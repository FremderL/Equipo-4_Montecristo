'use strict';

const { REGLAS } = require('../reglas.js');
const { crearMazo, sacarCarta } = require('../rng.js');

/** Cuenta los ases como 1; a lo sumo uno puede subir a 11 sin pasarse de 21. */
function contarPuntos(cartas) {
  let total = 0;
  let hayAs = false;
  for (const carta of cartas) {
    const rango = carta.slice(0, -1); // «10♥» → «10»
    if (rango === 'A') {
      total += 1;
      hayAs = true;
    } else {
      total += ['J', 'Q', 'K'].includes(rango) ? 10 : Number(rango);
    }
  }
  return hayAs && total + 10 <= 21 ? total + 10 : total;
}

/** Estado privado de la ronda: ni el mazo ni el conjunto de manos se difunden. */
function repartirInicial(orden, rng) {
  if (!Array.isArray(orden) || orden.length < 1 || orden.length > REGLAS.JUGADORES_POR_SALA) {
    throw new RangeError(`Se requieren entre 1 y ${REGLAS.JUGADORES_POR_SALA} jugadores para repartir.`);
  }
  const manos = new Map(orden.map((id) => [id, []]));
  if (manos.size !== orden.length) throw new Error('Un jugador no puede ocupar dos asientos.');

  const mazo = crearMazo(REGLAS.MAZOS_BLACKJACK, rng);
  const casa = [];
  for (let vuelta = 0; vuelta < 2; vuelta += 1) {
    for (const mano of manos.values()) mano.push(sacarCarta(mazo));
    casa.push(sacarCarta(mazo));
  }
  return { mazo, manos, casa };
}

/** Hasta el cierre, ni la segunda carta ni sus puntos salen del servidor. */
function vistaDeCasa(casa, revelar = false) {
  if (revelar) return { cartas: [...casa], puntos: contarPuntos(casa) };
  const [visible] = casa;
  return { cartas: [visible, null], puntos: contarPuntos([visible]) };
}

module.exports = { contarPuntos, repartirInicial, vistaDeCasa };
