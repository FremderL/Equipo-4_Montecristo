// Conexión compartida a SQLite (better-sqlite3, API síncrona).
// La conexión se abre UNA sola vez al cargar el módulo y se exporta así:
//   const db = require('./lib/db.js');
//   db.prepare('SELECT ...').get(...);
// Nada de abrir y cerrar por cada consulta.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Archivo de la base de datos: la variable de entorno DB_FILE o, por defecto,
// data/casino.db (relativa a la raíz del repo, no a la carpeta de trabajo).
const archivo = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'casino.db');

let db;
try {
  // La carpeta data/ se crea sola si no existe.
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  db = new Database(archivo);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log(`✅ Base de datos conectada: ${archivo}`);
} catch (error) {
  console.error(`❌ No se pudo conectar la base de datos: ${error.message}`);
  throw error;
}

module.exports = db;
