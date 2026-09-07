/* Service worker de la Biblioteca.

   Regla de oro: la red manda. La caché es una red de seguridad para cuando no
   hay conexión, nunca la fuente de la verdad; así nadie se queda leyendo una
   versión vieja del sitio después de un despliegue.

   Lo que NUNCA pasa por aquí:
     /api/*      — catálogo y sesión; guardarlos deja el catálogo mentiroso.
     /archivo/*  — los documentos van por peticiones con rango (206) y pesan
                   decenas de megas; la Cache API no sabe responder rangos. */

const VERSION = 'v1';
const CACHE = `biblioteca-${VERSION}`;

/* El esqueleto: lo justo para que la biblioteca abra sin conexión. */
const ESQUELETO = [
  '/',
  '/leer',
  '/css/estilo.css',
  '/css/catalogo.css',
  '/css/lector.css',
  '/js/comun.js',
  '/js/catalogo.js',
  '/js/pwa.js',
  '/img/icono.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Uno a uno: si un archivo falla, no tira abajo la instalación entera.
    await Promise.all(ESQUELETO.map((ruta) => cache.add(ruta).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(nombres.map((n) => (n !== CACHE ? caches.delete(n) : null)));
    await self.clients.claim();
  })());
});

const esVendor = (ruta) => ruta.startsWith('/vendor/');
const seSalta = (ruta) => ruta.startsWith('/api/') || ruta.startsWith('/archivo/');

/* Librerías: se sirven de caché al instante y se refrescan por detrás, para que
   una versión nueva entre sola en la siguiente visita sin frenar esta. */
async function deCacheYRefrescar(peticion) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(peticion);
  const red = fetch(peticion)
    .then((resp) => { if (resp.ok) cache.put(peticion, resp.clone()); return resp; })
    .catch(() => null);
  return guardada || (await red) || Response.error();
}

/* Todo lo demás: red primero, caché solo si la red falla. */
async function deRedYRespaldo(peticion) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await fetch(peticion);
    if (resp.ok && peticion.method === 'GET') cache.put(peticion, resp.clone());
    return resp;
  } catch (error) {
    const guardada = await cache.match(peticion);
    if (guardada) return guardada;
    // Sin conexión y sin copia: si el usuario pedía una página, se le da la portada.
    if (peticion.mode === 'navigate') {
      const portada = await cache.match('/');
      if (portada) return portada;
    }
    throw error;
  }
}

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;

  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;
  if (seSalta(url.pathname)) return;

  evento.respondWith(esVendor(url.pathname) ? deCacheYRefrescar(peticion) : deRedYRespaldo(peticion));
});
