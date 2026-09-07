-- Quién puede leer la biblioteca.
--
-- 'publico' = cualquiera con el enlace, que es como funcionaba hasta ahora.
-- 'clave'   = hace falta la clave común que reparte quien administra.
--
-- Se nace en 'publico' a propósito: cerrarla en la migración dejaría fuera de
-- golpe a todo el que ya estaba leyendo, y sin que nadie lo hubiera pedido.
INSERT OR IGNORE INTO ajustes (clave, valor, actualizado_en)
VALUES ('acceso', 'publico', datetime('now'));

-- La generación de los lectores viaja dentro de su galleta: al cambiar la clave
-- o el modo de acceso sube, y las sesiones abiertas dejan de valer sin tener
-- que guardar una lista de ellas.
INSERT OR IGNORE INTO ajustes (clave, valor, actualizado_en)
VALUES ('generacion_lectura', '1', datetime('now'));

-- La clave misma (fila 'clave_lectura') no se crea aquí: aparece cuando se
-- pone una desde el panel, y va cifrada, no en claro.
