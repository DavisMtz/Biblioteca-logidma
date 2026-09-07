// Copia las librerías del lector desde node_modules a public/vendor.
// Se sirven desde el propio dominio: nada depende de un CDN externo
// (la red de la oficina bloquea hosts arbitrarios y ahí también se lee).
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destino = resolve(raiz, 'public/vendor');

const archivos = [
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  ['node_modules/pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['node_modules/mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js'],
  ['node_modules/jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['node_modules/marked/marked.min.js', 'marked.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
  ['node_modules/gsap/dist/gsap.min.js', 'gsap.min.js'],
];

await rm(destino, { recursive: true, force: true });
await mkdir(destino, { recursive: true });

for (const [origen, salida] of archivos) {
  const rutaOrigen = resolve(raiz, origen);
  try {
    await access(rutaOrigen);
  } catch {
    console.error(`FALTA: ${origen} — ¿corriste npm install?`);
    process.exit(1);
  }
  const rutaSalida = resolve(destino, salida);
  await mkdir(dirname(rutaSalida), { recursive: true });
  await cp(rutaOrigen, rutaSalida, { recursive: true });
  console.log(`vendor/${salida}`);
}
console.log('Librerías copiadas.');
