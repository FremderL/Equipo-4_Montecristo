# Evidencia · Ticket 2 — Funciones básicas de jugadores

## Mini comentario

Se creó **`lib/jugadores.js`**, la única puerta de entrada a la tabla `jugadores`:

| Función | Qué hace |
| --- | --- |
| `crearJugador({ id?, nombre, avatar?, saldo? })` | Inserta la fila (avatar `🙂` y 1.000 fichas por defecto) y devuelve el jugador. |
| `buscarJugadorPorId(id)` | Devuelve el jugador o `null`. |
| `actualizarJugador(id, { nombre?, avatar?, saldo? })` | Actualiza los campos indicados. |
| `actualizarNombreJugador` · `actualizarAvatarJugador` · `actualizarSaldoJugador` | Atajos de un campo. |
| `ajustarSaldoJugador(id, delta)` | Suma o resta fichas de forma atómica; el saldo nunca queda en negativo. |

**No quedan consultas sueltas.** `lib/fichas.js` ya no ejecuta `SELECT`/`UPDATE` sobre `jugadores`:
`apostar`, `acreditar` y `reembolsar` mueven las fichas con `ajustarSaldoJugador`. `server.js` crea
el jugador de la sala con `crearJugador`, lo busca con `buscarJugadorPorId` y, si vuelve con otro
nombre o avatar, lo actualiza con `actualizarJugador`. Una prueba automática
(`tests/jugadores.test.js` → *«ni server.js ni lib/fichas.js tienen consultas sueltas sobre
jugadores»*) falla si alguien vuelve a escribir SQL sobre esa tabla fuera del módulo.

- Código: `lib/jugadores.js`, `lib/esquema.js`, `lib/fichas.js`, `server.js`.
- Pruebas: `tests/jugadores.test.js` (11 pruebas).

## Evidencia 1 · crear, buscar y actualizar (ejecución real)

```
$ node evidencias/scripts/ticket-2-jugadores.js

Base de datos de la evidencia: /tmp/evidencia-ticket-2.db

✅ Base de datos conectada: /tmp/evidencia-ticket-2.db
1) crearJugador({ id: "j_ana", nombre: "Ana" }) →
{
  "id": "j_ana",
  "nombre": "Ana",
  "avatar": "🙂",
  "saldo": 1000,
  ...
}

2) buscarJugadorPorId("j_ana") →
{
  "id": "j_ana",
  "nombre": "Ana",
  "avatar": "🙂",
  "saldo": 1000,
  ...
}

   buscarJugadorPorId("j_nadie") →
null

3) actualizarJugador("j_ana", { nombre, avatar, saldo }) →
{
  "id": "j_ana",
  "nombre": "Ana María",
  "avatar": "🦊",
  "saldo": 640,
  ...
}

4) actualizarNombreJugador / actualizarAvatarJugador / actualizarSaldoJugador →
[
  "Ana",
  "🐯",
  1000
]

5) ajustarSaldoJugador("j_ana", -250) → 750 fichas
   ajustarSaldoJugador("j_ana", -100000) → ❌ SALDO_INSUFICIENTE: Saldo insuficiente.
   saldo final: 750 fichas

6) fichas.apostar(...) descuenta 200 → saldo 550 (lo aplica jugadores.ajustarSaldoJugador)
   fichas.acreditar(... ×2) → saldo 950

7) ¿Quedan consultas sueltas a la tabla jugadores?
   ✅ server.js
   ✅ lib/fichas.js
   ✅ lib/historial.js
   ✅ lib/db.js
   ✅ db/migrar.js
```

## Evidencia 2 · pruebas automáticas

```
$ node --test tests/jugadores.test.js

ok 1 - crearJugador guarda la fila y devuelve el jugador con saldo y avatar por defecto
ok 2 - crearJugador acepta id generado, avatar propio y saldo inicial explícito
ok 3 - crearJugador rechaza nombre vacío, nombre repetido en id y saldo inválido
ok 4 - buscarJugadorPorId devuelve el jugador guardado o null si no existe
ok 5 - actualizarJugador cambia el nombre, el avatar y el saldo a la vez
ok 6 - las funciones cortas actualizan un solo campo cada una
ok 7 - actualizarJugador valida los datos y avisa si el jugador no existe
ok 8 - ajustarSaldoJugador suma y resta sin dejar el saldo en negativo
ok 9 - ni server.js ni lib/fichas.js tienen consultas sueltas sobre jugadores
ok 10 - lib/fichas.js mueve las fichas con las funciones de jugadores
ok 11 - configurarDb conecta fichas y jugadores a la misma base de pruebas
# tests 11
# pass 11
# fail 0
```
