/* El hilo aparte que abre el EPUB.

   Un EPUB es un ZIP con decenas o cientos de archivos dentro, y descomprimirlos
   bloquea el hilo que lo haga durante todo ese rato. Hecho en la página, el
   teléfono se queda sin responder —ni gestos, ni botones, ni pintar— y el
   navegador acaba avisando de que la pestaña no contesta. Aquí ese trabajo va
   aparte y la interfaz sigue viva, contando el avance.

   Todo el trabajo de verdad está en `epub-zip.js`, que la página también sabe
   cargar por su cuenta si este worker no llega a arrancar. */

importScripts('/vendor/jszip.min.js', '/js/epub-zip.js');

self.onmessage = async (evento) => {
  try {
    const resultado = await EpubZip.abrir(
      evento.data.buffer,
      (porcentaje, texto) => self.postMessage({ tipo: 'progreso', porcentaje, texto }),
    );
    self.postMessage({ tipo: 'listo', ...resultado });
  } catch (error) {
    self.postMessage({ tipo: 'error', mensaje: String((error && error.message) || error) });
  }
};
