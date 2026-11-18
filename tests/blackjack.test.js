'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearMazo, crearRng } = require('../lib/rng.js');
const {
  ESTADOS_MANO,
  contarPuntos,
  sePaso,
  repartirInicial,
  vistaDeCasa,
  estadoDeMano,
  detalleMano,
  validarAccionJugador,
  pedirCarta,
  plantarse,
  aplicarAccionJugador,
  liquidarDerrotaInmediata
} = require('../lib/juegos/blackjack.js');

/** Arma una partida controlada; las cartas de `mazoAlTope` salen en ese mismo orden al pedir. */
function partidaFija(manosIniciales, mazoAlTope = [], casa = ['9♠', '7♥']) {
  return {
    mazo: [...mazoAlTope].reverse(),
    manos: new Map(Object.entries(manosIniciales).map(([id, cartas]) => [id, [...cartas]])),
    casa: [...casa]
  };
}

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

test('pedir carta con 21 o menos suma la carta, mantiene el turno y permite plantarse después', () => {
  const partida = partidaFija({ ana: ['6♠', '5♥'] }, ['4♦', '6♣', 'K♠']);

  const primera = pedirCarta(partida, 'ana');
  assert.deepEqual(primera, {
    accion: 'hit',
    carta: '4♦',
    cartas: ['6♠', '5♥', '4♦'],
    puntos: 15,
    estado: ESTADOS_MANO.JUGANDO,
    pasado: false,
    perdio: false,
    multiplicador: null,
    mantenerTurno: true
  });

  // Llegar exactamente a 21 no es pasarse: conserva sus 21 puntos y puede plantarse.
  const segunda = aplicarAccionJugador(partida, 'ana', ' pedir ');
  assert.equal(segunda.puntos, 21);
  assert.equal(segunda.pasado, false);
  assert.equal(segunda.perdio, false);
  assert.equal(sePaso(segunda.cartas), false);
  assert.equal(segunda.mantenerTurno, true);

  const cierre = aplicarAccionJugador(partida, 'ana', 'Plantarse');
  assert.deepEqual(cierre, {
    accion: 'stand',
    carta: null,
    cartas: ['6♠', '5♥', '4♦', '6♣'],
    puntos: 21,
    estado: ESTADOS_MANO.PLANTADO,
    pasado: false,
    perdio: false,
    multiplicador: null,
    mantenerTurno: false
  });
  assert.deepEqual(partida.mazo, ['K♠'], 'plantarse no consume cartas del mazo');
  assert.equal(estadoDeMano(partida, 'ana'), ESTADOS_MANO.PLANTADO);
});

test('si al pedir se pasa de 21 pierde de inmediato y su mano queda cerrada', () => {
  const partida = partidaFija({ ana: ['10♠', '7♥'], bruno: ['9♦', '8♣'] }, ['5♦', '2♠']);

  const jugada = pedirCarta(partida, 'ana');
  assert.deepEqual(jugada, {
    accion: 'hit',
    carta: '5♦',
    cartas: ['10♠', '7♥', '5♦'],
    puntos: 22,
    estado: ESTADOS_MANO.PASADO,
    pasado: true,
    perdio: true,
    multiplicador: 0,
    mantenerTurno: false
  });
  assert.equal(sePaso(jugada.puntos), true);
  assert.deepEqual(detalleMano(partida, 'ana'), {
    cartas: ['10♠', '7♥', '5♦'],
    puntos: 22,
    estado: ESTADOS_MANO.PASADO,
    pasado: true
  });

  // Una vez pasada, no puede volver a pedir ni plantarse, y el mazo queda intacto para el siguiente.
  assert.throws(() => pedirCarta(partida, 'ana'), (fallo) => fallo.codigo === 'MANO_CERRADA');
  assert.throws(() => plantarse(partida, 'ana'), (fallo) => fallo.codigo === 'MANO_CERRADA');
  assert.deepEqual(partida.mazo, ['2♠']);

  const apuesta = { jugadorId: 'ana', nombre: 'Ana', monto: 100, opcion: 'mano' };
  liquidarDerrotaInmediata(apuesta);
  assert.equal(apuesta.multiplicador, 0);
  assert.equal(apuesta.pago, 0);
  assert.equal(apuesta.neto, -100);
  assert.equal(apuesta.resultado, 'pierde');
  const liquidadaEn = apuesta.liquidadaEn;
  liquidarDerrotaInmediata(apuesta);
  assert.equal(apuesta.liquidadaEn, liquidadaEn, 'liquidar la derrota inmediata es idempotente');
});

test('los ases ajustan su valor de 11 a 1 al pedir antes de declarar bust', () => {
  const partida = partidaFija({ ana: ['A♠', '6♥'] }, ['9♦', 'A♣', '8♠']);

  const primera = pedirCarta(partida, 'ana');
  assert.equal(primera.puntos, 16, 'A(1) + 6 + 9 = 16: no se pasa');
  assert.equal(primera.pasado, false);
  assert.equal(primera.mantenerTurno, true);

  const segunda = pedirCarta(partida, 'ana');
  assert.equal(segunda.puntos, 17, 'A(1) + 6 + 9 + A(1) = 17: sigue en juego');
  assert.equal(segunda.pasado, false);
  assert.equal(segunda.mantenerTurno, true);

  const tercera = pedirCarta(partida, 'ana');
  assert.equal(tercera.puntos, 25, 'con dos ases a 1 suma 25: ahora sí pierde');
  assert.equal(tercera.pasado, true);
  assert.equal(tercera.perdio, true);
  assert.equal(tercera.mantenerTurno, false);
});

test('solo acepta pedir o plantarse sobre manos abiertas con cartas disponibles', () => {
  const partida = partidaFija({ ana: ['10♠', '8♥'] }, ['2♣']);

  for (const invalida of ['double', 'doblar', 'split', 'dividir', 'raise', '', null, 42]) {
    const revision = validarAccionJugador(partida, 'ana', invalida);
    assert.equal(revision.ok, false);
    assert.equal(revision.codigo, 'ACCION_INVALIDA');
  }
  assert.equal(validarAccionJugador(partida, 'fantasma', 'hit').codigo, 'SIN_MANO');

  pedirCarta(partida, 'ana'); // consume la única carta de prueba (10 + 8 + 2 = 20)
  assert.equal(validarAccionJugador(partida, 'ana', 'hit').codigo, 'SIN_CARTAS');
  assert.equal(validarAccionJugador(partida, 'ana', 'stand').ok, true, 'sin cartas aún puede plantarse');

  plantarse(partida, 'ana');
  assert.equal(validarAccionJugador(partida, 'ana', 'stand').codigo, 'MANO_CERRADA');
});
