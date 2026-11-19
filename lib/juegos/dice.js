'use strict';

const { PAGOS } = require('../reglas.js');
const { lanzarDado } = require('../rng.js');

const JUEGO = 'dice';
const OPCIONES = ['bajo', 'alto', ...Array.from({ length: 6 }, (_, i) => `n:${i + 1}`)];

function validarOpcion(valor) {
  const opcion = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  return OPCIONES.includes(opcion)
    ? { ok: true, opcion }
    : { ok: false, error: 'Elige bajo, alto o un número del 1 al 6.' };
}

function lanzar(rng) {
  return { numero: lanzarDado(rng) };
}

function evaluar(valor, { numero }) {
  const { ok, opcion } = validarOpcion(valor);
  if (!ok || !Number.isInteger(numero) || numero < 1 || numero > 6) throw new TypeError('Apuesta o dado inválido.');
  const rango = numero <= 3 ? 'bajo' : 'alto';
  const acierto = opcion === rango || opcion === `n:${numero}`;
  const multiplicador = acierto ? PAGOS.dice[opcion === rango ? rango : 'exacto'] : PAGOS.dice.fallo;
  return { acierto, multiplicador };
}

module.exports = { JUEGO, OPCIONES, validarOpcion, lanzar, evaluar };
