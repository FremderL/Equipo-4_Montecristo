'use strict';

// MonteCristo · servidor Express + Socket.IO
// Implementa lo descrito en docs/04-arquitectura.md:
//   - sirve la interfaz de public/
//   - expone /health, /api/salas y /api/salas/:codigo
//   - mantiene las salas en memoria y atiende crear_sala / entrar_sala / salir_sala / chat
//   - corre el reloj de turno: si el jugador no responde, el servidor decide por él
//     (blackjack: se planta · póker: pasa si puede, si no se retira) y la partida sigue
// El servidor es autoritativo: el navegador solo envía intenciones.

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { REGLAS } = require('./lib/reglas.js');
const { FASES, cambiarFase, abrirNuevaRonda, fasePermiteAccion, cancelarTemporizadores } = require('./lib/ronda.js');
const { validarApuesta } = require('./lib/fichas.js');
const { crearRelojDeTurnos, tiempoDeTurno } = require('./lib/turno.js');

const PUERTO = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_SALAS = Number(process.env.MAX_SALAS) > 0 ? Number(process.env.MAX_SALAS) : 50;
const JUEGOS = ['coinflip', 'dice', 'roulette', 'blackjack', 'poker'];
const ALFABETO_CODIGO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function enteroPositivo(valor, predeterminado) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : predeterminado;
}

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

/** codigo -> sala. Todo vive en memoria: al reiniciar se empieza de cero. */
const salas = new Map();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function error(codigo, mensaje) {
  const fallo = new Error(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

function generarCodigo() {
  for (let intento = 0; intento < 100; intento += 1) {
    let codigo = '';
    for (let i = 0; i < REGLAS.LONGITUD_CODIGO_SALA; i += 1) {
      codigo += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
    }
    if (!salas.has(codigo)) return codigo;
  }
  throw error('SIN_CODIGO', 'No se pudo generar un código de sala libre. Inténtalo de nuevo.');
}

function normalizarCodigo(codigo) {
  return String(codigo || '').trim().toUpperCase();
}

function validarNombre(nombre) {
  if (typeof nombre !== 'string') throw error('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');

  const limpio = nombre.trim();
  if (limpio.length === 0) throw error('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');
  if (limpio.length > 24) throw error('NOMBRE_INVALIDO', 'El nombre puede tener como máximo 24 caracteres.');
  return limpio;
}

function validarAvatar(avatar) {
  if (typeof avatar !== 'string' || avatar.trim().length === 0) {
    throw error('AVATAR_INVALIDO', 'Selecciona un avatar antes de continuar.');
  }
  return avatar.trim().slice(0, 8);
}

function validarJuego(juego) {
  if (!JUEGOS.includes(juego)) {
    throw error('JUEGO_INVALIDO', 'Elige uno de los juegos disponibles para crear la sala.');
  }
  return juego;
}

function jugadoresDeSala(sala) {
  return Array.from(sala.jugadores.values());
}

/** Vista pública de la sala: nunca incluye datos privados de otros sockets. */
function estadoDeSala(sala) {
  return {
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    anfitrionId: sala.anfitrionId,
    capacidad: REGLAS.JUGADORES_POR_SALA,
    asientosLibres: REGLAS.JUGADORES_POR_SALA - sala.jugadores.size,
    numeroRonda: sala.numero_ronda,
    // Límite del turno (DOC-02): la interfaz puede pintar la cuenta regresiva
    // aunque todavía no haya nadie en turno.
    limiteTurnoMs: limiteDeTurno(sala.juego),
    turno: sala.turnos ? sala.turnos.vistaPublica() : null,
    apuestas: sala.apuestas.map(({ jugadorId, monto, opcion }) => ({ jugadorId, monto, opcion })),
    acciones: sala.acciones.map(({ jugadorId, accion, automatica, motivo, mensaje }) => ({
      jugadorId,
      accion,
      automatica,
      motivo,
      mensaje
    })),
    jugadores: jugadoresDeSala(sala).map((jugador) => ({
      id: jugador.id,
      nombre: jugador.nombre,
      avatar: jugador.avatar,
      fichas: jugador.fichas,
      esAnfitrion: jugador.id === sala.anfitrionId
    }))
  };
}

function difundirEstado(sala) {
  io.to(sala.codigo).emit('estado_sala', estadoDeSala(sala));
}

/** Estructura de una sala en memoria (DOC-03 + reloj de turno). */
function crearSala(codigo, juego, anfitrionId, jugador) {
  return {
    codigo,
    juego,
    fase: FASES.ESPERA,
    anfitrionId,
    creadaEn: Date.now(),
    actualizadaEn: Date.now(),
    numero_ronda: 1,
    apuestas: [],
    apuestasConfirmadas: 0,
    acciones: [],
    // Póker: cuánto hay que igualar y cuánto lleva puesto cada quien. Es el
    // contexto que decide si el servidor pasa o se retira por inactividad.
    apuestaActual: 0,
    puestas: {},
    bote: 0,
    turnos: null,
    temporizadores: new Set(),
    tareasPendientes: [],
    jugadores: new Map([[jugador.id, jugador]])
  };
}

function crearJugador(socketId, { nombre, avatar }) {
  return {
    id: socketId,
    nombre: validarNombre(nombre),
    avatar: validarAvatar(avatar),
    fichas: REGLAS.SALDO_INICIAL,
    conectado: true
  };
}

function asignarAnfitrion(sala) {
  const siguiente = jugadoresDeSala(sala)[0];
  sala.anfitrionId = siguiente ? siguiente.id : null;
}

/** Quita al jugador de su sala y limpia la sala si queda vacía. */
function abandonarSala(socket) {
  const codigo = socket.data.codigoSala;
  if (!codigo) return;

  const sala = salas.get(codigo);
  socket.data.codigoSala = null;
  socket.leave(codigo);

  if (!sala) return;

  // Si se va (o se desconecta) cuando le tocaba jugar, el servidor decide por él
  // y la vuelta sigue: la mesa no se queda esperando a quien ya no está.
  if (sala.turnos) sala.turnos.retirarJugador(socket.id, 'abandono');

  sala.jugadores.delete(socket.id);

  if (sala.jugadores.size === 0) {
    cancelarTurnos(sala, 'sala_vacia');
    cancelarTemporizadores(sala);
    salas.delete(codigo);
    return;
  }

  if (sala.anfitrionId === socket.id) asignarAnfitrion(sala);
  difundirEstado(sala);
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
    if (!jugador) continue; // quien salió en juego no se reembolsa (DOC-04 §5)
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
    cambiarFase(sala, FASES.RESULTADOS, { servidor: true });
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
  const lista = Array.from(salas.values()).map((sala) => ({
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    jugadores: sala.jugadores.size,
    capacidad: REGLAS.JUGADORES_POR_SALA
  }));
  res.json({ ok: true, salas: lista });
});

app.get('/api/salas/:codigo', (req, res) => {
  const codigo = normalizarCodigo(req.params.codigo);
  const sala = salas.get(codigo);

  if (!sala) {
    res.status(404).json({ ok: false, existe: false, codigo, error: 'La sala no existe o ya se cerró.' });
    return;
  }

  res.json({
    ok: true,
    existe: true,
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    asientosLibres: REGLAS.JUGADORES_POR_SALA - sala.jugadores.size
  });
});

// ---------------------------------------------------------------------------
// Socket.IO: eventos de docs/04-arquitectura.md
// ---------------------------------------------------------------------------

/** Sala y jugador del socket, o un error con código si no está sentado. */
function contextoDeSala(socket) {
  const codigo = socket.data.codigoSala;
  const sala = codigo ? salas.get(codigo) : null;
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

  socket.on('crear_sala', (datos, ack) => {
    try {
      if (salas.size >= MAX_SALAS) {
        throw error('LIMITE_SALAS', 'Se alcanzó el máximo de salas activas. Inténtalo más tarde.');
      }

      const juego = validarJuego(datos && datos.juego);
      const jugador = crearJugador(socket.id, datos || {});
      const codigo = generarCodigo();
      const sala = crearSala(codigo, juego, socket.id, jugador);

      salas.set(codigo, sala);
      abandonarSala(socket);
      socket.data.codigoSala = codigo;
      socket.join(codigo);

      socket.emit('estado_sala', estadoDeSala(sala));
      if (typeof ack === 'function') ack({ ok: true, codigo });
    } catch (fallo) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: fallo.codigo || 'ERROR', mensaje: fallo.message } });
      }
    }
  });

  socket.on('entrar_sala', (datos, ack) => {
    try {
      const codigo = normalizarCodigo(datos && datos.codigo);
      if (!new RegExp(`^[A-Z0-9]{${REGLAS.LONGITUD_CODIGO_SALA}}$`).test(codigo)) {
        throw error('CODIGO_INVALIDO', 'El código de sala no es válido. Debe tener cinco letras o números.');
      }

      const sala = salas.get(codigo);
      if (!sala) throw error('SALA_NO_ENCONTRADA', 'La sala no existe o ya se cerró.');
      if (sala.jugadores.size >= REGLAS.JUGADORES_POR_SALA) {
        throw error('SALA_LLENA', `La sala ya tiene ${REGLAS.JUGADORES_POR_SALA} jugadores.`);
      }

      const jugador = crearJugador(socket.id, datos || {});
      sala.jugadores.set(jugador.id, jugador);

      abandonarSala(socket);
      socket.data.codigoSala = codigo;
      socket.join(codigo);

      difundirEstado(sala);
      if (typeof ack === 'function') ack({ ok: true, codigo });
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
      cambiarFase(sala, FASES.APUESTAS, { accion: 'comenzar', jugadorId: jugador.id });
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
      if (!opcion) throw error('APUESTA_INVALIDA', 'Elige una opción para tu apuesta.');

      jugador.fichas -= monto;
      sala.apuestas.push({ jugadorId: jugador.id, monto, opcion, confirmadaEn: Date.now() });
      sala.apuestasConfirmadas = sala.apuestas.length;
      sala.bote += monto;

      io.to(sala.codigo).emit('apuesta_confirmada', { jugadorId: jugador.id, nombre: jugador.nombre, monto, opcion });
      difundirEstado(sala);
      return { saldo: jugador.fichas, monto, opcion };
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
        throw error('JUEGO_SIN_TURNOS', 'Este juego no se juega por turnos; su lanzamiento llegará con el motor de resultados.');
      }

      const orden = sala.apuestas
        .map((apuesta) => apuesta.jugadorId)
        .filter((jugadorId) => sala.jugadores.has(jugadorId));
      if (orden.length === 0) throw error('SIN_APOSTADORES', 'Nadie confirmó una apuesta en esta ronda.');

      cambiarFase(sala, FASES.JUGANDO, { jugadorId: jugador.id, apuestasConfirmadas: sala.apuestas.length });
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

  // El anfitrión abre la siguiente ronda; se apagan todos los relojes.
  socket.on('nueva_ronda', (datos, ack) => {
    atender(socket, ack, () => {
      const { sala, jugador } = contextoDeSala(socket);
      if (!fasePermiteAccion(sala.fase, 'nueva_ronda')) {
        throw error('FASE_INVALIDA', 'La siguiente ronda se abre desde los resultados.');
      }

      cancelarTurnos(sala, 'nueva_ronda');
      abrirNuevaRonda(sala, jugador.id); // limpia temporizadores y apuestas, y suma una ronda
      sala.acciones.length = 0;
      sala.apuestaActual = 0;
      sala.puestas = {};
      sala.bote = 0;
      sala.turnos = null;

      difundirEstado(sala);
      return { fase: sala.fase, numeroRonda: sala.numero_ronda };
    });
  });

  socket.on('chat', (datos, ack) => {
    const codigo = socket.data.codigoSala;
    const sala = codigo ? salas.get(codigo) : null;
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

    io.to(codigo).emit('chat_mensaje', {
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

servidor.listen(PUERTO, HOST, () => {
  console.log(`MonteCristo escuchando en http://localhost:${PUERTO}`);
  console.log('Fichas 100 % virtuales; no hay dinero real.');
});

function apagar(senal) {
  console.log(`\n${senal} recibido: cerrando MonteCristo…`);
  // Se apagan los relojes de turno para no dejar temporizadores vivos al salir.
  for (const sala of salas.values()) {
    cancelarTurnos(sala, 'servidor_cerrando');
    cancelarTemporizadores(sala);
  }
  io.close(() => {
    servidor.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => apagar('SIGINT'));
process.on('SIGTERM', () => apagar('SIGTERM'));
