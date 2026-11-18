# Evidencia · Ticket 3 — npm, Express, puerto 3000 y carpeta `public`

## Mini comentario

El proyecto arranca con **`npm start`** (`node server.js`) en el **puerto 3000**
(`const PUERTO = Number(process.env.PORT) || 3000`) y **Express** entrega toda la carpeta `public/`:
HTML (`/`, `/perfil.html`), CSS (`/styles.css`), JavaScript del navegador (`/app.js`) e imágenes
(`/assets/*.jpg`). Además queda `/health` (`{ "ok": true }`) para comprobar que el servidor está
vivo, y `/socket.io/socket.io.js` para el cliente de Socket.IO. `server.js` exporta
`{ app, servidor, io, PUERTO, PUERTO_POR_DEFECTO, RUTA_PUBLIC, MENSAJE_BIENVENIDA }`, así que las
pruebas levantan el mismo servidor en un puerto libre sin tocar el 3000.

- Código: `package.json` (`start`, dependencia `express`) y `server.js` (`RUTA_PUBLIC`, `express.static`).
- Pruebas: `tests/servidor-express.test.js` (3 pruebas).

## Evidencia 1 · `npm start` levanta el servidor en el 3000

```
$ npm start

> montecristo@0.1.0 start
> node server.js

MonteCristo escuchando en http://localhost:3000
Fichas 100 % virtuales; no hay dinero real.
```

## Evidencia 2 · los archivos de `public/` se entregan por HTTP

```
$ for r in / /perfil.html /styles.css /app.js /assets/casino-hero.jpg /health /socket.io/socket.io.js; do
    curl -s -o /dev/null -w '%{http_code} · %{content_type} · %{size_download} bytes\n' "http://localhost:3000$r"
  done

/                            HTTP 200 · text/html; charset=UTF-8 · 8803 bytes
/perfil.html                 HTTP 200 · text/html; charset=UTF-8 · 8390 bytes
/styles.css                  HTTP 200 · text/css; charset=UTF-8 · 22592 bytes
/app.js                      HTTP 200 · application/javascript; charset=UTF-8 · 19725 bytes
/assets/casino-hero.jpg      HTTP 200 · image/jpeg · 152104 bytes
/health                      HTTP 200 · application/json; charset=utf-8 · 11 bytes
/socket.io/socket.io.js      HTTP 200 · application/javascript; charset=utf-8 · 153519 bytes
```

## Evidencia 3 · pruebas automáticas

```
$ node --test tests/servidor-express.test.js

ok 1 - package.json define npm start hacia server.js, Express instalado y puerto 3000 por defecto
ok 2 - Express sirve HTML, CSS, JavaScript del navegador e imágenes desde public/
ok 3 - GET /health confirma que el servidor está activo y archivos inexistentes responden 404
# tests 3
# pass 3
# fail 0
```
