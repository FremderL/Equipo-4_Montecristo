'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearMazo, crearRng } = require('../lib/rng.js');
const { contarPuntos, repartirInicial, vistaDeCasa } = require('../lib/juegos/blackjack.js');

test('los números conservan su valor y J, Q y K valen 10', () => {
  for (let n = 2; n <= 10; n += 1) assert.equal(contarPuntos([`${n}♥`]), n);
  for (const figura of ['J♠', 'Q♦', 'K♣']) assert.equal(contarPuntos([figura, '7♦']), 17);
  assert.equal(contarPuntos(['10♥', '7♦', '5♣']), 22, 'si se pasa, conserva el total real');
});

test('los ases dan el mejor total posible, incluso con varios en la mano', () => {
  assert.equal(contarPuntos(['A♦', 'K♣']), 21);
  assert.equal(contarPuntos(['A♦', '6♣']), 17);
  assert.equal(contarPuntos(['A♦', '6♣', '9♥']), 16, 'el as baja de 11 a 1');
  assert.equal(contarPuntos(['A♦', 'A♣']), 12);
  assert.equal(contarPuntos(['A♥', 'A♦', 'A♣', '8♠']), 21);
  assert.equal(contarPuntos(['A♦', 'A♣', 'K♥']), 12, 'ambos ases valen 1');
  assert.equal(contarPuntos(['A♦', 'K♥', 'Q♣', '2♠']), 23);
});

test('reparte en dos vueltas desde un solo mazo barajado, de uno a seis jugadores', () => {
  for (let n = 1; n <= 6; n += 1) {
    const orden = Array.from({ length: n }, (_, i) => `jugador-${i}`);
    const semilla = `reparto-${n}`;
    const esperado = crearMazo(1, crearRng(semilla));
    const { mazo, manos, casa } = repartirInicial(orden, crearRng(semilla));

    assert.deepEqual([...manos.keys()], orden);
    for (let vuelta = 0; vuelta < 2; vuelta += 1) {
      for (const id of orden) {
        assert.equal(manos.get(id).length, 2);
        assert.equal(manos.get(id)[vuelta], esperado.pop());
      }
      assert.equal(casa[vuelta], esperado.pop(), 'la casa recibe la última carta de cada vuelta');
    }
    assert.equal(casa.length, 2);
    assert.deepEqual(mazo, esperado);
    assert.equal(mazo.length, 52 - 2 * (n + 1));
    const baraja = new Set([...mazo, ...casa, ...[...manos.values()].flat()]);
    assert.equal(baraja.size, 52);
    for (const carta of baraja) assert.match(carta, /^(?:[2-9]|10|[AJQK])[♠♥♦♣]$/);
    assert.notDeepEqual(repartirInicial(orden, crearRng('otra semilla')).mazo, mazo);
  }
});

test('la vista pública no revela ni sustituye la carta tapada', () => {
  const casa = ['A♠', '10♥'];
  assert.deepEqual(vistaDeCasa(casa), { cartas: ['A♠', null], puntos: 11 });
  assert.deepEqual(vistaDeCasa(casa, true), { cartas: ['A♠', '10♥'], puntos: 21 });
});
