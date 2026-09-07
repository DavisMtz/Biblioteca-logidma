/* Catálogo: carga, búsqueda, filtro por categoría y el movimiento de todo ello.

   Regla del proyecto, que aquí manda especialmente: ninguna animación es lo
   único que hace visible algo. Todo nace en su sitio y GSAP solo lo trae desde
   otro lado, así que si no llega a correr —pestaña de fondo, GSAP que no cargó,
   movimiento reducido— la página se ve igual, sin adorno. */

const rejilla = document.getElementById('rejilla');
const filtros = document.getElementById('filtros');
const buscar = document.getElementById('buscar');
const limpiarBusqueda = document.getElementById('limpiar-busqueda');

let categoriaActiva = '';
let ultimaBusqueda = '';
let primeraCarga = true;
let peticion = 0;             // para descartar respuestas que lleguen tarde

/** Ni GSAP ni ganas de movimiento: el adorno se queda fuera, la página no. */
const sinAdorno = () =>
  typeof gsap === 'undefined' || matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------ pintar ------------------------------ */

function esqueletos(n = 10) {
  rejilla.dataset.estado = 'esqueletos';
  rejilla.replaceChildren();
  for (let i = 0; i < n; i++) {
    const hueco = document.createElement('div');
    hueco.className = 'libro';
    hueco.setAttribute('aria-hidden', 'true');
    hueco.innerHTML = `
      <div class="libro__portada esqueleto"></div>
      <div class="libro__datos">
        <div class="esqueleto" style="height:14px;width:85%"></div>
        <div class="esqueleto" style="height:12px;width:55%;margin-top:6px"></div>
      </div>`;
    rejilla.append(hueco);
  }
}

function crearTarjeta(libro) {
  /* Los puntos de separación los pone el CSS, no el marcado: así se puede
     esconder un dato en pantalla estrecha y su punto se va con él. Con los
     puntos escritos a mano quedaba «1663 pág. · 1.2 MB ·» y el año solo en la
     línea de abajo. El peso es lo primero que sobra: a quien va a leer le
     importan las páginas y el año, no cuánto ocupa el archivo. */
  const datos = [];
  if (libro.paginas) datos.push(['', `${libro.paginas} pág.`]);
  datos.push(['libro__peso', Bib.pesoLegible(libro.tamano)]);
  if (libro.anio) datos.push(['', String(libro.anio)]);
  const meta = datos.map(([clase, texto]) =>
    `<span${clase ? ` class="${clase}"` : ''}>${Bib.escapar(texto)}</span>`).join('');

  const nodo = document.createElement('a');
  nodo.className = 'libro';
  nodo.href = `/leer?id=${encodeURIComponent(libro.id)}`;
  nodo.dataset.id = libro.id;
  nodo.innerHTML = `
    <div class="libro__portada">${Bib.portadaHTML(libro)}</div>
    <div class="libro__datos">
      <span class="libro__titulo">${Bib.escapar(libro.titulo)}</span>
      ${libro.autor ? `<span class="libro__autor">${Bib.escapar(libro.autor)}</span>` : ''}
      <span class="libro__meta">${meta}</span>
    </div>`;
  return nodo;
}

/* Las tarjetas que siguen estando NO se vuelven a crear: se mueven. Rehacerlas
   obligaría al navegador a pedir otra vez cada portada y a descodificarla, y
   filtrar pasaría de ser instantáneo a parpadear entero. */
function repartir(libros) {
  const antes = new Map();
  for (const nodo of rejilla.children) if (nodo.dataset.id) antes.set(nodo.dataset.id, nodo);

  const nuevas = [];
  const orden = libros.map((libro) => {
    const previa = antes.get(libro.id);
    if (previa) { antes.delete(libro.id); return previa; }
    const nodo = crearTarjeta(libro);
    nuevas.push(nodo);
    return nodo;
  });
  return { orden, nuevas, salen: [...antes.values()] };
}

async function pintarLibros(libros) {
  const veniaDeLibros = rejilla.dataset.estado === 'libros';
  if (!veniaDeLibros) rejilla.replaceChildren();
  const { orden, nuevas, salen } = repartir(libros);
  rejilla.dataset.estado = 'libros';

  if (!veniaDeLibros || sinAdorno() || typeof Flip === 'undefined') {
    for (const nodo of salen) nodo.remove();
    rejilla.append(...orden);
    return { nuevas, deEstreno: !veniaDeLibros };
  }

  /* 1. Primero se van las que se van, y solas. Si todo se moviera a la vez, no
        se entendería que unas desaparecieron por no encajar con el filtro y las
        otras solo cerraron filas. */
  if (salen.length) {
    await new Promise((listo) => {
      gsap.to(salen, {
        opacity: 0, scale: 0.92, duration: 0.24, ease: 'power2.in',
        stagger: { each: 0.015, from: 'end' }, onComplete: listo,
      });
    });
    for (const nodo of salen) nodo.remove();
  }

  /* 2. Y las que quedan cierran filas por el camino corto. Flip mide dónde
        estaba cada una, deja que el navegador recoloque la rejilla, y anima el
        trayecto entre las dos posiciones. */
  const quedan = orden.filter((nodo) => nodo.isConnected);
  const estado = Flip.getState(quedan);
  rejilla.append(...orden);
  if (quedan.length) {
    Flip.from(estado, {
      duration: 0.5, ease: 'power3.inOut', absolute: true,
      stagger: { each: 0.012, from: 'start' },
    });
  }
  return { nuevas, deEstreno: false };
}

function pintarVacio(hayFiltro) {
  rejilla.dataset.estado = 'vacio';
  rejilla.innerHTML = `
    <div class="vacio" style="grid-column:1/-1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/>
        <path d="M11 4h7.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11z"/>
      </svg>
      <h2>${hayFiltro ? 'Sin resultados' : 'La estantería está vacía'}</h2>
      <p>${hayFiltro
        ? 'Ningún libro coincide con esa búsqueda. Prueba con otras palabras o quita el filtro de categoría.'
        : 'Todavía no hay documentos publicados.'}</p>
    </div>`;
  Bib.animar((tl) => tl.from('.vacio > *', { y: 16, opacity: 0, stagger: 0.07, duration: 0.45 }));
}

/* ------------------------------ filtros ------------------------------ */

let firmaFiltros = null;

function pintarFiltros(categorias) {
  // Las cuentas no dependen de la búsqueda, así que casi nunca cambian. Si no
  // han cambiado, los botones no se rehacen: rehacerlos haría saltar la
  // pastilla en vez de dejarla deslizarse.
  const firma = categorias.map((c) => `${c.categoria}:${c.n}`).join('|');
  const rehacer = firma !== firmaFiltros;
  firmaFiltros = firma;

  if (rehacer) {
    if (!categorias.length) { filtros.replaceChildren(); return; }
    const pastilla = document.createElement('span');
    pastilla.className = 'filtros__pastilla';
    filtros.replaceChildren(pastilla);
    for (const c of [{ categoria: '', n: null }, ...categorias]) {
      const boton = document.createElement('button');
      boton.className = 'filtro';
      boton.type = 'button';
      boton.dataset.cat = c.categoria;
      boton.innerHTML = c.categoria
        ? `${Bib.escapar(c.categoria)} <span aria-hidden="true">${c.n}</span>`
        : 'Todas';
      filtros.append(boton);
    }
  }
  for (const boton of filtros.querySelectorAll('.filtro')) {
    boton.setAttribute('aria-pressed', String(boton.dataset.cat === categoriaActiva));
  }
  colocarPastilla(!rehacer);
}

/* La pastilla se desliza de un filtro a otro en vez de encenderse y apagarse.
   Es lo que convierte «he pulsado un botón» en «me he movido a otro sitio». */
function colocarPastilla(deslizando) {
  const pastilla = filtros.querySelector('.filtros__pastilla');
  const activo = filtros.querySelector('.filtro[aria-pressed="true"]');
  if (!pastilla || !activo) return;
  if (sinAdorno()) {
    // Sin GSAP la pastilla no se puede colocar: manda la regla del CSS, que
    // pinta el propio botón activo. Ese es el aspecto de siempre.
    delete filtros.dataset.pastilla;
    return;
  }
  const destino = {
    x: activo.offsetLeft, y: activo.offsetTop,
    width: activo.offsetWidth, height: activo.offsetHeight,
  };
  filtros.dataset.pastilla = '1';
  if (deslizando) gsap.to(pastilla, { ...destino, duration: 0.45, ease: 'power3.out', overwrite: 'auto' });
  else gsap.set(pastilla, destino);
}

/* Al filtrar, el botón elegido se acerca al centro de la tira: en un teléfono
   la categoría que se acaba de tocar puede quedar medio salida por un borde. */
function acercarFiltro(boton) {
  const izq = boton.offsetLeft - (filtros.clientWidth - boton.offsetWidth) / 2;
  filtros.scrollTo({ left: Math.max(0, izq), behavior: sinAdorno() ? 'auto' : 'smooth' });
}

/* ------------------------------ carga ------------------------------ */

async function cargar() {
  const mia = ++peticion;
  rejilla.setAttribute('aria-busy', 'true');
  if (rejilla.dataset.estado === 'libros') rejilla.dataset.cargando = '1';

  const parametros = new URLSearchParams();
  if (ultimaBusqueda) parametros.set('q', ultimaBusqueda);
  if (categoriaActiva) parametros.set('categoria', categoriaActiva);

  try {
    const datos = await Bib.api(`/api/libros?${parametros}`);
    // Escribir rápido dispara varias peticiones y la lenta puede llegar la
    // última: solo pinta la más reciente.
    if (mia !== peticion) return;
    delete rejilla.dataset.cargando;

    Bib.contar(document.getElementById('cifra-libros'), datos.libros.length);
    Bib.contar(document.getElementById('cifra-categorias'), datos.categorias.length);
    pintarFiltros(datos.categorias);

    if (!datos.libros.length) {
      pintarVacio(Boolean(ultimaBusqueda || categoriaActiva));
    } else {
      const { nuevas, deEstreno } = await pintarLibros(datos.libros);
      if (mia !== peticion) return;
      if (primeraCarga) { primeraCarga = false; animarEntrada(nuevas); }
      else if (deEstreno) repartirEntrada(nuevas);
      else entrarLasNuevas(nuevas);
    }
    // El enlace al panel solo se enseña a quien ya entró.
    document.getElementById('enlace-admin').hidden = !datos.admin;
  } catch (error) {
    if (mia !== peticion) return;
    delete rejilla.dataset.cargando;
    rejilla.dataset.estado = 'error';
    rejilla.innerHTML = `<div class="aviso aviso--error" style="grid-column:1/-1">
      No se pudo cargar el catálogo: ${Bib.escapar(error.message)}</div>`;
  } finally {
    if (mia === peticion) rejilla.setAttribute('aria-busy', 'false');
  }
}

filtros.addEventListener('click', (e) => {
  const boton = e.target.closest('.filtro');
  if (!boton || boton.dataset.cat === categoriaActiva) return;
  categoriaActiva = boton.dataset.cat;
  for (const otro of filtros.querySelectorAll('.filtro')) {
    otro.setAttribute('aria-pressed', String(otro === boton));
  }
  // La pastilla se mueve YA, sin esperar a la red: el botón tiene que acusar
  // el toque en el mismo momento en que se toca.
  colocarPastilla(true);
  acercarFiltro(boton);
  cargar();
});

let retardo;
buscar.addEventListener('input', () => {
  limpiarBusqueda.hidden = !buscar.value;
  clearTimeout(retardo);
  retardo = setTimeout(() => {
    ultimaBusqueda = buscar.value.trim();
    cargar();
  }, 250);
});

limpiarBusqueda.addEventListener('click', () => {
  buscar.value = '';
  limpiarBusqueda.hidden = true;
  buscar.focus();
  clearTimeout(retardo);
  if (ultimaBusqueda) { ultimaBusqueda = ''; cargar(); }
});

/* ---------------- movimiento ---------------- */

/** Parte el titular en palabras para poder entrarlas una a una. */
function partirTitular(elemento) {
  if (!elemento || elemento.querySelector('.palabra')) return [];
  const palabras = elemento.textContent.trim().split(/\s+/);
  elemento.textContent = '';
  return palabras.map((texto, i) => {
    const palabra = document.createElement('span');
    palabra.className = 'palabra';
    palabra.textContent = texto;
    elemento.append(palabra);
    if (i < palabras.length - 1) elemento.append(' ');
    return palabra;
  });
}

/** La página se abre: cabecera, titular, cifras, filtros y la primera hornada
    de lomos, todo en la misma línea de tiempo para que se lea como un gesto. */
function animarEntrada(tarjetas) {
  const titular = document.querySelector('.portada h1');
  const palabras = Bib.sinMovimiento() ? [] : partirTitular(titular);
  const primeras = aLaVista(tarjetas);

  Bib.animar((tl) => {
    tl.from('.marca', { x: -16, opacity: 0, duration: 0.5 }, 0)
      .from('.buscador', { y: -10, opacity: 0, duration: 0.45 }, 0.06)
      .from('.cabecera .btn', { y: -10, opacity: 0, stagger: 0.05, duration: 0.4 }, 0.1)
      .from(palabras.length ? palabras : titular,
        { y: 28, opacity: 0, duration: 0.7, stagger: 0.05 }, 0.12)
      .from('.portada__sub', { y: 12, opacity: 0, duration: 0.5 }, 0.34)
      .from('.portada__cifras > div', { y: 14, opacity: 0, stagger: 0.09, duration: 0.5 }, 0.38)
      .from('.filtro', { y: 12, opacity: 0, stagger: 0.035, duration: 0.4,
        clearProps: 'transform,opacity' }, 0.44)
      // `grid: auto` deja que GSAP deduzca filas y columnas de dónde ha puesto
      // el navegador cada tarjeta, así que los lomos entran en diagonal, como
      // se llena una estantería, y no uno detrás de otro en fila india.
      .from(primeras, {
        y: 30, opacity: 0, scale: 0.96, duration: 0.6,
        stagger: { each: 0.05, grid: 'auto', from: 'start' },
        clearProps: 'transform,opacity',
      }, 0.5);
  }, { remate: 2600 });

  vigilarLaEntrada(tarjetas.filter((n) => !primeras.includes(n)));
}

/** Las que caben en pantalla ahora mismo; el resto esperan a que se baje. */
function aLaVista(tarjetas) {
  const hasta = window.innerHeight + 40;
  return tarjetas.filter((nodo) => nodo.getBoundingClientRect().top < hasta);
}

/** Rejilla estrenada (cambio de filtro desde un estado vacío, por ejemplo). */
function repartirEntrada(tarjetas) {
  if (!tarjetas.length) return;
  const primeras = aLaVista(tarjetas);
  Bib.animar((tl) => tl.from(primeras, {
    y: 26, opacity: 0, scale: 0.97, duration: 0.55,
    stagger: { each: 0.045, grid: 'auto', from: 'start' },
    clearProps: 'transform,opacity',
  }));
  vigilarLaEntrada(tarjetas.filter((n) => !primeras.includes(n)));
}

/** Las que aparecen al afinar un filtro: entran donde las dejó Flip. */
function entrarLasNuevas(tarjetas) {
  if (!tarjetas.length) return;
  const primeras = aLaVista(tarjetas);
  Bib.animar((tl) => tl.from(primeras, {
    y: 16, opacity: 0, scale: 0.94, duration: 0.45,
    stagger: { each: 0.035, grid: 'auto', from: 'start' },
    clearProps: 'transform,opacity',
  }));
  vigilarLaEntrada(tarjetas.filter((n) => !primeras.includes(n)));
}

/* Lo que queda por debajo del borde entra al asomarse. El aviso se pide 160 px
   ANTES de que la tarjeta llegue a verse: así el fotograma en que GSAP la pone
   a cero ocurre fuera de la pantalla y nunca se ve un parpadeo. */
let observador = null;
function vigilarLaEntrada(tarjetas) {
  if (!tarjetas.length || sinAdorno() || typeof IntersectionObserver === 'undefined') return;
  observador = observador || new IntersectionObserver((entradas, obs) => {
    const asoman = entradas.filter((e) => e.isIntersecting).map((e) => e.target);
    if (!asoman.length) return;
    for (const nodo of asoman) obs.unobserve(nodo);
    Bib.animar((tl) => tl.from(asoman, {
      y: 26, opacity: 0, duration: 0.55,
      stagger: { each: 0.05, grid: 'auto', from: 'start' },
      clearProps: 'transform,opacity',
    }));
  }, { rootMargin: '0px 0px 160px 0px', threshold: 0 });
  for (const nodo of tarjetas) observador.observe(nodo);
}

/* ---------------- las tarjetas, bajo el dedo ---------------- */

/* Tres cosas al pasar por encima, y cada una en su capa para que no se estorben:
     la tapa se inclina hacia el puntero   -> GSAP, en .libro__lamina
     un reflejo la cruza                   -> GSAP, en .libro__brillo
     el libro se levanta del papel         -> CSS, en .libro__portada
   Nada de esto existe en una pantalla táctil: ahí no hay «pasar por encima», y
   fingirlo deja la tapa torcida después de tocarla. */
function realzarTarjetas() {
  if (sinAdorno() || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const GRADOS = 6;
  const REPOSO = 1.012;      // el mismo pelo de más que le da el CSS
  let sobre = null;
  let punto = null;
  let marco = 0;

  const lamina = (libro) => libro.querySelector('.libro__lamina');
  const brillo = (libro) => libro.querySelector('.libro__brillo');

  function inclinar() {
    marco = 0;
    if (!sobre || !punto) return;
    const caja = sobre.getBoundingClientRect();
    const x = (punto.x - caja.left) / caja.width - 0.5;
    const y = (punto.y - caja.top) / caja.height - 0.5;
    gsap.to(lamina(sobre), {
      rotateY: x * GRADOS, rotateX: -y * GRADOS, scale: 1.04,
      duration: 0.6, ease: 'power2.out', overwrite: 'auto',
    });
  }

  function reposar(libro) {
    gsap.to(lamina(libro), {
      rotateX: 0, rotateY: 0, scale: REPOSO,
      duration: 0.55, ease: 'power3.out', overwrite: 'auto',
    });
    gsap.to(brillo(libro), { opacity: 0, duration: 0.2, overwrite: 'auto' });
  }

  rejilla.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const libro = e.target.closest('.libro');
    if (!libro || !libro.dataset.id || libro === sobre) return;
    if (sobre) reposar(sobre);
    sobre = libro;
    // El reflejo cruza una vez y se apaga. Repetirlo mientras el puntero siga
    // encima lo convertiría en un parpadeo.
    gsap.killTweensOf(brillo(libro));
    gsap.fromTo(brillo(libro),
      { xPercent: -40, opacity: 0 },
      { xPercent: 40, opacity: 1, duration: 0.75, ease: 'power2.inOut',
        onComplete() { gsap.to(brillo(libro), { opacity: 0, duration: 0.3 }); } });
  });

  rejilla.addEventListener('pointerout', (e) => {
    const libro = e.target.closest('.libro');
    if (!libro || libro !== sobre) return;
    if (libro.contains(e.relatedTarget)) return;   // sigue dentro de la misma tarjeta
    reposar(libro);
    sobre = null;
  });

  rejilla.addEventListener('pointermove', (e) => {
    if (!sobre || (e.pointerType && e.pointerType !== 'mouse')) return;
    punto = { x: e.clientX, y: e.clientY };
    // Un cálculo por fotograma, no uno por evento: el ratón manda muchos más.
    if (!marco) marco = requestAnimationFrame(inclinar);
  }, { passive: true });
}

/* Al pulsar una tarjeta, se hunde un poco: el clic se siente antes de navegar. */
rejilla.addEventListener('pointerdown', (e) => {
  const libro = e.target.closest('.libro');
  if (!libro || !libro.dataset.id || Bib.sinMovimiento()) return;
  gsap.to(libro, { scale: 0.975, duration: 0.12, ease: 'power2.out' });
  // clearProps al soltar: sin eso queda un transform en línea y el hover del
  // CSS ya no puede mover nada.
  const soltar = () => gsap.to(libro, { scale: 1, duration: 0.25, ease: 'power2.out', clearProps: 'transform' });
  libro.addEventListener('pointerup', soltar, { once: true });
  libro.addEventListener('pointerleave', soltar, { once: true });
});

/* Al cambiar el ancho, la tira de filtros reparte de otra manera y la pastilla
   se queda donde estaba. Se recoloca sin animar: no es un cambio de estado, es
   la misma posición medida de nuevo. */
let temporizadorAncho;
addEventListener('resize', () => {
  clearTimeout(temporizadorAncho);
  temporizadorAncho = setTimeout(() => colocarPastilla(false), 150);
});

realzarTarjetas();
esqueletos();
cargar();
