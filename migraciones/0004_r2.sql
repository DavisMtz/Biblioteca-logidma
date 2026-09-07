-- Desbordamiento a R2: los libros nuevos siguen yendo a KV hasta que este se
-- acerca a su gigabyte gratuito; a partir de ahí van al bucket de R2, que da
-- 10 GB. Los que ya estaban se quedan donde están y se sirven igual.
ALTER TABLE libros ADD COLUMN almacen TEXT NOT NULL DEFAULT 'kv';

-- Una subida a medias necesita saber a qué almacén va, y en R2 hay que
-- recordar el identificador que devuelve el inicio del envío por partes.
ALTER TABLE subidas ADD COLUMN almacen TEXT NOT NULL DEFAULT 'kv';
ALTER TABLE subidas ADD COLUMN upload_id TEXT;
ALTER TABLE subidas ADD COLUMN clave_r2 TEXT;
