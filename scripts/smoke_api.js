/* eslint-disable no-console */

// Smoke test simple para validar que la API lee la misma BD que inspeccionamos
// y que el campo `imagen` llega normalizado (basename) para /engrave/<file>.

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${text.slice(0, 300)}`);
  }
  return res.json();
}

(async () => {
  // Asegurar modo DB-only en la ejecución de prueba
  process.env.WRITE_TO_ENGRAVE_FILES = 'false';

  const { startServer, stopServer } = require('../server');

  let startedHere = false;
  try {
    // Si ya hay un server levantado, no intentar iniciar otro.
    let pieces;
    try {
      pieces = await getJson('http://localhost:3000/api/lotes/lotes/pieces');
    } catch (e) {
      await startServer();
      startedHere = true;
      await sleep(250);
      pieces = await getJson('http://localhost:3000/api/lotes/lotes/pieces');
    }
    if (!Array.isArray(pieces)) {
      throw new Error('La API no devolvió un array en /api/lotes/lotes/pieces');
    }

    const count = pieces.length;
    const badImagen = pieces.filter((p) => {
      const img = p && p.imagen;
      return typeof img === 'string' && img && !img.startsWith('data:') && /[\\/]/.test(img);
    });

    console.log('✅ /api/lotes/lotes/pieces count:', count);
    console.log('✅ imagen normalizada (sin / ni \\) - malos:', badImagen.length);

    if (count === 0) {
      throw new Error('La API devolvió 0 piezas (se esperaba > 0).');
    }

    if (badImagen.length > 0) {
      console.log('Ejemplos de imagen NO normalizada:');
      console.table(badImagen.slice(0, 10).map((p) => ({ uid: p.uid, imagen: p.imagen })));
      throw new Error('Se encontraron piezas con imagen no normalizada (contiene "/" o "\\").');
    }

    process.exitCode = 0;
  } catch (e) {
    console.error('❌ Smoke test falló:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    if (startedHere) {
      try { await stopServer(); } catch (e) { /* noop */ }
    }
    // Evitar que el proceso se quede vivo por timers/handles residuales
    await sleep(100);
  }
})();
