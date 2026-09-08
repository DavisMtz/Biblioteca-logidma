from pathlib import Path

js = Path('public/js/formatos.js')
s = js.read_text()

reemplazos = [
("""    'border-collapse', 'display', 'float', 'clear', 'width', 'max-width',
    'break-before', 'break-after', 'break-inside',
""", """    'border-collapse', 'display', 'float', 'clear', 'width', 'max-width',
    'break-before', 'break-after', 'break-inside', 'orphans', 'widows', 'overflow-wrap',
"""),
("""  const ABSOLUTA = /\\d\\s*(px|pt|pc|in|cm|mm|q)\\b/i;
  // Ni paréntesis ni llaves ni comillas: sin `url()`, `calc()` ni nada que
""", """  const ABSOLUTA = /\\d\\s*(px|pt|pc|in|cm|mm|q)\\b/i;
  const ABSOLUTAS = /(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))\\s*(px|pt|pc|in|cm|mm|q)\\b/gi;

  /* Los EPUB editoriales suelen expresar sangrías y espaciados en pt/px. Tirarlos
     por completo aplana el libro; conservarlos tal cual rompe el móvil. Se
     convierten a em y se limitan: se mantiene la proporción tipográfica sin
     permitir que una maqueta de papel se lleve media pantalla. Los anchos fijos
     siguen prohibidos más abajo. */
  function absolutasAEm(valor, propiedad) {
    const factores = { px: 1 / 16, pt: 1 / 12, pc: 1, in: 6, cm: 96 / 2.54 / 16, mm: 96 / 25.4 / 16, q: 96 / 101.6 / 16 };
    let minimo = -4, maximo = 4;
    if (propiedad === 'font-size') { minimo = 0.65; maximo = 2.4; }
    else if (propiedad === 'text-indent') { minimo = -3; maximo = 3; }
    else if (propiedad === 'letter-spacing') { minimo = -0.35; maximo = 0.35; }
    else if (propiedad === 'word-spacing') { minimo = -1; maximo = 1; }
    return valor.replace(ABSOLUTAS, (_todo, numero, unidad) => {
      const em = Math.max(minimo, Math.min(maximo, Number(numero) * factores[unidad.toLowerCase()]));
      return `${Math.round(em * 1000) / 1000}em`;
    });
  }
  // Ni paréntesis ni llaves ni comillas: sin `url()`, `calc()` ni nada que
"""),
("""    let prop = propiedad.trim().toLowerCase();
    let val = valor.replace(/!\\s*important/gi, '').trim();
    if (!prop || !val || val.length > 120 || VALOR_SUCIO.test(val)) return '';

    // Los saltos de página del libro se convierten en saltos de columna: aquí
""", """    let prop = propiedad.trim().toLowerCase();
    let val = valor.replace(/!\\s*important/gi, '').trim();
    if (!prop || !val || val.length > 120 || VALOR_SUCIO.test(val)) return '';
    if (/^-(?:epub|webkit|moz)-hyphens$/.test(prop)) prop = 'hyphens';
    if (prop === 'word-wrap') prop = 'overflow-wrap';

    // Los saltos de página del libro se convierten en saltos de columna: aquí
"""),
("""    // Medidas en píxeles o puntos: el libro las escribió para una pantalla que
    // no es esta, y no crecen con A+ ni encogen con A−.
    if (RELATIVA.has(prop) && ABSOLUTA.test(val)) return '';
    if (prop === 'display' && !DISPLAY.test(val)) return '';
""", """    // Los anchos fijos siguen fuera: una caja de 546pt no cabe en un teléfono.
    // Para tipografía y espaciado, en cambio, se conserva la intención editorial
    // convirtiendo las medidas absolutas a em y limitándolas.
    if (RELATIVA.has(prop) && ABSOLUTA.test(val)) {
      if (prop === 'width' || prop === 'max-width') return '';
      val = absolutasAEm(val, prop);
    }
    if (prop === 'display' && !DISPLAY.test(val)) return '';
"""),
("""      const url = urlDeImagen(datos.ruta);
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
""", """      const url = urlDeImagen(datos.ruta);
      const esSvg = img.tagName.toLowerCase() === 'image';
      if (esSvg) {
        // En SVG, width/height son coordenadas del viewBox, NO el tamaño real del
        // JPG. Sustituir esas coordenadas por los píxeles intrínsecos deforma o
        // recorta portadas. Se conserva lo que escribió el EPUB.
        img.setAttribute('href', url);
        const svg = img.closest && img.closest('svg');
        if (svg && svg.querySelectorAll('image').length === 1 && !svg.querySelector('text, foreignObject')) {
          svg.classList.add('epub__lamina');
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        }
      } else {
        img.setAttribute('src', url);
        // En HTML sí son dimensiones intrínsecas: reservarlas evita que cambie el
        // reparto de páginas cuando la imagen termina de descodificarse.
        if (datos.ancho && datos.alto) {
          img.setAttribute('width', String(datos.ancho));
          img.setAttribute('height', String(datos.alto));
        }
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
      }
      img.removeAttribute('xlink:href');
""")]

for viejo, nuevo in reemplazos:
    if s.count(viejo) != 1:
        raise SystemExit(f'No se encontró exactamente una vez el bloque esperado: {viejo[:80]!r}')
    s = s.replace(viejo, nuevo)
js.write_text(s)

css = Path('public/css/lector.css')
c = css.read_text()
marker = ".hoja__flujo img {\n  max-width: 100%; height: auto; display: block; margin: 1em auto; break-inside: avoid;\n"
if c.count(marker) != 1:
    raise SystemExit('No se encontró el punto de inserción de estilos para imágenes.')
extra = """/* Las portadas/laminas EPUB hechas como SVG son páginas visuales completas.
   Se encajan por su viewBox y nunca se estiran a la forma de la pantalla. */
.hoja__flujo svg.epub__lamina {
  display: block;
  width: 100%; max-width: 100%; height: auto;
  max-height: calc(var(--alto-hoja, 62vh) * 0.86);
  margin: 0 auto 1em;
  break-inside: avoid;
  overflow: visible;
}
.hoja__flujo svg.epub__lamina > image { width: 100%; height: 100%; }

"""
c = c.replace(marker, extra + marker)
css.write_text(c)
print('Parche aplicado.')
