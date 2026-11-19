'use strict';

// Inicialización perezosa e idempotente del esquema SQLite (db/schema.sql).
// Se ejecuta como máximo una vez por instancia de base de datos cuando algún
// módulo de datos la necesita, sin alterar el comportamiento de `db/migrar.js`.

const fs = require('node:fs');
const path = require('node:path');

const RUTA_ESQUEMA = path.join(__dirname, '..', 'db', 'schema.sql');
const inicializadas = new WeakSet();
let sqlCache = null;

function leerEsquema() {
  if (sqlCache === null) {
    sqlCache = fs.readFileSync(RUTA_ESQUEMA, 'utf8');
  }
  return sqlCache;
}

function asegurarEsquema(db) {
  if (!db || typeof db.exec !== 'function') return db;
  if (!inicializadas.has(db)) {
    db.exec(leerEsquema());
    inicializadas.add(db);
  }
  return db;
}

module.exports = { asegurarEsquema };
