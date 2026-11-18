# Evidencia · Ticket 1 — Socket.IO y mensaje de bienvenida

## Mini comentario

Se instaló **Socket.IO** (`socket.io` en el servidor y `socket.io-client` para las pruebas) y la
conexión queda funcionando de punta a punta: al abrir la página, `public/app.js` carga
`/socket.io/socket.io.js`, abre el socket y **el servidor le manda el evento `bienvenida`** con
`{ mensaje, socketId, fecha }`. El servidor imprime ese mismo mensaje en su consola
(`[Socket.IO] Navegador conectado (<id>): …`) y el navegador lo imprime en la consola del navegador
(`[MonteCristo] …`). Cada pestaña recibe el suyo: no hay mensaje global ni estado compartido.

- Servidor: `server.js` → bloque `io.on('connection', …)`.
- Navegador: `public/app.js` → `socket.on('bienvenida', …)` con `console.log`.
- Contrato documentado en `docs/04-arquitectura.md` §3.3 (tabla de eventos del servidor).
- Pruebas: `tests/socket-bienvenida.test.js` (3 pruebas).

## Evidencia 1 · el servidor arranca y avisa por consola

```
$ npm start

> montecristo@0.1.0 start
> node server.js

MonteCristo escuchando en http://localhost:3000
Fichas 100 % virtuales; no hay dinero real.
```

## Evidencia 2 · dos navegadores se conectan y reciben la bienvenida

```
$ node evidencias/scripts/ticket-1-cliente.js

Conectando dos navegadores a http://localhost:3000 …

[Navegador 1] socket jpRkbChrWN6yZFuWAAAA
[Navegador 1] consola del navegador → [MonteCristo] ¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).
[Navegador 1] datos recibidos: {"mensaje":"¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).","socketId":"jpRkbChrWN6yZFuWAAAA","fecha":"2026-11-18T22:21:56.062Z"}
[Navegador 2] socket jpRkbChrWN6yZFuWAAAB
[Navegador 2] consola del navegador → [MonteCristo] ¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).
[Navegador 2] datos recibidos: {"mensaje":"¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).","socketId":"jpRkbChrWN6yZFuWAAAB","fecha":"2026-11-18T22:21:56.063Z"}

✅ Los dos recibieron la bienvenida (¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).)
```

## Evidencia 3 · la consola del servidor tras esas dos conexiones

```
MonteCristo escuchando en http://localhost:3000
Fichas 100 % virtuales; no hay dinero real.
[Socket.IO] Navegador conectado (jpRkbChrWN6yZFuWAAAA): ¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).
[Socket.IO] Navegador conectado (jpRkbChrWN6yZFuWAAAB): ¡Bienvenido a MonteCristo! Conexión en tiempo real lista (fichas 100 % virtuales).
```

## Evidencia 4 · pruebas automáticas

```
$ node --test tests/socket-bienvenida.test.js

ok 1 - Socket.IO está instalado y expone el script cliente /socket.io/socket.io.js
ok 2 - al conectarse un navegador, el servidor manda bienvenida y la imprime en consola
ok 3 - varios navegadores simultáneos reciben cada uno su propio mensaje de bienvenida y public/app.js lo registra en consola
# tests 3
# pass 3
# fail 0
```
