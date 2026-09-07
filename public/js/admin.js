/* Panel de administración: acceso, subida por partes y edición del catálogo. */

import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const acceso = $('acceso');
const panel = $('panel');
const cola = $('cola');
const lista = $('lista');

const CATEGORIAS_SUGERIDAS = ['Manuales', 'Procedimientos', 'Formación', 'Referencia', 'Lectura', 'Legal'];
let categoriasConocidas = [...CATEGORIAS_SUGERIDAS];

/* ------------------------------ sesión ------------------------------ */

async function comprobarSesion() {
  const { admin } = await Bib.api('/api/sesion');
  acceso.hidden = admin;
  panel.hidden = !admin;
  $('btn-salir').hidden = !admin;
  if (admin) {
    cargarCatalogo();
    Bib.animar((tl) => {
      tl.from('.pestanas', { y: -10, opacity: 0, duration: 0.4 }, 0)
        .from('.soltar', { y: 16, opacity: 0, scale: 0.99, duration: 0.5 }, 0.05);
    });
  } else {
    $('clave').focus();
    Bib.animar((tl) => tl.from('.acceso__tarjeta', {
      y: 18, opacity: 0, scale: 0.98, duration: 0.5,
      clearProps: 'transform,opacity',
    }));
  }
}

$('form-acceso').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('error-acceso');
  const boton = $('btn-entrar');
  error.hidden = true;
  boton.disabled = true;
  boton.textContent = 'Comprobando…';
  try {
    await Bib.api('/api/sesion', { method: 'POST', body: JSON.stringify({ clave: $('clave').value }) });
    $('clave').value = '';
    await comprobarSesion();
  } catch (fallo) {
    error.textContent = fallo.message;
    error.hidden = false;
    $('clave').select();
  } finally {
    boton.disabled = false;
    boton.textContent = 'Entrar';
  }
});

$('btn-salir').addEventListener('click', async () => {
  await Bib.api('/api/sesion', { method: 'DELETE' });
  location.reload();
});

/* ------------------------------ pestañas ------------------------------ */

const PESTANAS = ['subir', 'catalogo', 'seguridad'];

function pestana(activa) {
  for (const nombre of PESTANAS) {
    const esta = nombre === activa;
    $(`tab-${nombre}`).setAttribute('aria-selected', String(esta));
    $(`vista-${nombre}`).hidden = !esta;
  }
  Bib.animar((tl) => tl.from(`#vista-${activa}`, {
    y: 10, opacity: 0, duration: 0.35, clearProps: 'transform,opacity',
  }));
  if (activa === 'catalogo') cargarCatalogo();
}
for (const nombre of PESTANAS) $(`tab-${nombre}`).addEventListener('click', () => pestana(nombre));

/* ------------------------------ elegir archivos ------------------------------ */

const soltar = $('soltar');
const entradaArchivos = $('archivos');

soltar.addEventListener('click', () => entradaArchivos.click());
soltar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); entradaArchivos.click(); }
});
entradaArchivos.addEventListener('change', () => {
  encolar([...entradaArchivos.files]);
  entradaArchivos.value = '';
});
['dragenter', 'dragover'].forEach((evento) =>
  soltar.addEventListener(evento, (e) => { e.preventDefault(); soltar.dataset.encima = '1'; }));
['dragleave', 'drop'].forEach((evento) =>
  soltar.addEventListener(evento, (e) => { e.preventDefault(); soltar.dataset.encima = '0'; }));
soltar.addEventListener('drop', (e) => encolar([...(e.dataTransfer?.files || [])]));

const EXTENSIONES = ['pdf', 'epub', 'docx', 'odt', 'rtf', 'txt', 'html', 'htm', 'md'];

function encolar(archivos) {
  for (const archivo of archivos) {
    const ext = (archivo.name.split('.').pop() || '').toLowerCase();
    if (!EXTENSIONES.includes(ext)) {
      Bib.brindis(`«${archivo.name}» no es un formato admitido`, 'error');
      continue;
    }
    const ficha = crearFicha(archivo);
    cola.prepend(ficha);
    Bib.animar((tl) => tl.from(ficha, {
      y: -14, opacity: 0, scale: 0.985, duration: 0.45,
      clearProps: 'transform,opacity',
    }));
  }
}

/* ------------------------------ ficha de subida ------------------------------ */

function crearFicha(archivo) {
  const ficha = document.createElement('article');
  ficha.className = 'ficha';
  const titulo = archivo.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const ext = (archivo.name.split('.').pop() || '').toLowerCase();
  const [tonoA, tonoB] = Bib.tonosDe(titulo);

  ficha.innerHTML = `
    <div class="ficha__portada" data-portada>
      <div class="libro__generada" style="--tono-a:${tonoA};--tono-b:${tonoB}">
        <span>${Bib.escapar(titulo)}</span><small>Logidma</small>
      </div>
    </div>
    <div class="ficha__cuerpo">
      <p class="ficha__archivo">
        <span class="etiqueta">${ext.toUpperCase()}</span>
        <span>${Bib.escapar(archivo.name)}</span>
        <span aria-hidden="true">·</span>
        <span>${Bib.pesoLegible(archivo.size)}</span>
      </p>
      <div class="ficha__campos">
        <div class="campo campo--ancho">
          <label class="campo__label">Título</label>
          <input class="entrada" data-campo="titulo" value="${Bib.escapar(titulo)}">
        </div>
        <div class="campo">
          <label class="campo__label">Autor</label>
          <input class="entrada" data-campo="autor" placeholder="Opcional">
        </div>
        <div class="campo">
          <label class="campo__label">Categoría</label>
          <input class="entrada" data-campo="categoria" list="categorias" placeholder="Opcional">
        </div>
        <div class="campo">
          <label class="campo__label">Año</label>
          <input class="entrada" data-campo="anio" type="number" min="1400" max="2200" placeholder="Opcional">
        </div>
        <div class="campo">
          <label class="campo__label">Visibilidad</label>
          <select class="selector" data-campo="estado">
            <option value="publicado">Publicado</option>
            <option value="borrador">Borrador (solo administradores)</option>
          </select>
        </div>
        <div class="campo campo--ancho">
          <label class="campo__label">Descripción</label>
          <textarea class="area" data-campo="descripcion" placeholder="De qué trata, para quién es…"></textarea>
        </div>
      </div>
      <div class="barra" data-barra><span></span></div>
      <p class="ficha__estado" data-estado>Listo para subir.</p>
      <div class="ficha__acciones">
        <button class="btn btn--primario btn--sm" data-subir type="button">Subir a la biblioteca</button>
        <button class="btn btn--linea btn--sm" data-portada-propia type="button">Poner portada</button>
        <button class="btn btn--texto btn--sm" data-quitar type="button">Quitar</button>
        <input type="file" accept="image/*" hidden data-portada-entrada>
      </div>
    </div>`;

  const estado = ficha.querySelector('[data-estado]');
  const barra = ficha.querySelector('[data-barra]');
  const relleno = barra.querySelector('span');
  let portadaBlob = null;
  let portadaUrl = '';

  function decir(texto, tipo = '') {
    estado.textContent = texto;
    estado.dataset.tipo = tipo;
  }

  // Portada automática: la primera página del PDF.
  if (ext === 'pdf') {
    portadaDePdf(archivo).then(({ blob, url }) => {
      if (!blob) return;
      portadaBlob = blob;
      ficha.querySelector('[data-portada]').innerHTML = `<img src="${url}" alt="">`;
    }).catch(() => { /* si no se puede, queda la portada tipográfica */ });
  }

  ficha.querySelector('[data-portada-propia]').addEventListener('click', () =>
    ficha.querySelector('[data-portada-entrada]').click());
  ficha.querySelector('[data-portada-entrada]').addEventListener('change', (e) => {
    const imagen = e.target.files[0];
    if (!imagen) return;
    portadaBlob = imagen;
    ficha.querySelector('[data-portada]').innerHTML = `<img src="${URL.createObjectURL(imagen)}" alt="">`;
  });

  ficha.querySelector('[data-quitar]').addEventListener('click', () => ficha.remove());

  ficha.querySelector('[data-subir]').addEventListener('click', async (e) => {
    const boton = e.currentTarget;
    boton.disabled = true;
    ficha.querySelectorAll('input, textarea, select').forEach((c) => { c.disabled = true; });
    barra.className = 'barra';
    relleno.style.transform = 'scaleX(0)';
    try {
      const valor = (campo) => ficha.querySelector(`[data-campo="${campo}"]`).value.trim();

      decir('Preparando la subida…');
      // El tamaño va solo para que el servidor elija almacén; el que se guarda
      // en el catálogo lo cuenta él sumando las partes que recibe.
      const inicio = await Bib.api('/api/subir/iniciar', {
        method: 'POST', body: JSON.stringify({ nombre: archivo.name, tamano: archivo.size }),
      });

      const partes = [];
      const total = Math.max(1, Math.ceil(archivo.size / inicio.tamanoParte));
      for (let n = 1; n <= total; n++) {
        const trozo = archivo.slice((n - 1) * inicio.tamanoParte, n * inicio.tamanoParte);
        const resp = await fetch(`/api/subir/parte?id=${inicio.id}&n=${n}`, {
          method: 'PUT', body: trozo, credentials: 'same-origin',
        });
        if (!resp.ok) throw new Error(`Falló la parte ${n} de ${total}`);
        partes.push(await resp.json());
        relleno.style.transform = `scaleX(${(n / total) * 0.88})`;
        decir(total > 1 ? `Subiendo… parte ${n} de ${total}` : 'Subiendo…');
      }

      if (portadaBlob) {
        decir('Subiendo la portada…');
        portadaUrl = await subirPortada(portadaBlob, inicio.id).catch(() => '');
      }
      relleno.style.transform = 'scaleX(.96)';

      decir('Guardando en el catálogo…');
      const anio = Number(valor('anio'));
      const { libro } = await Bib.api('/api/subir/completar', {
        method: 'POST',
        body: JSON.stringify({
          id: inicio.id, partes,
          titulo: valor('titulo'), autor: valor('autor'),
          categoria: valor('categoria'), descripcion: valor('descripcion'),
          anio: Number.isFinite(anio) && anio > 0 ? anio : null,
          estado: ficha.querySelector('[data-campo="estado"]').value,
          portada_url: portadaUrl, tamano: archivo.size,
        }),
      });

      relleno.style.transform = 'scaleX(1)';
      barra.className = 'barra barra--ok';
      decir('Listo. Ya está en la biblioteca.', 'ok');
      boton.textContent = 'Ver en la biblioteca';
      boton.className = 'btn btn--linea btn--sm';
      boton.disabled = false;
      boton.onclick = () => { location.href = `/leer?id=${encodeURIComponent(libro.id)}`; };
      Bib.brindis(`«${libro.titulo}» se subió correctamente`);
    } catch (fallo) {
      barra.className = 'barra barra--error';
      relleno.style.transform = 'scaleX(1)';
      decir(fallo.message, 'error');
      boton.disabled = false;
      ficha.querySelectorAll('input, textarea, select').forEach((c) => { c.disabled = false; });
    }
  });

  return ficha;
}

/* ------------------------------ portadas ------------------------------ */

async function portadaDePdf(archivo) {
  const buffer = await archivo.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pagina = await pdf.getPage(1);
  const base = pagina.getViewport({ scale: 1 });
  const escala = Math.min(900 / base.width, 1400 / base.height, 3);
  const vista = pagina.getViewport({ scale: escala });
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.floor(vista.width);
  lienzo.height = Math.floor(vista.height);
  await pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista }).promise;
  const blob = await new Promise((r) => lienzo.toBlob(r, 'image/jpeg', 0.86));
  return { blob, url: URL.createObjectURL(blob) };
}

/** La firma la calcula el Worker: la clave de Cloudinary nunca llega al navegador. */
async function subirPortada(blob, idLibro) {
  const firma = await Bib.api('/api/portada/firma', {
    method: 'POST', body: JSON.stringify({ libro: idLibro }),
  });
  const cuerpo = new FormData();
  cuerpo.append('file', blob);
  cuerpo.append('api_key', firma.apiKey);
  cuerpo.append('timestamp', firma.timestamp);
  cuerpo.append('folder', firma.carpeta);
  cuerpo.append('public_id', firma.publicId);
  cuerpo.append('overwrite', 'true');
  cuerpo.append('signature', firma.firma);
  const resp = await fetch(firma.url, { method: 'POST', body: cuerpo });
  const datos = await resp.json();
  if (!resp.ok) throw new Error(datos?.error?.message || 'Cloudinary rechazó la portada');
  // El tamaño se pide en la propia URL: así no se guardan copias.
  return datos.secure_url.replace('/image/upload/', '/image/upload/c_fill,w_480,h_672,q_auto,f_auto/');
}

/* ------------------------------ catálogo ------------------------------ */

let libros = [];

async function cargarCatalogo() {
  lista.innerHTML = '<p class="ficha__estado">Cargando el catálogo…</p>';
  try {
    const datos = await Bib.api('/api/libros');
    libros = datos.libros;
    categoriasConocidas = [...new Set([...CATEGORIAS_SUGERIDAS, ...datos.categorias.map((c) => c.categoria)])];
    ponerDatalist();
    pintarLista();
  } catch (error) {
    lista.innerHTML = `<div class="aviso aviso--error">${Bib.escapar(error.message)}</div>`;
  }
}

function ponerDatalist() {
  let lista_ = document.getElementById('categorias');
  if (!lista_) {
    lista_ = document.createElement('datalist');
    lista_.id = 'categorias';
    document.body.appendChild(lista_);
  }
  lista_.innerHTML = categoriasConocidas.map((c) => `<option value="${Bib.escapar(c)}">`).join('');
}

function pintarLista() {
  const filtro = $('buscar-admin').value.trim().toLowerCase();
  const visibles = libros.filter((l) =>
    !filtro || `${l.titulo} ${l.autor} ${l.categoria}`.toLowerCase().includes(filtro));

  if (!visibles.length) {
    lista.innerHTML = `<div class="vacio">
      <h2>${filtro ? 'Sin resultados' : 'Todavía no hay libros'}</h2>
      <p>${filtro ? 'Prueba con otras palabras.' : 'Sube el primero desde la pestaña «Subir libros».'}</p>
    </div>`;
    return;
  }

  lista.innerHTML = visibles.map((libro) => {
    const [a, b] = Bib.tonosDe(libro.titulo || libro.id);
    const mini = libro.portada_url
      ? `<img src="${Bib.escapar(libro.portada_url)}" alt="">`
      : `<div class="libro__generada" style="--tono-a:${a};--tono-b:${b};padding:4px"></div>`;
    const meta = [
      Bib.ETIQUETAS_FORMATO[libro.formato] || libro.formato,
      libro.autor, libro.categoria,
      libro.paginas ? `${libro.paginas} pág.` : '',
      Bib.pesoLegible(libro.tamano),
    ].filter(Boolean).map(Bib.escapar).join(' · ');
    return `
      <article class="fila" data-id="${libro.id}">
        <div class="fila__mini">${mini}</div>
        <div class="fila__datos">
          <span class="fila__titulo">${Bib.escapar(libro.titulo)}
            ${libro.estado === 'borrador' ? '<span class="etiqueta etiqueta--borrador">Borrador</span>' : ''}</span>
          <span class="fila__meta">${meta}</span>
        </div>
        <div class="fila__acciones">
          <a class="btn btn--sm btn--texto" href="/leer?id=${encodeURIComponent(libro.id)}">Leer</a>
          <button class="btn btn--sm btn--linea" data-editar type="button">Editar</button>
          <button class="btn btn--sm btn--peligro" data-borrar type="button">Eliminar</button>
        </div>
      </article>`;
  }).join('');

  Bib.animar((tl) => tl.from([...lista.querySelectorAll('.fila')].slice(0, 16), {
    y: 12, opacity: 0, duration: 0.4, stagger: 0.03, clearProps: 'transform,opacity',
  }));
}

$('buscar-admin').addEventListener('input', pintarLista);

lista.addEventListener('click', async (e) => {
  const fila = e.target.closest('.fila');
  if (!fila) return;
  const libro = libros.find((l) => l.id === fila.dataset.id);
  if (!libro) return;

  if (e.target.closest('[data-editar]')) return abrirEditor(libro);

  // Confirmación en la propia fila: sin diálogos del navegador.
  if (e.target.closest('[data-borrar]')) {
    const acciones = fila.querySelector('.fila__acciones');
    acciones.innerHTML = `
      <span class="ficha__estado" data-tipo="error">¿Eliminar «${Bib.escapar(libro.titulo)}»?</span>
      <button class="btn btn--sm btn--peligro" data-confirmar type="button">Sí, eliminar</button>
      <button class="btn btn--sm btn--linea" data-cancelar type="button">No</button>`;
    return;
  }
  if (e.target.closest('[data-cancelar]')) return pintarLista();
  if (e.target.closest('[data-confirmar]')) {
    try {
      await Bib.api(`/api/libros/${encodeURIComponent(libro.id)}`, { method: 'DELETE' });
      libros = libros.filter((l) => l.id !== libro.id);
      // La fila se retira antes de repintar; si no hay movimiento, se repinta y ya.
      const salida = Bib.animar((tl) => tl.to(fila, {
        opacity: 0, x: 24, duration: 0.25, ease: 'power2.in',
      }));
      if (salida) await salida.then();
      pintarLista();
      Bib.brindis(`«${libro.titulo}» se eliminó`);
    } catch (error) {
      Bib.brindis(error.message, 'error');
      pintarLista();
    }
  }
});

/* ------------------------------ editor ------------------------------ */

const editor = $('editor');
let enEdicion = null;

function abrirEditor(libro) {
  enEdicion = libro;
  $('titulo-editor').textContent = 'Editar libro';
  $('cuerpo-editor').innerHTML = `
    <div class="campo campo--ancho">
      <label class="campo__label" for="e-titulo">Título</label>
      <input class="entrada" id="e-titulo" value="${Bib.escapar(libro.titulo)}">
    </div>
    <div class="campo">
      <label class="campo__label" for="e-autor">Autor</label>
      <input class="entrada" id="e-autor" value="${Bib.escapar(libro.autor)}">
    </div>
    <div class="campo">
      <label class="campo__label" for="e-categoria">Categoría</label>
      <input class="entrada" id="e-categoria" list="categorias" value="${Bib.escapar(libro.categoria)}">
    </div>
    <div class="campo">
      <label class="campo__label" for="e-anio">Año</label>
      <input class="entrada" id="e-anio" type="number" min="1400" max="2200" value="${libro.anio || ''}">
    </div>
    <div class="campo">
      <label class="campo__label" for="e-estado">Visibilidad</label>
      <select class="selector" id="e-estado">
        <option value="publicado"${libro.estado === 'publicado' ? ' selected' : ''}>Publicado</option>
        <option value="borrador"${libro.estado === 'borrador' ? ' selected' : ''}>Borrador</option>
      </select>
    </div>
    <div class="campo campo--ancho">
      <label class="campo__label" for="e-descripcion">Descripción</label>
      <textarea class="area" id="e-descripcion">${Bib.escapar(libro.descripcion)}</textarea>
    </div>
    <div class="campo campo--ancho">
      <label class="campo__label" for="e-portada">Portada</label>
      <input class="entrada" id="e-portada" type="file" accept="image/*">
      <span class="campo__ayuda">Si no eliges nada, se conserva la portada actual.</span>
    </div>`;
  editor.showModal();
  Bib.animar((tl) => tl.from('.modal__caja', {
    y: 16, opacity: 0, scale: 0.97, duration: 0.35, ease: 'power3.out',
    clearProps: 'transform,opacity',
  }));
}

$('cerrar-editor').addEventListener('click', () => editor.close());
$('cancelar-editor').addEventListener('click', () => editor.close());

$('guardar-editor').addEventListener('click', async () => {
  if (!enEdicion) return;
  const boton = $('guardar-editor');
  boton.disabled = true;
  boton.textContent = 'Guardando…';
  try {
    const imagen = $('e-portada').files[0];
    const portada = imagen ? await subirPortada(imagen, enEdicion.id) : enEdicion.portada_url;
    const anio = Number($('e-anio').value);
    const { libro } = await Bib.api(`/api/libros/${encodeURIComponent(enEdicion.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        titulo: $('e-titulo').value.trim(),
        autor: $('e-autor').value.trim(),
        categoria: $('e-categoria').value.trim(),
        descripcion: $('e-descripcion').value.trim(),
        anio: Number.isFinite(anio) && anio > 0 ? anio : null,
        estado: $('e-estado').value,
        portada_url: portada,
      }),
    });
    libros = libros.map((l) => (l.id === libro.id ? libro : l));
    pintarLista();
    editor.close();
    Bib.brindis('Cambios guardados');
  } catch (error) {
    Bib.brindis(error.message, 'error');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Guardar cambios';
  }
});

/* ------------------------------ cambiar la contraseña ------------------------------ */

const formClave = $('form-clave');
const claveNueva = $('clave-nueva');
const claveRepetir = $('clave-repetir');
const claveActual = $('clave-actual');

/** Pista de fortaleza, no un candado: la decisión final es suya. */
function medirClave(valor) {
  if (valor.length < 8) return { nivel: 1, texto: 'Muy corta: al menos 8 caracteres.' };
  let variedad = 0;
  if (/[a-záéíóúñ]/.test(valor)) variedad++;
  if (/[A-ZÁÉÍÓÚÑ]/.test(valor)) variedad++;
  if (/\d/.test(valor)) variedad++;
  if (/[^\w\s]/.test(valor)) variedad++;
  if (/\s/.test(valor)) variedad++;              // una frase cuenta como variedad
  if (valor.length >= 16 || (valor.length >= 12 && variedad >= 3)) {
    return { nivel: 3, texto: 'Buena: difícil de adivinar.' };
  }
  if (valor.length >= 10 || variedad >= 3) return { nivel: 2, texto: 'Aceptable. Una frase larga sería mejor.' };
  return { nivel: 1, texto: 'Débil: alárgala o usa una frase con espacios.' };
}

function revisarFormulario() {
  const nueva = claveNueva.value;
  const barra = $('fuerza-barra');
  const medidor = barra.parentElement;

  if (nueva) {
    const { nivel, texto } = medirClave(nueva);
    medidor.dataset.nivel = String(nivel);
    barra.style.transform = `scaleX(${nivel / 3})`;
    $('fuerza-texto').textContent = texto;
  } else {
    medidor.dataset.nivel = '';
    barra.style.transform = 'scaleX(0)';
    $('fuerza-texto').textContent = '';
  }

  const coinciden = !claveRepetir.value || claveRepetir.value === nueva;
  $('repetir-aviso').textContent = coinciden ? '' : 'Las dos contraseñas no coinciden.';
  $('repetir-aviso').style.color = coinciden ? '' : 'var(--danger)';

  $('btn-clave').disabled = !(claveActual.value && nueva.length >= 8 && claveRepetir.value === nueva);
}

[claveActual, claveNueva, claveRepetir].forEach((campo) =>
  campo.addEventListener('input', revisarFormulario));

formClave.addEventListener('submit', async (e) => {
  e.preventDefault();
  const boton = $('btn-clave');
  const error = $('error-clave');
  error.hidden = true;
  boton.disabled = true;
  boton.textContent = 'Cambiando…';
  try {
    await Bib.api('/api/clave', {
      method: 'POST',
      body: JSON.stringify({ actual: claveActual.value, nueva: claveNueva.value }),
    });
    formClave.reset();
    revisarFormulario();
    // El servidor ya retiró la cookie: hay que volver a entrar con la nueva.
    Bib.brindis('Contraseña cambiada. Entra de nuevo con la nueva.');
    setTimeout(() => location.reload(), 1800);
  } catch (fallo) {
    error.textContent = fallo.message;
    error.hidden = false;
    boton.disabled = false;
    boton.textContent = 'Cambiar la contraseña';
    revisarFormulario();
  }
});

comprobarSesion();
