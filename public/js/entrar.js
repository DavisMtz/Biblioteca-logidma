/* La puerta: cuando la biblioteca está cerrada, aquí se pide la clave.

   No hay cuentas ni nombres. Es una clave común que reparte quien administra,
   como el código de un portal: la biblioteca se comparte entre conocidos y una
   lista de altas y bajas para eso sobraría. */

const $ = (id) => document.getElementById(id);

/** Solo se vuelve a un sitio de esta misma biblioteca. Un destino con
    protocolo, o que empiece por dos barras, es un salto a otro dominio. */
function destinoSeguro(valor) {
  const crudo = String(valor || '');
  if (!crudo.startsWith('/') || crudo.startsWith('//') || crudo.includes('\\')) return '/';
  if (crudo.startsWith('/entrar')) return '/';        // no devolverlo a la puerta
  return crudo;
}

const destino = destinoSeguro(new URLSearchParams(location.search).get('destino'));

/* Si la biblioteca ya está abierta —o esta galleta todavía vale— no hay nada
   que pedir: llegar aquí a mano no debería dejar a nadie fuera. */
(async () => {
  try {
    const { puede } = await Bib.api('/api/acceso');
    if (puede) return location.replace(destino);
  } catch { /* sin respuesta: se le pide la clave, que es lo prudente */ }
  $('clave').focus();
  Bib.animar((tl) => tl.from('.acceso__tarjeta', {
    y: 18, opacity: 0, scale: 0.98, duration: 0.5, clearProps: 'transform,opacity',
  }));
})();

$('form-entrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('error-entrar');
  const boton = $('btn-entrar');
  error.hidden = true;
  boton.disabled = true;
  boton.textContent = 'Comprobando…';
  try {
    await Bib.api('/api/acceso', {
      method: 'POST',
      body: JSON.stringify({ clave: $('clave').value }),
    });
    location.replace(destino);
  } catch (fallo) {
    error.textContent = fallo.message;
    error.hidden = false;
    $('clave').select();
    boton.disabled = false;
    boton.textContent = 'Entrar';
  }
});
