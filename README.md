# Biblioteca Logidma

Biblioteca virtual del equipo: donde el conocimiento es compartido. Los
administradores suben documentos y cualquiera los lee en el navegador,
paginados, sin descargar nada.

**Producción:** https://biblioteca.logidma.com

## Qué hace

- **Formatos que abre:** PDF, EPUB, DOCX, ODT, RTF, TXT, HTML y Markdown.
- **Lector paginado.** El PDF se dibuja con PDF.js página por página; el resto se
  convierte a HTML en el navegador y se reparte en columnas del ancho de la hoja,
  así que «pasar de página» es pasar de página, no hacer scroll. El libro va
  troceado en bloques y solo uno vive en la página a la vez.
- **Los EPUB conservan su tipografía:** sangrías, centrados, versalitas, versos y
  saltos de capítulo salen como los dejó quien maquetó el libro.
- **Marcador de lectura** por libro, con el tamaño de letra ajustable.
- **Panel `/admin`:** subir (arrastrando o eligiendo), portada automática desde la
  primera página del PDF, edición de datos, borradores y borrado.
- Tema claro y oscuro, y funciona igual en teléfono.

## Arquitectura

| Pieza | Dónde vive |
| --- | --- |
| Worker (API + servido) | `src/index.ts`, Hono sobre Cloudflare Workers |
| Interfaz | `public/` — HTML, CSS y JS sin compilar, servido como Static Assets |
| Motor de formatos | `public/js/formatos.js`; el EPUB se descomprime en `public/js/epub-worker.js` con la lógica de `public/js/epub-zip.js` |
| Archivos de los libros | R2, bucket `biblioteca-logidma` |
| Catálogo y marcadores | D1, base `biblioteca-logidma` (`migraciones/`) |
| Portadas | Cloudinary (cloud `srz5sh9l`, carpeta `biblioteca/portadas`) |
| Instalación como app | `public/manifest.webmanifest` + `public/sw.js` |

Decisiones que no se deducen mirando el código:

- **Los archivos viven en R2** (10 GB gratis al mes, sin coste de descarga).
  Cada libro se sube por partes de 5 MiB —R2 exige que todas midan lo mismo
  salvo la última, y al menos 5 MiB— y `GET /archivo/:id` deja que el propio
  bucket resuelva los rangos (`206`), que es lo que PDF.js necesita para abrir un
  libro grande sin bajarlo entero.
- **El tamaño que se guarda en el catálogo lo cuenta el servidor** sumando las
  partes que recibe, no lo declara el navegador.

- **El libro que refluye se lee por bloques, nunca entero.** Para saber cuántas
  páginas ocupa un texto, el navegador tiene que maquetarlo en columnas, y eso
  cuesta memoria y tiempo en proporción a lo que haya dentro. Con el libro
  completo dentro son cientos de columnas vivas a la vez: en el escritorio se
  nota, en un teléfono el navegador se queda sin memoria y mata la pestaña. Por
  eso `formatos.js` trocea cada capítulo en bloques de unos 60 000 caracteres
  —cortando donde el libro ya hacía una pausa— y el lector monta uno solo. El
  resto se miden en una caja gemela invisible (`#medidor`), entre fotograma y
  fotograma, así que el total se afina mientras ya se está leyendo; hasta que
  cuaja, la cuenta se enseña con una tilde (`~1709`). Medido con un libro de
  millón y medio de caracteres en un teléfono simulado: abrir pasó de 27 s a 1 s,
  y el bloqueo más largo del hilo principal, de 10,9 s a 0,2 s.

- **Descomprimir el EPUB va en un hilo aparte.** Es el tramo más largo con
  diferencia y, hecho en la página, deja la pantalla muerta todo ese rato.
  `epub-zip.js` no toca el DOM justamente para poder cargarse en el worker; la
  página lo carga también como respaldo por si el worker no arranca. Las
  imágenes cruzan como `Blob` (no se copian bytes, se pasa un asa) y sus medidas
  se leen de la cabecera del archivo: con el ancho y el alto en el marcado, el
  hueco de la ilustración existe antes de descodificarla y el reparto en páginas
  no se descoloca al llegar.

- **La limpieza también se paga a plazos.** DOMPurify recorre nodo a nodo y
  atributo a atributo; hacerlo del libro entero era el otro parón gordo. Cada
  bloque se limpia la primera vez que se monta o se mide, no antes.

- **Los estilos del EPUB se filtran, no se copian.** Sin ellos el libro se lee
  como un chorro de párrafos iguales; tal cual, rompen el lector (posiciones
  fijas, columnas propias, alturas en píxeles) o se pelean con los temas. Así que
  pasa una lista blanca de propiedades tipográficas y cada selector queda
  encerrado bajo `.hoja__flujo`. Quedan fuera a propósito `color` y `background`
  (mandan los temas claro/sepia/oscuro), `font-family` (manda la letra del
  lector), `line-height` (el lector calcula la altura de la página para que quepa
  un número entero de renglones, y si cada párrafo trae el suyo la cuenta no
  sale), `height`, todo lo que venga en píxeles o puntos —no crece con A+ ni
  encoge con A−— y cualquier valor con paréntesis, que deja el filtro en texto
  plano y auditable de un vistazo. `page-break-before` sí pasa, convertido en
  `break-before: column`: aquí una columna ES una página.

- **El archivo de un libro se guarda un año en el navegador** (`immutable`). El
  id se acuña al subirlo y cambiar el documento obliga a subir otro libro, así
  que no hay nada que revalidar; reabrir un EPUB deja de costar la descarga
  entera. El `etag` cubre las recargas a mano, que se saltan la caché.
- Hasta el 07/09/2026 los archivos vivían en Workers KV, troceados a mano,
  porque R2 pide método de pago para activarse. Con R2 ya activo se mudaron los
  7 libros que había y KV salió del proyecto: R2 resuelve rangos por su cuenta,
  no tiene el tope de 25 MiB por valor y da diez veces más espacio.
- **La portada no pasa por el Worker:** el navegador pide una firma
  (`/api/portada/firma`) y sube directo a Cloudinary. El `api_secret` no sale del
  servidor y el destino lo decide él, no el cliente.
- **El service worker pone la red por delante.** La caché es respaldo para
  cuando no hay señal, nunca la fuente de la verdad: así un despliegue nuevo se
  ve al instante en vez de quedarse una versión vieja pegada. `/api/*` y
  `/archivo/*` ni siquiera pasan por él —guardar el catálogo lo deja mintiendo
  después de cada subida, y los documentos viajan por peticiones con rango, que
  la Cache API no sabe responder—. `public/vendor/` va al revés, de caché y
  refrescando por detrás, porque son librerías fijas de megas. Al cambiar esa
  política hay que subir `VERSION` en `public/sw.js`: en `activate` se borran
  las cachés que no lleven el nombre de la versión en curso.

- **Los iconos PNG del manifiesto están generados, no dibujados a mano.** Salen
  de `public/img/icono.svg` con Chrome sin ventana
  (`--headless --window-size=512,512 --screenshot`). Un manifiesto solo con SVG
  no pasa la comprobación de Chrome y el aviso de instalar no llega a aparecer.

- **Las librerías del lector se sirven desde el propio dominio** (`public/vendor/`,
  generado por `npm run vendor`). Nada depende de un CDN externo.
- **El dominio propio no se declara en `wrangler.jsonc`.** Se ató una vez con
  `PUT /accounts/{id}/workers/domains`; con un bloque `routes`, cada despliegue
  sube el código y luego falla con un error de autenticación que parece que no
  se desplegó.

## Trabajar en local

```bash
npm install
npm run vendor                  # copia PDF.js, mammoth, JSZip… a public/vendor
npm run migrar:local            # crea las tablas en la D1 local
npx wrangler dev                # http://127.0.0.1:8787
```

Hace falta un `.dev.vars` (ignorado por git) con:

```
ADMIN_PASSWORD="…"
SESSION_SECRET="…"
CLOUDINARY_API_SECRET="…"
```

## Si se olvida la contraseña

No hay correo de recuperación: se borra el hash y vuelve a valer la de arranque
(la de `secrets.json`). De paso sube la generación, así cae cualquier sesión que
siguiera abierta:

```bash
npx wrangler d1 execute biblioteca-logidma --remote --command   "DELETE FROM ajustes WHERE clave='clave_admin';    UPDATE ajustes SET valor = CAST(valor AS INTEGER) + 1 WHERE clave='generacion';"
```

## Desplegar

Cada `push` a `main` dispara `.github/workflows/deploy.yml`, que aplica las
migraciones remotas y despliega. A mano:

```bash
npm run migrar
npm run deploy
```

Los secretos de producción se cargan con `npx wrangler secret bulk secrets.json`
(archivo local, ignorado por git; `wrangler secret put` por tubería en PowerShell
le pega un salto de línea al secreto).
