'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const roulette = require('../lib/juegos/roulette.js');

const SIMPLES = ['rojo', 'negro', 'par', 'impar'];
const ROJOS_EUROPEOS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const girarConNumero = (numero) => roulette.lanzar(() => (numero + 0.5) / 37);

function comprobarPago(opcion, resultado, multiplicador) {
  assert.deepEqual(
    roulette.evaluar(opcion, resultado),
    { acierto: multiplicador > 0, multiplicador },
    `${opcion} cuando sale ${resultado.numero}`
  );
}

test('valida y normaliza las cuatro opciones simples y los plenos n:0 a n:36', () => {
  assert.equal(roulette.JUEGO, 'roulette');
  const opciones = [...SIMPLES, ...Array.from({ length: 37 }, (_, numero) => `n:${numero}`)];
  for (const opcion of opciones) {
    assert.deepEqual(roulette.validarOpcion(` ${opcion.toUpperCase()} `), { ok: true, opcion });
  }
});

test('rechaza opciones fuera del ticket y plenos mal escritos o fuera de rango', () => {
  const invalidas = [
    '', ' ', 'verde', 'bajo', 'alto', 'd2', 'c3', 'cara', '17', 'n:', 'n:-1', 'n:37',
    'n:00', 'n:1.5', 'n:1e1', 'n: 17', null, undefined, 17, ['n:17'], { numero: 17 }
  ];
  for (const opcion of invalidas) {
    assert.equal(roulette.validarOpcion(opcion).ok, false, `opción ${JSON.stringify(opcion)}`);
  }
});

test('el giro del servidor devuelve cualquiera de las 37 casillas con su color europeo', () => {
  for (let numero = 0; numero <= 36; numero += 1) {
    const color = numero === 0 ? 'verde' : ROJOS_EUROPEOS.has(numero) ? 'rojo' : 'negro';
    assert.deepEqual(girarConNumero(numero), { numero, color });
  }
  assert.deepEqual(roulette.lanzar(() => 0), { numero: 0, color: 'verde' });
  assert.throws(() => roulette.lanzar(() => 1), RangeError);
});

test('rojo, negro, par e impar pagan ×2 si aciertan y ×0 si fallan', () => {
  for (let numero = 1; numero <= 36; numero += 1) {
    const resultado = girarConNumero(numero);
    const ganadoras = [ROJOS_EUROPEOS.has(numero) ? 'rojo' : 'negro', numero % 2 === 0 ? 'par' : 'impar'];
    for (const opcion of SIMPLES) comprobarPago(opcion, resultado, ganadoras.includes(opcion) ? 2 : 0);
  }
});

test('el cero hace perder todas las apuestas de color y paridad', () => {
  const resultado = girarConNumero(0);
  for (const opcion of SIMPLES) comprobarPago(opcion, resultado, 0);
});

test('cada pleno paga ×36 solo al acertar su número, incluidos 0 y 36', () => {
  for (let numero = 0; numero <= 36; numero += 1) {
    const resultado = girarConNumero(numero);
    for (let elegido = 0; elegido <= 36; elegido += 1) {
      comprobarPago(`n:${elegido}`, resultado, elegido === numero ? 36 : 0);
    }
  }
});

test('no liquida opciones ni números de resultado inválidos', () => {
  assert.throws(() => roulette.evaluar('n:37', { numero: 36, color: 'rojo' }), TypeError);
  for (const resultado of [null, {}, { numero: -1 }, { numero: 37 }, { numero: '0' }, { numero: 1.5 }]) {
    assert.throws(() => roulette.evaluar('n:0', resultado), TypeError);
  }
});
