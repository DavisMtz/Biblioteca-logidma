-- Los archivos pasan de R2 a Workers KV, troceados: R2 exige un método de pago
-- aunque su tramo sea gratuito, y KV entra en el plan gratis de Workers.
ALTER TABLE libros RENAME COLUMN clave_r2 TO clave_archivo;
ALTER TABLE libros ADD COLUMN partes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE libros ADD COLUMN tamano_parte INTEGER NOT NULL DEFAULT 5242880;

-- Las subidas a medio camino ya no tienen un upload_id de R2: se cuentan partes.
DROP TABLE IF EXISTS subidas;
CREATE TABLE subidas (
  id             TEXT PRIMARY KEY,
  nombre_archivo TEXT NOT NULL,
  partes         INTEGER NOT NULL DEFAULT 0,
  bytes_ultima   INTEGER NOT NULL DEFAULT 0,
  creado_en      TEXT NOT NULL
);
