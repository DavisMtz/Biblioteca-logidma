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

- **Los archivos viven en R2** (10 GB gratis al mes, sin coste de descarga).
  Cada libro se sube por partes de 5 MiB —R2 exige que todas midan lo mismo
  salvo la última, y al menos 5 MiB— y `GET /archivo/:id` deja que el propio
  bucket resuelva los rangos (`206`), que es lo que PDF.js necesita para abrir un
  libro grande sin bajarlo entero.
- **El tamaño que se guarda en el catálogo lo cuenta el servidor** sumando las
  partes que recibe, no lo declara el navegador.
- Hasta el 07/09/2026 los archivos vivían en Workers KV, troceados a mano,
  porque R2 pide método de pago para activarse. Con R2 ya activo se mudaron los
  7 libros que había y KV salió del proyecto: R2 resuelve rangos por su cuenta,
  no tiene el tope de 25 MiB por valor y da diez veces más espacio.
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
