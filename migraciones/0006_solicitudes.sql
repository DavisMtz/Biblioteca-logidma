-- Libros que alguien pidió desde el catálogo y todavía no están.
--
-- Las escribe cualquier lector (con la biblioteca cerrada, solo quien tenga la
-- clave) y solo las lee quien administra, en /admin → Solicitudes.
--
-- Un título que ya se pidió y sigue pendiente no abre otra fila: sube `veces`.
-- Tres personas pidiendo lo mismo es un dato para decidir qué subir primero;
-- tres filas gemelas, solo ruido.
CREATE TABLE IF NOT EXISTS solicitudes (
  id             TEXT PRIMARY KEY,
  titulo         TEXT NOT NULL,
  titulo_llano   TEXT NOT NULL,              -- sin mayúsculas, tildes ni signos: con esto se juntan las repetidas
  autor          TEXT NOT NULL DEFAULT '',
  nota           TEXT NOT NULL DEFAULT '',
  contacto       TEXT NOT NULL DEFAULT '',   -- opcional: sin cuentas, es la única forma de avisar
  veces          INTEGER NOT NULL DEFAULT 1,
  estado         TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | atendida | descartada
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_estado ON solicitudes (estado, actualizado_en DESC);
CREATE INDEX IF NOT EXISTS idx_solicitudes_llano  ON solicitudes (titulo_llano, estado);

-- Un apunte por envío, solo para frenar los envíos en masa. No guarda la IP:
-- `huella` es un HMAC de ella con SESSION_SECRET, que sirve para contar y no
-- para saber de quién es. El Worker borra los apuntes de más de un día.
CREATE TABLE IF NOT EXISTS envios_solicitud (
  huella    TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_envios_solicitud ON envios_solicitud (huella, creado_en);
CREATE INDEX IF NOT EXISTS idx_envios_solicitud_creado ON envios_solicitud (creado_en);
