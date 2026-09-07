/* Instalación como aplicación.

   Dos trabajos: registrar el service worker y ofrecer la instalación una sola
   vez, sin estorbar. El letrero se construye aquí y no en el HTML para que la
   página no cargue con un hueco que quizá nunca se llene. */

(() => {
  const RECHAZO = 'bib.instalar.rechazado';
  const ESPERA = 30 * 24 * 60 * 60 * 1000; // un mes de tregua tras decir que no

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* sin conexión o modo privado */ });
    });
  }

  const yaInstalada = () =>
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: minimal-ui)').matches ||
    navigator.standalone === true;

  const enTregua = () => {
    try {
      const desde = Number(localStorage.getItem(RECHAZO));
      return Boolean(desde) && Date.now() - desde < ESPERA;
    } catch { return false; }
  };

  const apartar = () => { try { localStorage.setItem(RECHAZO, String(Date.now())); } catch { /* modo privado */ } };

  // Leyendo no se interrumpe a nadie: el ofrecimiento vive en el catálogo.
  const leyendo = document.body.classList.contains('cuerpo-lector');
  if (leyendo || yaInstalada() || enTregua()) return;

  let letrero = null;

  function cerrar(recordar) {
    if (!letrero) return;
    if (recordar) apartar();
    letrero.dataset.visible = '0';
    const quitar = () => letrero && letrero.remove();
    letrero.addEventListener('transitionend', quitar, { once: true });
    setTimeout(quitar, 400); // por si la transición no llega a correr
  }

  /**
   * Dibuja la barra. `accion` es null en iOS, donde no existe la instalación
   * automática y lo único que se puede hacer es explicar el camino.
   */
  function mostrar({ texto, accion }) {
    if (letrero) return;
    letrero = document.createElement('div');
    letrero.className = 'instalar';
    letrero.dataset.visible = '0';
    letrero.setAttribute('role', 'dialog');
    letrero.setAttribute('aria-label', 'Instalar la biblioteca');
    letrero.innerHTML = `
      <svg class="instalar__icono" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H11v18H5.5A1.5 1.5 0 0 1 4 19.5z"/>
        <path d="M11 3h7.5A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5H11z"/>
      </svg>
      <div class="instalar__texto">
        <strong>Ten la biblioteca a mano</strong>
        <span>${texto}</span>
      </div>
      <div class="instalar__botones">
        ${accion ? '<button class="btn btn--primario btn--sm" type="button" data-instalar>Instalar</button>' : ''}
        <button class="btn btn--linea btn--sm" type="button" data-ahora-no>${accion ? 'Ahora no' : 'Entendido'}</button>
      </div>`;
    document.body.appendChild(letrero);
    requestAnimationFrame(() => { letrero.dataset.visible = '1'; });

    letrero.querySelector('[data-ahora-no]').addEventListener('click', () => cerrar(true));
    const boton = letrero.querySelector('[data-instalar]');
    if (boton) boton.addEventListener('click', () => { boton.disabled = true; accion(); });
  }

  /* Chrome, Edge y Android avisan cuando la instalación es posible. */
  addEventListener('beforeinstallprompt', (evento) => {
    evento.preventDefault();
    mostrar({
      texto: 'Instálala y ábrela como una aplicación, sin buscar la dirección.',
      accion: async () => {
        evento.prompt();
        const { outcome } = await evento.userChoice;
        cerrar(outcome !== 'accepted');
      },
    });
  });

  addEventListener('appinstalled', () => { apartar(); cerrar(false); });

  /* iOS no dispara ese aviso: ahí solo cabe enseñar el camino, y una sola vez. */
  const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (esIOS) {
    setTimeout(() => mostrar({
      texto: 'Toca Compartir y luego «Añadir a pantalla de inicio».',
      accion: null,
    }), 2500);
  }
})();
