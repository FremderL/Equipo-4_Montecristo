'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PAGOS } = require('../lib/reglas.js');
const { liquidar } = require('../lib/fichas.js');
const { crearRng } = require('../lib/rng.js');
const coinflip = require('../lib/juegos/coinflip.js');

test('solo existen dos opciones: cara y cruz', () => {
  assert.equal(coinflip.JUEGO, 'coinflip');
  assert.deepEqual(coinflip.OPCIONES, ['cara', 'cruz']);
  assert.deepEqual(coinflip.validarOpcion('cara'), { ok: true, opcion: 'cara' });
  assert.deepEqual(coinflip.validarOpcion('cruz'), { ok: true, opcion: 'cruz' });
  assert.deepEqual(coinflip.validarOpcion('  CaRa '), { ok: true, opcion: 'cara' }, 'se normaliza igual que el resto de las apuestas');
});

test('rechaza cualquier opción que no sea cara o cruz', () => {
  const invalidas = ['', ' ', 'canto', 'caras', 'cara o cruz', 'rojo', 'bajo', 'n:1', 'heads', null, undefined, 0, 1, true, ['cara'], { opcion: 'cara' }];
  for (const opcion of invalidas) {
    assert.deepEqual(
      coinflip.validarOpcion(opcion),
      { ok: false, error: 'Elige cara o cruz para apostar.' },
      `opción ${JSON.stringify(opcion)}`
    );
  }
});

test('el servidor lanza con su RNG: la mitad baja es cara y la mitad alta es cruz', () => {
  assert.deepEqual(coinflip.lanzar(() => 0), { lado: 'cara' });
  assert.deepEqual(coinflip.lanzar(() => 0.4999), { lado: 'cara' });
  assert.deepEqual(coinflip.lanzar(() => 0.5), { lado: 'cruz' });
  assert.deepEqual(coinflip.lanzar(() => 0.9999), { lado: 'cruz' });
  assert.throws(() => coinflip.lanzar(() => 1), RangeError, 'un RNG fuera de rango no produce resultado');
  assert.throws(() => coinflip.lanzar(() => NaN), RangeError);
  assert.ok(coinflip.OPCIONES.includes(coinflip.lanzar().lado), 'sin RNG inyectado también cae en cara o cruz');
});

test('casos 1 y 2 de DOC-02: acertar paga el doble y fallar paga cero', () => {
  // #1 · coinflip · 100 a `cara` · sale `cara` → ×2 · pago 200 · ganancia +100
  const acierto = coinflip.evaluar('cara', { lado: 'cara' });
  assert.deepEqual(acierto, { acierto: true, multiplicador: 2 });
  assert.deepEqual(liquidar(100, acierto.multiplicador), { pago: 200, neto: 100 });

  // #2 · coinflip · 100 a `cara` · sale `cruz` → ×0 · pago 0 · ganancia −100
  const fallo = coinflip.evaluar('cara', { lado: 'cruz' });
  assert.deepEqual(fallo, { acierto: false, multiplicador: 0 });
  assert.deepEqual(liquidar(100, fallo.multiplicador), { pago: 0, neto: -100 });
});

test('cruz paga igual que cara y los multiplicadores salen de PAGOS', () => {
  assert.equal(coinflip.evaluar('cruz', { lado: 'cruz' }).multiplicador, PAGOS.coinflip.acierto);
  assert.equal(coinflip.evaluar('cruz', { lado: 'cara' }).multiplicador, PAGOS.coinflip.fallo);
  assert.equal(coinflip.evaluar(' CRUZ ', { lado: 'cruz' }).acierto, true);
});

test('no evalúa apuestas ni resultados que no existen', () => {
  assert.throws(() => coinflip.evaluar('canto', { lado: 'cara' }), TypeError);
  assert.throws(() => coinflip.evaluar('', { lado: 'cara' }), TypeError);
  assert.throws(() => coinflip.evaluar('cara', { lado: 'canto' }), TypeError);
  assert.throws(() => coinflip.evaluar('cara', {}), TypeError);
  assert.throws(() => coinflip.evaluar('cara', null), TypeError);
  assert.throws(() => coinflip.evaluar('cara', 'cara'), TypeError, 'el resultado es un objeto { lado }');
});

test('con una semilla nueva por ronda la moneda sigue siendo justa (10 000 rondas)', () => {
  // El servidor no reutiliza un generador: cada ronda estrena semilla y toma su primer valor.
  let caras = 0;
  for (let ronda = 0; ronda < 10000; ronda += 1) {
    if (coinflip.lanzar(crearRng(`ronda-${ronda}`)).lado === 'cara') caras += 1;
  }
  assert.ok(caras >= 4500 && caras <= 5500, `caras: ${caras} de 10 000`);
});
