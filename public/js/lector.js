/* Lector paginado: PDF con PDF.js, todo lo demás con columnas CSS. */

import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { TextLayer } from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const hoja = $('hoja');
const flujo = $('flujo');
const lienzo = $('lienzo');
const zonaPdf = $('zona-pdf');
const capaTexto = $('pdf-texto');
const cargando = $('cargando');
const cuenta = $('cuenta');
const deslizador = $('deslizador');
const btnAnterior = $('anterior');
const btnSiguiente = $('siguiente');

const idLibro = new URLSearchParams(location.search).get('id') || '';

let libro = null;
let modo = 'texto';        // texto | pdf
let pagina = 1;
let total = 1;
let pdf = null;
let tareaRender = null;
let tamanoTexto = 18;
const CLAVE_TAMANO = 'bib.tamano';

/* Acercamiento del PDF. Los dos primeros son ajustes vivos —se recalculan con
   la ventana—; el resto son escalas fijas sobre el tamaño real del papel. */
const ZOOM = ['ajustar', 'ancho', 1, 1.25, 1.5, 2, 3];
const CLAVE_ZOOM = 'bib.zoom';
let zoom = 'ajustar';
const rotuloZoom = (z) => (z === 'ajustar' ? 'Ajustar' : z === 'ancho' ? 'Ancho' : `${Math.round(z * 100)} %`);

/* ---------------- carga del libro ---------------- */

function progreso(porcentaje, texto) {
  const parte = Math.max(4, Math.min(100, porcentaje)) / 100;
  $('progreso-barra').style.transform = `scaleX(${parte})`;
  if (texto) $('progreso-texto').textContent = texto;
}

function fallo(mensaje) {
  cargando.innerHTML = `
    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--danger)" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>
    </svg>
    <p style="color:var(--danger);max-width:42ch">${Bib.escapar(mensaje)}</p>
    <a class="btn btn--linea" href="/">Volver al catálogo</a>`;
  cargando.hidden = false;
}

async function descargar(url) {
  const resp = await fetch(url, { credentials: 'same-origin' });
  if (!resp.ok) throw new Error(`No se pudo descargar el archivo (${resp.status}).`);
  const largo = Number(resp.headers.get('content-length') || 0);
  if (!resp.body || !largo) return resp.arrayBuffer();

  const lector = resp.body.getReader();
  const trozos = [];
  let leidos = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    trozos.push(value);
    leidos += value.length;
    progreso((leidos / largo) * 80, `Descargando… ${Math.round((leidos / largo) * 100)}%`);
  }
  const todo = new Uint8Array(leidos);
  let posicion = 0;
  for (const trozo of trozos) { todo.set(trozo, posicion); posicion += trozo.length; }
  return todo.buffer;
}

async function iniciar() {
  if (!idLibro) return fallo('No se indicó qué libro abrir.');
  try {
    const datos = await Bib.api(`/api/libros/${encodeURIComponent(idLibro)}`);
    libro = datos.libro;
  } catch (error) {
    return fallo(error.status === 404 ? 'Ese libro ya no está en la biblioteca.' : error.message);
  }

  document.title = `${libro.titulo} · Biblioteca Logidma`;
  $('titulo-libro').textContent = libro.titulo;
  $('autor-libro').textContent = [libro.autor, libro.anio].filter(Boolean).join(' · ');
  $('btn-descargar').href = `/archivo/${encodeURIComponent(libro.id)}?descargar=1`;

  try { tamanoTexto = Number(localStorage.getItem(CLAVE_TAMANO)) || 18; } catch { /* sin almacenamiento */ }
  flujo.style.setProperty('--tamano', `${tamanoTexto}px`);

  try {
    if (libro.formato === 'pdf') await abrirPdf();
    else await abrirTexto();
  } catch (error) {
    console.error(error);
    return fallo(`No se pudo abrir el libro: ${error.message}`);
  }

  cargando.hidden = true;
  animarEntrada();
  await irAMarcador();
  document.addEventListener('keydown', teclado);
  gestos();
}

/* ---------------- PDF ---------------- */

async function abrirPdf() {
  progreso(20, 'Abriendo el PDF…');
  // PDF.js pide el archivo por trozos: el Worker responde con rangos y la
  // primera página aparece sin haber bajado el libro entero.
  const tarea = pdfjsLib.getDocument({
    url: `/archivo/${encodeURIComponent(libro.id)}`,
    withCredentials: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    disableAutoFetch: true,
    disableStream: false,
  });
  tarea.onProgress = ({ loaded, total: t }) => { if (t) progreso(20 + (loaded / t) * 60); };
  pdf = await tarea.promise;

  modo = 'pdf';
  total = pdf.numPages;
  zonaPdf.hidden = false;
  flujo.hidden = true;

  try {
    const guardado = localStorage.getItem(CLAVE_ZOOM);
    if (guardado && ZOOM.includes(guardado === 'ajustar' || guardado === 'ancho' ? guardado : Number(guardado))) {
      zoom = guardado === 'ajustar' || guardado === 'ancho' ? guardado : Number(guardado);
    }
  } catch { /* sin almacenamiento */ }

  // Aquí A− y A+ dejan de tocar el texto y pasan a acercar la página.
  $('texto-menos').setAttribute('aria-label', 'Alejar la página');
  $('texto-mas').setAttribute('aria-label', 'Acercar la página');
  $('nivel-zoom').hidden = false;
  pintarNivelZoom();
  if (!libro.paginas) guardarPaginas(total);
  actualizarControles();
  await pintarPdf();
  addEventListener('resize', reajustar);
}

/** Cuánto hay que agrandar el papel para lo que pide el nivel de acercamiento. */
function escalaPara(base) {
  const margen = 2 * 16 + 4;                       // el relleno de la zona
  const anchoLibre = Math.max(120, zonaPdf.clientWidth - margen);
  const altoLibre = Math.max(120, zonaPdf.clientHeight - margen);
  if (zoom === 'ancho') return anchoLibre / base.width;
  if (zoom === 'ajustar') return Math.min(anchoLibre / base.width, altoLibre / base.height);
  return zoom;
}

async function pintarPdf() {
  if (tareaRender) { try { tareaRender.cancel(); } catch { /* ya terminó */ } }
  const hojaPdf = await pdf.getPage(pagina);

  const base = hojaPdf.getViewport({ scale: 1 });
  const escala = escalaPara(base);
  // El lienzo se dibuja al doble de puntos en pantallas finas y luego se
  // encoge por CSS: así el texto escaneado no sale con los bordes deshechos.
  const nitidez = Math.min(window.devicePixelRatio || 1, 2);
  const vista = hojaPdf.getViewport({ scale: escala * nitidez });
  const vistaCss = hojaPdf.getViewport({ scale: escala });

  lienzo.width = Math.floor(vista.width);
  lienzo.height = Math.floor(vista.height);
  lienzo.style.width = `${Math.floor(vistaCss.width)}px`;
  lienzo.style.height = `${Math.floor(vistaCss.height)}px`;
  pintarCapaTexto(hojaPdf, vistaCss);

  // Un fundido corto disimula el instante en que el lienzo se repinta.
  Bib.animar((tl) => tl.fromTo(lienzo, { opacity: 0.4 }, { opacity: 1, duration: 0.35 }), { remate: 600 });

  const tarea = hojaPdf.render({ canvasContext: lienzo.getContext('2d'), viewport: vista });
  tareaRender = tarea;
  tarea.promise.then(
    () => { if (tareaRender === tarea) tareaRender = null; },
    (error) => {
      if (tareaRender === tarea) tareaRender = null;
      if (error?.name !== 'RenderingCancelledException') console.error(error);
    },
  );

  // PDF.js programa la continuación del dibujo con requestAnimationFrame, y
  // Chrome lo congela en las pestañas de segundo plano: esperar la promesa
  // dejaría el aviso de «Abriendo el PDF…» pegado hasta que alguien mire la
  // pestaña. La página ya se ve mientras tanto.
  await Promise.race([
    tarea.promise.catch(() => {}),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
}

/* Letras invisibles encima del dibujo: dejan seleccionar, copiar y buscar con
   Ctrl+F. En un libro escaneado no hay texto que colocar y la capa queda vacía,
   sin estorbar. */
let capaEnCurso = 0;
async function pintarCapaTexto(hojaPdf, vista) {
  const turno = ++capaEnCurso;
  capaTexto.replaceChildren();
  capaTexto.style.width = `${Math.floor(vista.width)}px`;
  capaTexto.style.height = `${Math.floor(vista.height)}px`;
  capaTexto.style.setProperty('--scale-factor', String(vista.scale));
  capaTexto.style.setProperty('--total-scale-factor', String(vista.scale));
  try {
    const capa = new TextLayer({
      textContentSource: hojaPdf.streamTextContent({ includeMarkedContent: true }),
      container: capaTexto,
      viewport: vista,
    });
    await capa.render();
    if (turno !== capaEnCurso) capaTexto.replaceChildren();   // llegó tarde: manda la página nueva
  } catch { /* sin texto que colocar: es un escaneo */ }
}

/* Detalle de PDF.js: mientras se arrastra la selección, el ancla del final
   sube para que se pueda seleccionar hasta el borde de la página. */
capaTexto.addEventListener('pointerdown', () => {
  capaTexto.classList.add('seleccionando');
  addEventListener('pointerup', () => capaTexto.classList.remove('seleccionando'), { once: true });
});

function pintarNivelZoom() {
  const boton = $('nivel-zoom');
  boton.textContent = rotuloZoom(zoom);
  boton.setAttribute('aria-label', `Acercamiento ${rotuloZoom(zoom)}; volver a ajustar a la pantalla`);
  $('texto-menos').disabled = ZOOM.indexOf(zoom) <= 0;
  $('texto-mas').disabled = ZOOM.indexOf(zoom) >= ZOOM.length - 1;
}

async function cambiarZoom(valor) {
  if (modo !== 'pdf' || valor === zoom) return;
  zoom = valor;
  try { localStorage.setItem(CLAVE_ZOOM, String(zoom)); } catch { /* sin almacenamiento */ }
  pintarNivelZoom();
  await pintarPdf();
  zonaPdf.scrollTop = 0;
}

/* ---------------- texto paginado ---------------- */

async function abrirTexto() {
  progreso(10, 'Descargando el documento…');
  const buffer = await descargar(`/archivo/${encodeURIComponent(libro.id)}`);
  progreso(85, 'Dando formato al texto…');
  const html = await Formatos.aHtml(libro.formato, buffer);

  modo = 'texto';
  flujo.hidden = false;
  zonaPdf.hidden = true;
  flujo.innerHTML = html;
  progreso(95, 'Repartiendo en páginas…');

  // Las imágenes cambian la altura del texto: hay que medir después de cargarlas.
  await Promise.all([...flujo.querySelectorAll('img')].map((img) =>
    img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));

  medir();
  addEventListener('resize', reajustar);
}

function medir() {
  flujo.style.paddingBottom = '';               // sin esto el ajuste de abajo se acumula
  const estilo = getComputedStyle(flujo);
  const padIzq = parseFloat(estilo.paddingLeft);
  const padDer = parseFloat(estilo.paddingRight);
  const gap = parseFloat(estilo.columnGap) || 64;
  const anchoColumna = Math.max(200, flujo.clientWidth - padIzq - padDer);

  // La altura debe caber un número entero de renglones: si sobra medio,
  // la última línea de cada página aparece cortada por la mitad.
  const alto = parseFloat(estilo.lineHeight);
  const padArriba = parseFloat(estilo.paddingTop);
  const padAbajo = parseFloat(estilo.paddingBottom);
  const util = flujo.clientHeight - padArriba - padAbajo;
  if (alto > 0 && util > alto) {
    flujo.style.paddingBottom = `${padAbajo + (util % alto)}px`;
  }

  flujo.style.columnWidth = `${anchoColumna}px`;
  flujo.scrollLeft = 0;

  const anchoContenido = flujo.scrollWidth - padIzq - padDer;
  total = Math.max(1, Math.round((anchoContenido + gap) / (anchoColumna + gap)));
  flujo.dataset.ancho = String(anchoColumna + gap);

  if (pagina > total) pagina = total;
  colocar(false);
  actualizarControles();
  // El reparto del texto depende de la pantalla: guardar ese número en el
  // catálogo lo haría bailar según quién abra el libro. Solo el PDF tiene
  // páginas de verdad.
}

let pasoEnCurso = null;

function colocar(animar = true) {
  if (modo !== 'texto') return;
  const destino = (pagina - 1) * Number(flujo.dataset.ancho || 0);
  if (pasoEnCurso) { pasoEnCurso.kill(); pasoEnCurso = null; }
  if (animar) {
    // Tope corto: una página a medio pasar deja el texto partido en dos.
    pasoEnCurso = Bib.animar(
      (tl) => tl.to(flujo, { scrollLeft: destino, duration: 0.45, ease: 'power2.inOut' }),
      { remate: 700 },
    );
    if (pasoEnCurso) return;
  }
  flujo.scrollLeft = destino;   // sin movimiento: se coloca de golpe
}

/* ---------------- navegación ---------------- */

function actualizarControles() {
  pintarCuenta(pagina);
  deslizador.max = String(total);
  deslizador.value = String(pagina);
  btnAnterior.disabled = pagina <= 1;
  btnSiguiente.disabled = pagina >= total;
  $('anterior-movil').disabled = pagina <= 1;
  $('siguiente-movil').disabled = pagina >= total;
}

async function ir(destino) {
  const nueva = Math.max(1, Math.min(total, Math.round(destino)));
  if (nueva === pagina) return;
  pagina = nueva;
  actualizarControles();
  if (modo === 'pdf') { zonaPdf.scrollTop = 0; await pintarPdf(); }
  else colocar(true);
  apuntarMarcador();
}

/** El porcentaje dice de un vistazo cuánto queda; el número solo, no. */
function pintarCuenta(n) {
  const avance = total > 1 ? Math.round(((n - 1) / (total - 1)) * 100) : 100;
  cuenta.innerHTML = `<b>${n}</b> / ${total}<small>${avance} %</small>`;
  $('anuncio').textContent = `Página ${n} de ${total}`;
}

/* Pulsar el contador abre un hueco para escribir la página: en un libro de
   cuatrocientas hojas, arrastrar el deslizador hasta la 287 es una tortura. */
const campoIr = $('ir-pagina');
function abrirSalto() {
  campoIr.max = String(total);
  campoIr.value = String(pagina);
  campoIr.hidden = false;
  cuenta.hidden = true;
  campoIr.focus();
  campoIr.select();
}
function cerrarSalto(destino) {
  campoIr.hidden = true;
  cuenta.hidden = false;
  if (destino) ir(destino);
}
cuenta.addEventListener('click', abrirSalto);
campoIr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); cerrarSalto(Number(campoIr.value)); }
  if (e.key === 'Escape') { e.preventDefault(); cerrarSalto(0); }
});
campoIr.addEventListener('blur', () => cerrarSalto(0));

const teclas = {
  ArrowRight: 1, PageDown: 1, ' ': 1, ArrowDown: 1,
  ArrowLeft: -1, PageUp: -1, ArrowUp: -1,
};
const VERTICALES = new Set(['ArrowUp', 'ArrowDown', ' ']);

function teclado(e) {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Home') { e.preventDefault(); return void ir(1); }
  if (e.key === 'End') { e.preventDefault(); return void ir(total); }

  // Con la página acercada, arriba y abajo recorren el papel; solo cuando ya no
  // queda nada que recorrer pasan a cambiar de hoja. Izquierda y derecha
  // siempre cambian de hoja.
  if (modo === 'pdf' && VERTICALES.has(e.key)) {
    const sobra = zonaPdf.scrollHeight - zonaPdf.clientHeight;
    const abajo = e.key !== 'ArrowUp';
    const tope = abajo ? sobra - zonaPdf.scrollTop > 2 : zonaPdf.scrollTop > 2;
    if (sobra > 4 && tope) {
      e.preventDefault();
      zonaPdf.scrollBy({ top: (abajo ? 1 : -1) * zonaPdf.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
  }

  const salto = teclas[e.key];
  if (!salto) return;
  e.preventDefault();
  ir(pagina + salto);
}

function gestos() {
  let inicioX = 0, inicioY = 0, tocando = false;
  hoja.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    tocando = true; inicioX = e.touches[0].clientX; inicioY = e.touches[0].clientY;
  }, { passive: true });
  hoja.addEventListener('touchend', (e) => {
    if (!tocando) return;
    tocando = false;
    const dx = e.changedTouches[0].clientX - inicioX;
    const dy = e.changedTouches[0].clientY - inicioY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) ir(pagina + (dx < 0 ? 1 : -1));
  }, { passive: true });
}

btnAnterior.addEventListener('click', () => ir(pagina - 1));
btnSiguiente.addEventListener('click', () => ir(pagina + 1));
$('anterior-movil').addEventListener('click', () => ir(pagina - 1));
$('siguiente-movil').addEventListener('click', () => ir(pagina + 1));
deslizador.addEventListener('input', () => pintarCuenta(Number(deslizador.value)));
deslizador.addEventListener('change', () => ir(Number(deslizador.value)));

/* ---------------- tamaño del texto ---------------- */

function cambiarTamano(delta) {
  if (modo !== 'texto') return;
  tamanoTexto = Math.max(13, Math.min(28, tamanoTexto + delta));
  try { localStorage.setItem(CLAVE_TAMANO, String(tamanoTexto)); } catch { /* sin almacenamiento */ }
  const proporcion = total > 1 ? (pagina - 1) / (total - 1) : 0;
  flujo.style.setProperty('--tamano', `${tamanoTexto}px`);
  requestAnimationFrame(() => {
    medir();
    pagina = Math.max(1, Math.round(proporcion * (total - 1)) + 1);
    colocar(false);
    actualizarControles();
  });
}
/* Un solo par de botones para las dos formas de leer: agrandan la letra cuando
   el texto refluye y acercan el papel cuando es un PDF. */
function ajustar(delta) {
  if (modo !== 'pdf') return cambiarTamano(delta);
  const siguiente = ZOOM[Math.max(0, Math.min(ZOOM.length - 1, ZOOM.indexOf(zoom) + delta))];
  cambiarZoom(siguiente);
}
$('texto-mas').addEventListener('click', () => ajustar(1));
$('texto-menos').addEventListener('click', () => ajustar(-1));
$('nivel-zoom').addEventListener('click', () => cambiarZoom('ajustar'));

/* Al cambiar el tamaño de la ventana cambia el reparto: se conserva
   la posición relativa, no el número de página. */
let temporizadorAjuste;
function reajustar() {
  clearTimeout(temporizadorAjuste);
  temporizadorAjuste = setTimeout(async () => {
    if (modo === 'pdf') return void pintarPdf();
    const proporcion = total > 1 ? (pagina - 1) / (total - 1) : 0;
    medir();
    pagina = Math.max(1, Math.round(proporcion * (total - 1)) + 1);
    colocar(false);
    actualizarControles();
  }, 180);
}

/* ---------------- movimiento ---------------- */

/** El libro se abre: barra, hoja y controles entran juntos. */
function animarEntrada() {
  Bib.animar((tl) => {
    tl.from('.lector__barra > *', { y: -10, opacity: 0, stagger: 0.05, duration: 0.4 }, 0)
      .from('.hoja', { y: 18, opacity: 0, scale: 0.985, duration: 0.55 }, 0.05)
      .from('.lector__pie > *', { y: 10, opacity: 0, stagger: 0.05, duration: 0.4 }, 0.15)
      .from('.paso', { opacity: 0, x: (i) => (i ? 10 : -10), stagger: 0.06, duration: 0.4, clearProps: 'transform,opacity' }, 0.25);
  });
}

/* ---------------- marcador y páginas ---------------- */

let temporizadorMarcador;
function apuntarMarcador() {
  try { localStorage.setItem(`bib.pagina.${idLibro}`, String(pagina)); } catch { /* sin almacenamiento */ }
  clearTimeout(temporizadorMarcador);
  temporizadorMarcador = setTimeout(() => {
    Bib.api(`/api/marcador/${encodeURIComponent(idLibro)}`, {
      method: 'PUT', body: JSON.stringify({ pagina }),
    }).catch(() => { /* el marcador local ya quedó guardado */ });
  }, 1200);
}

async function irAMarcador() {
  let guardada = 0;
  try { guardada = Number(localStorage.getItem(`bib.pagina.${idLibro}`)) || 0; } catch { /* sin almacenamiento */ }
  if (!guardada) {
    try { guardada = (await Bib.api(`/api/marcador/${encodeURIComponent(idLibro)}`)).pagina; } catch { /* sin marcador */ }
  }
  if (guardada > 1 && guardada <= total) {
    await ir(guardada);
    Bib.brindis(`Retomamos en la página ${guardada}`);
  }
}

/** Solo para PDF: son páginas reales del archivo, iguales para todos. */
function guardarPaginas(n) {
  // Solo un administrador puede escribirlo; para el resto falla en silencio.
  Bib.api(`/api/libros/${encodeURIComponent(idLibro)}`, {
    method: 'PATCH', body: JSON.stringify({ paginas: n }),
  }).catch(() => {});
}

iniciar();
