# Ticket 05 · Despliegue en Render

| Campo | Valor |
| --- | --- |
| **ID** | DOC-05 |
| **Tipo** | Despliegue (infraestructura) |
| **Estado** | listo para desplegar |
| **Prioridad** | Alta |
| **Depende de** | DOC-04 (arquitectura), `server.js`, `package.json` |
| **Desbloquea** | URL pública del proyecto |
| **Archivos** | `render.yaml`, `.renderignore`, `.nvmrc` |

> La v1 guarda el estado en **memoria del proceso** y usa SQLite solo como capa de datos
> (schema en `db/schema.sql`, migración en `db/migrar.js`). Por eso el despliegue mínimo es
> **un Web Service Node.js**: no requiere base de datos gestionada ni disco duradero.

---

## 1. Recursos creados

| Recurso | Archivo | Qué hace |
| --- | --- | --- |
| **Web Service** | `render.yaml` | Ejecuta Express + Socket.IO: sirve `public/`, la API REST y el WebSocket. |
| **Ignora build** | `.renderignore` | Excluye `node_modules`, `.git` y archivos `.db` del bundle de deploy. |
| **Versión de Node** | `.nvmrc` | Fija Node 20 LTS (compatible con `better-sqlite3` v11). |

## 2. `render.yaml`

```yaml
services:
  - type: web
    name: montecristo
    runtime: node
    plan: free
    buildCommand: npm ci
    startCommand: npm run db:migrar && npm start
    healthCheckPath: /health
    autoDeploy: true
    envVars:
      - key: NODE_ENV
        value: production
      - key: MAX_SALAS
        value: "50"
```

- `buildCommand: npm ci`: instalar dependencias con el *lockfile*.
- `startCommand`: aplica el schema (`db/migrar.js`, idempotente) y arranca `server.js`.
- `healthCheckPath: /health`: `server.js` responde `{"ok":true}` — Render lo usa para admitir tráfico.
- `autoDeploy: true`: cada *push* a `main` redeploya.

## 3. Planes: free vs pago

| Característica | `free` (Hobby) | `starter` / profesional |
| --- | --- | --- |
| Disco persistente | ❌ no admite | ✅ sí |
| Apagado por inactividad | 15 min (cold start) | siempre activa |
| WebSocket / URL pública | sí | sí |
| Migración SQLite | efímera (se pierde al redeploy) | duradera con disco |

**Variante paid** (disco en `/data`):

```yaml
services:
  - type: web
    name: montecristo
    runtime: node
    plan: starter
    buildCommand: npm ci
    startCommand: npm run db:migrar && npm start
    healthCheckPath: /health
    autoDeploy: true
    disk:
      name: montecristo-data
      mountPath: /data
      sizeGB: 1
    envVars:
      - key: NODE_ENV
        value: production
      - key: MAX_SALAS
        value: "50"
      - key: DB_FILE
        value: /data/casino.db
```

## 4. Cómo desplegar

1. [render.com](https://render.com) → **New** → **Blueprint**.
2. Conecta `FremderL/Equipo-4_Montecristo`.
3. Render detecta `render.yaml` y crea el servicio **montecristo** (plan `free`).
4. Espera al *build*: `npm ci` compila `better-sqlite3` y corre `db:migrar`.
5. El *health check* `/health` devuelve `200` → Render marca el servicio **Live**.
6. Abre la URL pública `https://<service>.onrender.com`.

## 5. Variables de entorno en Render

| Variable | Origen |
| --- | --- |
| `PORT` | Render asigna automáticamente |
| `NODE_ENV` | `production` (blueprint) |
| `MAX_SALAS` | `50` (blueprint) |
| `DB_FILE` | `data/casino.db` (efímero en free) |
| `HOST` | `0.0.0.0` por defecto en `server.js` |

## 6. Evidencia para subir al ticket

1. **Captura del dashboard** de Render: servicio **montecristo** en **Live**.
2. **Log de deploy** en verde: `npm ci` → `db:migrar` → `MonteCristo escuchando en …`.
3. **URL pública** del servicio (`*.onrender.com`).
4. **`GET /health`** devolviendo `{"ok":true}`.
5. **`npm test`** con las pruebas verdes (unitarios de reglas/pagos/fases; `db.test.js` requiere el `better-sqlite3` nativo).
6. (Opcional) **Captura del navegador** con una sala creada.

## 7. Opciones futuras

- **Render Postgres** si migran de SQLite a PostgreSQL (DOC-03 lo documenta como posible).
- **Cron job / one-off** para tareas de mantenimiento.
- **Dominio propio** y HTTPS (ya incluidos por Render).
