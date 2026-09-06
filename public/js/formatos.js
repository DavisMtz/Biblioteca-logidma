/* Convierte cada formato de libro a HTML legible.
   Todo ocurre en el navegador: el Worker solo entrega los bytes. */

const Formatos = (() => {

  const blobsVivos = [];
  function urlDe(blob) {
    const url = URL.createObjectURL(blob);
    blobsVivos.push(url);
    return url;
  }
  addEventListener('pagehide', () => blobsVivos.forEach((u) => URL.revokeObjectURL(u)));

  function limpiar(html) {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
      FORBID_ATTR: ['srcset'],
      // Las imágenes de EPUB/ODT salen del propio ZIP como blob:, y las de DOCX como data:.
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|data|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
  }

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
    const texto = new TextDecoder('utf-8').decode(buffer);
    return limpiar(marked.parse(texto, { breaks: false, gfm: true }));
  }

  /* ------------------------------ HTML ------------------------------ */

  function deHTML(buffer) {
    let texto = new TextDecoder('utf-8').decode(buffer);
    const doc = new DOMParser().parseFromString(texto, 'text/html');
    return limpiar(doc.body ? doc.body.innerHTML : texto);
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
    return limpiar(resultado.value);
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
      } else if (etiqueta === 'frame' || etiqueta === 'image') {
        salida += textoODT(hijo, estilos);
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
    return limpiar(partes.join(''));
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

    function abrir() {
      let etiquetas = '';
      if (estado.negrita) etiquetas += '<strong>';
      if (estado.cursiva) etiquetas += '<em>';
      if (estado.subrayado) etiquetas += '<u>';
      return etiquetas;
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
          case 'tab': agregar(' '); break;
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
    return limpiar(parrafos.join('') || '<p>El archivo RTF no contiene texto legible.</p>');
  }

  /* ------------------------------ EPUB ------------------------------ */

  async function deEpub(buffer) {
    const zip = await JSZip.loadAsync(buffer);

    const contenedor = await zip.file('META-INF/container.xml').async('string');
    const rutaOpf = new DOMParser().parseFromString(contenedor, 'application/xml')
      .getElementsByTagNameNS('*', 'rootfile')[0].getAttribute('full-path');
    const base = rutaOpf.includes('/') ? rutaOpf.slice(0, rutaOpf.lastIndexOf('/') + 1) : '';

    const opf = new DOMParser().parseFromString(await zip.file(rutaOpf).async('string'), 'application/xml');

    const manifiesto = new Map();
    for (const item of opf.getElementsByTagNameNS('*', 'item')) {
      manifiesto.set(item.getAttribute('id'), {
        href: item.getAttribute('href'),
        tipo: item.getAttribute('media-type') || '',
      });
    }

    const orden = [...opf.getElementsByTagNameNS('*', 'itemref')]
      .map((ref) => manifiesto.get(ref.getAttribute('idref')))
      .filter((item) => item && /xhtml|html/.test(item.tipo));

    // Todas las imágenes del EPUB, indexadas por su ruta normalizada.
    const imagenes = new Map();
    for (const [id, item] of manifiesto) {
      if (!/^image\//.test(item.tipo)) continue;
      const ruta = normalizar(base + item.href);
      const archivo = zip.file(ruta);
      if (archivo) imagenes.set(ruta, urlDe(await archivo.async('blob')));
    }

    const capitulos = [];
    for (const item of orden) {
      const ruta = normalizar(base + item.href);
      const archivo = zip.file(ruta);
      if (!archivo) continue;
      const doc = new DOMParser().parseFromString(await archivo.async('string'), 'application/xhtml+xml');
      const cuerpo = doc.getElementsByTagName('body')[0];
      if (!cuerpo) continue;
      const carpeta = ruta.includes('/') ? ruta.slice(0, ruta.lastIndexOf('/') + 1) : '';
      for (const img of cuerpo.querySelectorAll('img, image')) {
        const src = img.getAttribute('src') || img.getAttribute('xlink:href') || '';
        const url = imagenes.get(normalizar(carpeta + src));
        if (url) { img.setAttribute('src', url); img.removeAttribute('xlink:href'); }
        else img.remove();
      }
      for (const enlace of cuerpo.querySelectorAll('a[href]')) {
        const href = enlace.getAttribute('href');
        if (!/^https?:/i.test(href)) enlace.removeAttribute('href'); // enlaces internos: sin destino real
      }
      capitulos.push(`<section class="capitulo">${cuerpo.innerHTML}</section>`);
    }

    return limpiar(capitulos.join('') || '<p>El EPUB no trae capítulos legibles.</p>');
  }

  function normalizar(ruta) {
    const partes = [];
    for (const parte of ruta.split('/')) {
      if (parte === '.' || parte === '') continue;
      if (parte === '..') partes.pop();
      else partes.push(parte);
    }
    return partes.join('/');
  }

  /* ------------------------------ despacho ------------------------------ */

  async function aHtml(formato, buffer) {
    switch (formato) {
      case 'docx': return deDocx(buffer);
      case 'odt':  return deOdt(buffer);
      case 'rtf':  return deRtf(buffer);
      case 'epub': return deEpub(buffer);
      case 'md':   return deMarkdown(buffer);
      case 'html': return deHTML(buffer);
      case 'txt':  return deTexto(buffer);
      default: throw new Error(`No sé abrir el formato «${formato}».`);
    }
  }

  return { aHtml, limpiar };
})();
