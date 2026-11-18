'use strict';

// Pruebas del Ticket 1:
// Socket.IO instalado y conexión funcionando: cuando el navegador se conecta,
// el servidor envía un mensaje de bienvenida y se imprime en consola.

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: clienteIo } = require('socket.io-client');

const archivoDb = path.join(os.tmpdir(), `montecristo-socket-${process.pid}.db`);
process.env.DB_FILE = archivoDb;

const paquete = require('../package.json');
const { servidor, io, MENSAJE_BIENVENIDA } = require('../server.js');

const ESPERA_MS = 3000;
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

test('Socket.IO está instalado y expone el script cliente /socket.io/socket.io.js', async () => {
  assert.ok(paquete.dependencies && paquete.dependencies['socket.io'], 'socket.io debe figurar en dependencies');

  const respuesta = await fetch(`${origen}/socket.io/socket.io.js`);
  assert.equal(respuesta.status, 200);
  assert.match(respuesta.headers.get('content-type') || '', /javascript/i);
  const cuerpo = await respuesta.text();
  assert.ok(cuerpo.length > 1000, 'el cliente de Socket.IO debe entregarse completo');
});

test('al conectarse un navegador, el servidor manda bienvenida y la imprime en consola', async (t) => {
  const lineasConsola = [];
  const logOriginal = console.log;
  console.log = (...args) => {
    lineasConsola.push(args.join(' '));
    logOriginal(...args);
  };
  t.after(() => {
    console.log = logOriginal;
  });

  const cliente = clienteIo(origen, { autoConnect: false, reconnection: false, forceNew: true });
  t.after(() => cliente.disconnect());

  const promesaBienvenida = once(cliente, 'bienvenida', { signal: AbortSignal.timeout(ESPERA_MS) });
  cliente.connect();
  const [datos] = await promesaBienvenida;

  assert.equal(datos.mensaje, MENSAJE_BIENVENIDA);
  assert.equal(datos.socketId, cliente.id);
  assert.ok(!Number.isNaN(Date.parse(datos.fecha)), 'fecha debe ser ISO válida');

  assert.ok(
    lineasConsola.some((linea) => linea.includes(cliente.id) && linea.includes(MENSAJE_BIENVENIDA)),
    'el servidor debe imprimir el mensaje de bienvenida en consola al conectar'
  );
});

test('varios navegadores simultáneos reciben cada uno su propio mensaje de bienvenida y public/app.js lo registra en consola', async (t) => {
  const codigoCliente = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(codigoCliente, /socket\.on\(['"]bienvenida['"]/);
  assert.match(codigoCliente, /console\.log/);

  const clientes = [1, 2, 3].map(() =>
    clienteIo(origen, { autoConnect: false, reconnection: false, forceNew: true })
  );
  t.after(() => clientes.forEach((c) => c.disconnect()));

  const bienvenidas = await Promise.all(
    clientes.map((c) => {
      const espera = once(c, 'bienvenida', { signal: AbortSignal.timeout(ESPERA_MS) });
      c.connect();
      return espera.then(([d]) => ({ socketId: c.id, recibido: d }));
    })
  );

  for (const { socketId, recibido } of bienvenidas) {
    assert.equal(recibido.socketId, socketId);
    assert.equal(recibido.mensaje, MENSAJE_BIENVENIDA);
  }
});
