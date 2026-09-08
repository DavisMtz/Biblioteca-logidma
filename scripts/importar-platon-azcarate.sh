#!/usr/bin/env bash
set -euo pipefail

: "${ROMAN:?}" "${YEAR:?}" "${BOOK_ID:?}" "${SUBSERIE:?}"

FILENAME="Obras completas de Platón - Tomo ${ROMAN} (${YEAR}).djvu"
ENCODED=$(python -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1].replace(" ", "_")))' "$FILENAME")
SOURCE_URL="https://commons.wikimedia.org/wiki/Special:Redirect/file/${ENCODED}"
COVER_URL="https://commons.wikimedia.org/w/thumb.php?f=${ENCODED}&w=480&page=1"
PDF="/tmp/${BOOK_ID}.pdf"
RAW="/tmp/${BOOK_ID}-raw.pdf"
DJVU="/tmp/${BOOK_ID}.djvu"

curl --fail --location --retry 3 --retry-delay 2 "$SOURCE_URL" -o "$DJVU"
file "$DJVU" | grep -q 'DjVu multiple page document'
test "$(stat -c %s "$DJVU")" -gt 10000000

# Commons genera una miniatura JPEG de la primera página. Se valida antes de
# guardarla como portada externa para evitar fichas con imágenes rotas.
curl --fail --location --retry 3 --retry-delay 2 "$COVER_URL" -o /tmp/portada.jpg
file /tmp/portada.jpg | grep -q 'JPEG image data'
test "$(stat -c %s /tmp/portada.jpg)" -gt 10000

# El lector no abre DjVu. ddjvu conserva fielmente el facsímil, pero produce un
# PDF enorme; Ghostscript lo lleva a una resolución razonable para lectura en
# pantalla sin ocupar cientos de MB por tomo.
ddjvu -format=pdf "$DJVU" "$RAW" 2>/dev/null
gs -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite \
  -dCompatibilityLevel=1.5 \
  -dColorImageDownsampleType=/Bicubic -dColorImageResolution=120 \
  -dGrayImageDownsampleType=/Bicubic -dGrayImageResolution=120 \
  -dMonoImageDownsampleType=/Subsample -dMonoImageResolution=300 \
  -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
  -dAutoFilterGrayImages=false -dGrayImageFilter=/DCTEncode \
  -dJPEGQ=82 \
  -sOutputFile="$PDF" "$RAW"

PAGES=$(pdfinfo "$PDF" | awk '/^Pages:/ {print $2}')
SIZE=$(stat -c %s "$PDF")
test "${PAGES:-0}" -gt 150
test "$SIZE" -gt 1000000
test "$SIZE" -lt 180000000

# Muestreo visual: fuerza a Poppler a rasterizar una página intermedia.
SAMPLE=$(( PAGES > 40 ? 20 : 1 ))
pdftoppm -f "$SAMPLE" -singlefile -jpeg -r 100 "$PDF" /tmp/muestra >/dev/null 2>&1
test "$(stat -c %s /tmp/muestra.jpg)" -gt 20000

KEY="libros/${BOOK_ID}.pdf"
npx wrangler r2 object put "biblioteca-logidma/${KEY}" \
  --file "$PDF" --remote \
  --content-type 'application/pdf' \
  --content-disposition "inline; filename=\"Platon-Azcarate-Tomo-${ROMAN}.pdf\""

NOW=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
TITLE="Obras completas de Platón — Tomo ${ROMAN} (Azcárate)"
DESCRIPTION="${SUBSERIE}. Edición histórica en español, traducción de Patricio de Azcárate, Madrid ${YEAR}. Facsímil de dominio público procedente de Wikimedia Commons."
NAME="Obras completas de Platón - Tomo ${ROMAN} - Azcárate.pdf"

cat > /tmp/import.sql <<SQL
INSERT INTO libros (
  id, titulo, autor, descripcion, categoria, anio, formato, clave_archivo,
  nombre_archivo, tamano, portada_url, paginas, estado, creado_en, actualizado_en,
  partes, tamano_parte, almacen
) VALUES (
  '${BOOK_ID}', '${TITLE}', 'Platón', '${DESCRIPTION}', 'Filosofía', ${YEAR}, 'pdf', '${KEY}',
  '${NAME}', ${SIZE}, '${COVER_URL}', ${PAGES}, 'publicado', '${NOW}', '${NOW}',
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
  paginas=excluded.paginas,
  estado='publicado',
  actualizado_en=excluded.actualizado_en,
  partes=excluded.partes,
  tamano_parte=excluded.tamano_parte,
  almacen='r2';
SQL

npx wrangler d1 execute biblioteca-logidma --remote --file=/tmp/import.sql
npx wrangler d1 execute biblioteca-logidma --remote --command="SELECT id,titulo,autor,formato,paginas,tamano,estado FROM libros WHERE id='${BOOK_ID}';"

echo "IMPORTADO ${BOOK_ID} | ${PAGES} páginas | ${SIZE} bytes"
