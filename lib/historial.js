'use strict';

// Historial de rondas terminadas (tabla `historial_rondas` de db/schema.sql).
// Guarda una fila por jugador y ronda: sala, juego, jugador, apuesta, resultado
// y fecha. Es la fuente del historial y de las estadísticas, así que se puede
// consultar sin cruzar `partidas` ni `apuestas`.
//
// Uso típico, justo al liquidar la ronda y pasar la sala a la fase 'resultados':
//
//   const { registrarRondaTerminada } = require('./lib/historial.js');
//
//   registrarRondaTerminada({
//     salaCodigo: sala.codigo,
//     juego: sala.juego,
//     numeroRonda: sala.numero_ronda,
//     jugadores: apuestas.map((apuesta) => ({
//       jugadorId: apuesta.jugadorId,
//       nombre: sala.jugadores.get(apuesta.jugadorId).nombre,
//       apuesta: apuesta.monto,
//       opcion: apuesta.opcion,
//       resultado: apuesta.resultado,
//       pago: apuesta.pago
//     }))
//   });
//
// La llamada es idempotente: si la ronda ya estaba registrada para ese jugador,
// no se duplica la fila (y se avisa si los datos nuevos no coinciden).

const { randomUUID } = require('node:crypto');
const { REGLAS } = require('./reglas.js');

const TABLA = 'historial_rondas';
const JUEGOS = Object.freeze(['coinflip', 'dice', 'roulette', 'blackjack', 'poker']);
const RESULTADOS = Object.freeze(['gana', 'pierde', 'empate']);
const LARGO_CODIGO = REGLAS.LONGITUD_CODIGO_SALA;
const LARGO_NOMBRE = 24;
const LARGO_OPCION = 16;
const LARGO_FECHA = 32;

let dbConfigurada;

// La conexión compartida se carga solo cuando hace falta, igual que en fichas.js.
function obtenerDb() {
  if (dbConfigurada) return dbConfigurada;
  const modulo = require('./db.js');
  return modulo.db || modulo.default || modulo;
}

function configurarDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('Se requiere una instancia better-sqlite3.');
  }
  dbConfigurada = db;
}

// ---------------------------------------------------------------------------
// Validación de los datos que llegan del servidor
// ---------------------------------------------------------------------------

function exigirTexto(valor, campo, maximo) {
  if (typeof valor !== 'string' || valor.trim().length === 0) {
    throw new TypeError(`${campo} debe ser un texto no vacío.`);
  }
  const limpio = valor.trim();
  if (limpio.length > maximo) throw new TypeError(`${campo} no puede superar ${maximo} caracteres.`);
  return limpio;
}

function exigirEntero(valor, campo, minimo) {
  if (!Number.isInteger(valor) || valor < minimo) {
    throw new TypeError(`${campo} debe ser un entero mayor o igual a ${minimo}.`);
  }
  return valor;
}

function validarCabecera(datos) {
  if (!datos || typeof datos !== 'object') throw new TypeError('Faltan los datos de la ronda terminada.');

  const codigo = exigirTexto(datos.salaCodigo, 'salaCodigo', LARGO_CODIGO).toUpperCase();
  if (!new RegExp(`^[A-Z0-9]{${LARGO_CODIGO}}$`).test(codigo)) {
    throw new TypeError(`salaCodigo debe tener ${LARGO_CODIGO} letras o números.`);
  }
  if (!JUEGOS.includes(datos.juego)) throw new TypeError(`juego inválido: ${datos.juego}.`);

  return {
    salaCodigo: codigo,
    juego: datos.juego,
    numeroRonda: exigirEntero(datos.numeroRonda, 'numeroRonda', 1)
  };
}

function normalizarFila(jugador, cabecera) {
  if (!jugador || typeof jugador !== 'object') throw new TypeError('Cada jugador de la ronda debe ser un objeto.');

  const resultado = jugador.resultado;
  if (!RESULTADOS.includes(resultado)) throw new TypeError(`resultado inválido: ${resultado}.`);

  return {
    id: randomUUID(),
    salaCodigo: cabecera.salaCodigo,
    juego: cabecera.juego,
    numeroRonda: cabecera.numeroRonda,
    jugadorId: exigirTexto(jugador.jugadorId, 'jugadorId', 64),
    jugadorNombre: exigirTexto(jugador.nombre, 'nombre', LARGO_NOMBRE),
    apuesta: exigirEntero(jugador.apuesta, 'apuesta', REGLAS.APUESTA_MINIMA),
    opcion: exigirTexto(jugador.opcion, 'opcion', LARGO_OPCION),
    resultado,
    pago: jugador.pago === undefined || jugador.pago === null ? 0 : exigirEntero(jugador.pago, 'pago', 0),
    // null = la fecha la pone SQLite con datetime('now').
    fecha: jugador.fecha === undefined || jugador.fecha === null ? null : exigirTexto(jugador.fecha, 'fecha', LARGO_FECHA)
  };
}

// ---------------------------------------------------------------------------
// Acceso a la base de datos
// ---------------------------------------------------------------------------

const SQL_INSERTAR = `
  INSERT INTO ${TABLA}
    (id, sala_codigo, juego, numero_ronda, jugador_id, jugador_nombre, apuesta, opcion, resultado, pago, fecha)
  VALUES
    (@id, @salaCodigo, @juego, @numeroRonda, @jugadorId, @jugadorNombre, @apuesta, @opcion, @resultado, @pago, COALESCE(@fecha, datetime('now')))
  ON CONFLICT (sala_codigo, numero_ronda, jugador_id) DO NOTHING
`;

const SQL_BUSCAR = `
  SELECT * FROM ${TABLA}
  WHERE sala_codigo = ? AND numero_ronda = ? AND jugador_id = ?
`;

function aObjeto(fila) {
  return {
    id: fila.id,
    salaCodigo: fila.sala_codigo,
    juego: fila.juego,
    numeroRonda: fila.numero_ronda,
    jugadorId: fila.jugador_id,
    jugadorNombre: fila.jugador_nombre,
    apuesta: fila.apuesta,
    opcion: fila.opcion,
    resultado: fila.resultado,
    pago: fila.pago,
    fecha: fila.fecha
  };
}

function mismoContenido(guardada, nueva) {
  return guardada.juego === nueva.juego
    && guardada.jugador_nombre === nueva.jugadorNombre
    && guardada.apuesta === nueva.apuesta
    && guardada.opcion === nueva.opcion
    && guardada.resultado === nueva.resultado
    && guardada.pago === nueva.pago;
}

/** Inserta una fila ya validada y devuelve { insertada, fila }. */
function insertar(db, fila) {
  const insercion = db.prepare(SQL_INSERTAR).run(fila);
  const guardada = db.prepare(SQL_BUSCAR).get(fila.salaCodigo, fila.numeroRonda, fila.jugadorId);

  if (!guardada) throw new Error(`No se pudo registrar la ronda ${fila.numeroRonda} de la sala ${fila.salaCodigo}.`);

  if (insercion.changes === 0) {
    // La ronda ya estaba registrada: solo es válido si los datos coinciden.
    if (!mismoContenido(guardada, fila)) {
      throw new Error(
        `La ronda ${fila.numeroRonda} de la sala ${fila.salaCodigo} ya está registrada para ${fila.jugadorNombre} con otros datos.`
      );
    }
    return { insertada: false, fila: aObjeto(guardada) };
  }

  return { insertada: true, fila: aObjeto(guardada) };
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Registra un jugador de una ronda terminada.
 * Devuelve { insertada: true|false, fila }.
 */
function registrarJugadorEnRonda(datos) {
  const db = obtenerDb();
  const cabecera = validarCabecera(datos);
  const fila = normalizarFila(datos, cabecera);
  return db.transaction(() => insertar(db, fila))();
}

/**
 * Registra de una sola vez todos los jugadores de una ronda terminada.
 * Todo o nada: si una fila falla, no se guarda ninguna.
 * Devuelve { insertadas, filas } (insertadas puede ser menor que filas.length
 * si la ronda ya estaba registrada).
 */
function registrarRondaTerminada(datos) {
  const db = obtenerDb();
  const cabecera = validarCabecera(datos);

  const jugadores = datos.jugadores;
  if (!Array.isArray(jugadores) || jugadores.length === 0) {
    throw new TypeError('jugadores debe ser una lista con al menos un jugador.');
  }
  if (jugadores.length > REGLAS.JUGADORES_POR_SALA) {
    throw new TypeError(`Una ronda no puede tener más de ${REGLAS.JUGADORES_POR_SALA} jugadores.`);
  }

  const filas = jugadores.map((jugador) => normalizarFila(jugador, cabecera));
  const vistos = new Set();
  for (const fila of filas) {
    if (vistos.has(fila.jugadorId)) throw new TypeError(`El jugador ${fila.jugadorId} está repetido en la ronda.`);
    vistos.add(fila.jugadorId);
  }

  const resultados = db.transaction(() => filas.map((fila) => insertar(db, fila)))();

  return {
    insertadas: resultados.filter((resultado) => resultado.insertada).length,
    filas: resultados.map((resultado) => resultado.fila)
  };
}

module.exports = {
  TABLA,
  JUEGOS,
  RESULTADOS,
  registrarRondaTerminada,
  registrarJugadorEnRonda,
  configurarDb
};
