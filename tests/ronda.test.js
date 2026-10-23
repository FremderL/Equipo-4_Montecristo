'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FASES, puedeTransicionar, cambiarFase, fasePermiteAccion, abrirNuevaRonda } = require('../lib/ronda.js');

test('solo admite transiciones consecutivas de fase', () => {
  assert.equal(puedeTransicionar(FASES.ESPERA, FASES.APUESTAS), true);
  assert.equal(puedeTransicionar(FASES.APUESTAS, FASES.JUGANDO), true);
  assert.equal(puedeTransicionar(FASES.JUGANDO, FASES.RESULTADOS), true);
  assert.equal(puedeTransicionar(FASES.RESULTADOS, FASES.APUESTAS), true);
  assert.equal(puedeTransicionar(FASES.APUESTAS, FASES.RESULTADOS), false);
  assert.equal(puedeTransicionar(FASES.ESPERA, FASES.JUGANDO), false);
  assert.equal(puedeTransicionar(FASES.RESULTADOS, FASES.JUGANDO), false);
});

test('rechaza acción/transición inválida sin alterar la fase', () => {
  const sala = { fase: FASES.APUESTAS, juego: 'dice', anfitrionId: 'host', apuestas: [] };
  assert.throws(() => cambiarFase(sala, FASES.RESULTADOS), /Transición/);
  assert.throws(() => cambiarFase(sala, FASES.JUGANDO, { jugadorId: 'otro', apuestasConfirmadas: 1 }), /anfitrión/);
  assert.throws(() => cambiarFase(sala, FASES.JUGANDO, { jugadorId: 'host' }), /apuesta/);
  assert.equal(sala.fase, FASES.APUESTAS);
});

test('valida host, apuesta confirmada y servidor para progresar', () => {
  const sala = { fase: FASES.APUESTAS, juego: 'coinflip', anfitrionId: 'h', apuestas: [{ id: 1 }] };
  cambiarFase(sala, FASES.JUGANDO, { jugadorId: 'h' });
  assert.equal(sala.fase, FASES.JUGANDO);
  assert.throws(() => cambiarFase(sala, FASES.RESULTADOS), /servidor/);
  cambiarFase(sala, FASES.RESULTADOS, { servidor: true });
  assert.equal(sala.fase, FASES.RESULTADOS);
});

test('inicia con mínimos por juego y abre siguiente ronda limpiando estado', () => {
  const poker = { fase: FASES.ESPERA, juego: 'poker', jugadores: ['a'] };
  assert.throws(() => cambiarFase(poker, FASES.APUESTAS, { accion: 'automatico' }), /2 jugadores/);
  const sala = { fase: FASES.RESULTADOS, juego: 'dice', anfitrionId: 'h', numero_ronda: 4, apuestas: [1], manos: [1], temporizadores: new Set(), tareasPendientes: [1] };
  abrirNuevaRonda(sala, 'h');
  assert.equal(sala.fase, FASES.APUESTAS);
  assert.equal(sala.numero_ronda, 5);
  assert.deepEqual(sala.apuestas, []);
  assert.deepEqual(sala.manos, []);
  assert.equal(sala.tareasPendientes.length, 0);
});

test('acción permitida depende de fase', () => {
  assert.equal(fasePermiteAccion(FASES.APUESTAS, 'apostar'), true);
  assert.equal(fasePermiteAccion(FASES.JUGANDO, 'apostar'), false);
});
