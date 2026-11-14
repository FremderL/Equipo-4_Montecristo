'use strict';

// MonteCristo · lanzamiento de los juegos rápidos (Cara o Cruz · Dados · Ruleta)
//
// DOC-01 §3: en los juegos rápidos todos apuestan a la vez, hay un solo lanzamiento
// y la liquidación es inmediata para toda la sala. Este módulo recorre esa ronda
// completa sobre el motor de fases (lib/ronda.js):
//
//   apuestas ──(el anfitrión lanza)──▶ jugando ──(el servidor liquida)──▶ resultados
//
// Es puro: no conoce Express ni Socket.IO. Recibe la sala en memoria y el motor del
// juego (lib/juegos/*.js) y devuelve el resumen que el servidor difunde.
//
// Contrato del motor de un juego rápido:
//   JUEGO                       clave del juego, p. ej. 'coinflip'
//   validarOpcion(opcion)       → { ok: true, opcion } | { ok: false, error }   (al apostar)
//   lanzar(rng)                 → resultado autoritativo, p. ej. { lado: 'cara' }
//   evaluar(opcion, resultado)  → { multiplicador, … } con los pagos de DOC-02

const crypto = require('node:crypto');
const { FASES, cambiarFase, fasePermiteAccion, esAnfitrion } = require('./ronda.js');
const { liquidar } = require('./fichas.js');
const { crearRng } = require('./rng.js');

function errorLanzamiento(codigo, mensaje) {
  const fallo = new Error(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

/** Semilla nueva e impredecible para cada ronda: es `partidas.semilla_rng` (DOC-03). */
function nuevaSemilla() {
  return `sd_${crypto.randomBytes(16).toString('hex')}`;
}

/** `apuestas.resultado` de DOC-03, según lo que la apuesta dejó de verdad. */
function desenlace(neto) {
  if (neto > 0) return 'gana';
  return neto < 0 ? 'pierde' : 'empate';
}

/** Liquida UNA apuesta contra el resultado: multiplicador de DOC-02 → pago total y neto. */
function liquidarApuesta(motor, apuesta, resultado) {
  const { multiplicador } = motor.evaluar(apuesta.opcion, resultado);
  const { pago, neto } = liquidar(apuesta.monto, multiplicador);
  return { multiplicador, pago, neto, resultado: desenlace(neto) };
}

/**
 * Lo que la sala puede ver de una apuesta. Antes de lanzar, los campos de la
 * liquidación van en null; después traen el pago. Se usa igual en `estado_sala`
 * y en el evento `resultado`, para que la interfaz lea siempre la misma forma.
 */
function vistaDeApuesta(apuesta) {
  return {
    jugadorId: apuesta.jugadorId,
    nombre: apuesta.nombre ?? null,
    monto: apuesta.monto,
    opcion: apuesta.opcion,
    multiplicador: apuesta.multiplicador ?? null,
    pago: apuesta.pago ?? null,
    neto: apuesta.neto ?? null,
    resultado: apuesta.resultado ?? null
  };
}

function esMotorRapido(motor) {
  return Boolean(motor)
    && typeof motor.JUEGO === 'string'
    && typeof motor.lanzar === 'function'
    && typeof motor.evaluar === 'function';
}

/**
 * El anfitrión lanza: el servidor cierra las apuestas, genera el resultado, paga a
 * toda la sala con ese mismo resultado y deja la ronda en `resultados`.
 *
 * Opciones:
 *   jugadorId  quién pide lanzar (tiene que ser el anfitrión)
 *   semilla    semilla del RNG; por defecto una nueva al azar (se fija en pruebas)
 *   rng        generador ya construido; sustituye a la semilla (solo pruebas)
 *
 * No existe una opción para pasar el resultado: nadie puede dictarlo.
 * Devuelve { juego, numeroRonda, resultado, apuestas }, listo para difundir. La
 * semilla NO va en el resumen: queda en `sala.semillaRng`, del lado del servidor.
 */
function lanzarRonda(sala, motor, opciones) {
  if (!esMotorRapido(motor)) throw new TypeError('Se requiere el motor de un juego rápido (lib/juegos/*.js).');
  if (!sala || !(sala.jugadores instanceof Map) || !Array.isArray(sala.apuestas)) {
    throw new TypeError('Se requiere una sala en memoria con sus jugadores y apuestas.');
  }
  const { jugadorId, semilla, rng } = opciones || {};

  // 1 · Revisar. Un segundo `lanzar` encuentra la sala en `resultados` y se rechaza:
  //     la ronda se liquida UNA sola vez (DOC-04 §6.4).
  if (sala.juego !== motor.JUEGO) throw errorLanzamiento('JUEGO_INVALIDO', `En esta sala se juega ${sala.juego}.`);
  if (sala.fase === FASES.RESULTADOS) {
    throw errorLanzamiento('RONDA_LIQUIDADA', 'Esta ronda ya se lanzó y se liquidó: abre la siguiente ronda.');
  }
  if (!fasePermiteAccion(sala.fase, 'lanzar')) {
    throw errorLanzamiento('FASE_INVALIDA', 'Solo se lanza durante la fase de apuestas.');
  }
  if (!esAnfitrion(sala, jugadorId)) throw errorLanzamiento('SOLO_ANFITRION', 'Solo el anfitrión puede lanzar.');

  // Solo juegan las apuestas pendientes de quien sigue sentado: nunca se liquida
  // dos veces la misma apuesta ni se le paga a alguien que ya no está.
  const enJuego = sala.apuestas.filter((apuesta) => sala.jugadores.get(apuesta.jugadorId) && !apuesta.resultado);
  if (enJuego.length === 0) throw errorLanzamiento('SIN_APOSTADORES', 'Nadie confirmó una apuesta en esta ronda.');

  // 2 · Lanzar. El resultado sale del RNG del servidor, una vez y para toda la sala.
  const semillaUsada = typeof rng === 'function' ? null : String(semilla ?? nuevaSemilla());
  const resultado = motor.lanzar(typeof rng === 'function' ? rng : crearRng(semillaUsada));

  // 3 · Calcular todos los pagos antes de tocar la sala. Si algo falla hasta aquí
  //     (RNG roto, apuesta mal formada), la ronda sigue intacta en `apuestas`:
  //     nunca queda a medias, con la fase atorada o con pagos parciales.
  const liquidaciones = enJuego.map((apuesta) => liquidarApuesta(motor, apuesta, resultado));

  // 4 · Aplicar: se cierran las apuestas, se acredita y la sala pasa a resultados.
  cambiarFase(sala, FASES.JUGANDO, { jugadorId, apuestasConfirmadas: enJuego.length });
  const liquidadaEn = Date.now();
  enJuego.forEach((apuesta, indice) => {
    const jugador = sala.jugadores.get(apuesta.jugadorId);
    jugador.fichas += liquidaciones[indice].pago;
    Object.assign(apuesta, liquidaciones[indice], { nombre: jugador.nombre, liquidadaEn });
  });
  sala.apuestas.splice(0, sala.apuestas.length, ...enJuego);
  sala.apuestasConfirmadas = enJuego.length;
  sala.resultado = resultado;
  sala.semillaRng = semillaUsada;
  cambiarFase(sala, FASES.RESULTADOS, { servidor: true });

  return {
    juego: sala.juego,
    numeroRonda: sala.numero_ronda,
    resultado,
    apuestas: enJuego.map(vistaDeApuesta)
  };
}

module.exports = { lanzarRonda, liquidarApuesta, vistaDeApuesta, nuevaSemilla };
