'use strict';

// Operaciones básicas sobre la tabla `jugadores` (db/schema.sql · DOC-03 §2).
// Todo el código que necesite crear un jugador, buscarlo por id o actualizar su
// nombre, avatar o saldo debe pasar por estas funciones y no por consultas sueltas.

const { randomUUID } = require('node:crypto');
const { REGLAS } = require('./reglas.js');
const { asegurarEsquema } = require('./esquema.js');

const TABLA = 'jugadores';
const AVATAR_POR_DEFECTO = '🙂';
const MAX_LARGO_ID = 64;
const MAX_LARGO_NOMBRE = 24;
const MAX_LARGO_AVATAR = 8;
const PATRON_ID_DISPOSITIVO = /^[A-Za-z0-9_-]{1,64}$/;

let dbConfigurada;

function errorJugador(codigo, mensaje, Clase = Error) {
  const fallo = new Clase(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

function obtenerDb() {
  let db = dbConfigurada;
  if (!db) {
    const modulo = require('./db.js');
    db = modulo.db || modulo.default || modulo;
  }
  return asegurarEsquema(db);
}

function configurarDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('Se requiere una instancia better-sqlite3.');
  }
  dbConfigurada = db;
}

// ---------------------------------------------------------------------------
// Validación de campos
// ---------------------------------------------------------------------------

function validarIdJugador(id) {
  if (typeof id !== 'string') {
    throw errorJugador('ID_INVALIDO', 'El identificador del jugador debe ser un texto no vacío.', TypeError);
  }
  const limpio = id.trim();
  if (limpio.length === 0 || limpio.length > MAX_LARGO_ID) {
    throw errorJugador('ID_INVALIDO', `El identificador del jugador debe tener entre 1 y ${MAX_LARGO_ID} caracteres.`, TypeError);
  }
  return limpio;
}

function validarIdDispositivo(id) {
  const limpio = typeof id === 'string' ? id.trim() : '';
  if (!PATRON_ID_DISPOSITIVO.test(limpio)) {
    throw errorJugador('DISPOSITIVO_INVALIDO', 'El identificador del navegador no es válido.', TypeError);
  }
  return limpio;
}

function validarNombre(nombre) {
  if (typeof nombre !== 'string') {
    throw errorJugador('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');
  }
  const limpio = nombre.trim();
  if (limpio.length === 0) {
    throw errorJugador('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');
  }
  if (limpio.length > MAX_LARGO_NOMBRE) {
    throw errorJugador('NOMBRE_INVALIDO', `El nombre puede tener como máximo ${MAX_LARGO_NOMBRE} caracteres.`);
  }
  return limpio;
}

function validarAvatar(avatar) {
  if (typeof avatar !== 'string' || avatar.trim().length === 0) {
    throw errorJugador('AVATAR_INVALIDO', 'Selecciona un avatar antes de continuar.');
  }
  return avatar.trim().slice(0, MAX_LARGO_AVATAR);
}

function validarSaldo(saldo) {
  if (!Number.isInteger(saldo) || saldo < 0) {
    throw errorJugador('SALDO_INVALIDO', 'El saldo debe ser un entero mayor o igual a 0.', TypeError);
  }
  return saldo;
}

function extraerSaldo(datos) {
  if (!datos || typeof datos !== 'object') return undefined;
  if (datos.saldo !== undefined) return datos.saldo;
  if (datos.saldoFichas !== undefined) return datos.saldoFichas;
  if (datos.fichas !== undefined) return datos.fichas;
  return undefined;
}

function aJugador(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    nombre: fila.nombre,
    avatar: fila.avatar,
    saldo: fila.saldo_fichas,
    saldoFichas: fila.saldo_fichas,
    fichas: fila.saldo_fichas,
    salaId: fila.sala_id ?? null,
    asiento: fila.asiento ?? null,
    esAnfitrion: Boolean(fila.es_anfitrion),
    conectado: Boolean(fila.conectado),
    deviceId: fila.device_id ?? null,
    creadoEn: fila.creado_en,
    ultimaActividad: fila.ultima_actividad
  };
}

// ---------------------------------------------------------------------------
// Consultas encapsuladas
// ---------------------------------------------------------------------------

const SQL_INSERTAR = `
  INSERT INTO ${TABLA} (id, nombre, avatar, saldo_fichas, conectado, device_id)
  VALUES (@id, @nombre, @avatar, @saldoFichas, @conectado, @deviceId)
`;

const SQL_BUSCAR_POR_ID = `
  SELECT * FROM ${TABLA} WHERE id = ?
`;

const SQL_BUSCAR_POR_DISPOSITIVO = `
  SELECT * FROM ${TABLA} WHERE device_id = ?
`;

const SQL_AJUSTAR_SALDO = `
  UPDATE ${TABLA}
  SET saldo_fichas = saldo_fichas + @delta,
      ultima_actividad = datetime('now')
  WHERE id = @id AND saldo_fichas + @delta >= 0
`;

/**
 * Crea un jugador en la base de datos y devuelve su representación normalizada.
 */
function crearJugador(datos = {}) {
  if (!datos || typeof datos !== 'object') {
    throw errorJugador('DATOS_INVALIDOS', 'Faltan los datos para crear el jugador.', TypeError);
  }

  const db = obtenerDb();
  const id = datos.id === undefined || datos.id === null ? randomUUID() : validarIdJugador(datos.id);
  const nombre = validarNombre(datos.nombre);
  const avatar = datos.avatar === undefined ? AVATAR_POR_DEFECTO : validarAvatar(datos.avatar);
  const saldoRecibido = extraerSaldo(datos);
  const saldoFichas = saldoRecibido === undefined ? REGLAS.SALDO_INICIAL : validarSaldo(saldoRecibido);
  const conectado = datos.conectado === undefined ? 1 : (datos.conectado ? 1 : 0);
  const deviceId = datos.deviceId == null ? null : validarIdDispositivo(datos.deviceId);

  return db.transaction(() => {
    try {
      db.prepare(SQL_INSERTAR).run({
        id,
        nombre,
        avatar,
        saldoFichas,
        conectado,
        deviceId
      });
    } catch (error) {
      if (error && error.code && String(error.code).startsWith('SQLITE_CONSTRAINT')) {
        throw errorJugador('JUGADOR_DUPLICADO', `Ya existe un jugador registrado con ese identificador (${id}).`);
      }
      throw error;
    }
    return aJugador(db.prepare(SQL_BUSCAR_POR_ID).get(id));
  })();
}

/**
 * Busca un jugador por su identificador único. Devuelve `null` si no existe
 * (o si el identificador recibido no puede ser uno válido).
 */
function buscarJugadorPorId(id) {
  if (typeof id !== 'string') return null;
  const idLimpio = id.trim();
  if (idLimpio.length === 0 || idLimpio.length > MAX_LARGO_ID) return null;

  const db = obtenerDb();
  const fila = db.prepare(SQL_BUSCAR_POR_ID).get(idLimpio);
  return aJugador(fila);
}

/** Recupera el perfil anónimo por el identificador que conserva su navegador. */
function buscarJugadorPorDispositivo(id) {
  const idLimpio = validarIdDispositivo(id);
  const db = obtenerDb();
  return aJugador(db.prepare(SQL_BUSCAR_POR_DISPOSITIVO).get(idLimpio));
}

/**
 * Actualiza el nombre, avatar, saldo y/o estado de conexión de un jugador existente.
 */
function actualizarJugador(id, cambios = {}) {
  const idLimpio = validarIdJugador(id);
  if (!cambios || typeof cambios !== 'object') {
    throw errorJugador('DATOS_INVALIDOS', 'Debes indicar los campos del jugador que deseas actualizar.', TypeError);
  }

  const asignaciones = [];
  const parametros = { id: idLimpio };

  if (cambios.nombre !== undefined) {
    parametros.nombre = validarNombre(cambios.nombre);
    asignaciones.push('nombre = @nombre');
  }

  if (cambios.avatar !== undefined) {
    parametros.avatar = validarAvatar(cambios.avatar);
    asignaciones.push('avatar = @avatar');
  }

  const saldoNuevo = extraerSaldo(cambios);
  if (saldoNuevo !== undefined) {
    parametros.saldoFichas = validarSaldo(saldoNuevo);
    asignaciones.push('saldo_fichas = @saldoFichas');
  }

  if (cambios.conectado !== undefined) {
    parametros.conectado = cambios.conectado ? 1 : 0;
    asignaciones.push('conectado = @conectado');
  }

  if (asignaciones.length === 0) {
    throw errorJugador(
      'SIN_CAMBIOS',
      'Debes indicar al menos un campo para actualizar (nombre, avatar o saldo).',
      TypeError
    );
  }

  asignaciones.push("ultima_actividad = datetime('now')");
  const sql = `UPDATE ${TABLA} SET ${asignaciones.join(', ')} WHERE id = @id`;

  const db = obtenerDb();
  return db.transaction(() => {
    const resultado = db.prepare(sql).run(parametros);
    if (resultado.changes !== 1) {
      throw errorJugador('JUGADOR_NO_ENCONTRADO', 'Jugador no encontrado.');
    }
    return aJugador(db.prepare(SQL_BUSCAR_POR_ID).get(idLimpio));
  })();
}

function actualizarNombreJugador(id, nombre) {
  return actualizarJugador(id, { nombre });
}

function actualizarAvatarJugador(id, avatar) {
  return actualizarJugador(id, { avatar });
}

function actualizarSaldoJugador(id, saldo) {
  return actualizarJugador(id, { saldo });
}

/** Guarda los saldos finales de una ronda en una sola transacción. */
function actualizarSaldosJugadores(saldos) {
  const db = obtenerDb();
  db.transaction(() => {
    for (const { id, saldo } of saldos) actualizarSaldoJugador(id, saldo);
  })();
}

/**
 * Suma o descuenta fichas de forma atómica verificando que el jugador exista y
 * que su saldo nunca quede por debajo de cero.
 */
function ajustarSaldoJugador(id, delta) {
  const idLimpio = validarIdJugador(id);
  if (!Number.isInteger(delta)) {
    throw errorJugador('SALDO_INVALIDO', 'El ajuste de saldo debe ser un número entero.', TypeError);
  }

  const db = obtenerDb();
  return db.transaction(() => {
    const actual = db.prepare(SQL_BUSCAR_POR_ID).get(idLimpio);
    if (!actual) {
      throw errorJugador('JUGADOR_NO_ENCONTRADO', 'Jugador no encontrado.');
    }
    const resultado = db.prepare(SQL_AJUSTAR_SALDO).run({ id: idLimpio, delta });
    if (resultado.changes !== 1) {
      throw errorJugador('SALDO_INSUFICIENTE', 'Saldo insuficiente.');
    }
    return aJugador(db.prepare(SQL_BUSCAR_POR_ID).get(idLimpio));
  })();
}

module.exports = {
  TABLA,
  AVATAR_POR_DEFECTO,
  crearJugador,
  buscarJugadorPorId,
  buscarJugadorPorDispositivo,
  actualizarJugador,
  actualizarNombreJugador,
  actualizarAvatarJugador,
  actualizarSaldoJugador,
  actualizarSaldosJugadores,
  ajustarSaldoJugador,
  validarIdJugador,
  validarIdDispositivo,
  validarNombre,
  validarAvatar,
  validarSaldo,
  configurarDb
};
