'use strict';

// MonteCristo · servidor Express + Socket.IO
// Implementa lo descrito en docs/04-arquitectura.md:
//   - sirve la interfaz de public/
//   - expone /health, /api/salas y /api/salas/:codigo
//   - mantiene las salas en memoria y atiende crear_sala / entrar_sala / salir_sala / chat
// El servidor es autoritativo: el navegador solo envía intenciones.

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { REGLAS } = require('./lib/reglas.js');

const PUERTO = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_SALAS = Number(process.env.MAX_SALAS) > 0 ? Number(process.env.MAX_SALAS) : 50;
const JUEGOS = ['coinflip', 'dice', 'roulette', 'blackjack', 'poker'];
const ALFABETO_CODIGO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** codigo -> sala. Todo vive en memoria: al reiniciar se empieza de cero. */
const salas = new Map();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function error(codigo, mensaje) {
  const fallo = new Error(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

function generarCodigo() {
  for (let intento = 0; intento < 100; intento += 1) {
    let codigo = '';
    for (let i = 0; i < REGLAS.LONGITUD_CODIGO_SALA; i += 1) {
      codigo += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
    }
    if (!salas.has(codigo)) return codigo;
  }
  throw error('SIN_CODIGO', 'No se pudo generar un código de sala libre. Inténtalo de nuevo.');
}

function normalizarCodigo(codigo) {
  return String(codigo || '').trim().toUpperCase();
}

function validarNombre(nombre) {
  if (typeof nombre !== 'string') throw error('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');

  const limpio = nombre.trim();
  if (limpio.length === 0) throw error('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');
  if (limpio.length > 24) throw error('NOMBRE_INVALIDO', 'El nombre puede tener como máximo 24 caracteres.');
  return limpio;
}

function validarAvatar(avatar) {
  if (typeof avatar !== 'string' || avatar.trim().length === 0) {
    throw error('AVATAR_INVALIDO', 'Selecciona un avatar antes de continuar.');
  }
  return avatar.trim().slice(0, 8);
}

function validarJuego(juego) {
  if (!JUEGOS.includes(juego)) {
    throw error('JUEGO_INVALIDO', 'Elige uno de los juegos disponibles para crear la sala.');
  }
  return juego;
}

function jugadoresDeSala(sala) {
  return Array.from(sala.jugadores.values());
}

/** Vista pública de la sala: nunca incluye datos privados de otros sockets. */
function estadoDeSala(sala) {
  return {
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    anfitrionId: sala.anfitrionId,
    capacidad: REGLAS.JUGADORES_POR_SALA,
    asientosLibres: REGLAS.JUGADORES_POR_SALA - sala.jugadores.size,
    jugadores: jugadoresDeSala(sala).map((jugador) => ({
      id: jugador.id,
      nombre: jugador.nombre,
      avatar: jugador.avatar,
      fichas: jugador.fichas,
      esAnfitrion: jugador.id === sala.anfitrionId
    }))
  };
}

function difundirEstado(sala) {
  io.to(sala.codigo).emit('estado_sala', estadoDeSala(sala));
}

function crearJugador(socketId, { nombre, avatar }) {
  return {
    id: socketId,
    nombre: validarNombre(nombre),
    avatar: validarAvatar(avatar),
    fichas: REGLAS.SALDO_INICIAL,
    conectado: true
  };
}

function asignarAnfitrion(sala) {
  const siguiente = jugadoresDeSala(sala)[0];
  sala.anfitrionId = siguiente ? siguiente.id : null;
}

/** Quita al jugador de su sala y limpia la sala si queda vacía. */
function abandonarSala(socket) {
  const codigo = socket.data.codigoSala;
  if (!codigo) return;

  const sala = salas.get(codigo);
  socket.data.codigoSala = null;
  socket.leave(codigo);

  if (!sala) return;

  sala.jugadores.delete(socket.id);

  if (sala.jugadores.size === 0) {
    salas.delete(codigo);
    return;
  }

  if (sala.anfitrionId === socket.id) asignarAnfitrion(sala);
  difundirEstado(sala);
}

// ---------------------------------------------------------------------------
// Express: archivos estáticos y API HTTP
// ---------------------------------------------------------------------------

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/salas', (req, res) => {
  const lista = Array.from(salas.values()).map((sala) => ({
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    jugadores: sala.jugadores.size,
    capacidad: REGLAS.JUGADORES_POR_SALA
  }));
  res.json({ ok: true, salas: lista });
});

app.get('/api/salas/:codigo', (req, res) => {
  const codigo = normalizarCodigo(req.params.codigo);
  const sala = salas.get(codigo);

  if (!sala) {
    res.status(404).json({ ok: false, existe: false, codigo, error: 'La sala no existe o ya se cerró.' });
    return;
  }

  res.json({
    ok: true,
    existe: true,
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    asientosLibres: REGLAS.JUGADORES_POR_SALA - sala.jugadores.size
  });
});

// ---------------------------------------------------------------------------
// Socket.IO: eventos de docs/04-arquitectura.md
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.data.codigoSala = null;

  socket.on('crear_sala', (datos, ack) => {
    try {
      if (salas.size >= MAX_SALAS) {
        throw error('LIMITE_SALAS', 'Se alcanzó el máximo de salas activas. Inténtalo más tarde.');
      }

      const juego = validarJuego(datos && datos.juego);
      const jugador = crearJugador(socket.id, datos || {});
      const codigo = generarCodigo();

      const sala = {
        codigo,
        juego,
        fase: 'espera',
        anfitrionId: socket.id,
        creadaEn: Date.now(),
        jugadores: new Map([[jugador.id, jugador]])
      };

      salas.set(codigo, sala);
      abandonarSala(socket);
      socket.data.codigoSala = codigo;
      socket.join(codigo);

      socket.emit('estado_sala', estadoDeSala(sala));
      if (typeof ack === 'function') ack({ ok: true, codigo });
    } catch (fallo) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: fallo.codigo || 'ERROR', mensaje: fallo.message } });
      }
    }
  });

  socket.on('entrar_sala', (datos, ack) => {
    try {
      const codigo = normalizarCodigo(datos && datos.codigo);
      if (!new RegExp(`^[A-Z0-9]{${REGLAS.LONGITUD_CODIGO_SALA}}$`).test(codigo)) {
        throw error('CODIGO_INVALIDO', 'El código de sala no es válido. Debe tener cinco letras o números.');
      }

      const sala = salas.get(codigo);
      if (!sala) throw error('SALA_NO_ENCONTRADA', 'La sala no existe o ya se cerró.');
      if (sala.jugadores.size >= REGLAS.JUGADORES_POR_SALA) {
        throw error('SALA_LLENA', `La sala ya tiene ${REGLAS.JUGADORES_POR_SALA} jugadores.`);
      }

      const jugador = crearJugador(socket.id, datos || {});
      sala.jugadores.set(jugador.id, jugador);

      abandonarSala(socket);
      socket.data.codigoSala = codigo;
      socket.join(codigo);

      difundirEstado(sala);
      if (typeof ack === 'function') ack({ ok: true, codigo });
    } catch (fallo) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: fallo.codigo || 'ERROR', mensaje: fallo.message } });
      }
    }
  });

  socket.on('salir_sala', (datos, ack) => {
    abandonarSala(socket);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('chat', (datos, ack) => {
    const codigo = socket.data.codigoSala;
    const sala = codigo ? salas.get(codigo) : null;
    const jugador = sala ? sala.jugadores.get(socket.id) : null;
    const texto = typeof (datos && datos.texto) === 'string' ? datos.texto.trim() : '';

    if (!sala || !jugador) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: 'SIN_SALA', mensaje: 'No estás dentro de una sala.' } });
      }
      return;
    }

    if (texto.length === 0 || texto.length > 200) {
      if (typeof ack === 'function') {
        ack({ ok: false, error: { codigo: 'MENSAJE_INVALIDO', mensaje: 'El mensaje debe tener entre 1 y 200 caracteres.' } });
      }
      return;
    }

    io.to(codigo).emit('chat_mensaje', {
      nombre: jugador.nombre,
      texto,
      hora: new Date().toISOString()
    });

    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    abandonarSala(socket);
  });
});

// ---------------------------------------------------------------------------
// Arranque y apagado ordenado
// ---------------------------------------------------------------------------

servidor.listen(PUERTO, HOST, () => {
  console.log(`MonteCristo escuchando en http://localhost:${PUERTO}`);
  console.log('Fichas 100 % virtuales; no hay dinero real.');
});

function apagar(senal) {
  console.log(`\n${senal} recibido: cerrando MonteCristo…`);
  io.close(() => {
    servidor.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => apagar('SIGINT'));
process.on('SIGTERM', () => apagar('SIGTERM'));
