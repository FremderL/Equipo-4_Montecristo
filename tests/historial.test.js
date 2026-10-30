// Pruebas de la tabla `historial_rondas` y de la función que la llena al
// terminar cada ronda (lib/historial.js).
// Uso: npm test
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Base de datos de pruebas en un archivo aparte: no toca data/casino.db.
const archivoTest = path.join(os.tmpdir(), `montecristo-historial-${process.pid}.db`);
process.env.DB_FILE = archivoTest;

// La conexión se abre una sola vez (lib/db.js) y aplica el esquema.
const db = require('../lib/db.js');
const esquema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(esquema);

const {
  TABLA,
  registrarRondaTerminada,
  registrarJugadorEnRonda,
  configurarDb
} = require('../lib/historial.js');

after(() => {
  db.close();
  for (const sufijo of ['', '-wal', '-shm']) {
    fs.rmSync(archivoTest + sufijo, { force: true });
  }
});

const limpiar = () => db.exec(`DELETE FROM ${TABLA};`);
const filas = (jugadorId) => db.prepare(`SELECT * FROM ${TABLA} WHERE jugador_id = ? ORDER BY numero_ronda`).all(jugadorId);

const RONDA = {
  salaCodigo: 'K7Q2M',
  juego: 'roulette',
  numeroRonda: 1,
  jugadores: [
    { jugadorId: 'p_ana', nombre: 'Ana', apuesta: 100, opcion: 'rojo', resultado: 'gana', pago: 200 },
    { jugadorId: 'p_bruno', nombre: 'Bruno', apuesta: 50, opcion: 'n:17', resultado: 'pierde', pago: 0 }
  ]
};

const debeFallarPor = (accion, tipoDeError) => {
  assert.throws(
    accion,
    (error) => error.code && error.code.startsWith('SQLITE_CONSTRAINT') && error.message.startsWith(tipoDeError),
    `se esperaba un error "${tipoDeError}"`
  );
};

test('la tabla historial_rondas existe con las columnas del historial', () => {
  limpiar();
  const columnas = new Set(db.prepare(`PRAGMA table_info(${TABLA})`).all().map((columna) => columna.name));
  for (const nombre of [
    'id',
    'sala_codigo',
    'juego',
    'jugador_id',
    'jugador_nombre',
    'numero_ronda',
    'apuesta',
    'opcion',
    'resultado',
    'pago',
    'fecha'
  ]) {
    assert.ok(columnas.has(nombre), `falta la columna ${nombre}`);
  }
});

test('registra una fila por jugador con apuesta, resultado y fecha', () => {
  limpiar();
  const resultado = registrarRondaTerminada(RONDA);

  assert.equal(resultado.insertadas, 2);
  assert.equal(resultado.filas.length, 2);

  const ana = filas('p_ana')[0];
  assert.equal(ana.sala_codigo, 'K7Q2M');
  assert.equal(ana.juego, 'roulette');
  assert.equal(ana.numero_ronda, 1);
  assert.equal(ana.jugador_nombre, 'Ana');
  assert.equal(ana.apuesta, 100);
  assert.equal(ana.opcion, 'rojo');
  assert.equal(ana.resultado, 'gana');
  assert.equal(ana.pago, 200);
  assert.match(ana.fecha, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'la fecha la pone SQLite');

  const bruno = filas('p_bruno')[0];
  assert.equal(bruno.jugador_nombre, 'Bruno');
  assert.equal(bruno.resultado, 'pierde');
  assert.equal(bruno.pago, 0);
});

test('registrarJugadorEnRonda guarda una sola fila y devuelve su contenido', () => {
  limpiar();
  const { insertada, fila } = registrarJugadorEnRonda({
    salaCodigo: 'AB123',
    juego: 'dice',
    numeroRonda: 4,
    jugadorId: 'p_carla',
    nombre: 'Carla',
    apuesta: 20,
    opcion: 'exacto',
    resultado: 'empate',
    pago: 20
  });

  assert.equal(insertada, true);
  assert.equal(fila.salaCodigo, 'AB123');
  assert.equal(fila.jugadorNombre, 'Carla');
  assert.equal(fila.apuesta, 20);
  assert.equal(fila.resultado, 'empate');
  assert.deepEqual(filas('p_carla').map((guardada) => guardada.id), [fila.id]);
});

test('normaliza el código de sala y repetir la ronda no duplica filas', () => {
  limpiar();
  registrarRondaTerminada(RONDA);
  const repetida = registrarRondaTerminada({ ...RONDA, salaCodigo: ' k7q2m ' });

  assert.equal(repetida.insertadas, 0, 'la segunda vez no inserta nada');
  assert.equal(repetida.filas.length, 2, 'devuelve las filas ya guardadas');
  assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM ${TABLA} WHERE sala_codigo = ?`).get('K7Q2M').total, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM ${TABLA} WHERE sala_codigo = ' k7q2m '`).get().total, 0);
});

test('avisa si la ronda ya está registrada con otros datos', () => {
  limpiar();
  registrarRondaTerminada(RONDA);
  const cambiada = {
    ...RONDA,
    jugadores: [{ ...RONDA.jugadores[0], pago: 999 }]
  };
  assert.throws(() => registrarRondaTerminada(cambiada), /ya está registrada/);
  assert.equal(filas('p_ana')[0].pago, 200, 'la fila original no se modifica');
});

test('es todo o nada: si un jugador falla, no se guarda ninguno', () => {
  limpiar();
  registrarRondaTerminada(RONDA);

  const mixta = {
    ...RONDA,
    jugadores: [
      { jugadorId: 'p_dario', nombre: 'Dario', apuesta: 30, opcion: 'alto', resultado: 'gana', pago: 60 },
      { ...RONDA.jugadores[0], pago: 999 }
    ]
  };

  assert.throws(() => registrarRondaTerminada(mixta), /ya está registrada/);
  assert.equal(filas('p_dario').length, 0, 'la transacción revierte la fila nueva');
});

test('rechaza apuestas por debajo del mínimo (validación y CHECK)', () => {
  limpiar();
  const ronda = { ...RONDA, jugadores: [{ ...RONDA.jugadores[0], apuesta: 5 }] };
  assert.throws(() => registrarRondaTerminada(ronda), /apuesta/);

  debeFallarPor(
    () => db.prepare(`INSERT INTO ${TABLA} (id, sala_codigo, juego, numero_ronda, jugador_id, jugador_nombre, apuesta, opcion, resultado)
                      VALUES ('h_poca', 'K7Q2M', 'roulette', 1, 'p_ana', 'Ana', 5, 'rojo', 'gana')`).run(),
    'CHECK constraint failed'
  );
});

test('rechaza juegos, resultados y montos inválidos (validación y CHECK)', () => {
  limpiar();
  assert.throws(() => registrarRondaTerminada({ ...RONDA, juego: 'tragamonedas' }), /juego inválido/);
  assert.throws(
    () => registrarRondaTerminada({ ...RONDA, jugadores: [{ ...RONDA.jugadores[0], resultado: 'ganado' }] }),
    /resultado inválido/
  );
  assert.throws(() => registrarRondaTerminada({ ...RONDA, numeroRonda: 0 }), /numeroRonda/);
  assert.throws(
    () => registrarRondaTerminada({ ...RONDA, jugadores: [{ ...RONDA.jugadores[0], pago: -1 }] }),
    /pago/
  );

  debeFallarPor(
    () => db.prepare(`INSERT INTO ${TABLA} (id, sala_codigo, juego, numero_ronda, jugador_id, jugador_nombre, apuesta, opcion, resultado)
                      VALUES ('h_juego', 'K7Q2M', 'tragamonedas', 1, 'p_ana', 'Ana', 10, 'rojo', 'gana')`).run(),
    'CHECK constraint failed'
  );
  debeFallarPor(
    () => db.prepare(`INSERT INTO ${TABLA} (id, sala_codigo, juego, numero_ronda, jugador_id, jugador_nombre, apuesta, opcion, resultado)
                      VALUES ('h_res', 'K7Q2M', 'roulette', 1, 'p_ana', 'Ana', 10, 'rojo', 'ganado')`).run(),
    'CHECK constraint failed'
  );
  debeFallarPor(
    () => db.prepare(`INSERT INTO ${TABLA} (id, sala_codigo, juego, numero_ronda, jugador_id, jugador_nombre, apuesta, opcion, resultado)
                      VALUES ('h_ronda', 'K7Q2M', 'roulette', 0, 'p_ana', 'Ana', 10, 'rojo', 'gana')`).run(),
    'CHECK constraint failed'
  );
});

test('rechaza una ronda sin jugadores, con más de 6 o con jugadores repetidos', () => {
  limpiar();
  assert.throws(() => registrarRondaTerminada({ ...RONDA, jugadores: [] }), /al menos un jugador/);

  const siete = Array.from({ length: 7 }, (_, i) => ({ ...RONDA.jugadores[0], jugadorId: `p_${i}` }));
  assert.throws(() => registrarRondaTerminada({ ...RONDA, jugadores: siete }), /más de 6/);

  const repetidos = [RONDA.jugadores[0], { ...RONDA.jugadores[0], opcion: 'negro' }];
  assert.throws(() => registrarRondaTerminada({ ...RONDA, jugadores: repetidos }), /repetido/);

  assert.throws(
    () => registrarRondaTerminada({ ...RONDA, jugadores: [{ ...RONDA.jugadores[0], nombre: '   ' }] }),
    /nombre/
  );
  assert.throws(() => registrarRondaTerminada({ ...RONDA, salaCodigo: 'ABC' }), /salaCodigo/);
  assert.throws(() => configurarDb({}), /better-sqlite3/);
});

test('guarda la fecha indicada cuando se quiere reconstruir una ronda', () => {
  limpiar();
  const { fila } = registrarJugadorEnRonda({
    ...RONDA.jugadores[0],
    salaCodigo: RONDA.salaCodigo,
    juego: RONDA.juego,
    numeroRonda: 2,
    fecha: '2026-10-30 21:15:00'
  });
  assert.equal(fila.fecha, '2026-10-30 21:15:00');
  assert.equal(filas('p_ana')[0].fecha, '2026-10-30 21:15:00');
});

test('la tabla responde el historial y las estadísticas de un jugador', () => {
  limpiar();
  registrarRondaTerminada(RONDA);
  registrarRondaTerminada({
    ...RONDA,
    numeroRonda: 2,
    jugadores: [
      { jugadorId: 'p_ana', nombre: 'Ana', apuesta: 40, opcion: 'negro', resultado: 'pierde', pago: 0 },
      { jugadorId: 'p_bruno', nombre: 'Bruno', apuesta: 10, opcion: 'rojo', resultado: 'gana', pago: 20 }
    ]
  });

  const estadisticas = db
    .prepare(`SELECT resultado, COUNT(*) AS rondas, SUM(apuesta) AS apostado, SUM(pago) AS pagado
              FROM ${TABLA} WHERE jugador_id = ? GROUP BY resultado ORDER BY resultado`)
    .all('p_ana');

  assert.deepEqual(estadisticas, [
    { resultado: 'gana', rondas: 1, apostado: 100, pagado: 200 },
    { resultado: 'pierde', rondas: 1, apostado: 40, pagado: 0 }
  ]);

  const historial = db
    .prepare(`SELECT numero_ronda, apuesta, resultado FROM ${TABLA} WHERE jugador_id = ? ORDER BY numero_ronda DESC`)
    .all('p_bruno');
  assert.deepEqual(historial, [
    { numero_ronda: 2, apuesta: 10, resultado: 'gana' },
    { numero_ronda: 1, apuesta: 50, resultado: 'pierde' }
  ]);
});
