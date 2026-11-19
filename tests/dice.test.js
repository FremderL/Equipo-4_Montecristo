'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dice = require('../lib/juegos/dice.js');

test('dados: cada lanzamiento paga solo su rango y su número exacto', () => {
  for (let numero = 1; numero <= 6; numero++) {
    const tirada = dice.lanzar(() => (numero - 0.5) / 6);
    assert.deepEqual(tirada, { numero });
    for (const opcion of dice.OPCIONES) {
      const esperado = opcion === `n:${numero}` ? 6 : opcion === (numero <= 3 ? 'bajo' : 'alto') ? 2 : 0;
      assert.equal(dice.evaluar(opcion, tirada).multiplicador, esperado);
    }
  }
  for (const valor of ['n:0', 'n:7', 'cara', null]) assert.equal(dice.validarOpcion(valor).ok, false);
});
