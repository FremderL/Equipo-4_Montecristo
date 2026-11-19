// Solo presentación. La validez de la apuesta, el resultado y el saldo los decide el servidor.
const numerosExactos = (desde, hasta) => Array.from({ length: hasta - desde + 1 }, (_, i) => {
  const n = i + desde;
  return [`n:${n}`, `Número ${n}`];
});

const JUEGOS_UI = {
  coinflip: { nombre: 'Cara o Cruz', imagen: 'coin', icono: 'moneda', lanzamiento: 'Lanzar moneda',
    opciones: [['cara', 'Cara'], ['cruz', 'Cruz']] },
  dice: { nombre: 'Dados', imagen: 'dice', icono: 'dado', lanzamiento: 'Lanzar dado',
    opciones: [['bajo', 'Bajo (1–3)'], ['alto', 'Alto (4–6)'], ...numerosExactos(1, 6)] },
  roulette: { nombre: 'Ruleta europea', imagen: 'roulette', icono: 'ruleta', lanzamiento: 'Girar ruleta',
    opciones: [['rojo', 'Rojo'], ['negro', 'Negro'], ['par', 'Par'], ['impar', 'Impar'], ...numerosExactos(0, 36)] },
  blackjack: { nombre: 'Blackjack / 21', imagen: 'blackjack', icono: 'cartas', opciones: [['mano', 'Mano de blackjack']] },
  poker: { nombre: 'Texas Hold’em', imagen: 'poker', icono: 'cartas', opciones: [['mano', 'Entrada a la mano']] }
};
