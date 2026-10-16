const AVATARES = ['🙂', '🦊', '🐱', '🦉', '🐼', '🦁', '🐸', '🐺'];

const ETIQUETAS_AVATAR = {
  '🙂': 'Avatar sonriente',
  '🦊': 'Avatar de zorro',
  '🐱': 'Avatar de gato',
  '🦉': 'Avatar de búho',
  '🐼': 'Avatar de panda',
  '🦁': 'Avatar de león',
  '🐸': 'Avatar de rana',
  '🐺': 'Avatar de lobo'
};

const CLAVE_PERFIL = 'montecristo.perfil';

let socket = null;
let accionPerfil = 'crear';
let codigoDestino = '';
let avatarSeleccionado = AVATARES[0];
let perfilGuardado = null;
let enviando = false;
let solicitudPendiente = false;
let temporizadorSolicitud = null;

const buscar = (selector, contexto = document) => contexto.querySelector(selector);
const buscarPorId = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  cargarSocketIO();

  if (document.body.dataset.pagina === 'inicio') {
    iniciarInicio();
  }

  if (document.body.dataset.pagina === 'perfil') {
    iniciarPerfil();
  }
});

function cargarSocketIO() {
  actualizarEstadoConexion('conectando', 'Conectando…');

  if (window.location.protocol === 'file:') {
    actualizarEstadoConexion('no-disponible', 'Servidor no disponible');
    return;
  }

  const scriptSocket = document.createElement('script');
  scriptSocket.src = '/socket.io/socket.io.js';
  scriptSocket.async = true;

  scriptSocket.addEventListener('load', () => {
    if (typeof window.io !== 'function') {
      actualizarEstadoConexion('no-disponible', 'Servidor no disponible');
      return;
    }

    try {
      socket = window.io();
      socket.on('connect', () => {
        actualizarEstadoConexion('conectado', 'Conectado al servidor');
      });
      socket.on('disconnect', () => {
        if (socket && socket.active) {
          actualizarEstadoConexion('conectando', 'Conectando…');
        } else {
          actualizarEstadoConexion('no-disponible', 'Servidor no disponible');
        }
      });
      socket.on('connect_error', () => {
        actualizarEstadoConexion('no-disponible', 'Servidor no disponible');
      });
      socket.on('error', manejarErrorServidor);
    } catch (error) {
      actualizarEstadoConexion('no-disponible', 'Servidor no disponible');
    }
  });

  scriptSocket.addEventListener('error', () => {
    actualizarEstadoConexion('no-disponible', 'Servidor no disponible');
  });

  document.head.appendChild(scriptSocket);
}

function actualizarEstadoConexion(estado, texto) {
  document.querySelectorAll('.estado-conexion').forEach((indicador) => {
    indicador.dataset.estado = estado;
    const textoEstado = buscar('.estado-conexion__texto', indicador);

    if (textoEstado) {
      textoEstado.textContent = texto;
    }
  });
}

function iniciarInicio() {
  const formulario = buscarPorId('formulario-codigo');
  const campoCodigo = buscarPorId('codigo-sala');
  const botonCrearSala = buscarPorId('crear-sala');
  const regionError = buscarPorId('error-inicio');

  if (botonCrearSala) {
    botonCrearSala.addEventListener('click', () => {
      window.location.href = 'perfil.html?accion=crear';
    });
  }

  if (!formulario || !campoCodigo) {
    return;
  }

  campoCodigo.addEventListener('input', () => {
    const codigoLimpio = campoCodigo.value
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 5)
      .toUpperCase();

    if (campoCodigo.value !== codigoLimpio) {
      campoCodigo.value = codigoLimpio;
    }

    campoCodigo.removeAttribute('aria-invalid');
    mostrarAviso(regionError, '');
  });

  formulario.addEventListener('submit', (evento) => {
    evento.preventDefault();
    const codigo = campoCodigo.value.toUpperCase();

    if (!/^[A-Z0-9]{5}$/.test(codigo)) {
      campoCodigo.setAttribute('aria-invalid', 'true');
      mostrarAviso(regionError, 'Escribe un código de sala de exactamente cinco letras o números. No se permiten espacios ni símbolos.');
      campoCodigo.focus();
      return;
    }

    campoCodigo.removeAttribute('aria-invalid');
    mostrarAviso(regionError, '');
    window.location.href = `perfil.html?accion=entrar&codigo=${encodeURIComponent(codigo)}`;
  });
}

function iniciarPerfil() {
  const formulario = buscarPorId('formulario-perfil');
  const campoNombre = buscarPorId('nombre-jugador');
  const campoJuego = buscarPorId('juego-sala');
  const grupoAvatar = buscarPorId('selector-avatar');

  if (!formulario || !campoNombre || !grupoAvatar) {
    return;
  }

  const parametros = new URLSearchParams(window.location.search);
  accionPerfil = parametros.get('accion') === 'entrar' ? 'entrar' : 'crear';
  codigoDestino = (parametros.get('codigo') || '').toUpperCase();
  perfilGuardado = leerPerfilGuardado();

  if (perfilGuardado && typeof perfilGuardado.nombre === 'string') {
    campoNombre.value = perfilGuardado.nombre;
  }

  if (perfilGuardado && AVATARES.includes(perfilGuardado.avatar)) {
    avatarSeleccionado = perfilGuardado.avatar;
  }

  configurarIntencion(campoJuego);
  renderizarAvatares(grupoAvatar);
  actualizarVistaPrevia(campoNombre, campoJuego);

  campoNombre.addEventListener('input', () => {
    actualizarVistaPrevia(campoNombre, campoJuego);

    if (campoNombre.hasAttribute('aria-invalid') && !validarNombre(campoNombre.value)) {
      mostrarErrorNombre('');
    }
  });

  if (campoJuego) {
    campoJuego.addEventListener('change', () => actualizarVistaPrevia(campoNombre, campoJuego));
  }

  formulario.addEventListener('submit', (evento) => {
    evento.preventDefault();
    enviarSolicitudPerfil(campoNombre, campoJuego);
  });
}

function configurarIntencion(campoJuego) {
  const botonContinuar = buscarPorId('boton-continuar');
  const resumenCodigo = buscarPorId('resumen-codigo');
  const campoJuegoContenedor = buscarPorId('campo-juego');
  const textoIntencion = buscarPorId('texto-intencion');

  if (accionPerfil === 'entrar') {
    if (campoJuegoContenedor) {
      campoJuegoContenedor.hidden = true;
    }

    if (campoJuego) {
      campoJuego.required = false;
    }

    if (botonContinuar) {
      botonContinuar.textContent = 'Entrar a la sala';
    }

    if (textoIntencion) {
      textoIntencion.textContent = 'Completa tu perfil para entrar a la sala. Tus datos se guardan en este navegador para la próxima partida.';
    }

    if (resumenCodigo) {
      resumenCodigo.hidden = false;

      if (/^[A-Z0-9]{5}$/.test(codigoDestino)) {
        resumenCodigo.textContent = `Vas a entrar a la sala ${codigoDestino}.`;
        resumenCodigo.classList.remove('aviso--peligro');
      } else {
        resumenCodigo.textContent = 'El código de sala no es válido. Vuelve al inicio y escribe exactamente cinco letras o números.';
        resumenCodigo.classList.add('aviso--peligro');
      }
    }

    return;
  }

  if (campoJuegoContenedor) {
    campoJuegoContenedor.hidden = false;
  }

  if (campoJuego) {
    campoJuego.required = true;
  }

  if (botonContinuar) {
    botonContinuar.textContent = 'Crear sala';
  }

  if (textoIntencion) {
    textoIntencion.textContent = 'Así te verá tu grupo en la mesa. Elige un juego y crea una sala para hasta seis personas.';
  }

  if (resumenCodigo) {
    resumenCodigo.hidden = true;
  }
}

function renderizarAvatares(grupoAvatar) {
  const fragmento = document.createDocumentFragment();

  AVATARES.forEach((avatar) => {
    const boton = document.createElement('button');
    boton.className = 'avatar-opcion';
    boton.type = 'button';
    boton.dataset.avatar = avatar;
    boton.setAttribute('role', 'radio');
    boton.setAttribute('aria-label', ETIQUETAS_AVATAR[avatar]);
    boton.textContent = avatar;
    fragmento.appendChild(boton);
  });

  grupoAvatar.replaceChildren(fragmento);
  seleccionarAvatar(avatarSeleccionado);

  grupoAvatar.addEventListener('click', (evento) => {
    const boton = evento.target.closest('.avatar-opcion');

    if (boton && grupoAvatar.contains(boton)) {
      seleccionarAvatar(boton.dataset.avatar);
    }
  });

  grupoAvatar.addEventListener('keydown', (evento) => {
    const opciones = Array.from(grupoAvatar.querySelectorAll('.avatar-opcion'));
    const indiceActual = opciones.indexOf(evento.target);

    if (indiceActual < 0) {
      return;
    }

    let indiceSiguiente = indiceActual;

    if (evento.key === 'ArrowRight' || evento.key === 'ArrowDown') {
      indiceSiguiente = (indiceActual + 1) % opciones.length;
    } else if (evento.key === 'ArrowLeft' || evento.key === 'ArrowUp') {
      indiceSiguiente = (indiceActual - 1 + opciones.length) % opciones.length;
    } else if (evento.key === 'Home') {
      indiceSiguiente = 0;
    } else if (evento.key === 'End') {
      indiceSiguiente = opciones.length - 1;
    } else {
      return;
    }

    evento.preventDefault();
    seleccionarAvatar(opciones[indiceSiguiente].dataset.avatar, true);
  });
}

function seleccionarAvatar(avatar, enfocar = false) {
  if (!AVATARES.includes(avatar)) {
    return;
  }

  avatarSeleccionado = avatar;
  const grupoAvatar = buscarPorId('selector-avatar');

  if (grupoAvatar) {
    grupoAvatar.querySelectorAll('.avatar-opcion').forEach((boton) => {
      const seleccionado = boton.dataset.avatar === avatar;
      boton.setAttribute('aria-checked', String(seleccionado));
      boton.tabIndex = seleccionado ? 0 : -1;
      boton.classList.toggle('is-selected', seleccionado);

      if (seleccionado && enfocar) {
        boton.focus();
      }
    });
  }

  const vistaAvatar = buscarPorId('vista-avatar');

  if (vistaAvatar) {
    vistaAvatar.textContent = avatar;
  }
}

function actualizarVistaPrevia(campoNombre, campoJuego) {
  const vistaNombre = buscarPorId('vista-nombre');
  const contadorNombre = buscarPorId('contador-nombre');
  const vistaJuego = buscarPorId('vista-juego');
  const nombre = campoNombre.value;

  if (vistaNombre) {
    vistaNombre.textContent = nombre.trim() || 'Tu nombre';
  }

  if (contadorNombre) {
    contadorNombre.textContent = String(nombre.length);
  }

  if (vistaJuego && campoJuego && !campoJuego.closest('[hidden]')) {
    const opcion = campoJuego.options[campoJuego.selectedIndex];
    vistaJuego.textContent = opcion && opcion.value ? opcion.textContent : 'Elige un juego';
  } else if (vistaJuego && accionPerfil === 'entrar' && codigoDestino) {
    vistaJuego.textContent = `Sala ${codigoDestino}`;
  }
}

function validarNombre(nombre) {
  if (!nombre || nombre.trim().length === 0) {
    return 'Escribe tu nombre para continuar.';
  }

  if (nombre.length > 24) {
    return 'El nombre puede tener como máximo 24 caracteres.';
  }

  if (nombre !== nombre.trim()) {
    return 'El nombre no puede comenzar ni terminar con espacios.';
  }

  return '';
}

function mostrarErrorNombre(mensaje) {
  const campoNombre = buscarPorId('nombre-jugador');
  const regionError = buscarPorId('error-nombre');

  if (!campoNombre || !regionError) {
    return;
  }

  if (mensaje) {
    campoNombre.setAttribute('aria-invalid', 'true');
    regionError.textContent = mensaje;
    regionError.hidden = false;
  } else {
    campoNombre.removeAttribute('aria-invalid');
    regionError.textContent = '';
    regionError.hidden = true;
  }
}

function enviarSolicitudPerfil(campoNombre, campoJuego) {
  const regionError = buscarPorId('error-perfil');
  const nombre = campoNombre.value;
  const errorNombre = validarNombre(nombre);

  mostrarErrorNombre(errorNombre);
  mostrarAviso(regionError, '');

  if (errorNombre) {
    campoNombre.focus();
    return;
  }

  if (accionPerfil === 'entrar' && !/^[A-Z0-9]{5}$/.test(codigoDestino)) {
    mostrarAviso(regionError, 'El código de sala no es válido. Vuelve al inicio y escribe exactamente cinco letras o números.');
    return;
  }

  if (!AVATARES.includes(avatarSeleccionado)) {
    mostrarAviso(regionError, 'Selecciona un avatar antes de continuar.');
    buscarPorId('selector-avatar')?.querySelector('.avatar-opcion')?.focus();
    return;
  }

  if (accionPerfil === 'crear' && (!campoJuego || !campoJuego.value)) {
    mostrarAviso(regionError, 'Elige el juego que quieres jugar en esta sala.');
    campoJuego?.focus();
    return;
  }

  let datosJugador;

  try {
    datosJugador = guardarPerfil(nombre);
  } catch (error) {
    mostrarAviso(regionError, error.message || 'No se pudo guardar tu perfil en este navegador.');
    return;
  }

  if (!socket || !socket.connected) {
    actualizarEstadoConexion('no-disponible', 'Servidor no disponible');
    mostrarAviso(regionError, 'El servidor no está disponible. Tu perfil quedó guardado en este navegador; inténtalo de nuevo cuando el servidor esté activo.');
    return;
  }

  const evento = accionPerfil === 'crear' ? 'crear_sala' : 'entrar_sala';
  let datosEvento;

  if (accionPerfil === 'crear') {
    datosEvento = {
      nombre: datosJugador.nombre,
      avatar: datosJugador.avatar,
      juego: campoJuego.value
    };
  } else {
    datosEvento = {
      codigo: codigoDestino,
      nombre: datosJugador.nombre,
      avatar: datosJugador.avatar
    };
  }

  // device_id permanece guardado en localStorage; docs/04 no lo incluye en estos payloads.
  establecerEnviando(true);
  solicitudPendiente = true;
  temporizadorSolicitud = window.setTimeout(() => {
    if (!solicitudPendiente) {
      return;
    }

    solicitudPendiente = false;
    finalizarEnvio();
    mostrarAviso(regionError, 'El servidor no respondió a tiempo. Tu perfil se conservó; vuelve a intentarlo.');
  }, 15000);

  socket.emit(evento, datosEvento, (respuesta) => {
    if (!solicitudPendiente) {
      return;
    }

    solicitudPendiente = false;
    limpiarTemporizadorSolicitud();

    if (!respuesta || respuesta.ok !== true) {
      finalizarEnvio();
      const mensaje = obtenerMensajeError(respuesta && respuesta.error);
      mostrarAviso(regionError, mensaje || 'El servidor no pudo completar la solicitud. Revisa los datos e inténtalo de nuevo.');
      return;
    }

    const codigo = accionPerfil === 'entrar'
      ? codigoDestino
      : String(respuesta.codigo || '').toUpperCase();

    if (!/^[A-Z0-9]{5}$/.test(codigo)) {
      finalizarEnvio();
      mostrarAviso(regionError, 'El servidor confirmó la solicitud, pero no devolvió un código de sala válido.');
      return;
    }

    abrirSalaOCrearAviso(codigo);
  });
}

function guardarPerfil(nombre) {
  let deviceId = perfilGuardado && typeof perfilGuardado.device_id === 'string'
    ? perfilGuardado.device_id
    : '';

  if (!deviceId) {
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
      throw new Error('Este navegador no permite generar un identificador seguro. Actualiza el navegador para continuar.');
    }

    deviceId = window.crypto.randomUUID();
  }

  const datos = {
    nombre,
    avatar: avatarSeleccionado,
    device_id: deviceId
  };
  perfilGuardado = datos;

  try {
    window.localStorage.setItem(CLAVE_PERFIL, JSON.stringify(datos));
  } catch (error) {
    throw new Error('No se pudo guardar tu perfil en este navegador. Comprueba que el almacenamiento local esté permitido.');
  }

  return datos;
}

function leerPerfilGuardado() {
  try {
    const guardado = window.localStorage.getItem(CLAVE_PERFIL);

    if (!guardado) {
      return null;
    }

    const datos = JSON.parse(guardado);

    if (!datos || typeof datos !== 'object') {
      return null;
    }

    return {
      nombre: typeof datos.nombre === 'string' ? datos.nombre : '',
      avatar: typeof datos.avatar === 'string' ? datos.avatar : '',
      device_id: typeof datos.device_id === 'string' ? datos.device_id : ''
    };
  } catch (error) {
    return null;
  }
}

function establecerEnviando(activo) {
  enviando = activo;
  const formulario = buscarPorId('formulario-perfil');
  const boton = buscarPorId('boton-continuar');

  if (formulario) {
    formulario.setAttribute('aria-busy', String(activo));
    formulario.querySelectorAll('input, select, button').forEach((control) => {
      control.disabled = activo;
    });
  }

  if (boton) {
    boton.classList.toggle('is-loading', activo);
    boton.textContent = activo
      ? 'Cargando…'
      : accionPerfil === 'crear' ? 'Crear sala' : 'Entrar a la sala';
  }
}

function finalizarEnvio() {
  solicitudPendiente = false;
  limpiarTemporizadorSolicitud();

  if (enviando) {
    establecerEnviando(false);
  }
}

function limpiarTemporizadorSolicitud() {
  if (temporizadorSolicitud !== null) {
    window.clearTimeout(temporizadorSolicitud);
    temporizadorSolicitud = null;
  }
}

async function abrirSalaOCrearAviso(codigo) {
  const ruta = `/sala/${encodeURIComponent(codigo)}`;

  try {
    const respuesta = await window.fetch(ruta, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'text/html' }
    });

    if (respuesta.ok) {
      window.location.assign(ruta);
      return;
    }
  } catch (error) {
    // Si la pantalla de sala todavía no está disponible, se muestra el código aquí.
  }

  const regionLista = buscarPorId('sala-lista');
  const codigoCreado = buscarPorId('codigo-creado');
  const enlaceSala = buscarPorId('enlace-sala');
  const textoLista = buscarPorId('texto-sala-lista');
  const regionError = buscarPorId('error-perfil');

  finalizarEnvio();
  mostrarAviso(regionError, '');

  if (codigoCreado) {
    codigoCreado.textContent = codigo;
  }

  if (enlaceSala) {
    enlaceSala.href = ruta;
  }

  if (textoLista) {
    textoLista.textContent = accionPerfil === 'crear'
      ? 'La sala está creada. La pantalla de juego todavía no está disponible; comparte este código para probar el flujo:'
      : 'La entrada a la sala está confirmada. La pantalla de juego todavía no está disponible; este es el código de la sala:';
  }

  if (regionLista) {
    regionLista.hidden = false;
    regionLista.focus();
  }
}

function manejarErrorServidor(datos) {
  const mensaje = obtenerMensajeError(datos) || 'El servidor rechazó la acción. Revisa los datos e inténtalo de nuevo.';

  if (document.body.dataset.pagina === 'inicio') {
    mostrarAviso(buscarPorId('error-inicio'), mensaje);
    return;
  }

  if (document.body.dataset.pagina === 'perfil') {
    finalizarEnvio();
    mostrarAviso(buscarPorId('error-perfil'), mensaje);
  }
}

function obtenerMensajeError(datos) {
  if (typeof datos === 'string') {
    return datos;
  }

  if (!datos || typeof datos !== 'object') {
    return '';
  }

  if (typeof datos.mensaje === 'string') {
    return datos.mensaje;
  }

  if (typeof datos.error === 'string') {
    return datos.error;
  }

  if (datos.error && typeof datos.error.mensaje === 'string') {
    return datos.error.mensaje;
  }

  return '';
}

function mostrarAviso(region, mensaje) {
  if (!region) {
    return;
  }

  region.textContent = mensaje;
  region.hidden = !mensaje;
}
