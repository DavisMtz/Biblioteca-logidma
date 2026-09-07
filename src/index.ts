import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
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

/* La galleta de quien solo lee. Dura mucho más que la de administración porque
   no abre nada: con la biblioteca cerrada solo demuestra que en su día supo la
   clave. Pedírsela cada doce horas a quien va por la mitad de un libro sería un
   castigo, y la clave la reparte una persona a mano, no un formulario. */
const COOKIE_LECTOR = 'bib_lector';
const DURACION_LECTOR = 60 * 60 * 24 * 30; // 30 días
// Los archivos se guardan troceados en KV: el tope por valor es de 25 MiB y
// cada trozo es una escritura (1000 al día en el plan gratuito).
// R2 exige que todas las partes midan lo mismo salvo la última, y al menos 5 MiB.
const PARTE = 5 * 1024 * 1024;        // 5 MiB por parte
const claveR2 = (id: string, ext: string) => `libros/${id}.${ext}`;

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

type Ajustes = {
  hash: string | null;        // resumen de la contraseña de administración
  generacion: number;         // sube al cambiarla, y tira las sesiones abiertas
  acceso: string;             // 'publico' | 'clave'
  guardada: string;           // la clave de lectura, cifrada
  generacionLectura: number;  // sube al cambiar el acceso, y tira a los lectores
};
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
async function ajustes(c: any): Promise<Ajustes> {
  const guardado = c.get('ajustes');
  if (guardado) return guardado;
  const { results } = await c.env.DB.prepare(
    `SELECT clave, valor FROM ajustes
      WHERE clave IN ('clave_admin', 'generacion', 'acceso', 'clave_lectura', 'generacion_lectura')`,
  ).all<{ clave: string; valor: string }>();
  const mapa: Record<string, string> = Object.fromEntries(
    (results || []).map((f: { clave: string; valor: string }) => [f.clave, f.valor]),
  );
  const datos: Ajustes = {
    hash: mapa.clave_admin || null,
    generacion: Number(mapa.generacion || 1),
    // Sin fila, abierta: es como funcionaba antes de que esto existiera, y
    // cerrarla por omisión dejaría a todo el mundo fuera sin haberlo pedido.
    acceso: mapa.acceso === 'clave' ? 'clave' : 'publico',
    guardada: mapa.clave_lectura || '',
    generacionLectura: Number(mapa.generacion_lectura || 1),
  };
  c.set('ajustes', datos);
  return datos;
}

/** Escribe un ajuste, creándolo si no estaba. */
const guardarAjuste = (c: any, clave: string, valor: string, cuando: string) =>
  c.env.DB.prepare(
    `INSERT INTO ajustes (clave, valor, actualizado_en) VALUES (?, ?, ?)
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`,
  ).bind(clave, valor, cuando);

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

/**
 * Comprueba una galleta firmada: que la firma sea nuestra, que no haya
 * caducado, que sea de quien dice ser y que su generación siga en curso.
 */
async function galletaValida(
  c: any, nombre: string, quien: string, generacion: number,
): Promise<boolean> {
  const galleta = getCookie(c, nombre);
  if (!galleta) return false;
  const corte = galleta.lastIndexOf('.');
  if (corte < 1) return false;
  const cuerpo = galleta.slice(0, corte);
  const esperada = await firmar(cuerpo, c.env.SESSION_SECRET);
  if (!igual(galleta.slice(corte + 1), esperada)) return false;

  const [tipo, exp, gen] = cuerpo.split(':');
  // El tipo va firmado dentro: una galleta de lector no puede hacerse pasar por
  // una de administración aunque alguien la cambie de nombre.
  if (tipo !== quien) return false;
  if (Number(exp || 0) <= Math.floor(Date.now() / 1000)) return false;
  // La generación sube al cambiar la contraseña o el acceso: lo viejo cae.
  return Number(gen || 0) === generacion;
}

async function sesionValida(c: any): Promise<boolean> {
  const { generacion } = await ajustes(c);
  return galletaValida(c, COOKIE, 'admin', generacion);
}

/** Quien no administra, pero ya demostró que sabe la clave de lectura. */
async function sesionDeLector(c: any): Promise<boolean> {
  const { generacionLectura } = await ajustes(c);
  return galletaValida(c, COOKIE_LECTOR, 'lector', generacionLectura);
}

/**
 * Si esta petición puede ver los libros. Con la biblioteca abierta, cualquiera;
 * cerrada, quien administra o quien trae la galleta de lector.
 */
async function puedeLeer(c: any): Promise<boolean> {
  const { acceso } = await ajustes(c);
  if (acceso !== 'clave') return true;
  // Quien administra entra siempre: si no, cerrar la biblioteca lo dejaría a él
  // mismo fuera. `c.get('admin')` solo está puesto bajo /api/*, de ahí el respaldo.
  if (c.get('admin') === true || (await sesionValida(c))) return true;
  return sesionDeLector(c);
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

const soloLectores = async (c: any, next: any) => {
  if (!(await puedeLeer(c))) {
    // El `codigo` lo mira el navegador para mandar a pedir la clave en vez de
    // enseñar un error que no dice qué hacer. El texto es para quien lo lea.
    return c.json(
      { error: 'La biblioteca está cerrada. Hace falta la clave para entrar.', codigo: 'acceso' },
      401,
    );
  }
  await next();
};

/* ---------- sesión ---------- */

app.get('/api/sesion', async (c) => {
  const { acceso } = await ajustes(c);
  return c.json({ admin: c.get('admin'), acceso, puede: await puedeLeer(c) });
});

async function ponerGalleta(
  c: any, nombre: string, quien: string, generacion: number, duracion: number,
) {
  const exp = Math.floor(Date.now() / 1000) + duracion;
  const cuerpo = `${quien}:${exp}:${generacion}:${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
  setCookie(c, nombre, `${cuerpo}.${await firmar(cuerpo, c.env.SESSION_SECRET)}`, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: duracion,
  });
}

async function abrirSesion(c: any) {
  const { generacion } = await ajustes(c);
  await ponerGalleta(c, COOKIE, 'admin', generacion, DURACION_SESION);
}

async function abrirSesionDeLector(c: any) {
  const { generacionLectura } = await ajustes(c);
  await ponerGalleta(c, COOKIE_LECTOR, 'lector', generacionLectura, DURACION_LECTOR);
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
    guardarAjuste(c, 'clave_admin', await hashDeClave(nueva!), t),
    guardarAjuste(c, 'generacion', String(generacion + 1), t),
  ]);

  // La sesión propia también cae: con la generación nueva, la cookie ya no vale.
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/* ---------- quién puede entrar a leer ---------- */

/* La biblioteca nace abierta: quien tenga el enlace, lee. Cerrarla pone una
   clave común —la que reparte quien administra— en vez de una cuenta por
   persona: son conocidos, no usuarios, y llevar altas y bajas para esto sobra.

   Esa clave se guarda RECUPERABLE, no en resumen, y es a propósito: no es la
   contraseña de nadie, es el código de la puerta, y quien administra tiene que
   poder volver a leerlo dentro de tres meses para dárselo a alguien más. Con un
   resumen habría que cambiarla cada vez, echando a todos los demás. A cambio va
   cifrada con SESSION_SECRET, que no vive en la base: una copia de la base sin
   el secreto del Worker no la enseña. La de administración sí va en resumen,
   que esa no se reparte y protege otra cosa. */

async function claveDeCaja(secreto: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`caja:${secreto}`));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function guardarEnCaja(texto: string, secreto: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cerrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await claveDeCaja(secreto), new TextEncoder().encode(texto),
  );
  return `v1.${b64url(iv)}.${b64url(cerrado)}`;
}

async function abrirCaja(guardado: string, secreto: string): Promise<string> {
  const [version, iv, cerrado] = String(guardado).split('.');
  if (version !== 'v1' || !iv || !cerrado) return '';
  try {
    const claro = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: deB64url(iv) }, await claveDeCaja(secreto), deB64url(cerrado),
    );
    return new TextDecoder().decode(claro);
  } catch {
    // Si cambió SESSION_SECRET, lo guardado ya no se puede abrir. Se da por
    // perdido y el panel pedirá una clave nueva; nadie se cuela por esto,
    // porque una clave vacía no la acierta nadie.
    return '';
  }
}

const claveDeLectura = async (c: any): Promise<string> =>
  abrirCaja((await ajustes(c)).guardada, c.env.SESSION_SECRET);

/* Una clave que se pueda dictar por teléfono y copiar sin equivocarse: sin las
   letras y cifras que se confunden entre sí (ni O ni 0, ni l ni 1) y partida en
   grupos de cuatro. Doce signos de treinta y uno son de sobra para una puerta
   que además tarda cuatro décimas en contestar a cada intento. */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';   // 31 signos

function claveSugerida(): string {
  const letras: string[] = [];
  while (letras.length < 12) {
    for (const n of crypto.getRandomValues(new Uint8Array(16))) {
      if (letras.length >= 12) break;
      // 248 = 8 × 31: lo que pase de ahí se descarta, que si no las primeras
      // letras del alfabeto saldrían más veces que las últimas.
      if (n < 248) letras.push(ALFABETO[n % ALFABETO.length]);
    }
  }
  return [0, 4, 8].map((i) => letras.slice(i, i + 4).join('')).join('-');
}

/* Los espacios de los extremos se quitan siempre, al ponerla y al comprobarla.
   Esta clave viaja por mensajes y se pega desde ellos: un espacio de más al
   copiar no debería dejar a nadie fuera, y en un código de puerta nunca es
   intencionado. Pero tiene que quitarse en los DOS sitios o la clave que se
   guardó no sería la que se acepta. */
const claveLimpia = (valor: unknown): string => String(valor ?? '').trim();

/** Devuelve el motivo del rechazo, o null si la clave de lectura sirve. */
function revisarClaveDeLectura(clave: string): string | null {
  if (clave.length < 6) return 'La clave de lectura debe tener al menos 6 caracteres.';
  if (clave.length > 120) return 'La clave de lectura es demasiado larga.';
  if (CLAVES_OBVIAS.includes(clave.toLowerCase().replace(/\s+/g, ''))) {
    return 'Esa clave es demasiado fácil de adivinar. Elige otra.';
  }
  return null;
}

/** Cómo está la puerta. La clave solo la ve quien administra: es quien la reparte. */
app.get('/api/acceso', async (c) => {
  const { acceso } = await ajustes(c);
  const datos: Record<string, unknown> = { modo: acceso, puede: await puedeLeer(c) };
  if (c.get('admin')) datos.clave = await claveDeLectura(c);
  return c.json(datos);
});

/** Entrar con la clave de lectura. */
app.post('/api/acceso', async (c) => {
  const { clave } = await c.req.json<{ clave?: string }>().catch(() => ({ clave: '' }));
  const { acceso } = await ajustes(c);
  if (acceso !== 'clave') return c.json({ ok: true });     // está abierta: no hay nada que pedir
  const buena = await claveDeLectura(c);
  if (!buena || !igual(claveLimpia(clave), buena)) {
    // El mismo retardo que en el acceso de administración: probar claves en
    // masa contra la puerta tampoco sale gratis.
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: 'Esa no es la clave de la biblioteca.' }, 401);
  }
  await abrirSesionDeLector(c);
  return c.json({ ok: true });
});

/** Una clave nueva para copiar. No se guarda aquí: la guarda el PUT si se acepta. */
app.get('/api/acceso/sugerencia', soloAdmin, (c) => c.json({ clave: claveSugerida() }));

app.put('/api/acceso', soloAdmin, async (c) => {
  const { modo, clave } = await c.req.json<{ modo?: string; clave?: string }>()
    .catch(() => ({} as { modo?: string; clave?: string }));
  if (modo !== 'publico' && modo !== 'clave') {
    return c.json({ error: 'No sé qué es ese modo de acceso.' }, 400);
  }

  const { acceso, generacionLectura } = await ajustes(c);
  const actual = await claveDeLectura(c);
  const t = ahora();
  const escrituras = [guardarAjuste(c, 'acceso', modo, t)];

  // Al cerrar sin escribir clave nueva se conserva la de antes: así se puede
  // abrir y volver a cerrar sin tener que repartir otra a todo el mundo.
  let nueva = actual;
  if (modo === 'clave') {
    nueva = claveLimpia(clave) || actual;
    if (!nueva) return c.json({ error: 'Para cerrar la biblioteca hace falta una clave.' }, 400);
    const problema = revisarClaveDeLectura(nueva);
    if (problema) return c.json({ error: problema }, 400);
    if (nueva !== actual) {
      escrituras.push(guardarAjuste(c, 'clave_lectura', await guardarEnCaja(nueva, c.env.SESSION_SECRET), t));
    }
  }

  // Cambiar de modo o de clave tira las sesiones de lector abiertas: si no,
  // quien entró con la clave vieja se quedaría dentro para siempre. Sin cambios
  // no se toca, que echar a todo el mundo por pulsar «Guardar» sería absurdo.
  if (modo !== acceso || nueva !== actual) {
    escrituras.push(guardarAjuste(c, 'generacion_lectura', String(generacionLectura + 1), t));
  }
  await c.env.DB.batch(escrituras);
  return c.json({ modo, clave: modo === 'clave' ? nueva : '' });
});

/* ---------- catálogo ---------- */

app.get('/api/libros', soloLectores, async (c) => {
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

app.get('/api/libros/:id', soloLectores, async (c) => {
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
    `SELECT clave_archivo FROM libros WHERE id = ?`,
  ).bind(c.req.param('id')).first<{ clave_archivo: string }>();
  if (!libro) return c.json({ error: 'No existe ese libro' }, 404);
  await c.env.LIBROS_R2.delete(libro.clave_archivo);
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
  const clave = claveR2(idSubida, extension(nombre));
  const multi = await c.env.LIBROS_R2.createMultipartUpload(clave, {
    httpMetadata: {
      contentType: FORMATOS[extension(nombre)],
      contentDisposition: `inline; filename="${encodeURIComponent(nombre)}"`,
    },
  });

  await c.env.DB.prepare(
    `INSERT INTO subidas (id, nombre_archivo, partes, creado_en, almacen, upload_id, clave_r2)
     VALUES (?,?,0,?,'r2',?,?)`,
  ).bind(idSubida, nombre, ahora(), multi.uploadId, clave).run();
  return c.json({ id: idSubida, formato, tamanoParte: PARTE });
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

  const multi = c.env.LIBROS_R2.resumeMultipartUpload(fila.clave_r2!, fila.upload_id!);
  const { etag } = await multi.uploadPart(numero, cuerpo);
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

  // El archivo no existe en R2 hasta que se cierran las partes.
  const multi = c.env.LIBROS_R2.resumeMultipartUpload(fila.clave_r2!, fila.upload_id!);
  await multi.complete(
    (datos.partes || [])
      .filter((p) => p && p.etag)
      .map((p) => ({ partNumber: p.partNumber, etag: p.etag! })),
  );

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
    datos.anio || null, formato, fila.clave_r2!, fila.nombre_archivo,
    tamano, datos.portada_url || '', datos.paginas || null,
    datos.estado === 'borrador' ? 'borrador' : 'publicado', t, t,
    partes, PARTE, 'r2',
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
    if (fila.clave_r2 && fila.upload_id) {
      await c.env.LIBROS_R2.resumeMultipartUpload(fila.clave_r2, fila.upload_id).abort().catch(() => {});
    }
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

app.get('/api/marcador/:id', soloLectores, async (c) => {
  const fila = await c.env.DB.prepare(
    `SELECT pagina FROM marcadores WHERE libro_id = ? AND lector = 'general'`,
  ).bind(c.req.param('id')).first<{ pagina: number }>();
  return c.json({ pagina: fila?.pagina || 1 });
});

app.put('/api/marcador/:id', soloLectores, async (c) => {
  const { pagina } = await c.req.json<{ pagina: number }>();
  await c.env.DB.prepare(
    `INSERT INTO marcadores (libro_id, lector, pagina, actualizado_en) VALUES (?, 'general', ?, ?)
     ON CONFLICT(libro_id, lector) DO UPDATE SET pagina = excluded.pagina, actualizado_en = excluded.actualizado_en`,
  ).bind(c.req.param('id'), Math.max(1, Number(pagina) || 1), ahora()).run();
  return c.json({ ok: true });
});

/* ---------- servir el archivo desde R2, con soporte de rangos ---------- */

/* El archivo de un libro no cambia NUNCA: el id se acuña al subirlo y cambiar
   el documento obliga a subir otro libro. Por eso se puede guardar un año y
   marcarlo `immutable`: reabrir un EPUB de veinte megas deja de costar la
   descarga entera, que en un teléfono con datos era la mitad de la espera. */
const CACHE_ARCHIVO = 'private, max-age=31536000, immutable';

/** `If-None-Match` puede traer varios etags, y el débil (`W/"…"`) vale igual. */
function etagCoincide(cabecera: string, etag: string): boolean {
  if (cabecera.trim() === '*') return true;
  const pelado = (v: string) => v.trim().replace(/^W\//, '');
  return cabecera.split(',').some((v) => pelado(v) === pelado(etag));
}

/** Servido desde R2: el propio bucket resuelve los rangos. */
async function servirDesdeR2(c: any, clave: string, formato: string, descarga: string | null) {
  const cabeceraRango = c.req.header('range');

  // Una recarga a mano se salta la caché del navegador pero manda el etag: si
  // coincide, aquí se corta y no viajan los bytes. Con rango no aplica: eso lo
  // pide PDF.js para un trozo concreto y siempre quiere la respuesta.
  const siNoCoincide = c.req.header('if-none-match');
  if (siNoCoincide && !cabeceraRango) {
    const cabeza = await c.env.LIBROS_R2.head(clave);
    if (cabeza && etagCoincide(siNoCoincide, cabeza.httpEtag)) {
      return new Response(null, {
        status: 304,
        headers: { etag: cabeza.httpEtag, 'cache-control': CACHE_ARCHIVO, 'accept-ranges': 'bytes' },
      });
    }
  }

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
  cabeceras.set('cache-control', CACHE_ARCHIVO);
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
  // Aquí no llega el middleware de /api/*, así que el guardia se pone a mano.
  if (!(await puedeLeer(c))) return c.text('La biblioteca está cerrada.', 401);
  const libro = await c.env.DB.prepare(
    `SELECT formato, nombre_archivo, estado, clave_archivo FROM libros WHERE id = ?`,
  ).bind(c.req.param('id')).first<{
    formato: string; nombre_archivo: string; estado: string; clave_archivo: string;
  }>();
  if (!libro) return c.text('No existe', 404);
  if (libro.estado !== 'publicado' && !(await sesionValida(c))) return c.text('No existe', 404);

  const descarga = c.req.query('descargar') === '1'
    ? `attachment; filename="${encodeURIComponent(libro.nombre_archivo)}"` : null;
  return servirDesdeR2(c, libro.clave_archivo, libro.formato, descarga);
});

app.all('/api/*', (c) => c.json({ error: 'Ruta no encontrada' }, 404));

export default app;
