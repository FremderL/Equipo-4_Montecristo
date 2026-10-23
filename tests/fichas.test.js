'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validarApuesta, liquidar, costoSeguro, obtenerMultiplicador } = require('../lib/fichas.js');
const { PAGOS } = require('../lib/reglas.js');

test('validación rechaza menos del mínimo, exceso de saldo, decimales y apuesta repetida', () => {
  assert.deepEqual(validarApuesta(100, 9), { ok: false, error: 'Apuesta entre 10 y tus fichas disponibles.' });
  assert.equal(validarApuesta(100, 101).ok, false);
  assert.equal(validarApuesta(100, 9.999).ok, false);
  assert.equal(validarApuesta(100, 10, true).ok, false);
  assert.deepEqual(validarApuesta(100, 10), { ok: true });
});

test('casos 1–18 de DOC-02 calculan exactamente pago y neto', () => {
  const casos = [
    [100, PAGOS.coinflip.acierto, 200, 100], [100, PAGOS.coinflip.fallo, 0, -100],
    [50, PAGOS.dice.bajo, 100, 50], [50, PAGOS.dice.fallo, 0, -50],
    [50, PAGOS.dice.exacto, 300, 250], [50, PAGOS.dice.fallo, 0, -50],
    [100, PAGOS.roulette.pleno, 3600, 3500], [100, PAGOS.roulette.simple, 200, 100],
    [100, PAGOS.roulette.fallo, 0, -100], [100, PAGOS.roulette.docena, 300, 200],
    [100, PAGOS.roulette.columna, 300, 200], [100, PAGOS.roulette.fallo, 0, -100],
    [100, PAGOS.blackjack.victoria, 200, 100], [15, PAGOS.blackjack.natural, 37, 22],
    [100, PAGOS.blackjack.empate, 100, 0], [100, PAGOS.blackjack.derrota, 0, -100],
    [50, PAGOS.blackjack.seguro, 150, 100], [50, PAGOS.blackjack.derrota, 0, -50]
  ];
  for (const [monto, multiplicador, pagoEsperado, netoEsperado] of casos) assert.deepEqual(liquidar(monto, multiplicador), { pago: pagoEsperado, neto: netoEsperado });
});

test('multiplicadores se obtienen de PAGOS y seguro redondea hacia arriba', () => {
  assert.equal(obtenerMultiplicador('blackjack', 'natural'), 2.5);
  assert.equal(costoSeguro(100), 50);
  assert.equal(costoSeguro(15), 8);
});
