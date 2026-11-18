// Evidencia Ticket 4 · una ronda de verdad contra el servidor que arranca con
// `npm start`: se apuesta, se lanza y la fila queda en `historial_rondas`.
// Después se lee el historial y las estadísticas con lib/historial.js.
// Uso: node evidencias/scripts/ticket-4-ronda.js [http://localhost:3000]
'use strict';

const { io: clienteIo } = require('socket.io-client');
const { historialDeSala, historialDeJugador, estadisticasDeJugador } = require('../../lib/historial.js');

const ORIGEN = process.argv[2] || 'http://localhost:3000';

const emitir = (socket, evento, datos) =>
  new Promise((resolve) => (datos === undefined ? socket.emit(evento, resolve) : socket.emit(evento, datos, resolve)));

const conectar = () =>
  new Promise((resolve, reject) => {
    const socket = clienteIo(ORIGEN, { forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

(async () => {
  const anfitrion = await conectar();
  const invitado = await conectar();

  const { codigo } = await emitir(anfitrion, 'crear_sala', { juego: 'coinflip', nombre: 'Ana', avatar: '🙂' });
  console.log(`Sala creada: ${codigo}`);

  console.log('  invitado entra →', JSON.stringify(await emitir(invitado, 'entrar_sala', { codigo, nombre: 'Bruno', avatar: '🐯' })));
  console.log('  comenzar      →', JSON.stringify(await emitir(anfitrion, 'comenzar')));
  console.log('  Ana apuesta 100 a cara →', JSON.stringify(await emitir(anfitrion, 'apostar', { monto: 100, opcion: 'cara' })));
  console.log('  Bruno apuesta 50 a cruz →', JSON.stringify(await emitir(invitado, 'apostar', { monto: 50, opcion: 'cruz' })));

  const resultado = await emitir(anfitrion, 'lanzar');
  console.log(`  lanzar        → ronda ${resultado.numeroRonda}, la moneda salió ${resultado.resultado.lado}\n`);

  const filas = historialDeSala(codigo);
  console.log(`historial_rondas · filas de la sala ${codigo}:`);
  console.table(
    filas.map((fila) => ({
      sala_codigo: fila.salaCodigo,
      juego: fila.juego,
      numero_ronda: fila.numeroRonda,
      jugador_id: fila.jugadorId,
      jugador_nombre: fila.jugadorNombre,
      apuesta: fila.apuesta,
      opcion: fila.opcion,
      resultado: fila.resultado,
      pago: fila.pago,
      fecha: fila.fecha
    }))
  );

  const ana = historialDeJugador(filas[0].jugadorId, { limite: 5 });
  console.log(`historialDeJugador("${filas[0].jugadorId}") → ${ana.length} ronda(s)`);
  console.log('estadisticasDeJugador →', JSON.stringify(estadisticasDeJugador(filas[0].jugadorId), null, 2));

  anfitrion.disconnect();
  invitado.disconnect();
})().catch((fallo) => {
  console.error('❌', fallo.message);
  process.exit(1);
});
