'use strict';

// MonteCristo · Cara o Cruz (DOC-02 §3)
// El juego más simple: cada jugador apuesta a `cara` o a `cruz`, el servidor lanza
// UNA moneda para toda la sala y paga el doble (×2) a quien le atina; quien falla
// pierde lo apostado (×0).
//
// El módulo es puro: no conoce Express ni Socket.IO y no mueve fichas. Solo
// responde las tres preguntas del juego —¿la opción existe?, ¿qué salió?, ¿cuánto
// paga?— y con eso cumple el contrato de motor que usa lib/lanzamiento.js.

const { PAGOS } = require('../reglas.js');
const { lanzarMoneda } = require('../rng.js');

const JUEGO = 'coinflip';

/** Los dos lados de la moneda: las únicas opciones de apuesta (DOC-02 §10.6). */
const OPCIONES = Object.freeze(['cara', 'cruz']);

const MENSAJE_OPCION = 'Elige cara o cruz para apostar.';

/** « Cara » → «cara». Lo que no es texto queda vacío y no pasa la validación. */
function normalizarOpcion(opcion) {
  return typeof opcion === 'string' ? opcion.trim().toLowerCase() : '';
}

/** Mismo formato que validarApuesta (lib/fichas.js): { ok: true } o { ok: false, error }. */
function validarOpcion(opcion) {
  const limpia = normalizarOpcion(opcion);
  if (!OPCIONES.includes(limpia)) return { ok: false, error: MENSAJE_OPCION };
  return { ok: true, opcion: limpia };
}

/**
 * El servidor lanza la moneda: 50 % cara, 50 % cruz (lib/rng.js).
 * Devuelve un objeto para guardarlo tal cual en `partidas.resultado` (DOC-03).
 */
function lanzar(rng) {
  return { lado: lanzarMoneda(rng) };
}

/**
 * Compara una apuesta con lo que salió y devuelve su multiplicador de DOC-02:
 * acierto ×2, fallo ×0. No acepta opciones ni resultados que no existan: una
 * apuesta mal formada nunca se paga «por las dudas».
 */
function evaluar(opcion, resultado) {
  const apuesta = validarOpcion(opcion);
  if (!apuesta.ok) throw new TypeError('Opción de apuesta inválida: se esperaba cara o cruz.');

  const lado = resultado ? resultado.lado : undefined;
  if (!OPCIONES.includes(lado)) throw new TypeError('Resultado inválido: la moneda solo cae en cara o cruz.');

  const acierto = apuesta.opcion === lado;
  return { acierto, multiplicador: acierto ? PAGOS.coinflip.acierto : PAGOS.coinflip.fallo };
}

module.exports = { JUEGO, OPCIONES, normalizarOpcion, validarOpcion, lanzar, evaluar };
