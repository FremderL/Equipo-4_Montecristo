'use strict';

const { randomInt } = require('node:crypto');
const { REGLAS } = require('./reglas.js');

const LONGITUD = REGLAS.LONGITUD_CODIGO_SALA;
const COMBINACIONES = 36 ** LONGITUD;
const MAX_INTENTOS = 100;
const FORMATO = new RegExp(`^[A-Za-z0-9]{${LONGITUD}}$`);

/** Devuelve un código libre en el mapa de salas activas. No lo reserva. */
function generarCodigoSala(salasActivas, enteroAleatorio = randomInt) {
  for (let intento = 0; intento < MAX_INTENTOS; intento += 1) {
    // Base 36: dígitos y letras. Conserva los ceros iniciales para tener siempre cinco caracteres.
    const codigo = enteroAleatorio(COMBINACIONES).toString(36).toUpperCase().padStart(LONGITUD, '0');
    if (!salasActivas.has(codigo)) return codigo;
  }

  const fallo = new Error('No se pudo generar un código de sala libre. Inténtalo de nuevo.');
  fallo.codigo = 'SIN_CODIGO';
  throw fallo;
}

/** Acepta minúsculas y espacios al pegar un código; null si el formato es inválido. */
function normalizarCodigoSala(valor) {
  if (typeof valor !== 'string') return null;
  const codigo = valor.trim();
  return FORMATO.test(codigo) ? codigo.toUpperCase() : null;
}

module.exports = { generarCodigoSala, normalizarCodigoSala };
