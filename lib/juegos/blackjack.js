'use strict';

// MonteCristo · Blackjack / 21 (DOC-02 §6)
// Reparto inicial con un mazo de 52 cartas, conteo de puntos y jugadas del
// participante en su turno: pedir otra carta (`hit`) o plantarse (`stand`).
// Si al pedir supera 21 puntos, su mano queda pasada y pierde de inmediato.
// Al terminar los turnos juega la casa (pide hasta llegar a 17), se comparan
// las manos y se paga cada apuesta según la tabla de DOC-02 §6.

const { REGLAS, PAGOS } = require('../reglas.js');
const { crearMazo, sacarCarta } = require('../rng.js');
const { liquidar } = require('../fichas.js');
const { normalizarAccion } = require('../turno.js');

const JUEGO = 'blackjack';
const TOPE_PUNTOS = 21;
const ACCIONES_TURNO = Object.freeze(['hit', 'stand']);
const ESTADOS_MANO = Object.freeze({
  JUGANDO: 'jugando',
  PLANTADO: 'plantado',
  PASADO: 'pasado'
});

const MENSAJE_ACCION = 'En tu turno solo puedes pedir otra carta (hit) o plantarte (stand).';

function errorBlackjack(codigo, mensaje) {
  const fallo = new Error(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

/** Cuenta los ases como 1; a lo sumo uno puede subir a 11 sin pasarse de 21. */
function contarPuntos(cartas) {
  let total = 0;
  let hayAs = false;
  for (const carta of cartas) {
    const rango = carta.slice(0, -1); // «10♥» → «10»
    if (rango === 'A') {
      total += 1;
      hayAs = true;
    } else {
      total += ['J', 'Q', 'K'].includes(rango) ? 10 : Number(rango);
    }
  }
  return hayAs && total + 10 <= TOPE_PUNTOS ? total + 10 : total;
}

/** Verdadero cuando la mano o el puntaje supera 21 (bust). */
function sePaso(cartasOPuntos) {
  const puntos = Array.isArray(cartasOPuntos) ? contarPuntos(cartasOPuntos) : Number(cartasOPuntos);
  return puntos > TOPE_PUNTOS;
}

/** Blackjack natural: 21 puntos con exactamente las dos primeras cartas. */
function esNatural(cartas) {
  return Array.isArray(cartas) && cartas.length === 2 && contarPuntos(cartas) === TOPE_PUNTOS;
}

/** Estado privado de la ronda: ni el mazo ni el conjunto de manos se difunden. */
function repartirInicial(orden, rng) {
  if (!Array.isArray(orden) || orden.length < 1 || orden.length > REGLAS.JUGADORES_POR_SALA) {
    throw new RangeError(`Se requieren entre 1 y ${REGLAS.JUGADORES_POR_SALA} jugadores para repartir.`);
  }
  const manos = new Map(orden.map((id) => [id, []]));
  if (manos.size !== orden.length) throw new Error('Un jugador no puede ocupar dos asientos.');

  const mazo = crearMazo(REGLAS.MAZOS_BLACKJACK, rng);
  const casa = [];
  for (let vuelta = 0; vuelta < 2; vuelta += 1) {
    for (const mano of manos.values()) mano.push(sacarCarta(mazo));
    casa.push(sacarCarta(mazo));
  }
  const estados = new Map(orden.map((id) => [id, ESTADOS_MANO.JUGANDO]));
  return { mazo, manos, casa, estados };
}

function obtenerEstados(partida) {
  if (!partida || !(partida.manos instanceof Map)) return null;
  if (!(partida.estados instanceof Map)) {
    partida.estados = new Map(
      Array.from(partida.manos.keys(), (id) => [
        id,
        sePaso(partida.manos.get(id)) ? ESTADOS_MANO.PASADO : ESTADOS_MANO.JUGANDO
      ])
    );
  }
  return partida.estados;
}

function estadoDeMano(partida, jugadorId) {
  const estados = obtenerEstados(partida);
  if (!estados || !partida.manos.has(jugadorId)) return null;
  return estados.get(jugadorId) || ESTADOS_MANO.JUGANDO;
}

/** Resumen privado de la mano de un jugador (solo para su propio socket). */
function detalleMano(partida, jugadorId) {
  if (!partida || !(partida.manos instanceof Map) || !partida.manos.has(jugadorId)) return null;
  const cartas = [...partida.manos.get(jugadorId)];
  const puntos = contarPuntos(cartas);
  const estado = estadoDeMano(partida, jugadorId);
  const pasado = estado === ESTADOS_MANO.PASADO || puntos > TOPE_PUNTOS;
  return { cartas, puntos, estado, pasado };
}

/** Valida que la jugada sea `hit` o `stand` (o sus sinónimos) y que la mano siga abierta. */
function validarAccionJugador(partida, jugadorId, accion) {
  const normalizada = normalizarAccion(JUEGO, accion);
  if (!normalizada.valida || !ACCIONES_TURNO.includes(normalizada.accion)) {
    return { ok: false, codigo: 'ACCION_INVALIDA', error: MENSAJE_ACCION };
  }
  if (!partida || !(partida.manos instanceof Map) || !partida.manos.has(jugadorId)) {
    return { ok: false, codigo: 'SIN_MANO', error: 'No tienes una mano activa en esta ronda.' };
  }
  if (estadoDeMano(partida, jugadorId) !== ESTADOS_MANO.JUGANDO) {
    return { ok: false, codigo: 'MANO_CERRADA', error: 'Tu mano ya está cerrada en esta ronda.' };
  }
  if (normalizada.accion === 'hit' && (!Array.isArray(partida.mazo) || partida.mazo.length === 0)) {
    return { ok: false, codigo: 'SIN_CARTAS', error: 'No quedan cartas disponibles en el mazo.' };
  }
  return { ok: true, accion: normalizada.accion };
}

/**
 * El jugador pide otra carta (`hit`): roba una del mazo. Si supera 21 se pasa,
 * pierde de inmediato y cede el turno; con 21 o menos conserva su turno.
 */
function pedirCarta(partida, jugadorId) {
  const revision = validarAccionJugador(partida, jugadorId, 'hit');
  if (!revision.ok) throw errorBlackjack(revision.codigo, revision.error);

  const carta = sacarCarta(partida.mazo);
  const mano = partida.manos.get(jugadorId);
  mano.push(carta);

  const puntos = contarPuntos(mano);
  const pasado = sePaso(puntos);
  const estado = pasado ? ESTADOS_MANO.PASADO : ESTADOS_MANO.JUGANDO;
  obtenerEstados(partida).set(jugadorId, estado);

  return {
    accion: 'hit',
    carta,
    cartas: [...mano],
    puntos,
    estado,
    pasado,
    perdio: pasado,
    multiplicador: pasado ? PAGOS.blackjack.derrota : null,
    mantenerTurno: !pasado
  };
}

/** El jugador se planta (`stand`): cierra su mano con los puntos actuales y cede el turno. */
function plantarse(partida, jugadorId) {
  const revision = validarAccionJugador(partida, jugadorId, 'stand');
  if (!revision.ok) throw errorBlackjack(revision.codigo, revision.error);

  const mano = partida.manos.get(jugadorId);
  const puntos = contarPuntos(mano);
  obtenerEstados(partida).set(jugadorId, ESTADOS_MANO.PLANTADO);

  return {
    accion: 'stand',
    carta: null,
    cartas: [...mano],
    puntos,
    estado: ESTADOS_MANO.PLANTADO,
    pasado: false,
    perdio: false,
    multiplicador: null,
    mantenerTurno: false
  };
}

/** Ejecuta `hit` o `stand` (acepta también `pedir`, `carta` y `plantarse`). */
function aplicarAccionJugador(partida, jugadorId, accion) {
  const revision = validarAccionJugador(partida, jugadorId, accion);
  if (!revision.ok) throw errorBlackjack(revision.codigo, revision.error);
  return revision.accion === 'hit'
    ? pedirCarta(partida, jugadorId)
    : plantarse(partida, jugadorId);
}

/**
 * Liquida de inmediato la apuesta de quien se pasó de 21 (DOC-02 §6 y caso 16):
 * multiplicador ×0, pago 0 y resultado `pierde`. Idempotente: nunca liquida dos veces.
 */
function liquidarDerrotaInmediata(apuesta) {
  if (!apuesta || typeof apuesta !== 'object') {
    throw new TypeError('Se requiere la apuesta del jugador para liquidar la derrota.');
  }
  if (apuesta.resultado !== undefined && apuesta.resultado !== null) return apuesta;

  const multiplicador = PAGOS.blackjack.derrota;
  const { pago, neto } = liquidar(apuesta.monto, multiplicador);
  Object.assign(apuesta, {
    multiplicador,
    pago,
    neto,
    resultado: 'pierde',
    liquidadaEn: Date.now()
  });
  return apuesta;
}

/** Hasta el cierre, ni la segunda carta ni sus puntos salen del servidor. */
function vistaDeCasa(casa, revelar = false) {
  if (revelar) return { cartas: [...casa], puntos: contarPuntos(casa) };
  const [visible] = casa;
  return { cartas: [visible, null], puntos: contarPuntos([visible]) };
}

/**
 * Turno de la casa (DOC-02 §6): pide cartas mientras sume 16 o menos y se
 * planta con 17 o más, incluido el 17 blando (As + 6). Si se pasa de 21 se
 * detiene con la mano pasada; si el mazo se acaba, se detiene con lo que tiene.
 * Idempotente: con 17 o más (o pasada) no roba nada, así que llamarlo dos
 * veces nunca mueve cartas de más.
 */
function turnoDeCasa(partida) {
  if (!partida || !Array.isArray(partida.casa) || !Array.isArray(partida.mazo)) {
    throw new TypeError('Se requiere una partida con la mano de la casa y el mazo.');
  }
  const robadas = [];
  while (contarPuntos(partida.casa) < REGLAS.PLANTARSE_CASA) {
    const carta = sacarCarta(partida.mazo);
    if (carta === null) break;
    partida.casa.push(carta);
    robadas.push(carta);
  }
  const puntos = contarPuntos(partida.casa);
  return {
    cartas: [...partida.casa],
    puntos,
    robadas,
    pasado: sePaso(puntos),
    plantado: puntos >= REGLAS.PLANTARSE_CASA && !sePaso(puntos)
  };
}

/**
 * Compara una mano del jugador contra la mano final de la casa y decide el
 * desenlace (DOC-02 §6): natural ×2,5 · victoria ×2 · empate ×1 ·
 * derrota o bust ×0. La casa con natural gana a cualquier mano que no sea
 * natural; quien se pasó de 21 pierde aunque la casa también se pase.
 */
function compararConCasa(cartasJugador, cartasCasa) {
  if (!Array.isArray(cartasJugador) || cartasJugador.length === 0) {
    throw new TypeError('Se requiere la mano del jugador para comparar.');
  }
  if (!Array.isArray(cartasCasa) || cartasCasa.length === 0) {
    throw new TypeError('Se requiere la mano de la casa para comparar.');
  }
  const puntosJugador = contarPuntos(cartasJugador);
  const puntosCasa = contarPuntos(cartasCasa);
  const naturalJugador = esNatural(cartasJugador);
  const naturalCasa = esNatural(cartasCasa);
  const pasadoJugador = sePaso(puntosJugador);
  const pasadoCasa = sePaso(puntosCasa);

  let resultado;
  let multiplicador;
  if (pasadoJugador) {
    resultado = 'pierde';
    multiplicador = PAGOS.blackjack.derrota;
  } else if (naturalJugador && naturalCasa) {
    resultado = 'empate';
    multiplicador = PAGOS.blackjack.empate;
  } else if (naturalJugador) {
    resultado = 'gana';
    multiplicador = PAGOS.blackjack.natural;
  } else if (naturalCasa) {
    resultado = 'pierde';
    multiplicador = PAGOS.blackjack.derrota;
  } else if (pasadoCasa || puntosJugador > puntosCasa) {
    resultado = 'gana';
    multiplicador = PAGOS.blackjack.victoria;
  } else if (puntosJugador < puntosCasa) {
    resultado = 'pierde';
    multiplicador = PAGOS.blackjack.derrota;
  } else {
    resultado = 'empate';
    multiplicador = PAGOS.blackjack.empate;
  }

  return {
    resultado,
    multiplicador,
    puntosJugador,
    puntosCasa,
    naturalJugador,
    naturalCasa,
    pasadoJugador,
    pasadoCasa
  };
}

/**
 * Liquida una apuesta contra la mano final de la casa: compara las manos,
 * calcula el pago total de DOC-02 y lo deja en la apuesta. Idempotente: una
 * apuesta ya liquidada (p. ej. por bust) nunca se paga dos veces.
 */
function liquidarContraCasa(apuesta, cartasJugador, cartasCasa) {
  if (!apuesta || typeof apuesta !== 'object') {
    throw new TypeError('Se requiere la apuesta del jugador para liquidar contra la casa.');
  }
  if (apuesta.resultado !== undefined && apuesta.resultado !== null) return apuesta;

  const { resultado, multiplicador } = compararConCasa(cartasJugador, cartasCasa);
  const { pago, neto } = liquidar(apuesta.monto, multiplicador);
  Object.assign(apuesta, {
    multiplicador,
    pago,
    neto,
    resultado,
    liquidadaEn: Date.now()
  });
  return apuesta;
}

module.exports = {
  JUEGO,
  TOPE_PUNTOS,
  ACCIONES_TURNO,
  ESTADOS_MANO,
  contarPuntos,
  sePaso,
  esNatural,
  repartirInicial,
  vistaDeCasa,
  turnoDeCasa,
  compararConCasa,
  liquidarContraCasa,
  estadoDeMano,
  detalleMano,
  validarAccionJugador,
  pedirCarta,
  plantarse,
  aplicarAccionJugador,
  liquidarDerrotaInmediata
};
