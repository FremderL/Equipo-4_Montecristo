'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: clienteIo } = require('socket.io-client');

// Base de datos de pruebas en un archivo aparte: no toca data/casino.db.
const archivoDb = path.join(os.tmpdir(), `montecristo-salas-${process.pid}.db`);
process.env.DB_FILE = archivoDb;

const { servidor, io } = require('../server.js');
const { REGLAS } = require('../lib/reglas.js');

const ESPERA_MS = 3000;
const perfil = (nombre) => ({ nombre, avatar: '🙂' });
let origen;

before(async () => {
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  origen = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await io.close();
  for (const sufijo of ['', '-wal', '-shm']) {
    fs.rmSync(archivoDb + sufijo, { force: true });
  }
});

async function conectar(t) {
  const cliente = clienteIo(origen, { autoConnect: false, reconnection: false, forceNew: true });
  t.after(() => cliente.disconnect());
  const conectado = unaVez(cliente, 'connect');
  cliente.connect();
  await conectado;
  return cliente;
}

async function unaVez(cliente, evento) {
  const [datos] = await once(cliente, evento, { signal: AbortSignal.timeout(ESPERA_MS) });
  return datos;
}

function pedir(cliente, evento, ...datos) {
  return cliente.timeout(ESPERA_MS).emitWithAck(evento, ...datos);
}

function crear(cliente, nombre, juego = 'coinflip') {
  return pedir(cliente, 'crear_sala', { ...perfil(nombre), juego });
}

function entrar(cliente, codigo, nombre) {
  return pedir(cliente, 'entrar_sala', { ...perfil(nombre), codigo });
}

async function consultar(ruta, opciones) {
  return fetch(origen + ruta, { signal: AbortSignal.timeout(ESPERA_MS), ...opciones });
}

test('salas activas distintas y un amigo entra solo a la mesa del código compartido', async (t) => {
  const [ana, carla, bruno] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const [primera, segunda] = await Promise.all([crear(ana, 'Ana'), crear(carla, 'Carla', 'poker')]);
  for (const sala of [primera, segunda]) {
    assert.equal(sala.ok, true);
    assert.match(sala.codigo, /^[A-Z0-9]{5}$/);
  }
  assert.notEqual(primera.codigo, segunda.codigo);

  const codigo = primera.codigo;
  const [estadoAna, estadoBruno, entrada] = await Promise.all([
    unaVez(ana, 'estado_sala'),
    unaVez(bruno, 'estado_sala'),
    entrar(bruno, ` ${codigo.toLowerCase()} `, 'Bruno')
  ]);
  assert.deepEqual(entrada, { ok: true, codigo });
  assert.deepEqual(estadoBruno, estadoAna);
  assert.equal(estadoAna.codigo, codigo);
  assert.deepEqual(estadoAna.jugadores.map(({ nombre }) => nombre), ['Ana', 'Bruno']);

  const consulta = await consultar(`/api/salas/${segunda.codigo.toLowerCase()}`);
  assert.equal(consulta.status, 200);
  assert.equal((await consulta.json()).asientosLibres, REGLAS.JUGADORES_POR_SALA - 1);

  const enlace = await consultar(`/sala/${codigo.toLowerCase()}`, { redirect: 'manual' });
  assert.equal(enlace.status, 302);
  assert.equal(enlace.headers.get('location'), `/perfil.html?accion=entrar&codigo=${codigo}`);
});

test('una sala llena rechaza a nuevos jugadores, pero no expulsa a quien reenvía el código', async (t) => {
  const anfitrion = await conectar(t);
  const { codigo } = await crear(anfitrion, 'Ana');
  const amigos = await Promise.all(Array.from({ length: REGLAS.JUGADORES_POR_SALA - 1 }, () => conectar(t)));
  const entradas = await Promise.all(amigos.map((amigo, i) => entrar(amigo, codigo, `Amigo ${i + 1}`)));
  assert.ok(entradas.every((entrada) => entrada.ok));

  const invitado = await conectar(t);
  assert.equal((await entrar(invitado, codigo, 'Bruno')).error.codigo, 'SALA_LLENA');
  assert.equal((await pedir(anfitrion, 'comenzar')).ok, true);
  assert.equal((await pedir(anfitrion, 'apostar', { monto: 100, opcion: 'cara' })).ok, true);

  const [estado, entrada] = await Promise.all([
    unaVez(anfitrion, 'estado_sala'),
    entrar(anfitrion, codigo, 'Otro nombre')
  ]);
  assert.deepEqual(entrada, { ok: true, codigo });
  assert.equal(estado.jugadores.length, REGLAS.JUGADORES_POR_SALA);
  const jugador = estado.jugadores.find(({ id }) => id === anfitrion.id);
  assert.equal(jugador.nombre, 'Ana');
  assert.equal(jugador.esAnfitrion, true);
  assert.equal(jugador.fichas, REGLAS.SALDO_INICIAL - 100);
  assert.equal(estado.apuestas.length, 1);
});

test('rechaza un código inválido o el de una sala que ya se vació', async (t) => {
  const [ana, bruno] = await Promise.all([conectar(t), conectar(t)]);
  const { codigo } = await crear(ana, 'Ana');
  assert.equal((await entrar(bruno, 'A*BCD', 'Bruno')).error.codigo, 'CODIGO_INVALIDO');
  assert.equal((await pedir(ana, 'salir_sala')).ok, true);
  assert.equal((await entrar(bruno, codigo, 'Bruno')).error.codigo, 'SALA_NO_ENCONTRADA');
  assert.equal((await consultar(`/api/salas/${codigo}`)).status, 404);
});

test('el directorio refleja anfitrión y ocupación; una baja libera su asiento, no mueve los demás', async (t) => {
  const [ana, bruno, luz] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const { codigo } = await crear(ana, 'Ana', 'roulette');
  await entrar(bruno, codigo, 'Bruno');
  await entrar(luz, codigo, 'Luz');
  const delDirectorio = async () => (await (await consultar('/api/salas')).json()).salas.find((s) => s.codigo === codigo);
  assert.deepEqual(await delDirectorio(), {
    id: `s_${codigo}`, codigo, juego: 'roulette', fase: 'espera', anfitrionId: ana.id,
    anfitrion: 'Ana', jugadores: 3, capacidad: 6, asientosLibres: 3
  });
  await pedir(ana, 'salir_sala');
  assert.equal((await delDirectorio()).anfitrion, 'Bruno');
  assert.equal((await delDirectorio()).jugadores, 2);
  const [estado] = await Promise.all([unaVez(ana, 'estado_sala'), entrar(ana, codigo, 'Ana')]);
  assert.deepEqual(estado.jugadores.map(({ nombre, asiento }) => [nombre, asiento]), [['Ana', 1], ['Bruno', 2], ['Luz', 3]]);
  for (const cliente of [ana, bruno, luz]) await pedir(cliente, 'salir_sala');
  assert.equal(await delDirectorio(), undefined);
});

test('la mesa no cobra apuestas fuera de fase, inválidas ni repetidas', async (t) => {
  const ana = await conectar(t);
  const { codigo } = await crear(ana, 'Ana');
  const apostar = (monto) => pedir(ana, 'apostar', { monto, opcion: 'cruz' });
  assert.equal((await apostar(100)).error.codigo, 'FASE_INVALIDA');
  await pedir(ana, 'comenzar');
  for (const monto of [9, 10.5, REGLAS.SALDO_INICIAL + 1]) {
    assert.equal((await apostar(monto)).error.codigo, 'APUESTA_INVALIDA');
  }
  assert.equal((await apostar(100)).saldo, REGLAS.SALDO_INICIAL - 100);
  assert.equal((await apostar(100)).error.codigo, 'APUESTA_REPETIDA');
  const [estado] = await Promise.all([unaVez(ana, 'estado_sala'), entrar(ana, codigo, 'Ana')]);
  assert.equal(estado.apuestas.length, 1);
  assert.equal(estado.jugadores[0].fichas, REGLAS.SALDO_INICIAL - 100);
});

test('resultado: todos reciben la misma liquidación de moneda y el mismo estado final', async (t) => {
  const [ines, diego, luz] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const { codigo } = await crear(ines, 'Inés');
  await entrar(diego, codigo, 'Diego');
  await entrar(luz, codigo, 'Luz');
  await pedir(ines, 'comenzar');
  await pedir(ines, 'apostar', { monto: 100, opcion: 'cara' });
  await pedir(diego, 'apostar', { monto: 100, opcion: 'cruz' });
  const [a, b, c, estado] = await Promise.all([
    ...[ines, diego, luz].map((j) => unaVez(j, 'resultado')),
    unaVez(diego, 'estado_sala'), pedir(ines, 'lanzar')
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(a.codigo, codigo);
  assert.equal(a.numeroRonda, estado.numeroRonda);
  assert.deepEqual(a.resultado, estado.resultado);
  assert.deepEqual(a.apuestas, estado.apuestas);
  assert.equal(a.apuestas.length, 2);
  for (const j of estado.jugadores) {
    const apuesta = a.apuestas.find((ap) => ap.jugadorId === j.id);
    if (apuesta) assert.equal(apuesta.neto, apuesta.opcion === a.resultado.lado ? 100 : -100);
    assert.equal(j.fichas, REGLAS.SALDO_INICIAL + (apuesta?.neto || 0));
  }
});

test('el cierre de póker informa lo aportado, las devoluciones y los abandonos sin inventar ganadores', async (t) => {
  const [ines, diego, luz] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  const { codigo } = await crear(ines, 'Inés', 'poker');
  await entrar(diego, codigo, 'Diego');
  await entrar(luz, codigo, 'Luz');
  await pedir(ines, 'comenzar');
  for (const j of [ines, diego, luz]) await pedir(j, 'apostar', { monto: 10, opcion: 'mano' });
  const [turno] = await Promise.all([unaVez(luz, 'turno'), pedir(ines, 'repartir')]);
  assert.deepEqual([turno.codigo, turno.numeroRonda, turno.jugadorId], [codigo, 1, ines.id]);
  assert.equal((await pedir(ines, 'accion_poker', { accion: 'raise', monto: 100 })).ok, true);
  await pedir(ines, 'salir_sala');
  assert.equal((await pedir(diego, 'accion_poker', { accion: 'call' })).ok, true);
  const [ronda] = await Promise.all([unaVez(diego, 'resultado'), pedir(luz, 'accion_poker', { accion: 'fold' })]);
  assert.deepEqual(ronda.resultado, { tipo: 'devolucion' });
  assert.deepEqual(ronda.apuestas.map(({ nombre, totalAportado, pago, neto }) => [nombre, totalAportado, pago, neto]), [
    ['Inés', 110, 0, -110], ['Diego', 110, 110, 0], ['Luz', 10, 10, 0]
  ]);
  const [estado] = await Promise.all([unaVez(ines, 'estado_sala'), entrar(ines, codigo, 'Invitada')]);
  assert.deepEqual(estado.apuestas, ronda.apuestas);
  assert.deepEqual(estado.resultado, ronda.resultado);
  assert.equal(estado.jugadores.find((j) => j.id === diego.id).fichas, REGLAS.SALDO_INICIAL);
});

test('chat: autor y destino son los del socket; valida pertenencia, blancos y el límite de 200', async (t) => {
  const [ines, diego, otro] = await Promise.all([conectar(t), conectar(t), conectar(t)]);
  assert.equal((await pedir(ines, 'chat', { texto: 'Hola' })).error.codigo, 'SIN_SALA');
  const { codigo } = await crear(ines, 'Inés');
  await entrar(diego, codigo, 'Diego');
  const otraSala = await crear(otro, 'Luz');
  const ajenos = [], recibidos = [];
  otro.on('chat_mensaje', (m) => ajenos.push(m));
  diego.on('chat_mensaje', (m) => recibidos.push(m));
  for (const texto of ['   ', 'a'.repeat(201)]) assert.equal((await pedir(ines, 'chat', { texto })).error.codigo, 'MENSAJE_INVALIDO');
  const [eco, entrega, ack] = await Promise.all([
    unaVez(ines, 'chat_mensaje'), unaVez(diego, 'chat_mensaje'),
    pedir(ines, 'chat', { texto: '  Hola, Diego.  ', nombre: 'Otro nombre', codigo: otraSala.codigo })
  ]);
  assert.deepEqual(ack, { ok: true });
  assert.deepEqual(eco, entrega);
  assert.deepEqual([eco.codigo, eco.jugadorId, eco.nombre, eco.texto], [codigo, ines.id, 'Inés', 'Hola, Diego.']);
  assert.ok(Number.isFinite(Date.parse(eco.hora)));
  assert.equal((await pedir(otro, 'chat', { texto: 'a'.repeat(200) })).ok, true);
  // Cada ack viaja detrás del eco de su sala; no hay que esperar con un sleep.
  assert.deepEqual(ajenos.map((m) => m.codigo), [otraSala.codigo]);
  assert.deepEqual(recibidos, [eco]);
});
