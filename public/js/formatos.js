/* Convierte cada formato de libro en páginas legibles.
   Todo ocurre en el navegador: el Worker solo entrega los bytes.

   El libro NO se sirve de una pieza. `abrir()` devuelve un objeto que guarda
   los capítulos en crudo y solo los limpia y los trocea cuando el lector pide
   sus bloques. El motivo es de peso: limpiar y maquetar un libro entero de
   golpe son minutos de trabajo y cientos de megas de memoria, y en un teléfono
   eso no es lentitud, es que el navegador mata la pestaña. */

const Formatos = (() => {
  'use strict';

  const blobsVivos = [];
  function urlDe(blob) {
    const url = URL.createObjectURL(blob);
    blobsVivos.push(url);
    return url;
  }
  addEventListener('pagehide', () => blobsVivos.forEach((u) => URL.revokeObjectURL(u)));

  const OPCIONES = {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
                  'link', 'meta', 'base', 'audio', 'video', 'source', 'track'],
    FORBID_ATTR: ['srcset', 'sizes', 'ping'],
    ADD_ATTR: ['loading', 'decoding'],
    // Las imágenes de EPUB/ODT salen del propio ZIP como blob:, y las de DOCX como data:.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|data|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  };

  const limpiar = (html) => DOMPurify.sanitize(html, OPCIONES);

  const escapar = (t) => String(t ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------ TXT ------------------------------ */

  function deTexto(buffer) {
    const texto = new TextDecoder('utf-8').decode(buffer);
    return texto
      .split(/\n\s*\n/)
      .map((p) => `<p>${escapar(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  /* ------------------------------ Markdown ------------------------------ */

  function deMarkdown(buffer) {
    return marked.parse(new TextDecoder('utf-8').decode(buffer), { breaks: false, gfm: true });
  }

  /* ------------------------------ HTML ------------------------------ */

  function deHTML(buffer) {
    const texto = new TextDecoder('utf-8').decode(buffer);
    const doc = new DOMParser().parseFromString(texto, 'text/html');
    return doc.body ? doc.body.innerHTML : texto;
  }

  /* ------------------------------ DOCX ------------------------------ */

  async function deDocx(buffer) {
    const resultado = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
        ],
      },
    );
    return resultado.value;
  }

  /* ------------------------------ ODT ------------------------------ */

  /** Lee los estilos automáticos para saber qué span va en negrita, cursiva o subrayado. */
  function estilosODT(doc) {
    const mapa = new Map();
    for (const estilo of doc.getElementsByTagNameNS('*', 'style')) {
      const nombre = estilo.getAttributeNS('*', 'name') || estilo.getAttribute('style:name');
      if (!nombre) continue;
      const props = estilo.getElementsByTagNameNS('*', 'text-properties')[0];
      if (!props) continue;
      const attr = (n) => props.getAttribute(n) || '';
      mapa.set(nombre, {
        negrita: /bold|[6-9]00/.test(attr('fo:font-weight')),
        cursiva: /italic|oblique/.test(attr('fo:font-style')),
        subrayado: attr('style:text-underline-style') && attr('style:text-underline-style') !== 'none',
      });
    }
    return mapa;
  }

  function textoODT(nodo, estilos) {
    let salida = '';
    for (const hijo of nodo.childNodes) {
      if (hijo.nodeType === 3) { salida += escapar(hijo.nodeValue); continue; }
      if (hijo.nodeType !== 1) continue;
      const etiqueta = hijo.localName;
      if (etiqueta === 's') {
        salida += '&nbsp;'.repeat(Number(hijo.getAttribute('text:c') || 1));
      } else if (etiqueta === 'tab') {
        salida += '&emsp;';
      } else if (etiqueta === 'line-break') {
        salida += '<br>';
      } else if (etiqueta === 'span') {
        const estilo = estilos.get(hijo.getAttribute('text:style-name')) || {};
        let dentro = textoODT(hijo, estilos);
        if (estilo.negrita) dentro = `<strong>${dentro}</strong>`;
        if (estilo.cursiva) dentro = `<em>${dentro}</em>`;
        if (estilo.subrayado) dentro = `<u>${dentro}</u>`;
        salida += dentro;
      } else if (etiqueta === 'a') {
        const href = hijo.getAttribute('xlink:href') || '#';
        salida += `<a href="${escapar(href)}" target="_blank" rel="noopener">${textoODT(hijo, estilos)}</a>`;
      } else {
        salida += textoODT(hijo, estilos);
      }
    }
    return salida;
  }

  async function deOdt(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const contenido = await zip.file('content.xml').async('string');
    const doc = new DOMParser().parseFromString(contenido, 'application/xml');
    const estilos = estilosODT(doc);

    // Las imágenes viven en Pictures/ dentro del propio ZIP.
    const imagenes = new Map();
    for (const nombre of Object.keys(zip.files)) {
      if (/^Pictures\//i.test(nombre) && !zip.files[nombre].dir) {
        imagenes.set(nombre, urlDe(await zip.file(nombre).async('blob')));
      }
    }

    const cuerpo = doc.getElementsByTagNameNS('*', 'text')[0];
    if (!cuerpo) return '<p>El documento no trae contenido legible.</p>';

    const partes = [];

    function bloque(nodo) {
      const etiqueta = nodo.localName;
      if (etiqueta === 'h') {
        const nivel = Math.min(6, Math.max(1, Number(nodo.getAttribute('text:outline-level') || 1)));
        partes.push(`<h${nivel}>${textoODT(nodo, estilos)}</h${nivel}>`);
      } else if (etiqueta === 'p') {
        const imagen = nodo.getElementsByTagNameNS('*', 'image')[0];
        if (imagen) {
          const href = imagen.getAttribute('xlink:href') || '';
          const url = imagenes.get(href.replace(/^\.\//, ''));
          if (url) partes.push(`<p class="imagen"><img src="${url}" alt=""></p>`);
        }
        const texto = textoODT(nodo, estilos).trim();
        if (texto) partes.push(`<p>${texto}</p>`);
      } else if (etiqueta === 'list') {
        const items = [];
        for (const item of nodo.children) {
          if (item.localName !== 'list-item') continue;
          const dentro = [];
          for (const sub of item.children) {
            if (sub.localName === 'list') { dentro.push('__ANIDADA__'); bloque(sub); }
            else dentro.push(textoODT(sub, estilos));
          }
          items.push(`<li>${dentro.filter((d) => d !== '__ANIDADA__').join(' ')}</li>`);
        }
        if (items.length) partes.push(`<ul>${items.join('')}</ul>`);
      } else if (etiqueta === 'table') {
        const filas = [];
        for (const fila of nodo.getElementsByTagNameNS('*', 'table-row')) {
          const celdas = [];
          for (const celda of fila.children) {
            if (celda.localName !== 'table-cell') continue;
            celdas.push(`<td>${textoODT(celda, estilos)}</td>`);
          }
          filas.push(`<tr>${celdas.join('')}</tr>`);
        }
        if (filas.length) partes.push(`<table>${filas.join('')}</table>`);
      } else if (etiqueta === 'section') {
        for (const hijo of nodo.children) bloque(hijo);
      }
    }

    for (const nodo of cuerpo.children) bloque(nodo);
    return partes.join('');
  }

  /* ------------------------------ RTF ------------------------------ */

  /** Intérprete mínimo de RTF: suficiente para documentos de texto con formato. */
  function deRtf(buffer) {
    const crudo = new TextDecoder('latin1').decode(buffer);
    // Destinos que no se leen: tablas de fuentes, colores, estilos, metadatos e imágenes.
    const IGNORAR = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|footnote|xmlns|themedata|colorschememapping|latentstyles|datastore|generator|listtable|listoverridetable|rsidtbl|mmathPr|nonshppict|shppict|shpinst|bkmkstart|bkmkend|field|fldinst|fldrslt|filetbl|revtbl|upr)$/;

    let i = 0;
    const pila = [];
    let estado = { negrita: false, cursiva: false, subrayado: false, oculto: false, codificacion: 'windows-1252' };
    const parrafos = [];
    let actual = '';
    let bytesPendientes = [];
    let saltarUnicode = 0;

    const decodificador = () => new TextDecoder(estado.codificacion === 'utf8' ? 'utf-8' : 'windows-1252');

    function volcarBytes() {
      if (!bytesPendientes.length) return;
      const texto = decodificador().decode(new Uint8Array(bytesPendientes));
      bytesPendientes = [];
      if (!estado.oculto) actual += escapar(texto);
    }

    function agregar(texto) {
      volcarBytes();
      if (!estado.oculto) actual += escapar(texto);
    }

    function cerrarParrafo() {
      volcarBytes();
      const texto = actual.trim();
      if (texto) parrafos.push(`<p>${texto}</p>`);
      actual = '';
    }

    // Marcas de formato: se abren y cierran de golpe al cambiar el estado.
    let abiertas = { negrita: false, cursiva: false, subrayado: false };
    function sincronizar() {
      volcarBytes();
      for (const clave of ['subrayado', 'cursiva', 'negrita']) {
        if (abiertas[clave] && !estado[clave]) {
          actual += clave === 'negrita' ? '</strong>' : clave === 'cursiva' ? '</em>' : '</u>';
          abiertas[clave] = false;
        }
      }
      for (const clave of ['negrita', 'cursiva', 'subrayado']) {
        if (!abiertas[clave] && estado[clave]) {
          actual += clave === 'negrita' ? '<strong>' : clave === 'cursiva' ? '<em>' : '<u>';
          abiertas[clave] = true;
        }
      }
    }

    while (i < crudo.length) {
      const c = crudo[i];

      if (c === '{') {
        pila.push({ ...estado });
        i++;
        // {\* ...} = destino que el lector puede ignorar entero.
        if (crudo[i] === '\\' && crudo[i + 1] === '*') {
          let profundidad = 1; i += 2;
          while (i < crudo.length && profundidad > 0) {
            if (crudo[i] === '{') profundidad++;
            else if (crudo[i] === '}') profundidad--;
            else if (crudo[i] === '\\') i++;
            i++;
          }
          estado = pila.pop() || estado;
        }
        continue;
      }

      if (c === '}') {
        volcarBytes();
        const previo = pila.pop();
        if (previo) { estado = previo; sincronizar(); }
        i++;
        continue;
      }

      if (c === '\\') {
        const siguiente = crudo[i + 1];

        if (siguiente === "'") {                       // \'xx = byte en hexadecimal
          const hex = crudo.slice(i + 2, i + 4);
          if (saltarUnicode > 0) { saltarUnicode--; i += 4; continue; }
          bytesPendientes.push(parseInt(hex, 16) || 32);
          i += 4;
          continue;
        }
        if (siguiente === '\\' || siguiente === '{' || siguiente === '}') {
          agregar(siguiente); i += 2; continue;
        }
        if (siguiente === '\n' || siguiente === '\r') { cerrarParrafo(); i += 2; continue; }

        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(crudo.slice(i));
        if (!m) { i++; continue; }
        const palabra = m[1];
        const valor = m[2] === undefined ? null : Number(m[2]);
        i += m[0].length;

        if (IGNORAR.test(palabra)) {                   // saltar el grupo entero
          let profundidad = 1;
          while (i < crudo.length && profundidad > 0) {
            if (crudo[i] === '{') profundidad++;
            else if (crudo[i] === '}') profundidad--;
            else if (crudo[i] === '\\') i++;
            i++;
          }
          estado = pila.pop() || estado;
          continue;
        }

        switch (palabra) {
          case 'par': case 'line': cerrarParrafo(); break;
          case 'pard': estado.negrita = estado.cursiva = estado.subrayado = false; sincronizar(); break;
          case 'b': estado.negrita = valor !== 0; sincronizar(); break;
          case 'i': estado.cursiva = valor !== 0; sincronizar(); break;
          case 'ul': estado.subrayado = valor !== 0; sincronizar(); break;
          case 'ulnone': estado.subrayado = false; sincronizar(); break;
          case 'plain': estado.negrita = estado.cursiva = estado.subrayado = false; sincronizar(); break;
          case 'v': estado.oculto = valor !== 0; break;
          case 'tab': agregar(' '); break;
          case 'emdash': agregar('—'); break;
          case 'endash': agregar('–'); break;
          case 'lquote': agregar('‘'); break;
          case 'rquote': agregar('’'); break;
          case 'ldblquote': agregar('“'); break;
          case 'rdblquote': agregar('”'); break;
          case 'bullet': agregar('•'); break;
          case 'ansicpg': estado.codificacion = valor === 65001 ? 'utf8' : 'windows-1252'; break;
          case 'u': {                                   // \uN = carácter Unicode
            volcarBytes();
            if (valor !== null) {
              const punto = valor < 0 ? valor + 65536 : valor;
              if (!estado.oculto) actual += escapar(String.fromCharCode(punto));
            }
            saltarUnicode = 1;                          // el sustituto que viene detrás se descarta
            break;
          }
          default: break;
        }
        continue;
      }

      if (c === '\n' || c === '\r') { i++; continue; }
      if (saltarUnicode > 0 && c !== ' ') { saltarUnicode--; i++; continue; }
      bytesPendientes.push(crudo.charCodeAt(i) & 0xff);
      i++;
    }

    cerrarParrafo();
    return parrafos.join('') || '<p>El archivo RTF no contiene texto legible.</p>';
  }

  /* ------------------------------ EPUB ------------------------------ */

  /* Descomprimir el ZIP se manda a un hilo aparte: es el trozo de trabajo más
     largo con diferencia y, hecho aquí, deja la pantalla congelada todo ese
     rato. El respaldo en la propia página existe porque un worker puede no
     arrancar —navegadores dentro de apps, políticas raras— y quedarse sin
     libro por eso sería peor que abrirlo despacio. */

  const SIN_NOTICIAS = 60000;   // si el hilo aparte no da señales en un minuto, se da por perdido

  function abrirEpub(buffer, avisar) {
    const aquiMismo = () => {
      if (typeof EpubZip === 'undefined') throw new Error('No se cargó el módulo que abre los EPUB.');
      return EpubZip.abrir(buffer, avisar);
    };
    return new Promise((resolver, rechazar) => {
      let worker = null;
      try { worker = new Worker('/js/epub-worker.js'); } catch { worker = null; }
      if (!worker) return resolver(aquiMismo());

      let vivo = true;
      let reloj = 0;
      const cerrar = () => { vivo = false; clearTimeout(reloj); worker.terminate(); };
      // El plazo se cuenta desde la última señal, no desde el principio: un
      // libro enorme en un teléfono viejo tarda, pero va avisando.
      const vigilar = () => {
        clearTimeout(reloj);
        reloj = setTimeout(() => {
          if (!vivo) return;
          cerrar();
          rechazar(new Error('El libro tardó demasiado en abrirse.'));
        }, SIN_NOTICIAS);
      };
      vigilar();

      worker.onmessage = ({ data }) => {
        if (!vivo) return;
        if (data.tipo === 'progreso') { vigilar(); return avisar(data.porcentaje, data.texto); }
        cerrar();
        if (data.tipo === 'error') rechazar(new Error(data.mensaje));
        else resolver(data);
      };
      worker.onerror = () => {
        if (!vivo) return;
        cerrar();
        Promise.resolve().then(aquiMismo).then(resolver, rechazar);
      };
      // El buffer se copia en vez de cederse: si el worker no llega a arrancar,
      // el respaldo de aquí lo necesita entero.
      worker.postMessage({ buffer });
    });
  }

  /* ------------------ los estilos que trae el propio libro ------------------ */

  /* Un EPUB viene con sus hojas de estilo y sin ellas se lee como un chorro de
     párrafos iguales: se pierden las dedicatorias centradas, la sangría de la
     primera línea, los versos, las citas, las versalitas. Pero esos estilos
     también pueden romper el lector (posiciones fijas, columnas propias,
     alturas en píxeles) o pelearse con los temas claro/sepia/oscuro.

     Así que no se copian: se filtran propiedad por propiedad, se les quita
     todo lo que no sea tipografía y cada selector se encierra bajo
     `.hoja__flujo`, que es la caja del texto. */

  const PROPIEDADES = new Set([
    'font-style', 'font-weight', 'font-variant', 'font-variant-caps', 'font-size',
    'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-indent',
    'text-decoration', 'text-decoration-line', 'text-transform', 'vertical-align',
    'white-space', 'hyphens', 'direction', 'quotes',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'list-style', 'list-style-type', 'list-style-position',
    'border-collapse', 'display', 'float', 'clear', 'width', 'max-width',
    'break-before', 'break-after', 'break-inside',
  ]);

  /* `line-height` NO está en la lista a propósito. El lector calcula la altura
     de la página para que quepa un número entero de renglones —si sobra medio,
     la última línea sale cortada por la mitad— y ese cálculo usa el interlineado
     de la caja. Si cada párrafo trae el suyo, la cuenta deja de salir.
     `color`, `background` y `font-family` tampoco: los temas de lectura y la
     letra del lector tienen que ganar siempre. Y `height` menos aún: una altura
     fija dentro de una columna descuadra el reparto en páginas. */

  const RELATIVA = new Set([
    'font-size', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'text-indent', 'width', 'max-width', 'letter-spacing', 'word-spacing',
  ]);

  const ABSOLUTA = /\d\s*(px|pt|pc|in|cm|mm|q)\b/i;
  // Ni paréntesis ni llaves ni comillas: sin `url()`, `calc()` ni nada que
  // pueda salirse de la declaración, el valor es texto plano y se ve de un vistazo.
  const VALOR_SUCIO = /[<>{}@\\()"';]/;
  const DISPLAY = /^(block|inline|inline-block|list-item|none|table|table-row|table-cell|table-row-group|inherit|initial)$/i;
  const PSEUDO_OK = /^(first-letter|first-line|first-child|last-child|only-child|nth-child|nth-of-type|first-of-type|last-of-type)\b/i;
  const TOPE_CSS = 400000;

  function declaracion(propiedad, valor) {
    let prop = propiedad.trim().toLowerCase();
    let val = valor.replace(/!\s*important/gi, '').trim();
    if (!prop || !val || val.length > 120 || VALOR_SUCIO.test(val)) return '';

    // Los saltos de página del libro se convierten en saltos de columna: aquí
    // una columna ES una página, así que el corte cae donde el autor lo puso.
    if (prop.startsWith('page-break-')) {
      prop = `break-${prop.slice(11)}`;
      if (/^(always|left|right|recto|verso)$/i.test(val)) val = 'column';
    }
    if (!PROPIEDADES.has(prop)) return '';
    // Medidas en píxeles o puntos: el libro las escribió para una pantalla que
    // no es esta, y no crecen con A+ ni encogen con A−.
    if (RELATIVA.has(prop) && ABSOLUTA.test(val)) return '';
    if (prop === 'display' && !DISPLAY.test(val)) return '';
    return `${prop}:${val}`;
  }

  function declaracionesSeguras(cuerpo) {
    const salida = [];
    for (const trozo of String(cuerpo).split(';')) {
      const dos = trozo.indexOf(':');
      if (dos < 1) continue;
      const decl = declaracion(trozo.slice(0, dos), trozo.slice(dos + 1));
      if (decl) salida.push(decl);
    }
    return salida.join(';');
  }

  function selectorSeguro(selector) {
    const limpio = String(selector).trim().replace(/\s+/g, ' ');
    if (!limpio || limpio.length > 200) return '';
    if (/[{}@\\"']|\/\*/.test(limpio)) return '';
    // Solo pseudoclases tipográficas: `:hover` no pinta nada en un libro y
    // `::before` con `content` metería texto que nunca pasó por la limpieza.
    for (const pseudo of limpio.match(/::?[\w-]+/g) || []) {
      if (!PSEUDO_OK.test(pseudo.replace(/^:+/, ''))) return '';
    }
    // El `html` y el `body` del libro son, aquí, la propia hoja.
    const raiz = limpio.replace(/^(html|body)\b\s*/i, '').trim();
    return raiz ? `.hoja__flujo ${raiz}` : '.hoja__flujo';
  }

  const buscar = (texto, desde, caracteres) => {
    for (let i = desde; i < texto.length; i++) if (caracteres.includes(texto[i])) return i;
    return -1;
  };

  function finDeBloque(texto, abre) {
    let nivel = 0;
    for (let i = abre; i < texto.length; i++) {
      if (texto[i] === '{') nivel++;
      else if (texto[i] === '}' && --nivel === 0) return i;
    }
    return texto.length;
  }

  /** Recorre la hoja entregando cada regla suelta: `selectores` y `cuerpo`. */
  function reglas(texto, alEncontrar, profundidad = 0) {
    if (profundidad > 4) return;
    let i = 0;
    while (i < texto.length) {
      const c = texto[i];
      if (c === '}' || c === ';' || /\s/.test(c)) { i++; continue; }
      if (c === '@') {
        const corte = buscar(texto, i, '{;');
        if (corte < 0) return;
        const prologo = texto.slice(i, corte);
        if (texto[corte] === ';') { i = corte + 1; continue; }
        const cierre = finDeBloque(texto, corte);
        // De `@media` se conserva lo de dentro; de `@font-face`, `@page` y
        // compañía, nada: son fuentes que no vamos a cargar y cajas de papel
        // que aquí no existen. Lo de imprimir tampoco pinta nada.
        if (/^@media\b/i.test(prologo) && !/\bprint\b/i.test(prologo)) {
          reglas(texto.slice(corte + 1, cierre), alEncontrar, profundidad + 1);
        }
        i = cierre + 1;
        continue;
      }
      const abre = buscar(texto, i, '{');
      if (abre < 0) return;
      const cierre = finDeBloque(texto, abre);
      alEncontrar(texto.slice(i, abre), texto.slice(abre + 1, cierre));
      i = cierre + 1;
    }
  }

  function cssSeguro(hojas) {
    let texto = (hojas || []).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
    if (texto.length > TOPE_CSS) texto = texto.slice(0, TOPE_CSS);
    const salida = [];
    reglas(texto, (selectores, cuerpo) => {
      const decls = declaracionesSeguras(cuerpo);
      if (!decls) return;
      // Sin repetidos: `html, body` acaba siendo dos veces el mismo selector.
      const buenos = [...new Set(selectores.split(',').map(selectorSeguro).filter(Boolean))];
      if (buenos.length) salida.push(`${buenos.join(',')}{${decls}}`);
    });
    return salida.join('\n');
  }

  /* ------------------------ troceado en bloques ------------------------ */

  /* El lector reparte el texto en columnas del ancho de la hoja, y para saber
     cuántas salen el navegador tiene que maquetar TODO lo que haya dentro. Con
     el libro entero ahí metido son cientos de columnas vivas a la vez: en el
     escritorio se nota, en un teléfono se come la memoria y la pestaña muere.

     Troceando, lo que se maqueta de una vez nunca pasa de unas decenas de
     páginas, dé igual lo gordo que sea el libro. Los cortes se buscan donde ya
     había una pausa —un título, una raya, un cambio de sección—, así que casi
     nunca se nota que el trozo cambió.

     Se trocea ANTES de limpiar, sobre el capítulo recién interpretado. Nada de
     lo que sale de aquí toca la página viva hasta pasar por DOMPurify. */

  /* Medido en un teléfono simulado con un libro de millón y medio de
     caracteres: con trozos de 260 000 el navegador se atasca casi dos segundos
     al maquetarlos, y con 120 000 baja a menos de uno. Por debajo se gana poco
     y se empieza a partir capítulos normales, que rara vez pasan de 60 000. */
  const PRESUPUESTO = 60000;    // a partir de aquí se corta en la primera pausa del libro…
  const TOPE_BLOQUE = 120000;   // …y a partir de aquí, en el primer sitio que haya
  const PAUSAS = /^(H[1-6]|HR|SECTION|ARTICLE|ASIDE|FIGURE|BLOCKQUOTE)$/;

  const esPausa = (nodo) => nodo.nodeType === 1 && PAUSAS.test(nodo.tagName);

  /** Muchos EPUB meten el capítulo entero dentro de un solo `<div>`: si no se
      entra en él, no hay por dónde cortar. Se baja hasta el nodo que tiene
      hermanos, guardando las capas para reponerlas en cada trozo —sus clases
      son las que llevan el estilo del libro—. */
  function desenvolver(raiz) {
    const capas = [];
    for (let n = 0; n < 6; n++) {
      const hijos = [...raiz.childNodes].filter(
        (h) => h.nodeType === 1 || (h.nodeType === 3 && h.nodeValue.trim()),
      );
      if (hijos.length !== 1 || hijos[0].nodeType !== 1 || !hijos[0].children.length) break;
      capas.push(hijos[0]);
      raiz = hijos[0];
    }
    return { raiz, capas };
  }

  function envolver(nodos, capas) {
    const caja = document.createElement('div');
    let destino = caja;
    for (const capa of capas) {
      const copia = capa.cloneNode(false);
      destino.appendChild(copia);
      destino = copia;
    }
    for (const nodo of nodos) destino.appendChild(nodo);
    return caja.innerHTML;
  }

  function partir(cuerpo) {
    const { raiz, capas } = desenvolver(cuerpo);
    const trozos = [];
    let tanda = [];
    let peso = 0;

    const cerrar = () => {
      const tieneAlgo = tanda.some((n) => n.nodeType === 1 || (n.nodeValue || '').trim());
      if (tieneAlgo) trozos.push({ crudo: envolver(tanda, capas), peso });
      tanda = [];
      peso = 0;
    };

    for (const nodo of [...raiz.childNodes]) {
      if (peso >= TOPE_BLOQUE || (peso >= PRESUPUESTO && esPausa(nodo))) cerrar();
      tanda.push(nodo);
      peso += (nodo.textContent || '').length + 48;   // el marcado también pesa al maquetar
    }
    cerrar();
    return trozos.length ? trozos : [{ crudo: '<p>Este capítulo no trae texto.</p>', peso: 30 }];
  }

  /* La limpieza se aplaza hasta que el bloque hace falta de verdad. Es con
     diferencia lo más caro de todo esto —DOMPurify recorre nodo a nodo y
     atributo a atributo— y hacerla de golpe para el libro entero es justo el
     parón que se venía a quitar: en un capítulo de millón y medio de caracteres
     son varios segundos con la pantalla muerta. Troceada se paga a plazos, y
     solo por los bloques que de verdad se leen o se miden. */
  function comoBloque(trozo) {
    let crudo = trozo.crudo;
    let limpio = null;
    return {
      peso: trozo.peso,
      get html() {
        if (limpio === null) {
          const fragmento = DOMPurify.sanitize(crudo, { ...OPCIONES, RETURN_DOM_FRAGMENT: true });
          podarEstilosEnLinea(fragmento);
          const caja = document.createElement('div');
          caja.appendChild(fragmento);
          limpio = caja.innerHTML;
          crudo = '';                 // el crudo ya no hace falta: fuera de la memoria
        }
        return limpio;
      },
    };
  }

  /* ------------------------ el libro abierto ------------------------ */

  /** El XHTML del capítulo, interpretado dentro de un documento inerte. */
  function comoCuerpo(capitulo) {
    const parser = new DOMParser();
    if (!capitulo.xml) {
      return parser.parseFromString(`<!doctype html><body>${capitulo.crudo}</body>`, 'text/html').body;
    }
    let doc = parser.parseFromString(capitulo.crudo, 'application/xhtml+xml');
    // Muchos EPUB reales no son XHTML válido; el intérprete de HTML sí los traga.
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) {
      doc = parser.parseFromString(capitulo.crudo, 'text/html');
    }
    return doc.body || doc.documentElement;
  }

  function colocarImagenes(cuerpo, carpeta, porRuta, urlDeImagen) {
    for (const img of cuerpo.querySelectorAll('img, image')) {
      const src = img.getAttribute('src') || img.getAttribute('xlink:href')
        || img.getAttribute('href') || '';
      const datos = src ? porRuta.get(EpubZip.normalizar(carpeta + EpubZip.comoRuta(src))) : null;
      if (!datos) { img.remove(); continue; }
      const url = urlDeImagen(datos.ruta);
      if (img.tagName.toLowerCase() === 'image') img.setAttribute('href', url);
      else img.setAttribute('src', url);
      img.removeAttribute('xlink:href');
      // Las medidas van en el marcado, no en el CSS: así el hueco de la
      // ilustración existe desde el primer momento y el reparto en páginas no
      // se descoloca cuando la imagen termina de descodificarse.
      if (datos.ancho && datos.alto) {
        img.setAttribute('width', String(datos.ancho));
        img.setAttribute('height', String(datos.alto));
      }
      // Solo se descodifican las que se lleguen a ver: en un libro ilustrado
      // esa es la diferencia entre unas pocas y todas a la vez.
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
    }
  }

  function desactivarEnlaces(cuerpo) {
    for (const enlace of cuerpo.querySelectorAll('a[href]')) {
      const href = enlace.getAttribute('href') || '';
      // Los enlaces internos apuntan a archivos del ZIP que aquí no existen
      // como direcciones: se quedan como texto, no como un enlace roto.
      if (!/^https?:/i.test(href)) enlace.removeAttribute('href');
      else { enlace.setAttribute('target', '_blank'); enlace.setAttribute('rel', 'noopener'); }
    }
  }

  function podarEstilosEnLinea(raiz) {
    for (const nodo of raiz.querySelectorAll('[style]')) {
      const seguro = declaracionesSeguras(nodo.getAttribute('style') || '');
      if (seguro) nodo.setAttribute('style', seguro);
      else nodo.removeAttribute('style');
    }
  }

  /**
   * Un libro abierto: los capítulos en crudo más la maquinaria para servirlos
   * limpios y troceados según el lector los vaya pidiendo.
   *
   * @returns {{css: string, capitulos: number, bloques: (i:number)=>string[]}}
   */
  function comoLibro({ capitulos, css, imagenes, delZip }) {
    const porRuta = new Map();
    for (const imagen of imagenes || []) porRuta.set(imagen.ruta, imagen);

    // Las direcciones `blob:` se crean una sola vez por imagen y se sueltan al
    // cerrar la página; los bytes ya estaban en el almacén del navegador.
    const urls = new Map();
    const urlDeImagen = (ruta) => {
      if (!urls.has(ruta)) urls.set(ruta, urlDe(porRuta.get(ruta).blob));
      return urls.get(ruta);
    };

    return {
      css: cssSeguro(css),
      capitulos: capitulos.length,
      /** Los bloques del capítulo `indice`, cada uno con su `html` a la espera. */
      bloques(indice) {
        const capitulo = capitulos[indice];
        if (!capitulo) return [];
        const cuerpo = comoCuerpo(capitulo);
        if (!cuerpo) return [];
        // Las imágenes y los enlaces se arreglan sobre el capítulo entero,
        // porque son cuatro búsquedas y valen para todos sus bloques. Lo caro
        // —la limpieza— es lo único que se aplaza.
        //
        // Recolocar imágenes solo tiene sentido cuando salen de un ZIP y hay
        // que buscarlas por su ruta. Las de un DOCX vienen ya como `data:` y
        // las de un ODT como `blob:`: ahí no hay ruta que buscar, y pasarlas
        // por este molde las borraría a todas por no estar en el mapa.
        if (delZip) colocarImagenes(cuerpo, capitulo.carpeta || '', porRuta, urlDeImagen);
        desactivarEnlaces(cuerpo);
        return partir(cuerpo).map(comoBloque);
      },
    };
  }

  /* ------------------------------ despacho ------------------------------ */

  async function comoTexto(formato, buffer) {
    switch (formato) {
      case 'docx': return deDocx(buffer);
      case 'odt':  return deOdt(buffer);
      case 'rtf':  return deRtf(buffer);
      case 'md':   return deMarkdown(buffer);
      case 'html': return deHTML(buffer);
      case 'txt':  return deTexto(buffer);
      default: throw new Error(`No sé abrir el formato «${formato}».`);
    }
  }

  /**
   * Abre un libro y devuelve con qué paginarlo.
   * @param {(pct:number, texto:string)=>void} avisar  para ir contando el avance
   */
  async function abrir(formato, buffer, avisar = () => {}) {
    if (formato === 'epub') {
      const partes = await abrirEpub(buffer, avisar);
      return comoLibro({
        ...partes,
        delZip: true,
        capitulos: partes.capitulos.map((c) => ({ ...c, xml: true })),
      });
    }
    avisar(40, 'Dando formato al texto…');
    const crudo = await comoTexto(formato, buffer);
    // Un solo «capítulo»: el troceado lo parte igual, que un TXT de veinte
    // megas ahoga al navegador exactamente igual que un EPUB.
    return comoLibro({ capitulos: [{ crudo, carpeta: '' }], css: [], imagenes: [], delZip: false });
  }

  return { abrir, limpiar, escapar };
})();
