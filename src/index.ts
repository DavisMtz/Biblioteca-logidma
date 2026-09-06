import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
  LIBROS: R2Bucket;
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
const PARTE = 10 * 1024 * 1024;       // 10 MiB por parte

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
  const libro = await c.env.DB.prepare(`SELECT clave_r2 FROM libros WHERE id = ?`)
    .bind(c.req.param('id')).first<{ clave_r2: string }>();
  if (!libro) return c.json({ error: 'No existe ese libro' }, 404);
  await c.env.LIBROS.delete(libro.clave_r2);
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
  const clave = `libros/${idSubida}.${extension(nombre)}`;
  const multi = await c.env.LIBROS.createMultipartUpload(clave, {
    httpMetadata: {
      contentType: FORMATOS[extension(nombre)],
      contentDisposition: `inline; filename="${encodeURIComponent(nombre)}"`,
    },
  });
  await c.env.DB.prepare(
    `INSERT INTO subidas (id, clave_r2, upload_id, nombre_archivo, creado_en) VALUES (?,?,?,?,?)`,
  ).bind(idSubida, clave, multi.uploadId, nombre, ahora()).run();
  return c.json({ id: idSubida, clave, formato, tamanoParte: PARTE });
});

app.put('/api/subir/parte', soloAdmin, async (c) => {
  const idSubida = c.req.query('id') || '';
  const numero = Number(c.req.query('n') || 0);
  if (!idSubida || !numero) return c.json({ error: 'Falta id o número de parte' }, 400);
  const fila = await c.env.DB.prepare(`SELECT clave_r2, upload_id FROM subidas WHERE id = ?`)
    .bind(idSubida).first<{ clave_r2: string; upload_id: string }>();
  if (!fila) return c.json({ error: 'Subida no encontrada' }, 404);
  const multi = c.env.LIBROS.resumeMultipartUpload(fila.clave_r2, fila.upload_id);
  const parte = await multi.uploadPart(numero, c.req.raw.body!);
  return c.json({ partNumber: parte.partNumber, etag: parte.etag });
});

app.post('/api/subir/completar', soloAdmin, async (c) => {
  const datos = await c.req.json<{
    id: string; partes: { partNumber: number; etag: string }[];
    titulo?: string; autor?: string; descripcion?: string; categoria?: string;
    anio?: number; portada_url?: string; paginas?: number; estado?: string; tamano?: number;
  }>();
  const fila = await c.env.DB.prepare(`SELECT clave_r2, upload_id, nombre_archivo FROM subidas WHERE id = ?`)
    .bind(datos.id).first<{ clave_r2: string; upload_id: string; nombre_archivo: string }>();
  if (!fila) return c.json({ error: 'Subida no encontrada' }, 404);

  const multi = c.env.LIBROS.resumeMultipartUpload(fila.clave_r2, fila.upload_id);
  await multi.complete(datos.partes);

  const formato = formatoDe(fila.nombre_archivo)!;
  const t = ahora();
  await c.env.DB.prepare(
    `INSERT INTO libros (id, titulo, autor, descripcion, categoria, anio, formato, clave_r2,
                         nombre_archivo, tamano, portada_url, paginas, estado, creado_en, actualizado_en)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    datos.id,
    (datos.titulo || fila.nombre_archivo.replace(/\.[^.]+$/, '')).slice(0, 300),
    datos.autor || '', datos.descripcion || '', datos.categoria || '',
    datos.anio || null, formato, fila.clave_r2, fila.nombre_archivo,
    datos.tamano || 0, datos.portada_url || '', datos.paginas || null,
    datos.estado === 'borrador' ? 'borrador' : 'publicado', t, t,
  ).run();
  await c.env.DB.prepare(`DELETE FROM subidas WHERE id = ?`).bind(datos.id).run();

  const libro = await c.env.DB.prepare(`SELECT * FROM libros WHERE id = ?`).bind(datos.id).first();
  return c.json({ libro });
});

app.post('/api/subir/cancelar', soloAdmin, async (c) => {
  const { id: idSubida } = await c.req.json<{ id: string }>();
  const fila = await c.env.DB.prepare(`SELECT clave_r2, upload_id FROM subidas WHERE id = ?`)
    .bind(idSubida).first<{ clave_r2: string; upload_id: string }>();
  if (fila) {
    await c.env.LIBROS.resumeMultipartUpload(fila.clave_r2, fila.upload_id).abort().catch(() => {});
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

/* ---------- servir el archivo desde R2, con soporte de rangos ---------- */

app.get('/archivo/:id', async (c) => {
  const libro = await c.env.DB.prepare(
    `SELECT clave_r2, formato, nombre_archivo, estado FROM libros WHERE id = ?`,
  ).bind(c.req.param('id')).first<{ clave_r2: string; formato: string; nombre_archivo: string; estado: string }>();
  if (!libro) return c.text('No existe', 404);
  if (libro.estado !== 'publicado' && !(await sesionValida(c))) return c.text('No existe', 404);

  const cabeceraRango = c.req.header('range');
  // PDF.js pide trozos: sin rangos tendría que bajar el libro entero para ver la página 1.
  let rango: R2Range | undefined;
  if (cabeceraRango) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(cabeceraRango.trim());
    if (m) {
      if (m[1] && m[2]) rango = { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
      else if (m[1]) rango = { offset: Number(m[1]) };
      else if (m[2]) rango = { suffix: Number(m[2]) };
    }
  }

  const objeto = await c.env.LIBROS.get(libro.clave_r2, rango ? { range: rango } : undefined);
  if (!objeto) return c.text('Archivo no encontrado en el almacén', 404);

  const cabeceras = new Headers();
  objeto.writeHttpMetadata(cabeceras);
  cabeceras.set('etag', objeto.httpEtag);
  cabeceras.set('accept-ranges', 'bytes');
  cabeceras.set('cache-control', 'private, max-age=3600');
  if (!cabeceras.get('content-type')) {
    cabeceras.set('content-type', FORMATOS[libro.formato] || 'application/octet-stream');
  }
  if (c.req.query('descargar') === '1') {
    cabeceras.set('content-disposition', `attachment; filename="${encodeURIComponent(libro.nombre_archivo)}"`);
  }

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
});

app.all('/api/*', (c) => c.json({ error: 'Ruta no encontrada' }, 404));

export default app;
