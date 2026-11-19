'use strict';
const { defineConfig } = require('@playwright/test');
const baseURL = 'http://127.0.0.1:3198';

module.exports = defineConfig({
  testDir: './e2e',
  workers: 1, // las pruebas comparten un directorio de salas en memoria
  expect: { timeout: 8000 },
  use: {
    baseURL, viewport: { width: 1366, height: 820 }, locale: 'es-MX', reducedMotion: 'reduce',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
    screenshot: 'only-on-failure'
  },
  webServer: { command: 'node server.js', url: `${baseURL}/health`, env: { PORT: '3198', HOST: '127.0.0.1', DB_FILE: ':memory:' } }
});
