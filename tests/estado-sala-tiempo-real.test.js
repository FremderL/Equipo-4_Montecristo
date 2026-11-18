'use strict';

// Pruebas del Ticket 6: cada vez que cambia el estado de la sala (alguien
// entra, sale o apuesta) el servidor manda `estado_sala` actualizado a TODOS
// los jugadores de esa sala, con el motivo del aviso y sin datos privados.

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: clienteIo } = require('socket.io-client');

const archivoDb = path.join(os.tmpdir(), `montecristo-estado-sala-${process.pid}.db`);
process.env.DB_FILE = archivoDb;

const { servidor, io } = require('../server.js');
const { REGLAS } = require('../lib/reglas.js');

const ESPERA_MS = 4000;
const CAPACIDAD = REGLAS.JUGADORES_POR_SALA;
const perfil = (nombre) => ({ nombre, avatar: '🙂' });
let origen;

before(async () => {
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  origen = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => io.close(resolve));
  for (const sufijo of ['', '-wal', '-shm']) {
    fs.rmSync(archivoDb + sufijo, { force: true });
  }
});

/** Cola de `estado_sala`: no se pierde ningún aviso aunque llegue antes de esperarlo. */
function escucharEstados(cliente) {
  const recibidos = [];
  const historial = [];
  const esperando = [];

  cliente.on('estado_sala', (estado) => {
    historial.push(estado);
    if (esperando.length > 0) esperando.shift()(estado);
    else recibidos.push(estado);
  });

  const siguiente = () => {
    if (recibidos.length > 0) return Promise.resolve(recibidos.shift());
    return new Promise((resolve, reject) => {
      const temporizador = setTimeout(() => reject(new Error('No llegó ningún estado_sala')), ESPERA_MS);
      esperando.push((estado) => {
        clearTimeout(temporizador);
        resolve(estado);
      });
    });
  };

  return {
    siguiente,
    async esperar(condicion) {
      for (;;) {
        const estado = await siguiente();
        if (condicion(estado)) return estado;
      }
    },
    /** Todos los avisos que llegaron, en orden (para revisar la secuencia de motivos). */
    get historial() {
      return historial;
    }
  };
}

async function conectar(t) {
  const cliente = clienteIo(origen, { autoConnect: false, reconnection: false, forceNew: true });
  t.after(() => cliente.disconnect());
  const conectado = once(cliente, 'connect', { signal: AbortSignal.timeout(ESPERA_MS) });
  cliente.connect();
  await conectado;
  return cliente;
}

const pedir = (cliente, evento, ...datos) => cliente.timeout(ESPERA_MS).emitWithAck(evento, ...datos);
const crear = (cliente, nombre, juego = 'coinflip') => pedir(cliente, 'crear_sala', { ...perfil(nombre), juego });
const entrar = (cliente, codigo, nombre) => pedir(cliente, 'entrar_sala', { ...perfil(nombre), codigo });

test('cuando alguien entra, todos los de la sala reciben el estado actualizado', async (t) => {
  const [ana, bruno, carla] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const estadosAna = escucharEstados(ana);
  const estadosBruno = escucharEstados(bruno);

  const { codigo } = await crear(ana, 'Ana');
  assert.equal((await entrar(bruno, codigo, 'Bruno')).ok, true);
  assert.equal((await entrar(carla, codigo, 'Carla')).ok, true);

  const paraAna = await estadosAna.esperar((estado) => estado.jugadores.length === 3);
  const paraBruno = await estadosBruno.esperar((estado) => estado.jugadores.length === 3);

  for (const estado of [paraAna, paraBruno]) {
    assert.equal(estado.codigo, codigo);
    assert.equal(estado.motivo, 'entrada', 'el aviso dice por qué se envió');
    assert.equal(estado.fase, 'espera');
    assert.deepEqual(estado.jugadores.map((j) => [j.asiento, j.nombre]), [[1, 'Ana'], [2, 'Bruno'], [3, 'Carla']]);
    assert.equal(estado.asientosLibres, CAPACIDAD - 3);
    assert.deepEqual(estado.apuestas, []);
  }
  assert.deepEqual(paraAna, paraBruno, 'todos reciben exactamente el mismo estado');
});

test('cuando alguien sale, el resto recibe el estado sin ese jugador', async (t) => {
  const [ana, bruno, carla] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const estadosAna = escucharEstados(ana);
  const estadosBruno = escucharEstados(bruno);

  const { codigo } = await crear(ana, 'Ana');
  assert.equal((await entrar(bruno, codigo, 'Bruno')).ok, true);
  assert.equal((await entrar(carla, codigo, 'Carla')).ok, true);

  assert.equal((await pedir(carla, 'salir_sala')).ok, true);

  const paraAna = await estadosAna.esperar((estado) => estado.motivo === 'salida' && estado.jugadores.length === 2);
  const paraBruno = await estadosBruno.esperar((estado) => estado.motivo === 'salida' && estado.jugadores.length === 2);

  for (const estado of [paraAna, paraBruno]) {
    assert.equal(estado.motivo, 'salida');
    assert.equal(estado.jugadores.length, 2);
    assert.deepEqual(estado.jugadores.map((j) => j.nombre), ['Ana', 'Bruno']);
    assert.equal(estado.asientosLibres, CAPACIDAD - 2);
  }
});

test('cuando alguien apuesta, todos ven las apuestas, el bote y las fichas al día', async (t) => {
  const [ana, bruno, carla] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const estadosBruno = escucharEstados(bruno);
  const estadosCarla = escucharEstados(carla);

  const { codigo } = await crear(ana, 'Ana');
  assert.equal((await entrar(bruno, codigo, 'Bruno')).ok, true);
  assert.equal((await entrar(carla, codigo, 'Carla')).ok, true);
  assert.equal((await pedir(ana, 'comenzar')).ok, true);

  assert.equal((await pedir(ana, 'apostar', { monto: 100, opcion: 'cara' })).ok, true);

  const paraBruno = await estadosBruno.esperar((estado) => estado.apuestas.length === 1);
  const paraCarla = await estadosCarla.esperar((estado) => estado.apuestas.length === 1);

  for (const estado of [paraBruno, paraCarla]) {
    assert.equal(estado.motivo, 'apuesta');
    assert.equal(estado.fase, 'apuestas');
    assert.equal(estado.bote, 100);
    assert.deepEqual(estado.apuestas.map((a) => [a.nombre, a.monto, a.opcion]), [['Ana', 100, 'cara']]);
    assert.equal(estado.jugadores.find((j) => j.nombre === 'Ana').fichas, REGLAS.SALDO_INICIAL - 100);
  }

  // La segunda apuesta también se difunde, ya con dos apuestas en la mesa.
  assert.equal((await pedir(bruno, 'apostar', { monto: 40, opcion: 'cruz' })).ok, true);
  const conDos = await estadosCarla.esperar((estado) => estado.apuestas.length === 2);
  assert.equal(conDos.bote, 140);
  assert.deepEqual(conDos.apuestas.map((a) => a.monto), [100, 40]);
});

test('el estado llega a los 6 jugadores de la sala a la vez', async (t) => {
  const anfitrion = await conectar(t);
  const estadosAnfitrion = escucharEstados(anfitrion);
  const { codigo } = await crear(anfitrion, 'Jugador 1');

  const amigos = await Promise.all(Array.from({ length: CAPACIDAD - 2 }, () => conectar(t)));
  const colecciones = amigos.map((amigo) => escucharEstados(amigo));
  for (const [i, amigo] of amigos.entries()) {
    assert.equal((await entrar(amigo, codigo, `Jugador ${i + 2}`)).ok, true);
  }

  // El sexto cierra la mesa: los seis reciben el estado con 6 jugadores.
  const ultimo = await conectar(t);
  const estadosUltimo = escucharEstados(ultimo);
  assert.equal((await entrar(ultimo, codigo, `Jugador ${CAPACIDAD}`)).ok, true);

  const todos = await Promise.all([
    estadosAnfitrion.esperar((estado) => estado.jugadores.length === CAPACIDAD),
    ...colecciones.map((cola) => cola.esperar((estado) => estado.jugadores.length === CAPACIDAD)),
    estadosUltimo.esperar((estado) => estado.jugadores.length === CAPACIDAD)
  ]);

  assert.equal(todos.length, CAPACIDAD, 'los 6 jugadores recibieron el aviso');
  for (const estado of todos) {
    assert.deepEqual(estado, todos[0], 'el estado es idéntico para todos');
  }
  assert.deepEqual(todos[0].jugadores.map((j) => j.asiento), [1, 2, 3, 4, 5, 6]);
  assert.equal(todos[0].asientosLibres, 0);
});

test('una ronda completa manda un estado por cada cambio y el motivo lo dice', async (t) => {
  const [ana, bruno] = await Promise.all([conectar(t), conectar(t)]);
  // Ana se queda en la mesa, así que recibe todos los avisos de la ronda.
  const estadosAna = escucharEstados(ana);

  const { codigo } = await crear(ana, 'Cara');
  assert.equal((await entrar(bruno, codigo, 'Bruno')).ok, true);
  assert.equal((await pedir(ana, 'comenzar')).ok, true);
  assert.equal((await pedir(ana, 'apostar', { monto: 10, opcion: 'cara' })).ok, true);
  assert.equal((await pedir(ana, 'lanzar')).ok, true);
  assert.equal((await pedir(bruno, 'salir_sala')).ok, true);

  await estadosAna.esperar((estado) => estado.motivo === 'salida');
  assert.deepEqual(
    estadosAna.historial.map((estado) => estado.motivo),
    ['creada', 'entrada', 'fase', 'apuesta', 'resultado', 'salida'],
    'un aviso por cada cambio de la sala'
  );
});

test('el estado difundido no filtra datos privados del servidor', async (t) => {
  const [ana, bruno] = await Promise.all([conectar(t), conectar(t)]);
  const estados = escucharEstados(bruno);

  const { codigo } = await crear(ana, 'Ana', 'blackjack');
  assert.equal((await entrar(bruno, codigo, 'Bruno')).ok, true);
  assert.equal((await pedir(ana, 'comenzar')).ok, true);
  assert.equal((await pedir(ana, 'apostar', { monto: 50, opcion: 'mano' })).ok, true);

  const estado = await estados.esperar((actual) => actual.apuestas.length === 1);
  const texto = JSON.stringify(estado);
  assert.doesNotMatch(texto, /"(?:semillaRng|mazo|manos|rng)":/);
  assert.ok(!('semillaRng' in estado) && !('mazo' in estado) && !('manos' in estado));
});
