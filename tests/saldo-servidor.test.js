'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: conectarSocket } = require('socket.io-client');

const carpetaDb = fs.mkdtempSync(path.join(os.tmpdir(), 'montecristo-saldo-'));
process.env.DB_FILE = path.join(carpetaDb, 'casino.db');
const db = require('../lib/db.js');
const { buscarJugadorPorId, buscarJugadorPorDispositivo } = require('../lib/jugadores.js');
const { historialDeJugador } = require('../lib/historial.js');
const { servidor, io } = require('../server.js');

const ESPERA_MS = 3000;
const perfil = (nombre) => ({ nombre, avatar: '🙂', device_id: randomUUID() });
const esperar = (emisor, evento) => once(emisor, evento, { signal: AbortSignal.timeout(ESPERA_MS) });
let origen;

before(async () => {
  servidor.listen(0, '127.0.0.1');
  await esperar(servidor, 'listening');
  origen = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await io.close();
  db.close();
  fs.rmSync(carpetaDb, { recursive: true, force: true });
});

async function conectar(t) {
  const socket = conectarSocket(origen, {
    autoConnect: false, reconnection: false, transports: ['websocket'], ackTimeout: ESPERA_MS
  });
  t.after(() => socket.disconnect());
  const conectado = esperar(socket, 'connect');
  socket.connect();
  await conectado;
  return socket;
}

async function desconectar(socket) {
  const desconectado = esperar(io.sockets.sockets.get(socket.id), 'disconnect');
  socket.disconnect();
  await desconectado;
}

async function pedir(socket, evento, ...datos) {
  const respuesta = await socket.emitWithAck(evento, ...datos);
  assert.equal(respuesta.ok, true, respuesta.error?.mensaje);
  return respuesta;
}

async function sentar(socket, evento, datos) {
  let estado;
  const recibir = (actual) => { estado = actual; };
  socket.on('estado_sala', recibir);
  try {
    const { codigo } = await pedir(socket, evento, datos);
    // Al cambiar de sala pueden llegar primero estados de la mesa que se deja.
    assert.equal(estado?.codigo, codigo);
    return { codigo, saldo: estado.jugadores.find((jugador) => jugador.id === socket.id).fichas, estado };
  } finally {
    socket.off('estado_sala', recibir);
  }
}

test('el mismo navegador recupera sus fichas, incluso si se quedó en cero', async (t) => {
  const [ana, bruno] = await Promise.all([conectar(t), conectar(t)]);
  const perfilAna = perfil('Ana');
  const perfilBruno = perfil('Bruno');
  const creada = await sentar(ana, 'crear_sala', { ...perfilAna, juego: 'coinflip', saldo: 99999 });
  const entrada = await sentar(bruno, 'entrar_sala', { ...perfilBruno, codigo: creada.codigo, fichas: 1 });
  assert.equal(creada.saldo, 1000, 'el cliente no puede decidir su saldo inicial');
  assert.equal(entrada.saldo, 1000);
  assert.equal(JSON.stringify(entrada.estado).includes(perfilAna.device_id), false, 'el identificador no se difunde');

  await pedir(ana, 'comenzar');
  await pedir(ana, 'apostar', { monto: 1000, opcion: 'cara' });
  await pedir(bruno, 'apostar', { monto: 1000, opcion: 'cruz' });
  const { resultado } = await pedir(ana, 'lanzar');
  const participantes = [
    { socket: ana, datos: perfilAna, id: ana.id },
    { socket: bruno, datos: perfilBruno, id: bruno.id }
  ];
  const [ganador, perdedor] = resultado.lado === 'cara' ? participantes : participantes.reverse();
  assert.equal(buscarJugadorPorId(ganador.id).saldo, 2000);
  assert.equal(buscarJugadorPorId(perdedor.id).saldo, 0);

  const nuevaConexion = await conectar(t);
  const nuevaSala = { ...perdedor.datos, nombre: 'Otro nombre', juego: 'coinflip' };
  assert.equal((await nuevaConexion.emitWithAck('crear_sala', nuevaSala)).error.codigo, 'PERFIL_EN_USO');
  await desconectar(perdedor.socket);
  const regreso = await sentar(nuevaConexion, 'crear_sala', nuevaSala);
  assert.equal(regreso.saldo, 0, 'cero es un saldo guardado, no un perfil nuevo');
  assert.equal(buscarJugadorPorDispositivo(perdedor.datos.device_id).id, perdedor.id);
  assert.equal(buscarJugadorPorId(perdedor.id).nombre, 'Otro nombre');
  assert.equal(buscarJugadorPorId(nuevaConexion.id), null, 'no se crea otra fila para el mismo navegador');

  await desconectar(ganador.socket);
  const otraConexion = await conectar(t);
  assert.equal((await sentar(otraConexion, 'entrar_sala', { ...ganador.datos, codigo: regreso.codigo })).saldo, 2000);
  await pedir(nuevaConexion, 'comenzar');
  await pedir(otraConexion, 'apostar', { monto: 100, opcion: 'cara' });
  const segunda = await pedir(nuevaConexion, 'lanzar');
  assert.equal(buscarJugadorPorId(ganador.id).saldo, segunda.resultado.lado === 'cara' ? 2100 : 1900);
  assert.equal(historialDeJugador(ganador.id).length, 2, 'el historial sigue asociado al perfil original');
});

for (const [juego, accion] of [['blackjack', 'stand'], ['poker', 'check']]) {
  test(`guarda el saldo al cerrar una mano de ${juego}`, async (t) => {
    const [anfitrion, invitado] = await Promise.all([conectar(t), conectar(t)]);
    const { codigo } = await sentar(anfitrion, 'crear_sala', { ...perfil('Ana'), juego });
    await sentar(invitado, 'entrar_sala', { ...perfil('Bruno'), codigo });
    const fechaAnterior = '2000-01-01 00:00:00';
    db.prepare('UPDATE jugadores SET ultima_actividad = ? WHERE id = ?').run(fechaAnterior, anfitrion.id);

    await pedir(anfitrion, 'comenzar');
    const apuesta = await pedir(anfitrion, 'apostar', { monto: 100, opcion: 'mano' });
    assert.equal(apuesta.saldo, 900);
    await pedir(anfitrion, 'repartir');
    assert.equal(buscarJugadorPorId(anfitrion.id).ultimaActividad, fechaAnterior);

    const cierre = await pedir(anfitrion, `accion_${juego}`, { accion });
    const guardado = buscarJugadorPorId(anfitrion.id);
    if (juego === 'blackjack') {
      // La casa ya juega y paga: con 100 apostadas el saldo depende del desenlace.
      assert.ok([900, 1000, 1100, 1150].includes(cierre.saldo), `saldo inesperado: ${cierre.saldo}`);
      const historial = historialDeJugador(anfitrion.id);
      assert.equal(historial.length, 1, 'la mano liquidada deja su fila en el historial');
      assert.equal(historial[0].pago, cierre.saldo - 900);
    } else {
      assert.equal(cierre.saldo, 1000, 'el motor provisional devuelve lo apostado');
    }
    assert.equal(guardado.saldo, cierre.saldo);
    assert.notEqual(guardado.ultimaActividad, fechaAnterior, 'SQLite se actualiza al llegar a resultados');
  });
}

test('al cambiar de mesa durante una mano, la apuesta abandonada no se reembolsa al volver', async (t) => {
  const [ana, bruno] = await Promise.all([conectar(t), conectar(t)]);
  const datosAna = perfil('Ana');
  const { codigo } = await sentar(ana, 'crear_sala', { ...datosAna, juego: 'blackjack' });
  await sentar(bruno, 'entrar_sala', { ...perfil('Bruno'), codigo });
  await pedir(ana, 'comenzar');
  await pedir(ana, 'apostar', { monto: 100, opcion: 'mano' });
  await pedir(bruno, 'apostar', { monto: 50, opcion: 'mano' });
  await pedir(ana, 'repartir');

  const cambio = await sentar(ana, 'crear_sala', { ...datosAna, juego: 'coinflip' });
  assert.equal(cambio.saldo, 900);
  assert.equal(buscarJugadorPorId(ana.id).saldo, 900);
  assert.equal((await sentar(ana, 'entrar_sala', { ...datosAna, codigo })).saldo, 900);
  await pedir(bruno, 'accion_blackjack', { accion: 'stand' });
  assert.equal(buscarJugadorPorId(ana.id).saldo, 900, 'la abandonada no cobra ni recupera nada');
  // Bruno jugó contra la casa con 50 apostadas: gana, empata o pierde según la mano.
  const saldoBruno = buscarJugadorPorId(bruno.id).saldo;
  assert.ok([950, 1000, 1050, 1075].includes(saldoBruno), `saldo inesperado de Bruno: ${saldoBruno}`);

  // También se pierde la apuesta si el abandono provoca el fin de la mano.
  await pedir(bruno, 'nueva_ronda');
  await pedir(ana, 'apostar', { monto: 100, opcion: 'mano' });
  await pedir(bruno, 'repartir');
  await pedir(ana, 'salir_sala');
  assert.equal(buscarJugadorPorId(ana.id).saldo, 800);
});
