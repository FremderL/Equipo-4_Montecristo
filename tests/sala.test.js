'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { REGLAS } = require('../lib/reglas.js');
const { lanzarRonda } = require('../lib/lanzamiento.js');
const { crearRelojDeTurnos } = require('../lib/turno.js');
const coinflip = require('../lib/juegos/coinflip.js');
const {
  JUEGOS,
  FASES,
  ESTADOS_SALA,
  MAX_SALAS_POR_DEFECTO,
  generarCodigoSala,
  normalizarCodigo,
  validarCodigo,
  validarJuego,
  validarNombre,
  validarAvatar,
  crearJugador,
  crearSala,
  esSala,
  jugadoresSentados,
  obtenerJugador,
  obtenerAnfitrion,
  esAnfitrion,
  asientosLibres,
  salaEstaLlena,
  salaEstaVacia,
  sentarJugador,
  retirarJugador,
  marcarConexionJugador,
  transferirAnfitrion,
  migrarAnfitrionSiInactivo,
  actualizarFaseSala,
  iniciarSiguienteRonda,
  cerrarSala,
  estadoDeSala,
  resumenDeSala,
  consultaDeSala,
  crearAlmacenSalas
} = require('../lib/salas.js');

const perfil = (id, nombre = id[0].toUpperCase() + id.slice(1), avatar = '🦊') => ({
  id,
  nombre,
  avatar
});

const conCodigo = (codigo) => (fallo) => {
  assert.equal(fallo.codigo, codigo);
  assert.ok(typeof fallo.message === 'string' && fallo.message.length > 0);
  return true;
};

// ---------------------------------------------------------------------------
// 1. Estructura inicial del objeto sala
// ---------------------------------------------------------------------------

test('crearSala guarda en memoria juego, jugadores sentados, anfitrión y fase inicial', () => {
  const instante = 1_760_475_000_000;
  const sala = crearSala({
    codigo: ' k7q2m ',
    juego: 'roulette',
    anfitrion: perfil('p_ana', 'Ana', '🦊'),
    ahora: instante
  });

  assert.equal(esSala(sala), true);
  assert.equal(sala.id, 's_K7Q2M');
  assert.equal(sala.codigo, 'K7Q2M');
  assert.equal(sala.juego, 'roulette');
  assert.equal(sala.estado, ESTADOS_SALA.ABIERTA);
  assert.equal(sala.fase, FASES.ESPERA);
  assert.equal(sala.numero_ronda, 1);
  assert.equal(sala.anfitrionId, 'p_ana');
  assert.equal(sala.capacidad, REGLAS.JUGADORES_POR_SALA);
  assert.equal(sala.apuestaMinima, REGLAS.APUESTA_MINIMA);
  assert.equal(sala.creadaEn, instante);
  assert.equal(sala.actualizadaEn, instante);

  // Estado limpio de la ronda activa
  assert.deepEqual(sala.apuestas, []);
  assert.equal(sala.apuestasConfirmadas, 0);
  assert.deepEqual(sala.manos, []);
  assert.deepEqual(sala.acciones, []);
  assert.equal(sala.resultado, null);
  assert.equal(sala.semillaRng, null);
  assert.equal(sala.bote, 0);
  assert.equal(sala.apuestaActual, 0);
  assert.deepEqual(sala.puestas, {});
  assert.equal(sala.turnos, null);
  assert.equal(sala.temporizadores.size, 0);
  assert.deepEqual(sala.tareasPendientes, []);

  // Anfitrión sentado en el asiento 1 con su saldo inicial
  assert.equal(sala.jugadores.size, 1);
  assert.equal(asientosLibres(sala), 5);
  assert.equal(salaEstaLlena(sala), false);
  assert.equal(salaEstaVacia(sala), false);

  const ana = obtenerAnfitrion(sala);
  assert.deepEqual(ana, {
    id: 'p_ana',
    nombre: 'Ana',
    avatar: '🦊',
    fichas: REGLAS.SALDO_INICIAL,
    salaId: 's_K7Q2M',
    asiento: 1,
    esAnfitrion: true,
    conectado: true,
    creadoEn: instante,
    ultimaActividad: instante
  });
  assert.equal(esAnfitrion(sala, 'p_ana'), true);
  assert.equal(esAnfitrion(sala, 'otro'), false);
  assert.equal(obtenerJugador(sala, 'p_ana'), ana);
  assert.equal(obtenerJugador(sala, 'inexistente'), null);
});

test('los 5 juegos de DOC-01 son elegibles y el juego de la sala no cambia tras crearla', () => {
  assert.deepEqual(JUEGOS, ['coinflip', 'dice', 'roulette', 'blackjack', 'poker']);

  for (const juego of JUEGOS) {
    const sala = crearSala({ codigo: 'A1B2C', juego, anfitrion: perfil('h', 'Host') });
    assert.equal(sala.juego, juego);
    assert.throws(() => { sala.juego = 'coinflip'; }, TypeError);
    assert.throws(() => { sala.codigo = 'ZZZZZ'; }, TypeError);
    assert.throws(() => { sala.id = 's_OTRA1'; }, TypeError);
    assert.throws(() => { sala.capacidad = 99; }, TypeError);
    assert.throws(() => { sala.apuestaMinima = 1; }, TypeError);
    assert.equal(sala.juego, juego);
    assert.equal(sala.capacidad, 6);
    assert.equal(sala.apuestaMinima, 10);
  }
});

test('rechaza juegos, códigos, anfitriones y perfiles inválidos con error.codigo claro', () => {
  for (const juegoInvalido of ['', 'slots', 'tragamonedas', 'ruleta', 'POKER', null, undefined, 42]) {
    assert.throws(
      () => crearSala({ codigo: 'K7Q2M', juego: juegoInvalido, anfitrion: perfil('h', 'Ana') }),
      conCodigo('JUEGO_INVALIDO')
    );
    assert.throws(() => validarJuego(juegoInvalido), conCodigo('JUEGO_INVALIDO'));
  }

  for (const codigoInvalido of ['', 'ABC', 'ABCD', 'ABCDEF', 'AB CD', 'A*BCD', 'AÑ123', 'ſABCD', null, 12345]) {
    assert.throws(() => validarCodigo(codigoInvalido), conCodigo('CODIGO_INVALIDO'));
  }
  assert.equal(normalizarCodigo('  k7q2m '), 'K7Q2M');
  assert.equal(normalizarCodigo(null), '');

  assert.throws(() => crearSala(null), conCodigo('DATOS_INVALIDOS'));
  assert.throws(() => crearSala({ codigo: 'K7Q2M', juego: 'dice' }), conCodigo('ANFITRION_REQUERIDO'));
  assert.throws(() => crearJugador('', { nombre: 'Ana', avatar: '🙂' }), conCodigo('JUGADOR_INVALIDO'));
  assert.throws(() => validarNombre('   '), conCodigo('NOMBRE_INVALIDO'));
  assert.throws(() => validarNombre('A'.repeat(25)), conCodigo('NOMBRE_INVALIDO'));
  assert.throws(() => validarAvatar(''), conCodigo('AVATAR_INVALIDO'));
  assert.throws(() => crearJugador('p1', { nombre: 'Ana', avatar: '🙂', fichas: -1 }), conCodigo('SALDO_INVALIDO'));
  assert.throws(() => crearJugador('p1', { nombre: 'Ana', avatar: '🙂', fichas: 10.5 }), conCodigo('SALDO_INVALIDO'));

  // Recorte seguro de avatar sin dejar un subrogado UTF-16 suelto
  const recorteEmoji = validarAvatar('abcdefg🦊');
  assert.equal(recorteEmoji, 'abcdefg');

  assert.equal(esSala(null), false);
  assert.equal(esSala({ codigo: 'K7Q2M', juego: 'dice', fase: 'espera', jugadores: [] }), false);
});

test('generarCodigoSala produce 5 caracteres únicos y falla si no queda ninguno libre', () => {
  const activas = new Map([['AAAAA', {}]]);
  let llamadas = 0;
  const secuencia = () => {
    llamadas += 1;
    return llamadas <= 5 ? 0 : 1; // primero intenta 'AAAAA', luego 'BBBBB'
  };

  assert.equal(generarCodigoSala(activas, secuencia), 'BBBBB');
  assert.match(generarCodigoSala(activas), /^[A-Z0-9]{5}$/);
  assert.throws(() => generarCodigoSala(activas, () => 0), conCodigo('SIN_CODIGO'));
});

// ---------------------------------------------------------------------------
// 2. Jugadores sentados y control de asientos (1 a 6)
// ---------------------------------------------------------------------------

test('acepta hasta 6 jugadores sentados, rechaza el séptimo y reutiliza asientos libres en orden', () => {
  const sala = crearSala({ codigo: 'K7Q2M', juego: 'poker', anfitrion: perfil('j1', 'Ana') });

  for (let n = 2; n <= REGLAS.JUGADORES_POR_SALA; n += 1) {
    const sentado = sentarJugador(sala, perfil(`j${n}`, `Jugador ${n}`, '🐼'));
    assert.equal(sentado.asiento, n);
    assert.equal(sentado.salaId, 's_K7Q2M');
    assert.equal(sentado.esAnfitrion, false);
    assert.equal(sentado.fichas, REGLAS.SALDO_INICIAL);
  }

  assert.equal(salaEstaLlena(sala), true);
  assert.equal(asientosLibres(sala), 0);
  assert.deepEqual(jugadoresSentados(sala).map((j) => j.asiento), [1, 2, 3, 4, 5, 6]);

  // El séptimo jugador se rechaza y la mesa no cambia
  assert.throws(() => sentarJugador(sala, perfil('j7', 'Intruso')), conCodigo('SALA_LLENA'));
  assert.equal(sala.jugadores.size, 6);

  // Salen los asientos 2 y 5; los nuevos ocupan primero el 2 y luego el 5
  const salida2 = retirarJugador(sala, 'j2');
  const salida5 = retirarJugador(sala, 'j5');
  assert.equal(salida2.asientoLiberado, 2);
  assert.equal(salida5.asientoLiberado, 5);
  assert.equal(salida2.retirado.asiento, null);
  assert.equal(salida2.retirado.salaId, null);
  assert.equal(asientosLibres(sala), 2);

  const nuevoA = sentarJugador(sala, perfil('j8', 'Elena'));
  const nuevoB = sentarJugador(sala, perfil('j9', 'Fer'));
  assert.equal(nuevoA.asiento, 2);
  assert.equal(nuevoB.asiento, 5);

  // La lista siempre viene ordenada por asiento 1…6 y sin duplicados
  assert.deepEqual(
    jugadoresSentados(sala).map((j) => [j.asiento, j.id]),
    [[1, 'j1'], [2, 'j8'], [3, 'j3'], [4, 'j4'], [5, 'j9'], [6, 'j6']]
  );
});

test('valida asientos explícitos, jugadores duplicados y jugadores sentados en otra sala', () => {
  const ana = crearJugador('ana', { nombre: 'Ana', avatar: '🦊' });
  const sala = crearSala({ codigo: 'M1N2P', juego: 'blackjack', anfitrion: ana });
  assert.equal(ana.asiento, 1);

  const bruno = sentarJugador(sala, perfil('bruno', 'Bruno'), { asiento: 4 });
  assert.equal(bruno.asiento, 4);

  assert.throws(() => sentarJugador(sala, perfil('carla', 'Carla'), { asiento: 4 }), conCodigo('ASIENTO_OCUPADO'));
  assert.throws(() => sentarJugador(sala, perfil('carla', 'Carla'), { asiento: 0 }), conCodigo('ASIENTO_INVALIDO'));
  assert.throws(() => sentarJugador(sala, perfil('carla', 'Carla'), { asiento: 7 }), conCodigo('ASIENTO_INVALIDO'));
  assert.throws(() => sentarJugador(sala, perfil('bruno', 'Clon')), conCodigo('JUGADOR_YA_SENTADO'));

  // El objeto `ana` sigue sentado en M1N2P: no puede sentarse a la vez en otra sala
  const otra = crearSala({ codigo: 'Q3R4S', juego: 'dice', anfitrion: perfil('dario', 'Darío') });
  assert.throws(() => sentarJugador(otra, ana), conCodigo('JUGADOR_EN_OTRA_SALA'));

  // Una vez que sale de M1N2P, puede sentarse en Q3R4S conservando sus fichas y conectada
  ana.fichas = 1350;
  retirarJugador(sala, 'ana');
  sentarJugador(otra, ana);
  assert.equal(ana.salaId, 's_Q3R4S');
  assert.equal(ana.asiento, 2);
  assert.equal(ana.conectado, true);
  assert.equal(ana.esAnfitrion, false);
  assert.equal(ana.fichas, 1350);
});

// ---------------------------------------------------------------------------
// 3. Rol de anfitrión, transferencia y cierre al vaciarse
// ---------------------------------------------------------------------------

test('transfiere el anfitrión al siguiente jugador conectado y cierra la sala al vaciarse', () => {
  const sala = crearSala({ codigo: 'H0ST1', juego: 'coinflip', anfitrion: perfil('ana', 'Ana'), ahora: 1_000 });
  sentarJugador(sala, perfil('bruno', 'Bruno'), { ahora: 1_100 });
  sentarJugador(sala, perfil('carla', 'Carla'), { ahora: 1_200 });

  // Bruno pierde conexión temporalmente; Ana sale → el rol salta a Carla (conectada)
  marcarConexionJugador(sala, 'bruno', false, { ahora: 1_300 });
  const salidaAna = retirarJugador(sala, 'ana', { ahora: 1_400 });

  assert.equal(salidaAna.anfitrionCambio, true);
  assert.equal(salidaAna.cerrada, false);
  assert.equal(salidaAna.nuevoAnfitrion.id, 'carla');
  assert.equal(salidaAna.retirado.esAnfitrion, false);
  assert.equal(sala.anfitrionId, 'carla');
  assert.equal(obtenerJugador(sala, 'carla').esAnfitrion, true);
  assert.equal(obtenerJugador(sala, 'bruno').esAnfitrion, false);

  // Transferencia manual: rechaza desconectados o ajenos, acepta a Bruno al reconectar
  assert.throws(() => transferirAnfitrion(sala, 'bruno'), conCodigo('JUGADOR_DESCONECTADO'));
  assert.throws(() => transferirAnfitrion(sala, 'nadie'), conCodigo('JUGADOR_NO_EN_SALA'));
  marcarConexionJugador(sala, 'bruno', true, { ahora: 1_500 });
  transferirAnfitrion(sala, 'bruno', { ahora: 1_600 });
  assert.equal(sala.anfitrionId, 'bruno');
  assert.equal(jugadoresSentados(sala).filter((j) => j.esAnfitrion).length, 1);

  // Sale Carla (no anfitriona): Bruno conserva el rol
  const salidaCarla = retirarJugador(sala, 'carla', { ahora: 1_700 });
  assert.equal(salidaCarla.anfitrionCambio, false);
  assert.equal(sala.anfitrionId, 'bruno');

  // Sale Bruno (último jugador): la sala se cierra y cancela sus temporizadores
  const temporizador = setTimeout(() => {}, 60_000);
  sala.temporizadores.add(temporizador);
  const salidaFinal = retirarJugador(sala, 'bruno', { ahora: 2_000 });

  assert.equal(salidaFinal.cerrada, true);
  assert.equal(salidaFinal.nuevoAnfitrion, null);
  assert.equal(sala.estado, ESTADOS_SALA.CERRADA);
  assert.equal(sala.anfitrionId, null);
  assert.equal(salaEstaVacia(sala), true);
  assert.equal(sala.temporizadores.size, 0);

  assert.throws(() => sentarJugador(sala, perfil('dario', 'Darío')), conCodigo('SALA_CERRADA'));
  assert.throws(() => actualizarFaseSala(sala, FASES.APUESTAS, { accion: 'automatico' }), conCodigo('SALA_CERRADA'));
});

test('migrarAnfitrionSiInactivo pasa el rol tras 60 s de desconexión (DOC-01 §4)', () => {
  const sala = crearSala({ codigo: 'M1GR4', juego: 'roulette', anfitrion: perfil('ana', 'Ana'), ahora: 10_000 });
  sentarJugador(sala, perfil('bruno', 'Bruno'), { ahora: 10_500 });

  // Conectada: nunca migra aunque pase el tiempo
  assert.equal(migrarAnfitrionSiInactivo(sala, { ahora: 99_000 }).migrado, false);

  marcarConexionJugador(sala, 'ana', false, { ahora: 20_000 });
  // Antes de 60 s: conserva el rol
  assert.equal(
    migrarAnfitrionSiInactivo(sala, { ahora: 20_000 + REGLAS.TIEMPO_HOST_INACTIVO_MS - 1 }).migrado,
    false
  );
  assert.equal(sala.anfitrionId, 'ana');

  // Al cumplirse los 60 s: Bruno pasa a ser anfitrión
  const migracion = migrarAnfitrionSiInactivo(sala, { ahora: 20_000 + REGLAS.TIEMPO_HOST_INACTIVO_MS });
  assert.equal(migracion.migrado, true);
  assert.equal(migracion.anteriorId, 'ana');
  assert.equal(migracion.anfitrion.id, 'bruno');
  assert.equal(sala.anfitrionId, 'bruno');
  assert.equal(obtenerJugador(sala, 'ana').esAnfitrion, false);
  assert.equal(obtenerJugador(sala, 'bruno').esAnfitrion, true);
});

// ---------------------------------------------------------------------------
// 4. Fases de la ronda e integración con ronda.js, lanzamiento.js y turno.js
// ---------------------------------------------------------------------------

test('recorre las fases espera → apuestas → jugando → resultados → nueva ronda y valida reglas', () => {
  // En póker no arranca con 1 solo jugador sentado (DOC-01 §4)
  const poker = crearSala({ codigo: 'P0K3R', juego: 'poker', anfitrion: perfil('ana', 'Ana') });
  assert.throws(
    () => actualizarFaseSala(poker, FASES.APUESTAS, { jugadorId: 'ana' }),
    conCodigo('JUGADORES_INSUFICIENTES')
  );
  assert.equal(poker.fase, FASES.ESPERA);

  sentarJugador(poker, perfil('bruno', 'Bruno'));
  assert.throws(() => actualizarFaseSala(poker, FASES.JUGANDO, { jugadorId: 'ana' }), conCodigo('FASE_INVALIDA'));
  assert.throws(() => iniciarSiguienteRonda(poker, 'ana'), conCodigo('FASE_INVALIDA'));
  assert.throws(() => actualizarFaseSala(poker, FASES.APUESTAS, { jugadorId: 'bruno' }), conCodigo('SOLO_ANFITRION'));

  actualizarFaseSala(poker, FASES.APUESTAS, { jugadorId: 'ana' });
  assert.equal(poker.fase, FASES.APUESTAS);

  // Sin apuestas confirmadas no entra a jugando
  assert.throws(() => actualizarFaseSala(poker, FASES.JUGANDO, { jugadorId: 'ana' }), conCodigo('SIN_APOSTADORES'));

  poker.apuestas.push({ jugadorId: 'ana', nombre: 'Ana', monto: 20, opcion: 'ciega' });
  poker.apuestasConfirmadas = 1;
  poker.bote = 20;
  poker.apuestaActual = 20;
  poker.puestas = { ana: 20 };

  assert.throws(() => actualizarFaseSala(poker, FASES.JUGANDO, { jugadorId: 'bruno' }), conCodigo('SOLO_ANFITRION'));
  actualizarFaseSala(poker, FASES.JUGANDO, { jugadorId: 'ana' });
  assert.equal(poker.fase, FASES.JUGANDO);

  assert.throws(() => actualizarFaseSala(poker, FASES.RESULTADOS, { jugadorId: 'ana' }), conCodigo('SOLO_SERVIDOR'));
  actualizarFaseSala(poker, FASES.RESULTADOS, { servidor: true });
  assert.equal(poker.fase, FASES.RESULTADOS);

  // Ana sale en resultados; Bruno hereda el rol y abre la ronda 2 limpia
  retirarJugador(poker, 'ana');
  assert.equal(poker.anfitrionId, 'bruno');
  assert.throws(() => iniciarSiguienteRonda(poker, 'ana'), conCodigo('SOLO_ANFITRION'));

  iniciarSiguienteRonda(poker, 'bruno');
  assert.equal(poker.fase, FASES.APUESTAS);
  assert.equal(poker.numero_ronda, 2);
  assert.deepEqual(poker.apuestas, []);
  assert.equal(poker.apuestasConfirmadas, 0);
  assert.equal(poker.bote, 0);
  assert.equal(poker.apuestaActual, 0);
  assert.deepEqual(poker.puestas, {});
  assert.equal(poker.juego, 'poker');
});

test('el objeto sala funciona directamente con lanzarRonda y crearRelojDeTurnos', () => {
  // Juego rápido (Cara o Cruz)
  const rapida = crearSala({ codigo: 'C01NF', juego: 'coinflip', anfitrion: perfil('ana', 'Ana') });
  sentarJugador(rapida, perfil('bruno', 'Bruno'));
  actualizarFaseSala(rapida, FASES.APUESTAS, { jugadorId: 'ana' });

  obtenerJugador(rapida, 'ana').fichas -= 100;
  rapida.apuestas.push({ jugadorId: 'ana', nombre: 'Ana', monto: 100, opcion: 'cara' });
  obtenerJugador(rapida, 'bruno').fichas -= 50;
  rapida.apuestas.push({ jugadorId: 'bruno', nombre: 'Bruno', monto: 50, opcion: 'cara' });
  rapida.apuestasConfirmadas = 2;
  rapida.bote = 150;

  // Bruno sale antes de lanzar: recupera sus 50 fichas y su apuesta desaparece
  const salidaBruno = retirarJugador(rapida, 'bruno');
  assert.equal(salidaBruno.retirado.fichas, 1000);
  assert.equal(rapida.apuestas.length, 1);
  assert.equal(rapida.bote, 100);

  const resumen = lanzarRonda(rapida, coinflip, { jugadorId: 'ana', rng: () => 0 });
  assert.equal(rapida.fase, FASES.RESULTADOS);
  assert.deepEqual(resumen.resultado, { lado: 'cara' });
  assert.equal(obtenerJugador(rapida, 'ana').fichas, 1100);

  // Juego por turnos (Blackjack): si alguien abandona en su turno, no se reembolsa ni se atora
  const mesaBj = crearSala({ codigo: 'BJ021', juego: 'blackjack', anfitrion: perfil('ana', 'Ana') });
  sentarJugador(mesaBj, perfil('bruno', 'Bruno'));
  actualizarFaseSala(mesaBj, FASES.APUESTAS, { jugadorId: 'ana' });

  obtenerJugador(mesaBj, 'ana').fichas -= 100;
  mesaBj.apuestas.push({ jugadorId: 'ana', nombre: 'Ana', monto: 100, opcion: 'mano' });
  obtenerJugador(mesaBj, 'bruno').fichas -= 100;
  mesaBj.apuestas.push({ jugadorId: 'bruno', nombre: 'Bruno', monto: 100, opcion: 'mano' });
  actualizarFaseSala(mesaBj, FASES.JUGANDO, { jugadorId: 'ana' });

  const resueltas = [];
  mesaBj.turnos = crearRelojDeTurnos({
    juego: mesaBj.juego,
    orden: ['ana', 'bruno'],
    sala: mesaBj,
    programar: () => 1,
    cancelar: () => {},
    alResolver: (r) => resueltas.push(r)
  });
  mesaBj.turnos.iniciar();

  const abandonoAna = retirarJugador(mesaBj, 'ana');
  assert.equal(abandonoAna.apuestaReembolsada, null, 'salir en juego no reembolsa la apuesta');
  assert.equal(abandonoAna.retirado.fichas, 900);
  assert.equal(resueltas[0].accion, 'stand');
  assert.equal(resueltas[0].motivo, 'abandono');
  assert.equal(mesaBj.turnos.jugadorId, 'bruno', 'el turno pasó a Bruno');
  assert.equal(mesaBj.anfitrionId, 'bruno', 'Bruno también heredó el rol de anfitrión');

  cerrarSala(mesaBj);
  assert.equal(mesaBj.turnos, null);
});

// ---------------------------------------------------------------------------
// 5. Vistas públicas y aislamiento de datos privados
// ---------------------------------------------------------------------------

test('estadoDeSala, resumenDeSala y consultaDeSala reflejan la sala sin filtrar secretos', () => {
  const sala = crearSala({ codigo: 'V1STA', juego: 'blackjack', anfitrion: perfil('ana', 'Ana', '🦊') });
  sentarJugador(sala, perfil('bruno', 'Bruno', '🐼'), { asiento: 3 });
  sala.semillaRng = 'sd_secreta_12345';
  sala.manos.push({ jugadorId: 'ana', cartas: ['A♠', 'K♥'] });
  sala.resultado = { casa: 20 };

  const publica = estadoDeSala(sala);
  assert.equal(publica.id, 's_V1STA');
  assert.equal(publica.codigo, 'V1STA');
  assert.equal(publica.juego, 'blackjack');
  assert.equal(publica.estado, 'abierta');
  assert.equal(publica.fase, FASES.ESPERA);
  assert.equal(publica.anfitrionId, 'ana');
  assert.equal(publica.capacidad, 6);
  assert.equal(publica.asientosLibres, 4);
  assert.equal(publica.apuestaMinima, 10);
  assert.equal(publica.numeroRonda, 1);
  assert.equal(publica.limiteTurnoMs, REGLAS.TIEMPO_TURNO_BLACKJACK_MS);
  assert.deepEqual(publica.jugadores, [
    { id: 'ana', nombre: 'Ana', avatar: '🦊', fichas: 1000, asiento: 1, esAnfitrion: true, conectado: true },
    { id: 'bruno', nombre: 'Bruno', avatar: '🐼', fichas: 1000, asiento: 3, esAnfitrion: false, conectado: true }
  ]);

  const serializado = JSON.stringify(publica);
  assert.equal(serializado.includes('sd_secreta_12345'), false, 'la semilla nunca sale al cliente');
  assert.equal(serializado.includes('A♠'), false, 'las cartas privadas no van en estado_sala');

  // Mutar la vista pública no toca la sala en memoria
  publica.resultado.casa = 99;
  publica.jugadores[0].fichas = 0;
  assert.equal(sala.resultado.casa, 20);
  assert.equal(obtenerJugador(sala, 'ana').fichas, 1000);

  assert.deepEqual(resumenDeSala(sala), {
    id: 's_V1STA',
    codigo: 'V1STA',
    juego: 'blackjack',
    fase: FASES.ESPERA,
    anfitrionId: 'ana',
    anfitrion: 'Ana',
    jugadores: 2,
    capacidad: 6,
    asientosLibres: 4
  });
  assert.deepEqual(consultaDeSala(sala), {
    ok: true,
    existe: true,
    id: 's_V1STA',
    codigo: 'V1STA',
    juego: 'blackjack',
    fase: FASES.ESPERA,
    anfitrionId: 'ana',
    jugadores: 2,
    capacidad: 6,
    asientosLibres: 4
  });
});

// ---------------------------------------------------------------------------
// 6. Almacén de salas activas en memoria
// ---------------------------------------------------------------------------

test('crearAlmacenSalas aísla salas, respeta maxSalas, protege reentradas y limpia vacías', () => {
  assert.equal(MAX_SALAS_POR_DEFECTO, 50);
  const almacen = crearAlmacenSalas({ maxSalas: 2 });

  const primera = almacen.crear({ codigo: 'SALA1', juego: 'coinflip', anfitrion: perfil('ana', 'Ana') });
  const segunda = almacen.crear({ codigo: 'SALA2', juego: 'dice', anfitrion: perfil('carla', 'Carla') });
  assert.equal(almacen.size, 2);
  assert.equal(almacen.obtener('sala1'), primera);
  assert.equal(almacen.salaDeJugador('ana'), primera);

  // Tope de salas y código repetido
  assert.throws(
    () => almacen.crear({ codigo: 'SALA3', juego: 'poker', anfitrion: perfil('dario', 'Darío') }),
    conCodigo('LIMITE_SALAS')
  );
  // Si Carla (única en SALA2) crea otra sala, libera SALA2 y no excede el tope
  const reemplazo = almacen.crear({ codigo: 'SALA3', juego: 'poker', anfitrion: perfil('carla', 'Carla') });
  assert.equal(almacen.size, 2);
  assert.equal(almacen.obtener('SALA2'), null);
  assert.equal(segunda.estado, ESTADOS_SALA.CERRADA);
  assert.equal(almacen.salaDeJugador('carla'), reemplazo);
  assert.throws(
    () => almacen.crear({ codigo: 'SALA1', juego: 'dice', anfitrion: perfil('carla', 'Carla') }),
    conCodigo('CODIGO_EN_USO')
  );

  // Reenviar `unir` a la misma sala no altera asiento, saldo ni anfitrión
  obtenerJugador(primera, 'ana').fichas = 750;
  const reentrada = almacen.unir(' sala1 ', perfil('ana', 'Otro nombre'));
  assert.equal(reentrada.yaEstaba, true);
  assert.equal(reentrada.jugador.nombre, 'Ana');
  assert.equal(reentrada.jugador.fichas, 750);
  assert.equal(reentrada.jugador.asiento, 1);
  assert.equal(primera.anfitrionId, 'ana');

  // Si una entrada falla, el jugador NO pierde su asiento en la sala donde estaba
  assert.throws(() => almacen.unir('NOEXI', perfil('carla', 'Carla')), conCodigo('SALA_NO_ENCONTRADA'));
  assert.equal(almacen.salaDeJugador('carla'), reemplazo);

  // Al cambiarse de SALA3 a SALA1, SALA3 queda vacía y se elimina sola
  const cambio = almacen.unir('SALA1', perfil('carla', 'Carla'));
  assert.equal(cambio.yaEstaba, false);
  assert.equal(cambio.salidaAnterior.cerrada, true);
  assert.equal(almacen.obtener('SALA3'), null);
  assert.equal(almacen.size, 1);
  assert.equal(primera.jugadores.size, 2);

  almacen.cerrarTodas();
  assert.equal(almacen.size, 0);
  assert.equal(primera.estado, ESTADOS_SALA.CERRADA);
});

// ---------------------------------------------------------------------------
// 7. Integración con server.js (HTTP + Socket.IO en vivo)
// ---------------------------------------------------------------------------

/** Cliente mínimo de Socket.IO v4 sobre WebSocket (sin dependencias extra). */
function conectarClienteSocket(puerto, t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${puerto}/socket.io/?EIO=4&transport=websocket`);
    let siguienteAck = 1;
    let idSocket = null;
    const pendientes = new Map();
    const escuchas = new Map();

    const limpiar = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
    t.after(limpiar);

    ws.on('error', reject);
    ws.on('message', (crudo) => {
      const texto = String(crudo);
      if (texto.startsWith('0')) {
        ws.send('40'); // conectar al namespace principal
        return;
      }
      if (texto === '2') {
        ws.send('3'); // latido Engine.IO
        return;
      }
      if (texto.startsWith('40')) {
        const carga = JSON.parse(texto.slice(2));
        idSocket = carga.sid;
        resolve({
          get id() { return idSocket; },
          emitir(evento, ...argumentos) {
            const id = siguienteAck;
            siguienteAck += 1;
            return new Promise((ok, fallo) => {
              const reloj = setTimeout(() => {
                pendientes.delete(id);
                fallo(new Error(`Sin respuesta para ${evento}`));
              }, 3000);
              pendientes.set(id, (respuesta) => {
                clearTimeout(reloj);
                ok(respuesta);
              });
              ws.send(`42${id}${JSON.stringify([evento, ...argumentos])}`);
            });
          },
          esperarEvento(evento, filtro = null) {
            return new Promise((ok, fallo) => {
              const reloj = setTimeout(() => fallo(new Error(`No llegó el evento ${evento}`)), 3000);
              const cola = escuchas.get(evento) || [];
              cola.push({
                filtro,
                resolver: (datos) => {
                  clearTimeout(reloj);
                  ok(datos);
                }
              });
              escuchas.set(evento, cola);
            });
          }
        });
        return;
      }
      if (texto.startsWith('43')) {
        const coincidencia = /^43(\d+)([\s\S]*)$/.exec(texto);
        if (!coincidencia) return;
        const resolver = pendientes.get(Number(coincidencia[1]));
        if (resolver) {
          pendientes.delete(Number(coincidencia[1]));
          const [respuesta] = JSON.parse(coincidencia[2]);
          resolver(respuesta);
        }
        return;
      }
      if (texto.startsWith('42')) {
        const coincidencia = /^42\d*([\s\S]*)$/.exec(texto);
        if (!coincidencia) return;
        const [evento, datos] = JSON.parse(coincidencia[1]);
        const cola = escuchas.get(evento);
        if (cola && cola.length > 0) {
          const indice = cola.findIndex((item) => !item.filtro || item.filtro(datos));
          if (indice >= 0) {
            const [item] = cola.splice(indice, 1);
            item.resolver(datos);
          }
        }
      }
    });
  });
}

test('server.js mantiene la estructura de la sala en memoria durante todo el ciclo de vida', async (t) => {
  const { servidor, io, salas } = require('../server.js');
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  t.after(async () => {
    salas.cerrarTodas('fin_prueba');
    await new Promise((ok) => io.close(ok));
  });

  const puerto = servidor.address().port;
  const base = `http://127.0.0.1:${puerto}`;

  const ana = await conectarClienteSocket(puerto, t);
  const bruno = await conectarClienteSocket(puerto, t);

  // Crear sala: guarda juego, anfitrión en asiento 1 y fase espera
  const [estadoInicial, creada] = await Promise.all([
    ana.esperarEvento('estado_sala'),
    ana.emitir('crear_sala', { nombre: 'Ana', avatar: '🦊', juego: 'coinflip' })
  ]);
  assert.equal(creada.ok, true);
  assert.match(creada.codigo, /^[A-Z0-9]{5}$/);
  assert.equal(estadoInicial.id, `s_${creada.codigo}`);
  assert.equal(estadoInicial.juego, 'coinflip');
  assert.equal(estadoInicial.fase, FASES.ESPERA);
  assert.equal(estadoInicial.anfitrionId, ana.id);
  assert.equal(estadoInicial.jugadores[0].asiento, 1);
  assert.equal(estadoInicial.jugadores[0].esAnfitrion, true);

  // Llenar hasta 6 asientos y rechazar al séptimo
  const [estadoConBruno, entradaBruno] = await Promise.all([
    ana.esperarEvento('estado_sala'),
    bruno.emitir('entrar_sala', { codigo: creada.codigo.toLowerCase(), nombre: 'Bruno', avatar: '🐼' })
  ]);
  assert.deepEqual(entradaBruno, { ok: true, codigo: creada.codigo });
  assert.deepEqual(
    estadoConBruno.jugadores.map((j) => [j.asiento, j.nombre, j.esAnfitrion]),
    [[1, 'Ana', true], [2, 'Bruno', false]]
  );

  const extras = [];
  for (let i = 3; i <= 6; i += 1) {
    const cliente = await conectarClienteSocket(puerto, t);
    extras.push(cliente);
    const r = await cliente.emitir('entrar_sala', { codigo: creada.codigo, nombre: `J${i}`, avatar: '🙂' });
    assert.equal(r.ok, true);
  }
  const septimo = await conectarClienteSocket(puerto, t);
  const rechazoLlena = await septimo.emitir('entrar_sala', { codigo: creada.codigo, nombre: 'Extra', avatar: '🐺' });
  assert.equal(rechazoLlena.ok, false);
  assert.equal(rechazoLlena.error.codigo, 'SALA_LLENA');

  // Consultar API HTTP
  const listaHttp = await (await fetch(`${base}/api/salas`)).json();
  assert.equal(listaHttp.ok, true);
  assert.equal(listaHttp.salas.length, 1);
  assert.equal(listaHttp.salas[0].jugadores, 6);
  assert.equal(listaHttp.salas[0].asientosLibres, 0);
  assert.equal(listaHttp.salas[0].fase, FASES.ESPERA);

  // Solo el anfitrión abre apuestas, lanza y abre la siguiente ronda
  const rechazoNoHost = await bruno.emitir('comenzar');
  assert.equal(rechazoNoHost.ok, false);
  assert.equal(rechazoNoHost.error.codigo, 'SOLO_ANFITRION');

  assert.deepEqual(await ana.emitir('comenzar'), { ok: true, fase: FASES.APUESTAS, numeroRonda: 1 });
  assert.equal((await ana.emitir('apostar', { monto: 100, opcion: 'cara' })).ok, true);

  // Reentrar con el mismo código no expulsa ni reinicia el saldo o el asiento
  const [estadoReentrada, reentrada] = await Promise.all([
    ana.esperarEvento('estado_sala'),
    ana.emitir('entrar_sala', { codigo: creada.codigo, nombre: 'Cambio', avatar: '🐸' })
  ]);
  assert.deepEqual(reentrada, { ok: true, codigo: creada.codigo });
  assert.equal(estadoReentrada.jugadores.length, 6);
  assert.equal(estadoReentrada.jugadores[0].fichas, 900);
  assert.equal(estadoReentrada.jugadores[0].nombre, 'Ana');

  const [estadoLiquidadoBruno, lanzada] = await Promise.all([
    bruno.esperarEvento('estado_sala'),
    ana.emitir('lanzar')
  ]);
  assert.equal(lanzada.ok, true);
  assert.equal(estadoLiquidadoBruno.fase, FASES.RESULTADOS);
  assert.equal(salas.obtener(creada.codigo).fase, FASES.RESULTADOS);

  // Ana sale: Bruno hereda el anfitrión y abre la ronda 2
  const [estadoTrasSalida] = await Promise.all([
    bruno.esperarEvento('estado_sala'),
    ana.emitir('salir_sala')
  ]);
  assert.equal(estadoTrasSalida.anfitrionId, bruno.id);
  assert.equal(estadoTrasSalida.asientosLibres, 1);
  assert.deepEqual(
    estadoTrasSalida.jugadores.slice(0, 2).map((j) => [j.asiento, j.nombre, j.esAnfitrion]),
    [[2, 'Bruno', true], [3, 'J3', false]]
  );

  // Un nuevo jugador ocupa el asiento 1 que dejó libre Ana
  const [estadoConReemplazo, entradaReemplazo] = await Promise.all([
    bruno.esperarEvento('estado_sala'),
    septimo.emitir('entrar_sala', { codigo: creada.codigo, nombre: 'Gabi', avatar: '🐺' })
  ]);
  assert.equal(entradaReemplazo.ok, true);
  assert.deepEqual(
    estadoConReemplazo.jugadores.slice(0, 2).map((j) => [j.asiento, j.nombre, j.esAnfitrion]),
    [[1, 'Gabi', false], [2, 'Bruno', true]],
    'Gabi ocupa el asiento 1 libre sin quitarle el rol de anfitrión a Bruno'
  );

  assert.deepEqual(await bruno.emitir('nueva_ronda'), { ok: true, fase: FASES.APUESTAS, numeroRonda: 2 });

  // Cuando salen todos los jugadores, la sala desaparece de memoria
  for (const cliente of [septimo, bruno, ...extras]) {
    assert.equal((await cliente.emitir('salir_sala')).ok, true);
  }
  assert.equal(salas.size, 0);
  assert.equal((await fetch(`${base}/api/salas/${creada.codigo}`)).status, 404);

  // Mesa de póker y cambio entre salas activas sin dejar jugadores duplicados ni apuestas huérfanas
  const carla = await conectarClienteSocket(puerto, t);
  const salaPoker = await ana.emitir('crear_sala', { nombre: 'Ana', avatar: '🦊', juego: 'poker' });
  const salaRuleta = await carla.emitir('crear_sala', { nombre: 'Carla', avatar: '🦉', juego: 'roulette' });
  assert.equal(salaPoker.ok, true);
  assert.equal(salaRuleta.ok, true);

  // Póker exige mínimo 2 jugadores sentados para pasar a apuestas
  const soloUna = await ana.emitir('comenzar');
  assert.equal(soloUna.ok, false);
  assert.equal(soloUna.error.codigo, 'JUGADORES_INSUFICIENTES');

  assert.equal((await bruno.emitir('entrar_sala', { codigo: salaPoker.codigo, nombre: 'Bruno', avatar: '🐼' })).ok, true);
  assert.equal((await ana.emitir('comenzar')).ok, true);
  assert.equal((await ana.emitir('apostar', { monto: 100, opcion: 'ciega' })).ok, true);
  assert.equal((await bruno.emitir('apostar', { monto: 50, opcion: 'ciega' })).ok, true);

  // Ana se pasa a la sala de ruleta: en póker desaparece su apuesta y Bruno queda de anfitrión
  const [estadoPokerSinAna, estadoRuletaConAna, pasoARuleta] = await Promise.all([
    bruno.esperarEvento('estado_sala', (e) => e.codigo === salaPoker.codigo && e.jugadores.length === 1),
    carla.esperarEvento('estado_sala', (e) => e.codigo === salaRuleta.codigo && e.jugadores.length === 2),
    ana.emitir('entrar_sala', { codigo: salaRuleta.codigo, nombre: 'Ana', avatar: '🦊' })
  ]);
  assert.equal(pasoARuleta.ok, true);
  assert.equal(estadoPokerSinAna.anfitrionId, bruno.id);
  assert.equal(estadoPokerSinAna.bote, 50);
  assert.equal(estadoPokerSinAna.apuestas.length, 1);
  assert.equal(estadoRuletaConAna.anfitrionId, carla.id);
  assert.deepEqual(estadoRuletaConAna.jugadores.map((j) => [j.asiento, j.nombre]), [[1, 'Carla'], [2, 'Ana']]);

  // Bruno reparte y juega su turno en póker: jugando → resultados → nueva ronda
  assert.equal((await bruno.emitir('repartir')).ok, true);
  assert.equal(salas.obtener(salaPoker.codigo).fase, FASES.JUGANDO);
  assert.equal((await bruno.emitir('accion_poker', { accion: 'check' })).ok, true);
  assert.equal(salas.obtener(salaPoker.codigo).fase, FASES.RESULTADOS);

  // Un crear_sala inválido no saca a Bruno de su sala; uno válido cierra la anterior al vaciarse
  const creacionFallida = await bruno.emitir('crear_sala', { nombre: 'Bruno', avatar: '🐼', juego: 'slots' });
  assert.equal(creacionFallida.ok, false);
  assert.equal(creacionFallida.error.codigo, 'JUEGO_INVALIDO');
  assert.equal(salas.salaDeJugador(bruno.id).codigo, salaPoker.codigo);

  const salaBj = await bruno.emitir('crear_sala', { nombre: 'Bruno', avatar: '🐼', juego: 'blackjack' });
  assert.equal(salaBj.ok, true);
  assert.equal(salas.obtener(salaPoker.codigo), null);
  assert.equal(salas.salaDeJugador(bruno.id).codigo, salaBj.codigo);
});
