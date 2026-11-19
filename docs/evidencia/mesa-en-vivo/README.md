# Evidencia · Turnos, resultados, animación y chat

[**Informe con cinco capturas (PDF)**](MonteCristo-mesa-en-vivo.pdf) · [**Grabación de dos rondas (WebM)**](animacion-y-salto.webm) · [Mediciones y avisos recibidos (JSON)](mediciones.json) · [Salida de las pruebas](pruebas.txt)

Se usó el servidor del proyecto con clientes independientes de Chromium, sin sustituir el resultado, adelantar el reloj ni editar los saldos.

| Ticket | Verificación en la aplicación | Capturas |
| --- | --- | --- |
| Avisos del servidor | Inés se plantó y la mesa anunció **Turno de Diego**, turno 2 de 2, con su asiento resaltado. En la ronda de moneda salió **cruz**: de dos apuestas de 100, Diego recibió 200 (**+100 netas**) e Inés recibió 0 (**−100 netas**). Luz, que entró después, vio el mismo resultado y figuró **Sin apuesta**. | [Turno](01-turno.jpg) · [Balance](05-balance.jpg) |
| Animación breve y saltable | El efecto tiene **1,400 ms** programados. En la grabación, el control estuvo visible **1,541 ms** hasta el fin natural y **190 ms** en la ronda que se saltó. El saldo de Inés fue **910** antes y después de saltar. Se probaron tanto el botón como **Esc**, y la presentación sin movimiento. | [Revelación y botón](04-animacion.jpg) · [Video](animacion-y-salto.webm) |
| Chat de sala | Durante un turno de blackjack, Diego e Inés enviaron con **Enter**. Cada cliente mostró ambos mensajes una sola vez, con el nombre correcto. La sala de ruleta de Luz solo recibió su propio mensaje. El chat permaneció al abrir la ronda siguiente, pero no al desconectarse y volver a entrar. | [Conversación](02-chat.jpg) · [Otra sala](03-otra-sala.jpg) |

**Alcance:** las cifras proceden del servidor. En el cierre provisional de blackjack y póker se muestran las devoluciones reales; no se presentan como victorias de cartas. El chat no es un historial persistente.

## Pruebas ejecutadas

- `npm test`: **99 aprobadas**, 0 fallidas (incluye [integración por Socket.IO](../../../tests/salas.test.js)).
- `npm run test:e2e`: **13 aprobadas**, 0 fallidas, incluidas las cinco nuevas [pruebas de navegador](../../../e2e/partida.spec.js).

## Reproducción

Con Node.js 18 o superior, desde la raíz y con el puerto 3198 libre:

```sh
npm ci
npx playwright install chromium
npm test
npm run test:e2e
```

Para guardar capturas, el video y las mediciones de otra ejecución sin modificar esta entrega:

```sh
EVIDENCIA_DIR=test-results/mesa-en-vivo npm run test:e2e -- partida.spec.js
```

En PowerShell, establece antes `$env:EVIDENCIA_DIR='test-results/mesa-en-vivo'`. `CHROMIUM_PATH` es opcional para un Chromium ya instalado. Para grabar el video, Playwright también necesita su componente FFmpeg (incluido al instalar el navegador). Los códigos, resultados y tiempos medidos pueden variar.
