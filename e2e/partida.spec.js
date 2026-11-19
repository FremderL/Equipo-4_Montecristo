'use strict';

const { test, expect, crear, entrarEn, captura } = require('./apoyo.js');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ video: process.env.EVIDENCIA_DIR ? { mode: 'on', size: { width: 1366, height: 820 } } : 'off' });

async function apostar(pagina, monto, opcion) {
  if (opcion) await pagina.getByLabel('Opción de juego').selectOption(opcion);
  await pagina.getByLabel('Monto en fichas').fill(String(monto));
  await pagina.locator('#confirmar-apuesta').click();
  await expect(pagina.locator('#texto-confirmar')).toHaveText('Apuesta confirmada');
}

async function escribir(pagina, texto) {
  const campo = pagina.getByLabel('Mensaje para la sala');
  await campo.fill(texto);
  await campo.press('Enter');
  await expect(campo).toHaveValue('');
}

test('turnos y chat durante una mano: nombre, Enter, mensajes entre rondas y aislamiento de otra sala', async ({ page: ines, otraPagina }) => {
  const codigo = await crear(ines, 'Inés', '🦊', 'blackjack');
  const diego = await otraPagina();
  await entrarEn(diego, codigo, 'Diego', '🐼');
  const luz = await otraPagina();
  await crear(luz, 'Luz', '🦉', 'roulette');
  await luz.getByRole('tab', { name: 'Chat de sala' }).click();
  await ines.getByRole('button', { name: 'Abrir apuestas' }).click();
  await apostar(ines, 50);
  await apostar(diego, 30);
  await ines.getByRole('button', { name: 'Repartir cartas' }).click();
  await expect(ines.locator('#estado-ronda')).toHaveText('Es tu turno');
  await expect(diego.locator('#estado-ronda')).toHaveText('Turno de Inés');
  await ines.getByRole('button', { name: 'Plantarse' }).click();
  await expect(ines.locator('#asientos .asiento--turno strong')).toHaveText('Diego');
  await expect(ines.locator('#detalle-ronda')).toHaveText('Turno 2 de 2');
  await expect(diego.locator('#estado-ronda')).toHaveText('Es tu turno');
  await captura(ines, '01-turno.jpg', { fullPage: true });

  await diego.getByRole('tab', { name: 'Chat de sala' }).click();
  await diego.getByLabel('Mensaje para la sala').fill('  ');
  await expect(diego.getByRole('button', { name: 'Enviar mensaje' })).toBeDisabled();
  await diego.getByLabel('Mensaje para la sala').press('Enter');
  await expect(diego.locator('#mensajes-chat li')).toHaveCount(0);
  await escribir(diego, '¿Lista para la siguiente mano, Inés?');
  await expect(ines.locator('#no-leidos')).toHaveText('1');
  await ines.getByRole('tab', { name: /Chat de sala/ }).click();
  await escribir(ines, '¡Lista, Diego! Cierra tu turno cuando quieras.');
  for (const p of [ines, diego]) {
    await expect(p.locator('#mensajes-chat li')).toHaveCount(2);
    await expect(p.locator('#mensajes-chat p')).toHaveText(['¿Lista para la siguiente mano, Inés?', '¡Lista, Diego! Cierra tu turno cuando quieras.']);
    await expect(p.locator('#no-leidos')).toBeHidden();
  }
  await expect(ines.locator('#mensajes-chat strong')).toHaveText(['Diego', 'Inés · Tú']);
  await expect(diego.locator('#mensajes-chat strong')).toHaveText(['Diego · Tú', 'Inés']);
  await captura(ines, '02-chat.jpg', { fullPage: true });
  await escribir(luz, 'Aquí jugamos a la ruleta.');
  await expect(luz.locator('#mensajes-chat p')).toHaveText(['Aquí jugamos a la ruleta.']);
  await expect(ines.locator('#mensajes-chat li')).toHaveCount(2);
  await captura(luz, '03-otra-sala.jpg', { fullPage: true });

  const [cierre] = await Promise.all([
    ines.evaluate(() => new Promise((ok) => socket.once('resultado', ok))),
    diego.getByRole('button', { name: 'Plantarse' }).click()
  ]);
  await expect(ines.locator('#fase-mesa')).toHaveText('Resultados');
  await expect(ines.locator('#panel-chat')).toBeVisible(); // el resultado no interrumpe una conversación
  await ines.getByRole('tab', { name: 'Balance' }).click();
  await expect(ines.locator('#estado-ronda')).toHaveText(`Casa: ${cierre.resultado.casa.puntos} puntos`);
  expect(cierre.apuestas.map((a) => a.nombre)).toEqual(['Inés', 'Diego']);
  for (const a of cierre.apuestas) {
    expect(a.neto).toBe(a.pago - a.monto);
    const fila = ines.locator('#filas-balance tr').filter({ hasText: a.nombre });
    await expect(fila.locator('td')).toHaveText([String(a.pago), a.neto > 0 ? `+${a.neto}` : String(a.neto)]);
    const asiento = ines.locator('#asientos li').filter({ hasText: a.nombre });
    await expect(asiento.locator('.asiento__saldo')).toHaveText(`${(1000 + a.neto).toLocaleString('es-MX')} fichas`);
  }
  await ines.getByRole('button', { name: 'Nueva ronda' }).click();
  await expect(ines.locator('#balance-ronda')).toBeHidden();
  await ines.getByRole('tab', { name: 'Chat de sala' }).click();
  await expect(ines.locator('#mensajes-chat li')).toHaveCount(2);
});

// Solo observa avisos y tiempos del navegador; no fija el resultado ni modifica el reloj o el DOM.
async function observarRevelaciones(pagina) {
  await pagina.evaluate(() => {
    const medicion = window.medicionRonda = { avisos: [], intervalosMs: [] };
    socket.on('resultado', ({ numeroRonda, resultado, apuestas }) => medicion.avisos.push({
      numeroRonda, resultado, apuestas: apuestas.map(({ nombre, monto, pago, neto }) => ({ nombre, monto, pago, neto }))
    }));
    const boton = document.getElementById('saltar-animacion');
    let inicio = null;
    new MutationObserver(() => {
      if (!boton.hidden && inicio == null) inicio = performance.now();
      else if (boton.hidden && inicio != null) {
        medicion.intervalosMs.push(Math.round(performance.now() - inicio));
        inicio = null;
      }
    }).observe(boton, { attributes: true, attributeFilter: ['hidden'] });
  });
}

test.describe('Revelación del servidor', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('duración natural, salto con Escape o botón, netos idénticos y entrada tardía sin repetir la animación', async ({ page: ines, context, otraPagina }) => {
    const codigo = await crear(ines, 'Inés', '🦊', 'coinflip');
    const diego = await otraPagina();
    await entrarEn(diego, codigo, 'Diego', '🐼');
    await diego.emulateMedia({ reducedMotion: 'reduce' });
    await observarRevelaciones(ines);
    await observarRevelaciones(diego);
    await ines.getByRole('button', { name: 'Abrir apuestas' }).click();
    await apostar(ines, 100, 'cara');
    await apostar(diego, 100, 'cruz');
    await expect(ines.locator('#pieza-resultado')).toBeHidden();
    await ines.getByRole('button', { name: 'Lanzar moneda' }).click();
    const saltar = ines.getByRole('button', { name: 'Saltar animación' });
    await expect(saltar).toBeVisible();
    const duracion = await ines.locator('#pieza-resultado').evaluate((pieza) => pieza.getAnimations()[0].effect.getTiming().duration);
    expect(duracion).toBe(1400);
    if (process.env.EVIDENCIA_DIR) {
      // Capturar la cara ya legible durante el giro, sin pausar o modificar la animación.
      await ines.waitForFunction(() => document.getElementById('pieza-resultado').getAnimations()[0]?.currentTime >= 450);
      await captura(ines, '04-animacion.jpg', { animations: 'allow', fullPage: true });
    }
    await expect(saltar).toBeHidden({ timeout: 2500 });
    const aviso = await ines.evaluate(() => window.medicionRonda.avisos[0]);
    for (const p of [ines, diego]) {
      await expect(p.locator('#estado-ronda')).toHaveText(`Salió ${aviso.resultado.lado}`);
      await expect(p.locator('#pieza-resultado')).toHaveText(aviso.resultado.lado);
      for (const a of aviso.apuestas) {
        const fila = p.locator('#filas-balance tr').filter({ hasText: a.nombre });
        expect(a.neto).toBe(a.nombre === (aviso.resultado.lado === 'cara' ? 'Inés' : 'Diego') ? 100 : -100);
        await expect(fila.locator('td').first()).toHaveText(String(a.pago));
        await expect(fila.locator('td').last()).toHaveText(a.neto > 0 ? '+100' : '-100');
      }
    }
    expect(await diego.evaluate(() => window.medicionRonda.intervalosMs)).toEqual([]);
    const luz = await otraPagina();
    await entrarEn(luz, codigo, 'Luz', '🦉'); // solo recibe estado_sala; no el evento anterior
    await expect(luz.locator('#estado-ronda')).toHaveText(`Salió ${aviso.resultado.lado}`);
    await expect(luz.locator('#saltar-animacion')).toBeHidden();
    await expect(luz.locator('#filas-balance tr').filter({ hasText: 'Luz' })).toContainText('Sin apuesta');
    await expect(ines.locator('#filas-balance tr')).toHaveCount(3);
    await expect(ines.locator('#saltar-animacion')).toBeHidden(); // la entrada de Luz no repite el efecto
    await captura(ines, '05-balance.jpg', { fullPage: true });

    await ines.getByRole('button', { name: 'Nueva ronda' }).click();
    await apostar(ines, 10, 'cruz');
    await ines.getByRole('button', { name: 'Lanzar moneda' }).click();
    await expect(saltar).toBeVisible();
    const saldoLiquidado = await ines.evaluate(() => 1000 + window.medicionRonda.avisos.reduce((s, r) => s + r.apuestas.find((a) => a.nombre === 'Inés').neto, 0));
    await expect(ines.locator('#saldo-jugador')).toHaveText(saldoLiquidado.toLocaleString('es-MX'));
    const saldo = await ines.locator('#saldo-jugador').textContent();
    const resultado = await ines.locator('#estado-ronda').textContent();
    await Promise.all([ines.keyboard.press('Escape'), luz.getByRole('button', { name: 'Saltar animación' }).click()]);
    await expect(luz.locator('#saltar-animacion')).toBeHidden();
    await expect(saltar).toBeHidden();
    expect(await ines.locator('#pieza-resultado').evaluate((el) => el.getAnimations().length)).toBe(0);
    await expect(ines.locator('#estado-ronda')).toHaveText(resultado);
    await expect(ines.locator('#saldo-jugador')).toHaveText(saldo);
    const medidas = await ines.evaluate(() => window.medicionRonda);
    expect(medidas.avisos).toHaveLength(2);
    expect(medidas.intervalosMs).toHaveLength(2);
    expect(medidas.intervalosMs[0]).toBeGreaterThan(1200);
    expect(medidas.intervalosMs[0]).toBeLessThan(2500);
    expect(medidas.intervalosMs[1]).toBeLessThan(duracion);
    if (process.env.EVIDENCIA_DIR) {
      await mkdir(process.env.EVIDENCIA_DIR, { recursive: true });
      const informe = { avisos: medidas.avisos, duracionProgramadaMs: duracion,
        duracionObservadaMs: medidas.intervalosMs[0], conSaltoMs: medidas.intervalosMs[1],
        saldoAntesDeSaltar: saldo, saldoDespuesDeSaltar: await ines.locator('#saldo-jugador').textContent() };
      await writeFile(path.join(process.env.EVIDENCIA_DIR, 'mediciones.json'), JSON.stringify(informe, null, 2) + '\n');
      const video = ines.video();
      await context.close();
      await video.saveAs(path.join(process.env.EVIDENCIA_DIR, 'animacion-y-salto.webm'));
    }
  });
});

test('un cambio de ronda cancela el efecto; una desconexión limpia la conversación', async ({ page, otraPagina }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const codigo = await crear(page, 'Inés', '🦊', 'dice');
  const otro = await otraPagina();
  await entrarEn(otro, codigo, 'Diego', '🐼');
  await page.getByRole('tab', { name: 'Chat de sala' }).click();
  await escribir(page, '¡Buena ronda!');
  await page.getByRole('tab', { name: 'Apuesta' }).click();
  await page.getByRole('button', { name: 'Abrir apuestas' }).click();
  await apostar(page, 10, 'alto');
  const [aviso] = await Promise.all([
    page.evaluate(() => new Promise((ok) => socket.once('resultado', ok))),
    page.getByRole('button', { name: 'Lanzar dado' }).click()
  ]);
  await expect(page.locator('#pieza-resultado .punto')).toHaveCount(aviso.resultado.numero);
  await expect(page.locator('#saltar-animacion')).toBeVisible();
  await page.getByRole('button', { name: 'Nueva ronda' }).click();
  await expect(page.locator('#pieza-resultado')).toBeHidden();
  await expect(page.locator('#saltar-animacion')).toBeHidden();
  await expect(page.locator('#estado-ronda')).toHaveText('Apuestas abiertas');
  await page.getByRole('tab', { name: 'Chat de sala' }).click();
  await page.getByLabel('Mensaje para la sala').fill('Borrador');
  await page.evaluate(() => socket.disconnect());
  await expect(page.locator('#vista-perfil')).toBeVisible();
  await page.evaluate(() => { socket.connect(); });
  await expect(page.locator('#estado-conexion')).toHaveAttribute('data-estado', 'conectado');
  await page.getByRole('button', { name: 'Entrar a la sala' }).click();
  await page.getByRole('tab', { name: 'Chat de sala' }).click();
  await expect(page.locator('#mensajes-chat li')).toHaveCount(0);
  await expect(page.getByLabel('Mensaje para la sala')).toHaveValue('');
});

test('la mesa anuncia una decisión automática y no borra del balance a quien abandonó', async ({ page: ines, otraPagina }) => {
  const codigo = await crear(ines, 'Inés', '🦊', 'poker');
  const diego = await otraPagina();
  await entrarEn(diego, codigo, 'Diego', '🐼');
  await ines.getByRole('button', { name: 'Abrir apuestas' }).click();
  await apostar(ines, 50);
  await apostar(diego, 50);
  await ines.getByRole('button', { name: 'Repartir cartas' }).click();
  await expect(diego.locator('#estado-ronda')).toHaveText('Turno de Inés');
  await ines.getByRole('link', { name: 'Salir al salón' }).click();
  await expect(diego.locator('#aviso-automatico')).toContainText('Inés · El jugador salió de la mesa');
  await expect(diego.locator('#estado-ronda')).toHaveText('Es tu turno');
  await diego.getByRole('button', { name: 'Pasar' }).click();
  await expect(diego.locator('#filas-balance tr').filter({ hasText: 'Inés' }).locator('td').last()).toHaveText('-50');
  await expect(diego.locator('#filas-balance tr').filter({ hasText: 'Diego' }).locator('td').last()).toHaveText('0');
});

test('con movimiento reducido la ruleta muestra directamente el número y el color del servidor', async ({ page }) => {
  await crear(page, 'Inés', '🦊', 'roulette');
  await page.getByRole('button', { name: 'Abrir apuestas' }).click();
  await apostar(page, 10, 'n:0');
  const [aviso] = await Promise.all([
    page.evaluate(() => new Promise((ok) => socket.once('resultado', ok))),
    page.getByRole('button', { name: 'Girar ruleta' }).click()
  ]);
  await expect(page.locator('#pieza-resultado')).toHaveText(String(aviso.resultado.numero));
  await expect(page.locator('#pieza-resultado')).toHaveAttribute('data-color', aviso.resultado.color);
  await expect(page.locator('#estado-ronda')).toHaveText(`Salió el ${aviso.resultado.numero} · ${aviso.resultado.color}`);
  await expect(page.locator('#saltar-animacion')).toBeHidden();
  expect(await page.locator('#pieza-resultado').evaluate((el) => el.getAnimations().length)).toBe(0);
});
