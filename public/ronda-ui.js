// Presentación exclusivamente: nunca se sortea un valor ni se liquida una apuesta aquí.
const formatoNeto = new Intl.NumberFormat('es-MX', { signDisplay: 'exceptZero' });

function tituloDelResultado(resultado) {
  if (resultado?.lado) return `Salió ${resultado.lado}`;
  if (resultado?.numero != null) return `Salió el ${resultado.numero}${resultado.color ? ` · ${resultado.color}` : ''}`;
  if (resultado?.casa) return `Casa: ${resultado.casa.puntos} puntos`;
  return 'Mano cerrada';
}

function tonoDelNeto(neto) {
  return neto > 0 ? 'positivo' : neto < 0 ? 'negativo' : 'neutro';
}

function crearVistaResultados() {
  const id = (clave) => document.getElementById(clave);
  const pieza = id('pieza-resultado');
  const saltar = id('saltar-animacion');
  const reducida = window.matchMedia('(prefers-reduced-motion: reduce)');
  const numero = new Intl.NumberFormat('es-MX');
  let rondaVista = null;
  let animacion = null;

  function terminar() {
    const conFoco = document.activeElement === saltar;
    if (animacion) {
      animacion.onfinish = null;
      animacion.cancel();
      animacion = null;
    }
    saltar.hidden = true;
    if (conFoco) id('estado-ronda').focus({ preventScroll: true });
  }
  saltar.addEventListener('click', terminar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !saltar.hidden && !e.isComposing && !e.defaultPrevented) {
      e.preventDefault();
      terminar();
    }
  });
  reducida.addEventListener('change', () => { if (reducida.matches) terminar(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) terminar(); });

  function mostrarPieza(juego, resultado) {
    const clave = `${juego}:${resultado.lado ?? resultado.numero ?? resultado.casa?.puntos ?? resultado.tipo}`;
    if (pieza.dataset.valor !== clave) {
      pieza.dataset.valor = clave;
      pieza.dataset.juego = juego;
      pieza.dataset.color = resultado.color || '';
      if (juego === 'dice') {
        // Distribución de puntos de la cara recibida; no hay caras intermedias al azar.
        const caras = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
        pieza.replaceChildren(...Array.from({ length: 9 }, (_, i) => {
          const punto = document.createElement('i');
          if (caras[resultado.numero]?.includes(i)) punto.className = 'punto';
          return punto;
        }));
      } else {
        pieza.textContent = resultado.lado ?? resultado.numero ?? resultado.casa?.puntos ?? '♦';
      }
    }
    pieza.hidden = false;
    id('emblema-espera').toggleAttribute('hidden', true);
  }

  function pintarBalance(sala, yoId) {
    id('nota-balance').textContent = sala.resultado?.tipo === 'devolucion'
      ? 'Mano cerrada con devolución; no se adjudicó un ganador.'
      : 'El pago incluye la apuesta. El neto indica cuánto ganó o perdió cada jugador.';
    const apuestas = new Map(sala.apuestas.map((a) => [a.jugadorId, a]));
    const jugadores = new Map(sala.jugadores.map((j) => [j.id, j.nombre]));
    // Conservar a quien apostó y salió: el acta no depende de que conserve su asiento.
    for (const a of apuestas.values()) if (!jugadores.has(a.jugadorId)) jugadores.set(a.jugadorId, a.nombre);
    const filas = [];
    for (const [jugadorId, nombre] of jugadores) {
      const a = apuestas.get(jugadorId);
      const fila = document.createElement('tr');
      const persona = document.createElement('th');
      persona.scope = 'row';
      const autor = document.createElement('strong');
      autor.textContent = `${nombre}${jugadorId === yoId ? ' · Tú' : ''}`;
      const opcion = JUEGOS_UI[sala.juego].opciones.find(([valor]) => valor === a?.opcion)?.[1];
      const detalle = document.createElement('small');
      detalle.textContent = a ? `${opcion || 'Apuesta'} · ${numero.format(a.totalAportado ?? a.monto)}` : 'Sin apuesta';
      persona.append(autor, detalle);
      const pago = document.createElement('td');
      pago.textContent = a?.pago != null ? numero.format(a.pago) : '—';
      const neto = document.createElement('td');
      const valor = a ? a.neto : 0;
      neto.textContent = valor == null ? '—' : formatoNeto.format(valor);
      neto.dataset.tono = tonoDelNeto(valor);
      fila.append(persona, pago, neto);
      filas.push(fila);
    }
    id('filas-balance').replaceChildren(...filas);
  }

  return {
    pintar(sala, yoId) {
      const cerrada = sala.fase === 'resultados';
      id('formulario-apuesta').hidden = cerrada;
      id('balance-ronda').hidden = !cerrada;
      id('etiqueta-tab-juego').textContent = cerrada ? 'Balance' : 'Apuesta';
      if (cerrada) {
        rondaVista = `${sala.codigo}:${sala.numeroRonda}`;
        if (sala.resultado) mostrarPieza(sala.juego, sala.resultado);
        pintarBalance(sala, yoId);
      }
    },
    // Solo el evento vivo «resultado» anima. Un estado repetido o una entrada tardía
    // muestra el mismo resultado estático; saltar jamás emite nada por el socket.
    revelar(ronda) {
      const clave = `${ronda.codigo}:${ronda.numeroRonda}`;
      if (rondaVista === clave || !ronda.resultado) return;
      rondaVista = clave;
      mostrarPieza(ronda.juego, ronda.resultado);
      if (reducida.matches || document.hidden || !pieza.animate) return;
      const rotar = ronda.juego === 'coinflip' ? 'rotateY' : 'rotate';
      const grados = ronda.juego === 'coinflip' ? -155 : -65;
      animacion = pieza.animate([
        { transform: `perspective(320px) translateY(3px) ${rotar}(${grados}deg) scale(.8)`, opacity: .55 },
        { transform: `perspective(320px) translateY(-2px) ${rotar}(9deg) scale(1.05)`, opacity: 1, offset: .72 },
        { transform: 'none', opacity: 1 }
      ], { duration: 1400, easing: 'ease-out' });
      saltar.hidden = false;
      animacion.onfinish = terminar;
    },
    limpiar() {
      terminar();
      rondaVista = null;
      pieza.hidden = true;
      id('emblema-espera').removeAttribute('hidden');
      id('filas-balance').replaceChildren();
      id('balance-ronda').hidden = true;
    }
  };
}
