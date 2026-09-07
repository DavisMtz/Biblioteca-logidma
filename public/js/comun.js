/* Utilidades compartidas por catálogo, lector y panel. */

const Bib = (() => {
  const TEMA = 'bib.tema';

  function aplicarTema(tema) {
    document.documentElement.dataset.tema = tema || '';
    try { tema ? localStorage.setItem(TEMA, tema) : localStorage.removeItem(TEMA); } catch { /* modo privado */ }
  }

  function iniciarTema() {
    let guardado = null;
    try { guardado = localStorage.getItem(TEMA); } catch { /* sin almacenamiento */ }
    if (guardado) document.documentElement.dataset.tema = guardado;
    const boton = document.getElementById('btn-tema');
    if (!boton) return;
    boton.addEventListener('click', () => {
      const actual = document.documentElement.dataset.tema;
      const oscuroDelSistema = matchMedia('(prefers-color-scheme: dark)').matches;
      const esOscuro = actual ? actual === 'oscuro' : oscuroDelSistema;
      aplicarTema(esOscuro ? 'claro' : 'oscuro');
    });
  }

  async function api(ruta, opciones = {}) {
    const resp = await fetch(ruta, {
      credentials: 'same-origin',
      headers: opciones.body && !(opciones.body instanceof FormData)
        ? { 'content-type': 'application/json', ...(opciones.headers || {}) }
        : (opciones.headers || {}),
      ...opciones,
    });
    let datos = null;
    try { datos = await resp.json(); } catch { /* respuesta sin cuerpo */ }
    if (!resp.ok) {
      const error = new Error((datos && datos.error) || `Error ${resp.status}`);
      error.status = resp.status;
      throw error;
    }
    return datos;
  }

  let temporizador;
  function brindis(mensaje, tipo) {
    const caja = document.getElementById('brindis');
    if (!caja) return;
    caja.textContent = mensaje;
    caja.style.background = tipo === 'error' ? 'var(--danger)' : 'var(--text)';
    caja.style.color = tipo === 'error' ? '#fff' : 'var(--bg)';
    caja.dataset.visible = '1';
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { caja.dataset.visible = '0'; }, 3200);
  }

  function escapar(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function pesoLegible(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  }

  /* Paleta corta de tapas: tonos de encuadernación, no colores al azar.
     El mismo título cae siempre en la misma tapa. */
  const TAPAS = [
    ['#5c3324', '#2f1a12'],  // cuero
    ['#2f4739', '#18261e'],  // verde botella
    ['#2b3a52', '#16202e'],  // azul noche
    ['#5b4520', '#2f2311'],  // ocre
    ['#4a2b3d', '#26161f'],  // ciruela
    ['#3b3c40', '#1e1f22'],  // pizarra
  ];
  function tonosDe(texto) {
    let h = 0;
    for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) % 997;
    return TAPAS[h % TAPAS.length];
  }

  const ETIQUETAS_FORMATO = {
    pdf: 'PDF', epub: 'EPUB', docx: 'DOCX', odt: 'ODT',
    rtf: 'RTF', txt: 'TXT', html: 'HTML', md: 'MD',
  };

  function portadaHTML(libro) {
    const etiqueta = ETIQUETAS_FORMATO[libro.formato] || libro.formato.toUpperCase();
    const estado = libro.estado === 'borrador'
      ? '<span class="etiqueta etiqueta--borrador libro__estado">Borrador</span>' : '';
    if (libro.portada_url) {
      return `${estado}<span class="libro__formato">${etiqueta}</span>
        <img src="${escapar(libro.portada_url)}" alt="Portada de ${escapar(libro.titulo)}" loading="lazy">`;
    }
    const [a, b] = tonosDe(libro.titulo || libro.id);
    return `${estado}<span class="libro__formato">${etiqueta}</span>
      <div class="libro__generada" style="--tono-a:${a};--tono-b:${b}">
        <span>${escapar(libro.titulo)}</span>
        <small>${escapar(libro.autor || 'Logidma')}</small>
      </div>`;
  }

  /* ---------------- movimiento ----------------
     Regla del proyecto: ninguna animación es lo único que hace visible algo.
     Todo nace visible en el CSS y GSAP solo lo trae desde otro sitio, así que
     si no llega a correr —pestaña de fondo, GSAP que no cargó, preferencia de
     movimiento reducido— la página se ve igual, sin adorno. */

  const sinMovimiento = () =>
    typeof gsap === 'undefined' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.hidden;

  /**
   * Construye una línea de tiempo con red de seguridad: si el navegador congela
   * los fotogramas a media animación, se salta al estado final en vez de dejar
   * el contenido a medio revelar.
   */
  function animar(construir, opciones = {}) {
    if (sinMovimiento()) return null;
    const { remate = 1500, ...resto } = opciones;
    const tl = gsap.timeline({
      // clearProps por defecto: un `transform` en línea que sobrevive a la
      // animación gana al CSS y deja sin efecto estados como :active o :hover.
      defaults: { duration: 0.5, ease: 'power3.out', clearProps: 'transform,opacity' },
      ...resto,
    });
    construir(tl);

    const rematar = () => { if (tl.progress() < 1) tl.progress(1); };
    const limite = setTimeout(rematar, remate);
    const alOcultar = () => { if (document.hidden) rematar(); };
    document.addEventListener('visibilitychange', alOcultar);
    tl.eventCallback('onComplete', () => {
      clearTimeout(limite);
      document.removeEventListener('visibilitychange', alOcultar);
    });
    return tl;
  }

  /**
   * Cuenta hasta el número dado. Una cifra a medias MIENTE, así que el valor
   * final se escribe primero y la cuenta va por `animar`, que la remata si el
   * navegador congela los fotogramas.
   */
  function contar(elemento, valor) {
    if (!elemento) return;
    elemento.textContent = String(valor);
    if (valor < 2) return;
    const cursor = { n: 0 };
    const escribir = () => { elemento.textContent = String(Math.round(cursor.n)); };
    animar((tl) => {
      tl.to(cursor, {
        n: valor, duration: 0.7, ease: 'power2.out', snap: { n: 1 },
        onUpdate: escribir,
        onComplete: () => { elemento.textContent = String(valor); },
      });
    });
  }

  return {
    iniciarTema, aplicarTema, api, brindis, escapar, pesoLegible, tonosDe,
    portadaHTML, ETIQUETAS_FORMATO, animar, contar, sinMovimiento,
  };
})();

Bib.iniciarTema();
