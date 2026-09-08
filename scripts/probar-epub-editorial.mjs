import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import createDOMPurify from 'dompurify';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'dangerously',
  url: 'https://biblioteca.test/',
});
const w = dom.window;
w.JSZip = JSZip;
w.DOMPurify = createDOMPurify(w);
w.URL.createObjectURL = () => 'blob:https://biblioteca.test/prueba';
w.URL.revokeObjectURL = () => {};
w.Worker = undefined;

w.eval(fs.readFileSync('public/js/epub-zip.js', 'utf8'));
w.eval(fs.readFileSync('public/js/formatos.js', 'utf8') + '\nwindow.__Formatos = Formatos;');

const b = fs.readFileSync(process.argv[2] || '/tmp/republica.epub');
const buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const libro = await w.__Formatos.abrir('epub', buffer, () => {});

if (!/text-indent:2em/.test(libro.css)) {
  throw new Error('No se conservó la sangría editorial 24pt como 2em.');
}
if (/text-indent:24pt/.test(libro.css)) {
  throw new Error('Quedó una medida absoluta sin normalizar.');
}

const html = libro.bloques(0)[0].html;
const doc = new JSDOM(`<body>${html}</body>`).window.document;
const svg = doc.querySelector('svg.epub__lamina');
const image = svg && svg.querySelector('image');
if (!svg || !image) throw new Error('No se detectó la portada SVG como lámina.');
if (svg.getAttribute('preserveAspectRatio') !== 'xMidYMid meet') {
  throw new Error('La portada aún permite deformación.');
}
if (image.getAttribute('width') !== '566' || image.getAttribute('height') !== '734') {
  throw new Error('Se alteraron las coordenadas originales de la portada SVG.');
}
if (!String(image.getAttribute('href') || '').startsWith('blob:')) {
  throw new Error('La imagen de portada no quedó enlazada al recurso interno.');
}

console.log('OK: portada SVG conservada y CSS editorial normalizado.');
