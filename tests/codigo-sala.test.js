'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generarCodigoSala, normalizarCodigoSala } = require('../lib/codigo-sala.js');

test('genera cinco caracteres alfanuméricos en mayúsculas, incluso con ceros iniciales', () => {
  const salas = new Map();
  assert.match(generarCodigoSala(salas), /^[A-Z0-9]{5}$/);
  assert.equal(generarCodigoSala(salas, () => 0), '00000');
  assert.equal(generarCodigoSala(salas, (maximo) => maximo - 1), 'ZZZZZ');
});

test('descarta códigos de salas activas hasta encontrar uno libre', () => {
  const primera = { codigo: 'K7Q2M' };
  const segunda = { codigo: '00ABC' };
  const salas = new Map([[primera.codigo, primera], [segunda.codigo, segunda]]);
  const candidatos = ['K7Q2M', '00ABC', 'ABC12'].map((codigo) => parseInt(codigo, 36));

  assert.equal(generarCodigoSala(salas, () => candidatos.shift()), 'ABC12');
  assert.equal(salas.get('K7Q2M'), primera);
  assert.equal(salas.get('00ABC'), segunda);
  assert.equal(salas.size, 2);
});

test('si no encuentra un código libre, termina con un error sin repetirlo', () => {
  const salas = new Map([['00000', {}]]);
  let intentos = 0;
  const repetirCodigo = () => {
    assert.ok(++intentos <= 100, 'debe detener los reintentos');
    return 0;
  };

  assert.throws(() => generarCodigoSala(salas, repetirCodigo), { codigo: 'SIN_CODIGO' });
});

test('normaliza un código escrito a mano y rechaza otros formatos', () => {
  assert.equal(normalizarCodigoSala(' 00aBc '), '00ABC');
  for (const invalido of [null, 12345, ['ABCDE'], '', 'ABCD', 'ABCDEF', 'AB CD', 'A*BCD', 'ſABCD']) {
    assert.equal(normalizarCodigoSala(invalido), null);
  }
});
