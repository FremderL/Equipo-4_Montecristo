'use strict';

// Pruebas del Ticket 4 de punta a punta: al acabar una ronda de verdad (dos
// navegadores en una sala de Cara o Cruz), el servidor deja una fila por
// jugador en `historial_rondas` con sala, juego, jugador, apuesta, resultado y
// fecha, y esa tabla responde el historial y las estadísticas.

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: clienteIo } = require('socket.io-client');

const archivoDb = path.join(os.tmpdir(), `montecristo-historial-rondas-${process.pid}.db`);
process.env.DB_FILE = archivoDb;

const db = require('../lib/db.js');
db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
const {
  TABLA,
  registrarRondaTerminada,
  historialDeJugador,
  historialDeSala,
  estadisticasDeJugador
} = require('../lib/historial.js');
const { servidor, io } = require('../server.js');
const { buscarJugadorPorId } = require('../lib/jugadores.js');

const ESPERA_MS = 4000;
let origen;

before(async () => {
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  origen = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => io.close(resolve));
  db.close();
  for (const sufijo of ['', '-wal', '-shm']) {
    fs.rmSync(archivoDb + sufijo, { force: true });
  }
});

const emitir = (socket, evento, datos) =>
  new Promise((resolve) => {
    if (datos === undefined) socket.emit(evento, resolve);
    else socket.emit(evento, datos, resolve);
  });

async function conectar(t, nombre) {
  const cliente = clienteIo(origen, { autoConnect: false, reconnection: false, forceNew: true });
  t.after(() => cliente.disconnect());
  const listo = once(cliente, 'connect', { signal: AbortSignal.timeout(ESPERA_MS) });
  cliente.connect();
  await listo;
  return cliente;
}

test('al lanzar una ronda, historial_rondas guarda sala, juego, jugador, apuesta, resultado y fecha', async (t) => {
  db.exec(`DELETE FROM ${TABLA};`);

  const anfitrion = await conectar(t, 'Ana');
  const invitado = await conectar(t, 'Bruno');

  const creada = await emitir(anfitrion, 'crear_sala', { juego: 'coinflip', nombre: 'Ana', avatar: '🙂' });
  assert.equal(creada.ok, true);
  const { codigo } = creada;

  const entrado = await emitir(invitado, 'entrar_sala', { codigo, nombre: 'Bruno', avatar: '🐯' });
  assert.equal(entrado.ok, true);
  assert.equal(buscarJugadorPorId(anfitrion.id).saldo, 1000);
  assert.equal(buscarJugadorPorId(invitado.id).saldo, 1000);

  assert.equal((await emitir(anfitrion, 'comenzar')).ok, true);
  assert.equal((await emitir(anfitrion, 'apostar', { monto: 100, opcion: 'cara' })).ok, true);
  assert.equal((await emitir(invitado, 'apostar', { monto: 50, opcion: 'cruz' })).ok, true);
  assert.equal(buscarJugadorPorId(anfitrion.id).saldo, 1000, 'no se persiste una apuesta pendiente');
  assert.equal(buscarJugadorPorId(invitado.id).saldo, 1000);

  const lanzada = await emitir(anfitrion, 'lanzar');
  assert.equal(lanzada.ok, true, JSON.stringify(lanzada));

  const filas = db
    .prepare(`SELECT * FROM ${TABLA} WHERE sala_codigo = ? ORDER BY jugador_nombre`)
    .all(codigo);

  assert.equal(filas.length, 2, 'una fila por jugador y ronda');
  const [ana, bruno] = filas;
  assert.equal(ana.juego, 'coinflip');
  assert.equal(ana.numero_ronda, lanzada.numeroRonda);
  // El lado de la moneda lo decide el RNG del servidor: Ana apostó a cara y
  // Bruno a cruz, así que uno gana ×2 y el otro pierde lo apostado.
  const ganoAna = lanzada.resultado.lado === 'cara';
  assert.equal(ana.jugador_nombre, 'Ana');
  assert.equal(ana.apuesta, 100);
  assert.equal(ana.opcion, 'cara');
  assert.equal(ana.resultado, ganoAna ? 'gana' : 'pierde');
  assert.equal(ana.pago, ganoAna ? 200 : 0);
  assert.ok(!Number.isNaN(Date.parse(ana.fecha.replace(' ', 'T') + 'Z')), 'la fecha la pone la base de datos');
  assert.equal(bruno.jugador_nombre, 'Bruno');
  assert.equal(bruno.apuesta, 50);
  assert.equal(bruno.opcion, 'cruz');
  assert.equal(bruno.resultado, ganoAna ? 'pierde' : 'gana');
  assert.equal(bruno.pago, ganoAna ? 0 : 100);

  const saldoAna = 1000 - ana.apuesta + ana.pago;
  const saldoBruno = 1000 - bruno.apuesta + bruno.pago;
  assert.equal(lanzada.saldo, saldoAna);
  assert.equal(buscarJugadorPorId(anfitrion.id).saldo, saldoAna);
  assert.equal(buscarJugadorPorId(invitado.id).saldo, saldoBruno);
  assert.equal((await emitir(anfitrion, 'lanzar')).error.codigo, 'RONDA_LIQUIDADA');
  assert.equal(buscarJugadorPorId(anfitrion.id).saldo, saldoAna);

  // La misma ronda no se duplica; una ronda nueva sí se añade. `nueva_ronda`
  // devuelve la sala a la fase de apuestas, así que se apuesta y se lanza.
  const nueva = await emitir(anfitrion, 'nueva_ronda');
  assert.equal(nueva.ok, true, JSON.stringify(nueva));
  assert.equal((await emitir(anfitrion, 'apostar', { monto: 10, opcion: 'cara' })).ok, true);
  const segunda = await emitir(anfitrion, 'lanzar');
  assert.equal(segunda.ok, true, JSON.stringify(segunda));
  const pagoSegunda = segunda.resultado.lado === 'cara' ? 20 : 0;
  assert.equal(buscarJugadorPorId(anfitrion.id).saldo, saldoAna - 10 + pagoSegunda);
  assert.equal(buscarJugadorPorId(invitado.id).saldo, saldoBruno, 'no cambia si no vuelve a apostar');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLA} WHERE sala_codigo = ?`).get(codigo).n;
  assert.equal(total, 3, 'dos de la primera ronda y una de la segunda');
});

test('el historial y las estadísticas se consultan sin cruzar partidas ni apuestas', () => {
  db.exec(`DELETE FROM ${TABLA};`);

  registrarRondaTerminada({
    salaCodigo: 'K7Q2M',
    juego: 'roulette',
    numeroRonda: 1,
    jugadores: [
      { jugadorId: 'p_ana', nombre: 'Ana', apuesta: 100, opcion: 'rojo', resultado: 'gana', pago: 200 },
      { jugadorId: 'p_bruno', nombre: 'Bruno', apuesta: 50, opcion: 'n:17', resultado: 'pierde', pago: 0 }
    ]
  });
  registrarRondaTerminada({
    salaCodigo: 'K7Q2M',
    juego: 'roulette',
    numeroRonda: 2,
    jugadores: [
      { jugadorId: 'p_ana', nombre: 'Ana', apuesta: 40, opcion: 'negro', resultado: 'pierde', pago: 0 }
    ]
  });

  const historial = historialDeJugador('p_ana');
  assert.equal(historial.length, 2);
  assert.deepEqual(
    historial.map((fila) => [fila.numeroRonda, fila.apuesta, fila.resultado]),
    [[2, 40, 'pierde'], [1, 100, 'gana']],
    'de la ronda más reciente a la más antigua'
  );

  const soloRuleta = historialDeJugador('p_ana', { juego: 'roulette', limite: 1 });
  assert.equal(soloRuleta.length, 1);
  assert.throws(() => historialDeJugador('p_ana', { juego: 'ajedrez' }), /Juego desconocido/);

  assert.equal(historialDeSala('k7q2m').length, 3, 'el código se normaliza a mayúsculas');
  assert.throws(() => historialDeSala('ABC'), /cinco letras o números/);

  const estadisticas = estadisticasDeJugador('p_ana');
  assert.deepEqual(estadisticas, {
    rondas: 2,
    apostado: 140,
    cobrado: 200,
    ganadas: 1,
    perdidas: 1,
    empatadas: 0,
    neto: 60,
    porJuego: [{ juego: 'roulette', rondas: 2, apostado: 140, cobrado: 200, neto: 60 }]
  });

  const vacias = estadisticasDeJugador('p_nadie');
  assert.equal(vacias.rondas, 0);
  assert.equal(vacias.neto, 0);
});
