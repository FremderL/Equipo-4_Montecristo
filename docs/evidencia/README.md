# Evidencia de entrega · Salas, mesa y apuestas

> **Siguiente entrega:** [avisos, animación y chat de sala (PDF y video)](mesa-en-vivo/README.md).

**18 de noviembre de 2026.** [Descargar el informe con las cinco capturas (PDF)](MonteCristo-evidencia.pdf) · [Salida completa de las pruebas](pruebas.txt).

Las capturas son del sitio servido por Express, con jugadores en contextos independientes de Chromium y el servidor Socket.IO del proyecto. Las salas, los asientos, los resultados y los saldos de estas imágenes no son datos de muestra.

| Ticket | Qué se comprobó | Evidencia |
| --- | --- | --- |
| Mostrar salas abiertas | Cara o Cruz con Valeria y **3/6**; Ruleta europea con Renata y **1/6**. El enlace **Entrar** de cada fila conduce al perfil de esa sala. Una mesa llena desaparece y vuelve al liberarse un lugar. | [01 · Directorio](01-directorio.jpg) |
| Pantalla de juego | Valeria, Mateo y Lucía ocupan tres asientos con sus avatares. Se distinguen los tres libres y el asiento propio; el centro muestra la fase y el lateral, las **1,000** fichas del jugador. | [02 · Mesa en espera](02-mesa-espera.jpg) |
| Elegir y confirmar | Con la ronda abierta, seleccionar **Cruz · 100** no cambia el saldo. Confirmar lo reduce a **900** y bloquea una segunda apuesta; el saldo de los demás no cambia por esa acción. | [03 · Antes](03-apuesta-abierta.jpg) / [04 · Después](04-apuesta-confirmada.jpg) |
| Bloqueos de la apuesta | No se puede apostar en espera, jugando o resultados, ni confirmar un monto vacío, fraccionario, menor de 10 o superior al saldo. En la ronda 02, **con las apuestas abiertas**, quien tiene **0** no puede usar los controles. | [02 · Fuera de fase](02-mesa-espera.jpg) / [05 · Sin saldo](05-saldo-insuficiente.jpg) |

**Cómo se obtuvo el saldo cero:** dos participantes apostaron sus 1,000 fichas a lados opuestos de la moneda. El servidor lanzó y liquidó la ronda; la captura 05 corresponde a quien perdió. No fue necesario fijar el resultado ni editar el saldo.

## Verificación

| Ejecución | Resultado |
| --- | --- |
| `npm test` · reglas e integración | **96 aprobadas**, 0 fallidas |
| `npm run test:e2e` · navegador | **8 aprobadas**, 0 fallidas |

Los [recorridos de navegador](../../e2e/mesa.spec.js) prueban las opciones de los cinco juegos, el descuento y los bloqueos, el directorio vacío o sin conexión, la rotación del anfitrión y el caso en que una sala desaparece entre **Entrar** y completar el perfil. Los [tests de sala](../../tests/salas.test.js) comprueban también los rechazos del servidor y que los asientos restantes no se renumeren.

## Reproducir

Desde la raíz, con el puerto 3198 libre (las pruebas arrancan y detienen su propio servidor):

```sh
npm ci
npx playwright install chromium
npm test
npm run test:e2e
```

Para capturas nuevas, define `EVIDENCIA_DIR` antes de `npm run test:e2e`, por ejemplo `EVIDENCIA_DIR=test-results/capturas npm run test:e2e` en Linux/macOS, o `$env:EVIDENCIA_DIR='test-results/capturas'` en PowerShell. Los códigos de sala y el resultado de cada ronda cambian en cada ejecución.

Entorno de esta entrega: Node.js 22.22.3, Playwright 1.58.2, Chromium 149, ventana de 1366 × 820 px. `CHROMIUM_PATH` permite usar un ejecutable de Chromium ya instalado en lugar del que descarga Playwright.
