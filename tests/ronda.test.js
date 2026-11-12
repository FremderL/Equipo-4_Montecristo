'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FASES, puedeTransicionar, cambiarFase, fasePermiteAccion, abrirNuevaRonda, esAnfitrion } = require('../lib/ronda.js');

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

test('sin identidad nadie pasa por anfitrión', () => {
  const enApuestas = () => ({ fase: FASES.APUESTAS, juego: 'coinflip', anfitrionId: 'h', apuestas: [{ id: 1 }] });
  assert.throws(() => cambiarFase(enApuestas(), FASES.JUGANDO), /anfitrión/);
  assert.throws(() => cambiarFase(enApuestas(), FASES.JUGANDO, {}), /anfitrión/);
  assert.throws(() => cambiarFase(enApuestas(), FASES.JUGANDO, { jugadorId: null }), /anfitrión/);
  assert.throws(() => cambiarFase(enApuestas(), FASES.JUGANDO, { jugadorId: '' }), /anfitrión/);

  const enEspera = { fase: FASES.ESPERA, juego: 'coinflip', anfitrionId: 'h', jugadores: ['h'] };
  assert.throws(() => cambiarFase(enEspera, FASES.APUESTAS, { accion: 'comenzar' }), /anfitrión/);
  assert.equal(enEspera.fase, FASES.ESPERA);

  const enResultados = { fase: FASES.RESULTADOS, juego: 'coinflip', anfitrionId: 'h', numero_ronda: 1, apuestas: [] };
  assert.throws(() => abrirNuevaRonda(enResultados), /anfitrión/);
  assert.equal(enResultados.numero_ronda, 1);

  assert.equal(esAnfitrion({ anfitrionId: 'h' }, 'h'), true);
  assert.equal(esAnfitrion({ anfitrion_id: 'h' }, 'h'), true);
  assert.equal(esAnfitrion({ anfitrionId: 'h' }, 'otro'), false);
  assert.equal(esAnfitrion({ anfitrionId: 'h' }, undefined), false);
  assert.equal(esAnfitrion({ anfitrionId: null }, null), false, 'una sala sin anfitrión no se lo regala a quien llega sin id');
});

test('la ronda nueva no arrastra el resultado de la anterior', () => {
  const sala = {
    fase: FASES.RESULTADOS,
    juego: 'coinflip',
    anfitrionId: 'h',
    numero_ronda: 1,
    apuestas: [{ jugadorId: 'h', monto: 100, opcion: 'cara', resultado: 'gana' }],
    resultado: { lado: 'cara' },
    semillaRng: 'sd_0123'
  };
  abrirNuevaRonda(sala, 'h');
  assert.equal(sala.resultado, null);
  assert.equal(sala.semillaRng, null);
  assert.deepEqual(sala.apuestas, []);
  assert.equal(sala.numero_ronda, 2);
});
