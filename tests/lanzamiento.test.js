'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REGLAS } = require('../lib/reglas.js');
const { FASES, cambiarFase, abrirNuevaRonda, fasePermiteAccion } = require('../lib/ronda.js');
const { validarApuesta } = require('../lib/fichas.js');
const { crearRng } = require('../lib/rng.js');
const coinflip = require('../lib/juegos/coinflip.js');
const { lanzarRonda, liquidarApuesta, vistaDeApuesta, nuevaSemilla } = require('../lib/lanzamiento.js');

// Generadores fijos: la moneda cae en cara con la mitad baja y en cruz con la alta.
const CARA = () => 0;
const CRUZ = () => 0.99;

/** Sala en memoria como la arma server.js; el primer nombre es el anfitrión. */
function mesa(nombres = ['ana', 'bruno'], { comenzar = true } = {}) {
  const sala = {
    codigo: 'K7Q2M',
    juego: 'coinflip',
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
  assert.equal(coinflip.validarOpcion(opcion).ok, true);

  jugador.fichas -= monto;
  sala.apuestas.push({ jugadorId, nombre: jugador.nombre, monto, opcion, confirmadaEn: Date.now() });
  sala.apuestasConfirmadas = sala.apuestas.length;
  sala.bote += monto;
}

const saldos = (sala) => Object.fromEntries(Array.from(sala.jugadores.values(), (jugador) => [jugador.id, jugador.fichas]));
const conCodigo = (codigo) => (fallo) => fallo.codigo === codigo;

test('caso 1 de DOC-02: 100 a cara y sale cara → cobra 200 (gana 100)', () => {
  const sala = mesa();
  apostar(sala, 'ana', 100, 'cara');
  assert.equal(sala.jugadores.get('ana').fichas, 900, 'la apuesta sale del saldo al confirmar');

  const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA });

  assert.deepEqual(ronda, {
    juego: 'coinflip',
    numeroRonda: 1,
    resultado: { lado: 'cara' },
    apuestas: [
      { jugadorId: 'ana', nombre: 'Ana', monto: 100, opcion: 'cara', multiplicador: 2, pago: 200, neto: 100, resultado: 'gana' }
    ]
  });
  assert.equal(sala.jugadores.get('ana').fichas, 1100, 'el pago se acredita al liquidar');
  assert.equal(sala.fase, FASES.RESULTADOS);
  assert.deepEqual(sala.resultado, { lado: 'cara' });
});

test('caso 2 de DOC-02: 100 a cara y sale cruz → pierde lo apostado', () => {
  const sala = mesa();
  apostar(sala, 'ana', 100, 'cara');

  const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CRUZ });

  assert.deepEqual(ronda.resultado, { lado: 'cruz' });
  assert.deepEqual(ronda.apuestas, [
    { jugadorId: 'ana', nombre: 'Ana', monto: 100, opcion: 'cara', multiplicador: 0, pago: 0, neto: -100, resultado: 'pierde' }
  ]);
  assert.equal(sala.jugadores.get('ana').fichas, 900);
  assert.equal(sala.fase, FASES.RESULTADOS);
});

test('una sola moneda para toda la sala: todos se liquidan con el mismo resultado', () => {
  const sala = mesa(['ana', 'bruno', 'carla', 'dario']);
  apostar(sala, 'ana', 100, 'cara');
  apostar(sala, 'bruno', 250, 'cruz');
  apostar(sala, 'carla', 10, 'cruz');
  // dario mira la ronda sin apostar

  const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CRUZ });

  assert.deepEqual(ronda.resultado, { lado: 'cruz' });
  assert.deepEqual(
    ronda.apuestas.map((apuesta) => [apuesta.jugadorId, apuesta.resultado, apuesta.pago, apuesta.neto]),
    [['ana', 'pierde', 0, -100], ['bruno', 'gana', 500, 250], ['carla', 'gana', 20, 10]]
  );
  assert.deepEqual(saldos(sala), { ana: 900, bruno: 1250, carla: 1010, dario: 1000 }, 'quien no apuesta no gana ni pierde');
  assert.deepEqual(sala.apuestas.map(vistaDeApuesta), ronda.apuestas, 'estado_sala y el evento resultado cuentan lo mismo');
});

test('no hace falta que haya apuestas en los dos lados, ni que el anfitrión apueste', () => {
  const sala = mesa(['ana', 'bruno', 'carla']);
  apostar(sala, 'bruno', 100, 'cara');
  apostar(sala, 'carla', 300, 'cara');

  const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA });

  assert.deepEqual(ronda.apuestas.map((apuesta) => apuesta.resultado), ['gana', 'gana']);
  assert.deepEqual(saldos(sala), { ana: 1000, bruno: 1100, carla: 1300 });
});

test('solo el anfitrión puede lanzar', () => {
  const sala = mesa();
  apostar(sala, 'bruno', 100, 'cara');
  const antes = saldos(sala);

  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'bruno', rng: CARA }), conCodigo('SOLO_ANFITRION'));
  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'intruso', rng: CARA }), /Solo el anfitrión puede lanzar/);
  assert.throws(() => lanzarRonda(sala, coinflip, { rng: CARA }), conCodigo('SOLO_ANFITRION'), 'sin identidad tampoco');
  assert.throws(() => lanzarRonda(sala, coinflip), conCodigo('SOLO_ANFITRION'));

  assert.equal(sala.fase, FASES.APUESTAS, 'un rechazo no mueve la fase');
  assert.deepEqual(saldos(sala), antes, 'ni los saldos');
  assert.equal(sala.resultado, null);
});

test('sin apuestas confirmadas no hay nada que lanzar', () => {
  const sala = mesa();

  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA }), conCodigo('SIN_APOSTADORES'));
  assert.equal(sala.fase, FASES.APUESTAS);

  apostar(sala, 'bruno', 10, 'cruz');
  assert.equal(lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CRUZ }).apuestas.length, 1, 'con una apuesta ya se puede');
});

test('solo se lanza con las apuestas abiertas', () => {
  const enEspera = mesa(['ana', 'bruno'], { comenzar: false });
  assert.throws(() => lanzarRonda(enEspera, coinflip, { jugadorId: 'ana', rng: CARA }), conCodigo('FASE_INVALIDA'));
  assert.equal(enEspera.fase, FASES.ESPERA);

  const jugando = mesa();
  apostar(jugando, 'ana', 100, 'cara');
  cambiarFase(jugando, FASES.JUGANDO, { jugadorId: 'ana' });
  assert.throws(() => lanzarRonda(jugando, coinflip, { jugadorId: 'ana', rng: CARA }), conCodigo('FASE_INVALIDA'));
  assert.equal(jugando.jugadores.get('ana').fichas, 900, 'no se pagó nada');
});

test('dos lanzar seguidos liquidan una sola vez (idempotencia)', () => {
  const sala = mesa();
  apostar(sala, 'ana', 100, 'cara');
  apostar(sala, 'bruno', 100, 'cruz');

  const primera = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA });
  assert.deepEqual(saldos(sala), { ana: 1100, bruno: 900 });

  // El segundo lanzamiento saldría cruz: si se aplicara, bruno cobraría y el resultado cambiaría.
  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CRUZ }), conCodigo('RONDA_LIQUIDADA'));
  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA }), /ya se lanzó y se liquidó/);

  assert.deepEqual(saldos(sala), { ana: 1100, bruno: 900 }, 'nadie cobra dos veces');
  assert.deepEqual(sala.resultado, primera.resultado, 'el resultado de la ronda no cambia');
  assert.deepEqual(sala.apuestas.map(vistaDeApuesta), primera.apuestas);
  assert.equal(sala.fase, FASES.RESULTADOS);
});

test('la ronda es todo o nada: si el lanzamiento falla, la sala queda intacta', () => {
  const sala = mesa();
  apostar(sala, 'ana', 100, 'cara');
  apostar(sala, 'bruno', 100, 'cruz');
  const antes = saldos(sala);

  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: () => 7 }), RangeError, 'RNG roto');
  sala.apuestas[1].opcion = 'canto'; // apuesta corrupta: el evento `apostar` jamás la dejaría pasar
  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA }), TypeError);

  assert.equal(sala.fase, FASES.APUESTAS, 'la fase no se quedó atorada en jugando');
  assert.deepEqual(saldos(sala), antes, 'no hubo pagos parciales: ana no cobró su acierto');
  assert.equal(sala.resultado, null);
  assert.ok(sala.apuestas.every((apuesta) => apuesta.resultado === undefined), 'ninguna apuesta quedó liquidada');

  sala.apuestas[1].opcion = 'cruz';
  const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA });
  assert.deepEqual(ronda.resultado, { lado: 'cara' }, 'la mesa no quedó bloqueada');
  assert.deepEqual(saldos(sala), { ana: 1100, bruno: 900 });
});

test('la semilla de la ronda queda del lado del servidor y permite repetirla', () => {
  const sala = mesa();
  apostar(sala, 'ana', 100, 'cara');

  const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana' }); // semilla real, como en producción

  assert.match(sala.semillaRng, /^sd_[0-9a-f]{32}$/);
  assert.deepEqual(coinflip.lanzar(crearRng(sala.semillaRng)), ronda.resultado, 'la semilla reproduce el resultado');
  assert.equal(JSON.stringify(ronda).includes(sala.semillaRng), false, 'la semilla no viaja en lo que se difunde');
  assert.deepEqual(Object.keys(ronda), ['juego', 'numeroRonda', 'resultado', 'apuestas']);

  for (const semilla of ['semilla-a', 'semilla-b', 'semilla-c', 'semilla-d']) {
    const otra = mesa();
    apostar(otra, 'ana', 10, 'cara');
    const repetida = lanzarRonda(otra, coinflip, { jugadorId: 'ana', semilla });
    assert.equal(otra.semillaRng, semilla);
    assert.deepEqual(repetida.resultado, coinflip.lanzar(crearRng(semilla)), 'misma semilla, mismo resultado');
  }

  assert.notEqual(nuevaSemilla(), nuevaSemilla(), 'cada ronda estrena semilla');
});

test('nadie puede dictar el resultado: solo cuenta el RNG del servidor', () => {
  let semillaDeCruz = null;
  for (let i = 0; semillaDeCruz === null; i += 1) {
    if (coinflip.lanzar(crearRng(`ronda-${i}`)).lado === 'cruz') semillaDeCruz = `ronda-${i}`;
  }
  const sala = mesa();
  apostar(sala, 'ana', 100, 'cara');

  // Aunque alguien colara un resultado entre las opciones, la función no lo lee.
  const ronda = lanzarRonda(sala, coinflip, {
    jugadorId: 'ana',
    semilla: semillaDeCruz,
    resultado: { lado: 'cara' },
    lado: 'cara'
  });

  assert.deepEqual(ronda.resultado, { lado: 'cruz' });
  assert.equal(sala.jugadores.get('ana').fichas, 900);
});

test('la apuesta de quien ya salió no se liquida ni cuenta para lanzar', () => {
  const sala = mesa(['ana', 'bruno', 'carla']);
  apostar(sala, 'bruno', 100, 'cara');
  sala.jugadores.delete('bruno'); // se fue y su apuesta quedó huérfana en la mesa

  assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA }), conCodigo('SIN_APOSTADORES'));

  apostar(sala, 'carla', 50, 'cara');
  const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA });

  assert.deepEqual(ronda.apuestas.map((apuesta) => apuesta.jugadorId), ['carla']);
  assert.deepEqual(sala.apuestas.map((apuesta) => apuesta.jugadorId), ['carla'], 'la apuesta huérfana desaparece de la mesa');
  assert.equal(sala.apuestasConfirmadas, 1);
  assert.deepEqual(saldos(sala), { ana: 1000, carla: 1050 });
});

test('el motor tiene que ser el del juego de la sala', () => {
  const deDados = mesa();
  deDados.juego = 'dice';
  apostar(deDados, 'ana', 100, 'cara');
  assert.throws(() => lanzarRonda(deDados, coinflip, { jugadorId: 'ana', rng: CARA }), conCodigo('JUEGO_INVALIDO'));
  assert.equal(deDados.fase, FASES.APUESTAS);

  const sala = mesa();
  assert.throws(() => lanzarRonda(sala, null, { jugadorId: 'ana' }), TypeError);
  assert.throws(() => lanzarRonda(sala, { JUEGO: 'coinflip' }, { jugadorId: 'ana' }), TypeError);
  assert.throws(() => lanzarRonda(null, coinflip, { jugadorId: 'ana' }), TypeError);
  assert.throws(() => lanzarRonda({ juego: 'coinflip', fase: FASES.APUESTAS, jugadores: [], apuestas: [] }, coinflip, { jugadorId: 'ana' }), TypeError);
});

test('ronda completa sobre el motor: espera → apuestas → jugando → resultados → nueva ronda', () => {
  const sala = mesa(['ana', 'bruno'], { comenzar: false });
  assert.equal(sala.fase, FASES.ESPERA);

  cambiarFase(sala, FASES.APUESTAS, { accion: 'comenzar', jugadorId: 'ana' });
  apostar(sala, 'ana', 100, 'cara');
  apostar(sala, 'bruno', 200, 'cruz');

  // Espía de fases: el lanzamiento tiene que recorrer las dos transiciones del motor.
  const recorrido = [];
  let fase = sala.fase;
  Object.defineProperty(sala, 'fase', {
    enumerable: true,
    get: () => fase,
    set: (nueva) => { recorrido.push(nueva); fase = nueva; }
  });

  const primera = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CARA });
  assert.deepEqual(recorrido, [FASES.JUGANDO, FASES.RESULTADOS]);
  assert.equal(primera.numeroRonda, 1);
  assert.deepEqual(saldos(sala), { ana: 1100, bruno: 800 });

  // En resultados ya no se apuesta ni se lanza, y solo el anfitrión abre la siguiente.
  assert.equal(fasePermiteAccion(sala.fase, 'apostar'), false);
  assert.equal(fasePermiteAccion(sala.fase, 'lanzar'), false);
  assert.throws(() => abrirNuevaRonda(sala, 'bruno'), /anfitrión/);

  abrirNuevaRonda(sala, 'ana');
  assert.equal(sala.fase, FASES.APUESTAS);
  assert.equal(sala.numero_ronda, 2);
  assert.deepEqual(sala.apuestas, []);
  assert.equal(sala.apuestasConfirmadas, 0);
  assert.equal(sala.resultado, null, 'la ronda nueva no arrastra el resultado anterior');
  assert.equal(sala.semillaRng, null);

  // Segunda ronda: los saldos se conservan y se puede apostar todo lo que se tiene.
  apostar(sala, 'bruno', 800, 'cruz');
  const segunda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', rng: CRUZ });
  assert.equal(segunda.numeroRonda, 2);
  assert.deepEqual(segunda.apuestas.map((apuesta) => [apuesta.jugadorId, apuesta.pago]), [['bruno', 1600]]);
  assert.deepEqual(saldos(sala), { ana: 1100, bruno: 1600 });
});

test('300 rondas seguidas: las fichas siempre cuadran y nadie queda en negativo', () => {
  const azar = crearRng('trescientas-rondas'); // decide quién apuesta, cuánto y a qué lado
  const sala = mesa(['ana', 'bruno', 'carla', 'dario', 'elena', 'fer']);
  let lanzadas = 0;
  let caras = 0;

  for (let vuelta = 1; vuelta <= 300; vuelta += 1) {
    const antes = saldos(sala);
    for (const jugador of sala.jugadores.values()) {
      if (jugador.fichas < REGLAS.APUESTA_MINIMA || azar() < 0.2) continue;
      const tope = Math.min(jugador.fichas, 200);
      const monto = REGLAS.APUESTA_MINIMA + Math.floor(azar() * (tope - REGLAS.APUESTA_MINIMA + 1));
      apostar(sala, jugador.id, monto, azar() < 0.5 ? 'cara' : 'cruz');
    }
    if (sala.apuestas.length === 0) {
      assert.throws(() => lanzarRonda(sala, coinflip, { jugadorId: 'ana', semilla: `vuelta-${vuelta}` }), conCodigo('SIN_APOSTADORES'));
      continue;
    }

    const ronda = lanzarRonda(sala, coinflip, { jugadorId: 'ana', semilla: `vuelta-${vuelta}` });
    lanzadas += 1;
    if (ronda.resultado.lado === 'cara') caras += 1;
    assert.equal(ronda.numeroRonda, lanzadas);

    for (const jugador of sala.jugadores.values()) {
      const apuesta = ronda.apuestas.find((candidata) => candidata.jugadorId === jugador.id);
      const pago = apuesta && apuesta.opcion === ronda.resultado.lado ? apuesta.monto * 2 : 0;
      const esperado = antes[jugador.id] - (apuesta ? apuesta.monto : 0) + pago;
      assert.equal(jugador.fichas, esperado, `vuelta ${vuelta}: saldo de ${jugador.id}`);
      assert.ok(Number.isInteger(jugador.fichas) && jugador.fichas >= 0);
      if (apuesta) assert.equal(apuesta.pago, pago);
    }

    abrirNuevaRonda(sala, 'ana');
  }

  assert.ok(lanzadas >= 290, `se lanzaron ${lanzadas} rondas`);
  assert.ok(caras > lanzadas * 0.4 && caras < lanzadas * 0.6, `caras: ${caras} de ${lanzadas}`);
});

test('liquidarApuesta aplica el multiplicador del juego y clasifica gana · pierde · empate', () => {
  assert.deepEqual(
    liquidarApuesta(coinflip, { monto: 100, opcion: 'cara' }, { lado: 'cara' }),
    { multiplicador: 2, pago: 200, neto: 100, resultado: 'gana' }
  );
  assert.deepEqual(
    liquidarApuesta(coinflip, { monto: 100, opcion: 'cara' }, { lado: 'cruz' }),
    { multiplicador: 0, pago: 0, neto: -100, resultado: 'pierde' }
  );
  // Un juego que devuelva lo apostado (×1) lo registra como empate, igual que DOC-03.
  assert.equal(liquidarApuesta({ evaluar: () => ({ multiplicador: 1 }) }, { monto: 100, opcion: 'x' }, {}).resultado, 'empate');
  assert.throws(() => liquidarApuesta(coinflip, { monto: 9.5, opcion: 'cara' }, { lado: 'cara' }), TypeError, 'solo fichas enteras');
});

test('una apuesta sin liquidar se ve con los campos de pago en null', () => {
  assert.deepEqual(
    vistaDeApuesta({ jugadorId: 'ana', nombre: 'Ana', monto: 100, opcion: 'cara', confirmadaEn: 1 }),
    { jugadorId: 'ana', nombre: 'Ana', monto: 100, opcion: 'cara', multiplicador: null, pago: null, neto: null, resultado: null }
  );
  assert.deepEqual(
    vistaDeApuesta({ jugadorId: 'ana', monto: 100, opcion: 'cara', multiplicador: 0, pago: 0, neto: -100, resultado: 'pierde', liquidadaEn: 2 }),
    { jugadorId: 'ana', nombre: null, monto: 100, opcion: 'cara', multiplicador: 0, pago: 0, neto: -100, resultado: 'pierde' },
    'un pago de 0 fichas es un dato, no un «todavía no»'
  );
});
