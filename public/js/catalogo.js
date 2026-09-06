/* Catálogo: carga, búsqueda y filtro por categoría. */

const rejilla = document.getElementById('rejilla');
const filtros = document.getElementById('filtros');
const buscar = document.getElementById('buscar');

let categoriaActiva = '';
let ultimaBusqueda = '';

function esqueletos(n = 10) {
  rejilla.innerHTML = Array.from({ length: n }, () => `
    <div class="libro" aria-hidden="true">
      <div class="libro__portada esqueleto"></div>
      <div class="libro__datos">
        <div class="esqueleto" style="height:14px;width:85%"></div>
        <div class="esqueleto" style="height:12px;width:55%;margin-top:6px"></div>
      </div>
    </div>`).join('');
}

function tarjeta(libro) {
  const meta = [
    libro.paginas ? `${libro.paginas} pág.` : '',
    Bib.pesoLegible(libro.tamano),
    libro.anio || '',
  ].filter(Boolean).map((t) => `<span>${Bib.escapar(t)}</span>`).join('<span aria-hidden="true">·</span>');

  return `
    <a class="libro" href="/leer?id=${encodeURIComponent(libro.id)}">
      <div class="libro__portada">${Bib.portadaHTML(libro)}</div>
      <div class="libro__datos">
        <span class="libro__titulo">${Bib.escapar(libro.titulo)}</span>
        ${libro.autor ? `<span class="libro__autor">${Bib.escapar(libro.autor)}</span>` : ''}
        <span class="libro__meta">${meta}</span>
      </div>
    </a>`;
}

function pintarFiltros(categorias) {
  if (!categorias.length) { filtros.innerHTML = ''; return; }
  const botones = [{ categoria: '', n: null }, ...categorias].map((c) => `
    <button class="filtro" type="button" data-cat="${Bib.escapar(c.categoria)}"
            aria-pressed="${(c.categoria || '') === categoriaActiva}">
      ${c.categoria ? Bib.escapar(c.categoria) : 'Todas'}${c.n ? ` <span aria-hidden="true">(${c.n})</span>` : ''}
    </button>`).join('');
  filtros.innerHTML = botones;
}

function pintarVacio(hayFiltro) {
  rejilla.innerHTML = `
    <div class="vacio" style="grid-column:1/-1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/>
        <path d="M11 4h7.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11z"/>
      </svg>
      <h2>${hayFiltro ? 'Sin resultados' : 'La estantería está vacía'}</h2>
      <p>${hayFiltro
        ? 'Ningún libro coincide con esa búsqueda. Prueba con otras palabras o quita el filtro de categoría.'
        : 'Todavía no se ha subido ningún documento. Entra a <strong>Administrar</strong> para subir el primero.'}</p>
      ${hayFiltro ? '' : '<a class="btn btn--primario" href="/admin">Subir el primer libro</a>'}
    </div>`;
}

async function cargar() {
  rejilla.setAttribute('aria-busy', 'true');
  const parametros = new URLSearchParams();
  if (ultimaBusqueda) parametros.set('q', ultimaBusqueda);
  if (categoriaActiva) parametros.set('categoria', categoriaActiva);
  try {
    const datos = await Bib.api(`/api/libros?${parametros}`);
    document.getElementById('cifra-libros').textContent = datos.libros.length;
    document.getElementById('cifra-categorias').textContent = datos.categorias.length;
    pintarFiltros(datos.categorias);
    if (!datos.libros.length) pintarVacio(Boolean(ultimaBusqueda || categoriaActiva));
    else rejilla.innerHTML = datos.libros.map(tarjeta).join('');
    if (datos.admin) document.getElementById('texto-admin').textContent = 'Panel';
  } catch (error) {
    rejilla.innerHTML = `<div class="aviso aviso--error" style="grid-column:1/-1">
      No se pudo cargar el catálogo: ${Bib.escapar(error.message)}</div>`;
  } finally {
    rejilla.setAttribute('aria-busy', 'false');
  }
}

filtros.addEventListener('click', (e) => {
  const boton = e.target.closest('.filtro');
  if (!boton) return;
  categoriaActiva = boton.dataset.cat;
  cargar();
});

let retardo;
buscar.addEventListener('input', () => {
  clearTimeout(retardo);
  retardo = setTimeout(() => {
    ultimaBusqueda = buscar.value.trim();
    cargar();
  }, 250);
});

esqueletos();
cargar();
