'use strict';

const { FASES, REGLAS } = require('./reglas.js');

const TRANSICIONES = Object.freeze({
  [FASES.ESPERA]: [FASES.APUESTAS],
  [FASES.APUESTAS]: [FASES.JUGANDO],
  [FASES.JUGANDO]: [FASES.RESULTADOS],
  [FASES.RESULTADOS]: [FASES.APUESTAS]
});
const ACCIONES_POR_FASE = Object.freeze({
  [FASES.ESPERA]: ['comenzar', 'entrar', 'salir'],
  [FASES.APUESTAS]: ['apostar', 'lanzar', 'repartir', 'salir'],
  [FASES.JUGANDO]: ['accion', 'turno'],
  [FASES.RESULTADOS]: ['nueva_ronda', 'cerrar', 'expulsar']
});

function puedeTransicionar(desde, hasta) {
  return Boolean(TRANSICIONES[desde] && TRANSICIONES[desde].includes(hasta));
}

function minimoJugadores(juego) {
  return juego === 'poker' ? 2 : 1;
}

function esAnfitrion(sala, jugadorId) {
  return sala.anfitrionId === jugadorId || sala.anfitrion_id === jugadorId || sala.anfitrion === jugadorId;
}

function cantidadJugadores(sala) {
  if (Array.isArray(sala.jugadores)) return sala.jugadores.length;
  if (sala.jugadores instanceof Map) return sala.jugadores.size;
  return Number(sala.cantidadJugadores || 0);
}

function cambiarFase(sala, fase, motivo = {}) {
  if (!sala || !Object.values(FASES).includes(sala.fase)) throw new Error('Fase actual inválida.');
  if (!Object.values(FASES).includes(fase) || !puedeTransicionar(sala.fase, fase)) {
    throw new Error(`Transición de fase inválida: ${sala && sala.fase} → ${fase}.`);
  }
  const opciones = typeof motivo === 'string' ? { accion: motivo } : motivo;
  if (sala.fase === FASES.ESPERA && fase === FASES.APUESTAS) {
    const minimo = minimoJugadores(sala.juego);
    if (opciones.accion === 'automatico' && cantidadJugadores(sala) < minimo) {
      throw new Error(`Se requieren al menos ${minimo} jugadores para comenzar.`);
    }
    if (opciones.accion === 'comenzar' && !esAnfitrion(sala, opciones.jugadorId)) {
      throw new Error('Solo el anfitrión puede comenzar.');
    }
    if (!['automatico', 'comenzar'].includes(opciones.accion)) throw new Error('Motivo de inicio inválido.');
    if (cantidadJugadores(sala) < minimo) throw new Error(`Se requieren al menos ${minimo} jugadores para comenzar.`);
  }
  if (sala.fase === FASES.APUESTAS && fase === FASES.JUGANDO) {
    if (!esAnfitrion(sala, opciones.jugadorId)) throw new Error('Solo el anfitrión puede iniciar la ronda.');
    if (!Number(opciones.apuestasConfirmadas ?? sala.apuestasConfirmadas ?? (Array.isArray(sala.apuestas) ? sala.apuestas.length : 0))) {
      throw new Error('Se requiere al menos una apuesta confirmada.');
    }
  }
  if (sala.fase === FASES.JUGANDO && fase === FASES.RESULTADOS && opciones.servidor !== true) {
    throw new Error('Solo el servidor puede finalizar y liquidar la ronda.');
  }
  if (sala.fase === FASES.RESULTADOS && fase === FASES.APUESTAS) {
    if (!esAnfitrion(sala, opciones.jugadorId)) throw new Error('Solo el anfitrión puede abrir la siguiente ronda.');
    if (sala.temporizadores instanceof Set) {
      for (const temporizador of sala.temporizadores) clearTimeout(temporizador);
      sala.temporizadores.clear();
    }
    if (Array.isArray(sala.apuestas)) sala.apuestas.length = 0;
    if (Array.isArray(sala.manos)) sala.manos.length = 0;
    if (Array.isArray(sala.tareasPendientes)) sala.tareasPendientes.length = 0;
    sala.apuestasConfirmadas = 0;
    sala.numero_ronda = (Number(sala.numero_ronda) || 0) + 1;
  }
  sala.fase = fase;
  sala.actualizadaEn = Date.now();
  return sala;
}

function fasePermiteAccion(fase, accion) {
  return Boolean(ACCIONES_POR_FASE[fase] && ACCIONES_POR_FASE[fase].includes(accion));
}

function abrirNuevaRonda(sala, jugadorId) {
  return cambiarFase(sala, FASES.APUESTAS, { jugadorId });
}

function cancelarTemporizadores(sala) {
  if (sala && sala.temporizadores instanceof Set) {
    for (const temporizador of sala.temporizadores) clearTimeout(temporizador);
    sala.temporizadores.clear();
  }
  if (sala && Array.isArray(sala.tareasPendientes)) sala.tareasPendientes.length = 0;
}

module.exports = { FASES, REGLAS, puedeTransicionar, cambiarFase, fasePermiteAccion, abrirNuevaRonda, cancelarTemporizadores, minimoJugadores };
