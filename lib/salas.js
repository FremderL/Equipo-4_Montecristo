'use strict';

// MonteCristo · estructura y almacén de salas en memoria (DOC-01 §4–6 · DOC-03 §2–4)
//
// Cada sala en memoria concentra los cuatro datos que gobiernan una mesa:
//   1. `juego`        el juego elegido al crearla (inmutable durante la vida de la sala)
//   2. `jugadores`    quienes están sentados (Map jugadorId → jugador, asientos únicos 1…6)
//   3. `anfitrionId`  quién controla el arranque, el lanzamiento/reparto y la siguiente ronda
//   4. `fase`         en qué paso va la ronda (`espera` → `apuestas` → `jugando` → `resultados`)
//
// El módulo es puro: no conoce Express, Socket.IO ni SQLite. `server.js` lo usa para
// crear salas, sentar o retirar jugadores, transferir el anfitrión, avanzar la fase y
// construir la vista pública `estado_sala` sin filtrar datos privados ni semillas.

const crypto = require('node:crypto');
const { REGLAS, FASES } = require('./reglas.js');
const {
  puedeTransicionar,
  cambiarFase,
  fasePermiteAccion,
  cancelarTemporizadores,
  minimoJugadores,
  esAnfitrion
} = require('./ronda.js');
const { tiempoDeTurno } = require('./turno.js');
const { vistaDeApuesta } = require('./lanzamiento.js');

/** Los cinco juegos incluidos en la v1 (DOC-01 §3 · DOC-03 §2). */
const JUEGOS = Object.freeze(['coinflip', 'dice', 'roulette', 'blackjack', 'poker']);

/**
 * Ciclo de vida de la sala, separado de `fase` (db/schema.sql · DOC-03 §2):
 * una sala abierta recorre rondas; al quedarse vacía pasa a `cerrada`.
 */
const ESTADOS_SALA = Object.freeze({
  ABIERTA: 'abierta',
  CERRADA: 'cerrada'
});

/** Tope de salas activas simultáneas por servidor (DOC-01 §10 · DOC-04 §6.5). */
const MAX_SALAS_POR_DEFECTO = 50;

const ALFABETO_CODIGO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PATRON_CODIGO_ENTRADA = new RegExp(`^[A-Za-z0-9]{${REGLAS.LONGITUD_CODIGO_SALA}}$`);
const MAX_INTENTOS_CODIGO = 100;
const MAX_LARGO_ID = 64;
const MAX_LARGO_NOMBRE = 24;
const MAX_LARGO_AVATAR = 8;

const MARCA_JUGADOR = Symbol('montecristo.jugador');

// ---------------------------------------------------------------------------
// Errores y utilidades internas
// ---------------------------------------------------------------------------

function errorSala(codigo, mensaje) {
  const fallo = new Error(mensaje);
  fallo.codigo = codigo;
  return fallo;
}

function marcaDeTiempo(fuente) {
  if (typeof fuente === 'function') return Number(fuente());
  if (Number.isFinite(fuente)) return Number(fuente);
  return Date.now();
}

function clonarPlano(valor) {
  if (valor === null || typeof valor !== 'object') return valor;
  if (Array.isArray(valor)) return valor.map(clonarPlano);
  const copia = {};
  for (const [clave, elemento] of Object.entries(valor)) {
    copia[clave] = clonarPlano(elemento);
  }
  return copia;
}

// ---------------------------------------------------------------------------
// Validaciones de sala y jugador
// ---------------------------------------------------------------------------

/** Limpia espacios y pasa a mayúsculas un código recibido. */
function normalizarCodigo(codigo) {
  if (typeof codigo !== 'string') return '';
  return codigo.trim().toUpperCase();
}

/** Exige exactamente 5 caracteres ASCII alfanuméricos y lo devuelve en mayúsculas. */
function validarCodigo(codigo) {
  if (typeof codigo !== 'string') {
    throw errorSala('CODIGO_INVALIDO', 'El código de sala no es válido. Debe tener cinco letras o números.');
  }
  const recortado = codigo.trim();
  if (!PATRON_CODIGO_ENTRADA.test(recortado)) {
    throw errorSala('CODIGO_INVALIDO', 'El código de sala no es válido. Debe tener cinco letras o números.');
  }
  return recortado.toUpperCase();
}

/** Genera un código de 5 caracteres en mayúsculas libre en `salasActivas`. */
function generarCodigoSala(salasActivas = null, enteroAleatorio = crypto.randomInt) {
  const estaOcupado = salasActivas && typeof salasActivas.has === 'function'
    ? (codigo) => salasActivas.has(codigo)
    : () => false;

  for (let intento = 0; intento < MAX_INTENTOS_CODIGO; intento += 1) {
    let codigo = '';
    for (let i = 0; i < REGLAS.LONGITUD_CODIGO_SALA; i += 1) {
      codigo += ALFABETO_CODIGO[enteroAleatorio(ALFABETO_CODIGO.length)];
    }
    if (!estaOcupado(codigo)) return codigo;
  }

  throw errorSala('SIN_CODIGO', 'No se pudo generar un código de sala libre. Inténtalo de nuevo.');
}

function validarJuego(juego) {
  if (typeof juego !== 'string' || !JUEGOS.includes(juego)) {
    throw errorSala('JUEGO_INVALIDO', 'Elige uno de los juegos disponibles para crear la sala.');
  }
  return juego;
}

function validarIdJugador(id) {
  if (typeof id !== 'string') {
    throw errorSala('JUGADOR_INVALIDO', 'El identificador del jugador no es válido.');
  }
  const limpio = id.trim();
  if (limpio.length === 0 || limpio.length > MAX_LARGO_ID) {
    throw errorSala('JUGADOR_INVALIDO', 'El identificador del jugador no es válido.');
  }
  return limpio;
}

function validarNombre(nombre) {
  if (typeof nombre !== 'string') {
    throw errorSala('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');
  }
  const limpio = nombre.trim();
  if (limpio.length === 0) {
    throw errorSala('NOMBRE_INVALIDO', 'Escribe tu nombre para continuar.');
  }
  if (limpio.length > MAX_LARGO_NOMBRE) {
    throw errorSala('NOMBRE_INVALIDO', `El nombre puede tener como máximo ${MAX_LARGO_NOMBRE} caracteres.`);
  }
  return limpio;
}

function validarAvatar(avatar) {
  if (typeof avatar !== 'string' || avatar.trim().length === 0) {
    throw errorSala('AVATAR_INVALIDO', 'Selecciona un avatar antes de continuar.');
  }
  const limpio = avatar.trim();
  if (limpio.length <= MAX_LARGO_AVATAR) return limpio;

  // Evita cortar un par subrogado UTF-16 (emoji) por la mitad.
  const recorte = limpio.slice(0, MAX_LARGO_AVATAR);
  const ultimo = recorte.charCodeAt(recorte.length - 1);
  const seguro = ultimo >= 0xD800 && ultimo <= 0xDBFF ? recorte.slice(0, -1) : recorte;
  if (seguro.length === 0) {
    throw errorSala('AVATAR_INVALIDO', 'Selecciona un avatar antes de continuar.');
  }
  return seguro;
}

function validarFichas(fichas) {
  if (!Number.isInteger(fichas) || fichas < 0) {
    throw errorSala('SALDO_INVALIDO', 'El saldo de fichas debe ser un número entero mayor o igual a cero.');
  }
  return fichas;
}

/** Comprueba que el objeto tenga la forma de una sala en memoria. */
function esSala(sala) {
  return Boolean(sala)
    && typeof sala === 'object'
    && typeof sala.codigo === 'string'
    && JUEGOS.includes(sala.juego)
    && Object.values(FASES).includes(sala.fase)
    && sala.jugadores instanceof Map
    && Array.isArray(sala.apuestas);
}

function exigirSala(sala) {
  if (!esSala(sala)) {
    throw errorSala('SALA_INVALIDA', 'Se requiere un objeto sala válido.');
  }
  return sala;
}

function exigirSalaAbierta(sala) {
  exigirSala(sala);
  if (sala.estado === ESTADOS_SALA.CERRADA) {
    throw errorSala('SALA_CERRADA', 'La sala ya se cerró.');
  }
  return sala;
}

// ---------------------------------------------------------------------------
// Jugador y sala en memoria (DOC-03 §2–4)
// ---------------------------------------------------------------------------

/**
 * Crea el registro en memoria de un jugador antes de sentarlo en una sala.
 * Empieza con `REGLAS.SALDO_INICIAL` (1.000 fichas) salvo que se indique otro saldo entero ≥ 0.
 */
function crearJugador(id, datos = {}, opciones = {}) {
  const ahora = marcaDeTiempo(opciones.ahora);
  const jugadorId = validarIdJugador(id);
  const nombre = validarNombre(datos && datos.nombre);
  const avatar = validarAvatar(datos && datos.avatar);
  const fichas = datos && datos.fichas !== undefined
    ? validarFichas(datos.fichas)
    : REGLAS.SALDO_INICIAL;
  const conectado = datos && datos.conectado !== undefined ? Boolean(datos.conectado) : true;

  const jugador = {
    id: jugadorId,
    nombre,
    avatar,
    fichas,
    salaId: null,
    asiento: null,
    esAnfitrion: false,
    conectado,
    creadoEn: ahora,
    ultimaActividad: ahora
  };

  Object.defineProperty(jugador, MARCA_JUGADOR, { value: true });
  return jugador;
}

function prepararJugador(entrada, opciones = {}) {
  if (!entrada || typeof entrada !== 'object') {
    throw errorSala(
      opciones.codigoFalta || 'JUGADOR_INVALIDO',
      opciones.mensajeFalta || 'Faltan los datos del jugador.'
    );
  }

  if (entrada[MARCA_JUGADOR] === true) {
    validarIdJugador(entrada.id);
    validarNombre(entrada.nombre);
    validarAvatar(entrada.avatar);
    validarFichas(entrada.fichas);
    if (entrada.salaId !== null || entrada.asiento !== null) {
      throw errorSala('JUGADOR_EN_OTRA_SALA', 'El jugador ya ocupa un asiento en otra sala.');
    }
    return entrada;
  }

  return crearJugador(entrada.id, entrada, { ahora: opciones.ahora });
}

function elegirAsientoLibre(sala, asientoSolicitado) {
  const ocupados = new Set();
  for (const jugador of sala.jugadores.values()) {
    if (Number.isInteger(jugador.asiento)) ocupados.add(jugador.asiento);
  }

  if (asientoSolicitado !== undefined && asientoSolicitado !== null) {
    if (!Number.isInteger(asientoSolicitado) || asientoSolicitado < 1 || asientoSolicitado > sala.capacidad) {
      throw errorSala('ASIENTO_INVALIDO', `El asiento debe ser un entero entre 1 y ${sala.capacidad}.`);
    }
    if (ocupados.has(asientoSolicitado)) {
      throw errorSala('ASIENTO_OCUPADO', `El asiento ${asientoSolicitado} ya está ocupado.`);
    }
    return asientoSolicitado;
  }

  for (let asiento = 1; asiento <= sala.capacidad; asiento += 1) {
    if (!ocupados.has(asiento)) return asiento;
  }

  throw errorSala('SALA_LLENA', `La sala ya tiene ${sala.capacidad} jugadores.`);
}

function sincronizarBanderaAnfitrion(sala) {
  for (const jugador of sala.jugadores.values()) {
    jugador.esAnfitrion = jugador.id === sala.anfitrionId;
  }
}

/**
 * Crea el objeto sala en memoria (DOC-01 §4 · DOC-03 §2 y §4).
 *
 * Opciones:
 *   codigo     código compartible de 5 caracteres (se normaliza a mayúsculas)
 *   juego      'coinflip' | 'dice' | 'roulette' | 'blackjack' | 'poker'
 *   anfitrion  jugador creado con `crearJugador` o `{ id, nombre, avatar, fichas? }`
 *   ahora      marca de tiempo o función de reloj (pruebas deterministas)
 *
 * La sala nace en estado `'abierta'`, fase `'espera'` y ronda `1`, con el
 * anfitrión sentado en el asiento 1. Los atributos fijos de la mesa (`id`,
 * `codigo`, `juego`, `capacidad`, `apuestaMinima`, `creadaEn`) quedan protegidos
 * contra sobrescritura accidental.
 */
function crearSala(opciones = {}) {
  if (!opciones || typeof opciones !== 'object') {
    throw errorSala('DATOS_INVALIDOS', 'Faltan los datos para crear la sala.');
  }

  const ahora = marcaDeTiempo(opciones.ahora);
  const codigo = validarCodigo(opciones.codigo);
  const juego = validarJuego(opciones.juego);
  const anfitrion = prepararJugador(opciones.anfitrion, {
    ahora,
    codigoFalta: 'ANFITRION_REQUERIDO',
    mensajeFalta: 'La sala necesita un anfitrión sentado para crearse.'
  });

  const id = `s_${codigo}`;
  const capacidad = REGLAS.JUGADORES_POR_SALA;
  const apuestaMinima = REGLAS.APUESTA_MINIMA;

  const sala = {
    id,
    codigo,
    juego,
    capacidad,
    apuestaMinima,
    estado: ESTADOS_SALA.ABIERTA,
    fase: FASES.ESPERA,
    numero_ronda: 1,
    anfitrionId: anfitrion.id,
    jugadores: new Map(),
    // Estado en memoria de la ronda activa (compatible con ronda.js, lanzamiento.js y turno.js).
    apuestas: [],
    apuestasConfirmadas: 0,
    manos: [],
    resultado: null,
    semillaRng: null,
    acciones: [],
    // Póker: apuesta a igualar, aportes por jugador y bote acumulado.
    apuestaActual: 0,
    puestas: {},
    bote: 0,
    turnos: null,
    temporizadores: new Set(),
    tareasPendientes: [],
    creadaEn: ahora,
    actualizadaEn: ahora
  };

  // DOC-01 §4 · DOC-03 §2: identidad, juego y límites de la mesa no cambian tras crearla.
  Object.defineProperties(sala, {
    id: { value: id, enumerable: true, writable: false, configurable: false },
    codigo: { value: codigo, enumerable: true, writable: false, configurable: false },
    juego: { value: juego, enumerable: true, writable: false, configurable: false },
    capacidad: { value: capacidad, enumerable: true, writable: false, configurable: false },
    apuestaMinima: { value: apuestaMinima, enumerable: true, writable: false, configurable: false },
    creadaEn: { value: ahora, enumerable: true, writable: false, configurable: false }
  });

  anfitrion.salaId = sala.id;
  anfitrion.asiento = 1;
  anfitrion.esAnfitrion = true;
  anfitrion.conectado = true;
  anfitrion.ultimaActividad = ahora;
  sala.jugadores.set(anfitrion.id, anfitrion);

  return sala;
}

// ---------------------------------------------------------------------------
// Consultas sobre la sala
// ---------------------------------------------------------------------------

/** Devuelve los jugadores sentados en orden ascendente de asiento (1…6). */
function jugadoresSentados(sala) {
  exigirSala(sala);
  return Array.from(sala.jugadores.values()).sort((a, b) => {
    const asientoA = Number.isInteger(a.asiento) ? a.asiento : Number.MAX_SAFE_INTEGER;
    const asientoB = Number.isInteger(b.asiento) ? b.asiento : Number.MAX_SAFE_INTEGER;
    return asientoA - asientoB;
  });
}

function obtenerJugador(sala, jugadorId) {
  exigirSala(sala);
  if (typeof jugadorId !== 'string' || !jugadorId) return null;
  return sala.jugadores.get(jugadorId) || null;
}

function obtenerAnfitrion(sala) {
  exigirSala(sala);
  if (!sala.anfitrionId) return null;
  return sala.jugadores.get(sala.anfitrionId) || null;
}

function asientosLibres(sala) {
  exigirSala(sala);
  const capacidad = Number.isInteger(sala.capacidad) ? sala.capacidad : REGLAS.JUGADORES_POR_SALA;
  return Math.max(0, capacidad - sala.jugadores.size);
}

function salaEstaLlena(sala) {
  return asientosLibres(sala) === 0;
}

function salaEstaVacia(sala) {
  exigirSala(sala);
  return sala.jugadores.size === 0;
}

// ---------------------------------------------------------------------------
// Operaciones sobre jugadores sentados, anfitrión y fase
// ---------------------------------------------------------------------------

/**
 * Sienta a un jugador en el primer asiento libre (1…6) o en el indicado en
 * `opciones.asiento`. Rechaza si la sala está cerrada, llena o si ese `id` ya
 * ocupa un asiento en la mesa.
 */
function sentarJugador(sala, jugadorODatos, opciones = {}) {
  exigirSalaAbierta(sala);
  const ahora = marcaDeTiempo(opciones.ahora);

  if (jugadorODatos && typeof jugadorODatos === 'object' && typeof jugadorODatos.id === 'string') {
    const idExistente = jugadorODatos.id.trim();
    if (idExistente && sala.jugadores.has(idExistente)) {
      throw errorSala('JUGADOR_YA_SENTADO', 'El jugador ya ocupa un asiento en esta sala.');
    }
  }

  if (salaEstaLlena(sala)) {
    throw errorSala('SALA_LLENA', `La sala ya tiene ${sala.capacidad} jugadores.`);
  }

  const asiento = elegirAsientoLibre(sala, opciones.asiento);
  const jugador = prepararJugador(jugadorODatos, { ahora });

  if (sala.jugadores.has(jugador.id)) {
    throw errorSala('JUGADOR_YA_SENTADO', 'El jugador ya ocupa un asiento en esta sala.');
  }

  const conectadoExplicito = opciones.conectado !== undefined
    ? Boolean(opciones.conectado)
    : (jugadorODatos && jugadorODatos[MARCA_JUGADOR] !== true && jugadorODatos.conectado !== undefined
      ? Boolean(jugadorODatos.conectado)
      : true);

  jugador.salaId = sala.id;
  jugador.asiento = asiento;
  jugador.conectado = conectadoExplicito;
  jugador.ultimaActividad = ahora;
  sala.jugadores.set(jugador.id, jugador);

  if (!sala.anfitrionId || !sala.jugadores.has(sala.anfitrionId)) {
    sala.anfitrionId = jugador.id;
  }
  sincronizarBanderaAnfitrion(sala);
  sala.actualizadaEn = ahora;

  return jugador;
}

/** Actualiza el estado de conexión y última actividad de un jugador sentado. */
function marcarConexionJugador(sala, jugadorId, conectado, opciones = {}) {
  exigirSalaAbierta(sala);
  const jugador = obtenerJugador(sala, jugadorId);
  if (!jugador) {
    throw errorSala('JUGADOR_NO_EN_SALA', 'El jugador no está sentado en esta sala.');
  }

  const ahora = marcaDeTiempo(opciones.ahora);
  jugador.conectado = Boolean(conectado);
  jugador.ultimaActividad = ahora;
  sala.actualizadaEn = ahora;
  return jugador;
}

/**
 * Transfiere el rol de anfitrión (DOC-01 §4–5).
 *
 * - Si se indica `nuevoAnfitrionId`, valida que esté sentado (y conectado, salvo
 *   `opciones.permitirDesconectado === true`).
 * - Si no se indica, elige automáticamente al siguiente jugador conectado según
 *   el orden de asientos (excluyendo al anfitrión actual si `opciones.rotar` o
 *   a `opciones.excluirId`).
 */
function transferirAnfitrion(sala, nuevoAnfitrionId = null, opciones = {}) {
  exigirSalaAbierta(sala);
  const ahora = marcaDeTiempo(opciones.ahora);

  if (sala.jugadores.size === 0) {
    sala.anfitrionId = null;
    sala.actualizadaEn = ahora;
    return null;
  }

  let elegido = null;

  if (nuevoAnfitrionId !== null && nuevoAnfitrionId !== undefined) {
    const idLimpio = typeof nuevoAnfitrionId === 'string' ? nuevoAnfitrionId.trim() : '';
    elegido = idLimpio ? sala.jugadores.get(idLimpio) || null : null;
    if (!elegido) {
      throw errorSala('JUGADOR_NO_EN_SALA', 'El nuevo anfitrión debe estar sentado en la sala.');
    }
    if (elegido.conectado === false && opciones.permitirDesconectado !== true) {
      throw errorSala('JUGADOR_DESCONECTADO', 'No se puede asignar como anfitrión a un jugador desconectado.');
    }
  } else {
    const excluirId = opciones.excluirId !== undefined
      ? opciones.excluirId
      : (opciones.rotar ? sala.anfitrionId : null);
    const sentados = jugadoresSentados(sala);
    const candidatos = excluirId
      ? sentados.filter((jugador) => jugador.id !== excluirId)
      : sentados;
    const piscina = candidatos.length > 0 ? candidatos : sentados;

    elegido = piscina.find((jugador) => jugador.conectado !== false) || piscina[0] || null;
  }

  sala.anfitrionId = elegido ? elegido.id : null;
  sincronizarBanderaAnfitrion(sala);
  sala.actualizadaEn = ahora;
  return elegido;
}

/**
 * Si el anfitrión lleva desconectado al menos `TIEMPO_HOST_INACTIVO_MS` (60 s en
 * DOC-01 §4 · DOC-02 §2), pasa el rol al siguiente jugador conectado en orden de asiento.
 */
function migrarAnfitrionSiInactivo(sala, opciones = {}) {
  exigirSalaAbierta(sala);
  const anfitrion = obtenerAnfitrion(sala);
  if (!anfitrion || anfitrion.conectado !== false) {
    return { migrado: false, anteriorId: null, anfitrion };
  }

  const ahora = marcaDeTiempo(opciones.ahora);
  const limiteMs = Number.isFinite(opciones.limiteMs) && opciones.limiteMs >= 0
    ? Number(opciones.limiteMs)
    : REGLAS.TIEMPO_HOST_INACTIVO_MS;

  if (ahora - anfitrion.ultimaActividad < limiteMs) {
    return { migrado: false, anteriorId: null, anfitrion };
  }

  const siguiente = jugadoresSentados(sala).find(
    (jugador) => jugador.id !== anfitrion.id && jugador.conectado !== false
  );
  if (!siguiente) {
    return { migrado: false, anteriorId: null, anfitrion };
  }

  transferirAnfitrion(sala, siguiente.id, { ahora });
  return { migrado: true, anteriorId: anfitrion.id, anfitrion: siguiente };
}

/**
 * Devuelve al saldo del jugador su apuesta aún no liquidada y la quita de la mesa
 * (DOC-01 §6 · DOC-04 §5). Las apuestas ya liquidadas nunca se reembolsan.
 */
function reembolsarApuestaPendiente(sala, jugadorId) {
  exigirSala(sala);
  const indice = sala.apuestas.findIndex(
    (apuesta) => apuesta.jugadorId === jugadorId && (apuesta.resultado === undefined || apuesta.resultado === null)
  );
  if (indice < 0) return null;

  const [apuesta] = sala.apuestas.splice(indice, 1);
  const jugador = sala.jugadores.get(jugadorId);
  if (jugador) jugador.fichas += apuesta.monto;
  sala.apuestasConfirmadas = sala.apuestas.length;
  sala.bote = Math.max(0, (Number(sala.bote) || 0) - apuesta.monto);
  return apuesta;
}

function detenerRelojDeTurnos(sala, motivo) {
  if (!sala.turnos) return;
  const reloj = sala.turnos;
  sala.turnos = null;
  if (typeof reloj.cancelar === 'function') reloj.cancelar(motivo);
}

/**
 * Cierra definitivamente la sala: detiene relojes y temporizadores, libera a los
 * jugadores que quedaran sentados y marca `estado = 'cerrada'`.
 */
function cerrarSala(sala, opciones = {}) {
  exigirSala(sala);
  const ahora = marcaDeTiempo(opciones.ahora);
  const motivo = opciones.motivo || 'sala_cerrada';

  detenerRelojDeTurnos(sala, motivo);
  cancelarTemporizadores(sala);

  for (const jugador of sala.jugadores.values()) {
    jugador.salaId = null;
    jugador.asiento = null;
    jugador.esAnfitrion = false;
    jugador.conectado = false;
    jugador.ultimaActividad = ahora;
  }
  sala.jugadores.clear();
  sala.anfitrionId = null;
  sala.estado = ESTADOS_SALA.CERRADA;
  sala.actualizadaEn = ahora;
  return sala;
}

/**
 * Retira a un jugador de su asiento y actualiza la sala en memoria:
 *   - si estaba en turno, avisa al reloj para que la mesa no se quede atorada;
 *   - si la ronda seguía en `apuestas`, reembolsa su apuesta pendiente;
 *   - libera su asiento (1…6);
 *   - si era el anfitrión, pasa el rol al siguiente jugador conectado;
 *   - si era el último jugador, cierra la sala y limpia sus temporizadores.
 */
function retirarJugador(sala, jugadorId, opciones = {}) {
  exigirSala(sala);
  const jugador = obtenerJugador(sala, jugadorId);
  if (!jugador) {
    return {
      retirado: null,
      asientoLiberado: null,
      apuestaReembolsada: null,
      anfitrionCambio: false,
      nuevoAnfitrion: obtenerAnfitrion(sala),
      cerrada: sala.estado === ESTADOS_SALA.CERRADA
    };
  }

  const ahora = marcaDeTiempo(opciones.ahora);
  const eraAnfitrion = sala.anfitrionId === jugador.id;
  const asientoLiberado = jugador.asiento;

  // Se marca desconectado antes de notificar al reloj de turno: los callbacks aún
  // pueden leer su nombre en `sala.jugadores`, pero la mano no lo trata como activo.
  jugador.conectado = false;
  jugador.ultimaActividad = ahora;

  // El reloj puede cerrar la mano antes de quitar el asiento. Marca la apuesta
  // antes de llamarlo para no reembolsarla, incluso si el jugador vuelve a entrar.
  if (sala.fase === FASES.JUGANDO) {
    const apuesta = sala.apuestas.find((apuesta) => apuesta.jugadorId === jugador.id);
    if (apuesta) apuesta.abandonada = true;
  }

  if (opciones.resolverTurno !== false && sala.turnos && typeof sala.turnos.retirarJugador === 'function') {
    sala.turnos.retirarJugador(jugador.id, opciones.motivoTurno || 'abandono');
  }

  // DOC-01 §6 · DOC-04 §5: solo se reembolsa si la ronda todavía no se lanzó ni repartió.
  const apuestaReembolsada = opciones.reembolsar !== false && fasePermiteAccion(sala.fase, 'apostar')
    ? reembolsarApuestaPendiente(sala, jugador.id)
    : null;

  sala.jugadores.delete(jugador.id);
  jugador.salaId = null;
  jugador.asiento = null;
  jugador.esAnfitrion = false;

  if (sala.jugadores.size === 0) {
    cerrarSala(sala, { ahora, motivo: 'sala_vacia' });
    return {
      retirado: jugador,
      asientoLiberado,
      apuestaReembolsada,
      anfitrionCambio: eraAnfitrion,
      nuevoAnfitrion: null,
      cerrada: true
    };
  }

  let nuevoAnfitrion = obtenerAnfitrion(sala);
  let anfitrionCambio = false;

  if (eraAnfitrion || !nuevoAnfitrion) {
    nuevoAnfitrion = transferirAnfitrion(sala, null, { ahora });
    anfitrionCambio = true;
  } else {
    sincronizarBanderaAnfitrion(sala);
    sala.actualizadaEn = ahora;
  }

  return {
    retirado: jugador,
    asientoLiberado,
    apuestaReembolsada,
    anfitrionCambio,
    nuevoAnfitrion,
    cerrada: false
  };
}

/**
 * Avanza la fase de la ronda de la sala (`espera` → `apuestas` → `jugando` →
 * `resultados` → `apuestas`) delegando en `lib/ronda.js` y etiquetando cada
 * rechazo con un `error.codigo` uniforme para el servidor.
 */
function actualizarFaseSala(sala, nuevaFase, motivo = {}) {
  exigirSalaAbierta(sala);

  if (!Object.values(FASES).includes(nuevaFase) || !puedeTransicionar(sala.fase, nuevaFase)) {
    throw errorSala('FASE_INVALIDA', `Transición de fase inválida: ${sala.fase} → ${nuevaFase}.`);
  }

  const opciones = typeof motivo === 'string' ? { accion: motivo } : { ...(motivo || {}) };

  if (sala.fase === FASES.ESPERA && nuevaFase === FASES.APUESTAS) {
    if (!opciones.accion && opciones.jugadorId !== undefined) opciones.accion = 'comenzar';
    if (!['automatico', 'comenzar'].includes(opciones.accion)) {
      throw errorSala('MOTIVO_INVALIDO', 'Motivo de inicio inválido.');
    }
    if (opciones.accion === 'comenzar' && !esAnfitrion(sala, opciones.jugadorId)) {
      throw errorSala('SOLO_ANFITRION', 'Solo el anfitrión puede comenzar.');
    }
    const minimo = minimoJugadores(sala.juego);
    if (sala.jugadores.size < minimo) {
      throw errorSala('JUGADORES_INSUFICIENTES', `Se requieren al menos ${minimo} jugadores para comenzar.`);
    }
  } else if (sala.fase === FASES.APUESTAS && nuevaFase === FASES.JUGANDO) {
    if (!esAnfitrion(sala, opciones.jugadorId)) {
      throw errorSala('SOLO_ANFITRION', 'Solo el anfitrión puede iniciar la ronda.');
    }
    const confirmadas = opciones.apuestasConfirmadas !== undefined
      ? Number(opciones.apuestasConfirmadas)
      : (Number(sala.apuestasConfirmadas) || sala.apuestas.length);
    if (!Number.isFinite(confirmadas) || confirmadas <= 0) {
      throw errorSala('SIN_APOSTADORES', 'Nadie confirmó una apuesta en esta ronda.');
    }
  } else if (sala.fase === FASES.JUGANDO && nuevaFase === FASES.RESULTADOS) {
    if (opciones.servidor !== true) {
      throw errorSala('SOLO_SERVIDOR', 'Solo el servidor puede finalizar y liquidar la ronda.');
    }
  } else if (sala.fase === FASES.RESULTADOS && nuevaFase === FASES.APUESTAS) {
    if (!esAnfitrion(sala, opciones.jugadorId)) {
      throw errorSala('SOLO_ANFITRION', 'Solo el anfitrión puede abrir la siguiente ronda.');
    }
    detenerRelojDeTurnos(sala, 'nueva_ronda');
  }

  cambiarFase(sala, nuevaFase, opciones);
  if (opciones.ahora !== undefined) {
    sala.actualizadaEn = marcaDeTiempo(opciones.ahora);
  }
  return sala;
}

/** Abre la siguiente ronda desde `resultados`: limpia la mesa e incrementa `numero_ronda`. */
function iniciarSiguienteRonda(sala, jugadorId, opciones = {}) {
  exigirSalaAbierta(sala);
  if (!fasePermiteAccion(sala.fase, 'nueva_ronda')) {
    throw errorSala('FASE_INVALIDA', 'La siguiente ronda se abre desde los resultados.');
  }
  return actualizarFaseSala(sala, FASES.APUESTAS, { ...opciones, jugadorId });
}

// ---------------------------------------------------------------------------
// Vistas públicas (DOC-04 §3.1 y §3.3): nunca exponen semillas ni manos privadas
// ---------------------------------------------------------------------------

function vistaDeJugador(sala, jugador) {
  return {
    id: jugador.id,
    nombre: jugador.nombre,
    avatar: jugador.avatar,
    fichas: jugador.fichas,
    asiento: jugador.asiento,
    esAnfitrion: jugador.id === sala.anfitrionId,
    conectado: Boolean(jugador.conectado)
  };
}

/** Estado público completo para el evento `estado_sala` (DOC-04 §3.3). */
function estadoDeSala(sala, opciones = {}) {
  exigirSala(sala);
  const limiteTurnoMs = opciones.limiteTurnoMs !== undefined
    ? opciones.limiteTurnoMs
    : tiempoDeTurno(sala.juego);

  return {
    id: sala.id,
    codigo: sala.codigo,
    juego: sala.juego,
    estado: sala.estado,
    fase: sala.fase,
    anfitrionId: sala.anfitrionId,
    capacidad: sala.capacidad,
    asientosLibres: asientosLibres(sala),
    apuestaMinima: sala.apuestaMinima,
    numeroRonda: sala.numero_ronda,
    limiteTurnoMs,
    turno: sala.turnos && typeof sala.turnos.vistaPublica === 'function'
      ? sala.turnos.vistaPublica()
      : null,
    resultado: sala.resultado ? clonarPlano(sala.resultado) : null,
    bote: Number(sala.bote) || 0,
    apuestas: sala.apuestas.map(vistaDeApuesta),
    acciones: (Array.isArray(sala.acciones) ? sala.acciones : []).map(
      ({ jugadorId, accion, automatica, motivo, mensaje }) => ({
        jugadorId,
        accion,
        automatica,
        motivo,
        mensaje
      })
    ),
    jugadores: jugadoresSentados(sala).map((jugador) => vistaDeJugador(sala, jugador))
  };
}

/** Resumen de una sala activa para `GET /api/salas` (DOC-04 §3.1). */
function resumenDeSala(sala) {
  exigirSala(sala);
  return {
    id: sala.id,
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    anfitrionId: sala.anfitrionId,
    anfitrion: obtenerAnfitrion(sala)?.nombre ?? null,
    jugadores: sala.jugadores.size,
    capacidad: sala.capacidad,
    asientosLibres: asientosLibres(sala)
  };
}

/** Detalle de ocupación para `GET /api/salas/:codigo` (DOC-04 §3.1). */
function consultaDeSala(sala) {
  exigirSala(sala);
  return {
    ok: true,
    existe: true,
    id: sala.id,
    codigo: sala.codigo,
    juego: sala.juego,
    fase: sala.fase,
    anfitrionId: sala.anfitrionId,
    jugadores: sala.jugadores.size,
    capacidad: sala.capacidad,
    asientosLibres: asientosLibres(sala)
  };
}

// ---------------------------------------------------------------------------
// Almacén de salas activas en memoria (DOC-03 §3–4 · DOC-04 §6.5)
// ---------------------------------------------------------------------------

/**
 * Crea el registro en memoria de todas las salas activas del servidor.
 *
 * Garantiza los invariantes de DOC-01 y DOC-03:
 *   - como máximo `maxSalas` salas simultáneas (50 por defecto);
 *   - códigos de 5 caracteres únicos entre salas activas;
 *   - cada jugador ocupa asiento en una sola sala activa a la vez;
 *   - si una solicitud falla, no saca al jugador de la sala donde estaba;
 *   - cuando una sala queda vacía se cierra y se elimina del mapa.
 */
function crearAlmacenSalas(opciones = {}) {
  const maxSalas = Number.isInteger(opciones.maxSalas) && opciones.maxSalas > 0
    ? opciones.maxSalas
    : MAX_SALAS_POR_DEFECTO;
  const reloj = opciones.ahora;
  const enteroAleatorio = typeof opciones.enteroAleatorio === 'function'
    ? opciones.enteroAleatorio
    : crypto.randomInt;
  const generadorCodigo = typeof opciones.generarCodigo === 'function'
    ? opciones.generarCodigo
    : (activas) => generarCodigoSala(activas, enteroAleatorio);

  /** codigo -> sala */
  const salasPorCodigo = new Map();
  /** jugadorId -> codigo */
  const salaPorJugador = new Map();

  function obtener(codigo) {
    const limpio = normalizarCodigo(codigo);
    if (!limpio) return null;
    return salasPorCodigo.get(limpio) || null;
  }

  function tiene(codigo) {
    return obtener(codigo) !== null;
  }

  function salaDeJugador(jugadorId) {
    if (typeof jugadorId !== 'string' || !jugadorId) return null;
    const codigo = salaPorJugador.get(jugadorId);
    if (!codigo) return null;
    const sala = salasPorCodigo.get(codigo) || null;
    if (!sala || !sala.jugadores.has(jugadorId)) {
      salaPorJugador.delete(jugadorId);
      return null;
    }
    return sala;
  }

  function salir(jugadorId, extra = {}) {
    const sala = salaDeJugador(jugadorId);
    if (!sala) {
      return {
        sala: null,
        retirado: null,
        asientoLiberado: null,
        apuestaReembolsada: null,
        anfitrionCambio: false,
        nuevoAnfitrion: null,
        cerrada: false
      };
    }

    const ahora = extra.ahora !== undefined ? extra.ahora : reloj;
    const resultado = retirarJugador(sala, jugadorId, { ...extra, ahora });
    salaPorJugador.delete(jugadorId);

    if (resultado.cerrada) {
      salasPorCodigo.delete(sala.codigo);
    }

    return { sala, ...resultado };
  }

  function crear(datos = {}, extra = {}) {
    if (!datos || typeof datos !== 'object') {
      throw errorSala('DATOS_INVALIDOS', 'Faltan los datos para crear la sala.');
    }

    const ahora = marcaDeTiempo(datos.ahora !== undefined ? datos.ahora : reloj);
    const juego = validarJuego(datos.juego);
    const anfitrion = prepararJugador(datos.anfitrion, {
      ahora,
      codigoFalta: 'ANFITRION_REQUERIDO',
      mensajeFalta: 'La sala necesita un anfitrión sentado para crearse.'
    });

    const previa = salaDeJugador(anfitrion.id);
    const liberaPrevia = Boolean(previa && previa.jugadores.size === 1);
    if (salasPorCodigo.size - (liberaPrevia ? 1 : 0) >= maxSalas) {
      throw errorSala('LIMITE_SALAS', 'Se alcanzó el máximo de salas activas. Inténtalo más tarde.');
    }

    let codigo;
    if (datos.codigo !== undefined && datos.codigo !== null) {
      codigo = validarCodigo(datos.codigo);
      if (salasPorCodigo.has(codigo)) {
        throw errorSala('CODIGO_EN_USO', `Ya existe una sala activa con el código ${codigo}.`);
      }
    } else {
      codigo = validarCodigo(generadorCodigo(salasPorCodigo));
      if (salasPorCodigo.has(codigo)) {
        throw errorSala('CODIGO_EN_USO', `Ya existe una sala activa con el código ${codigo}.`);
      }
    }

    // Permite cargar el perfil persistente después de validar la entrada, sin
    // quitarle el asiento previo al jugador si la carga falla.
    extra.prepararIngreso?.(anfitrion);
    if (previa) anfitrion.fichas = salir(anfitrion.id, { ahora }).retirado.fichas;

    const sala = crearSala({ codigo, juego, anfitrion, ahora });
    salasPorCodigo.set(sala.codigo, sala);
    salaPorJugador.set(anfitrion.id, sala.codigo);
    return sala;
  }

  function unir(codigo, datosJugador, extra = {}) {
    const ahora = marcaDeTiempo(extra.ahora !== undefined ? extra.ahora : reloj);
    const codigoValido = validarCodigo(codigo);
    const sala = salasPorCodigo.get(codigoValido);

    if (!sala || sala.estado === ESTADOS_SALA.CERRADA) {
      throw errorSala('SALA_NO_ENCONTRADA', 'La sala no existe o ya se cerró.');
    }

    const idCandidato = datosJugador && typeof datosJugador === 'object' && typeof datosJugador.id === 'string'
      ? datosJugador.id.trim()
      : '';

    // Reenviar el mismo código no expulsa al jugador ni toca su asiento, saldo o rol.
    if (idCandidato && sala.jugadores.has(idCandidato)) {
      const existente = sala.jugadores.get(idCandidato);
      existente.conectado = true;
      existente.ultimaActividad = ahora;
      salaPorJugador.set(existente.id, sala.codigo);
      return { sala, jugador: existente, yaEstaba: true, salidaAnterior: null };
    }

    if (salaEstaLlena(sala)) {
      throw errorSala('SALA_LLENA', `La sala ya tiene ${sala.capacidad} jugadores.`);
    }

    // Validamos asiento y perfil antes de abandonar una posible sala anterior.
    const asiento = elegirAsientoLibre(sala, extra.asiento);
    const jugador = prepararJugador(datosJugador, { ahora });
    extra.prepararIngreso?.(jugador);

    const previa = salaDeJugador(jugador.id);
    const salidaAnterior = previa ? salir(jugador.id, { ahora }) : null;
    if (salidaAnterior) jugador.fichas = salidaAnterior.retirado.fichas;

    sentarJugador(sala, jugador, { asiento, ahora });
    salaPorJugador.set(jugador.id, sala.codigo);
    return { sala, jugador, yaEstaba: false, salidaAnterior };
  }

  function eliminar(codigo, extra = {}) {
    const sala = obtener(codigo);
    if (!sala) return false;

    const ahora = extra.ahora !== undefined ? extra.ahora : reloj;
    for (const id of sala.jugadores.keys()) {
      salaPorJugador.delete(id);
    }
    cerrarSala(sala, { ahora, motivo: extra.motivo || 'sala_cerrada' });
    salasPorCodigo.delete(sala.codigo);
    return true;
  }

  function listar() {
    return Array.from(salasPorCodigo.values());
  }

  function cerrarTodas(motivo = 'servidor_cerrando') {
    for (const sala of salasPorCodigo.values()) {
      cerrarSala(sala, { ahora: reloj, motivo });
    }
    salasPorCodigo.clear();
    salaPorJugador.clear();
  }

  return {
    crear,
    unir,
    salir,
    obtener,
    get: obtener,
    tiene,
    has: tiene,
    salaDeJugador,
    eliminar,
    delete: eliminar,
    listar,
    values: () => salasPorCodigo.values(),
    cerrarTodas,
    get maxSalas() { return maxSalas; },
    get size() { return salasPorCodigo.size; }
  };
}

module.exports = {
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
  minimoJugadores,
  fasePermiteAccion,
  sentarJugador,
  retirarJugador,
  marcarConexionJugador,
  transferirAnfitrion,
  migrarAnfitrionSiInactivo,
  actualizarFaseSala,
  iniciarSiguienteRonda,
  reembolsarApuestaPendiente,
  cerrarSala,
  vistaDeJugador,
  estadoDeSala,
  resumenDeSala,
  consultaDeSala,
  crearAlmacenSalas
};
