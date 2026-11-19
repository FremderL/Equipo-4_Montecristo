// estado_sala es la fuente de verdad: ni el formulario ni el ack descuentan fichas.
function crearVistaMesa(obtenerSocket) {
  const id = (clave) => document.getElementById(clave);
  const opciones = id('opcion-apuesta');
  const monto = id('monto-apuesta');
  const controles = id('controles-apuesta');
  const confirmar = id('confirmar-apuesta');
  const ayuda = id('ayuda-apuesta');
  const atajos = Array.from(controles.querySelectorAll('[data-monto]'));
  const accionRonda = id('accion-ronda');
  const formato = new Intl.NumberFormat('es-MX');
  const fases = { espera: 'En espera', apuestas: 'Fase de apuestas', jugando: 'En juego', resultados: 'Resultados' };
  const resultados = crearVistaResultados();
  const chat = crearChatMesa(obtenerSocket);
  let sala = null;
  let yo = null;
  let mano = null;
  let pendiente = null;

  function pintarAsientos() {
    const lista = Array.from({ length: sala.capacidad }, (_, i) => {
      const jugador = sala.jugadores.find((j) => j.asiento === i + 1);
      const propio = jugador?.id === yo.id;
      const lugar = document.createElement('li');
      lugar.className = `asiento${propio ? ' asiento--propio' : ''}${jugador ? '' : ' asiento--libre'}`;
      const avatar = document.createElement('span');
      avatar.className = 'asiento__avatar';
      avatar.textContent = jugador ? jugador.avatar : '+';
      if (jugador) {
        avatar.setAttribute('role', 'img');
        avatar.setAttribute('aria-label', ETIQUETAS_AVATAR[jugador.avatar] || 'Avatar de jugador');
      } else avatar.setAttribute('aria-hidden', 'true');
      const texto = document.createElement('div');
      const numero = document.createElement('small');
      numero.textContent = `Asiento ${String(i + 1).padStart(2, '0')}${propio ? ' · Tú' : ''}`;
      const nombre = document.createElement('strong');
      nombre.textContent = jugador?.nombre ?? 'Libre';
      nombre.title = nombre.textContent;
      texto.append(numero, nombre);
      if (jugador) {
        const saldo = document.createElement('span');
        saldo.className = 'asiento__saldo';
        saldo.textContent = `${formato.format(jugador.fichas)} fichas`;
        texto.append(saldo);
      }
      if (jugador && sala.fase === 'jugando' && sala.turno?.activo && sala.turno.jugadorId === jugador.id) {
        lugar.classList.add('asiento--turno');
        const marca = document.createElement('span');
        marca.className = 'marca-turno';
        marca.textContent = 'En turno';
        texto.append(marca);
      } else if (jugador && sala.fase === 'resultados') {
        const apuesta = sala.apuestas.find((a) => a.jugadorId === jugador.id);
        const neto = document.createElement('span');
        neto.className = 'asiento__neto';
        neto.dataset.tono = tonoDelNeto(apuesta?.neto);
        neto.textContent = !apuesta ? 'Sin apuesta' : apuesta.neto == null ? 'Pendiente' : `${formatoNeto.format(apuesta.neto)} fichas`;
        texto.append(neto);
      }
      lugar.append(avatar, texto);
      return lugar;
    });
    id('asientos').replaceChildren(...lista);
    id('ocupacion-sala').textContent = `${sala.jugadores.length}/${sala.capacidad} jugadores`;
  }

  function pintarCartas() {
    const lineas = [];
    if (sala.casa) lineas.push(`Casa: ${sala.casa.cartas.map((c) => c ?? '▧').join('  ')} · ${sala.casa.puntos} pts.`);
    if (mano && mano.numeroRonda === sala.numeroRonda) lineas.push(`Tu mano: ${mano.cartas.join('  ')} · ${mano.puntos} pts.`);
    id('cartas-mesa').textContent = lineas.join('     |     ');
    id('cartas-mesa').hidden = !lineas.length;
  }

  function pintarCentro() {
    const juego = JUEGOS_UI[sala.juego];
    id('titulo-mesa').textContent = juego.nombre;
    id('numero-ronda').textContent = `Ronda ${String(sala.numeroRonda).padStart(2, '0')}`;
    id('emblema-juego').setAttribute('href', `assets/mesa-iconos.svg#${juego.icono}`);
    let titulo, detalle;
    if (sala.fase === 'espera') {
      titulo = 'Preparando la mesa';
      detalle = 'Las apuestas todavía no están abiertas.';
    } else if (sala.fase === 'apuestas') {
      titulo = 'Apuestas abiertas';
      const n = sala.apuestas.length;
      detalle = n === 1 ? '1 apuesta confirmada' : `${n} apuestas confirmadas`;
    } else if (sala.fase === 'jugando') {
      const turno = sala.jugadores.find((j) => j.id === sala.turno?.jugadorId);
      titulo = turno ? (turno.id === yo.id ? 'Es tu turno' : `Turno de ${turno.nombre}`) : 'Ronda en curso';
      detalle = turno ? `${turno.id === yo.id ? turno.nombre + ' · ' : ''}Turno ${sala.turno.posicion} de ${sala.turno.total}` : 'Las apuestas están cerradas.';
    } else {
      titulo = tituloDelResultado(sala.resultado);
      detalle = sala.resultado?.tipo === 'devolucion' ? 'Cierre con devolución de fichas.' : 'Resultado confirmado por el servidor.';
    }
    // No volver a anunciar el mismo aviso al llegar el estado que sigue al evento.
    for (const [clave, texto] of [['fase-mesa', fases[sala.fase]], ['estado-ronda', titulo], ['detalle-ronda', detalle]]) {
      if (id(clave).textContent !== texto) id(clave).textContent = texto;
    }
    pintarCartas();
  }

  function pintarApuesta() {
    if (!yo) return;
    const apuesta = sala.apuestas.find((a) => a.jugadorId === yo.id);
    const saldo = yo.fichas;
    const minimo = sala.apuestaMinima;
    const editable = obtenerSocket()?.connected && sala.fase === 'apuestas' && !apuesta && saldo >= minimo && !pendiente;
    const cantidad = monto.valueAsNumber;
    const entero = Number.isSafeInteger(cantidad);
    const valido = entero && cantidad >= minimo && cantidad <= saldo;
    controles.disabled = !editable;
    confirmar.disabled = !editable || !valido || !opciones.value;
    confirmar.classList.toggle('confirmada', Boolean(apuesta));
    id('texto-confirmar').textContent = apuesta ? 'Apuesta confirmada' : pendiente?.evento === 'apostar' ? 'Confirmando…' : 'Confirmar apuesta';
    id('icono-confirmar').textContent = apuesta ? '✓' : '→';
    monto.max = saldo;
    monto.setAttribute('aria-invalid', String(Boolean(editable && !valido)));
    id('saldo-jugador').textContent = formato.format(saldo);
    atajos.forEach((btn) => {
      const valor = btn.dataset.monto === 'max' ? saldo : Number(btn.dataset.monto);
      btn.disabled = valor < minimo || valor > saldo;
      btn.classList.toggle('elegido', valor === cantidad && editable);
    });

    let texto;
    if (sala.fase === 'espera') texto = 'Espera a que el anfitrión abra las apuestas.';
    else if (sala.fase === 'jugando') texto = 'Apuestas cerradas mientras se juega la ronda.';
    else if (sala.fase === 'resultados') {
      texto = apuesta?.neto != null
        ? `Resultado de tu apuesta: ${apuesta.neto > 0 ? '+' : ''}${formato.format(apuesta.neto)} fichas netas.`
        : 'Ronda cerrada. Espera a la siguiente para apostar.';
    } else if (apuesta) texto = `Apuesta confirmada: ${formato.format(apuesta.monto)} fichas · ${opciones.selectedOptions[0]?.textContent}.`;
    else if (saldo < minimo) texto = `Saldo insuficiente. Necesitas al menos ${minimo} fichas para apostar.`;
    else if (pendiente) texto = 'Esperando confirmación del servidor…';
    else if (!entero || cantidad < minimo) texto = `El monto debe ser entero y de al menos ${minimo} fichas.`;
    else if (cantidad > saldo) texto = `Saldo insuficiente. Tienes ${formato.format(saldo)} fichas disponibles.`;
    else texto = `Mínimo ${minimo} fichas. Una apuesta por ronda.`;
    ayuda.textContent = texto;
    ayuda.classList.toggle('atencion', sala.fase === 'apuestas' && !apuesta && (!valido || saldo < minimo));
  }

  // La misma botonera sigue al rol y a la fase que difunde el servidor.
  function accionDisponible() {
    if (sala.fase === 'jugando' && sala.turno?.jugadorId === yo.id) {
      return sala.juego === 'blackjack'
        ? { evento: 'accion_blackjack', texto: 'Plantarse', datos: { accion: 'stand' } }
        : { evento: 'accion_poker', texto: 'Pasar', datos: { accion: 'check' } };
    }
    if (!yo.esAnfitrion) return null;
    if (sala.fase === 'espera') return { evento: 'comenzar', texto: 'Abrir apuestas', bloqueada: sala.juego === 'poker' && sala.jugadores.length < 2 };
    if (sala.fase === 'resultados') return { evento: 'nueva_ronda', texto: 'Nueva ronda' };
    if (sala.fase === 'apuestas') {
      const lanzamiento = JUEGOS_UI[sala.juego].lanzamiento;
      return { evento: lanzamiento ? 'lanzar' : 'repartir', texto: lanzamiento || 'Repartir cartas', bloqueada: !sala.apuestas.length };
    }
    return null;
  }

  function pintarAcciones() {
    if (!sala) return;
    const accion = accionDisponible();
    accionRonda.hidden = !accion;
    accionRonda.disabled = !accion || accion.bloqueada || Boolean(pendiente);
    accionRonda.textContent = accion?.texto || '';
    const nota = id('nota-ronda');
    nota.textContent = accion?.bloqueada && sala.fase === 'espera' ? 'Se necesitan dos jugadores.' : !accion ? 'Espera a que avance la ronda.' : '';
    nota.hidden = !nota.textContent;
    pintarApuesta();
  }

  async function enviar(evento, datos = null) {
    const socket = obtenerSocket();
    if (!sala || !socket?.connected || pendiente) return;
    const solicitud = { evento };
    pendiente = solicitud;
    mostrarAviso(id('error-mesa'), '');
    pintarAcciones();
    try {
      const respuesta = await socket.timeout(8000).emitWithAck(evento, datos);
      if (!respuesta?.ok && pendiente === solicitud) mostrarAviso(id('error-mesa'), obtenerMensajeError(respuesta) || 'La mesa rechazó la acción.');
    } catch {
      if (pendiente === solicitud) mostrarAviso(id('error-mesa'), 'No llegó la confirmación. Comprueba el estado de la mesa antes de reintentar.');
    } finally {
      if (pendiente === solicitud) {
        pendiente = null;
        pintarAcciones();
      }
    }
  }

  monto.addEventListener('input', pintarApuesta);
  opciones.addEventListener('change', pintarApuesta);
  atajos.forEach((btn) => btn.addEventListener('click', () => {
    monto.value = btn.dataset.monto === 'max' ? yo.fichas : btn.dataset.monto;
    pintarApuesta();
  }));
  id('formulario-apuesta').addEventListener('submit', (e) => {
    e.preventDefault();
    pintarApuesta();
    if (!confirmar.disabled && !controles.disabled) enviar('apostar', { opcion: opciones.value, monto: monto.valueAsNumber });
  });
  accionRonda.addEventListener('click', () => {
    const accion = sala && accionDisponible();
    if (accion && !accion.bloqueada) enviar(accion.evento, accion.datos);
  });

  function recibir(estado) {
    const jugador = estado.jugadores.find((j) => j.id === obtenerSocket()?.id);
    if (!jugador) return;
    chat.entrar(estado.codigo); // no borra la conversación al cambiar de ronda
    if (estado.codigo !== sala?.codigo || estado.numeroRonda !== sala?.numeroRonda) {
      resultados.limpiar();
      mostrarAviso(id('aviso-automatico'), '');
      mano = null;
      opciones.replaceChildren(...JUEGOS_UI[estado.juego].opciones.map(([valor, texto]) => new Option(texto, valor)));
      monto.min = monto.value = estado.apuestaMinima;
      mostrarAviso(id('error-mesa'), '');
    }
    sala = estado;
    yo = jugador;
    const apuesta = sala.apuestas.find((a) => a.jugadorId === yo.id);
    if (apuesta) {
      opciones.value = apuesta.opcion;
      monto.value = apuesta.monto;
    }
    const anfitrion = sala.jugadores.find((j) => j.esAnfitrion);
    id('anfitrion-mesa').textContent = `${anfitrion.nombre}${yo.esAnfitrion ? ' · Tú' : ''}`;
    const ultimoAuto = sala.acciones.filter((a) => a.automatica).at(-1);
    if (ultimoAuto) {
      const autor = sala.apuestas.find((a) => a.jugadorId === ultimoAuto.jugadorId)?.nombre || 'Jugador';
      avisoAutomatico(autor, ultimoAuto.mensaje);
    }
    pintarAsientos();
    pintarCentro();
    pintarAcciones();
    resultados.pintar(sala, yo.id);
  }

  function avisoAutomatico(nombre, mensaje) {
    const texto = `${nombre} · ${mensaje}`;
    if (id('aviso-automatico').textContent !== texto) mostrarAviso(id('aviso-automatico'), texto);
  }

  const mismaRonda = (d) => sala && d.codigo === sala.codigo && d.numeroRonda === sala.numeroRonda;
  return {
    recibir,
    recibirMensaje: chat.recibir,
    recibirTurno(turno) {
      if (!mismaRonda(turno) || sala.fase === 'resultados') return;
      recibir({ ...sala, turno: turno.activo ? turno : null, fase: turno.activo ? 'jugando' : sala.fase });
    },
    recibirAutomatico(aviso) {
      if (mismaRonda(aviso)) avisoAutomatico(aviso.nombre, aviso.mensaje);
    },
    recibirResultado(ronda) {
      if (!mismaRonda(ronda) || ronda.juego !== sala.juego) return;
      resultados.revelar(ronda);
      // El aviso ya trae los netos, pero solo estado_sala actualiza los saldos.
      recibir({ ...sala, fase: 'resultados', turno: null, resultado: ronda.resultado, apuestas: ronda.apuestas });
    },
    recibirCartas(datos) {
      if (sala && datos.numeroRonda === sala.numeroRonda) {
        mano = datos;
        pintarCartas();
      }
    },
    limpiar() {
      resultados.limpiar();
      chat.entrar(null);
      sala = yo = mano = pendiente = null;
      controles.disabled = confirmar.disabled = true;
      id('cartas-mesa').replaceChildren();
      id('asientos').replaceChildren();
    }
  };
}
