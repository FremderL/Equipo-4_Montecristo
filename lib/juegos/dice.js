'use strict';

// MonteCristo · Dados (DOC-02 §4)
// Se lanza UN dado de 6 caras (1–6) para toda la sala. Cada jugador apuesta a:
//   «bajo» (1–3) ×2 · «alto» (4–6) ×2 · o a un número exacto (n:1…n:6) ×6.
// Quien falle pierde lo apostado (×0). El 1 no es comodín: simplemente es «bajo».
//
// El módulo es puro: no conoce Express ni Socket.IO y no mueve fichas. Solo
// responde las tres preguntas del juego —¿la opción existe?, ¿qué salió?, ¿cuánto
// paga?— y con eso cumple el contrato de motor que usa lib/lanzamiento.js.

const { PAGOS } = require('../reglas.js');
const { lanzarDado } = require('../rng.js');

const JUEGO = 'dice';

/** Las ocho opciones de apuesta (DOC-02 §4 y §10.6): bajo, alto y los seis números exactos. */
const OPCIONES = Object.freeze(['bajo', 'alto', 'n:1', 'n:2', 'n:3', 'n:4', 'n:5', 'n:6']);

const MENSAJE_OPCION = 'Elige «bajo» (1–3), «alto» (4–6) o un número exacto del 1 al 6 (n:1…n:6) para apostar.';

/** « N:5 » → «n:5». Lo que no es texto queda vacío y no pasa la validación. */
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
 * El servidor lanza el dado: cada cara con la misma probabilidad (lib/rng.js).
 * Devuelve un objeto para guardarlo tal cual en `partidas.resultado` (DOC-03).
 */
function lanzar(rng) {
  return { valor: lanzarDado(rng) };
}

/**
 * Compara una apuesta con lo que salió y devuelve su multiplicador de DOC-02:
 * bajo 1–3 ×2 · alto 4–6 ×2 · número exacto ×6 · fallo ×0. No acepta opciones ni
 * resultados que no existan: una apuesta mal formada nunca se paga «por las dudas».
 */
function evaluar(opcion, resultado) {
  const apuesta = validarOpcion(opcion);
  if (!apuesta.ok) throw new TypeError('Opción de apuesta inválida: se esperaba bajo, alto o n:1…n:6.');

  const valor = resultado ? resultado.valor : undefined;
  if (!Number.isInteger(valor) || valor < 1 || valor > 6) {
    throw new TypeError('Resultado inválido: el dado solo cae en un entero del 1 al 6.');
  }

  const elegida = apuesta.opcion;
  let acierto;
  if (elegida === 'bajo') acierto = valor <= 3;
  else if (elegida === 'alto') acierto = valor >= 4;
  else acierto = Number(elegida.slice(2)) === valor;

  const clave = elegida === 'bajo' || elegida === 'alto' ? elegida : 'exacto';
  return { acierto, multiplicador: acierto ? PAGOS.dice[clave] : PAGOS.dice.fallo };
}

module.exports = { JUEGO, OPCIONES, normalizarOpcion, validarOpcion, lanzar, evaluar };
