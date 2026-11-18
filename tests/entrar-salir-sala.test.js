'use strict';

// Pruebas del Ticket 5: un jugador entra a una sala por su código y sale de
// ella, con un máximo de 6 jugadores por mesa.
//
// Se cubre: entrar con el código (aunque venga en minúsculas o con espacios),
// el tope de 6 asientos, la liberación del asiento al salir, el reembolso de la
// apuesta pendiente, el traspaso de anfitrión, el aviso `sala_cerrada` cuando la
// mesa se queda vacía y el rechazo de códigos que ya no existen.

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: clienteIo } = require('socket.io-client');

// Base de datos de pruebas en un archivo aparte: no toca data/casino.db.
const archivoDb = path.join(os.tmpdir(), `montecristo-entrar-salir-${process.pid}.db`);
process.env.DB_FILE = archivoDb;

const { servidor, io } = require('../server.js');
const { REGLAS } = require('../lib/reglas.js');

const ESPERA_MS = 4000;
const CAPACIDAD = REGLAS.JUGADORES_POR_SALA; // 6
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

/**
 * Cola de eventos `estado_sala` de un cliente: guarda los que llegan y deja
 * esperar el siguiente (o el primero que cumpla una condición) sin perder
 * ninguno por el camino.
 */
function escucharEstados(cliente) {
  const recibidos = [];
  const esperando = [];

  cliente.on('estado_sala', (estado) => {
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
    /** Primer estado (de los ya recibidos o de los que lleguen) que cumpla el filtro. */
    async esperar(condicion) {
      for (;;) {
        const estado = await siguiente();
        if (condicion(estado)) return estado;
      }
    },
    limpiar() {
      recibidos.length = 0;
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

test('se entra con el código de la sala (en minúsculas o con espacios) y se sale cuando se quiere', async (t) => {
  const [ana, bruno] = await Promise.all([conectar(t), conectar(t)]);
  const estadosAna = escucharEstados(ana);

  const { codigo } = await crear(ana, 'Ana');
  assert.match(codigo, /^[A-Z0-9]{5}$/, 'el código tiene 5 caracteres');

  const entrada = await entrar(bruno, ` ${codigo.toLowerCase()} `, 'Bruno');
  assert.deepEqual(entrada, { ok: true, codigo });

  const conBruno = await estadosAna.esperar((estado) => estado.jugadores.length === 2);
  assert.deepEqual(conBruno.jugadores.map((j) => [j.asiento, j.nombre]), [[1, 'Ana'], [2, 'Bruno']]);
  assert.equal(conBruno.asientosLibres, CAPACIDAD - 2);

  // Bruno sale: su asiento queda libre y Ana recibe el estado nuevo.
  const salida = await pedir(bruno, 'salir_sala');
  assert.deepEqual(salida, { ok: true, codigo, salaCerrada: false });

  const sinBruno = await estadosAna.esperar((estado) => estado.jugadores.length === 1);
  assert.deepEqual(sinBruno.jugadores.map((j) => [j.asiento, j.nombre]), [[1, 'Ana']]);
  assert.equal(sinBruno.asientosLibres, CAPACIDAD - 1);

  const consulta = await fetch(`${origen}/api/salas/${codigo.toLowerCase()}`);
  assert.equal(consulta.status, 200);
  assert.equal((await consulta.json()).asientosLibres, CAPACIDAD - 1);
});

test('máximo 6 jugadores: el séptimo recibe SALA_LLENA y entra en cuanto se libera un asiento', async (t) => {
  const anfitrion = await conectar(t);
  const estados = escucharEstados(anfitrion);
  const { codigo } = await crear(anfitrion, 'Ana');

  const amigos = await Promise.all(Array.from({ length: CAPACIDAD - 1 }, () => conectar(t)));
  const entradas = await Promise.all(amigos.map((amigo, i) => entrar(amigo, codigo, `Amigo ${i + 1}`)));
  assert.ok(entradas.every((entrada) => entrada.ok), 'caben los 6 jugadores');

  const estadoLleno = await estados.esperar((estado) => estado.jugadores.length === CAPACIDAD);
  assert.deepEqual(estadoLleno.jugadores.map((j) => j.asiento), [1, 2, 3, 4, 5, 6]);
  assert.equal(estadoLleno.asientosLibres, 0);

  // El séptimo no cabe.
  const septimo = await conectar(t);
  const rechazo = await entrar(septimo, codigo, 'Séptimo');
  assert.equal(rechazo.ok, false);
  assert.equal(rechazo.error.codigo, 'SALA_LLENA');
  assert.match(rechazo.error.mensaje, /6 jugadores/);

  // Alguien sale y el séptimo aprovecha ese asiento.
  assert.equal((await pedir(amigos[2], 'salir_sala')).ok, true);
  assert.equal((await entrar(septimo, codigo, 'Séptimo')).ok, true);

  const estadoFinal = await estados.esperar(
    (estado) => estado.jugadores.length === CAPACIDAD && estado.jugadores.some((j) => j.nombre === 'Séptimo')
  );
  assert.deepEqual(estadoFinal.jugadores.map((j) => j.asiento), [1, 2, 3, 4, 5, 6], 'el asiento libre se reutiliza');
});

test('al salir se libera el asiento, se reembolsa la apuesta pendiente y el anfitrión pasa al siguiente', async (t) => {
  const [ana, bruno, carla] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const estadosBruno = escucharEstados(bruno);

  const { codigo } = await crear(ana, 'Ana');
  assert.equal((await entrar(bruno, codigo, 'Bruno')).ok, true);
  assert.equal((await entrar(carla, codigo, 'Carla')).ok, true);

  assert.equal((await pedir(ana, 'comenzar')).ok, true);
  assert.equal((await pedir(ana, 'apostar', { monto: 100, opcion: 'cara' })).ok, true);
  assert.equal((await pedir(carla, 'apostar', { monto: 50, opcion: 'cruz' })).ok, true);

  // La anfitriona se va en plena fase de apuestas.
  await pedir(ana, 'salir_sala');
  const estado = await estadosBruno.esperar((actual) => !actual.jugadores.some((j) => j.nombre === 'Ana'));

  assert.equal(estado.jugadores.length, 2);
  assert.equal(estado.apuestas.length, 1, 'la apuesta de quien se fue no se queda en la mesa');
  assert.equal(estado.bote, 50, 'su apuesta se devolvió y el bote baja');
  assert.equal(estado.jugadores.find((j) => j.nombre === 'Bruno').esAnfitrion, true, 'el rol de anfitrión pasó a Bruno');
  assert.equal(estado.anfitrionId, bruno.id);
  assert.deepEqual(estado.jugadores.map((j) => j.asiento), [2, 3], 'los asientos que quedan no se mueven');
});

test('quien entra estando en otra sala sale de la anterior y las dos mesas se enteran', async (t) => {
  const [ana, bruno, carla] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const estadosAna = escucharEstados(ana);
  const estadosCarla = escucharEstados(carla);

  const salaUno = await crear(ana, 'Ana');
  assert.equal((await entrar(bruno, salaUno.codigo, 'Bruno')).ok, true);
  const salaDos = await crear(carla, 'Carla', 'poker');

  assert.equal((await entrar(bruno, salaDos.codigo, 'Bruno')).ok, true);

  const sinBruno = await estadosAna.esperar((estado) => estado.codigo === salaUno.codigo && estado.jugadores.length === 1);
  assert.deepEqual(sinBruno.jugadores.map((j) => j.nombre), ['Ana']);

  const conBruno = await estadosCarla.esperar((estado) => estado.codigo === salaDos.codigo && estado.jugadores.length === 2);
  assert.deepEqual(conBruno.jugadores.map((j) => j.nombre), ['Carla', 'Bruno']);
});

test('cuando se va el último jugador la sala se cierra y su código deja de existir', async (t) => {
  const [ana, bruno] = await Promise.all([conectar(t), conectar(t)]);
  const { codigo } = await crear(ana, 'Ana');
  assert.equal((await entrar(bruno, codigo, 'Bruno')).ok, true);
  assert.equal((await pedir(bruno, 'salir_sala')).salaCerrada, false);

  // Ana es la última: además de salir, el servidor le avisa que la sala se cerró.
  const aviso = once(ana, 'sala_cerrada', { signal: AbortSignal.timeout(ESPERA_MS) });
  const salida = await pedir(ana, 'salir_sala');
  assert.deepEqual(salida, { ok: true, codigo, salaCerrada: true });
  assert.deepEqual(await aviso.then(([datos]) => datos), { codigo, motivo: 'sala_vacia' });

  // El código ya no sirve para entrar y la API responde 404.
  assert.equal((await entrar(bruno, codigo, 'Bruno')).error.codigo, 'SALA_NO_ENCONTRADA');
  assert.equal((await fetch(`${origen}/api/salas/${codigo}`)).status, 404);
});
