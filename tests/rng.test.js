'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lanzarMoneda, lanzarDado, girarRuleta, crearMazo, sacarCarta, crearRng, necesitaRebarajar, rebarajarSiNecesario } = require('../lib/rng.js');

test('moneda aproximadamente justa con 10 000 intentos', () => {
  const rng = crearRng('moneda');
  let caras = 0;
  for (let i = 0; i < 10000; i += 1) if (lanzarMoneda(rng) === 'cara') caras += 1;
  assert.ok(caras >= 4500 && caras <= 5500);
});

test('dado solo genera enteros del 1 al 6', () => {
  const rng = crearRng('dado');
  for (let i = 0; i < 10000; i += 1) assert.ok(Number.isInteger(lanzarDado(rng)) && lanzarDado(crearRng(i)) >= 1 && lanzarDado(crearRng(i)) <= 6);
});

test('ruleta europea devuelve 0–36 y asigna verde al cero', () => {
  assert.deepEqual(girarRuleta(() => 0), { numero: 0, color: 'verde' });
  assert.deepEqual(girarRuleta(() => 1 / 37), { numero: 1, color: 'rojo' });
  assert.deepEqual(girarRuleta(() => 2 / 37), { numero: 2, color: 'negro' });
  const rng = crearRng('ruleta');
  for (let i = 0; i < 10000; i += 1) {
    const { numero, color } = girarRuleta(rng);
    assert.ok(numero >= 0 && numero <= 36);
    if (numero === 0) assert.equal(color, 'verde');
  }
});

test('semilla reproduce la secuencia', () => {
  const a = crearRng('misma-semilla');
  const b = crearRng('misma-semilla');
  assert.deepEqual(Array.from({ length: 20 }, () => lanzarDado(a)), Array.from({ length: 20 }, () => lanzarDado(b)));
});

test('mazos, cartas sin reposición y umbral de rebarajado', () => {
  const blackjack = crearMazo(4, crearRng('blackjack'));
  assert.equal(blackjack.length, 208);
  assert.equal(new Set(blackjack).size, 52);
  const poker = crearMazo(1, crearRng('poker'));
  assert.equal(poker.length, 52);
  const carta = sacarCarta(poker);
  assert.equal(poker.includes(carta), false);
  assert.equal(necesitaRebarajar(Array(51)), true);
  assert.equal(necesitaRebarajar(Array(52)), false);
  assert.equal(rebarajarSiNecesario(Array(51), 1, crearRng('replacement')).length, 52);
  assert.equal(sacarCarta([]), null);
});
