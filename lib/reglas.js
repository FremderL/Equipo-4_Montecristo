'use strict';

const REGLAS = Object.freeze({
  SALDO_INICIAL: 1000,
  APUESTA_MINIMA: 10,
  JUGADORES_POR_SALA: 6,
  LONGITUD_CODIGO_SALA: 5,
  TIEMPO_TURNO_BLACKJACK_MS: 25000,
  TIEMPO_TURNO_POKER_MS: 30000,
  CIEGA_PEQUENA: 10,
  CIEGA_GRANDE: 20,
  MAZOS_BLACKJACK: 4,
  MAZOS_POKER: 1,
  REBARAJAR_SI_QUEDAN_MENOS_DE: 52,
  PLANTARSE_CASA: 17,
  TIEMPO_HOST_INACTIVO_MS: 60000
});

const FASES = Object.freeze({
  ESPERA: 'espera',
  APUESTAS: 'apuestas',
  JUGANDO: 'jugando',
  RESULTADOS: 'resultados'
});

const PAGOS = Object.freeze({
  coinflip: Object.freeze({ acierto: 2, fallo: 0 }),
  dice: Object.freeze({ bajo: 2, alto: 2, exacto: 6, fallo: 0 }),
  roulette: Object.freeze({ pleno: 36, docena: 3, columna: 3, simple: 2, fallo: 0 }),
  blackjack: Object.freeze({ victoria: 2, natural: 2.5, empate: 1, derrota: 0, seguro: 3 })
});

module.exports = { REGLAS, FASES, PAGOS };
