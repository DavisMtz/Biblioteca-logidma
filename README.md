# Biblioteca Logidma

Biblioteca virtual del equipo: los administradores suben documentos y cualquiera
los lee en el navegador, paginados, sin descargar nada.

**Producción:** https://biblioteca.logidma.com

## Qué hace

- **Formatos que abre:** PDF, EPUB, DOCX, ODT, RTF, TXT, HTML y Markdown.
- **Lector paginado.** El PDF se dibuja con PDF.js página por página; el resto se
  convierte a HTML en el navegador y se reparte en columnas del ancho de la hoja,
  así que «pasar de página» es pasar de página, no hacer scroll.
- **Marcador de lectura** por libro, con el tamaño de letra ajustable.
- **Panel `/admin`:** subir (arrastrando o eligiendo), portada automática desde la
  primera página del PDF, edición de datos, borradores y borrado.
- Tema claro y oscuro, y funciona igual en teléfono.

## Arquitectura

| Pieza | Dónde vive |
| --- | --- |
| Worker (API + servido) | `src/index.ts`, Hono sobre Cloudflare Workers |
| Interfaz | `public/` — HTML, CSS y JS sin compilar, servido como Static Assets |
| Archivos de los libros | R2, bucket `biblioteca-logidma` |
| Catálogo y marcadores | D1, base `biblioteca-logidma` (`migraciones/`) |
| Portadas | Cloudinary (cloud `srz5sh9l`, carpeta `biblioteca/portadas`) |

Decisiones que no se deducen mirando el código:

- **Todo el tráfico de archivos pasa por el Worker.** El endpoint S3 de R2
  (`*.r2.cloudflarestorage.com`) está bloqueado en la red de la oficina, así que
  no se usan URLs prefirmadas: `GET /archivo/:id` lee del binding y responde
  rangos (`206`), que es lo que PDF.js necesita para abrir un libro grande sin
  bajarlo entero.
- **Las subidas van por partes** (`/api/subir/iniciar` → `parte` → `completar`,
  10 MiB por parte). Un Worker no acepta cuerpos de más de 100 MB de una vez.
- **La portada no pasa por el Worker:** el navegador pide una firma
  (`/api/portada/firma`) y sube directo a Cloudinary. El `api_secret` no sale del
  servidor y el destino lo decide él, no el cliente.
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
