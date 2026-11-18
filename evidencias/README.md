# Evidencias por ticket

Cada ticket tiene su propio archivo con el mini comentario y las capturas de su funcionamiento:

| Ticket | Tema | Evidencia | Código | Pruebas |
| --- | --- | --- | --- | --- |
| 1 | Socket.IO y mensaje de bienvenida | [`ticket-1-socketio-bienvenida.md`](ticket-1-socketio-bienvenida.md) | `server.js`, `public/app.js` | `tests/socket-bienvenida.test.js` |
| 2 | Crear, buscar y actualizar jugadores | [`ticket-2-funciones-jugadores.md`](ticket-2-funciones-jugadores.md) | `lib/jugadores.js`, `lib/fichas.js`, `server.js` | `tests/jugadores.test.js` |
| 3 | `npm start` + Express sirviendo `public/` | [`ticket-3-express-public.md`](ticket-3-express-public.md) | `package.json`, `server.js` | `tests/servidor-express.test.js` |
| 4 | Tabla `historial_rondas` y la función que inserta | [`ticket-4-historial-rondas.md`](ticket-4-historial-rondas.md) | `db/schema.sql`, `lib/historial.js`, `server.js` | `tests/historial.test.js`, `tests/historial-servidor.test.js` |

Los guiones que producen las capturas están en `evidencias/scripts/` y se pueden repetir con el
servidor levantado (`npm start`):

```bash
node evidencias/scripts/ticket-1-cliente.js      # dos navegadores reciben `bienvenida`
node evidencias/scripts/ticket-2-jugadores.js    # crear · buscar · actualizar jugadores
node evidencias/scripts/ticket-4-ronda.js        # una ronda real y su fila en historial_rondas
```

Toda la batería del proyecto:

```bash
npm test   # 112 pruebas · 0 fallos
```
