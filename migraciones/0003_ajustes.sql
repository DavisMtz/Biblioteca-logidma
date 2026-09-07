-- La contraseña de administración deja de vivir en un secreto del Worker (que
-- el propio Worker no puede reescribir) y pasa a la base, guardada como hash.
-- Mientras NO haya fila `clave_admin`, vale la contraseña de arranque del
-- secreto ADMIN_PASSWORD; en cuanto se cambia una vez, esa deja de servir.
CREATE TABLE IF NOT EXISTS ajustes (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- La generación viaja dentro de la cookie: al cambiar la contraseña sube, y
-- todas las sesiones abiertas dejan de valer sin consultar nada más.
INSERT OR IGNORE INTO ajustes (clave, valor, actualizado_en)
VALUES ('generacion', '1', datetime('now'));
