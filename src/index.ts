import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
  ARCHIVOS: KVNamespace;
  LIBROS_R2: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  CLOUDINARY_CLOUD: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  CLOUDINARY_CARPETA: string;
};

const COOKIE = 'bib_sesion';
const DURACION_SESION = 60 * 60 * 12; // 12 h
// Los archivos se guardan troceados en KV: el tope por valor es de 25 MiB y
// cada trozo es una escritura (1000 al día en el plan gratuito).
// R2 exige que todas las partes midan lo mismo salvo la última, y al menos
// 5 MiB: este tamaño vale para los dos almacenes tal cual.
const PARTE = 5 * 1024 * 1024;        // 5 MiB por parte
const clavePart = (id: string, n: number) => `libro:${id}:${n}`;
const claveR2 = (id: string, ext: string) => `libros/${id}.${ext}`;

// Cuando KV llega aquí, los libros nuevos empiezan a ir a R2. Se deja margen
// sobre el gigabyte gratuito para que un libro grande no se quede a medias.
const UMBRAL_KV = 900 * 1024 * 1024;

const FORMATOS: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

type Ajustes = { hash: string | null; generacion: number };
const app = new Hono<{ Bindings: Env; Variables: { admin: boolean; ajustes: Ajustes } }>();

/* ---------- utilidades ---------- */

const ahora = () => new Date().toISOString();

function id(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

function extension(nombre: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(nombre.trim());
  return m ? m[1].toLowerCase() : '';
}

function formatoDe(nombre: string): string | null {
  const ext = extension(nombre);
  if (!(ext in FORMATOS)) return null;
  return ext === 'htm' ? 'html' : ext;
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function firmar(valor: string, secreto: string): Promise<string> {
  const clave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', clave, new TextEncoder().encode(valor)));
}

/** Comparación en tiempo constante: no delata la contraseña por el tiempo de respuesta. */
function igual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/* ---------- contraseña de administración ---------- */

// 100 000 iteraciones es el techo medido en Workers de este plan: con 200 000
// la petición muere por CPU. No subirlo sin volver a medirlo.
const ITERACIONES = 100000;

function deB64url(texto: string): Uint8Array {
  const base = texto.replace(/-/g, '+').replace(/_/g, '/');
  const cruda = atob(base + '='.repeat((4 - (base.length % 4)) % 4));
  return Uint8Array.from(cruda, (c) => c.charCodeAt(0));
}

async function derivar(clave: string, sal: Uint8Array, iteraciones: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: sal, iterations: iteraciones, hash: 'SHA-256' }, material, 256,
  );
  return new Uint8Array(bits);
}

/** Formato guardado: pbkdf2$<iteraciones>$<sal>$<hash>, para poder subir el listón luego. */
async function hashDeClave(clave: string): Promise<string> {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const bytes = await derivar(clave, sal, ITERACIONES);
  return `pbkdf2$${ITERACIONES}$${b64url(sal)}$${b64url(bytes)}`;
}

async function claveCorrecta(clave: string, guardado: string): Promise<boolean> {
  const [algoritmo, iteraciones, sal, esperado] = guardado.split('$');
  if (algoritmo !== 'pbkdf2' || !sal || !esperado) return false;
  const bytes = await derivar(clave, deB64url(sal), Number(iteraciones) || ITERACIONES);
  return igual(b64url(bytes), esperado);
}

/** Ajustes de la base, leídos una sola vez por petición. */
async function ajustes(c: any): Promise<{ hash: string | null; generacion: number }> {
  const guardado = c.get('ajustes');
  if (guardado) return guardado;
  const { results } = await c.env.DB.prepare(
    `SELECT clave, valor FROM ajustes WHERE clave IN ('clave_admin', 'generacion')`,
  ).all<{ clave: string; valor: string }>();
  const mapa = Object.fromEntries((results || []).map((f) => [f.clave, f.valor]));
  const datos = { hash: mapa.clave_admin || null, generacion: Number(mapa.generacion || 1) };
  c.set('ajustes', datos);
  return datos;
}

/**
 * Comprueba la contraseña. Mientras no haya hash en la base vale la de
 * arranque; en cuanto se cambia una vez, esa deja de servir para siempre —si no,
 * sería una puerta trasera permanente atada a un valor que anda en varios sitios.
 */
async function claveValida(c: any, clave: string): Promise<boolean> {
  if (!clave) return false;
  const { hash } = await ajustes(c);
  if (hash) return claveCorrecta(clave, hash);
  return Boolean(c.env.ADMIN_PASSWORD) && igual(clave, c.env.ADMIN_PASSWORD);
}

async function sesionValida(c: any): Promise<boolean> {
  const galleta = getCookie(c, COOKIE);
  if (!galleta) return false;
  const corte = galleta.lastIndexOf('.');
  if (corte < 1) return false;
  const cuerpo = galleta.slice(0, corte);
  const firma = galleta.slice(corte + 1);
  const esperada = await firmar(cuerpo, c.env.SESSION_SECRET);
  if (!igual(firma, esperada)) return false;

  const [, exp, gen] = cuerpo.split(':');
  if (Number(exp || 0) <= Math.floor(Date.now() / 1000)) return false;
  // La generación cambia al cambiar la contraseña: las sesiones viejas caen.
  const { generacion } = await ajustes(c);
  return Number(gen || 0) === generacion;
}

/* ---------- middleware ---------- */

app.use('/api/*', async (c, next) => {
  c.set('admin', await sesionValida(c));
  await next();
});

const soloAdmin = async (c: any, next: any) => {
  if (!c.get('admin')) return c.json({ error: 'Sesión requerida' }, 401);
  await next();
};

/* ---------- sesión ---------- */

app.get('/api/sesion', (c) => c.json({ admin: c.get('admin') }));

async function abrirSesion(c: any) {
  const { generacion } = await ajustes(c);
  const exp = Math.floor(Date.now() / 1000) + DURACION_SESION;
  const cuerpo = `admin:${exp}:${generacion}:${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
  const galleta = `${cuerpo}.${await firmar(cuerpo, c.env.SESSION_SECRET)}`;
  setCookie(c, COOKIE, galleta, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: DURACION_SESION,
  });
}

app.post('/api/sesion', async (c) => {
  const { clave } = await c.req.json<{ clave?: string }>().catch(() => ({ clave: '' }));
  if (!(await claveValida(c, clave || ''))) {
    // Retardo pequeño y uniforme para que probar claves en masa no sea gratis.
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: 'Contraseña incorrecta' }, 401);
  }
  await abrirSesion(c);
  return c.json({ ok: true });
});

app.delete('/api/sesion', (c) => {
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/* ---------- cambiar la contraseña ---------- */

const CLAVES_OBVIAS = [
  '12345678', '123456789', 'password', 'contrasena', 'contraseña',
  'biblioteca', 'logidma', 'administrador', 'qwertyui', 'aaaaaaaa',
];

/** Devuelve el motivo del rechazo, o null si la contraseña sirve. */
function revisarClave(nueva: string, actual: string): string | null {
  if (!nueva || nueva.length < 8) return 'La contraseña nueva debe tener al menos 8 caracteres.';
  if (nueva.length > 200) return 'La contraseña nueva es demasiado larga.';
  if (nueva === actual) return 'La contraseña nueva tiene que ser distinta de la actual.';
  if (nueva.trim() !== nueva) return 'La contraseña no puede empezar ni terminar con espacios.';
  const llana = nueva.toLowerCase().replace(/\s+/g, '');
  if (CLAVES_OBVIAS.includes(llana)) return 'Esa contraseña es demasiado fácil de adivinar. Elige otra.';
  return null;
}

app.post('/api/clave', soloAdmin, async (c) => {
  const { actual, nueva } = await c.req.json<{ actual?: string; nueva?: string }>()
    .catch(() => ({ actual: '', nueva: '' }));

  if (!(await claveValida(c, actual || ''))) {
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: 'La contraseña actual no es correcta.' }, 401);
  }
  const problema = revisarClave(nueva || '', actual || '');
  if (problema) return c.json({ error: problema }, 400);

  const { generacion } = await ajustes(c);
  const t = ahora();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ajustes (clave, valor, actualizado_en) VALUES ('clave_admin', ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`,
    ).bind(await hashDeClave(nueva!), t),
    c.env.DB.prepare(
      `INSERT INTO ajustes (clave, valor, actualizado_en) VALUES ('generacion', ?, ?)
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`,
    ).bind(String(generacion + 1), t),
  ]);

  // La sesión propia también cae: con la generación nueva, la cookie ya no vale.
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/* ---------- catálogo ---------- */

app.get('/api/libros', async (c) => {
  const admin = c.get('admin');
  const q = (c.req.query('q') || '').trim();
  const categoria = (c.req.query('categoria') || '').trim();

  let sql = `SELECT id, titulo, autor, descripcion, categoria, anio, formato,
                    nombre_archivo, tamano, portada_url, paginas, estado, creado_en
             FROM libros WHERE 1=1`;
  const args: unknown[] = [];
  if (!admin) sql += ` AND estado = 'publicado'`;
  if (q) {
    sql += ` AND (LOWER(titulo) LIKE ?1 OR LOWER(autor) LIKE ?1 OR LOWER(descripcion) LIKE ?1)`;
    args.push(`%${q.toLowerCase()}%`);
  }
  if (categoria) {
    sql += ` AND categoria = ?${args.length + 1}`;
    args.push(categoria);
  }
  sql += ` ORDER BY creado_en DESC LIMIT 500`;

  const { results } = await c.env.DB.prepare(sql).bind(...args).all();
  const cats = await c.env.DB.prepare(
    `SELECT categoria, COUNT(*) n FROM libros
     WHERE categoria <> '' ${admin ? '' : `AND estado = 'publicado'`}
     GROUP BY categoria ORDER BY categoria`,
  ).all();
  return c.json({ libros: results, categorias: cats.results, admin });
});

app.get('/api/libros/:id', async (c) => {
  const libro = await c.env.DB.prepare(`SELECT * FROM libros WHERE id = ?`)
    .bind(c.req.param('id')).first();
  if (!libro) return c.json({ error: 'No existe ese libro' }, 404);
  if (libro.estado !== 'publicado' && !c.get('admin')) return c.json({ error: 'No existe ese libro' }, 404);
  return c.json({ libro, admin: c.get('admin') });
});

app.patch('/api/libros/:id', soloAdmin, async (c) => {
  const datos = await c.req.json<Record<string, any>>();
  const campos = ['titulo', 'autor', 'descripcion', 'categoria', 'anio', 'portada_url', 'estado', 'paginas'];
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const campo of campos) {
    if (campo in datos) { sets.push(`${campo} = ?`); args.push(datos[campo]); }
  }
  if (!sets.length) return c.json({ error: 'Nada que actualizar' }, 400);
  sets.push('actualizado_en = ?');
  args.push(ahora(), c.req.param('id'));
  await c.env.DB.prepare(`UPDATE libros SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  const libro = await c.env.DB.prepare(`SELECT * FROM libros WHERE id = ?`).bind(c.req.param('id')).first();
  return c.json({ libro });
});

app.delete('/api/libros/:id', soloAdmin, async (c) => {
  const libro = await c.env.DB.prepare(
    `SELECT partes, almacen, clave_archivo FROM libros WHERE id = ?`,
  ).bind(c.req.param('id')).first<{ partes: number; almacen: string; clave_archivo: string }>();
  if (!libro) return c.json({ error: 'No existe ese libro' }, 404);
  if (libro.almacen === 'r2') await c.env.LIBROS_R2.delete(libro.clave_archivo);
  else await borrarPartes(c.env, c.req.param('id'), libro.partes);
  await c.env.DB.prepare(`DELETE FROM libros WHERE id = ?`).bind(c.req.param('id')).run();
  await c.env.DB.prepare(`DELETE FROM marcadores WHERE libro_id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

/* ---------- subida por partes ---------- */

/**
 * Elige almacén: KV mientras quepa holgadamente, R2 en cuanto no.
 * El tamaño que manda el navegador sirve SOLO para decidir el destino; el que
 * se guarda en el catálogo lo sigue contando el servidor parte por parte.
 */
async function elegirAlmacen(c: any, tamanoPrevisto: number): Promise<'kv' | 'r2'> {
  const fila = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(tamano), 0) AS usado FROM libros WHERE almacen = 'kv'`,
  ).first<{ usado: number }>();
  const usado = Number(fila?.usado || 0);
  return usado + Math.max(0, tamanoPrevisto) > UMBRAL_KV ? 'r2' : 'kv';
}

app.post('/api/subir/iniciar', soloAdmin, async (c) => {
  const { nombre, tamano } = await c.req.json<{ nombre: string; tamano?: number }>();
  const formato = formatoDe(nombre || '');
  if (!formato) {
    return c.json({ error: 'Formato no admitido. Usa PDF, EPUB, DOCX, ODT, RTF, TXT, HTML o MD.' }, 400);
  }
  const idSubida = id();
  const almacen = await elegirAlmacen(c, Number(tamano) || 0);

  let uploadId: string | null = null;
  let clave: string | null = null;
  if (almacen === 'r2') {
    clave = claveR2(idSubida, extension(nombre));
    const multi = await c.env.LIBROS_R2.createMultipartUpload(clave, {
      httpMetadata: {
        contentType: FORMATOS[extension(nombre)],
        contentDisposition: `inline; filename="${encodeURIComponent(nombre)}"`,
      },
    });
    uploadId = multi.uploadId;
  }

  await c.env.DB.prepare(
    `INSERT INTO subidas (id, nombre_archivo, partes, creado_en, almacen, upload_id, clave_r2)
     VALUES (?,?,0,?,?,?,?)`,
  ).bind(idSubida, nombre, ahora(), almacen, uploadId, clave).run();
  return c.json({ id: idSubida, formato, tamanoParte: PARTE, almacen });
});

app.put('/api/subir/parte', soloAdmin, async (c) => {
  const idSubida = c.req.query('id') || '';
  const numero = Number(c.req.query('n') || 0);
  if (!idSubida || !numero) return c.json({ error: 'Falta id o número de parte' }, 400);
  const fila = await c.env.DB.prepare(
    `SELECT partes, almacen, upload_id, clave_r2 FROM subidas WHERE id = ?`,
  ).bind(idSubida).first<{ partes: number; almacen: string; upload_id: string | null; clave_r2: string | null }>();
  if (!fila) return c.json({ error: 'Subida no encontrada' }, 404);

  const cuerpo = await c.req.arrayBuffer();
  if (cuerpo.byteLength > PARTE) return c.json({ error: 'Parte demasiado grande' }, 413);

  let etag: string | undefined;
  if (fila.almacen === 'r2') {
    const multi = c.env.LIBROS_R2.resumeMultipartUpload(fila.clave_r2!, fila.upload_id!);
    etag = (await multi.uploadPart(numero, cuerpo)).etag;
  } else {
    await c.env.ARCHIVOS.put(clavePart(idSubida, numero), cuerpo);
  }
  // Todas las partes miden PARTE menos la última: guardando cuál es la última
  // y cuánto pesa, el tamaño del archivo sale del servidor y no del navegador.
  await c.env.DB.prepare(
    `UPDATE subidas SET bytes_ultima = CASE WHEN ? >= partes THEN ? ELSE bytes_ultima END,
                        partes = MAX(partes, ?)
     WHERE id = ?`,
  ).bind(numero, cuerpo.byteLength, numero, idSubida).run();
  return c.json({ partNumber: numero, bytes: cuerpo.byteLength, etag });
});

app.post('/api/subir/completar', soloAdmin, async (c) => {
  const datos = await c.req.json<{
    id: string; partes: { partNumber: number; etag?: string }[];
    titulo?: string; autor?: string; descripcion?: string; categoria?: string;
    anio?: number; portada_url?: string; paginas?: number; estado?: string; tamano?: number;
  }>();
  const fila = await c.env.DB.prepare(
    `SELECT nombre_archivo, partes, bytes_ultima, almacen, upload_id, clave_r2 FROM subidas WHERE id = ?`,
  ).bind(datos.id).first<{
    nombre_archivo: string; partes: number; bytes_ultima: number;
    almacen: string; upload_id: string | null; clave_r2: string | null;
  }>();
  if (!fila) return c.json({ error: 'Subida no encontrada' }, 404);

  const partes = fila.partes;
  if (!partes) return c.json({ error: 'No se subió ninguna parte' }, 400);
  const tamano = (partes - 1) * PARTE + fila.bytes_ultima;

  // En R2 el archivo no existe hasta que se cierran las partes; en KV cada
  // parte ya quedó escrita por su cuenta.
  if (fila.almacen === 'r2') {
    const multi = c.env.LIBROS_R2.resumeMultipartUpload(fila.clave_r2!, fila.upload_id!);
    await multi.complete(
      (datos.partes || [])
        .filter((p) => p && p.etag)
        .map((p) => ({ partNumber: p.partNumber, etag: p.etag! })),
    );
  }

  const formato = formatoDe(fila.nombre_archivo)!;
  const t = ahora();
  await c.env.DB.prepare(
    `INSERT INTO libros (id, titulo, autor, descripcion, categoria, anio, formato, clave_archivo,
                         nombre_archivo, tamano, portada_url, paginas, estado, creado_en, actualizado_en,
                         partes, tamano_parte, almacen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    datos.id,
    (datos.titulo || fila.nombre_archivo.replace(/\.[^.]+$/, '')).slice(0, 300),
    datos.autor || '', datos.descripcion || '', datos.categoria || '',
    datos.anio || null, formato,
    fila.almacen === 'r2' ? fila.clave_r2! : `libro:${datos.id}`,
    fila.nombre_archivo,
    tamano, datos.portada_url || '', datos.paginas || null,
    datos.estado === 'borrador' ? 'borrador' : 'publicado', t, t,
    partes, PARTE, fila.almacen,
  ).run();
  await c.env.DB.prepare(`DELETE FROM subidas WHERE id = ?`).bind(datos.id).run();

  const libro = await c.env.DB.prepare(`SELECT * FROM libros WHERE id = ?`).bind(datos.id).first();
  return c.json({ libro });
});

app.post('/api/subir/cancelar', soloAdmin, async (c) => {
  const { id: idSubida } = await c.req.json<{ id: string }>();
  const fila = await c.env.DB.prepare(
    `SELECT partes, almacen, upload_id, clave_r2 FROM subidas WHERE id = ?`,
  ).bind(idSubida).first<{ partes: number; almacen: string; upload_id: string | null; clave_r2: string | null }>();
  if (fila) {
    if (fila.almacen === 'r2' && fila.clave_r2 && fila.upload_id) {
      await c.env.LIBROS_R2.resumeMultipartUpload(fila.clave_r2, fila.upload_id).abort().catch(() => {});
    } else {
      await borrarPartes(c.env, idSubida, fila.partes);
    }
    await c.env.DB.prepare(`DELETE FROM subidas WHERE id = ?`).bind(idSubida).run();
  }
  return c.json({ ok: true });
});

/* ---------- mantenimiento: mudar un libro de KV a R2 ---------- */

/**
 * Mueve UN libro por llamada, parte por parte, para no cargar el archivo entero
 * en memoria ni agotar el tiempo del Worker. Devuelve cuántos quedan.
 */
app.post('/api/mantenimiento/mover-a-r2', soloAdmin, async (c) => {
  const libro = await c.env.DB.prepare(
    `SELECT id, nombre_archivo, partes, tamano FROM libros WHERE almacen = 'kv' ORDER BY tamano LIMIT 1`,
  ).first<{ id: string; nombre_archivo: string; partes: number; tamano: number }>();

  if (!libro) {
    const quedan = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM libros WHERE almacen = 'kv'`,
    ).first<{ n: number }>();
    return c.json({ terminado: true, quedan: Number(quedan?.n || 0) });
  }

  const ext = extension(libro.nombre_archivo);
  const clave = claveR2(libro.id, ext);
  const multi = await c.env.LIBROS_R2.createMultipartUpload(clave, {
    httpMetadata: {
      contentType: FORMATOS[ext],
      contentDisposition: `inline; filename="${encodeURIComponent(libro.nombre_archivo)}"`,
    },
  });

  const subidas: R2UploadedPart[] = [];
  for (let n = 1; n <= libro.partes; n++) {
    const trozo = await leerParte(c.env, libro.id, n);
    if (!trozo) {
      await multi.abort().catch(() => {});
      return c.json({ error: `Al libro «${libro.id}» le falta la parte ${n}; no se movió.` }, 500);
    }
    subidas.push(await multi.uploadPart(n, trozo));
  }
  await multi.complete(subidas);

  // Solo después de que R2 confirme, se cambia el catálogo y se suelta lo viejo.
  const puesto = await c.env.LIBROS_R2.head(clave);
  if (!puesto || puesto.size !== libro.tamano) {
    return c.json({ error: `R2 guardó ${puesto?.size ?? 0} bytes y se esperaban ${libro.tamano}.` }, 500);
  }
  await c.env.DB.prepare(
    `UPDATE libros SET almacen = 'r2', clave_archivo = ?, actualizado_en = ? WHERE id = ?`,
  ).bind(clave, ahora(), libro.id).run();
  await borrarPartes(c.env, libro.id, libro.partes);

  const quedan = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM libros WHERE almacen = 'kv'`,
  ).first<{ n: number }>();
  return c.json({ movido: libro.id, bytes: libro.tamano, quedan: Number(quedan?.n || 0) });
});

/* ---------- portadas en Cloudinary ---------- */

/** El servidor decide carpeta y public_id; el navegador solo sube el archivo. */
app.post('/api/portada/firma', soloAdmin, async (c) => {
  const { libro } = await c.req.json<{ libro: string }>();
  if (!c.env.CLOUDINARY_API_SECRET) return c.json({ error: 'Cloudinary sin configurar' }, 500);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = (libro || id()).replace(/[^a-zA-Z0-9_-]/g, '');
  const aFirmar = `folder=${c.env.CLOUDINARY_CARPETA}&overwrite=true&public_id=${publicId}&timestamp=${timestamp}${c.env.CLOUDINARY_API_SECRET}`;
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(aFirmar));
  const firma = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return c.json({
    firma, timestamp, publicId,
    carpeta: c.env.CLOUDINARY_CARPETA,
    apiKey: c.env.CLOUDINARY_API_KEY,
    url: `https://api.cloudinary.com/v1_1/${c.env.CLOUDINARY_CLOUD}/image/upload`,
  });
});

/* ---------- marcador de lectura ---------- */

app.get('/api/marcador/:id', async (c) => {
  const fila = await c.env.DB.prepare(
    `SELECT pagina FROM marcadores WHERE libro_id = ? AND lector = 'general'`,
  ).bind(c.req.param('id')).first<{ pagina: number }>();
  return c.json({ pagina: fila?.pagina || 1 });
});

app.put('/api/marcador/:id', async (c) => {
  const { pagina } = await c.req.json<{ pagina: number }>();
  await c.env.DB.prepare(
    `INSERT INTO marcadores (libro_id, lector, pagina, actualizado_en) VALUES (?, 'general', ?, ?)
     ON CONFLICT(libro_id, lector) DO UPDATE SET pagina = excluded.pagina, actualizado_en = excluded.actualizado_en`,
  ).bind(c.req.param('id'), Math.max(1, Number(pagina) || 1), ahora()).run();
  return c.json({ ok: true });
});

/* ---------- servir el archivo desde KV, con soporte de rangos ---------- */

/** Borra todas las partes de un libro o de una subida a medias. */
async function borrarPartes(env: Env, idLibro: string, partes: number) {
  const tareas = [];
  for (let n = 1; n <= (partes || 0); n++) tareas.push(env.ARCHIVOS.delete(clavePart(idLibro, n)));
  await Promise.all(tareas);
}

/**
 * Lee una parte. KV es de consistencia eventual: una parte recién escrita puede
 * tardar en verse desde otro centro de datos, así que se reintenta antes de
 * darla por perdida. Las partes no cambian nunca, de ahí el `cacheTtl`.
 */
async function leerParte(env: Env, idLibro: string, n: number): Promise<ArrayBuffer | null> {
  for (let intento = 0; intento < 3; intento++) {
    const trozo = await env.ARCHIVOS.get(clavePart(idLibro, n), { type: 'arrayBuffer', cacheTtl: 3600 });
    if (trozo) return trozo;
    await new Promise((r) => setTimeout(r, 400 * (intento + 1)));
  }
  return null;
}

/** Servido desde R2: el propio bucket resuelve los rangos. */
async function servirDesdeR2(c: any, clave: string, formato: string, descarga: string | null) {
  const cabeceraRango = c.req.header('range');
  let rango: R2Range | undefined;
  if (cabeceraRango) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(cabeceraRango.trim());
    if (m) {
      if (m[1] && m[2]) rango = { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
      else if (m[1]) rango = { offset: Number(m[1]) };
      else if (m[2]) rango = { suffix: Number(m[2]) };
    }
  }

  const objeto = await c.env.LIBROS_R2.get(clave, rango ? { range: rango } : undefined);
  if (!objeto) return c.text('Archivo no encontrado en el almacén', 404);

  const cabeceras = new Headers();
  objeto.writeHttpMetadata(cabeceras);
  cabeceras.set('etag', objeto.httpEtag);
  cabeceras.set('accept-ranges', 'bytes');
  cabeceras.set('cache-control', 'private, max-age=3600');
  if (!cabeceras.get('content-type')) {
    cabeceras.set('content-type', FORMATOS[formato] || 'application/octet-stream');
  }
  if (descarga) cabeceras.set('content-disposition', descarga);

  if (objeto.range && cabeceraRango) {
    const r: any = objeto.range;
    const inicio = r.offset ?? (objeto.size - (r.suffix ?? 0));
    const largo = r.length ?? (objeto.size - inicio);
    cabeceras.set('content-range', `bytes ${inicio}-${inicio + largo - 1}/${objeto.size}`);
    cabeceras.set('content-length', String(largo));
    return new Response(objeto.body, { status: 206, headers: cabeceras });
  }
  cabeceras.set('content-length', String(objeto.size));
  return new Response(objeto.body, { headers: cabeceras });
}

app.get('/archivo/:id', async (c) => {
  const libro = await c.env.DB.prepare(
    `SELECT formato, nombre_archivo, estado, tamano, partes, tamano_parte, almacen, clave_archivo
     FROM libros WHERE id = ?`,
  ).bind(c.req.param('id')).first<{
    formato: string; nombre_archivo: string; estado: string;
    tamano: number; partes: number; tamano_parte: number;
    almacen: string; clave_archivo: string;
  }>();
  if (!libro) return c.text('No existe', 404);
  if (libro.estado !== 'publicado' && !(await sesionValida(c))) return c.text('No existe', 404);

  const descarga = c.req.query('descargar') === '1'
    ? `attachment; filename="${encodeURIComponent(libro.nombre_archivo)}"` : null;

  // R2 sabe servir rangos por su cuenta; con KV hay que coser las partes.
  if (libro.almacen === 'r2') {
    return servirDesdeR2(c, libro.clave_archivo, libro.formato, descarga);
  }

  const idLibro = c.req.param('id');
  const total = libro.tamano;
  const tamanoParte = libro.tamano_parte || PARTE;

  // PDF.js pide trozos: sin rangos tendría que bajar el libro entero para ver
  // la página 1. Como las partes son de tamaño fijo, se calcula cuáles tocar.
  let inicio = 0;
  let fin = total - 1;
  let parcial = false;
  const cabeceraRango = c.req.header('range');
  if (cabeceraRango && total > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(cabeceraRango.trim());
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        inicio = Number(m[1]);
        fin = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      } else {
        inicio = Math.max(0, total - Number(m[2]));
      }
      if (inicio >= total || inicio > fin) {
        return new Response('Rango fuera del archivo', {
          status: 416, headers: { 'content-range': `bytes */${total}` },
        });
      }
      parcial = true;
    }
  }

  const primera = Math.floor(inicio / tamanoParte) + 1;
  const ultima = Math.floor(fin / tamanoParte) + 1;

  const flujo = new ReadableStream({
    async pull(controlador) {
      // Se emite parte por parte, recortando la primera y la última.
      for (let n = primera; n <= ultima; n++) {
        const trozo = await leerParte(c.env, idLibro, n);
        if (!trozo) { controlador.error(new Error(`Falta la parte ${n} del archivo`)); return; }
        const desdeParte = (n - 1) * tamanoParte;
        const recorteInicio = Math.max(0, inicio - desdeParte);
        const recorteFin = Math.min(trozo.byteLength, fin - desdeParte + 1);
        if (recorteFin > recorteInicio) {
          controlador.enqueue(new Uint8Array(trozo.slice(recorteInicio, recorteFin)));
        }
      }
      controlador.close();
    },
  });

  const cabeceras = new Headers({
    'content-type': FORMATOS[libro.formato] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'content-length': String(fin - inicio + 1),
  });
  if (descarga) cabeceras.set('content-disposition', descarga);
  if (parcial) {
    cabeceras.set('content-range', `bytes ${inicio}-${fin}/${total}`);
    return new Response(flujo, { status: 206, headers: cabeceras });
  }
  return new Response(flujo, { headers: cabeceras });
});

app.all('/api/*', (c) => c.json({ error: 'Ruta no encontrada' }, 404));

export default app;
