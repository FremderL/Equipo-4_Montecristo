'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: conectar } = require('socket.io-client');
const { servidor, io } = require('../server.js');
const { contarPuntos } = require('../lib/juegos/blackjack.js');

async function enviar(socket, evento, ...datos) {
  const respuesta = await socket.emitWithAck(evento, ...datos);
  assert.equal(respuesta.ok, true, respuesta.error?.mensaje);
  return respuesta;
}

function esperarEstado(socket, fase) {
  return new Promise((resolve) => {
    function recibir(estado) {
      if (estado.fase !== fase) return;
      socket.off('estado_sala', recibir);
      resolve(estado);
    }
    socket.on('estado_sala', recibir);
  });
}

test('repartir envía manos privadas solo a los apostadores y destapa la casa al cierre', { timeout: 10000 }, async (t) => {
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  const clientes = ['host', 'ana', 'bruno'].map(() => conectar(url, {
    autoConnect: false, reconnection: false, transports: ['websocket'], ackTimeout: 3000
  }));
  t.after(async () => {
    for (const socket of clientes) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
  });
  const [host, ana, bruno] = clientes;
  const manos = clientes.map((socket) => {
    const recibidas = [];
    socket.on('cartas', (mano) => recibidas.push(mano));
    return recibidas;
  });
  // El anfitrión no apuesta: todos los eventos que reciba deben ser públicos.
  const publicos = [];
  host.onAny((evento, datos) => publicos.push(datos));
  await Promise.all(clientes.map((socket) => once(socket.connect(), 'connect')));
  const { codigo } = await enviar(host, 'crear_sala', { nombre: 'Host', avatar: '🙂', juego: 'blackjack' });
  await enviar(ana, 'entrar_sala', { codigo, nombre: 'Ana', avatar: '🦊' });
  await enviar(bruno, 'entrar_sala', { codigo, nombre: 'Bruno', avatar: '🐼' });
  await enviar(host, 'comenzar');
  assert.equal((await host.emitWithAck('repartir')).error.codigo, 'SIN_APOSTADORES');
  for (const socket of [ana, bruno]) await enviar(socket, 'apostar', { monto: 10, opcion: 'mano' });
  assert.equal((await ana.emitWithAck('repartir')).error.codigo, 'SOLO_ANFITRION');

  const enJuego = Promise.all(clientes.map((socket) => esperarEstado(socket, 'jugando')));
  const ack = await enviar(host, 'repartir');
  assert.deepEqual(ack.orden, [ana.id, bruno.id]);
  const estados = await enJuego;
  assert.equal((await host.emitWithAck('repartir')).error.codigo, 'FASE_INVALIDA');
  assert.deepEqual(manos.map((recibidas) => recibidas.length), [0, 1, 1]);
  const cartasJugadores = [];
  for (const [mano] of manos.slice(1)) {
    assert.equal(mano.cartas.length, 2);
    assert.deepEqual(mano, { numeroRonda: 1, cartas: mano.cartas, puntos: contarPuntos(mano.cartas) });
    cartasJugadores.push(...mano.cartas);
  }
  const visible = estados[0].casa.cartas[0];
  for (const estado of estados) {
    assert.deepEqual(estado.casa, { cartas: [visible, null], puntos: contarPuntos([visible]) });
  }
  const antesDelCierre = JSON.stringify([publicos, estados, ack]);
  assert.doesNotMatch(antesDelCierre, /"(?:semillaRng|mazo|manos)":/);

  const alCierre = esperarEstado(host, 'resultados');
  for (const socket of [ana, bruno]) await enviar(socket, 'accion_blackjack', { accion: 'stand' });
  const { casa } = await alCierre;
  assert.equal(casa.cartas.length, 2);
  assert.equal(casa.cartas[0], visible);
  assert.equal(casa.puntos, contarPuntos(casa.cartas));
  assert.equal(new Set([...casa.cartas, ...cartasJugadores]).size, 6);
  for (const carta of [casa.cartas[1], ...cartasJugadores]) {
    assert.ok(!antesDelCierre.includes(JSON.stringify(carta)), 'ni la tapada ni las manos privadas viajaron a la sala');
  }

  const alAbrir = esperarEstado(host, 'apuestas');
  await enviar(host, 'nueva_ronda');
  const siguiente = await alAbrir;
  assert.equal(siguiente.numeroRonda, 2);
  assert.equal(siguiente.casa, null, 'la siguiente ronda empieza sin cartas');
});
