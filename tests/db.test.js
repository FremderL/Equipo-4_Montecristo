// Pruebas de la base de datos (tickets BE-01/BE-02/BE-03):
// que las cuatro tablas existen y que las restricciones funcionan.
// Uso: npm test
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Base de datos de pruebas en un archivo aparte: no toca data/casino.db.
const archivoTest = path.join(os.tmpdir(), `montecristo-test-${process.pid}.db`);
process.env.DB_FILE = archivoTest;

// La conexión se abre una sola vez (lib/db.js) y aplica el esquema de pruebas.
const db = require('../lib/db.js');
const esquema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(esquema);

after(() => {
  db.close();
  for (const sufijo of ['', '-wal', '-shm']) {
    fs.rmSync(archivoTest + sufijo, { force: true });
  }
});

// Deja cada prueba con las tablas vacías (se borran primero las hijas).
const limpiarTablas = () => {
  db.exec('DELETE FROM apuestas; DELETE FROM partidas; DELETE FROM salas; DELETE FROM jugadores;');
};

// Asegura que una inserción falle con un error de restricción de SQLite.
const debeFallarPor = (accion, tipoDeError) => {
  assert.throws(
    accion,
    (error) => error.code && error.code.startsWith('SQLITE_CONSTRAINT') && error.message.startsWith(tipoDeError),
    `se esperaba un error "${tipoDeError}"`
  );
};

test('las tablas del modelo existen', () => {
  limpiarTablas();
  const filas = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table');
  const tablas = new Set(filas.map((fila) => fila.name));
  for (const nombre of ['jugadores', 'salas', 'partidas', 'apuestas', 'historial_rondas']) {
    assert.ok(tablas.has(nombre), `falta la tabla ${nombre}`);
  }
});

test('insertos válidos aplican los valores por defecto', () => {
  limpiarTablas();
  db.prepare("INSERT INTO jugadores (id, nombre) VALUES ('p_def', 'Por Defecto')").run();
  const jugador = db.prepare('SELECT * FROM jugadores WHERE id = ?').get('p_def');
  assert.strictEqual(jugador.saldo_fichas, 1000);
  assert.strictEqual(jugador.avatar, '🙂');
  assert.strictEqual(jugador.es_anfitrion, 0);
  assert.strictEqual(jugador.conectado, 1);
  assert.ok(jugador.creado_en, 'creado_en debe tener valor por defecto');

  db.prepare("INSERT INTO salas (id, codigo, juego, anfitrion_id) VALUES ('s_def', 'DEF01', 'coinflip', 'p_def')").run();
  const sala = db.prepare('SELECT * FROM salas WHERE id = ?').get('s_def');
  assert.strictEqual(sala.capacidad, 6);
  assert.strictEqual(sala.estado, 'abierta');
  assert.strictEqual(sala.fase, 'espera');
  assert.strictEqual(sala.apuesta_minima, 10);
});

test('jugadores: saldo_fichas negativo falla por CHECK', () => {
  limpiarTablas();
  const insertar = db.prepare('INSERT INTO jugadores (id, nombre, saldo_fichas) VALUES (?, ?, ?)');
  debeFallarPor(() => insertar.run('p_neg', 'Nadie', -1), 'CHECK constraint failed');
});

test('salas: juego inválido falla por CHECK', () => {
  limpiarTablas();
  const insertar = db.prepare('INSERT INTO salas (id, codigo, juego) VALUES (?, ?, ?)');
  debeFallarPor(() => insertar.run('s_traga', 'TRAGA', 'tragamonedas'), 'CHECK constraint failed');
});

test('salas: dos códigos iguales fallan por UNIQUE', () => {
  limpiarTablas();
  const insertar = db.prepare('INSERT INTO salas (id, codigo, juego) VALUES (?, ?, ?)');
  insertar.run('s_uno', 'K7Q2M', 'roulette');
  debeFallarPor(() => insertar.run('s_dos', 'K7Q2M', 'dice'), 'UNIQUE constraint failed');
});

test('apuestas: monto menor a 10 falla por CHECK', () => {
  limpiarTablas();
  db.prepare("INSERT INTO jugadores (id, nombre) VALUES ('p_ap', 'Apostadora')").run();
  db.prepare("INSERT INTO salas (id, codigo, juego, anfitrion_id) VALUES ('s_ap', 'AP001', 'dice', 'p_ap')").run();
  db.prepare("INSERT INTO partidas (id, sala_id, numero_ronda, juego, fase) VALUES ('r_ap', 's_ap', 1, 'dice', 'apuestas')").run();
  const insertar = db.prepare('INSERT INTO apuestas (id, partida_id, jugador_id, monto, opcion) VALUES (?, ?, ?, ?, ?)');
  debeFallarPor(() => insertar.run('b_poca', 'r_ap', 'p_ap', 5, 'bajo'), 'CHECK constraint failed');
});

test('apuestas: una segunda apuesta del mismo jugador en la misma ronda falla por UNIQUE', () => {
  limpiarTablas();
  db.prepare("INSERT INTO jugadores (id, nombre) VALUES ('p_dup', 'Duplicada')").run();
  db.prepare("INSERT INTO salas (id, codigo, juego, anfitrion_id) VALUES ('s_dup', 'DUP01', 'dice', 'p_dup')").run();
  db.prepare("INSERT INTO partidas (id, sala_id, numero_ronda, juego, fase) VALUES ('r_dup', 's_dup', 1, 'dice', 'apuestas')").run();
  const insertar = db.prepare('INSERT INTO apuestas (id, partida_id, jugador_id, monto, opcion) VALUES (?, ?, ?, ?, ?)');
  insertar.run('b_primera', 'r_dup', 'p_dup', 10, 'bajo');
  debeFallarPor(() => insertar.run('b_segunda', 'r_dup', 'p_dup', 20, 'alto'), 'UNIQUE constraint failed');
});

test('con foreign_keys activado: sala con anfitrión inexistente falla', () => {
  limpiarTablas();
  const pragmaFk = db.pragma('foreign_keys', { get: true })[0].foreign_keys;
  assert.strictEqual(pragmaFk, 1, 'la conexión debe tener foreign_keys = ON');
  debeFallarPor(
    () => db.prepare("INSERT INTO salas (id, codigo, juego, anfitrion_id) VALUES ('s_fk', 'FK001', 'poker', 'p_inexistente')").run(),
    'FOREIGN KEY constraint failed'
  );
});
