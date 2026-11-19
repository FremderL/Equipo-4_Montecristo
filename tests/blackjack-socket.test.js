'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: conectar } = require('socket.io-client');
const { servidor, io } = require('../server.js');
const { REGLAS } = require('../lib/reglas.js');
const { contarPuntos, compararConCasa } = require('../lib/juegos/blackjack.js');

let url;

before(async () => {
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => io.close(resolve));
});

async function abrirClientes(t, cuantos) {
  const clientes = Array.from({ length: cuantos }, () => conectar(url, {
    autoConnect: false, reconnection: false, transports: ['websocket'], ackTimeout: 3000
  }));
  t.after(() => {
    for (const socket of clientes) socket.disconnect();
  });
  await Promise.all(clientes.map((socket) => once(socket.connect(), 'connect')));
  return clientes;
}

async function enviar(socket, evento, ...datos) {
  const respuesta = await socket.emitWithAck(evento, ...datos);
  assert.equal(respuesta.ok, true, respuesta.error?.mensaje);
  return respuesta;
}

function esperarEstado(socket, predicadoOFase) {
  const cumple = typeof predicadoOFase === 'function'
    ? predicadoOFase
    : (estado) => estado.fase === predicadoOFase;
  return new Promise((resolve) => {
    function recibir(estado) {
      if (!cumple(estado)) return;
      socket.off('estado_sala', recibir);
      resolve(estado);
    }
    socket.on('estado_sala', recibir);
  });
}

test('repartir envía manos privadas solo a los apostadores y destapa la casa al cierre', { timeout: 10000 }, async (t) => {
  const [host, ana, bruno] = await abrirClientes(t, 3);
  const clientes = [host, ana, bruno];
  const manos = clientes.map((socket) => {
    const recibidas = [];
    socket.on('cartas', (mano) => recibidas.push(mano));
    return recibidas;
  });
  // El anfitrión no apuesta: todos los eventos que reciba deben ser públicos.
  const publicos = [];
  host.onAny((evento, datos) => publicos.push(datos));

  const { codigo } = await enviar(host, 'crear_sala', { nombre: 'Host', avatar: '🙂', juego: 'blackjack' });
  await enviar(ana, 'entrar_sala', { codigo, nombre: 'Ana', avatar: '🦊' });
  await enviar(bruno, 'entrar_sala', { codigo, nombre: 'Bruno', avatar: '🐼' });
  await enviar(host, 'comenzar');
  assert.equal((await host.emitWithAck('repartir')).error.codigo, 'SIN_APOSTADORES');
  for (const socket of [ana, bruno]) await enviar(socket, 'apostar', { monto: 10, opcion: 'mano' });
  assert.equal((await ana.emitWithAck('repartir')).error.codigo, 'SOLO_ANFITRION');

  const enJuego = Promise.all(clientes.map((socket) => esperarEstado(socket, 'jugando')));
  const ack = await enviar(host, 'repartir');
  assert.deepEqual(ack.orden, [ana.id, bruno.id]);
  const estados = await enJuego;
  assert.equal((await host.emitWithAck('repartir')).error.codigo, 'FASE_INVALIDA');
  assert.deepEqual(manos.map((recibidas) => recibidas.length), [0, 1, 1]);
  const cartasJugadores = [];
  for (const [mano] of manos.slice(1)) {
    assert.equal(mano.cartas.length, 2);
    assert.deepEqual(mano, { numeroRonda: 1, cartas: mano.cartas, puntos: contarPuntos(mano.cartas) });
    cartasJugadores.push(...mano.cartas);
  }
  const visible = estados[0].casa.cartas[0];
  for (const estado of estados) {
    assert.deepEqual(estado.casa, { cartas: [visible, null], puntos: contarPuntos([visible]) });
  }
  const antesDelCierre = JSON.stringify([publicos, estados, ack]);
  assert.doesNotMatch(antesDelCierre, /"(?:semillaRng|mazo|manos)":/);

  const alCierre = esperarEstado(host, 'resultados');
  for (const socket of [ana, bruno]) await enviar(socket, 'accion_blackjack', { accion: 'stand' });
  const { casa } = await alCierre;
  assert.ok(casa.cartas.length >= 2, 'la casa juega su mano al cierre');
  assert.equal(casa.cartas[0], visible);
  assert.equal(casa.puntos, contarPuntos(casa.cartas));
  assert.ok(casa.puntos >= 17, 'la casa se planta con 17 o más (o se pasa)');
  assert.equal(new Set([...casa.cartas, ...cartasJugadores]).size, casa.cartas.length + cartasJugadores.length);
  for (const carta of [...casa.cartas.slice(1), ...cartasJugadores]) {
    assert.ok(!antesDelCierre.includes(JSON.stringify(carta)), 'ni la tapada ni las manos privadas viajaron a la sala');
  }

  const alAbrir = esperarEstado(host, 'apuestas');
  await enviar(host, 'nueva_ronda');
  const siguiente = await alAbrir;
  assert.equal(siguiente.numeroRonda, 2);
  assert.equal(siguiente.casa, null, 'la siguiente ronda empieza sin cartas');
});

test('si el jugador se pasa de 21 al pedir, pierde su apuesta de inmediato y el turno pasa al siguiente', { timeout: 10000 }, async (t) => {
  const [host, ana, bruno] = await abrirClientes(t, 3);
  const manosAna = [];
  const manosBruno = [];
  const manosHost = [];
  ana.on('cartas', (mano) => manosAna.push(mano));
  bruno.on('cartas', (mano) => manosBruno.push(mano));
  host.on('cartas', (mano) => manosHost.push(mano));

  let ultimoEstadoHost = null;
  host.on('estado_sala', (estado) => { ultimoEstadoHost = estado; });
  const publicosBruno = [];
  bruno.on('estado_sala', (estado) => publicosBruno.push(estado));

  const { codigo } = await enviar(host, 'crear_sala', { nombre: 'Host', avatar: '🙂', juego: 'blackjack' });
  await enviar(ana, 'entrar_sala', { codigo, nombre: 'Ana', avatar: '🦊' });
  await enviar(bruno, 'entrar_sala', { codigo, nombre: 'Bruno', avatar: '🐼' });
  await enviar(host, 'comenzar');

  await enviar(ana, 'apostar', { monto: 100, opcion: 'mano' });
  await enviar(bruno, 'apostar', { monto: 50, opcion: 'mano' });
  await enviar(host, 'repartir');

  // Bruno no puede actuar en el turno de Ana; tampoco se aceptan acciones no implementadas.
  assert.equal((await bruno.emitWithAck('accion_blackjack', { accion: 'stand' })).error.codigo, 'TURNO_AJENO');
  assert.equal((await ana.emitWithAck('accion_blackjack', { accion: 'double' })).error.codigo, 'ACCION_INVALIDA');
  assert.equal((await ana.emitWithAck('accion_blackjack', { accion: 'split' })).error.codigo, 'ACCION_INVALIDA');

  // Ana pide cartas hasta superar 21 (el servidor ignora cualquier carta enviada por el cliente).
  let respuestaAna;
  let cantidadPrevia = 2;
  do {
    const cartaRecibida = once(ana, 'cartas');
    respuestaAna = await enviar(ana, 'accion_blackjack', { accion: 'pedir', carta: 'A♠' });
    const [manoPrivada] = await cartaRecibida;

    assert.equal(respuestaAna.cartas.length, cantidadPrevia + 1);
    assert.equal(respuestaAna.puntos, contarPuntos(respuestaAna.cartas));
    assert.deepEqual(manoPrivada, {
      numeroRonda: 1,
      cartas: respuestaAna.cartas,
      puntos: respuestaAna.puntos
    });
    cantidadPrevia = respuestaAna.cartas.length;

    if (!respuestaAna.pasado) {
      assert.ok(respuestaAna.puntos <= 21);
      assert.equal(respuestaAna.estado, 'jugando');
      assert.equal(respuestaAna.turno.jugadorId, ana.id, 'con 21 o menos conserva su turno');
    }
  } while (!respuestaAna.pasado);

  // En cuanto supera 21, Ana pierde de inmediato aunque Bruno aún no haya jugado su turno.
  assert.ok(respuestaAna.puntos > 21);
  assert.equal(respuestaAna.estado, 'pasado');
  assert.equal(respuestaAna.saldo, REGLAS.SALDO_INICIAL - 100);
  assert.equal(respuestaAna.turno.jugadorId, bruno.id, 'el turno pasó de inmediato a Bruno');

  const estadoTrasBust = ultimoEstadoHost?.fase === 'jugando' && ultimoEstadoHost?.turno?.jugadorId === bruno.id
    ? ultimoEstadoHost
    : await esperarEstado(host, (estado) => estado.fase === 'jugando' && estado.turno?.jugadorId === bruno.id);
  const apuestaAna = estadoTrasBust.apuestas.find((apuesta) => apuesta.jugadorId === ana.id);
  const apuestaBruno = estadoTrasBust.apuestas.find((apuesta) => apuesta.jugadorId === bruno.id);
  assert.deepEqual(apuestaAna, {
    jugadorId: ana.id,
    nombre: 'Ana',
    monto: 100,
    opcion: 'mano',
    multiplicador: 0,
    pago: 0,
    neto: -100,
    resultado: 'pierde'
  });
  assert.equal(apuestaBruno.resultado, null, 'la apuesta de Bruno sigue abierta');
  assert.equal(estadoTrasBust.acciones.at(-1).motivo, 'bust');

  // Ana ya no está en turno: cualquier nuevo intento se rechaza.
  assert.equal((await ana.emitWithAck('accion_blackjack', { accion: 'hit' })).error.codigo, 'TURNO_AJENO');
  assert.equal((await ana.emitWithAck('accion_blackjack', { accion: 'stand' })).error.codigo, 'TURNO_AJENO');
  assert.equal(manosHost.length, 0);
  assert.equal(manosBruno.length, 1, 'Bruno no recibió las cartas pedidas por Ana');
  const cartasNuevasDeAna = respuestaAna.cartas.slice(2);
  const vistoPorBruno = JSON.stringify(publicosBruno);
  for (const carta of cartasNuevasDeAna) {
    assert.ok(!vistoPorBruno.includes(JSON.stringify(carta)), 'las cartas pedidas por Ana siguen siendo privadas');
  }

  // Bruno se planta: la ronda cierra y Ana NO recupera las 100 fichas que perdió al pasarse.
  const cierre = esperarEstado(host, 'resultados');
  const respuestaBruno = await enviar(bruno, 'accion_blackjack', { accion: 'plantarse' });
  assert.equal(respuestaBruno.accion, 'stand');
  assert.equal(respuestaBruno.estado, 'plantado');
  assert.equal(respuestaBruno.pasado, false);

  const estadoFinal = await cierre;
  const jugadorAna = estadoFinal.jugadores.find((j) => j.id === ana.id);
  assert.equal(jugadorAna.fichas, REGLAS.SALDO_INICIAL - 100, 'la derrota inmediata de Ana es definitiva');
  const todasLasCartas = [...respuestaAna.cartas, ...respuestaBruno.cartas, ...estadoFinal.casa.cartas];
  assert.equal(new Set(todasLasCartas).size, todasLasCartas.length, 'todas las cartas salieron del mismo mazo sin reposición');
});

test('pedir carta sin pasarse permite seguir jugando y luego plantarse; si el único jugador se pasa la ronda termina', { timeout: 10000 }, async (t) => {
  const [ana] = await abrirClientes(t, 1);
  let ultimoEstado = null;
  ana.on('estado_sala', (estado) => { ultimoEstado = estado; });

  await enviar(ana, 'crear_sala', { nombre: 'Ana', avatar: '🦊', juego: 'blackjack' });
  await enviar(ana, 'comenzar');

  // Buscamos una mano donde tras pedir siga con <= 21 y luego se plante, y otra donde se pase siendo única jugadora.
  let proboPedirYPlantarse = false;
  let proboPasarseUnica = false;

  for (let intento = 0; intento < 25 && (!proboPedirYPlantarse || !proboPasarseUnica); intento += 1) {
    if (intento > 0) await enviar(ana, 'nueva_ronda');
    const saldoAntes = (await enviar(ana, 'apostar', { monto: 20 })).saldo;
    const manoInicial = once(ana, 'cartas');
    await enviar(ana, 'repartir');
    const [{ puntos: puntosIniciales }] = await manoInicial;

    if (!proboPedirYPlantarse && puntosIniciales <= 16) {
      const pedida = await enviar(ana, 'accion_blackjack', { accion: 'hit' });
      if (!pedida.pasado) {
        assert.equal(pedida.estado, 'jugando');
        assert.equal(pedida.turno.jugadorId, ana.id);
        const alCerrar = esperarEstado(ana, 'resultados');
        const plantada = await enviar(ana, 'accion_blackjack', { accion: 'stand' });
        assert.equal(plantada.estado, 'plantado');
        assert.equal(plantada.puntos, pedida.puntos);
        assert.equal((await alCerrar).fase, 'resultados');
        proboPedirYPlantarse = true;
        continue;
      }
      // Si se pasó en esta mano, ya cubrió el caso de único jugador que se pasa.
      const cerrado = ultimoEstado?.fase === 'resultados' ? ultimoEstado : await esperarEstado(ana, 'resultados');
      assert.equal(cerrado.apuestas[0].resultado, 'pierde');
      assert.equal(cerrado.jugadores[0].fichas, saldoAntes);
      proboPasarseUnica = true;
      continue;
    }

    if (!proboPasarseUnica) {
      const alCerrar = esperarEstado(ana, 'resultados');
      let ultima;
      do {
        ultima = await enviar(ana, 'accion_blackjack', { accion: 'hit' });
      } while (!ultima.pasado);
      const cerrado = await alCerrar;
      assert.ok(ultima.puntos > 21);
      assert.equal(cerrado.fase, 'resultados');
      assert.equal(cerrado.apuestas[0].resultado, 'pierde');
      assert.equal(cerrado.apuestas[0].pago, 0);
      assert.equal(cerrado.apuestas[0].neto, -20);
      assert.equal(cerrado.jugadores[0].fichas, saldoAntes, 'pierde las 20 fichas apostadas de inmediato');
      proboPasarseUnica = true;
      continue;
    }

    const alCerrar = esperarEstado(ana, 'resultados');
    await enviar(ana, 'accion_blackjack', { accion: 'stand' });
    await alCerrar;
  }

  assert.equal(proboPedirYPlantarse, true, 'probó pedir carta sin pasarse y plantarse');
  assert.equal(proboPasarseUnica, true, 'probó pasarse de 21 siendo la única jugadora');
});

test('al plantarse todos, la casa juega hasta 17 y paga según la comparación', { timeout: 10000 }, async (t) => {
  const [host, ana, bruno] = await abrirClientes(t, 3);
  const manos = new Map();
  for (const socket of [ana, bruno]) {
    socket.on('cartas', (mano) => manos.set(socket.id, mano));
  }

  const { codigo } = await enviar(host, 'crear_sala', { nombre: 'Host', avatar: '🙂', juego: 'blackjack' });
  await enviar(ana, 'entrar_sala', { codigo, nombre: 'Ana', avatar: '🦊' });
  await enviar(bruno, 'entrar_sala', { codigo, nombre: 'Bruno', avatar: '🐼' });
  await enviar(host, 'comenzar');
  await enviar(ana, 'apostar', { monto: 100, opcion: 'mano' });
  await enviar(bruno, 'apostar', { monto: 50, opcion: 'mano' });
  await enviar(host, 'repartir');

  const alCierre = esperarEstado(host, 'resultados');
  const alResultado = once(host, 'resultado');
  await enviar(ana, 'accion_blackjack', { accion: 'stand' });
  await enviar(bruno, 'accion_blackjack', { accion: 'stand' });
  const estadoFinal = await alCierre;
  const [resultadoPublico] = await alResultado;

  // DOC-04 §3.3: el evento `resultado` trae la casa destapada y el pago de cada apuesta.
  assert.equal(resultadoPublico.juego, 'blackjack');
  assert.equal(resultadoPublico.numeroRonda, estadoFinal.numeroRonda);
  assert.deepEqual(resultadoPublico.resultado.casa, estadoFinal.casa);
  assert.deepEqual(
    resultadoPublico.apuestas.map((apuesta) => [apuesta.nombre, apuesta.resultado]),
    estadoFinal.apuestas.map((apuesta) => [apuesta.nombre, apuesta.resultado])
  );
  for (const apuesta of resultadoPublico.apuestas) {
    assert.deepEqual(Object.keys(apuesta).sort(), [
      'jugadorId', 'monto', 'multiplicador', 'neto', 'nombre', 'opcion', 'pago', 'resultado'
    ]);
  }

  // La casa jugó su turno: se plantó con 17 o más (o se pasó) y se destapó.
  assert.ok(estadoFinal.casa.cartas.length >= 2);
  assert.ok(estadoFinal.casa.puntos >= 17);
  assert.equal(estadoFinal.casa.puntos, contarPuntos(estadoFinal.casa.cartas));

  // Cada apuesta se pagó exactamente según la comparación de las manos.
  for (const [socket, monto] of [[ana, 100], [bruno, 50]]) {
    const mano = manos.get(socket.id);
    const esperado = compararConCasa(mano.cartas, estadoFinal.casa.cartas);
    const apuesta = estadoFinal.apuestas.find((candidata) => candidata.jugadorId === socket.id);
    assert.equal(apuesta.resultado, esperado.resultado);
    assert.equal(apuesta.multiplicador, esperado.multiplicador);
    assert.equal(apuesta.pago, Math.floor(monto * esperado.multiplicador));
    assert.equal(apuesta.neto, apuesta.pago - monto);
    const jugador = estadoFinal.jugadores.find((candidato) => candidato.id === socket.id);
    assert.equal(jugador.fichas, REGLAS.SALDO_INICIAL - monto + apuesta.pago);
  }
});

test('si el único jugador se pasa, la casa no roba y la apuesta ya quedó liquidada', { timeout: 10000 }, async (t) => {
  const [ana] = await abrirClientes(t, 1);

  await enviar(ana, 'crear_sala', { nombre: 'Ana', avatar: '🦊', juego: 'blackjack' });
  await enviar(ana, 'comenzar');
  await enviar(ana, 'apostar', { monto: 20, opcion: 'mano' });
  await enviar(ana, 'repartir');

  const alCierre = esperarEstado(ana, 'resultados');
  let ultima;
  do {
    ultima = await enviar(ana, 'accion_blackjack', { accion: 'hit' });
  } while (!ultima.pasado);
  const estadoFinal = await alCierre;

  assert.equal(estadoFinal.casa.cartas.length, 2, 'sin nadie en pie, la casa no juega su turno');
  assert.deepEqual(estadoFinal.apuestas[0], {
    jugadorId: ana.id,
    nombre: 'Ana',
    monto: 20,
    opcion: 'mano',
    multiplicador: 0,
    pago: 0,
    neto: -20,
    resultado: 'pierde'
  });
  assert.equal(estadoFinal.jugadores[0].fichas, REGLAS.SALDO_INICIAL - 20);
});
