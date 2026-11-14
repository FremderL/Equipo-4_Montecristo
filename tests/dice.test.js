'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REGLAS } = require('../lib/reglas.js');
const { FASES, cambiarFase, abrirNuevaRonda, fasePermiteAccion } = require('../lib/ronda.js');
const { validarApuesta, liquidar } = require('../lib/fichas.js');
const { crearRng } = require('../lib/rng.js');
const { PAGOS } = require('../lib/reglas.js');
const dice = require('../lib/juegos/dice.js');
const { lanzarRonda, vistaDeApuesta, nuevaSemilla } = require('../lib/lanzamiento.js');

// Generadores fijos: el dado cae en la cara que toca según el valor del RNG.
const valor = (numero) => () => (numero - 0.5) / 6;

/** Sala en memoria como la arma server.js; el primer nombre es el anfitrión. */
function mesa(nombres = ['ana', 'bruno'], { comenzar = true } = {}) {
  const sala = {
    codigo: 'K7Q2M',
    juego: 'dice',
    fase: FASES.ESPERA,
    anfitrionId: nombres[0],
    numero_ronda: 1,
    apuestas: [],
    apuestasConfirmadas: 0,
    resultado: null,
    semillaRng: null,
    bote: 0,
    temporizadores: new Set(),
    tareasPendientes: [],
    jugadores: new Map(nombres.map((id) => [
      id,
      { id, nombre: id[0].toUpperCase() + id.slice(1), fichas: REGLAS.SALDO_INICIAL }
    ]))
  };
  if (comenzar) cambiarFase(sala, FASES.APUESTAS, { accion: 'comenzar', jugadorId: sala.anfitrionId });
  return sala;
}

/** Lo mismo que el evento `apostar`: valida, descuenta del saldo y deja la apuesta en la mesa. */
function apostar(sala, jugadorId, monto, opcion) {
  const jugador = sala.jugadores.get(jugadorId);
  const yaAposto = sala.apuestas.some((apuesta) => apuesta.jugadorId === jugadorId);
  assert.equal(fasePermiteAccion(sala.fase, 'apostar'), true, 'las apuestas están abiertas');
  assert.deepEqual(validarApuesta(jugador.fichas, monto, yaAposto), { ok: true });
  assert.equal(dice.validarOpcion(opcion).ok, true);

  jugador.fichas -= monto;
  sala.apuestas.push({ jugadorId, nombre: jugador.nombre, monto, opcion, confirmadaEn: Date.now() });
  sala.apuestasConfirmadas = sala.apuestas.length;
  sala.bote += monto;
}

const saldos = (sala) => Object.fromEntries(Array.from(sala.jugadores.values(), (jugador) => [jugador.id, jugador.fichas]));
const conCodigo = (codigo) => (fallo) => fallo.codigo === codigo;

test('existen ocho opciones: bajo, alto y los números exactos del 1 al 6', () => {
  assert.equal(dice.JUEGO, 'dice');
  assert.deepEqual(dice.OPCIONES, ['bajo', 'alto', 'n:1', 'n:2', 'n:3', 'n:4', 'n:5', 'n:6']);
  assert.deepEqual(dice.validarOpcion('bajo'), { ok: true, opcion: 'bajo' });
  assert.deepEqual(dice.validarOpcion('alto'), { ok: true, opcion: 'alto' });
  assert.deepEqual(dice.validarOpcion('  N:5 '), { ok: true, opcion: 'n:5' }, 'se normaliza igual que el resto de las apuestas');
  for (const numero of [1, 2, 3, 4, 5, 6]) {
    assert.deepEqual(dice.validarOpcion(`n:${numero}`), { ok: true, opcion: `n:${numero}` });
  }
});

test('rechaza cualquier opción que no sea bajo, alto o n:1…n:6', () => {
  const invalidas = ['', ' ', 'medio', 'bajito', 'altos', 'n:0', 'n:7', 'n:10', 'n:', 'n1', '1', '6', 'cara', 'rojo', 'x:3', null, undefined, 0, 5, true, ['bajo'], { opcion: 'bajo' }];
  for (const opcion of invalidas) {
    const revision = dice.validarOpcion(opcion);
    assert.equal(revision.ok, false, `opción ${JSON.stringify(opcion)}`);
    assert.equal(typeof revision.error, 'string');
  }
});

test('el servidor lanza con su RNG: cada cara del 1 al 6 es posible', () => {
  assert.deepEqual(dice.lanzar(() => 0), { valor: 1 });
  assert.deepEqual(dice.lanzar(() => 0.4999), { valor: 3 });
  assert.deepEqual(dice.lanzar(() => 0.5), { valor: 4 });
  assert.deepEqual(dice.lanzar(() => 0.9999), { valor: 6 });
  for (const numero of [1, 2, 3, 4, 5, 6]) assert.deepEqual(dice.lanzar(valor(numero)), { valor: numero });
  assert.throws(() => dice.lanzar(() => 1), RangeError, 'un RNG fuera de rango no produce resultado');
  assert.throws(() => dice.lanzar(() => NaN), RangeError);
  assert.ok(dice.OPCIONES.includes(`n:${dice.lanzar().valor}`), 'sin RNG inyectado también cae en una cara válida');
});

test('casos 3–6 de DOC-02: bajo y número exacto calculan pago y neto', () => {
  // #3 · dice · 50 a `bajo` · sale 3 → ×2 · pago 100 · ganancia +50
  const bajoAcierto = dice.evaluar('bajo', { valor: 3 });
  assert.deepEqual(bajoAcierto, { acierto: true, multiplicador: 2 });
  assert.deepEqual(liquidar(50, bajoAcierto.multiplicador), { pago: 100, neto: 50 });

  // #4 · dice · 50 a `bajo` · sale 4 → ×0 · pago 0 · ganancia −50
  const bajoFallo = dice.evaluar('bajo', { valor: 4 });
  assert.deepEqual(bajoFallo, { acierto: false, multiplicador: 0 });
  assert.deepEqual(liquidar(50, bajoFallo.multiplicador), { pago: 0, neto: -50 });

  // #5 · dice · 50 a `n:5` · sale 5 → ×6 · pago 300 · ganancia +250
  const exactoAcierto = dice.evaluar('n:5', { valor: 5 });
  assert.deepEqual(exactoAcierto, { acierto: true, multiplicador: 6 });
  assert.deepEqual(liquidar(50, exactoAcierto.multiplicador), { pago: 300, neto: 250 });

  // #6 · dice · 50 a `n:5` · sale 2 → ×0 · pago 0 · ganancia −50
  const exactoFallo = dice.evaluar('n:5', { valor: 2 });
  assert.deepEqual(exactoFallo, { acierto: false, multiplicador: 0 });
  assert.deepEqual(liquidar(50, exactoFallo.multiplicador), { pago: 0, neto: -50 });
});

test('bajo gana con 1–3 y pierde con 4–6; alto al revés', () => {
  for (const numero of [1, 2, 3, 4, 5, 6]) {
    assert.equal(dice.evaluar('bajo', { valor: numero }).multiplicador, numero <= 3 ? PAGOS.dice.bajo : PAGOS.dice.fallo, `bajo con ${numero}`);
    assert.equal(dice.evaluar('alto', { valor: numero }).multiplicador, numero >= 4 ? PAGOS.dice.alto : PAGOS.dice.fallo, `alto con ${numero}`);
  }
  // El 1 no es comodín: para un número exacto, solo la misma cara paga (DOC-02 §4).
  for (const numero of [1, 2, 3, 4, 5, 6]) {
    for (const numeroApuesta of [1, 2, 3, 4, 5, 6]) {
      const { multiplicador } = dice.evaluar(`n:${numeroApuesta}`, { valor: numero });
      assert.equal(multiplicador, numero === numeroApuesta ? PAGOS.dice.exacto : PAGOS.dice.fallo, `n:${numeroApuesta} con sale ${numero}`);
    }
  }
});

test('alto paga doble con 4–6 (espejo de bajo)', () => {
  assert.deepEqual(dice.evaluar('alto', { valor: 4 }), { acierto: true, multiplicador: 2 });
  assert.deepEqual(dice.evaluar('alto', { valor: 6 }), { acierto: true, multiplicador: 2 });
  assert.deepEqual(dice.evaluar('alto', { valor: 3 }), { acierto: false, multiplicador: 0 });
});

test('no evalúa apuestas ni resultados que no existen', () => {
  assert.throws(() => dice.evaluar('canto', { valor: 1 }), TypeError);
  assert.throws(() => dice.evaluar('n:0', { valor: 1 }), TypeError);
  assert.throws(() => dice.evaluar('n:7', { valor: 1 }), TypeError);
  assert.throws(() => dice.evaluar('bajo', { valor: 0 }), TypeError);
  assert.throws(() => dice.evaluar('bajo', { valor: 7 }), TypeError);
  assert.throws(() => dice.evaluar('bajo', { valor: 2.5 }), TypeError);
  assert.throws(() => dice.evaluar('bajo', { valor: '3' }), TypeError);
  assert.throws(() => dice.evaluar('bajo', {}), TypeError);
  assert.throws(() => dice.evaluar('bajo', null), TypeError);
  assert.throws(() => dice.evaluar('bajo', 'bajo'), TypeError, 'el resultado es un objeto { valor }');
});

test('caso 5 de DOC-02 en la mesa completa: 50 a n:5 y sale 5 → cobra 300', () => {
  const sala = mesa(['ana', 'bruno', 'carla']);
  apostar(sala, 'ana', 50, 'bajo');   // pierde: salió 5
  apostar(sala, 'bruno', 50, 'n:5');  // gana ×6
  apostar(sala, 'carla', 50, 'alto'); // gana ×2

  const ronda = lanzarRonda(sala, dice, { jugadorId: 'ana', rng: valor(5) });

  assert.deepEqual(ronda.resultado, { valor: 5 });
  assert.deepEqual(ronda.apuestas.map((apuesta) => [apuesta.jugadorId, apuesta.resultado, apuesta.pago, apuesta.neto]), [
    ['ana', 'pierde', 0, -50],
    ['bruno', 'gana', 300, 250],
    ['carla', 'gana', 100, 50]
  ]);
  assert.deepEqual(saldos(sala), { ana: 950, bruno: 1250, carla: 1050 });
  assert.equal(sala.fase, FASES.RESULTADOS);
});

test('un solo dado para toda la sala: todos se liquidan con la misma cara', () => {
  const sala = mesa(['ana', 'bruno', 'carla', 'dario']);
  apostar(sala, 'ana', 100, 'bajo');
  apostar(sala, 'bruno', 100, 'alto');
  apostar(sala, 'carla', 100, 'n:2');
  // dario mira la ronda sin apostar

  const ronda = lanzarRonda(sala, dice, { jugadorId: 'ana', rng: valor(2) });

  assert.deepEqual(ronda.resultado, { valor: 2 });
  assert.deepEqual(ronda.apuestas.map((apuesta) => [apuesta.jugadorId, apuesta.pago]), [
    ['ana', 200],
    ['bruno', 0],
    ['carla', 600]
  ]);
  assert.deepEqual(saldos(sala), { ana: 1100, bruno: 900, carla: 1500, dario: 1000 });
  assert.deepEqual(sala.apuestas.map(vistaDeApuesta), ronda.apuestas, 'estado_sala y el evento resultado cuentan lo mismo');
});

test('el lanzamiento es reproducible con la semilla de la ronda y no se puede repetir', () => {
  const sala = mesa();
  apostar(sala, 'ana', 50, 'n:3');

  const ronda = lanzarRonda(sala, dice, { jugadorId: 'ana', semilla: 'semilla-dados' });

  assert.deepEqual(ronda.resultado, dice.lanzar(crearRng('semilla-dados')), 'misma semilla, mismo resultado');
  assert.equal(sala.semillaRng, 'semilla-dados');
  assert.equal(JSON.stringify(ronda).includes('semilla-dados'), false, 'la semilla no viaja en lo que se difunde');
  assert.throws(() => lanzarRonda(sala, dice, { jugadorId: 'ana' }), conCodigo('RONDA_LIQUIDADA'));
});

test('sin semilla explícita cada ronda estrena una semilla impredecible que no se difunde', () => {
  assert.match(nuevaSemilla(), /^sd_[0-9a-f]{32}$/);
  const sala = mesa();
  apostar(sala, 'ana', 50, 'n:3');

  const ronda = lanzarRonda(sala, dice, { jugadorId: 'ana' });

  assert.match(sala.semillaRng, /^sd_[0-9a-f]{32}$/);
  assert.deepEqual(ronda.resultado, dice.lanzar(crearRng(sala.semillaRng)), 'la semilla guardada reproduce el resultado');
  assert.equal(JSON.stringify(ronda).includes(sala.semillaRng), false, 'la semilla no viaja en lo que se difunde');
});

test('abrir la siguiente ronda deja Dados listo para otra tirada', () => {
  const sala = mesa();
  apostar(sala, 'ana', 50, 'bajo');
  lanzarRonda(sala, dice, { jugadorId: 'ana', rng: valor(1) });

  abrirNuevaRonda(sala, 'ana');

  assert.equal(sala.fase, FASES.APUESTAS);
  assert.equal(sala.numero_ronda, 2);
  assert.deepEqual(sala.apuestas, []);
  assert.equal(sala.resultado, null, 'la ronda nueva no arrastra el resultado anterior');
  apostar(sala, 'ana', 10, 'n:6');
  const ronda2 = lanzarRonda(sala, dice, { jugadorId: 'ana', rng: valor(6) });
  assert.deepEqual(ronda2.resultado, { valor: 6 });
  assert.equal(ronda2.apuestas[0].pago, 60);
});

test('con una semilla nueva por ronda el dado es justo (12 000 tiradas)', () => {
  const caras = [0, 0, 0, 0, 0, 0];
  for (let ronda = 0; ronda < 12000; ronda += 1) {
    caras[dice.lanzar(crearRng(`tirada-${ronda}`)).valor - 1] += 1;
  }
  for (const [indice, conteo] of caras.entries()) {
    assert.ok(conteo >= 1600 && conteo <= 2400, `cara ${indice + 1}: ${conteo} de 12 000`);
  }
});
