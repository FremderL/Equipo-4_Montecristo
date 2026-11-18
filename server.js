'use strict';

// MonteCristo · servidor Express + Socket.IO
// Implementa lo descrito en docs/04-arquitectura.md:
//   - sirve la interfaz de public/
//   - expone /health, /api/salas y /api/salas/:codigo
//   - mantiene las salas en memoria y atiende crear_sala / entrar_sala / salir_sala / chat
//   - lanza los juegos rápidos: el anfitrión manda `lanzar` y el servidor genera el
//     resultado y paga a toda la sala (Cara o Cruz: ×2 a quien acierta)
//   - corre el reloj de turno: si el jugador no responde, el servidor decide por él
//     (blackjack: se planta · póker: pasa si puede, si no se retira) y la partida sigue
// El servidor es autoritativo: el navegador solo envía intenciones.

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { REGLAS } = require('./lib/reglas.js');
const { FASES, fasePermiteAccion } = require('./lib/ronda.js');
const { validarApuesta } = require('./lib/fichas.js');
const { crearRelojDeTurnos, tiempoDeTurno } = require('./lib/turno.js');
const { lanzarRonda } = require('./lib/lanzamiento.js');
const {
  ESTADOS_SALA,
  MAX_SALAS_POR_DEFECTO,
  normalizarCodigo,
  actualizarFaseSala,
  iniciarSiguienteRonda,
  estadoDeSala,
  resumenDeSala,
  consultaDeSala,
  crearAlmacenSalas
} = require('./lib/salas.js');
const coinflip = require('./lib/juegos/coinflip.js');

function enteroPositivo(valor, predeterminado) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : predeterminado;
}

const PUERTO = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_SALAS = enteroPositivo(process.env.MAX_SALAS, MAX_SALAS_POR_DEFECTO);

/**
 * Juegos rápidos con motor listo (lib/juegos/*.js): un solo lanzamiento y
 * liquidación inmediata para toda la sala. Dados y ruleta se registran aquí
 * cuando llegue su ticket; el evento `lanzar` no cambia.
 */
const MOTORES_RAPIDOS = new Map([[coinflip.JUEGO, coinflip]]);

/**
 * Límites de turno de DOC-02 (25 s blackjack · 30 s póker). Se pueden acortar
 * por variable de entorno para probar la mesa o para partidas rápidas; sin las
 * variables, valen exactamente lo que dicen las reglas.
 */
const TIEMPOS_DE_TURNO = Object.freeze({
  blackjack: enteroPositivo(process.env.TIEMPO_TURNO_BLACKJACK_MS, REGLAS.TIEMPO_TURNO_BLACKJACK_MS),
  poker: enteroPositivo(process.env.TIEMPO_TURNO_POKER_MS, REGLAS.TIEMPO_TURNO_POKER_MS)
});

/** ms del reloj de turno del juego, o null si no usa reloj. */
function limiteDeTurno(juego) {
  return tiempoDeTurno(juego, TIEMPOS_DE_TURNO);
}

/** Almacén autoritativo de salas en memoria (lib/salas.js · DOC-03 §4). */
const salas = crearAlmacenSalas({ maxSalas: MAX_SALAS });

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function error(codigo, mensaje) {
  const fallo = new Error(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

/** Vista pública de la sala: nunca incluye datos privados de otros sockets ni semillas. */
function estadoPublico(sala) {
  return estadoDeSala(sala, { limiteTurnoMs: limiteDeTurno(sala.juego) });
}

function difundirEstado(sala) {
  io.to(sala.codigo).emit('estado_sala', estadoPublico(sala));
}

/** Quita al jugador de su sala y la elimina si queda vacía. */
function abandonarSala(socket) {
  const salida = salas.salir(socket.id);
  const codigo = socket.data.codigoSala || (salida.sala && salida.sala.codigo);
  socket.data.codigoSala = null;
  if (codigo) socket.leave(codigo);

  if (salida.sala && !salida.cerrada) {
    difundirEstado(salida.sala);
  }
}

// ---------------------------------------------------------------------------
// Reloj de turno · límite de tiempo por turno (lib/turno.js)
//
// Nadie puede atorar la partida: cada turno nace con su deadline y, si el
// jugador no manda nada, el servidor aplica la acción automática de DOC-02 y
// pasa al siguiente. Los juegos rápidos (moneda, dados, ruleta) no tienen
// reloj porque todos juegan a la vez.
// ---------------------------------------------------------------------------

function nombreDe(sala, jugadorId) {
  const jugador = sala.jugadores.get(jugadorId);
  return jugador ? jugador.nombre : 'Jugador';
}

/** Turno vacío: se emite cuando la vuelta termina o se cancela. */
function turnoSinJugador(sala, motivo) {
  return {
    juego: sala.juego,
    jugadorId: null,
    deadline: null,
    tiempoMs: limiteDeTurno(sala.juego),
    segundosRestantes: null,
    posicion: null,
    total: sala.acciones.length,
    activo: false,
    motivo: motivo || null
  };
}

/** Datos que necesita la decisión automática: en póker, cuánto falta por igualar. */
function contextoDelTurno(sala, jugadorId) {
  if (sala.juego !== 'poker') return {};
  const puesta = Number(sala.puestas[jugadorId]) || 0;
  return { apuestaPorIgualar: Math.max(0, (Number(sala.apuestaActual) || 0) - puesta) };
}

/**
 * Reglas de mesa que el reloj no conoce. El motor de cada juego (tickets de
 * blackjack y póker) ampliará esto con cartas, doblajes, ciegas y botes.
 */
function validarAccionDeTurno(sala, jugadorId, accion, extra = {}) {
  if (sala.juego !== 'poker') return { ok: true };

  const { apuestaPorIgualar } = contextoDelTurno(sala, jugadorId);

  if (accion === 'check' && apuestaPorIgualar > 0) {
    return { ok: false, codigo: 'HAY_QUE_IGUALAR', error: `No puedes pasar: faltan ${apuestaPorIgualar} fichas por igualar.` };
  }

  if (accion === 'raise' || accion === 'all_in') {
    const jugador = sala.jugadores.get(jugadorId);
    const monto = Number(extra.monto);
    const minima = (Number(sala.apuestaActual) || 0) + REGLAS.CIEGA_GRANDE;
    const tope = (jugador ? jugador.fichas : 0) + (Number(sala.puestas[jugadorId]) || 0);
    if (!Number.isInteger(monto) || monto < minima || monto > tope) {
      return {
        ok: false,
        codigo: 'SUBIDA_INVALIDA',
        error: `La subida debe estar entre ${minima} y ${tope} fichas.`
      };
    }
  }

  return { ok: true };
}

/** Aplica el movimiento de fichas de la acción (provisional hasta el motor de póker). */
function cobrarAccionDePoker(sala, registro) {
  if (sala.juego !== 'poker' || !['call', 'raise', 'all_in'].includes(registro.accion)) return;

  const jugador = sala.jugadores.get(registro.jugadorId);
  if (!jugador) return;

  const puesta = Number(sala.puestas[registro.jugadorId]) || 0;
  const objetivo = registro.accion === 'call'
    ? Number(sala.apuestaActual) || 0
    : Number(registro.monto) || puesta;
  const extraFichas = Math.max(0, Math.min(objetivo - puesta, jugador.fichas));
  if (extraFichas <= 0) return;

  jugador.fichas -= extraFichas;
  sala.puestas[registro.jugadorId] = puesta + extraFichas;
  sala.bote += extraFichas;
  sala.apuestaActual = Math.max(Number(sala.apuestaActual) || 0, sala.puestas[registro.jugadorId]);
}

/**
 * Devuelve lo apostado mientras no exista liquidación.
 * PUNTO DE EXTENSIÓN: el motor de blackjack (mano de la casa) y el de póker
 * (showdown y botes) sustituirán esta devolución por el pago real de DOC-02.
 */
function devolverApuestas(sala) {
  for (const apuesta of sala.apuestas) {
    const jugador = sala.jugadores.get(apuesta.jugadorId);
    if (!jugador || jugador.conectado === false) continue; // quien salió en juego no se reembolsa (DOC-04 §5)
    jugador.fichas += apuesta.monto + (Number(sala.puestas[apuesta.jugadorId]) || 0);
  }
  sala.bote = 0;
  sala.apuestaActual = 0;
  sala.puestas = {};
}

/** Todos resolvieron su turno: se cierra la mano y la sala pasa a resultados. */
function cerrarMano(sala, motivo) {
  if (sala.fase === FASES.JUGANDO) {
    devolverApuestas(sala);
    actualizarFaseSala(sala, FASES.RESULTADOS, { servidor: true });
  }
  io.to(sala.codigo).emit('turno', turnoSinJugador(sala, motivo || 'mano_cerrada'));
  difundirEstado(sala);
}

function cancelarTurnos(sala, motivo = 'cancelado') {
  if (!sala.turnos) return;
  const reloj = sala.turnos;
  sala.turnos = null;
  reloj.cancelar(motivo);
}

/** Arranca una vuelta (mano de blackjack o calle de póker) con su reloj. */
function iniciarTurnos(sala, orden) {
  cancelarTurnos(sala, 'nueva_mano');

  const tiempoMs = limiteDeTurno(sala.juego);
  if (!tiempoMs) return null;

  const reloj = crearRelojDeTurnos({
    juego: sala.juego,
    orden,
    tiempoMs,
    sala,
    contexto: (jugadorId) => contextoDelTurno(sala, jugadorId),
    validar: (jugadorId, accion, extra) => validarAccionDeTurno(sala, jugadorId, accion, extra),
    alIniciarTurno: (turno) => {
      io.to(sala.codigo).emit('turno', turno);
      difundirEstado(sala);
    },
    alResolver: (registro) => {
      cobrarAccionDePoker(sala, registro);
      sala.acciones.push(registro);
      if (registro.automatica) {
        // Aviso explícito: el jugador ve que fue el servidor quien decidió por él.
        io.to(sala.codigo).emit('turno_automatico', {
          jugadorId: registro.jugadorId,
          nombre: nombreDe(sala, registro.jugadorId),
          accion: registro.accion,
          motivo: registro.motivo,
          mensaje: registro.mensaje,
          numeroRonda: sala.numero_ronda
        });
      }
      difundirEstado(sala);
    },
    alTerminar: (resumen) => {
      sala.turnos = null;
      cerrarMano(sala, resumen.motivo);
    },
    alCancelar: (resumen) => {
      io.to(sala.codigo).emit('turno', turnoSinJugador(sala, resumen.motivo));
      difundirEstado(sala);
    }
  });

  sala.turnos = reloj;
  reloj.iniciar();
  return reloj;
}

/**
 * Acción de turno enviada por el navegador (DOC-04 §3.2).
 * El reloj valida que sea su turno y que no haya vencido; si ya venció, la
 * decisión automática del servidor es la que vale y la acción llega tarde.
 */
function jugarTurno(socket, ack, juego, datos) {
  atender(socket, ack, () => {
    const { sala, jugador } = contextoDeSala(socket);
    if (sala.juego !== juego) throw error('JUEGO_INVALIDO', `En esta sala se juega ${sala.juego}.`);
    if (!fasePermiteAccion(sala.fase, 'accion')) throw error('FASE_INVALIDA', 'La ronda no está en juego.');
    if (!sala.turnos) throw error('SIN_TURNO', 'No hay un turno activo en esta mesa.');

    const registro = sala.turnos.jugar(jugador.id, datos && datos.accion, { monto: datos && datos.monto });
    return {
      accion: registro.accion,
      automatica: registro.automatica,
      saldo: jugador.fichas,
      turno: sala.turnos ? sala.turnos.vistaPublica() : null
    };
  });
}

// ---------------------------------------------------------------------------
// Express: archivos estáticos y API HTTP
// ---------------------------------------------------------------------------

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/salas', (req, res) => {
  res.json({ ok: true, salas: salas.listar().map(resumenDeSala) });
});

app.get('/api/salas/:codigo', (req, res) => {
  const codigo = normalizarCodigo(req.params.codigo);
  const sala = salas.obtener(codigo);

  if (!sala) {
    res.status(404).json({ ok: false, existe: false, codigo, error: 'La sala no existe o ya se cerró.' });
    return;
  }

  res.json(consultaDeSala(sala));
});

// ---------------------------------------------------------------------------
// Socket.IO: eventos de docs/04-arquitectura.md
// ---------------------------------------------------------------------------

/** Sala y jugador del socket, o un error con código si no está sentado. */
function contextoDeSala(socket) {
  const sala = salas.salaDeJugador(socket.id);
  const jugador = sala ? sala.jugadores.get(socket.id) : null;
  if (!sala || !jugador) throw error('SIN_SALA', 'No estás dentro de una sala.');
  return { sala, jugador };
}

function fallar(socket, ack, fallo) {
  const detalle = { codigo: fallo.codigo || 'ERROR', mensaje: fallo.message };
  if (typeof ack === 'function') ack({ ok: false, error: detalle });
  // DOC-04 §3.3: además del ack se emite `error` para que la interfaz lo muestre.
  socket.emit('error', detalle);
}

/** Ejecuta el manejador y responde siempre con `{ ok }` (ack) o con el error. */
function atender(socket, ack, funcion) {
  try {
    const resultado = funcion() || {};
    if (typeof ack === 'function') ack({ ok: true, ...resultado });
  } catch (fallo) {
    fallar(socket, ack, fallo);
  }
}

io.on('connection', (socket) => {
  socket.data.codigoSala = null;

  // DOC-04 §3.2: `comenzar`, `lanzar`, `repartir`, `nueva_ronda` y `salir_sala` no
  // llevan datos. Si el cliente los manda solo con su ack (`socket.emit('lanzar', ack)`),
  // el paquete se acomoda como (datos = null, ack): así todo evento responde su ack.
  socket.use((paquete, siguiente) => {
    if (paquete.length === 2 && typeof paquete[1] === 'function') paquete.splice(1, 0, null);
    siguiente();
  });

  socket.on('crear_sala', (datos, ack) => {
    try {
      const salaPrevia = salas.salaDeJugador(socket.id);
      const sala = salas.crear({
        juego: datos && datos.juego,
        anfitrion: {
          id: socket.id,
          nombre: datos && datos.nombre,
          avatar: datos && datos.avatar
        }
      });

      if (salaPrevia) {
        socket.leave(salaPrevia.codigo);
        if (salaPrevia.estado === ESTADOS_SALA.ABIERTA) difundirEstado(salaPrevia);
      }

      socket.data.codigoSala = sala.codigo;
      socket.join(sala.codigo);

      socket.emit('estado_sala', estadoPublico(sala));
      if (typeof ack === 'function') ack({ ok: true, codigo: sala.codigo });
    } catch (fallo) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: fallo.codigo || 'ERROR', mensaje: fallo.message } });
      }
    }
  });

  socket.on('entrar_sala', (datos, ack) => {
    try {
      const { sala, yaEstaba, salidaAnterior } = salas.unir(datos && datos.codigo, {
        id: socket.id,
        nombre: datos && datos.nombre,
        avatar: datos && datos.avatar
      });

      if (salidaAnterior && salidaAnterior.sala) {
        socket.leave(salidaAnterior.sala.codigo);
        if (!salidaAnterior.cerrada) difundirEstado(salidaAnterior.sala);
      }

      socket.data.codigoSala = sala.codigo;
      socket.join(sala.codigo);

      if (yaEstaba) {
        socket.emit('estado_sala', estadoPublico(sala));
      } else {
        difundirEstado(sala);
      }
      if (typeof ack === 'function') ack({ ok: true, codigo: sala.codigo });
    } catch (fallo) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: fallo.codigo || 'ERROR', mensaje: fallo.message } });
      }
    }
  });

  socket.on('salir_sala', (datos, ack) => {
    abandonarSala(socket);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Ronda y reloj de turno (DOC-01 §8 · DOC-04 §3.2 y §5)
  // -------------------------------------------------------------------------

  // El anfitrión abre la fase de apuestas.
  socket.on('comenzar', (datos, ack) => {
    atender(socket, ack, () => {
      const { sala, jugador } = contextoDeSala(socket);
      if (!fasePermiteAccion(sala.fase, 'comenzar')) {
        throw error('FASE_INVALIDA', 'La ronda ya está en marcha o en resultados.');
      }
      actualizarFaseSala(sala, FASES.APUESTAS, { accion: 'comenzar', jugadorId: jugador.id });
      difundirEstado(sala);
      return { fase: sala.fase, numeroRonda: sala.numero_ronda };
    });
  });

  // Una apuesta por jugador y por ronda; las fichas salen del saldo al confirmar.
  socket.on('apostar', (datos, ack) => {
    atender(socket, ack, () => {
      const { sala, jugador } = contextoDeSala(socket);
      if (!fasePermiteAccion(sala.fase, 'apostar')) {
        throw error('FASE_INVALIDA', 'Las apuestas están cerradas en esta fase.');
      }

      const monto = Number(datos && datos.monto);
      const opcion = typeof (datos && datos.opcion) === 'string' ? datos.opcion.trim().toLowerCase() : '';
      const yaAposto = sala.apuestas.some((apuesta) => apuesta.jugadorId === jugador.id);
      if (yaAposto) throw error('APUESTA_REPETIDA', 'Ya confirmaste tu apuesta en esta ronda.');

      const validacion = validarApuesta(jugador.fichas, monto, false);
      if (!validacion.ok) throw error('APUESTA_INVALIDA', validacion.error);

      // DOC-02 §10.6: la opción tiene que existir en el juego (`cara` o `cruz` en
      // Cara o Cruz). Los juegos que aún no tienen motor conservan la revisión mínima.
      const motor = MOTORES_RAPIDOS.get(sala.juego);
      if (motor) {
        const revision = motor.validarOpcion(opcion);
        if (!revision.ok) throw error('OPCION_INVALIDA', revision.error);
      } else if (!opcion) {
        throw error('APUESTA_INVALIDA', 'Elige una opción para tu apuesta.');
      }

      const ahora = Date.now();
      jugador.fichas -= monto;
      jugador.ultimaActividad = ahora;
      sala.apuestas.push({ jugadorId: jugador.id, nombre: jugador.nombre, monto, opcion, confirmadaEn: ahora });
      sala.apuestasConfirmadas = sala.apuestas.length;
      sala.bote += monto;
      sala.actualizadaEn = ahora;

      io.to(sala.codigo).emit('apuesta_confirmada', { jugadorId: jugador.id, nombre: jugador.nombre, monto, opcion });
      difundirEstado(sala);
      return { saldo: jugador.fichas, monto, opcion };
    });
  });

  // El anfitrión lanza (juegos rápidos · DOC-04 §4). En un solo paso el servidor
  // cierra las apuestas, genera el resultado con su RNG, paga a toda la sala con
  // ese mismo resultado y deja la ronda en `resultados`. Lo que el cliente mande
  // en `datos` se ignora: nadie puede enviar, elegir ni adelantar el resultado.
  socket.on('lanzar', (datos, ack) => {
    atender(socket, ack, () => {
      const { sala, jugador } = contextoDeSala(socket);
      const motor = MOTORES_RAPIDOS.get(sala.juego);
      if (!motor) {
        throw limiteDeTurno(sala.juego) === null
          ? error('JUEGO_NO_DISPONIBLE', 'El lanzamiento de este juego todavía no está disponible.')
          : error('JUEGO_SIN_LANZAMIENTO', 'Este juego no se lanza: el anfitrión reparte y se juega por turnos.');
      }

      // Valida fase, anfitrión y apuestas. Si rechaza, la sala queda intacta; un
      // segundo `lanzar` no vuelve a liquidar (RONDA_LIQUIDADA).
      const ronda = lanzarRonda(sala, motor, { jugadorId: jugador.id });

      // PUNTO DE EXTENSIÓN: aquí se guarda la ronda terminada (historial y
      // estadísticas) cuando exista ese registro; `ronda.apuestas` ya trae
      // jugador, apuesta, opción, resultado y pago.
      io.to(sala.codigo).emit('ronda_iniciada', { numeroRonda: ronda.numeroRonda, juego: ronda.juego });
      io.to(sala.codigo).emit('resultado', ronda);
      difundirEstado(sala);
      return { numeroRonda: ronda.numeroRonda, resultado: ronda.resultado, saldo: jugador.fichas };
    });
  });

  // El anfitrión reparte: la sala pasa a `jugando` y arranca el reloj de turno.
  // Quien no confirmó apuesta no entra al orden de turnos: el servidor nunca
  // apuesta por él, simplemente juega sin esa persona.
  socket.on('repartir', (datos, ack) => {
    atender(socket, ack, () => {
      const { sala, jugador } = contextoDeSala(socket);
      if (!fasePermiteAccion(sala.fase, 'repartir')) {
        throw error('FASE_INVALIDA', 'Solo se reparte durante la fase de apuestas.');
      }
      if (limiteDeTurno(sala.juego) === null) {
        throw error('JUEGO_SIN_TURNOS', 'Este juego no se reparte ni se juega por turnos: el anfitrión lo inicia con «lanzar».');
      }

      const orden = sala.apuestas
        .map((apuesta) => apuesta.jugadorId)
        .filter((jugadorId) => sala.jugadores.has(jugadorId));
      if (orden.length === 0) throw error('SIN_APOSTADORES', 'Nadie confirmó una apuesta en esta ronda.');

      actualizarFaseSala(sala, FASES.JUGANDO, { jugadorId: jugador.id, apuestasConfirmadas: orden.length });
      sala.acciones.length = 0;
      sala.apuestaActual = 0;
      sala.puestas = {};

      io.to(sala.codigo).emit('ronda_iniciada', { numeroRonda: sala.numero_ronda, juego: sala.juego, orden });
      iniciarTurnos(sala, orden); // emite `turno` con su deadline y el estado nuevo
      return { numeroRonda: sala.numero_ronda, orden, limiteTurnoMs: limiteDeTurno(sala.juego) };
    });
  });

  socket.on('accion_blackjack', (datos, ack) => jugarTurno(socket, ack, 'blackjack', datos));
  socket.on('accion_poker', (datos, ack) => jugarTurno(socket, ack, 'poker', datos));

  // El anfitrión abre la siguiente ronda; se apagan todos los relojes y se limpia la mesa.
  socket.on('nueva_ronda', (datos, ack) => {
    atender(socket, ack, () => {
      const { sala, jugador } = contextoDeSala(socket);
      iniciarSiguienteRonda(sala, jugador.id);

      difundirEstado(sala);
      return { fase: sala.fase, numeroRonda: sala.numero_ronda };
    });
  });

  socket.on('chat', (datos, ack) => {
    const sala = salas.salaDeJugador(socket.id);
    const jugador = sala ? sala.jugadores.get(socket.id) : null;
    const texto = typeof (datos && datos.texto) === 'string' ? datos.texto.trim() : '';

    if (!sala || !jugador) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: 'SIN_SALA', mensaje: 'No estás dentro de una sala.' } });
      }
      return;
    }

    if (texto.length === 0 || texto.length > 200) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: 'MENSAJE_INVALIDO', mensaje: 'El mensaje debe tener entre 1 y 200 caracteres.' } });
      }
      return;
    }

    jugador.ultimaActividad = Date.now();
    io.to(sala.codigo).emit('chat_mensaje', {
      nombre: jugador.nombre,
      texto,
      hora: new Date().toISOString()
    });

    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    abandonarSala(socket);
  });
});

// ---------------------------------------------------------------------------
// Arranque y apagado ordenado
// ---------------------------------------------------------------------------

function apagar(senal) {
  console.log(`\n${senal} recibido: cerrando MonteCristo…`);
  // Se cierran las salas y se apagan los relojes para no dejar temporizadores vivos al salir.
  salas.cerrarTodas('servidor_cerrando');
  io.close(() => {
    servidor.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

if (require.main === module) {
  servidor.listen(PUERTO, HOST, () => {
    console.log(`MonteCristo escuchando en http://localhost:${PUERTO}`);
    console.log('Fichas 100 % virtuales; no hay dinero real.');
  });

  process.on('SIGINT', () => apagar('SIGINT'));
  process.on('SIGTERM', () => apagar('SIGTERM'));
}

module.exports = { app, servidor, io, salas };
