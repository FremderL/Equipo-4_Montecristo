'use strict';

const { test: base, expect } = require('@playwright/test');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');

const test = base.extend({
  otraPagina: async ({ browser }, use) => {
    const paginas = [];
    await use(async () => {
      const pagina = await browser.newPage(); // contexto, almacenamiento y socket propios
      paginas.push(pagina);
      return pagina;
    });
    await Promise.all(paginas.map((pagina) => pagina.close()));
  }
});

async function captura(pagina, archivo, opciones = {}) {
  if (!process.env.EVIDENCIA_DIR) return;
  await mkdir(process.env.EVIDENCIA_DIR, { recursive: true });
  await pagina.screenshot({ path: path.join(process.env.EVIDENCIA_DIR, archivo), quality: 90, animations: 'disabled', ...opciones });
}

async function perfil(pagina, nombre, avatar, juego) {
  await expect(pagina.locator('#estado-conexion')).toHaveAttribute('data-estado', 'conectado');
  await pagina.getByLabel('Nombre de jugador').fill(nombre);
  await pagina.locator(`[data-avatar="${avatar}"]`).click();
  if (juego) await pagina.getByLabel('Juego de la sala').selectOption(juego);
  await pagina.locator('#boton-continuar').click();
  await expect(pagina.locator('#vista-mesa')).toBeVisible();
  await expect(pagina.locator('.asiento--propio strong')).toHaveText(nombre);
  return pagina.locator('#codigo-creado').textContent();
}

async function crear(pagina, nombre, avatar, juego) {
  await pagina.goto('/');
  await pagina.locator('#crear-sala').click();
  return perfil(pagina, nombre, avatar, juego);
}

async function entrarEn(pagina, codigo, nombre, avatar) {
  await pagina.goto(`/sala/${codigo}`);
  return perfil(pagina, nombre, avatar);
}

module.exports = { test, expect, perfil, crear, entrarEn, captura };
