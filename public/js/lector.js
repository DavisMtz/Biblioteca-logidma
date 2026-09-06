/* Lector paginado: PDF con PDF.js, todo lo demás con columnas CSS. */

import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const hoja = $('hoja');
const flujo = $('flujo');
const lienzo = $('lienzo');
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

/* ---------------- carga del libro ---------------- */

function progreso(porcentaje, texto) {
  $('progreso-barra').style.width = `${Math.max(4, Math.min(100, porcentaje))}%`;
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
  lienzo.hidden = false;
  flujo.hidden = true;
  // El tamaño del texto solo aplica al texto refluido; en un PDF manda el archivo.
  $('texto-mas').disabled = true;
  $('texto-menos').disabled = true;
  if (!libro.paginas) guardarPaginas(total);
  actualizarControles();
  await pintarPdf();
  addEventListener('resize', reajustar);
}

async function pintarPdf() {
  if (tareaRender) { try { tareaRender.cancel(); } catch { /* ya terminó */ } }
  const hojaPdf = await pdf.getPage(pagina);

  const disponibleAncho = hoja.clientWidth - 32;
  const disponibleAlto = hoja.clientHeight - 32;
  const base = hojaPdf.getViewport({ scale: 1 });
  const escala = Math.min(disponibleAncho / base.width, disponibleAlto / base.height);
  const nitidez = Math.min(window.devicePixelRatio || 1, 2);
  const vista = hojaPdf.getViewport({ scale: escala * nitidez });

  lienzo.width = Math.floor(vista.width);
  lienzo.height = Math.floor(vista.height);
  lienzo.style.width = `${Math.floor(vista.width / nitidez)}px`;
  lienzo.style.height = `${Math.floor(vista.height / nitidez)}px`;

  tareaRender = hojaPdf.render({ canvasContext: lienzo.getContext('2d'), viewport: vista });
  try { await tareaRender.promise; } catch (error) {
    if (error?.name !== 'RenderingCancelledException') throw error;
  }
  tareaRender = null;
}

/* ---------------- texto paginado ---------------- */

async function abrirTexto() {
  progreso(10, 'Descargando el documento…');
  const buffer = await descargar(`/archivo/${encodeURIComponent(libro.id)}`);
  progreso(85, 'Dando formato al texto…');
  const html = await Formatos.aHtml(libro.formato, buffer);

  modo = 'texto';
  flujo.hidden = false;
  lienzo.hidden = true;
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
  flujo.dataset.animar = '0';
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

function colocar(animar = true) {
  if (modo !== 'texto') return;
  flujo.dataset.animar = animar ? '1' : '0';
  const paso = Number(flujo.dataset.ancho || 0);
  flujo.scrollLeft = (pagina - 1) * paso;
}

/* ---------------- navegación ---------------- */

function actualizarControles() {
  cuenta.textContent = `${pagina} / ${total}`;
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
  if (modo === 'pdf') await pintarPdf();
  else colocar(true);
  apuntarMarcador();
}

const teclas = {
  ArrowRight: 1, PageDown: 1, ' ': 1, ArrowDown: 1,
  ArrowLeft: -1, PageUp: -1, ArrowUp: -1,
};
function teclado(e) {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Home') { e.preventDefault(); return void ir(1); }
  if (e.key === 'End') { e.preventDefault(); return void ir(total); }
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
deslizador.addEventListener('input', () => {
  cuenta.textContent = `${deslizador.value} / ${total}`;
});
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
$('texto-mas').addEventListener('click', () => cambiarTamano(1));
$('texto-menos').addEventListener('click', () => cambiarTamano(-1));

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
