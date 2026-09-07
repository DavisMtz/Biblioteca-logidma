/* Saca de un EPUB —que por dentro es un ZIP— sus capítulos, sus estilos y sus
   imágenes.

   Este archivo se carga en dos sitios: dentro del worker que hace ese trabajo
   fuera del hilo principal, y en la propia página como respaldo por si el
   worker no llega a arrancar. Por eso no toca el DOM ni da por hecho nada del
   entorno: solo necesita JSZip y devuelve datos en crudo. Interpretarlos y
   limpiarlos es cosa de `formatos.js`, que sí tiene DOM con qué hacerlo. */

(function (raiz) {
  'use strict';

  /* ---------------- XML sin DOM ---------------- */

  const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function desescapar(texto) {
    if (!texto.includes('&')) return texto;
    return texto.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (todo, cuerpo) => {
      if (cuerpo[0] === '#') {
        const n = cuerpo[1] === 'x' || cuerpo[1] === 'X'
          ? parseInt(cuerpo.slice(2), 16)
          : parseInt(cuerpo.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : todo;
      }
      return ENTIDADES[cuerpo.toLowerCase()] ?? todo;
    });
  }

  /** Atributos de una etiqueta, sin montar un DOM que aquí puede no haber. */
  function atributos(texto) {
    const mapa = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(texto))) {
      // El prefijo de espacio de nombres da igual: `opf:role` y `role` son lo mismo aquí.
      mapa[m[1].replace(/^[\w.-]+:/, '').toLowerCase()] = desescapar(m[2] ?? m[3] ?? '');
    }
    return mapa;
  }

  /** Los atributos de cada `<nombre …>` del XML, lleve prefijo o no. */
  function etiquetas(xml, nombre) {
    const re = new RegExp(`<(?:[\\w.-]+:)?${nombre}\\b([^>]*)>`, 'gi');
    const salida = [];
    let m;
    while ((m = re.exec(xml))) salida.push(atributos(m[1] || ''));
    return salida;
  }

  /* ---------------- rutas dentro del ZIP ---------------- */

  function normalizar(ruta) {
    const partes = [];
    for (const parte of String(ruta).split('/')) {
      if (parte === '.' || parte === '') continue;
      if (parte === '..') partes.pop();
      else partes.push(parte);
    }
    return partes.join('/');
  }

  const carpetaDe = (ruta) => (ruta.includes('/') ? ruta.slice(0, ruta.lastIndexOf('/') + 1) : '');

  /** Los href del catálogo vienen escapados como URL: `Text/cap%201.xhtml` es un archivo real. */
  function comoRuta(href) {
    const limpio = String(href).split('#')[0];
    try { return decodeURIComponent(limpio); } catch { return limpio; }
  }

  /** Busca sin distinguir mayúsculas: hay EPUB con el índice y el ZIP descuadrados. */
  function archivo(zip, ruta) {
    const directo = zip.file(ruta);
    if (directo) return directo;
    const bajo = ruta.toLowerCase();
    for (const nombre of Object.keys(zip.files)) {
      if (!zip.files[nombre].dir && nombre.toLowerCase() === bajo) return zip.files[nombre];
    }
    return null;
  }

  /* ---------------- medidas de las imágenes ---------------- */

  const TIPOS = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  };

  /* Las medidas salen de la cabecera del archivo, sin descodificar la imagen.
     Con ellas se le reserva el hueco a la ilustración antes de pintarla: sin
     eso el texto se recoloca según van llegando las imágenes y el reparto en
     páginas —calculado antes— deja de cuadrar. */
  function medidasDeImagen(b) {
    const u16 = (i, le) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
    const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

    // PNG: la cabecera IHDR está siempre en el mismo sitio.
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { ancho: u32(16), alto: u32(20) };
    }
    // GIF
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return { ancho: u16(6, true), alto: u16(8, true) };
    }
    // WebP: tres variantes dentro del mismo envoltorio RIFF, cada una con la
    // medida guardada en otro sitio.
    if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const marca = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (marca === 'VP8X') {
        return { ancho: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
                 alto: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
      }
      if (marca === 'VP8 ') return { ancho: u16(26, true) & 0x3fff, alto: u16(28, true) & 0x3fff };
      if (marca === 'VP8L') {
        const n = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { ancho: (n & 0x3fff) + 1, alto: ((n >>> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG: hay que recorrer los marcadores hasta dar con el de inicio de trama.
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marcador = b[i + 1];
        if (marcador === 0xff) { i++; continue; }                       // relleno
        if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd8)) { i += 2; continue; }
        if (marcador === 0xda || marcador === 0xd9) break;              // aquí empieza la imagen
        const largo = u16(i + 2, false);
        if (largo < 2) break;
        // SOF0…SOF15, quitando los marcadores de tablas que caen dentro del rango.
        if (marcador >= 0xc0 && marcador <= 0xcf
            && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
          return { alto: u16(i + 5, false), ancho: u16(i + 7, false) };
        }
        i += 2 + largo;
      }
    }
    return null;
  }

  /** El SVG lleva sus medidas escritas: basta con leerle la etiqueta de apertura. */
  function medidasDeSvg(texto) {
    const abre = /<svg\b([^>]*)>/i.exec(texto.slice(0, 4000));
    if (!abre) return null;
    const attr = atributos(abre[1]);
    const numero = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    const ancho = numero(attr.width);
    const alto = numero(attr.height);
    if (ancho && alto) return { ancho, alto };
    const caja = String(attr.viewbox || '').trim().split(/[\s,]+/).map(Number);
    if (caja.length === 4 && caja[2] > 0 && caja[3] > 0) return { ancho: caja[2], alto: caja[3] };
    return null;
  }

  const sensata = (m) =>
    (m && m.ancho > 0 && m.alto > 0 && m.ancho < 40000 && m.alto < 40000 ? m : null);

  /* ---------------- apertura ---------------- */

  const TOPE_CSS = 400000;   // más allá de esto una hoja de estilos ya no es tipografía

  /**
   * @param {ArrayBuffer} buffer   el EPUB entero
   * @param {(pct:number, texto:string)=>void} avisar   para ir contando el avance
   */
  async function abrir(buffer, avisar = () => {}) {
    const zip = await JSZip.loadAsync(buffer);
    avisar(6, 'Leyendo el índice del libro…');

    const contenedor = archivo(zip, 'META-INF/container.xml');
    let rutaOpf = contenedor
      ? (etiquetas(await contenedor.async('string'), 'rootfile')[0] || {})['full-path']
      : '';
    // Sin contenedor válido el catálogo se busca a mano: un EPUB mal empaquetado
    // se sigue pudiendo leer, y eso vale más que un mensaje de error.
    if (!rutaOpf) rutaOpf = Object.keys(zip.files).find((n) => /\.opf$/i.test(n)) || '';
    const catalogo = rutaOpf ? archivo(zip, normalizar(comoRuta(rutaOpf))) : null;
    if (!catalogo) throw new Error('El EPUB no trae catálogo (.opf); puede estar dañado.');

    const opf = await catalogo.async('string');
    const base = carpetaDe(normalizar(comoRuta(rutaOpf)));

    const manifiesto = new Map();
    for (const attr of etiquetas(opf, 'item')) {
      if (!attr.id || !attr.href) continue;
      manifiesto.set(attr.id, {
        ruta: normalizar(base + comoRuta(attr.href)),
        tipo: (attr['media-type'] || '').toLowerCase(),
      });
    }

    const esTexto = (it) => /html/.test(it.tipo) || (!it.tipo && /\.x?html?$/i.test(it.ruta));
    let orden = etiquetas(opf, 'itemref')
      .map((ref) => manifiesto.get(ref.idref))
      .filter((it) => it && esTexto(it));
    // Sin lomo utilizable se leen todos los documentos del manifiesto, en su orden.
    if (!orden.length) orden = [...manifiesto.values()].filter(esTexto);
    if (!orden.length) throw new Error('El EPUB no trae capítulos legibles.');

    /* Estilos del libro, en crudo. Filtrarlos exige decidir qué propiedad es
       tipografía y cuál rompería el lector, y eso se hace en la página. */
    avisar(18, 'Recogiendo los estilos…');
    const css = [];
    let pesoCss = 0;
    for (const item of manifiesto.values()) {
      if (item.tipo !== 'text/css' && !/\.css$/i.test(item.ruta)) continue;
      if (pesoCss > TOPE_CSS) break;
      const entrada = archivo(zip, item.ruta);
      if (!entrada) continue;
      const texto = await entrada.async('string');
      pesoCss += texto.length;
      css.push(texto);
    }

    /* Imágenes. Viajan como Blob: al cruzar del worker a la página no se copian
       los bytes, se pasa un asa al almacén del navegador, y solo se descodifican
       las que de verdad lleguen a verse. */
    avisar(24, 'Sacando las ilustraciones…');
    const imagenes = [];
    const deImagen = [...manifiesto.values()].filter(
      (it) => /^image\//.test(it.tipo) || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(it.ruta),
    );
    for (let i = 0; i < deImagen.length; i++) {
      const item = deImagen[i];
      const entrada = archivo(zip, item.ruta);
      if (!entrada) continue;
      const extension = ((/\.([a-z0-9]+)$/i.exec(item.ruta) || [])[1] || '').toLowerCase();
      const tipo = item.tipo || TIPOS[extension] || 'application/octet-stream';
      const bytes = new Uint8Array(await entrada.async('arraybuffer'));
      const medidas = sensata(
        tipo === 'image/svg+xml'
          ? medidasDeSvg(new TextDecoder().decode(bytes.subarray(0, 4000)))
          : medidasDeImagen(bytes),
      );
      imagenes.push({
        ruta: item.ruta,
        blob: new Blob([bytes], { type: tipo }),
        ancho: medidas ? medidas.ancho : 0,
        alto: medidas ? medidas.alto : 0,
      });
      if (deImagen.length > 8 && i % 8 === 0) {
        avisar(24 + (i / deImagen.length) * 26,
          `Sacando las ilustraciones… ${i + 1}/${deImagen.length}`);
      }
    }

    avisar(52, 'Leyendo los capítulos…');
    const capitulos = [];
    for (let i = 0; i < orden.length; i++) {
      const entrada = archivo(zip, orden[i].ruta);
      if (!entrada) continue;
      capitulos.push({
        ruta: orden[i].ruta,
        carpeta: carpetaDe(orden[i].ruta),
        crudo: await entrada.async('string'),
      });
      if (orden.length > 8 && i % 8 === 0) {
        avisar(52 + (i / orden.length) * 44, `Leyendo los capítulos… ${i + 1}/${orden.length}`);
      }
    }
    if (!capitulos.length) throw new Error('El EPUB no trae capítulos legibles.');

    return { capitulos, css, imagenes };
  }

  raiz.EpubZip = { abrir, normalizar, carpetaDe, comoRuta };
})(typeof self !== 'undefined' ? self : globalThis);
