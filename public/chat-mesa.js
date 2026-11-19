function crearChatMesa(obtenerSocket) {
  const id = (clave) => document.getElementById(clave);
  const tabs = [id('tab-juego'), id('tab-chat')];
  const campo = id('texto-chat');
  const enviar = id('enviar-chat');
  const lista = id('mensajes-chat');
  const registro = id('registro-chat');
  const badge = id('no-leidos');
  const horaLocal = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  let sala = null;
  let pendiente = null;
  let noLeidos = 0;

  function pintarNoLeidos() {
    badge.hidden = !noLeidos;
    badge.textContent = noLeidos > 99 ? '99+' : String(noLeidos);
    tabs[1].setAttribute('aria-label', noLeidos ? `Chat de sala, ${noLeidos} sin leer` : 'Chat de sala');
  }

  function activar(tab) {
    tabs.forEach((t) => {
      t.setAttribute('aria-selected', String(t === tab));
      t.tabIndex = t === tab ? 0 : -1;
      id(t.getAttribute('aria-controls')).hidden = t !== tab;
    });
    if (tab === tabs[1]) {
      noLeidos = 0;
      pintarNoLeidos();
      registro.scrollTop = registro.scrollHeight;
    }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activar(tab));
    tab.addEventListener('keydown', (e) => {
      const indice = { ArrowRight: 1 - i, ArrowLeft: 1 - i, Home: 0, End: 1 }[e.key];
      if (indice == null) return;
      e.preventDefault();
      activar(tabs[indice]);
      tabs[indice].focus();
    });
  });

  function validar() {
    const largo = campo.value.trim().length;
    enviar.disabled = !sala || !obtenerSocket()?.connected || Boolean(pendiente) || !largo || largo > campo.maxLength;
    id('contador-chat').textContent = `${campo.value.length}/${campo.maxLength}`;
  }
  campo.addEventListener('input', () => { mostrarAviso(id('error-chat'), ''); validar(); });
  id('formulario-chat').addEventListener('submit', async (e) => {
    e.preventDefault(); // Enter y el botón pasan por la misma validación
    validar();
    if (enviar.disabled) return;
    const borrador = campo.value;
    const solicitud = obtenerSocket().timeout(6000).emitWithAck('chat', { texto: borrador.trim() });
    pendiente = solicitud;
    validar();
    mostrarAviso(id('error-chat'), '');
    try {
      const respuesta = await solicitud;
      if (pendiente !== solicitud) return;
      if (!respuesta?.ok) mostrarAviso(id('error-chat'), obtenerMensajeError(respuesta) || 'El mensaje no se envió.');
      else if (campo.value === borrador) campo.value = ''; // no borrar el siguiente mensaje mientras llega el ack
    } catch {
      if (pendiente === solicitud) mostrarAviso(id('error-chat'), 'No llegó la confirmación. Revisa la conversación antes de reenviar.');
    } finally {
      if (pendiente === solicitud) { pendiente = null; validar(); }
    }
  });

  function entrar(codigo) {
    if (sala === codigo) return;
    sala = codigo;
    pendiente = null;
    lista.replaceChildren();
    campo.value = '';
    id('chat-vacio').hidden = false;
    noLeidos = 0;
    pintarNoLeidos();
    mostrarAviso(id('error-chat'), '');
    activar(tabs[0]);
    validar();
  }

  return {
    entrar,
    recibir({ codigo, jugadorId, nombre, texto, hora }) {
      if (!sala || codigo !== sala) return;
      const propio = jugadorId === obtenerSocket()?.id;
      const alFinal = registro.scrollHeight - registro.clientHeight - registro.scrollTop < 12;
      const mensaje = document.createElement('li');
      mensaje.className = propio ? 'mensaje-chat propio' : 'mensaje-chat';
      const meta = document.createElement('div');
      const autor = document.createElement('strong');
      autor.textContent = `${nombre}${propio ? ' · Tú' : ''}`;
      const tiempo = document.createElement('time');
      tiempo.dateTime = hora;
      tiempo.textContent = horaLocal.format(new Date(hora));
      meta.append(autor, tiempo);
      const cuerpo = document.createElement('p');
      cuerpo.textContent = texto;
      mensaje.append(meta, cuerpo);
      // Única fuente de mensajes: el eco del servidor, también para quien escribe.
      id('chat-vacio').hidden = true;
      lista.append(mensaje);
      if (lista.children.length > 100) lista.firstElementChild.remove();
      if (id('panel-chat').hidden && !propio) { noLeidos++; pintarNoLeidos(); }
      if (alFinal || propio) registro.scrollTop = registro.scrollHeight;
    }
  };
}
