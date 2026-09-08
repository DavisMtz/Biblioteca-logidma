#!/usr/bin/env bash
set -euo pipefail

: "${BOOK_ID:?}" "${TITLE:?}" "${AUTHOR:?}" "${SOURCE_URL:?}" "${COVER_URL:?}" "${CATEGORY:?}" "${DESCRIPTION:?}"
YEAR_SQL="${YEAR:-NULL}"
EPUB="/tmp/${BOOK_ID}.epub"

curl --fail --location --retry 3 --retry-delay 2 "$SOURCE_URL" -o "$EPUB"
test "$(unzip -p "$EPUB" mimetype)" = 'application/epub+zip'
unzip -t "$EPUB" >/dev/null
mkdir -p /tmp/epub-check
unzip -q "$EPUB" -d /tmp/epub-check
grep -Riq "${AUTHOR%% *}" /tmp/epub-check

# La portada externa oficial se comprueba antes de registrar la ficha.
curl --fail --location --retry 3 --retry-delay 2 "$COVER_URL" -o /tmp/portada
test "$(stat -c %s /tmp/portada)" -gt 5000

SIZE=$(stat -c %s "$EPUB")
KEY="libros/${BOOK_ID}.epub"
npx wrangler r2 object put "biblioteca-logidma/${KEY}" \
  --file "$EPUB" --remote \
  --content-type 'application/epub+zip' \
  --content-disposition "inline; filename=\"${BOOK_ID}.epub\""

NOW=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
NAME="${TITLE}.epub"
cat > /tmp/import.sql <<SQL
INSERT INTO libros (
  id, titulo, autor, descripcion, categoria, anio, formato, clave_archivo,
  nombre_archivo, tamano, portada_url, paginas, estado, creado_en, actualizado_en,
  partes, tamano_parte, almacen
) VALUES (
  '${BOOK_ID}', '${TITLE}', '${AUTHOR}', '${DESCRIPTION}', '${CATEGORY}', ${YEAR_SQL}, 'epub', '${KEY}',
  '${NAME}', ${SIZE}, '${COVER_URL}', NULL, 'publicado', '${NOW}', '${NOW}',
  1, 5242880, 'r2'
)
ON CONFLICT(id) DO UPDATE SET
  titulo=excluded.titulo,
  autor=excluded.autor,
  descripcion=excluded.descripcion,
  categoria=excluded.categoria,
  anio=excluded.anio,
  formato=excluded.formato,
  clave_archivo=excluded.clave_archivo,
  nombre_archivo=excluded.nombre_archivo,
  tamano=excluded.tamano,
  portada_url=excluded.portada_url,
  estado='publicado',
  actualizado_en=excluded.actualizado_en,
  partes=excluded.partes,
  tamano_parte=excluded.tamano_parte,
  almacen='r2';
SQL

npx wrangler d1 execute biblioteca-logidma --remote --file=/tmp/import.sql
npx wrangler d1 execute biblioteca-logidma --remote --command="SELECT id,titulo,autor,formato,tamano,estado FROM libros WHERE id='${BOOK_ID}';"
echo "IMPORTADO ${BOOK_ID} | ${SIZE} bytes"
