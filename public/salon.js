function iniciarDirectorio() {
  const tabla = document.getElementById('tabla-salas');
  const filas = tabla.tBodies[0];
  const plantilla = document.getElementById('fila-sala');
  const total = document.getElementById('total-salas');
  const boton = document.getElementById('actualizar-salas');
  const aviso = document.getElementById('aviso-directorio');
  let cargando = false;
  let suscrito = false;

  function mensaje(titulo, detalle) {
    tabla.hidden = true;
    aviso.hidden = false;
    document.getElementById('estado-directorio').textContent = titulo;
    document.getElementById('detalle-directorio').textContent = detalle;
  }

  function actualizarFilas(salas) {
    // Reutilizar la fila mantiene el foco en «Entrar» durante los refrescos.
    const anteriores = new Map(Array.from(filas.rows, (fila) => [fila.dataset.codigo, fila]));
    for (const { codigo, juego, anfitrion, jugadores, capacidad } of salas) {
      let fila = anteriores.get(codigo);
      if (!fila) {
        fila = plantilla.content.firstElementChild.cloneNode(true);
        fila.dataset.codigo = codigo;
        const ficha = JUEGOS_UI[juego];
        fila.querySelector('img').src = `assets/${ficha.imagen}-lounge.jpg`;
        fila.querySelector('.juego-directorio strong').textContent = ficha.nombre;
        fila.querySelector('small').textContent = `Sala ${codigo}`;
        const enlace = fila.querySelector('.entrar-mesa');
        enlace.href = `/sala/${encodeURIComponent(codigo)}`;
        enlace.setAttribute('aria-label', `Entrar a ${ficha.nombre}, sala ${codigo}`);
        filas.append(fila);
      }
      anteriores.delete(codigo);
      fila.querySelector('.anfitrion').textContent = anfitrion;
      fila.querySelector('.inicial').textContent = Array.from(anfitrion)[0].toUpperCase();
      fila.querySelector('.cupos strong').textContent = `${jugadores}/${capacidad}`;
      const marcas = fila.querySelector('.cupos__marcas');
      marcas.replaceChildren(...Array.from({ length: capacidad }, (_, i) => {
        const marca = document.createElement('i');
        if (i < jugadores) marca.className = 'ocupada';
        return marca;
      }));
    }
    anteriores.forEach((fila) => fila.remove());
    total.hidden = false;
    total.textContent = String(salas.length);
    if (!salas.length) {
      mensaje('Todavía no hay salas abiertas', 'Crea una sala o vuelve cuando se libere un asiento.');
    } else {
      aviso.hidden = true;
      tabla.hidden = false;
    }
  }

  function aplicarSalas(salas) {
    actualizarFilas(salas.filter((sala) => sala.jugadores < sala.capacidad));
  }

  async function consultar() {
    if (cargando) return;
    cargando = true;
    boton.setAttribute('aria-busy', 'true');
    try {
      // no-cache = revalidar con ETag: si el directorio no cambió llega un 304 sin cuerpo.
      const respuesta = await fetch('/api/salas', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (!respuesta.ok) throw new Error();
      const datos = await respuesta.json();
      if (!datos.ok || !Array.isArray(datos.salas)) throw new Error();
      aplicarSalas(datos.salas);
    } catch {
      total.hidden = true;
      mensaje('No se pudo cargar el directorio', 'Comprueba la conexión y pulsa Actualizar para volver a intentarlo.');
    } finally {
      cargando = false;
      boton.removeAttribute('aria-busy');
    }
  }

  // Con WebSocket abierto el servidor avisa cuando entra o sale alguien: se acabó
  // pedir la lista cada 5 segundos. El sondeo queda solo como respaldo sin socket.
  function suscribirAlSocket() {
    if (suscrito || !socket || !socket.connected) return;
    suscrito = true;
    socket.on('salas_actualizadas', (datos) => {
      if (datos && Array.isArray(datos.salas)) aplicarSalas(datos.salas);
    });
    consultar(); // por si cambió algo mientras no había conexión
  }

  boton.addEventListener('click', consultar);
  window.addEventListener('montecristo:socket-listo', suscribirAlSocket);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) consultar(); });
  window.setInterval(() => {
    if (!document.hidden && (!socket || !socket.connected)) consultar();
  }, 30000);
  suscribirAlSocket();
  consultar();
}
