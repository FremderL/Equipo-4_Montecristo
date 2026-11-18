# Evidencia · Ticket 4 — Tabla `historial_rondas` y la función que inserta la fila

## Mini comentario

La tabla **`historial_rondas`** guarda **una fila por jugador y ronda terminada** con sala, juego,
jugador, apuesta, resultado y fecha; es append-only y **no tiene claves foráneas** para que el
historial sobreviva aunque la sala se cierre o el jugador se elimine. La crea `db/schema.sql`
(idempotente, `npm run db:migrar`) y la llena **`registrarRondaTerminada()`** de `lib/historial.js`,
que se llama desde `server.js` en cuanto la ronda pasa a `resultados` (`lanzar` en los juegos
rápidos y `cerrarMano` en blackjack/póker). Es idempotente: `UNIQUE` impide duplicar la ronda, y si
la base de datos falla la partida continúa (la ronda ya está pagada en memoria) avisando por consola.

Para el historial y las estadísticas se añadieron lecturas sin SQL suelto:
`historialDeJugador()`, `historialDeSala()` y `estadisticasDeJugador()` (rondas, ganadas, perdidas,
empatadas, apostado, cobrado, neto y desglose por juego).

- Código: `db/schema.sql`, `lib/historial.js`, `server.js` (`registrarHistorial`).
- Pruebas: `tests/historial.test.js` + `tests/historial-servidor.test.js` (2 de punta a punta).

## Evidencia 1 · una ronda real contra el servidor deja la fila en la tabla

```
$ node evidencias/scripts/ticket-4-ronda.js

Sala creada: 3YAX6
  invitado entra → {"ok":true,"codigo":"3YAX6"}
  comenzar      → {"ok":true,"fase":"apuestas","numeroRonda":1}
  Ana apuesta 100 a cara → {"ok":true,"saldo":900,"monto":100,"opcion":"cara"}
  Bruno apuesta 50 a cruz → {"ok":true,"saldo":950,"monto":50,"opcion":"cruz"}
  lanzar        → ronda 1, la moneda salió cara

✅ Base de datos conectada: data/casino.db
historial_rondas · filas de la sala 3YAX6:
┌─────────┬─────────────┬────────────┬──────────────┬────────────────────────┬────────────────┬─────────┬────────┬───────────┬──────┬───────────────────────┐
│ (index) │ sala_codigo │ juego      │ numero_ronda │ jugador_id             │ jugador_nombre │ apuesta │ opcion │ resultado │ pago │ fecha                 │
├─────────┼─────────────┼────────────┼──────────────┼────────────────────────┼────────────────┼─────────┼────────┼───────────┼──────┼───────────────────────┤
│ 0       │ '3YAX6'     │ 'coinflip' │ 1            │ 'bbJ8D_58-YA1n4pXAAAF' │ 'Bruno'        │ 50      │ 'cruz' │ 'pierde'  │ 0    │ '2026-11-18 22:21:58' │
│ 1       │ '3YAX6'     │ 'coinflip' │ 1            │ 'tfJcRZVfWMSVX_GbAAAE' │ 'Ana'          │ 100     │ 'cara' │ 'gana'    │ 200  │ '2026-11-18 22:21:58' │
└─────────┴─────────────┴────────────┴──────────────┴────────────────────────┴────────────────┴─────────┴────────┴───────────┴──────┴───────────────────────┘
historialDeJugador("bbJ8D_58-YA1n4pXAAAF") → 1 ronda(s)
estadisticasDeJugador → {
  "rondas": 1,
  "apostado": 50,
  "cobrado": 0,
  "ganadas": 0,
  "perdidas": 1,
  "empatadas": 0,
  "neto": -50,
  "porJuego": [
    {
      "juego": "coinflip",
      "rondas": 1,
      "apostado": 50,
      "cobrado": 0,
      "neto": -50
    }
  ]
}
```

## Evidencia 2 · la consola del servidor confirma la inserción

```
[Socket.IO] Navegador conectado (tfJcRZVfWMSVX_GbAAAE): ¡Bienvenido a MonteCristo! …
[Socket.IO] Navegador conectado (bbJ8D_58-YA1n4pXAAAF): ¡Bienvenido a MonteCristo! …
✅ Base de datos conectada: /home/user/Equipo-4_Montecristo/data/casino.db
🗂️  Historial: ronda 1 de la sala 3YAX6 guardada (2 fila(s)).
```

## Evidencia 3 · pruebas automáticas

```
$ node --test tests/historial.test.js tests/historial-servidor.test.js

ok …  la tabla historial_rondas existe con las columnas del historial
ok …  registra una fila por jugador con apuesta, resultado y fecha
ok …  la tabla responde el historial y las estadísticas de un jugador
ok 1 - al lanzar una ronda, historial_rondas guarda sala, juego, jugador, apuesta, resultado y fecha
ok 2 - el historial y las estadísticas se consultan sin cruzar partidas ni apuestas
# tests 13
# pass 13
# fail 0
```
