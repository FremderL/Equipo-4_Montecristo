// Aplica db/schema.sql sobre la base de datos y avisa por consola.
// Idempotente: puede ejecutarse mil veces sin romper nada.
// Uso: npm run db:migrar
const fs = require('fs');
const path = require('path');
const db = require('../lib/db.js');

const TABLAS = ['jugadores', 'salas', 'partidas', 'apuestas'];

function tablasExistentes() {
  const marcadores = TABLAS.map(() => '?').join(', ');
  const filas = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${marcadores})`)
    .all(...TABLAS);
  return new Set(filas.map((fila) => fila.name));
}

const antes = tablasExistentes();
const esquema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(esquema);
const despues = tablasExistentes();

let faltantes = 0;
for (const tabla of TABLAS) {
  if (!antes.has(tabla) && despues.has(tabla)) {
    console.log(`✅ Tabla creada: ${tabla}`);
  } else if (antes.has(tabla)) {
    console.log(`↪️  Tabla ya existía: ${tabla}`);
  } else {
    faltantes += 1;
    console.error(`❌ Falta la tabla: ${tabla}`);
  }
}

if (faltantes > 0) {
  process.exit(1);
}
console.log('🎉 Migración completada: esquema de db/schema.sql aplicado sin errores.');
