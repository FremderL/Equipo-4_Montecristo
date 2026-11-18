// Evidencia Ticket 1 · dos "navegadores" se conectan al servidor de verdad
// (el que arranca con `npm start` en el puerto 3000) y reciben `bienvenida`.
// Uso: node evidencias/scripts/ticket-1-cliente.js [http://localhost:3000]
'use strict';

const { io: clienteIo } = require('socket.io-client');

const ORIGEN = process.argv[2] || 'http://localhost:3000';

const conectar = (etiqueta) =>
  new Promise((resolve, reject) => {
    const cliente = clienteIo(ORIGEN, { forceNew: true, reconnection: false });
    const temporizador = setTimeout(() => reject(new Error(`${etiqueta}: no llegó la bienvenida`)), 5000);

    cliente.on('bienvenida', (datos) => {
      clearTimeout(temporizador);
      console.log(`[${etiqueta}] socket ${cliente.id}`);
      console.log(`[${etiqueta}] consola del navegador → [MonteCristo] ${datos.mensaje}`);
      console.log(`[${etiqueta}] datos recibidos: ${JSON.stringify(datos)}`);
      cliente.disconnect();
      resolve(datos);
    });
  });

(async () => {
  console.log(`Conectando dos navegadores a ${ORIGEN} …\n`);
  const [uno, dos] = await Promise.all([conectar('Navegador 1'), conectar('Navegador 2')]);
  console.log(`\n✅ Los dos recibieron la bienvenida (${uno.socketId ? '' : ''}${dos.socketId ? '' : ''}${uno.mensaje})`);
})().catch((fallo) => {
  console.error('❌', fallo.message);
  process.exit(1);
});
