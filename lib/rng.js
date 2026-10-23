'use strict';

// Seguridad: ningún evento ni endpoint acepta que el cliente envíe, elija o adelante resultados;
// el cliente recibe el resultado ya decidido y únicamente lo anima. El servidor nunca transmite
// el mazo completo: cada jugador recibe solo sus cartas. La semilla debe persistirse en
// partidas.semilla_rng junto con la ronda para poder reproducirla en pruebas.
const { REGLAS } = require('./reglas.js');
const PALOS = ['♠', '♥', '♦', '♣'];
const RANGOS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ROJOS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function valorAleatorio(rng = Math.random) {
  const valor = Number(rng());
  if (!Number.isFinite(valor) || valor < 0 || valor >= 1) throw new RangeError('El RNG debe devolver un número entre 0 (incluido) y 1 (excluido).');
  return valor;
}

function lanzarMoneda(rng = Math.random) {
  return valorAleatorio(rng) < 0.5 ? 'cara' : 'cruz';
}

function lanzarDado(rng = Math.random) {
  return Math.floor(valorAleatorio(rng) * 6) + 1;
}

function girarRuleta(rng = Math.random) {
  const numero = Math.floor(valorAleatorio(rng) * 37);
  return { numero, color: numero === 0 ? 'verde' : ROJOS.has(numero) ? 'rojo' : 'negro' };
}

function crearRng(semilla) {
  let estado = typeof semilla === 'number' ? semilla >>> 0 : 2166136261;
  if (typeof semilla !== 'number') {
    for (const caracter of String(semilla)) estado = Math.imul(estado ^ caracter.charCodeAt(0), 16777619) >>> 0;
  }
  return function rngDeterminista() {
    estado = (estado + 0x6D2B79F5) >>> 0;
    let t = estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function barajar(mazo, rng = Math.random) {
  for (let i = mazo.length - 1; i > 0; i -= 1) {
    const j = Math.floor(valorAleatorio(rng) * (i + 1));
    [mazo[i], mazo[j]] = [mazo[j], mazo[i]];
  }
  return mazo;
}

function crearMazo(cuantasBarajas = REGLAS.MAZOS_POKER, rng = Math.random) {
  if (!Number.isInteger(cuantasBarajas) || cuantasBarajas < 1) throw new RangeError('La cantidad de barajas debe ser un entero positivo.');
  const mazo = [];
  for (let baraja = 0; baraja < cuantasBarajas; baraja += 1) {
    for (const palo of PALOS) for (const rango of RANGOS) mazo.push(`${rango}${palo}`);
  }
  return barajar(mazo, rng);
}

function sacarCarta(mazo) {
  if (!Array.isArray(mazo)) throw new TypeError('El mazo debe ser un arreglo.');
  return mazo.length ? mazo.pop() : null;
}

function necesitaRebarajar(mazo) {
  return !Array.isArray(mazo) || mazo.length < REGLAS.REBARAJAR_SI_QUEDAN_MENOS_DE;
}

function rebarajarSiNecesario(mazo, cuantasBarajas = REGLAS.MAZOS_POKER, rng = Math.random) {
  return necesitaRebarajar(mazo) ? crearMazo(cuantasBarajas, rng) : mazo;
}

module.exports = { lanzarMoneda, lanzarDado, girarRuleta, crearMazo, barajar, sacarCarta, crearRng, necesitaRebarajar, rebarajarSiNecesario, PALOS, RANGOS, ROJOS };
