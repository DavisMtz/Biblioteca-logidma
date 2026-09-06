-- Catálogo de la biblioteca. Los archivos viven en R2; aquí solo los datos.
CREATE TABLE IF NOT EXISTS libros (
  id            TEXT PRIMARY KEY,
  titulo        TEXT NOT NULL,
  autor         TEXT NOT NULL DEFAULT '',
  descripcion   TEXT NOT NULL DEFAULT '',
  categoria     TEXT NOT NULL DEFAULT '',
  anio          INTEGER,
  formato       TEXT NOT NULL,          -- pdf | epub | docx | odt | rtf | txt | html | md
  clave_r2      TEXT NOT NULL,          -- ruta del objeto dentro del bucket
  nombre_archivo TEXT NOT NULL,
  tamano        INTEGER NOT NULL DEFAULT 0,
  portada_url   TEXT NOT NULL DEFAULT '',
  paginas       INTEGER,
  estado        TEXT NOT NULL DEFAULT 'publicado',  -- publicado | borrador
  creado_en     TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_libros_creado   ON libros (creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_libros_categoria ON libros (categoria);
CREATE INDEX IF NOT EXISTS idx_libros_estado   ON libros (estado);

-- Subidas por partes a medio camino. Se limpian al completar o al cancelar.
CREATE TABLE IF NOT EXISTS subidas (
  id          TEXT PRIMARY KEY,
  clave_r2    TEXT NOT NULL,
  upload_id   TEXT NOT NULL,
  nombre_archivo TEXT NOT NULL,
  creado_en   TEXT NOT NULL
);

-- Marcador de lectura por libro (una biblioteca compartida: un marcador por libro).
CREATE TABLE IF NOT EXISTS marcadores (
  libro_id    TEXT NOT NULL,
  lector      TEXT NOT NULL DEFAULT 'general',
  pagina      INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT NOT NULL,
  PRIMARY KEY (libro_id, lector)
);
