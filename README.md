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
| Archivos de los libros | Workers KV (`biblioteca-archivos`) hasta 900 MB, y R2 (`biblioteca-logidma`) a partir de ahí |
| Catálogo y marcadores | D1, base `biblioteca-logidma` (`migraciones/`) |
| Portadas | Cloudinary (cloud `srz5sh9l`, carpeta `biblioteca/portadas`) |

Decisiones que no se deducen mirando el código:

- **Dos almacenes, los dos gratuitos, con desbordamiento automático.** Un libro
  nuevo va a **KV** mientras la suma de lo guardado ahí más el archivo no pase de
  **900 MB**; en cuanto lo pasa, va a **R2** (10 GB). Lo decide `elegirAlmacen()`
  con un `SUM(tamano)` sobre D1, y queda anotado en `libros.almacen`, que es lo
  que luego elige el camino al servir y al borrar. Los libros ya guardados no se
  mueven: cada uno se sirve desde donde esté.
- **El tamaño que manda el navegador solo sirve para elegir almacén.** El que se
  guarda en el catálogo lo cuenta el servidor sumando las partes que recibe, así
  que un cliente no puede falsearlo.
- Topes de cada uno: KV, 1 GB por namespace, 25 MiB por valor y 1000 escrituras
  al día; R2, 10 GB, 1 M de escrituras y 10 M de lecturas al mes, sin coste de
  descarga. Las partes de 5 MiB valen para los dos (R2 exige que todas midan lo
  mismo salvo la última, y al menos 5 MiB).
- **Cada libro se guarda troceado** en claves `libro:<id>:<n>` de 5 MiB (el tope
  de KV por valor es 25 MiB). Como todas las partes miden lo mismo salvo la
  última, `GET /archivo/:id` calcula qué partes tocar y responde rangos (`206`),
  que es lo que PDF.js necesita para abrir un libro grande sin bajarlo entero.
  El tamaño del archivo lo calcula el servidor, no lo declara el navegador.
- **KV es de consistencia eventual**: al leer una parte se reintenta tres veces
  antes de darla por perdida, porque una recién escrita puede tardar en verse.
- **Todo el tráfico de archivos pasa por el Worker.** El endpoint S3 de R2
  (`*.r2.cloudflarestorage.com`) está además bloqueado en la red de la oficina,
  así que las URLs prefirmadas tampoco eran una opción.
- **Las subidas van por partes** (`/api/subir/iniciar` → `parte` → `completar`).
  Un Worker no acepta cuerpos de más de 100 MB de una vez.
- **La contraseña de administración no vive en el secreto del Worker**, porque un
  Worker no puede reescribir sus propios secretos. Vive en D1 como hash PBKDF2
  (SHA-256, 100 000 iteraciones —el techo medido en Workers— y sal de 16 bytes).
  `ADMIN_PASSWORD` es solo la **contraseña de arranque**: vale mientras no exista
  la fila `ajustes.clave_admin` y deja de servir en cuanto se cambia una vez, para
  que no quede una puerta trasera atada a un valor que anda en varios sitios.
- **Al cambiar la contraseña caen todas las sesiones.** La cookie lleva dentro un
  número de generación que sube con cada cambio; las cookies viejas dejan de
  validar sin necesidad de guardar una lista de sesiones.
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
