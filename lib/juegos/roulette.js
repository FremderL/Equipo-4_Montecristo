'use strict';

// MonteCristo · Ruleta europea (DOC-02 §5)
const { PAGOS } = require('../reglas.js');
const { girarRuleta, ROJOS } = require('../rng.js');

const JUEGO = 'roulette';
const NUMERO_MAXIMO = 36;
const OPCIONES = Object.freeze([
  'rojo', 'negro', 'par', 'impar',
  ...Array.from({ length: NUMERO_MAXIMO + 1 }, (_, numero) => `n:${numero}`)
]);
const MENSAJE_OPCION = 'Elige rojo, negro, par, impar o un número exacto (n:0 a n:36).';

function normalizarOpcion(opcion) {
  return typeof opcion === 'string' ? opcion.trim().toLowerCase() : '';
}

function validarOpcion(opcion) {
  const limpia = normalizarOpcion(opcion);
  if (!OPCIONES.includes(limpia)) return { ok: false, error: MENSAJE_OPCION };
  return { ok: true, opcion: limpia };
}

function lanzar(rng) {
  return girarRuleta(rng);
}

function evaluar(opcion, resultado) {
  const apuesta = validarOpcion(opcion);
  if (!apuesta.ok) throw new TypeError(apuesta.error);

  const numero = resultado?.numero;
  if (!Number.isInteger(numero) || numero < 0 || numero > NUMERO_MAXIMO) {
    throw new TypeError('Resultado inválido: se esperaba un número entero del 0 al 36.');
  }

  const { pleno, simple, fallo } = PAGOS.roulette;
  if (apuesta.opcion === `n:${numero}`) return { acierto: true, multiplicador: pleno };
  // El cero es verde y no cuenta para ninguna apuesta de paridad.
  if (numero === 0) return { acierto: false, multiplicador: fallo };

  const color = ROJOS.has(numero) ? 'rojo' : 'negro';
  const paridad = numero % 2 === 0 ? 'par' : 'impar';
  const acierto = apuesta.opcion === color || apuesta.opcion === paridad;
  return { acierto, multiplicador: acierto ? simple : fallo };
}

module.exports = { JUEGO, OPCIONES, normalizarOpcion, validarOpcion, lanzar, evaluar };
