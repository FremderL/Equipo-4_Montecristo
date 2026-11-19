'use strict';

const { test, expect, perfil, crear, captura } = require('./apoyo.js');
const { io } = require('socket.io-client');
const { once } = require('node:events');

async function controles(pagina, desactivados) {
  for (const selector of ['#opcion-apuesta', '#monto-apuesta', '.montos-rapidos button:first-child', '#confirmar-apuesta']) {
    if (desactivados) await expect(pagina.locator(selector)).toBeDisabled();
    else await expect(pagina.locator(selector)).toBeEnabled();
  }
}

test('distingue directorio vacío de error de red y permite reintentar', async ({ page }) => {
  await page.route('**/api/salas', (ruta) => ruta.fulfill({ status: 503, body: '' }));
  await page.goto('/');
  await expect(page.locator('#estado-directorio')).toHaveText('No se pudo cargar el directorio');
  await page.unroute('**/api/salas');
  await page.getByRole('button', { name: 'Actualizar' }).click();
  await expect(page.locator('#estado-directorio')).toHaveText('Todavía no hay salas abiertas');
});

test('del directorio a la mesa: asientos, fases, monto, confirmación y saldo insuficiente real', async ({ page: valeria, otraPagina }) => {
  const codigo = await crear(valeria, 'Valeria', '🦊', 'coinflip');
  const mateo = await otraPagina();
  await mateo.goto('/');
  await mateo.getByRole('link', { name: `Entrar a Cara o Cruz, sala ${codigo}` }).click();
  await perfil(mateo, 'Mateo', '🐼');
  const luz = await otraPagina();
  await luz.goto('/');
  await luz.locator('#codigo-sala').fill(codigo.toLowerCase());
  await luz.getByRole('button', { name: 'Entrar con código' }).click();
  await perfil(luz, 'Lucía', '🦉');
  const otraSala = await otraPagina();
  const codigoRuleta = await crear(otraSala, 'Renata', '🐱', 'roulette');

  const salon = await otraPagina();
  await salon.goto('/');
  const fila = salon.locator(`tr[data-codigo="${codigo}"]`);
  await expect(fila).toContainText('Valeria');
  await expect(fila).toContainText('3/6');
  await expect(salon.locator(`tr[data-codigo="${codigoRuleta}"]`)).toContainText('1/6');
  await captura(salon, '01-directorio.jpg');

  await expect(valeria.locator('#asientos li')).toHaveCount(6);
  await expect(valeria.locator('.asiento:not(.asiento--libre) strong')).toHaveText(['Valeria', 'Mateo', 'Lucía']);
  await expect(valeria.locator('.asiento:not(.asiento--libre) .asiento__avatar')).toHaveText(['🦊', '🐼', '🦉']);
  await expect(valeria.locator('#saldo-jugador')).toHaveText('1,000');
  await controles(valeria, true);
  await expect(mateo.locator('#accion-ronda')).toBeHidden();
  await captura(valeria, '02-mesa-espera.jpg');

  await valeria.getByRole('button', { name: 'Abrir apuestas' }).click();
  await controles(valeria, false);
  await expect(valeria.locator('#accion-ronda')).toBeDisabled(); // aún nadie confirmó
  await valeria.getByLabel('Opción de juego').selectOption('cruz');
  for (const invalido of ['', '9', '10.5', '1001']) {
    await valeria.getByLabel('Monto en fichas').fill(invalido);
    await expect(valeria.locator('#confirmar-apuesta')).toBeDisabled();
  }
  await expect(valeria.locator('#ayuda-apuesta')).toContainText('Saldo insuficiente');
  await expect(valeria.locator('#monto-apuesta')).toBeEnabled(); // puede corregir el monto
  await valeria.getByRole('button', { name: '100', exact: true }).click();
  await expect(valeria.locator('#confirmar-apuesta')).toBeEnabled();
  await captura(valeria, '03-apuesta-abierta.jpg');
  await valeria.locator('#confirmar-apuesta').click();
  await expect(valeria.locator('#saldo-jugador')).toHaveText('900');
  await expect(valeria.locator('#ayuda-apuesta')).toContainText('Apuesta confirmada: 100 fichas · Cruz');
  await controles(valeria, true);
  await expect(mateo.locator('#saldo-jugador')).toHaveText('1,000');
  await controles(mateo, false);
  await captura(valeria, '04-apuesta-confirmada.jpg');

  // Lados opuestos por el total: uno se quedará en cero sin manipular el RNG ni los saldos.
  for (const [pagina, opcion] of [[mateo, 'cara'], [luz, 'cruz']]) {
    await pagina.locator('#opcion-apuesta').selectOption(opcion);
    await pagina.getByRole('button', { name: 'Máx.' }).click();
    await pagina.locator('#confirmar-apuesta').click();
    await expect(pagina.locator('#saldo-jugador')).toHaveText('0');
  }
  await valeria.getByRole('button', { name: 'Lanzar moneda' }).click();
  for (const p of [valeria, mateo, luz]) {
    await expect(p.locator('#fase-mesa')).toHaveText('Resultados');
    await controles(p, true);
  }
  const sinSaldo = (await mateo.locator('#saldo-jugador').textContent()) === '0' ? mateo : luz;
  const conSaldo = sinSaldo === mateo ? luz : mateo;
  await valeria.getByRole('button', { name: 'Nueva ronda' }).click();
  await expect(sinSaldo.locator('#numero-ronda')).toHaveText('Ronda 02');
  await expect(sinSaldo.locator('#estado-ronda')).toHaveText('Apuestas abiertas');
  await expect(sinSaldo.locator('#saldo-jugador')).toHaveText('0');
  await expect(sinSaldo.locator('#ayuda-apuesta')).toContainText('Saldo insuficiente');
  await controles(sinSaldo, true);
  await expect(conSaldo.locator('#saldo-jugador')).toHaveText('2,000');
  await controles(conSaldo, false);
  await captura(sinSaldo, '05-saldo-insuficiente.jpg');
});

test('una mesa llena desaparece y reaparece al liberarse un asiento con el nuevo anfitrión', async ({ page, baseURL }) => {
  const clientes = [];
  try {
    async function conectar() {
      const cliente = io(baseURL, { autoConnect: false, reconnection: false });
      clientes.push(cliente);
      const conectado = once(cliente, 'connect', { signal: AbortSignal.timeout(5000) });
      cliente.connect();
      await conectado;
      return cliente;
    }
    const anfitrion = await conectar();
    const { codigo } = await anfitrion.emitWithAck('crear_sala', { nombre: 'Sol', avatar: '🙂', juego: 'dice' });
    await page.goto('/');
    const fila = page.locator(`tr[data-codigo="${codigo}"]`);
    await expect(fila).toContainText('Sol');
    for (let i = 1; i <= 5; i++) {
      const cliente = await conectar();
      expect((await cliente.emitWithAck('entrar_sala', { nombre: `Jugador ${i}`, avatar: '🐼', codigo })).ok).toBe(true);
    }
    // Comprueba el refresco automático sin hacer clic en Actualizar.
    await expect(fila).toHaveCount(0);
    await anfitrion.emitWithAck('salir_sala');
    await page.locator('#actualizar-salas').click();
    await expect(fila).toContainText('Jugador 1');
    await expect(fila).toContainText('5/6');
  } finally {
    clientes.forEach((cliente) => cliente.disconnect());
  }
});

for (const [juego, opcion, cantidad] of [['dice', 'n:6', 8], ['roulette', 'n:0', 41], ['blackjack', 'mano', 1], ['poker', 'mano', 1]]) {
  test(`${juego}: ofrece sus opciones, acepta la mínima y cierra los controles al jugar`, async ({ page, otraPagina }) => {
    const codigo = await crear(page, 'Valeria', '🦊', juego);
    if (juego === 'poker') {
      await expect(page.locator('#accion-ronda')).toBeDisabled();
      const invitado = await otraPagina();
      await invitado.goto(`/sala/${codigo}`);
      await perfil(invitado, 'Mateo', '🐼');
    }
    await page.getByRole('button', { name: 'Abrir apuestas' }).click();
    await expect(page.locator('#opcion-apuesta option')).toHaveCount(cantidad);
    await page.locator('#opcion-apuesta').selectOption(opcion);
    await page.locator('#confirmar-apuesta').click();
    await expect(page.locator('#saldo-jugador')).toHaveText('990');
    await page.locator('#accion-ronda').click();
    if (juego === 'blackjack' || juego === 'poker') {
      await expect(page.locator('#estado-ronda')).toHaveText('Es tu turno');
      await controles(page, true);
      if (juego === 'blackjack') await expect(page.locator('#cartas-mesa')).toContainText('Tu mano:');
      await page.locator('#accion-ronda').click(); // plantarse / pasar
    }
    await expect(page.locator('#fase-mesa')).toHaveText('Resultados');
    await controles(page, true);
  });
}

test('si la sala se cierra después de pulsar Entrar, el perfil explica el rechazo', async ({ page, otraPagina }) => {
  const codigo = await crear(page, 'Sol', '🙂', 'coinflip');
  const invitado = await otraPagina();
  await invitado.goto('/');
  await invitado.getByRole('link', { name: `Entrar a Cara o Cruz, sala ${codigo}` }).click();
  await page.getByRole('link', { name: 'Salir al salón' }).click();
  await expect(page.locator('#estado-directorio')).toHaveText('Todavía no hay salas abiertas');
  await invitado.getByLabel('Nombre de jugador').fill('Max');
  await expect(invitado.locator('#estado-conexion')).toHaveAttribute('data-estado', 'conectado');
  await invitado.getByRole('button', { name: 'Entrar a la sala' }).click();
  await expect(invitado.locator('#error-perfil')).toContainText('La sala no existe o ya se cerró');
  await expect(invitado.locator('#vista-mesa')).toBeHidden();
});
