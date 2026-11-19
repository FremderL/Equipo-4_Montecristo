'use strict';

// MonteCristo · servidor Express + Socket.IO
// Implementa lo descrito en docs/04-arquitectura.md:
//   - sirve la interfaz de public/
//   - expone /health, /api/salas, /api/salas/:codigo y los enlaces /sala/:codigo
//   - mantiene las salas en memoria y atiende crear_sala / entrar_sala / salir_sala / chat
//   - lanza los juegos rápidos: el anfitrión manda `lanzar` y el servidor genera el
//     resultado y paga a toda la sala (Cara o Cruz: ×2 a quien acierta)
//   - guarda en SQLite el saldo final de cada jugador cuando termina la ronda
//   - reparte blackjack con un mazo por ronda; solo el dueño recibe su mano y sus puntos
//   - al cerrar la mano de blackjack la casa pide hasta 17, compara y paga (DOC-02 §6)
//   - corre el reloj de turno: si el jugador no responde, el servidor decide por él
//     (blackjack: se planta · póker: pasa si puede, si no se retira) y la partida sigue
// El servidor es autoritativo: el navegador solo envía intenciones.

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { REGLAS } = require('./lib/reglas.js');
const { FASES, fasePermiteAccion, esAnfitrion } = require('./lib/ronda.js');
const {
  MAX_SALAS_POR_DEFECTO,
  ESTADOS_SALA,
  crearAlmacenSalas,
  estadoDeSala,
  resumenDeSala,
  consultaDeSala,
  actualizarFaseSala,
  iniciarSiguienteRonda,
  normalizarCodigo
} = require('./lib/salas.js');
const { validarApuesta } = require('./lib/fichas.js');
// Ticket 2: crear, buscar y actualizar jugadores pasa SIEMPRE por estas funciones.
const jugadores = require('./lib/jugadores.js');
// Ticket 4: cada ronda terminada se guarda en `historial_rondas`.
const { registrarRondaTerminada } = require('./lib/historial.js');
const { crearRelojDeTurnos, tiempoDeTurno } = require('./lib/turno.js');
const { lanzarRonda, vistaDeApuesta, nuevaSemilla } = require('./lib/lanzamiento.js');
const { crearRng } = require('./lib/rng.js');
const coinflip = require('./lib/juegos/coinflip.js');
const dice = require('./lib/juegos/dice.js');
const roulette = require('./lib/juegos/roulette.js');
const {
  contarPuntos,
  sePaso,
  repartirInicial,
  vistaDeCasa,
  turnoDeCasa,
  liquidarContraCasa,
  ESTADOS_MANO,
  detalleMano,
  validarAccionJugador,
  aplicarAccionJugador,
  liquidarDerrotaInmediata
} = require('./lib/juegos/blackjack.js');

const PUERTO_POR_DEFECTO = 3000;
const PUERTO = Number(process.env.PORT) || PUERTO_POR_DEFECTO;
const HOST = process.env.HOST || '0.0.0.0';
const RUTA_PUBLIC = path.join(__dirname, 'public');
const MENSAJE_BIENVENIDA = '¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).';
const MAX_SALAS = Number(process.env.MAX_SALAS) > 0 ? Number(process.env.MAX_SALAS) : MAX_SALAS_POR_DEFECTO;

/** Juegos rápidos con motor listo: un lanzamiento y una liquidación para toda la sala. */
const MOTORES_RAPIDOS = new Map([
  [coinflip.JUEGO, coinflip],
  [dice.JUEGO, dice],
  [roulette.JUEGO, roulette]
]);

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

/** Vista pública de la sala: nunca incluye datos privados de otros sockets. */
function estadoPublico(sala) {
  const estado = {
    ...estadoDeSala(sala, { limiteTurnoMs: limiteDeTurno(sala.juego) }),
    capacidad: sala.capacidad || REGLAS.JUGADORES_POR_SALA
  };
  // Blackjack: la casa se destapa solo en `resultados` (DOC-04 §3.3).
  if (sala.juego === 'blackjack') {
    estado.casa = sala.blackjack ? vistaDeCasa(sala.blackjack.casa, sala.fase === FASES.RESULTADOS) : null;
  }
  return estado;
}

/** Estado que viaja en `estado_sala`: el de la sala más el motivo del aviso. */
function estadoConMotivo(sala, motivo) {
  return { ...estadoPublico(sala), motivo };
}

/**
 * Ticket 2: manda el estado completo de la sala a TODOS sus jugadores cada vez
 * que algo cambia (alguien entra, sale, apuesta, se abre la ronda, se lanza…).
 * `motivo` dice por qué se envió, así el navegador puede reaccionar sin adivinar.
 */
function difundirEstado(sala, motivo = 'cambio') {
  if (!sala || sala.estado === ESTADOS_SALA.CERRADA) return;
  io.to(sala.codigo).emit('estado_sala', estadoConMotivo(sala, motivo));
}

// Cada aviso identifica la sala y ronda del estado al que pertenece.
function avisarRonda(sala, evento, datos) {
  io.to(sala.codigo).emit(evento, { ...datos, codigo: sala.codigo, numeroRonda: sala.numero_ronda });
}

/**
 * Directorio en tiempo real: se empuja solo cuando cambia el número de jugadores
 * o de salas. Antes el navegador pedía /api/salas cada 5 s aunque no hubiera
 * movimiento; ahora ese tráfico desaparece mientras haya WebSocket activo.
 */
function difundirDirectorio() {
  io.emit('salas_actualizadas', { salas: salas.listar().map(resumenDeSala) });
}

/** Carga el saldo guardado (o crea el perfil con el saldo inicial) antes de sentarlo. */
function cargarJugadorPersistente(socket, datos, jugador) {
  const deviceId = datos?.device_id === undefined ? null : jugadores.validarIdDispositivo(datos.device_id);
  const vinculado = socket.data.jugadorIdPersistente;
  const registrado = !vinculado && deviceId
    ? jugadores.buscarJugadorPorDispositivo(deviceId)
    : jugadores.buscarJugadorPorId(vinculado || socket.id);

  if (vinculado && !registrado) throw error('JUGADOR_NO_ENCONTRADO', 'El perfil vinculado ya no existe.');
  if (vinculado && deviceId && deviceId !== registrado.deviceId) {
    throw error('PERFIL_DISTINTO', 'Esta conexión ya está vinculada a otro perfil.');
  }
  // Un saldo persistente no debe poder gastarse simultáneamente en dos asientos.
  if (registrado && salas.listar().some((sala) => [...sala.jugadores.values()].some(
    (otro) => otro.id !== socket.id && otro.idPersistente === registrado.id
  ))) {
    throw error('PERFIL_EN_USO', 'Este perfil ya está jugando en otra pestaña.');
  }

  const { nombre, avatar } = jugador;
  let perfil = registrado;
  if (!perfil) {
    perfil = jugadores.crearJugador({ id: socket.id, nombre, avatar, deviceId });
  } else if (perfil.nombre !== nombre || perfil.avatar !== avatar) {
    perfil = jugadores.actualizarJugador(perfil.id, { nombre, avatar });
  }

  // El asiento y los mensajes privados siguen usando el socket, no el perfil.
  jugador.idPersistente = perfil.id;
  jugador.fichas = perfil.saldo;
  socket.data.jugadorIdPersistente = perfil.id;
}

function sincronizarSalida(socket, sala, jugador) {
  socket.leave(sala.codigo);
  // Una apuesta abandonada ya no puede cobrar ni reembolsarse. Si la mano
  // sigue abierta, guarda la pérdida antes de que el jugador use otra mesa.
  // Si su salida cerró la mano, el cierre ya guardó su saldo junto al resto.
  if (jugador && sala.fase === FASES.JUGANDO && sala.apuestas.some(
    (apuesta) => apuesta.jugadorId === jugador.id && apuesta.abandonada
  )) {
    guardarSaldos(sala, [jugador]);
  }
  if (sala.estado === ESTADOS_SALA.ABIERTA) {
    difundirEstado(sala, 'salida');
  } else if (sala.estado === ESTADOS_SALA.CERRADA) {
    // DOC-04 §3.2: la sala se quedó sin nadie; el último en salir se entera.
    socket.emit('sala_cerrada', { codigo: sala.codigo, motivo: 'sala_vacia' });
  }
}

/** Quita al jugador de su sala y la elimina si queda vacía. */
function abandonarSala(socket) {
  const salida = salas.salir(socket.id);
  if (salida.sala) sincronizarSalida(socket, salida.sala, salida.retirado);
  else if (socket.data.codigoSala) socket.leave(socket.data.codigoSala);
  socket.data.codigoSala = null;
  if (salida.sala) difundirDirectorio();
  return salida;
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
  if (sala.juego === 'blackjack') {
    return validarAccionJugador(sala.blackjack, jugadorId, accion);
  }

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
 * Aplica la jugada de turno en blackjack (`hit` o `stand`). Si pide carta, solo
 * el dueño recibe su mano actualizada; si supera 21, pierde su apuesta en el acto
 * y cede el turno; con 21 o menos conserva su turno y se renueva su reloj.
 */
function ejecutarAccionDeTurno(sala, jugadorId, accion, extra = {}) {
  if (sala.juego !== 'blackjack' || !sala.blackjack) return {};
  if (extra.automatica) {
    const actual = detalleMano(sala.blackjack, jugadorId);
    if (!actual || actual.estado !== ESTADOS_MANO.JUGANDO) return {};
  }

  const jugada = aplicarAccionJugador(sala.blackjack, jugadorId, accion);
  if (jugada.accion === 'hit') {
    io.to(jugadorId).emit('cartas', {
      numeroRonda: sala.numero_ronda,
      cartas: jugada.cartas,
      puntos: jugada.puntos
    });

    if (jugada.pasado) {
      const apuesta = sala.apuestas.find((candidata) => candidata.jugadorId === jugadorId);
      if (apuesta) liquidarDerrotaInmediata(apuesta);
      return {
        mantenerTurno: false,
        motivo: 'bust',
        mensaje: 'Se pasó de 21 y perdió de inmediato.'
      };
    }

    return { mantenerTurno: true };
  }

  return { mantenerTurno: false };
}

/**
 * Cierre de una mano de blackjack (DOC-02 §6): la casa juega su turno (pide
 * hasta llegar a 17), se comparan las manos y se paga cada apuesta pendiente
 * con su multiplicador (natural ×2,5 · victoria ×2 · empate ×1 · derrota ×0).
 *
 * La casa solo roba si queda alguien en pie: si todos se pasaron de 21, su
 * mano se destapa tal cual vino del reparto. Quien ya perdió por bust no se
 * paga dos veces y quien abandonó en juego no cobra nada.
 */
function liquidarBlackjack(sala) {
  const partida = sala.blackjack;
  const manos = partida.manos instanceof Map ? partida.manos : new Map();
  const enPie = sala.apuestas.some((apuesta) => !apuesta.resultado
    && !apuesta.abandonada
    && sala.jugadores.has(apuesta.jugadorId)
    && manos.has(apuesta.jugadorId)
    && !sePaso(manos.get(apuesta.jugadorId)));
  if (enPie) turnoDeCasa(partida);

  for (const apuesta of sala.apuestas) {
    if (apuesta.resultado !== undefined && apuesta.resultado !== null) continue;
    if (apuesta.abandonada) {
      // Su saldo ya descontó la apuesta. Reflejar esa pérdida en el balance de todos.
      liquidarDerrotaInmediata(apuesta);
      continue;
    }
    const jugador = sala.jugadores.get(apuesta.jugadorId);
    if (!jugador || !manos.has(apuesta.jugadorId)) continue;
    liquidarContraCasa(apuesta, manos.get(apuesta.jugadorId), partida.casa);
    jugador.fichas += apuesta.pago;
  }
  sala.bote = 0;
  sala.apuestaActual = 0;
  sala.puestas = {};
}

/**
 * Devuelve lo apostado mientras no exista liquidación (póker, provisional).
 * PUNTO DE EXTENSIÓN: el motor de póker (showdown y botes) sustituirá esta
 * devolución por el pago real de DOC-02.
 */
function devolverApuestas(sala) {
  for (const apuesta of sala.apuestas) {
    if (apuesta.resultado !== undefined && apuesta.resultado !== null) continue;
    const jugador = sala.jugadores.get(apuesta.jugadorId);
    const totalAportado = apuesta.monto + (Number(sala.puestas[apuesta.jugadorId]) || 0);
    const pago = jugador && !apuesta.abandonada ? totalAportado : 0;
    if (pago) jugador.fichas += pago;
    Object.assign(apuesta, { totalAportado, pago, neto: pago - totalAportado,
      multiplicador: pago ? 1 : 0, resultado: pago ? 'empate' : 'pierde' });
  }
  sala.bote = 0;
  sala.apuestaActual = 0;
  sala.puestas = {};
}

/** Guarda los saldos autoritativos, no los montos ni los pagos por separado. */
function guardarSaldos(sala, participantes = sala.jugadores.values()) {
  try {
    jugadores.actualizarSaldosJugadores(Array.from(participantes, (jugador) => ({
      id: jugador.idPersistente,
      saldo: jugador.fichas
    })));
  } catch (fallo) {
    // Igual que con el historial, una falla de SQLite no detiene el reloj ni la mesa.
    console.warn(`⚠️  Saldo: no se pudo guardar la ronda ${sala.numero_ronda} de la sala ${sala.codigo}: ${fallo.message}`);
  }
}

/**
 * Ticket 4: guarda en `historial_rondas` la ronda que acaba de terminar, con
 * una fila por jugador: sala, juego, jugador, apuesta, resultado y fecha.
 *
 * Solo se guardan las apuestas ya liquidadas de quien sigue en la sala. La
 * partida nunca se interrumpe por el historial: si la base de datos falla, la
 * ronda ya está liquidada en memoria y aquí solo se avisa por consola.
 */
function registrarHistorial(sala) {
  const numeroRonda = sala.numero_ronda;
  const liquidables = sala.apuestas.filter(
    (apuesta) => apuesta
      && typeof apuesta.resultado === 'string'
      && sala.jugadores.has(apuesta.jugadorId)
  );
  if (liquidables.length === 0) return;

  try {
    const { insertadas } = registrarRondaTerminada({
      salaCodigo: sala.codigo,
      juego: sala.juego,
      numeroRonda,
      jugadores: liquidables.map((apuesta) => {
        const jugador = sala.jugadores.get(apuesta.jugadorId);
        return {
          jugadorId: jugador.idPersistente,
          nombre: apuesta.nombre || jugador.nombre,
          apuesta: apuesta.totalAportado ?? apuesta.monto,
          opcion: apuesta.opcion,
          resultado: apuesta.resultado,
          pago: apuesta.pago
        };
      })
    });
    console.log(`🗂️  Historial: ronda ${numeroRonda} de la sala ${sala.codigo} guardada (${insertadas} fila(s)).`);
  } catch (fallo) {
    console.warn(`⚠️  Historial: no se pudo guardar la ronda ${numeroRonda} de la sala ${sala.codigo}: ${fallo.message}`);
  }
}

function guardarRondaTerminada(sala) {
  guardarSaldos(sala);
  registrarHistorial(sala);
}

/** Liquida una sola vez y usa el mismo resultado para el aviso, el balance y la entrada tardía. */
function cerrarMano(sala, motivo) {
  if (sala.fase !== FASES.JUGANDO) return;
  if (sala.juego === 'blackjack') {
    liquidarBlackjack(sala);
    sala.resultado = { casa: vistaDeCasa(sala.blackjack.casa, true) };
  } else {
    devolverApuestas(sala);
    sala.resultado = { tipo: 'devolucion' };
  }
  actualizarFaseSala(sala, FASES.RESULTADOS, { servidor: true });
  guardarRondaTerminada(sala);
  avisarRonda(sala, 'turno', turnoSinJugador(sala, motivo || 'mano_cerrada'));
  avisarRonda(sala, 'resultado', {
    juego: sala.juego, resultado: sala.resultado, apuestas: sala.apuestas.map(vistaDeApuesta)
  });
  difundirEstado(sala, 'resultado');
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
    ejecutar: (jugadorId, accion, extra) => ejecutarAccionDeTurno(sala, jugadorId, accion, extra),
    alIniciarTurno: (turno) => {
      avisarRonda(sala, 'turno', turno);
      difundirEstado(sala, 'turno');
    },
    alResolver: (registro) => {
      cobrarAccionDePoker(sala, registro);
      sala.acciones.push(registro);
      if (registro.automatica) {
        // Aviso explícito: el jugador ve que fue el servidor quien decidió por él.
        avisarRonda(sala, 'turno_automatico', {
          jugadorId: registro.jugadorId,
          nombre: nombreDe(sala, registro.jugadorId),
          accion: registro.accion,
          motivo: registro.motivo,
          mensaje: registro.mensaje
        });
      }
      difundirEstado(sala, 'turno');
    },
    alTerminar: (resumen) => {
      sala.turnos = null;
      cerrarMano(sala, resumen.motivo);
    },
    alCancelar: (resumen) => {
      avisarRonda(sala, 'turno', turnoSinJugador(sala, resumen.motivo));
      difundirEstado(sala, 'turno');
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
    const respuesta = {
      accion: registro.accion,
      automatica: registro.automatica,
      saldo: jugador.fichas,
      turno: sala.turnos ? sala.turnos.vistaPublica() : null
    };
    if (sala.juego === 'blackjack' && sala.blackjack) {
      const mano = detalleMano(sala.blackjack, jugador.id);
      if (mano) {
        respuesta.cartas = mano.cartas;
        respuesta.puntos = mano.puntos;
        respuesta.estado = mano.estado;
        respuesta.pasado = mano.pasado;
      }
    }
    return respuesta;
  });
}

// ---------------------------------------------------------------------------
// Express: archivos estáticos y API HTTP
// ---------------------------------------------------------------------------

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

app.disable('x-powered-by');

// HTML, CSS, JavaScript, JSON y SVG viajan comprimidos. Las imágenes ya lo están
// (JPEG) y no se recomprimen: con esto una carga inicial pesa la cuarta parte.
app.use(compression({ threshold: 1024 }));

// El HTML se revalida en cada visita para publicar cambios enseguida; el resto
// se guarda una hora en el navegador. express.static ya añade ETag/Last-Modified.
app.use(express.static(RUTA_PUBLIC, {
  setHeaders(res, filePath) {
    if (path.extname(filePath).toLowerCase() === '.html') {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    }
  }
}));

// Las respuestas de la API se revalidan con ETag: cuando no cambian, el servidor
// devuelve 304 sin cuerpo (el directorio se consulta al entrar y al reconectar).
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/sala/:codigo', (req, res) => {
  const codigo = normalizarCodigo(req.params.codigo);
  if (!codigo) {
    res.status(400).send('El código de sala debe tener cinco letras o números.');
    return;
  }
  res.redirect(`/perfil.html?accion=entrar&codigo=${codigo}`);
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

  const bienvenida = {
    mensaje: MENSAJE_BIENVENIDA,
    socketId: socket.id,
    fecha: new Date().toISOString()
  };
  console.log(`[Socket.IO] Navegador conectado (${socket.id}): ${bienvenida.mensaje}`);
  socket.emit('bienvenida', bienvenida);

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
      const jugadorPrevio = salaPrevia?.jugadores.get(socket.id);
      const sala = salas.crear({
        juego: datos && datos.juego,
        anfitrion: {
          id: socket.id,
          nombre: datos && datos.nombre,
          avatar: datos && datos.avatar
        }
      }, { prepararIngreso: (jugador) => cargarJugadorPersistente(socket, datos, jugador) });

      if (salaPrevia) sincronizarSalida(socket, salaPrevia, jugadorPrevio);

      socket.data.codigoSala = sala.codigo;
      socket.join(sala.codigo);

      socket.emit('estado_sala', estadoConMotivo(sala, 'creada'));
      difundirDirectorio();
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
      }, { prepararIngreso: (jugador) => cargarJugadorPersistente(socket, datos, jugador) });

      if (salidaAnterior) sincronizarSalida(socket, salidaAnterior.sala, salidaAnterior.retirado);

      socket.data.codigoSala = sala.codigo;
      socket.join(sala.codigo);

      if (yaEstaba) {
        // Repetir la solicitud no cambia el asiento, el saldo ni el anfitrión.
        socket.emit('estado_sala', estadoConMotivo(sala, 'reconexion'));
      } else {
        // Ticket 2: todos los de la mesa (incluido quien acaba de entrar) ven el estado nuevo.
        difundirEstado(sala, 'entrada');
        difundirDirectorio();
      }

      if (typeof ack === 'function') ack({ ok: true, codigo: sala.codigo });
    } catch (fallo) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: fallo.codigo || 'ERROR', mensaje: fallo.message } });
      }
    }
  });

  // El jugador se va de la sala: se libera su asiento (o se cierra la sala si era
  // el último) y el resto recibe el estado nuevo al instante.
  socket.on('salir_sala', (datos, ack) => {
    const salida = abandonarSala(socket);
    if (typeof ack === 'function') {
      ack({
        ok: true,
        codigo: salida.sala ? salida.sala.codigo : null,
        salaCerrada: Boolean(salida.cerrada)
      });
    }
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
      difundirEstado(sala, 'fase');
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
      const opcionSolicitada = datos && datos.opcion;
      const yaAposto = sala.apuestas.some((apuesta) => apuesta.jugadorId === jugador.id);
      if (yaAposto) throw error('APUESTA_REPETIDA', 'Ya confirmaste tu apuesta en esta ronda.');

      const validacion = validarApuesta(jugador.fichas, monto, false);
      if (!validacion.ok) throw error('APUESTA_INVALIDA', validacion.error);

      // DOC-02 §10.6: el motor valida y normaliza la opción antes de descontar fichas.
      // Los juegos sin motor conservan la revisión mínima.
      const motor = MOTORES_RAPIDOS.get(sala.juego);
      let opcion;
      if (motor) {
        const revision = motor.validarOpcion(opcionSolicitada);
        if (!revision.ok) throw error('OPCION_INVALIDA', revision.error);
        opcion = revision.opcion;
      } else {
        opcion = typeof opcionSolicitada === 'string' ? opcionSolicitada.trim().toLowerCase() : '';
        if (!opcion && sala.juego === 'blackjack') opcion = 'mano';
        if (!opcion) throw error('APUESTA_INVALIDA', 'Elige una opción para tu apuesta.');
      }

      jugador.fichas -= monto;
      sala.apuestas.push({ jugadorId: jugador.id, nombre: jugador.nombre, monto, opcion, confirmadaEn: Date.now() });
      sala.apuestasConfirmadas = sala.apuestas.length;
      sala.bote += monto;

      io.to(sala.codigo).emit('apuesta_confirmada', { jugadorId: jugador.id, nombre: jugador.nombre, monto, opcion });
      difundirEstado(sala, 'apuesta');
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

      // Guarda los saldos finales y el historial antes de avisar a la sala.
      guardarRondaTerminada(sala);
      io.to(sala.codigo).emit('ronda_iniciada', { numeroRonda: ronda.numeroRonda, juego: ronda.juego });
      avisarRonda(sala, 'resultado', ronda);
      difundirEstado(sala, 'resultado');
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

      if (!esAnfitrion(sala, jugador.id)) throw error('SOLO_ANFITRION', 'Solo el anfitrión puede repartir.');

      const orden = sala.apuestas
        .map((apuesta) => apuesta.jugadorId)
        .filter((jugadorId) => sala.jugadores.has(jugadorId));
      if (orden.length === 0) throw error('SIN_APOSTADORES', 'Nadie confirmó una apuesta en esta ronda.');

      // El cliente no elige cartas ni semilla. Preparamos el reparto antes de
      // cambiar la fase para no dejar una ronda a medias si el barajado falla.
      const semilla = sala.juego === 'blackjack' ? nuevaSemilla() : null;
      const reparto = semilla ? repartirInicial(orden, crearRng(semilla)) : null;
      actualizarFaseSala(sala, FASES.JUGANDO, { jugadorId: jugador.id, apuestasConfirmadas: sala.apuestas.length });
      sala.acciones.length = 0;
      sala.apuestaActual = 0;
      sala.puestas = {};

      io.to(sala.codigo).emit('ronda_iniciada', { numeroRonda: sala.numero_ronda, juego: sala.juego, orden });
      if (reparto) {
        sala.blackjack = reparto;
        sala.semillaRng = semilla;
        for (const [jugadorId, cartas] of reparto.manos) {
          io.to(jugadorId).emit('cartas', { numeroRonda: sala.numero_ronda, cartas, puntos: contarPuntos(cartas) });
        }
      }
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
      cancelarTurnos(sala, 'nueva_ronda');
      // Limpia temporizadores, apuestas y resultado, y suma una ronda.
      iniciarSiguienteRonda(sala, jugador.id);
      sala.turnos = null;

      difundirEstado(sala, 'fase');
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

    io.to(sala.codigo).emit('chat_mensaje', {
      codigo: sala.codigo,
      jugadorId: jugador.id,
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
  // Se cierran las salas y se apagan los relojes para no dejar temporizadores vivos.
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

module.exports = {
  app,
  servidor,
  io,
  salas,
  PUERTO,
  PUERTO_POR_DEFECTO,
  RUTA_PUBLIC,
  MENSAJE_BIENVENIDA
};
