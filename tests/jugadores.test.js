'use strict';

// Pruebas del Ticket 2: funciones básicas de jugadores.
// Crear un jugador, buscarlo por id y actualizar su nombre, avatar y saldo.
// Además comprueba que el resto del código NO tenga consultas sueltas sobre
// la tabla `<repositorio>/jugadores`.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const archivoTest = path.join(os.tmpdir(), `montecristo-jugadores-${process.pid}.db`);
process.env.DB_FILE = archivoTest;

const db = require('../lib/db.js');
const esquema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(esquema);

const {
  TABLA,
  AVATAR_POR_DEFECTO,
  crearJugador,
  buscarJugadorPorId,
  buscarJugadorPorDispositivo,
  actualizarJugador,
  actualizarNombreJugador,
  actualizarAvatarJugador,
  actualizarSaldoJugador,
  actualizarSaldosJugadores,
  ajustarSaldoJugador,
  configurarDb
} = require('../lib/jugadores.js');
const fichas = require('../lib/fichas.js');
const { REGLAS } = require('../lib/reglas.js');

after(() => {
  db.close();
  for (const sufijo of ['', '-wal', '-shm']) {
    fs.rmSync(archivoTest + sufijo, { force: true });
  }
});

const limpiar = () => db.exec('DELETE FROM apuestas; DELETE FROM partidas; DELETE FROM salas; DELETE FROM jugadores;');

// ---------------------------------------------------------------------------
// crearJugador
// ---------------------------------------------------------------------------

test('crearJugador guarda la fila y devuelve el jugador con saldo y avatar por defecto', () => {
  limpiar();
  const jugador = crearJugador({ id: 'j_ana', nombre: '  Ana  ' });

  assert.equal(jugador.id, 'j_ana');
  assert.equal(jugador.nombre, 'Ana', 'el nombre se guarda sin espacios sobrantes');
  assert.equal(jugador.avatar, AVATAR_POR_DEFECTO);
  assert.equal(jugador.saldo, REGLAS.SALDO_INICIAL);
  assert.equal(jugador.saldoFichas, 1000);
  assert.equal(jugador.conectado, true);

  const fila = db.prepare(`SELECT * FROM ${TABLA} WHERE id = ?`).get('j_ana');
  assert.equal(fila.nombre, 'Ana');
  assert.equal(fila.saldo_fichas, 1000);
  assert.ok(fila.creado_en, 'la fecha de alta la pone la base de datos');
});

test('crearJugador acepta id generado, avatar propio y saldo inicial explícito', () => {
  limpiar();
  const sinId = crearJugador({ nombre: 'Bruno', avatar: '🐯' });
  assert.match(sinId.id, /^[0-9a-f-]{36}$/, 'sin id se genera un UUID');
  assert.equal(sinId.avatar, '🐯');

  const conSaldo = crearJugador({ id: 'j_carla', nombre: 'Carla', saldo: 250 });
  assert.equal(conSaldo.saldo, 250);
  assert.equal(buscarJugadorPorId('j_carla').saldo, 250);
});

test('crearJugador rechaza nombre vacío, nombre repetido en id y saldo inválido', () => {
  limpiar();
  assert.throws(() => crearJugador({ nombre: '   ' }), /Escribe tu nombre/);
  assert.throws(() => crearJugador({ nombre: 'x'.repeat(25) }), /24 caracteres/);
  assert.throws(() => crearJugador({ id: 'j_x', nombre: 'X', saldo: -5 }), /entero mayor o igual a 0/);
  assert.throws(() => crearJugador({ id: 'j_x', nombre: 'X', saldo: 10.5 }), /entero mayor o igual a 0/);

  crearJugador({ id: 'j_uno', nombre: 'Uno' });
  assert.throws(() => crearJugador({ id: 'j_uno', nombre: 'Otro' }), /Ya existe un jugador/);
});

// ---------------------------------------------------------------------------
// Buscar por id de jugador o dispositivo
// ---------------------------------------------------------------------------

test('buscarJugadorPorId devuelve el jugador guardado o null si no existe', () => {
  limpiar();
  const creado = crearJugador({ id: 'j_dani', nombre: 'Dani', avatar: '🐼' });

  const encontrado = buscarJugadorPorId('j_dani');
  assert.deepEqual(encontrado, creado);
  assert.equal(buscarJugadorPorId('j_dani').nombre, 'Dani');

  assert.equal(buscarJugadorPorId('j_fantasma'), null);
  assert.equal(buscarJugadorPorId(''), null);
  assert.equal(buscarJugadorPorId(undefined), null);
  assert.equal(buscarJugadorPorId(null), null);
});

test('recupera el perfil por su deviceId y valida el identificador', () => {
  limpiar();
  const jugador = crearJugador({ nombre: 'Luz', deviceId: 'd_luz' });
  assert.deepEqual(buscarJugadorPorDispositivo('d_luz'), jugador);
  assert.equal(buscarJugadorPorDispositivo('d_otro'), null);
  assert.throws(() => buscarJugadorPorDispositivo('x'.repeat(65)), { codigo: 'DISPOSITIVO_INVALIDO' });
});

// ---------------------------------------------------------------------------
// actualizarJugador (nombre, avatar y saldo)
// ---------------------------------------------------------------------------

test('actualizarJugador cambia el nombre, el avatar y el saldo a la vez', () => {
  limpiar();
  crearJugador({ id: 'j_eva', nombre: 'Eva', avatar: '🙂', saldo: 1000 });

  const actualizado = actualizarJugador('j_eva', { nombre: 'Eva María', avatar: '🦊', saldo: 640 });
  assert.equal(actualizado.nombre, 'Eva María');
  assert.equal(actualizado.avatar, '🦊');
  assert.equal(actualizado.saldo, 640);

  const enBase = db.prepare(`SELECT nombre, avatar, saldo_fichas FROM ${TABLA} WHERE id = ?`).get('j_eva');
  assert.deepEqual(enBase, { nombre: 'Eva María', avatar: '🦊', saldo_fichas: 640 });
});

test('las funciones cortas actualizan un solo campo cada una', () => {
  limpiar();
  crearJugador({ id: 'j_feo', nombre: 'Feo', avatar: '🙂', saldo: 1000 });

  assert.equal(actualizarNombreJugador('j_feo', 'Fede').nombre, 'Fede');
  assert.equal(actualizarAvatarJugador('j_feo', '🐸').avatar, '🐸');
  const conSaldo = actualizarSaldoJugador('j_feo', 0);
  assert.equal(conSaldo.saldo, 0);
  assert.equal(conSaldo.nombre, 'Fede', 'el resto de campos se conserva');
  assert.equal(conSaldo.avatar, '🐸');
});

test('actualizarJugador valida los datos y avisa si el jugador no existe', () => {
  limpiar();
  crearJugador({ id: 'j_gabi', nombre: 'Gabi' });

  assert.throws(() => actualizarJugador('j_gabi', {}), /al menos un campo/);
  assert.throws(() => actualizarJugador('j_gabi', { nombre: '' }), /Escribe tu nombre/);
  assert.throws(() => actualizarJugador('j_gabi', { avatar: '   ' }), /Selecciona un avatar/);
  assert.throws(() => actualizarJugador('j_gabi', { saldo: -1 }), /entero mayor o igual a 0/);
  assert.throws(() => actualizarJugador('j_nadie', { nombre: 'Nadie' }), /Jugador no encontrado/);
});

// ---------------------------------------------------------------------------
// Operaciones atómicas de saldo
// ---------------------------------------------------------------------------

test('actualizarSaldosJugadores guarda todos los saldos de la ronda o ninguno', () => {
  limpiar();
  crearJugador({ id: 'j_ana', nombre: 'Ana' });
  crearJugador({ id: 'j_bruno', nombre: 'Bruno' });
  const saldos = [{ id: 'j_ana', saldo: 2000 }, { id: 'j_bruno', saldo: 0 }];
  assert.throws(
    () => actualizarSaldosJugadores([...saldos, { id: 'no_existe', saldo: 1000 }]),
    { codigo: 'JUGADOR_NO_ENCONTRADO' }
  );
  assert.equal(buscarJugadorPorId('j_ana').saldo, 1000);
  assert.equal(buscarJugadorPorId('j_bruno').saldo, 1000);

  actualizarSaldosJugadores(saldos);
  assert.equal(buscarJugadorPorId('j_ana').saldo, 2000);
  assert.equal(buscarJugadorPorId('j_bruno').saldo, 0);
});

test('ajustarSaldoJugador suma y resta sin dejar el saldo en negativo', () => {
  limpiar();
  crearJugador({ id: 'j_hugo', nombre: 'Hugo', saldo: 100 });

  assert.equal(ajustarSaldoJugador('j_hugo', -40).saldo, 60);
  assert.equal(ajustarSaldoJugador('j_hugo', 200).saldo, 260);
  assert.throws(() => ajustarSaldoJugador('j_hugo', -300), /Saldo insuficiente/);
  assert.equal(buscarJugadorPorId('j_hugo').saldo, 260, 'el saldo no cambia si la operación falla');
  assert.throws(() => ajustarSaldoJugador('j_hugo', 1.5), /entero/);
  assert.throws(() => ajustarSaldoJugador('j_nadie', 10), /Jugador no encontrado/);
});

// ---------------------------------------------------------------------------
// El resto del código usa estas funciones
// ---------------------------------------------------------------------------

test('ni server.js ni lib/fichas.js tienen consultas sueltas sobre jugadores', () => {
  const archivos = ['server.js', 'lib/fichas.js', 'lib/historial.js', 'db/migrar.js'];
  const sqlSuelto = /\b(FROM|INTO|UPDATE|JOIN)\s+jugadores\b/i;

  for (const archivo of archivos) {
    const codigo = fs.readFileSync(path.join(__dirname, '..', archivo), 'utf8');
    assert.doesNotMatch(codigo, sqlSuelto, `${archivo} debe usar lib/jugadores.js en vez de SQL suelto`);
  }
});

test('lib/fichas.js mueve las fichas con las funciones de jugadores', () => {
  limpiar();
  crearJugador({ id: 'j_ines', nombre: 'Inés', saldo: 500 });
  db.prepare(`INSERT INTO salas (id, codigo, juego, anfitrion_id) VALUES ('s1', 'K7Q2M', 'coinflip', 'j_ines')`).run();
  db.prepare(`INSERT INTO partidas (id, sala_id, numero_ronda, juego, fase) VALUES ('p1', 's1', 1, 'coinflip', 'apuestas')`).run();

  const apuesta = fichas.apostar({ jugadorId: 'j_ines', partidaId: 'p1', monto: 200, opcion: 'cara' });
  assert.equal(apuesta.saldo, 300);
  assert.equal(buscarJugadorPorId('j_ines').saldo, 300, 'el descuento lo aplica jugadores.ajustarSaldoJugador');

  fichas.acreditar({ apuestaId: apuesta.apuestaId, multiplicador: 2, resultado: 'gana' });
  assert.equal(buscarJugadorPorId('j_ines').saldo, 700, 'el pago también pasa por jugadores');

  const otra = fichas.reembolsar(apuesta.apuestaId);
  assert.equal(otra.reembolsada, false, 'una apuesta ya liquidada no se reembolsa');
  assert.equal(buscarJugadorPorId('j_ines').saldo, 700);
});

test('configurarDb conecta fichas y jugadores a la misma base de pruebas', () => {
  assert.throws(() => configurarDb({}), /better-sqlite3/);
  const jugador = crearJugador({ id: 'j_luz', nombre: 'Luz' });
  assert.equal(jugador.id, 'j_luz');
});
