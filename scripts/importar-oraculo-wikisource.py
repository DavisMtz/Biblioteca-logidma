#!/usr/bin/env python3
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path
from bs4 import BeautifulSoup

BOOK_ID = "gracianoraculo1647"
TITLE = "Oráculo manual y arte de prudencia"
AUTHOR = "Baltasar Gracián"
YEAR = 1647
CATEGORY = "Filosofía"
SOURCE_PAGE = "https://es.wikisource.org/wiki/Oráculo_manual_y_arte_de_prudencia"
COVER_URL = "https://commons.wikimedia.org/wiki/Special:Redirect/file/Oráculo_manual_y_arte_de_prudencia.jpg"
PAGES = [
    ("Al lector", None, None),
    ("Aforismos (1-25)", 1, 25),
    ("Aforismos (26-50)", 26, 50),
    ("Aforismos (51-75)", 51, 75),
    ("Aforismos (76-100)", 76, 100),
    ("Aforismos (101-125)", 101, 125),
    ("Aforismos (126-150)", 126, 150),
    ("Aforismos (151-175)", 151, 175),
    ("Aforismos (176-200)", 176, 200),
    ("Aforismos (201-225)", 201, 225),
    ("Aforismos (226-250)", 226, 250),
    ("Aforismos (251-275)", 251, 275),
    ("Aforismos (276-300)", 276, 300),
]

UA = "Biblioteca-logidma/1.0 (+personal library import; source attribution retained)"

def get_url(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()

def fetch_page(subpage: str) -> tuple[str, str]:
    page = f"Oráculo manual y arte de prudencia/{subpage}"
    qs = urllib.parse.urlencode({
        "action": "parse",
        "page": page,
        "prop": "text",
        "format": "json",
        "formatversion": 2,
        "redirects": 1,
    })
    raw = get_url("https://es.wikisource.org/w/api.php?" + qs)
    data = json.loads(raw)
    html = data["parse"]["text"]
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.select("script, style, .mw-editsection, .noprint, .navigation-not-searchable, table.navbox, table.ambox"):
        node.decompose()
    root = soup.select_one(".mw-parser-output") or soup
    text = root.get_text("\n", strip=True)
    return str(root), text

def run(*args: str) -> None:
    subprocess.run(args, check=True)

def main() -> None:
    out = Path("/tmp/oraculo")
    out.mkdir(parents=True, exist_ok=True)
    sections = []
    combined_text = []

    for subpage, start, end in PAGES:
        html, text = fetch_page(subpage)
        if start is not None:
            # Verificación conservadora: cada bloque debe contener sus extremos
            # como números de aforismo visibles antes de generar el EPUB.
            if not re.search(rf"(?:^|\s){start}\.", text):
                raise RuntimeError(f"No se encontró el aforismo inicial {start} en {subpage}")
            if not re.search(rf"(?:^|\s){end}\.", text):
                raise RuntimeError(f"No se encontró el aforismo final {end} en {subpage}")
        sections.append(f"<section><h1>{subpage}</h1>{html}</section>")
        combined_text.append(text)

    all_text = "\n".join(combined_text)
    for n in (1, 25, 50, 100, 150, 200, 250, 275, 300):
        if not re.search(rf"(?:^|\s){n}\.", all_text):
            raise RuntimeError(f"Validación global falló: falta el aforismo {n}")

    html_doc = f"""<!doctype html><html lang='es'><head><meta charset='utf-8'><title>{TITLE}</title></head><body>
    <h1>{TITLE}</h1><p><strong>{AUTHOR}</strong> — edición original de 1647.</p>
    <p>Texto digital procedente de Wikisource en español, disponible bajo CC BY-SA 4.0. Fuente: {SOURCE_PAGE}</p>
    {''.join(sections)}</body></html>"""
    html_path = out / "oraculo.html"
    html_path.write_text(html_doc, encoding="utf-8")

    cover_path = out / "cover.jpg"
    cover_path.write_bytes(get_url(COVER_URL))
    run("file", str(cover_path))
    if cover_path.stat().st_size < 50000:
        raise RuntimeError("La portada descargada parece inválida")

    epub_path = out / f"{BOOK_ID}.epub"
    run(
        "pandoc", str(html_path), "-f", "html", "-t", "epub3",
        "--metadata", f"title={TITLE}",
        "--metadata", f"author={AUTHOR}",
        "--metadata", "lang=es",
        "--metadata", "rights=Texto de Wikisource: CC BY-SA 4.0; obra original en dominio público",
        "--epub-cover-image", str(cover_path),
        "-o", str(epub_path),
    )
    if epub_path.stat().st_size < 100000:
        raise RuntimeError("EPUB generado demasiado pequeño")
    if subprocess.check_output(["unzip", "-p", str(epub_path), "mimetype"], text=True).strip() != "application/epub+zip":
        raise RuntimeError("EPUB inválido")
    run("unzip", "-t", str(epub_path))

    size = epub_path.stat().st_size
    key = f"libros/{BOOK_ID}.epub"
    run(
        "npx", "wrangler", "r2", "object", "put", f"biblioteca-logidma/{key}",
        "--file", str(epub_path), "--remote",
        "--content-type", "application/epub+zip",
        "--content-disposition", f'inline; filename="{TITLE}.epub"',
    )

    now = subprocess.check_output(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], text=True).strip()
    description = (
        "Colección de 300 aforismos sobre prudencia, reputación, juicio y conducta social. "
        "Texto original español de 1647 de Baltasar Gracián, reconstruido desde Wikisource; "
        "texto digital CC BY-SA 4.0 y obra original de dominio público."
    )
    sql = f"""
    INSERT INTO libros (
      id,titulo,autor,descripcion,categoria,anio,formato,clave_archivo,nombre_archivo,
      tamano,portada_url,paginas,estado,creado_en,actualizado_en,partes,tamano_parte,almacen
    ) VALUES (
      '{BOOK_ID}','{TITLE}','{AUTHOR}','{description}','{CATEGORY}',{YEAR},'epub','{key}',
      '{TITLE}.epub',{size},'{COVER_URL}',NULL,'publicado','{now}','{now}',1,5242880,'r2'
    )
    ON CONFLICT(id) DO UPDATE SET
      titulo=excluded.titulo,autor=excluded.autor,descripcion=excluded.descripcion,
      categoria=excluded.categoria,anio=excluded.anio,formato=excluded.formato,
      clave_archivo=excluded.clave_archivo,nombre_archivo=excluded.nombre_archivo,
      tamano=excluded.tamano,portada_url=excluded.portada_url,estado='publicado',
      actualizado_en=excluded.actualizado_en,almacen='r2';
    """
    sql_path = out / "import.sql"
    sql_path.write_text(sql, encoding="utf-8")
    run("npx", "wrangler", "d1", "execute", "biblioteca-logidma", "--remote", f"--file={sql_path}")
    run("npx", "wrangler", "d1", "execute", "biblioteca-logidma", "--remote", "--command", f"SELECT id,titulo,autor,formato,tamano,estado FROM libros WHERE id='{BOOK_ID}';")
    print(f"IMPORTADO {BOOK_ID} | {size} bytes | 300 aforismos validados")

if __name__ == "__main__":
    main()
