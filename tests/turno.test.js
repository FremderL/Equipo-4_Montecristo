'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REGLAS } = require('../lib/reglas.js');
const {
  tiempoDeTurno,
  juegoTieneReloj,
  normalizarAccion,
  accionPorInactividad,
  crearRelojDeTurnos
} = require('../lib/turno.js');

/** Reloj manual: permite avanzar el tiempo y disparar vencimientos sin esperar de verdad. */
function crearRelojFalso(inicio = 0) {
  let ahora = inicio;
  let siguienteId = 1;
  const pendientes = new Map();

  return {
    ahora: () => ahora,
    programar: (fn, ms) => {
      const id = siguienteId;
      siguienteId += 1;
      pendientes.set(id, { fn, vence: ahora + ms });
      return id;
    },
    cancelar: (id) => { pendientes.delete(id); },
    get pendientes() { return pendientes.size; },
    tarea: (id) => (pendientes.get(id) ? pendientes.get(id).fn : null),
    /** Mueve el reloj y dispara, en orden, todo lo que haya vencido. */
    avanzar(ms) {
      const destino = ahora + ms;
      for (;;) {
        const listos = Array.from(pendientes.entries())
          .filter(([, tarea]) => tarea.vence <= destino)
          .sort((a, b) => a[1].vence - b[1].vence);
        if (listos.length === 0) break;
        const [id, tarea] = listos[0];
        pendientes.delete(id);
        ahora = Math.max(ahora, tarea.vence);
        tarea.fn();
      }
      ahora = destino;
    },
    /** Mueve el reloj SIN disparar nada: simula un evento que llega tarde. */
    saltar(ms) { ahora += ms; }
  };
}

/** Reloj de turnos con espías, para no repetir el armado en cada prueba. */
function armar(opciones = {}) {
  const relojFalso = opciones.reloj || crearRelojFalso();
  const avisos = { turnos: [], resueltos: [], terminos: [], cancelaciones: [] };
  const sala = opciones.sala || { juego: opciones.juego || 'blackjack', temporizadores: new Set() };
  const reloj = crearRelojDeTurnos({
    juego: opciones.juego || 'blackjack',
    orden: opciones.orden || ['ana', 'bruno'],
    tiempoMs: opciones.tiempoMs,
    sala,
    ahora: relojFalso.ahora,
    programar: relojFalso.programar,
    cancelar: relojFalso.cancelar,
    contexto: opciones.contexto,
    validar: opciones.validar,
    alIniciarTurno: (turno) => avisos.turnos.push(turno),
    alResolver: (registro) => avisos.resueltos.push(registro),
    alTerminar: (resumen) => avisos.terminos.push(resumen),
    alCancelar: (resumen) => avisos.cancelaciones.push(resumen)
  });
  return { reloj, relojFalso, avisos, sala };
}

test('el límite por juego viene de DOC-02 y los juegos rápidos no tienen reloj', () => {
  assert.equal(tiempoDeTurno('blackjack'), REGLAS.TIEMPO_TURNO_BLACKJACK_MS);
  assert.equal(tiempoDeTurno('poker'), REGLAS.TIEMPO_TURNO_POKER_MS);
  assert.equal(tiempoDeTurno('blackjack'), 25000);
  assert.equal(tiempoDeTurno('poker'), 30000);
  assert.equal(tiempoDeTurno('coinflip'), null);
  assert.equal(tiempoDeTurno('dice'), null);
  assert.equal(tiempoDeTurno('roulette'), null);
  assert.equal(juegoTieneReloj('poker'), true);
  assert.equal(juegoTieneReloj('roulette'), false);
  assert.equal(tiempoDeTurno('blackjack', { blackjack: 5000 }), 5000, 'permite mesas rápidas o pruebas');
});

test('por inactividad el servidor se planta en blackjack y pasa o se retira en póker', () => {
  assert.deepEqual(
    accionPorInactividad('blackjack'),
    { accion: 'stand', automatica: true, motivo: 'inactividad', mensaje: 'Se acabó el tiempo: el servidor plantó la mano.' }
  );
  assert.equal(accionPorInactividad('poker').accion, 'check', 'sin fichas por igualar, pasa');
  assert.equal(accionPorInactividad('poker', { apuestaPorIgualar: 0 }).accion, 'check');
  assert.equal(accionPorInactividad('poker', { apuestaPorIgualar: 20 }).accion, 'fold', 'con apuesta pendiente, se retira');
  assert.equal(accionPorInactividad('poker', { apuestaPorIgualar: 0, puedePasar: false }).accion, 'fold');
  assert.match(accionPorInactividad('poker', { apuestaPorIgualar: 40 }).mensaje, /40 fichas/);
  assert.equal(accionPorInactividad('dice').accion, null);
  assert.match(accionPorInactividad('blackjack', {}, 'abandono').mensaje, /salió de la mesa/, 'explica el motivo cuando el jugador se va');
});

test('las acciones en español se normalizan y las ajenas al juego se rechazan', () => {
  assert.deepEqual(normalizarAccion('blackjack', 'Plantarse').accion, 'stand');
  assert.deepEqual(normalizarAccion('blackjack', ' pedir ').accion, 'hit');
  assert.equal(normalizarAccion('poker', 'pasar').accion, 'check');
  assert.equal(normalizarAccion('poker', 'retirarse').accion, 'fold');
  assert.equal(normalizarAccion('blackjack', 'raise').valida, false);
  assert.equal(normalizarAccion('poker', 'stand').valida, false);
  assert.equal(normalizarAccion('blackjack', '').valida, false);
});

test('al iniciar el turno avisa con jugador y deadline, y agenda un solo vencimiento', () => {
  const { reloj, relojFalso, avisos, sala } = armar();
  const vista = reloj.iniciar();

  assert.equal(vista.jugadorId, 'ana');
  assert.equal(vista.deadline, 25000);
  assert.equal(vista.segundosRestantes, 25);
  assert.equal(vista.activo, true);
  assert.deepEqual(avisos.turnos.length, 1);
  assert.equal(relojFalso.pendientes, 1);
  assert.equal(sala.temporizadores.size, 1, 'el handle queda registrado para poder limpiar la sala');
});

test('si nadie juega, el servidor decide por él y la partida sigue con el siguiente', () => {
  const { reloj, relojFalso, avisos, sala } = armar();
  reloj.iniciar();

  relojFalso.avanzar(24999);
  assert.equal(avisos.resueltos.length, 0, 'a los 24,99 s todavía es su turno');

  relojFalso.avanzar(1);
  assert.equal(avisos.resueltos.length, 1);
  assert.deepEqual(
    { jugadorId: avisos.resueltos[0].jugadorId, accion: avisos.resueltos[0].accion, automatica: avisos.resueltos[0].automatica },
    { jugadorId: 'ana', accion: 'stand', automatica: true }
  );
  assert.equal(avisos.resueltos[0].motivo, 'inactividad');
  assert.equal(avisos.resueltos[0].tiempoUsadoMs, 25000);
  assert.equal(reloj.jugadorId, 'bruno', 'el turno avanzó solo');
  assert.equal(avisos.turnos.length, 2);

  relojFalso.avanzar(25000);
  assert.equal(avisos.resueltos.length, 2);
  assert.equal(avisos.resueltos[1].jugadorId, 'bruno');
  assert.equal(reloj.terminado, true);
  assert.equal(avisos.terminos.length, 1);
  assert.equal(avisos.terminos[0].motivo, 'completo');
  assert.equal(avisos.terminos[0].registros.length, 2);
  assert.equal(relojFalso.pendientes, 0);
  assert.equal(sala.temporizadores.size, 0, 'no quedan temporizadores colgando');
});

test('la acción a tiempo gana: cancela el reloj y no hay decisión automática', () => {
  const { reloj, relojFalso, avisos, sala } = armar();
  reloj.iniciar();

  relojFalso.avanzar(10000);
  const registro = reloj.jugar('ana', 'hit');

  assert.equal(registro.automatica, false);
  assert.equal(registro.motivo, 'jugador');
  assert.equal(registro.tiempoUsadoMs, 10000);
  assert.equal(reloj.jugadorId, 'bruno');
  assert.equal(sala.temporizadores.size, 1, 'solo queda el reloj del turno actual');

  relojFalso.avanzar(25000);
  assert.deepEqual(avisos.resueltos.map((r) => [r.jugadorId, r.automatica]), [['ana', false], ['bruno', true]]);
});

test('rechaza jugar fuera de turno o una acción que no existe en el juego', () => {
  const { reloj, relojFalso, avisos } = armar();
  reloj.iniciar();

  assert.throws(() => reloj.jugar('bruno', 'stand'), /No es tu turno/);
  assert.throws(() => reloj.jugar('bruno', 'stand'), (fallo) => fallo.codigo === 'TURNO_AJENO');
  assert.throws(() => reloj.jugar('ana', 'raise'), /Acción no permitida/);
  assert.throws(() => reloj.jugar('ana', 'inventada'), (fallo) => fallo.codigo === 'ACCION_INVALIDA');
  assert.throws(() => reloj.jugar('carla', 'hit'), /No es tu turno/);

  assert.equal(avisos.resueltos.length, 0, 'ningún rechazo resuelve el turno');
  assert.equal(reloj.jugadorId, 'ana');
  relojFalso.avanzar(25000);
  assert.equal(avisos.resueltos.length, 1, 'el reloj de ana siguió corriendo');
});

test('el motor puede vetar una acción con sus propias reglas sin perder el turno', () => {
  const { reloj } = armar({
    juego: 'poker',
    contexto: () => ({ apuestaPorIgualar: 20 }),
    validar: (jugadorId, accion, extra) => (
      accion === 'check' && Number(extra.apuestaPorIgualar || 20) > 0
        ? { ok: false, codigo: 'HAY_QUE_IGUALAR', error: 'No puedes pasar: faltan 20 fichas por igualar.' }
        : { ok: true }
    )
  });
  reloj.iniciar();

  assert.throws(() => reloj.jugar('ana', 'check'), /faltan 20 fichas/);
  assert.equal(reloj.jugadorId, 'ana', 'sigue siendo su turno');
  assert.equal(reloj.jugar('ana', 'fold').accion, 'fold');
});

test('una acción que llega después del deadline se rechaza: el servidor ya decidió', () => {
  const { reloj, relojFalso, avisos } = armar();
  reloj.iniciar();

  relojFalso.saltar(25000); // el tiempo corrió pero el disparo aún no se procesa
  assert.throws(() => reloj.jugar('ana', 'hit'), /Se acabó tu tiempo/);
  assert.throws(() => reloj.jugar('ana', 'hit'), (fallo) => fallo.codigo === 'TURNO_VENCIDO' || fallo.codigo === 'TURNO_AJENO');
  assert.deepEqual(avisos.resueltos.map((r) => [r.jugadorId, r.accion, r.automatica]), [['ana', 'stand', true]]);
  assert.equal(reloj.jugadorId, 'bruno');

  relojFalso.avanzar(25000);
  assert.deepEqual(avisos.resueltos.map((r) => r.jugadorId), ['ana', 'bruno'], 'ana no se resuelve dos veces');
});

test('un temporizador viejo que se dispara tarde no decide nada (idempotencia)', () => {
  const { reloj, relojFalso, avisos } = armar();
  reloj.iniciar();
  const disparoViejo = relojFalso.tarea(1);

  reloj.jugar('ana', 'stand');
  assert.equal(reloj.jugadorId, 'bruno');

  disparoViejo();
  assert.deepEqual(avisos.resueltos.map((r) => r.jugadorId), ['ana']);
  assert.equal(reloj.jugadorId, 'bruno', 'el disparo viejo no le robó el turno');
});

test('en póker el reloj pasa sin apuesta pendiente y retira la mano si hay que igualar', () => {
  const mesa = { apuestaActual: 0, puestas: { ana: 0, bruno: 0 } };
  const { reloj, relojFalso, avisos } = armar({
    juego: 'poker',
    contexto: (jugadorId) => ({ apuestaPorIgualar: Math.max(0, mesa.apuestaActual - (mesa.puestas[jugadorId] || 0)) })
  });
  reloj.iniciar();
  relojFalso.avanzar(30000);
  assert.deepEqual([avisos.resueltos[0].accion, avisos.resueltos[0].automatica], ['check', true]);

  mesa.apuestaActual = 40; // alguien subió antes del turno de bruno
  relojFalso.avanzar(30000);
  assert.equal(avisos.resueltos[1].jugadorId, 'bruno');
  assert.equal(avisos.resueltos[1].accion, 'fold');
  assert.match(avisos.resueltos[1].mensaje, /40 fichas por igualar/);
  assert.equal(reloj.terminado, true);
});

test('si el jugador sale o se desconecta en su turno, el servidor decide y nadie se atoró', () => {
  const { reloj, avisos } = armar({ orden: ['ana', 'bruno', 'carla'] });
  reloj.iniciar();

  const registro = reloj.retirarJugador('ana', 'abandono');
  assert.deepEqual([registro.jugadorId, registro.accion, registro.automatica, registro.motivo], ['ana', 'stand', true, 'abandono']);
  assert.match(registro.mensaje, /salió de la mesa/);
  assert.equal(reloj.jugadorId, 'bruno');

  reloj.retirarJugador('carla', 'abandono');
  assert.deepEqual(reloj.orden.slice(1), ['bruno'], 'se quitó de los turnos pendientes');
  assert.equal(avisos.resueltos.length, 1, 'quitar a alguien que no estaba en turno no decide nada');

  reloj.retirarJugador('bruno', 'abandono');
  assert.equal(reloj.terminado, true);
  assert.equal(avisos.terminos[0].motivo, 'completo');
});

test('cancelar detiene el reloj y cierra la puerta a más acciones', () => {
  const { reloj, relojFalso, avisos, sala } = armar();
  reloj.iniciar();

  reloj.cancelar('nueva_ronda');
  assert.equal(relojFalso.pendientes, 0);
  assert.equal(sala.temporizadores.size, 0);
  assert.equal(reloj.jugadorId, null);
  assert.equal(reloj.vistaPublica().activo, false);
  assert.equal(avisos.cancelaciones.length, 1);
  assert.throws(() => reloj.jugar('ana', 'stand'), /ya no está activo/);
  assert.equal(reloj.retirarJugador('ana'), null);
  assert.equal(reloj.cancelar('otra vez'), null, 'cancelar es idempotente');
});

test('un juego sin reloj acepta acciones sin agendar vencimientos', () => {
  const { reloj, relojFalso, avisos, sala } = armar({ juego: 'roulette', tiempoMs: tiempoDeTurno('roulette') });
  reloj.iniciar();

  assert.equal(relojFalso.pendientes, 0);
  assert.equal(sala.temporizadores.size, 0);
  assert.equal(reloj.vistaPublica().deadline, null);
  assert.equal(reloj.vistaPublica().segundosRestantes, null);
  relojFalso.avanzar(600000);
  assert.equal(avisos.resueltos.length, 0, 'nadie decide por el jugador en los juegos rápidos');
});

test('sin jugadores no hay vuelta que iniciar', () => {
  const { reloj, avisos } = armar({ orden: [] });
  reloj.iniciar();
  assert.equal(reloj.terminado, true);
  assert.equal(avisos.terminos[0].motivo, 'sin_jugadores');
  assert.equal(reloj.iniciar().activo, false, 'iniciar dos veces no duplica nada');
});
