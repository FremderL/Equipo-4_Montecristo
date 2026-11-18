// Evidencia Ticket 2 · crear un jugador, buscarlo por id y actualizar su
// nombre, avatar y saldo usando SOLO lib/jugadores.js.
// Uso: DB_FILE=/tmp/evidencia-ticket-2.db node evidencias/scripts/ticket-2-jugadores.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DB_FILE = process.env.DB_FILE || path.join(os.tmpdir(), 'evidencia-ticket-2.db');

const jugadores = require('../../lib/jugadores.js');

const mostrar = (titulo, valor) => console.log(`${titulo}\n${JSON.stringify(valor, null, 2)}\n`);

console.log(`Base de datos de la evidencia: ${process.env.DB_FILE}\n`);

// 1 · Crear un jugador (sin consultas sueltas: una sola función).
const ana = jugadores.crearJugador({ id: 'j_ana', nombre: 'Ana' });
mostrar('1) crearJugador({ id: "j_ana", nombre: "Ana" }) →', ana);

// 2 · Buscarlo por id.
mostrar('2) buscarJugadorPorId("j_ana") →', jugadores.buscarJugadorPorId('j_ana'));
mostrar('   buscarJugadorPorId("j_nadie") →', jugadores.buscarJugadorPorId('j_nadie'));

// 3 · Actualizar nombre, avatar y saldo.
mostrar('3) actualizarJugador("j_ana", { nombre, avatar, saldo }) →',
  jugadores.actualizarJugador('j_ana', { nombre: 'Ana María', avatar: '🦊', saldo: 640 }));

// 4 · Atajos de un solo campo y ajuste atómico de fichas.
mostrar('4) actualizarNombreJugador / actualizarAvatarJugador / actualizarSaldoJugador →', [
  jugadores.actualizarNombreJugador('j_ana', 'Ana').nombre,
  jugadores.actualizarAvatarJugador('j_ana', '🐯').avatar,
  jugadores.actualizarSaldoJugador('j_ana', 1000).saldo
]);

console.log('5) ajustarSaldoJugador("j_ana", -250) →', jugadores.ajustarSaldoJugador('j_ana', -250).saldo, 'fichas');
try {
  jugadores.ajustarSaldoJugador('j_ana', -100000);
} catch (fallo) {
  console.log(`   ajustarSaldoJugador("j_ana", -100000) → ❌ ${fallo.codigo}: ${fallo.message}`);
}
console.log(`   saldo final: ${jugadores.buscarJugadorPorId('j_ana').saldo} fichas\n`);

// 6 · Quién usa estas funciones: fichas, servidor y el resto del proyecto.
const fichas = require('../../lib/fichas.js');
const db = require('../../lib/db.js');
db.prepare("INSERT INTO salas (id, codigo, juego, anfitrion_id) VALUES ('s1', 'K7Q2M', 'coinflip', 'j_ana')").run();
db.prepare("INSERT INTO partidas (id, sala_id, numero_ronda, juego, fase) VALUES ('p1', 's1', 1, 'coinflip', 'apuestas')").run();

const apuesta = fichas.apostar({ jugadorId: 'j_ana', partidaId: 'p1', monto: 200, opcion: 'cara' });
console.log(`6) fichas.apostar(...) descuenta 200 → saldo ${apuesta.saldo} (lo aplica jugadores.ajustarSaldoJugador)`);
fichas.acreditar({ apuestaId: apuesta.apuestaId, multiplicador: 2, resultado: 'gana' });
console.log(`   fichas.acreditar(... ×2) → saldo ${jugadores.buscarJugadorPorId('j_ana').saldo}\n`);

// 7 · Auditoría: ningún otro archivo escribe SQL sobre `jugadores`.
const raiz = path.join(__dirname, '..', '..');
const archivos = ['server.js', 'lib/fichas.js', 'lib/historial.js', 'lib/db.js', 'db/migrar.js'];
const sqlSuelto = /\b(FROM|INTO|UPDATE|JOIN)\s+jugadores\b/i;
console.log('7) ¿Quedan consultas sueltas a la tabla jugadores?');
for (const archivo of archivos) {
  const codigo = fs.readFileSync(path.join(raiz, archivo), 'utf8');
  console.log(`   ${sqlSuelto.test(codigo) ? '❌' : '✅'} ${archivo}`);
}

db.close();
