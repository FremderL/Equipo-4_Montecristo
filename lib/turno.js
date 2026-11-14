'use strict';

// MonteCristo · reloj de turno (límite de tiempo por turno)
// Regla del ticket: si el jugador no hace nada, EL SERVIDOR DECIDE POR ÉL
// (blackjack: se planta · póker: pasa si puede, si no se retira) para que la
// partida nunca se quede atorada esperando una acción.
//
// El módulo es puro: no conoce Express ni Socket.IO. Recibe el orden de los
// jugadores, los tiempos de DOC-02 y funciones de reloj inyectables, y avisa
// por callbacks cuándo arranca un turno, cuándo se resuelve (por el jugador o
// por inactividad) y cuándo se termina la vuelta.

const { REGLAS } = require('./reglas.js');

/** Milisegundos por juego (DOC-02 §4). Los juegos rápidos no tienen reloj. */
const TIEMPOS_DE_TURNO = Object.freeze({
  blackjack: REGLAS.TIEMPO_TURNO_BLACKJACK_MS,
  poker: REGLAS.TIEMPO_TURNO_POKER_MS
});

/** Acciones canónicas que acepta cada juego por turno (DOC-04 §3.2). */
const ACCIONES_POR_JUEGO = Object.freeze({
  blackjack: Object.freeze(['hit', 'stand', 'double', 'split']),
  poker: Object.freeze(['fold', 'check', 'call', 'raise', 'all_in'])
});

/** La interfaz habla español: se aceptan ambos nombres y se normaliza al canónico. */
const SINONIMOS = Object.freeze({
  pedir: 'hit',
  carta: 'hit',
  plantarse: 'stand',
  doblar: 'double',
  dividir: 'split',
  retirarse: 'fold',
  pasar: 'check',
  igualar: 'call',
  subir: 'raise',
  todo: 'all_in'
});

/** Lo que el servidor juega por el jugador cuando el reloj vence. */
const DECISION_AUTOMATICA = Object.freeze({
  PLANTARSE: 'stand',
  PASAR: 'check',
  RETIRARSE: 'fold'
});

function errorTurno(codigo, mensaje) {
  const fallo = new Error(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

/** Devuelve el límite del turno en ms, o null si el juego no usa reloj. */
function tiempoDeTurno(juego, tiempos = TIEMPOS_DE_TURNO) {
  if (typeof juego !== 'string' || !juego) return null;
  const ms = Number(tiempos ? tiempos[juego] : NaN);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : null;
}

function juegoTieneReloj(juego, tiempos = TIEMPOS_DE_TURNO) {
  return tiempoDeTurno(juego, tiempos) !== null;
}

/** Traduce «plantarse» → «stand» y dice si la acción existe en ese juego. */
function normalizarAccion(juego, accion) {
  const cruda = typeof accion === 'string' ? accion.trim().toLowerCase() : '';
  const canonica = Object.prototype.hasOwnProperty.call(SINONIMOS, cruda) ? SINONIMOS[cruda] : cruda;
  const permitidas = ACCIONES_POR_JUEGO[juego] || [];
  return { accion: canonica, permitidas, valida: permitidas.includes(canonica) };
}

/**
 * Decisión del servidor cuando el jugador no responde (DOC-01 §7 y DOC-04 §5):
 *   blackjack → se planta · póker → pasa si puede, si no se retira.
 * `contexto.apuestaPorIgualar` son las fichas que faltan por igualar en póker.
 * `motivo` distingue el reloj vencido ('inactividad') de quien salió de la mesa
 * ('abandono'): la decisión es la misma, cambia la explicación que ve la mesa.
 */
function accionPorInactividad(juego, contexto = {}, motivo = 'inactividad') {
  const causa = motivo === 'abandono' ? 'El jugador salió de la mesa' : 'Se acabó el tiempo';

  if (juego === 'blackjack') {
    return {
      accion: DECISION_AUTOMATICA.PLANTARSE,
      automatica: true,
      motivo,
      mensaje: `${causa}: el servidor plantó la mano.`
    };
  }

  if (juego === 'poker') {
    const porIgualar = Math.max(0, Number(contexto.apuestaPorIgualar) || 0);
    const puedePasar = contexto.puedePasar === undefined ? porIgualar <= 0 : Boolean(contexto.puedePasar);
    return puedePasar
      ? {
        accion: DECISION_AUTOMATICA.PASAR,
        automatica: true,
        motivo,
        mensaje: `${causa}: el servidor pasó.`
      }
      : {
        accion: DECISION_AUTOMATICA.RETIRARSE,
        automatica: true,
        motivo,
        mensaje: `${causa}: faltaban ${porIgualar} fichas por igualar y el servidor retiró la mano.`
      };
  }

  return { accion: null, automatica: true, motivo, mensaje: 'Este juego no tiene acciones por turno.' };
}

function notificar(callback, dato) {
  if (typeof callback === 'function') callback(dato);
}

/**
 * Crea el reloj de una vuelta (una mano de blackjack o una calle de póker).
 *
 * Opciones relevantes:
 *   juego              'blackjack' | 'poker' (define tiempo y decisión automática)
 *   orden              [jugadorId, …] en el orden en que juegan
 *   tiempoMs           sobrescribe el tiempo del juego (pruebas, mesas rápidas)
 *   sala               sala en memoria; su Set `temporizadores` guarda los handles
 *   contexto(jugadorId) datos para decidir en póker ({ apuestaPorIgualar })
 *   validar(jugadorId, accion, extra) regla extra del motor; { ok:false, error } rechaza
 *   ahora / programar / cancelar      reloj inyectable (por defecto Date.now y setTimeout)
 *   alIniciarTurno / alResolver / alTerminar / alCancelar   avisos al servidor
 */
function crearRelojDeTurnos(opciones = {}) {
  const juego = typeof opciones.juego === 'string' ? opciones.juego : '';
  const tiempoMs = Number.isFinite(opciones.tiempoMs) && opciones.tiempoMs > 0
    ? Math.floor(opciones.tiempoMs)
    : tiempoDeTurno(juego, opciones.tiempos);
  const orden = (Array.isArray(opciones.orden) ? opciones.orden : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const sala = opciones.sala && typeof opciones.sala === 'object' ? opciones.sala : null;

  const ahora = typeof opciones.ahora === 'function' ? opciones.ahora : () => Date.now();
  const programar = typeof opciones.programar === 'function' ? opciones.programar : (fn, ms) => setTimeout(fn, ms);
  const desprogramar = typeof opciones.cancelar === 'function' ? opciones.cancelar : (id) => clearTimeout(id);

  const contextoDe = typeof opciones.contexto === 'function' ? opciones.contexto : () => ({});
  const validar = typeof opciones.validar === 'function' ? opciones.validar : null;
  const alIniciarTurno = typeof opciones.alIniciarTurno === 'function' ? opciones.alIniciarTurno : null;
  const alResolver = typeof opciones.alResolver === 'function' ? opciones.alResolver : null;
  const alTerminar = typeof opciones.alTerminar === 'function' ? opciones.alTerminar : null;
  const alCancelar = typeof opciones.alCancelar === 'function' ? opciones.alCancelar : null;

  const estado = {
    iniciado: false,
    terminado: false,
    cancelado: false,
    indice: -1,
    jugadorId: null,
    inicioTurno: null,
    deadline: null,
    temporizador: null,
    // Cada turno nuevo incrementa la generación: un temporizador viejo que se
    // dispare tarde se ignora y nadie decide dos veces sobre la misma mano.
    generacion: 0,
    registros: []
  };

  function registrarTemporizador(id) {
    if (sala && sala.temporizadores instanceof Set) sala.temporizadores.add(id);
  }

  function liberarTemporizador(id) {
    if (sala && sala.temporizadores instanceof Set) sala.temporizadores.delete(id);
  }

  function limpiarTemporizador() {
    if (estado.temporizador !== null) {
      desprogramar(estado.temporizador);
      liberarTemporizador(estado.temporizador);
      estado.temporizador = null;
    }
    estado.deadline = null;
  }

  function segundosRestantes() {
    if (estado.deadline === null || !estado.jugadorId) return null;
    return Math.max(0, Math.ceil((estado.deadline - ahora()) / 1000));
  }

  /** Vista pública: es lo que viaja en `estado_sala.turno` y en el evento `turno`. */
  function vistaPublica() {
    return {
      juego,
      jugadorId: estado.jugadorId,
      deadline: estado.deadline,
      tiempoMs,
      segundosRestantes: segundosRestantes(),
      posicion: estado.jugadorId ? estado.indice + 1 : null,
      total: orden.length,
      activo: Boolean(estado.jugadorId) && !estado.terminado && !estado.cancelado
    };
  }

  function programarVencimiento() {
    limpiarTemporizador();
    if (tiempoMs === null) return; // juego sin reloj: espera la acción sin límite

    const generacion = estado.generacion;
    estado.deadline = ahora() + tiempoMs;
    const id = programar(() => {
      // Idempotencia: si el turno ya cambió, ya se resolvió o la ronda se
      // canceló, este disparo es basura y no debe decidir nada.
      if (generacion !== estado.generacion || estado.terminado || estado.cancelado) return;
      estado.temporizador = null;
      if (sala && sala.temporizadores instanceof Set) liberarTemporizador(id);
      vencer('inactividad');
    }, tiempoMs);

    estado.temporizador = id;
    registrarTemporizador(id);
  }

  function siguienteTurno() {
    estado.indice += 1;
    if (estado.indice >= orden.length) {
      terminar('completo');
      return;
    }
    estado.jugadorId = orden[estado.indice];
    estado.inicioTurno = ahora();
    estado.generacion += 1;
    programarVencimiento();
    notificar(alIniciarTurno, vistaPublica());
  }

  function terminar(motivo) {
    estado.generacion += 1;
    limpiarTemporizador();
    estado.jugadorId = null;
    estado.inicioTurno = null;
    if (estado.terminado) return;
    estado.terminado = true;
    notificar(alTerminar, { motivo, registros: estado.registros.slice(), total: orden.length });
  }

  function resolverTurno(accion, datos = {}) {
    const automatica = Boolean(datos.automatica);
    const registro = {
      jugadorId: estado.jugadorId,
      accion,
      automatica,
      motivo: datos.motivo || (automatica ? 'inactividad' : 'jugador'),
      mensaje: datos.mensaje || null,
      monto: Number.isFinite(datos.monto) ? Number(datos.monto) : null,
      posicion: estado.indice + 1,
      total: orden.length,
      inicioTurno: estado.inicioTurno,
      deadline: estado.deadline,
      resueltoEn: ahora(),
      tiempoUsadoMs: estado.inicioTurno === null ? null : Math.max(0, ahora() - estado.inicioTurno)
    };

    estado.registros.push(registro);
    estado.generacion += 1;
    limpiarTemporizador();
    estado.jugadorId = null; // la vista pública no señala a nadie hasta el siguiente turno
    notificar(alResolver, registro);
    siguienteTurno();
    return registro;
  }

  /** Aplica la decisión automática del servidor sobre el turno vigente. */
  function vencer(motivo = 'inactividad') {
    if (estado.terminado || estado.cancelado || !estado.jugadorId) return null;
    const decision = accionPorInactividad(juego, contextoDe(estado.jugadorId) || {}, motivo);
    return resolverTurno(decision.accion, {
      automatica: true,
      motivo: decision.motivo,
      mensaje: decision.mensaje
    });
  }

  /** Arranca la vuelta: primer jugador + su reloj. */
  function iniciar() {
    if (estado.iniciado) return vistaPublica();
    estado.iniciado = true;
    if (orden.length === 0) {
      terminar('sin_jugadores');
      return vistaPublica();
    }
    siguienteTurno();
    return vistaPublica();
  }

  /**
   * Acción enviada por el jugador. Valida turno, reloj y acción; si llega tarde,
   * el servidor ya decidió y se rechaza con TURNO_VENCIDO.
   */
  function jugar(jugadorId, accion, extra = {}) {
    const id = String(jugadorId || '').trim();
    if (estado.cancelado) throw errorTurno('RELOJ_CANCELADO', 'El reloj de esta ronda ya no está activo.');
    if (estado.terminado) throw errorTurno('RONDA_CERRADA', 'La ronda ya terminó: no hay turnos activos.');
    if (!id || id !== estado.jugadorId) throw errorTurno('TURNO_AJENO', 'No es tu turno: espera a que el servidor te lo asigne.');

    if (estado.deadline !== null && ahora() >= estado.deadline) {
      // El reloj ya venció aunque el disparo no haya corrido: decide el servidor.
      vencer('inactividad');
      throw errorTurno('TURNO_VENCIDO', 'Se acabó tu tiempo: el servidor decidió por ti.');
    }

    const normalizada = normalizarAccion(juego, accion);
    if (!normalizada.valida) {
      throw errorTurno('ACCION_INVALIDA', `Acción no permitida en ${juego}. Opciones: ${normalizada.permitidas.join(', ')}.`);
    }

    if (validar) {
      const revision = validar(id, normalizada.accion, extra) || {};
      if (revision.ok === false) throw errorTurno(revision.codigo || 'ACCION_INVALIDA', revision.error || 'La acción no es válida en este momento.');
    }

    return resolverTurno(normalizada.accion, {
      automatica: false,
      motivo: 'jugador',
      monto: extra && extra.monto
    });
  }

  /**
   * El jugador salió de la mesa o se desconectó: si era su turno, el servidor
   * decide por él y la vuelta sigue; si no, se quita de los turnos pendientes.
   */
  function retirarJugador(jugadorId, motivo = 'abandono') {
    const id = String(jugadorId || '').trim();
    if (!id || estado.terminado || estado.cancelado) return null;

    const eraSuTurno = estado.jugadorId === id;
    const registro = eraSuTurno ? vencer(motivo) : null;
    const corte = Math.max(estado.indice, 0);
    const pendientes = orden.slice(corte).filter((otro) => otro !== id);
    orden.length = corte;
    orden.push(...pendientes);

    if (!estado.terminado && corte >= orden.length) terminar('sin_jugadores');
    return registro;
  }

  /** Cancela el reloj sin decidir nada (nueva ronda, sala cerrada, apagado). */
  function cancelar(motivo = 'cancelado') {
    if (estado.cancelado) return null;
    estado.generacion += 1;
    limpiarTemporizador();
    estado.jugadorId = null;
    estado.inicioTurno = null;
    estado.cancelado = true;
    estado.terminado = true;
    notificar(alCancelar, { motivo, registros: estado.registros.slice(), total: orden.length });
    return { motivo, registros: estado.registros.slice() };
  }

  return {
    iniciar,
    jugar,
    vencer,
    retirarJugador,
    cancelar,
    vistaPublica,
    registros: () => estado.registros.slice(),
    get juego() { return juego; },
    get tiempoMs() { return tiempoMs; },
    get orden() { return orden.slice(); },
    get jugadorId() { return estado.jugadorId; },
    get deadline() { return estado.deadline; },
    get segundosRestantes() { return segundosRestantes(); },
    get iniciado() { return estado.iniciado; },
    get terminado() { return estado.terminado; },
    get cancelado() { return estado.cancelado; }
  };
}

module.exports = {
  TIEMPOS_DE_TURNO,
  ACCIONES_POR_JUEGO,
  DECISION_AUTOMATICA,
  SINONIMOS,
  tiempoDeTurno,
  juegoTieneReloj,
  normalizarAccion,
  accionPorInactividad,
  crearRelojDeTurnos
};
