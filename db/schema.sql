-- ============================================================
-- MonteCristo · Esquema de la base de datos (SQLite)
-- Fuente del diseño: docs/03-modelo-de-datos.md (sección 5),
-- adaptado a SQLite y con los campos del ticket BE-03.
-- Idempotente: puede ejecutarse mil veces sin romper nada.
-- ============================================================

-- JUGADORES: una fila por persona conectada (o que estuvo en la sala).
CREATE TABLE IF NOT EXISTS jugadores (
  id                TEXT PRIMARY KEY,
  nombre            TEXT NOT NULL,
  avatar            TEXT NOT NULL DEFAULT '🙂',
  saldo_fichas      INTEGER NOT NULL DEFAULT 1000 CHECK (saldo_fichas >= 0),
  sala_id           TEXT REFERENCES salas(id) ON DELETE SET NULL,
  asiento           INTEGER CHECK (asiento BETWEEN 1 AND 6),
  es_anfitrion      INTEGER NOT NULL DEFAULT 0 CHECK (es_anfitrion IN (0,1)),
  conectado         INTEGER NOT NULL DEFAULT 1 CHECK (conectado IN (0,1)),
  device_id         TEXT UNIQUE,
  creado_en         TEXT NOT NULL DEFAULT (datetime('now')),
  ultima_actividad  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SALAS: una fila por mesa activa.
-- ATENCIÓN: `estado` ('abierta'/'cerrada') y `fase` (momento de la ronda)
-- son DOS CAMPOS DISTINTOS: no fusionarlos ni eliminarlos.
CREATE TABLE IF NOT EXISTS salas (
  id              TEXT PRIMARY KEY,
  codigo          TEXT UNIQUE NOT NULL,
  juego           TEXT NOT NULL CHECK (juego IN ('coinflip','dice','roulette','blackjack','poker')),
  anfitrion_id    TEXT REFERENCES jugadores(id),
  capacidad       INTEGER NOT NULL DEFAULT 6 CHECK (capacidad BETWEEN 1 AND 6),
  estado          TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  fase            TEXT NOT NULL DEFAULT 'espera' CHECK (fase IN ('espera','apuestas','jugando','resultados')),
  apuesta_minima  INTEGER NOT NULL DEFAULT 10,
  creada_en       TEXT NOT NULL DEFAULT (datetime('now')),
  actualizada_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PARTIDAS: una fila por ronda jugada (historial y resultado autoritativo).
CREATE TABLE IF NOT EXISTS partidas (
  id             TEXT PRIMARY KEY,
  sala_id        TEXT NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
  numero_ronda   INTEGER NOT NULL,
  juego          TEXT NOT NULL,
  fase           TEXT NOT NULL,
  resultado      TEXT,
  bote_total     INTEGER NOT NULL DEFAULT 0,
  semilla_rng    TEXT,
  iniciada_en    TEXT NOT NULL DEFAULT (datetime('now')),
  finalizada_en  TEXT,
  UNIQUE (sala_id, numero_ronda)
);

-- APUESTAS: una fila por jugador y ronda (auditoría de cada ficha).
CREATE TABLE IF NOT EXISTS apuestas (
  id             TEXT PRIMARY KEY,
  partida_id     TEXT NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
  jugador_id     TEXT NOT NULL REFERENCES jugadores(id) ON DELETE CASCADE,
  monto          INTEGER NOT NULL CHECK (monto >= 10),
  opcion         TEXT NOT NULL,
  multiplicador  REAL NOT NULL DEFAULT 0,
  pago           INTEGER NOT NULL DEFAULT 0,
  resultado      TEXT CHECK (resultado IN ('gana','pierde','empate')),
  creada_en      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (partida_id, jugador_id)
);

-- HISTORIAL_RONDAS: una fila por jugador y ronda TERMINADA.
-- Es la tabla que alimenta el historial y las estadísticas: sala, juego,
-- jugador, apuesta, resultado y fecha en una sola fila, sin cruzar partidas
-- y apuestas. Se escribe una única vez al liquidar la ronda (append-only).
--
-- A propósito NO lleva claves foráneas: guarda una foto del código de sala y
-- del nombre del jugador para que el historial sobreviva cuando la sala se
-- cierre o el jugador se elimine (ambos se borran con CASCADE en las tablas
-- activas). La función que inserta es registrarRondaTerminada() de
-- lib/historial.js.
CREATE TABLE IF NOT EXISTS historial_rondas (
  id              TEXT PRIMARY KEY,
  sala_codigo     TEXT NOT NULL,
  juego           TEXT NOT NULL CHECK (juego IN ('coinflip','dice','roulette','blackjack','poker')),
  numero_ronda    INTEGER NOT NULL CHECK (numero_ronda >= 1),
  jugador_id      TEXT NOT NULL,
  jugador_nombre  TEXT NOT NULL,
  apuesta         INTEGER NOT NULL CHECK (apuesta >= 10),
  opcion          TEXT NOT NULL,
  resultado       TEXT NOT NULL CHECK (resultado IN ('gana','pierde','empate')),
  pago            INTEGER NOT NULL DEFAULT 0 CHECK (pago >= 0),
  fecha           TEXT NOT NULL DEFAULT (datetime('now')),
  -- Una ronda solo se registra una vez por jugador: repetirla no duplica filas.
  UNIQUE (sala_codigo, numero_ronda, jugador_id)
);

-- ÍNDICES de las búsquedas frecuentes.
CREATE INDEX IF NOT EXISTS idx_jugadores_sala   ON jugadores(sala_id);
CREATE INDEX IF NOT EXISTS idx_partidas_sala    ON partidas(sala_id);
CREATE INDEX IF NOT EXISTS idx_apuestas_partida ON apuestas(partida_id);
CREATE INDEX IF NOT EXISTS idx_apuestas_jugador ON apuestas(jugador_id);
CREATE INDEX IF NOT EXISTS idx_historial_jugador ON historial_rondas(jugador_id, fecha);
CREATE INDEX IF NOT EXISTS idx_historial_sala    ON historial_rondas(sala_codigo, fecha);
