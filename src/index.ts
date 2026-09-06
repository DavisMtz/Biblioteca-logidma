import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
  ARCHIVOS: KVNamespace;
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
const PARTE = 5 * 1024 * 1024;        // 5 MiB por parte
const clavePart = (id: string, n: number) => `libro:${id}:${n}`;

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

const app = new Hono<{ Bindings: Env; Variables: { admin: boolean } }>();

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

async function sesionValida(c: any): Promise<boolean> {
  const galleta = getCookie(c, COOKIE);
  if (!galleta) return false;
  const corte = galleta.lastIndexOf('.');
  if (corte < 1) return false;
  const cuerpo = galleta.slice(0, corte);
  const firma = galleta.slice(corte + 1);
  const esperada = await firmar(cuerpo, c.env.SESSION_SECRET);
  if (!igual(firma, esperada)) return false;
  const exp = Number(cuerpo.split(':')[1] || 0);
  return exp > Math.floor(Date.now() / 1000);
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

app.post('/api/sesion', async (c) => {
  const { clave } = await c.req.json<{ clave?: string }>().catch(() => ({ clave: '' }));
  if (!clave || !c.env.ADMIN_PASSWORD || !igual(clave, c.env.ADMIN_PASSWORD)) {
    // Retardo pequeño y uniforme para que probar claves en masa no sea gratis.
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: 'Contraseña incorrecta' }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + DURACION_SESION;
  const cuerpo = `admin:${exp}:${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
  const galleta = `${cuerpo}.${await firmar(cuerpo, c.env.SESSION_SECRET)}`;
  setCookie(c, COOKIE, galleta, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: DURACION_SESION,
  });
  return c.json({ ok: true });
});

app.delete('/api/sesion', (c) => {
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
  const libro = await c.env.DB.prepare(`SELECT partes FROM libros WHERE id = ?`)
    .bind(c.req.param('id')).first<{ partes: number }>();
  if (!libro) return c.json({ error: 'No existe ese libro' }, 404);
  await borrarPartes(c.env, c.req.param('id'), libro.partes);
  await c.env.DB.prepare(`DELETE FROM libros WHERE id = ?`).bind(c.req.param('id')).run();
  await c.env.DB.prepare(`DELETE FROM marcadores WHERE libro_id = ?`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

/* ---------- subida por partes ---------- */

app.post('/api/subir/iniciar', soloAdmin, async (c) => {
  const { nombre } = await c.req.json<{ nombre: string }>();
  const formato = formatoDe(nombre || '');
  if (!formato) {
    return c.json({ error: 'Formato no admitido. Usa PDF, EPUB, DOCX, ODT, RTF, TXT, HTML o MD.' }, 400);
  }
  const idSubida = id();
  await c.env.DB.prepare(
    `INSERT INTO subidas (id, nombre_archivo, partes, creado_en) VALUES (?,?,0,?)`,
  ).bind(idSubida, nombre, ahora()).run();
  return c.json({ id: idSubida, formato, tamanoParte: PARTE });
});

app.put('/api/subir/parte', soloAdmin, async (c) => {
  const idSubida = c.req.query('id') || '';
  const numero = Number(c.req.query('n') || 0);
  if (!idSubida || !numero) return c.json({ error: 'Falta id o número de parte' }, 400);
  const fila = await c.env.DB.prepare(`SELECT partes FROM subidas WHERE id = ?`)
    .bind(idSubida).first<{ partes: number }>();
  if (!fila) return c.json({ error: 'Subida no encontrada' }, 404);

  const cuerpo = await c.req.arrayBuffer();
  if (cuerpo.byteLength > PARTE) return c.json({ error: 'Parte demasiado grande' }, 413);
  await c.env.ARCHIVOS.put(clavePart(idSubida, numero), cuerpo);
  // Todas las partes miden PARTE menos la última: guardando cuál es la última
  // y cuánto pesa, el tamaño del archivo sale del servidor y no del navegador.
  await c.env.DB.prepare(
    `UPDATE subidas SET bytes_ultima = CASE WHEN ? >= partes THEN ? ELSE bytes_ultima END,
                        partes = MAX(partes, ?)
     WHERE id = ?`,
  ).bind(numero, cuerpo.byteLength, numero, idSubida).run();
  return c.json({ partNumber: numero, bytes: cuerpo.byteLength });
});

app.post('/api/subir/completar', soloAdmin, async (c) => {
  const datos = await c.req.json<{
    id: string; partes: { partNumber: number }[];
    titulo?: string; autor?: string; descripcion?: string; categoria?: string;
    anio?: number; portada_url?: string; paginas?: number; estado?: string; tamano?: number;
  }>();
  const fila = await c.env.DB.prepare(
    `SELECT nombre_archivo, partes, bytes_ultima FROM subidas WHERE id = ?`,
  ).bind(datos.id).first<{ nombre_archivo: string; partes: number; bytes_ultima: number }>();
  if (!fila) return c.json({ error: 'Subida no encontrada' }, 404);

  const partes = fila.partes;
  if (!partes) return c.json({ error: 'No se subió ninguna parte' }, 400);
  const tamano = (partes - 1) * PARTE + fila.bytes_ultima;

  const formato = formatoDe(fila.nombre_archivo)!;
  const t = ahora();
  await c.env.DB.prepare(
    `INSERT INTO libros (id, titulo, autor, descripcion, categoria, anio, formato, clave_archivo,
                         nombre_archivo, tamano, portada_url, paginas, estado, creado_en, actualizado_en,
                         partes, tamano_parte)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    datos.id,
    (datos.titulo || fila.nombre_archivo.replace(/\.[^.]+$/, '')).slice(0, 300),
    datos.autor || '', datos.descripcion || '', datos.categoria || '',
    datos.anio || null, formato, `libro:${datos.id}`, fila.nombre_archivo,
    tamano, datos.portada_url || '', datos.paginas || null,
    datos.estado === 'borrador' ? 'borrador' : 'publicado', t, t,
    partes, PARTE,
  ).run();
  await c.env.DB.prepare(`DELETE FROM subidas WHERE id = ?`).bind(datos.id).run();

  const libro = await c.env.DB.prepare(`SELECT * FROM libros WHERE id = ?`).bind(datos.id).first();
  return c.json({ libro });
});

app.post('/api/subir/cancelar', soloAdmin, async (c) => {
  const { id: idSubida } = await c.req.json<{ id: string }>();
  const fila = await c.env.DB.prepare(`SELECT partes FROM subidas WHERE id = ?`)
    .bind(idSubida).first<{ partes: number }>();
  if (fila) {
    await borrarPartes(c.env, idSubida, fila.partes);
    await c.env.DB.prepare(`DELETE FROM subidas WHERE id = ?`).bind(idSubida).run();
  }
  return c.json({ ok: true });
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

app.get('/archivo/:id', async (c) => {
  const libro = await c.env.DB.prepare(
    `SELECT formato, nombre_archivo, estado, tamano, partes, tamano_parte FROM libros WHERE id = ?`,
  ).bind(c.req.param('id')).first<{
    formato: string; nombre_archivo: string; estado: string;
    tamano: number; partes: number; tamano_parte: number;
  }>();
  if (!libro) return c.text('No existe', 404);
  if (libro.estado !== 'publicado' && !(await sesionValida(c))) return c.text('No existe', 404);

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
  if (c.req.query('descargar') === '1') {
    cabeceras.set('content-disposition', `attachment; filename="${encodeURIComponent(libro.nombre_archivo)}"`);
  }
  if (parcial) {
    cabeceras.set('content-range', `bytes ${inicio}-${fin}/${total}`);
    return new Response(flujo, { status: 206, headers: cabeceras });
  }
  return new Response(flujo, { headers: cabeceras });
});

app.all('/api/*', (c) => c.json({ error: 'Ruta no encontrada' }, 404));

export default app;
