'use strict';

const { randomUUID } = require('node:crypto');
const { APUESTA_MINIMA } = require('./reglas.js').REGLAS;
const { PAGOS } = require('./reglas.js');
const MENSAJE_APUESTA = 'Apuesta entre 10 y tus fichas disponibles.';
let dbConfigurada;

function validarApuesta(saldo, monto, yaAposto = false) {
  if (yaAposto) return { ok: false, error: MENSAJE_APUESTA };
  if (!Number.isInteger(saldo) || saldo < 0 || !Number.isInteger(monto) || monto < APUESTA_MINIMA || monto > saldo) return { ok: false, error: MENSAJE_APUESTA };
  return { ok: true };
}

function liquidar(monto, multiplicador) {
  if (!Number.isInteger(monto) || monto < 0 || !Number.isFinite(multiplicador) || multiplicador < 0) throw new TypeError('Monto o multiplicador inválido.');
  const pago = Math.floor(monto * multiplicador);
  return { pago, neto: pago - monto };
}

function costoSeguro(monto) {
  if (!Number.isInteger(monto) || monto < 0) throw new TypeError('El monto debe ser un entero no negativo.');
  return Math.ceil(monto / 2);
}

function obtenerDb() {
  if (dbConfigurada) return dbConfigurada;
  // La dependencia concreta pertenece a Backend 1; se carga solo cuando se invoca persistencia.
  const modulo = require('./db.js');
  return modulo.db || modulo.default || modulo;
}

function ejecutarTransaccion(db, funcion) {
  if (typeof db.transaction === 'function') return db.transaction(funcion)();
  throw new TypeError('lib/db.js debe exponer una instancia better-sqlite3 con transaction().');
}

function afirmarCambios(resultado, mensaje) {
  if (!resultado || resultado.changes !== 1) throw new Error(mensaje);
}

function apostar({ jugadorId, partidaId, monto, opcion }) {
  const db = obtenerDb();
  return ejecutarTransaccion(db, () => {
    const jugador = db.prepare('SELECT saldo_fichas FROM jugadores WHERE id = ?').get(jugadorId);
    if (!jugador) throw new Error('Jugador no encontrado.');
    const repetida = db.prepare('SELECT id FROM apuestas WHERE partida_id = ? AND jugador_id = ?').get(partidaId, jugadorId);
    const validacion = validarApuesta(jugador.saldo_fichas, monto, Boolean(repetida));
    if (!validacion.ok) throw new Error(validacion.error);
    if (typeof opcion !== 'string' || !opcion) throw new Error('Opción de apuesta inválida.');
    const partida = db.prepare('SELECT id FROM partidas WHERE id = ?').get(partidaId);
    if (!partida) throw new Error('Partida no encontrada.');
    const apuestaId = randomUUID();
    afirmarCambios(db.prepare('UPDATE jugadores SET saldo_fichas = saldo_fichas - ? WHERE id = ? AND saldo_fichas >= ?').run(monto, jugadorId, monto), 'Saldo insuficiente.');
    db.prepare('INSERT INTO apuestas (id, partida_id, jugador_id, monto, opcion, multiplicador, pago) VALUES (?, ?, ?, ?, ?, 0, 0)')
      .run(apuestaId, partidaId, jugadorId, monto, opcion);
    afirmarCambios(db.prepare('UPDATE partidas SET bote_total = bote_total + ? WHERE id = ?').run(monto, partidaId), 'No se pudo actualizar el bote.');
    return { apuestaId, jugadorId, partidaId, monto, opcion, saldo: jugador.saldo_fichas - monto };
  });
}

function acreditar({ apuestaId, multiplicador, resultado }) {
  const db = obtenerDb();
  if (!Number.isFinite(multiplicador) || multiplicador < 0) throw new TypeError('Multiplicador inválido.');
  return ejecutarTransaccion(db, () => {
    const apuesta = db.prepare('SELECT id, jugador_id, monto, resultado FROM apuestas WHERE id = ?').get(apuestaId);
    if (!apuesta) throw new Error('Apuesta no encontrada.');
    if (apuesta.resultado !== null && apuesta.resultado !== undefined) return { acreditada: false, pago: Number(db.prepare('SELECT pago FROM apuestas WHERE id = ?').get(apuestaId).pago) };
    const { pago, neto } = liquidar(apuesta.monto, multiplicador);
    const actualizacion = db.prepare('UPDATE apuestas SET multiplicador = ?, pago = ?, resultado = ? WHERE id = ? AND resultado IS NULL')
      .run(multiplicador, pago, resultado, apuestaId);
    if (actualizacion.changes !== 1) return { acreditada: false, pago: 0 };
    afirmarCambios(db.prepare('UPDATE jugadores SET saldo_fichas = saldo_fichas + ? WHERE id = ?').run(pago, apuesta.jugador_id), 'Jugador no encontrado al acreditar.');
    return { acreditada: true, pago, neto };
  });
}

function reembolsar(apuestaId) {
  const db = obtenerDb();
  return ejecutarTransaccion(db, () => {
    const apuesta = db.prepare('SELECT id, partida_id, jugador_id, monto, resultado FROM apuestas WHERE id = ?').get(apuestaId);
    if (!apuesta) throw new Error('Apuesta no encontrada.');
    if (apuesta.resultado !== null && apuesta.resultado !== undefined) return { reembolsada: false, monto: 0 };
    const borrado = db.prepare('DELETE FROM apuestas WHERE id = ? AND resultado IS NULL').run(apuestaId);
    if (borrado.changes !== 1) return { reembolsada: false, monto: 0 };
    afirmarCambios(db.prepare('UPDATE jugadores SET saldo_fichas = saldo_fichas + ? WHERE id = ?').run(apuesta.monto, apuesta.jugador_id), 'Jugador no encontrado al reembolsar.');
    afirmarCambios(db.prepare('UPDATE partidas SET bote_total = MAX(0, bote_total - ?) WHERE id = ?').run(apuesta.monto, apuesta.partida_id), 'Partida no encontrada al reembolsar.');
    return { reembolsada: true, monto: apuesta.monto };
  });
}

function obtenerMultiplicador(juego, tipoResultado) {
  if (!PAGOS[juego] || !Object.prototype.hasOwnProperty.call(PAGOS[juego], tipoResultado)) throw new Error(`Pago no definido para ${juego}.${tipoResultado}.`);
  return PAGOS[juego][tipoResultado];
}

function configurarDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('Se requiere una instancia better-sqlite3.');
  dbConfigurada = db;
}

module.exports = { validarApuesta, apostar, liquidar, acreditar, costoSeguro, reembolsar, obtenerMultiplicador, configurarDb, PAGOS };
