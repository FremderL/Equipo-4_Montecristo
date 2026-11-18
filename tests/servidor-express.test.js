'use strict';

// Pruebas del Ticket 3:
// Proyecto iniciado con npm, Express instalado, arranque con `npm start`
// en el puerto 3000 por defecto y entrega estática de `public/`
// (HTML, CSS, imágenes y JavaScript del navegador).

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const archivoDb = path.join(os.tmpdir(), `montecristo-express-${process.pid}.db`);
process.env.DB_FILE = archivoDb;

const paquete = require('../package.json');
const { servidor, io, PUERTO, PUERTO_POR_DEFECTO, RUTA_PUBLIC } = require('../server.js');

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

test('package.json define npm start hacia server.js, Express instalado y puerto 3000 por defecto', () => {
  assert.equal(paquete.main, 'server.js');
  assert.equal(paquete.scripts.start, 'node server.js');
  assert.ok(paquete.dependencies && paquete.dependencies.express, 'express debe estar en dependencies');
  assert.equal(PUERTO_POR_DEFECTO, 3000);
  if (!process.env.PORT) {
    assert.equal(PUERTO, 3000);
  }
  assert.equal(RUTA_PUBLIC, path.join(__dirname, '..', 'public'));
});

test('Express sirve HTML, CSS, JavaScript del navegador e imágenes desde public/', async () => {
  // HTML principal (/) y pantalla de perfil (/perfil.html)
  const resInicio = await fetch(`${origen}/`);
  assert.equal(resInicio.status, 200);
  assert.match(resInicio.headers.get('content-type') || '', /text\/html/i);
  const htmlInicio = await resInicio.text();
  assert.match(htmlInicio, /MonteCristo/);

  const resPerfil = await fetch(`${origen}/perfil.html`);
  assert.equal(resPerfil.status, 200);
  assert.match(resPerfil.headers.get('content-type') || '', /text\/html/i);

  // Hoja de estilos CSS
  const resCss = await fetch(`${origen}/styles.css`);
  assert.equal(resCss.status, 200);
  assert.match(resCss.headers.get('content-type') || '', /text\/css/i);
  const css = await resCss.text();
  assert.ok(css.length > 100, 'styles.css no debe estar vacío');

  // JavaScript del navegador
  const resJs = await fetch(`${origen}/app.js`);
  assert.equal(resJs.status, 200);
  assert.match(resJs.headers.get('content-type') || '', /javascript/i);
  const js = await resJs.text();
  assert.match(js, /cargarSocketIO/);

  // Imágenes de la carpeta public/assets/
  const rutaImagen = path.join(RUTA_PUBLIC, 'assets', 'casino-hero.jpg');
  const bytesDisco = fs.readFileSync(rutaImagen);
  const resImg = await fetch(`${origen}/assets/casino-hero.jpg`);
  assert.equal(resImg.status, 200);
  assert.match(resImg.headers.get('content-type') || '', /image\/jpeg/i);
  const bytesHttp = Buffer.from(await resImg.arrayBuffer());
  assert.equal(bytesHttp.length, bytesDisco.length);
});

test('GET /health confirma que el servidor está activo y archivos inexistentes responden 404', async () => {
  const salud = await fetch(`${origen}/health`);
  assert.equal(salud.status, 200);
  assert.deepEqual(await salud.json(), { ok: true });

  const inexistente = await fetch(`${origen}/archivo-que-no-existe.html`);
  assert.equal(inexistente.status, 404);
});
