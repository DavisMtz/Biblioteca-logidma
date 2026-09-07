/* Lector paginado: PDF con PDF.js, todo lo demás con columnas CSS. */

import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { TextLayer } from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const hoja = $('hoja');
const flujo = $('flujo');
const lienzo = $('lienzo');
const zonaPdf = $('zona-pdf');
const paginaPdf = $('pdf-pagina');
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

/* Acercamiento del PDF. `zoom` vale 'ajustar' o 'ancho' —ajustes vivos, que se
   recalculan solos con la pantalla— o un número, la escala sobre el tamaño real
   del papel. El pellizco produce números cualesquiera, así que nada de aquí
   abajo puede dar por hecho que la escala salga de una lista. */
const ESCALAS = [1, 1.25, 1.5, 2, 3, 4];
const ZOOM_MAX = 4;
const CLAVE_ZOOM = 'bib.zoom';
let zoom = 'ajustar';
let escalaVigente = 1;      // con la que está dibujada la página ahora mismo
let escalaAjuste = 1;       // la que hace caber la página entera
let escalaAncho = 1;        // la que llena el ancho
let paginaPintada = 0;
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
  document.body.classList.add('es-pdf');

  // Solo se heredan los ajustes vivos. Un porcentaje fijo guardado de otro libro
  // —o de otra pantalla— abre el siguiente cortado: un 300 % en un teléfono deja
  // ver una esquina, y eso no parece un acercamiento, parece un fallo.
  try {
    const guardado = localStorage.getItem(CLAVE_ZOOM);
    if (guardado === 'ajustar' || guardado === 'ancho') zoom = guardado;
  } catch { /* sin almacenamiento */ }

  // Aquí A− y A+ dejan de tocar el texto y pasan a acercar la página.
  $('texto-menos').setAttribute('aria-label', 'Alejar la página');
  $('texto-mas').setAttribute('aria-label', 'Acercar la página');
  $('nivel-zoom').hidden = false;
  if (!libro.paginas) guardarPaginas(total);
  actualizarControles();
  await pintarPdf();
  pintarNivelZoom();
  vigilarHueco();

  // Con la pestaña de fondo, Chrome congela los fotogramas y el dibujo de
  // PDF.js no llega a terminar; se acaba cancelando por el tope. Al volver a
  // mirar la pantalla se rehace, para no encontrarse una hoja en blanco.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && modo === 'pdf') pintarPdf();
  });
}

/** El hueco de verdad, sin su relleno, que en el teléfono no es el del escritorio. */
function espacioLibre() {
  const est = getComputedStyle(zonaPdf);
  return {
    ancho: Math.max(120, zonaPdf.clientWidth - parseFloat(est.paddingLeft) - parseFloat(est.paddingRight)),
    alto: Math.max(120, zonaPdf.clientHeight - parseFloat(est.paddingTop) - parseFloat(est.paddingBottom)),
  };
}

/** Cuánto hay que agrandar el papel para lo que pide el nivel de acercamiento. */
function escalaPara(base) {
  const libre = espacioLibre();
  cajaPintada = libre;
  escalaAncho = libre.ancho / base.width;
  escalaAjuste = Math.min(escalaAncho, libre.alto / base.height);
  if (zoom === 'ancho') return escalaAncho;
  if (zoom === 'ajustar') return escalaAjuste;
  return Math.max(escalaAjuste, Math.min(ZOOM_MAX, zoom));
}

/* La barra de direcciones del teléfono aparece y desaparece sin disparar
   `resize`: para saber de verdad cuánto hueco queda, hay que mirar la caja. */
let cajaPintada = { ancho: 0, alto: 0 };
let temporizadorCaja;
function vigilarHueco() {
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => {
    if (modo !== 'pdf' || typeof zoom === 'number') return;   // una escala fija no depende del hueco
    const libre = espacioLibre();
    // Sin este margen se entra en bucle: al redibujar aparece la barra de
    // desplazamiento, que encoge la caja, que dispara otro redibujo, que la
    // quita, que vuelve a disparar…
    if (Math.abs(libre.ancho - cajaPintada.ancho) < 16 && Math.abs(libre.alto - cajaPintada.alto) < 16) return;
    clearTimeout(temporizadorCaja);
    temporizadorCaja = setTimeout(() => pintarPdf(), 150);
  }).observe(zonaPdf);
}

/** Copia encogida de lo dibujado, para tapar el hueco mientras se redibuja. */
function capturar() {
  try {
    const k = Math.min(1, 1600 / lienzo.width);
    const copia = document.createElement('canvas');
    copia.width = Math.max(1, Math.round(lienzo.width * k));
    copia.height = Math.max(1, Math.round(lienzo.height * k));
    copia.getContext('2d').drawImage(lienzo, 0, 0, copia.width, copia.height);
    return copia;
  } catch { return null; }
}

/* Tras un pellizco, un doble toque o un escalón de acercamiento, el punto del
   papel que estaba bajo el dedo tiene que seguir estando ahí. */
let focoPendiente = null;
function recolocarFoco() {
  if (!focoPendiente) return;
  const { papelX, papelY, pantallaX, pantallaY } = focoPendiente;
  focoPendiente = null;
  const caja = zonaPdf.getBoundingClientRect();
  zonaPdf.scrollLeft = paginaPdf.offsetLeft + papelX * escalaVigente - (pantallaX - caja.left);
  zonaPdf.scrollTop = paginaPdf.offsetTop + papelY * escalaVigente - (pantallaY - caja.top);
}

/** Deja quieto lo que se ve en el centro al cambiar de escalón. */
function fijarFocoEnElCentro() {
  const caja = zonaPdf.getBoundingClientRect();
  const cajaPagina = paginaPdf.getBoundingClientRect();
  const pantallaX = caja.left + caja.width / 2;
  const pantallaY = caja.top + caja.height / 2;
  focoPendiente = {
    papelX: (pantallaX - cajaPagina.left) / escalaVigente,
    papelY: (pantallaY - cajaPagina.top) / escalaVigente,
    pantallaX, pantallaY,
  };
}

/* Cambiar el tamaño de un lienzo borra el estado del contexto, incluido el giro
   que PDF.js usa para poner el papel del derecho; y dos dibujos a la vez sobre
   el mismo lienzo terminan en «Cannot use the same canvas» y una página en
   blanco. Los dibujos van en cola, de uno en uno, y el que llega tarde se
   descarta por el número de turno.

   La cancelación se pide FUERA de la cola a propósito: en una pestaña de fondo
   Chrome congela los fotogramas y la promesa del dibujo no termina nunca, así
   que si esperásemos nuestro turno para cancelarlo, la cola se quedaría
   atascada para siempre. */
let turnoPintado = 0;
let colaPintado = Promise.resolve();

function pintarPdf() {
  const turno = ++turnoPintado;
  if (tareaRender) { try { tareaRender.cancel(); } catch { /* ya había terminado */ } }
  const trabajo = colaPintado.then(() => dibujarPagina(turno)).catch(() => {});
  colaPintado = trabajo;
  // Quien llama no se queda colgado: la página ya se ve mientras se termina.
  return Promise.race([trabajo, new Promise((r) => setTimeout(r, 2500))]);
}

async function dibujarPagina(turno) {
  if (turno !== turnoPintado) return;          // llegó otra petición mientras tanto

  const hojaPdf = await pdf.getPage(pagina);
  if (turno !== turnoPintado) return;

  const base = hojaPdf.getViewport({ scale: 1 });
  const escala = escalaPara(base);
  // El lienzo se dibuja con más puntos de los que ocupa y luego se encoge por
  // CSS: así el texto escaneado no sale con los bordes deshechos. El tope de
  // píxeles evita que una página grande al 300 % reviente el lienzo.
  const TOPE = 12e6;
  // Los teléfonos buenos tienen tres puntos de pantalla por píxel de CSS:
  // quedarse en dos es justo la falta de nitidez que se nota al acercar.
  const pedida = Math.min(window.devicePixelRatio || 1, 3);
  const cabe = Math.sqrt(TOPE / Math.max(1, base.width * escala * base.height * escala));
  const nitidez = Math.max(1, Math.min(pedida, cabe));
  const vista = hojaPdf.getViewport({ scale: escala * nitidez });

  // El lienzo mide exactamente `nitidez` veces lo que ocupa. Si la proporción no
  // sale redonda, el navegador reescala el dibujo y lo emborrona justo cuando
  // más se le está mirando.
  const anchoPuntos = Math.floor(vista.width);
  const altoPuntos = Math.floor(vista.height);
  const anchoCss = anchoPuntos / nitidez;
  const altoCss = altoPuntos / nitidez;

  // Lo que ya estaba dibujado se queda estirado mientras llega la versión
  // nítida: en un teléfono el dibujo nuevo tarda, y un rectángulo en blanco
  // asusta bastante más que una imagen borrosa un instante.
  const relevo = (paginaPintada === pagina && lienzo.width) ? capturar() : null;

  escalaVigente = escala;
  lienzo.width = anchoPuntos;
  lienzo.height = altoPuntos;
  lienzo.style.width = `${anchoCss}px`;
  lienzo.style.height = `${altoCss}px`;
  paginaPdf.style.transform = '';
  paginaPdf.classList.remove('pdf__pagina--pellizco');
  if (relevo) lienzo.getContext('2d').drawImage(relevo, 0, 0, anchoPuntos, altoPuntos);
  paginaPintada = pagina;
  recolocarFoco();
  // El rótulo se actualiza aquí y no al final: abajo se espera al dibujo, y el
  // botón no puede pasarse dos segundos diciendo un nivel que ya no es.
  pintarNivelZoom();
  pintarCapaTexto(hojaPdf, hojaPdf.getViewport({ scale: escala }), anchoCss, altoCss);

  // Un fundido corto disimula el instante en que el lienzo se repinta.
  Bib.animar((tl) => tl.fromTo(lienzo, { opacity: 0.4 }, { opacity: 1, duration: 0.35 }), { remate: 600 });

  const tarea = hojaPdf.render({ canvasContext: lienzo.getContext('2d'), viewport: vista });
  tareaRender = tarea;

  // La cola espera de verdad: hasta que este dibujo suelte el lienzo, el
  // siguiente no puede empezar.
  let vivo = true;
  const fin = tarea.promise.then(
    () => { vivo = false; },
    (error) => {
      vivo = false;
      if (error?.name !== 'RenderingCancelledException') console.error(error);
    },
  );

  if (document.hidden) {
    // Con la pestaña de fondo los fotogramas están congelados y esto no
    // terminaría nunca: se le da un margen y se cancela, para que la cola siga.
    // Al volver a mirar la pantalla se rehace el dibujo.
    await Promise.race([fin, new Promise((r) => setTimeout(r, 8000))]);
    if (vivo) { try { tarea.cancel(); } catch { /* justo terminó */ } }
  }
  // A la vista se espera lo que haga falta: un escaneo grande en un teléfono
  // lento tarda, y cortarlo por reloj dejaría la hoja en blanco sin motivo. Si
  // la pestaña se va de fondo a mitad, la desatasca la siguiente petición, que
  // cancela esta desde fuera de la cola.
  await fin;
  if (tareaRender === tarea) tareaRender = null;
}

/* Letras invisibles encima del dibujo: dejan seleccionar, copiar y buscar con
   Ctrl+F. En un libro escaneado no hay texto que colocar y la capa queda vacía,
   sin estorbar. */
let capaEnCurso = 0;
async function pintarCapaTexto(hojaPdf, vista, anchoCss, altoCss) {
  const turno = ++capaEnCurso;
  capaTexto.replaceChildren();
  capaTexto.style.width = `${anchoCss}px`;
  capaTexto.style.height = `${altoCss}px`;
  capaTexto.style.setProperty('--scale-factor', String(vista.scale));
  capaTexto.style.setProperty('--total-scale-factor', String(vista.scale));
  try {
    const capa = new TextLayer({
      textContentSource: hojaPdf.streamTextContent({ includeMarkedContent: true }),
      container: capaTexto,
      viewport: vista,
    });
    await capa.render();
    // `render` reescribe el tamaño de la capa con el del papel sin girar; se
    // repone el bueno para que la selección cubra la página y no un rectángulo
    // tumbado.
    capaTexto.style.width = `${anchoCss}px`;
    capaTexto.style.height = `${altoCss}px`;
    if (turno !== capaEnCurso) capaTexto.replaceChildren();   // llegó tarde: manda la página nueva
  } catch { /* sin texto que colocar: es un escaneo */ }
}

/* Detalle de PDF.js: mientras se arrastra la selección, el ancla del final
   sube para que se pueda seleccionar hasta el borde de la página. */
capaTexto.addEventListener('pointerdown', () => {
  capaTexto.classList.add('seleccionando');
  addEventListener('pointerup', () => capaTexto.classList.remove('seleccionando'), { once: true });
});

/* Los escalones que tienen sentido en ESTA página: los dos ajustes vivos más
   las escalas fijas que quedan por encima, quitando las que caen casi encima de
   otra —en una página apaisada, «ancho» y «ajustar» son casi lo mismo—. */
function escalones() {
  const lista = [
    { valor: escalaAjuste, modo: 'ajustar' },
    { valor: escalaAncho, modo: 'ancho' },
    ...ESCALAS.map((v) => ({ valor: v, modo: v })),
  ].filter((e) => e.valor >= escalaAjuste - 1e-6 && e.valor <= ZOOM_MAX + 1e-6)
    .sort((a, b) => a.valor - b.valor);
  return lista.filter((e, i) => i === 0 || e.valor / lista[i - 1].valor > 1.04);
}

function pintarNivelZoom() {
  const boton = $('nivel-zoom');
  const rotulo = rotuloZoom(typeof zoom === 'number' ? escalaVigente : zoom);
  boton.textContent = rotulo;
  boton.setAttribute('aria-label', `Acercamiento ${rotulo}; volver a ajustar a la pantalla`);
  const pasos = escalones();
  $('texto-menos').disabled = escalaVigente <= pasos[0].valor * 1.02;
  $('texto-mas').disabled = escalaVigente >= pasos[pasos.length - 1].valor * 0.98;
}

/**
 * @param {'ajustar'|'ancho'|number} valor
 * @param {boolean} conservar  deja el punto de `focoPendiente` donde estaba;
 *   si no, la página nueva se mira desde arriba.
 */
async function cambiarZoom(valor, conservar = false) {
  if (modo !== 'pdf') return;
  zoom = valor;
  // Solo se guardan los ajustes vivos: un porcentaje fijo no viaja bien de un
  // libro a otro ni de una pantalla a otra.
  try {
    if (typeof valor === 'string') localStorage.setItem(CLAVE_ZOOM, valor);
  } catch { /* sin almacenamiento */ }
  if (!conservar) { focoPendiente = null; zonaPdf.scrollTop = 0; zonaPdf.scrollLeft = 0; }
  await pintarPdf();
  pintarNivelZoom();
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
      // `behavior: 'smooth'` no llega a moverse en recorridos cortos: el
      // desplazamiento se lleva a mano, con la misma red de seguridad que el
      // resto del movimiento del sitio.
      const salto = (abajo ? 1 : -1) * zonaPdf.clientHeight * 0.85;
      const destino = Math.max(0, Math.min(sobra, zonaPdf.scrollTop + salto));
      const suave = Bib.animar(
        (tl) => tl.to(zonaPdf, { scrollTop: destino, duration: 0.3, ease: 'power2.out' }),
        { remate: 500 },
      );
      if (!suave) zonaPdf.scrollTop = destino;
      return;
    }
  }

  const salto = teclas[e.key];
  if (!salto) return;
  e.preventDefault();
  ir(pagina + salto);
}

/* ---------------- gestos ----------------

   Tres gestos, y ninguno debe pisar a los otros:
     un dedo de lado  -> cambiar de página
     dos dedos        -> acercar y alejar
     doble toque      -> alternar entre la página entera y el doble

   Para que el pellizco sea nuestro y no del navegador hacen falta las tres
   cosas a la vez: `touch-action: pan-x pan-y` en el CSS, `preventDefault` en el
   `touchmove` de dos dedos —con el oyente NO pasivo, o el navegador lo ignora—
   y `gesturestart` para Safari, que además de los toques dispara los suyos. */

const distanciaEntre = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const puntoMedio = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

let pellizco = null;

/** El punto del papel que hay bajo unas coordenadas de la pantalla. */
function papelBajo(pantallaX, pantallaY) {
  const caja = paginaPdf.getBoundingClientRect();
  return {
    papelX: (pantallaX - caja.left) / escalaVigente,
    papelY: (pantallaY - caja.top) / escalaVigente,
    pantallaX, pantallaY,
  };
}

function empezarPellizco(e) {
  const [a, b] = [e.touches[0], e.touches[1]];
  const medio = puntoMedio(a, b);
  const caja = paginaPdf.getBoundingClientRect();
  pellizco = {
    separacion: Math.max(1, distanciaEntre(a, b)),
    // el origen del estiramiento, en coordenadas de la página sin escalar
    origenX: medio.x - caja.left,
    origenY: medio.y - caja.top,
    foco: papelBajo(medio.x, medio.y),
    factor: 1,
  };
  paginaPdf.classList.add('pdf__pagina--pellizco');
}

function seguirPellizco(e) {
  const [a, b] = [e.touches[0], e.touches[1]];
  const medio = puntoMedio(a, b);
  const bruto = distanciaEntre(a, b) / pellizco.separacion;
  // Los topes se aplican ya durante el gesto: así se nota que la página no da
  // más de sí, en vez de estirarse y saltar hacia atrás al soltar.
  const minimo = escalaAjuste / escalaVigente;
  const maximo = ZOOM_MAX / escalaVigente;
  pellizco.factor = Math.max(minimo, Math.min(maximo, bruto));
  pellizco.foco = { ...pellizco.foco, pantallaX: medio.x, pantallaY: medio.y };

  const { origenX: mx, origenY: my, factor: k } = pellizco;
  // Con el origen en la esquina, hay que devolver a su sitio el punto de los
  // dedos: escalar lo aleja de la esquina, y el desplazamiento lo compensa.
  paginaPdf.style.transform = `translate(${mx * (1 - k)}px, ${my * (1 - k)}px) scale(${k})`;
}

function soltarPellizco() {
  const { factor, foco } = pellizco;
  pellizco = null;
  if (Math.abs(factor - 1) < 0.01) {           // apenas se movió: no se toca nada
    paginaPdf.style.transform = '';
    paginaPdf.classList.remove('pdf__pagina--pellizco');
    return;
  }
  focoPendiente = foco;
  cambiarZoom(escalaRedonda(escalaVigente * factor), true);
}

/* Una escala a mano casi nunca cae en un número redondo. Si queda muy cerca de
   un ajuste vivo, se prefiere el ajuste: así sigue recalculándose solo cuando
   gire el teléfono o cambie la barra de direcciones. */
function escalaRedonda(valor) {
  const v = Math.max(escalaAjuste, Math.min(ZOOM_MAX, valor));
  if (Math.abs(v - escalaAjuste) / escalaAjuste < 0.03) return 'ajustar';
  if (Math.abs(v - escalaAncho) / escalaAncho < 0.03) return 'ancho';
  return v;
}

function gestos() {
  let inicio = null;
  let ultimoToque = { t: 0, x: 0, y: 0 };

  hoja.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && modo === 'pdf') {
      inicio = null;                     // deja de ser un deslizamiento
      empezarPellizco(e);
      return;
    }
    if (e.touches.length !== 1) { inicio = null; return; }
    const z = modo === 'pdf' ? zonaPdf : null;
    inicio = {
      x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(),
      recorreH: z ? z.scrollWidth > z.clientWidth + 2 : false,
      desde: z ? z.scrollLeft : 0,
    };
  }, { passive: true });

  hoja.addEventListener('touchmove', (e) => {
    if (pellizco && e.touches.length === 2) {
      if (e.cancelable) e.preventDefault();   // sin esto el navegador hace su propio zoom
      seguirPellizco(e);
      return;
    }
    if (e.touches.length > 1) inicio = null;
  }, { passive: false });

  hoja.addEventListener('touchend', (e) => {
    if (pellizco && e.touches.length < 2) { soltarPellizco(); inicio = null; return; }
    const fin = e.changedTouches[0];
    if (!inicio || e.touches.length || !fin) { inicio = null; return; }
    const { x, y, t, recorreH, desde } = inicio;
    inicio = null;

    const dx = fin.clientX - x;
    const dy = fin.clientY - y;
    const quieto = Math.abs(dx) < 16 && Math.abs(dy) < 16;

    // Doble toque: la página entera o el doble, centrado donde se tocó.
    if (quieto && modo === 'pdf') {
      const ahora = Date.now();
      if (ahora - ultimoToque.t < 300 && Math.hypot(x - ultimoToque.x, y - ultimoToque.y) < 30) {
        ultimoToque = { t: 0, x: 0, y: 0 };
        const cerca = escalaVigente > escalaAjuste * 1.05;
        focoPendiente = cerca ? null : papelBajo(x, y);
        cambiarZoom(cerca ? 'ajustar' : Math.min(ZOOM_MAX, escalaAjuste * 2), !cerca);
        return;
      }
      ultimoToque = { t: ahora, x, y };
      return;
    }

    const minimo = Math.max(48, hoja.clientWidth * 0.12);
    if (Math.abs(dx) < minimo || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (Date.now() - t > 800) return;                  // arrastre lento: no es un gesto de paso
    // Con la página acercada, deslizar es recorrerla, y solo cambia de hoja
    // cuando el papel ya no se ha movido, o sea, cuando ha topado con el borde.
    // Mirar el borde con números no sirve: el hueco que reserva la barra de
    // desplazamiento hace que el máximo al que se llega de verdad no coincida
    // con el que dicen `scrollWidth` y `clientWidth`.
    if (recorreH && Math.abs(zonaPdf.scrollLeft - desde) > 4) return;
    ir(pagina + (dx < 0 ? 1 : -1));
  }, { passive: true });

  hoja.addEventListener('touchcancel', () => {
    inicio = null;
    if (pellizco) soltarPellizco();
  }, { passive: true });

  // Safari en iPhone lleva su propio pellizco además de los toques.
  for (const nombre of ['gesturestart', 'gesturechange', 'gestureend']) {
    hoja.addEventListener(nombre, (e) => e.preventDefault());
  }
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
  const pasos = escalones();
  const siguiente = delta > 0
    ? pasos.find((e) => e.valor > escalaVigente * 1.02)
    : [...pasos].reverse().find((e) => e.valor < escalaVigente * 0.98);
  if (!siguiente) return;
  fijarFocoEnElCentro();
  cambiarZoom(siguiente.modo, true);
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
