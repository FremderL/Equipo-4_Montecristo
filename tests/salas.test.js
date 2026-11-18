'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: clienteIo } = require('socket.io-client');
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
