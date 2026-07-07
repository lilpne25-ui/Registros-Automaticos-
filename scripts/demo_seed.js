/* eslint-disable no-console */

// Crea un dataset DEMO para lucir el reporte (lotes, piezas, incidencias y métricas).
// - Hace backup automático via /api/export
// - (opcional) Aplica cambios via /api/sync
//
// Uso:
//   node scripts/demo_seed.js --apply
//   node scripts/demo_seed.js --server http://localhost:3000 --apply
//
// Restaurar:
//   node scripts/demo_restore.js --file scripts/demo_backups/<backup>.json --apply

const fs = require('fs');
const path = require('path');

const DEFAULT_SERVER = 'http://localhost:3000';

function parseArgs(argv) {
  const args = { server: DEFAULT_SERVER, apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--server') args.server = argv[i + 1] || DEFAULT_SERVER;
    else if (a.startsWith('--server=')) args.server = a.split('=')[1] || DEFAULT_SERVER;
  }
  return args;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${text.slice(0, 300)}`);
  }
  return res.json();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function makeUid(prefix, partNumber, idx) {
  const safePart = String(partNumber || 'PART').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${prefix}_${safePart}_${idx}`;
}

function pickMany(arr, n, offset = 0) {
  const out = [];
  if (!Array.isArray(arr) || arr.length === 0) return out;
  for (let i = 0; i < n; i++) out.push(arr[(i + offset) % arr.length]);
  return out;
}

function buildLaserMetrics({ piezasGrabadas, retrabajo }) {
  return {
    piezas_grabadas: piezasGrabadas,
    piezas_retrabajo: retrabajo,
    tiempo_promedio: '0.75h por dispositivo',
    potencia_laser: '40 Watts (W)',
    velocidad_grabado: '2200 mm/s',
    paros_mantenimiento: '0/mes',
    cumplimiento_ficha: 'Aceptable',
    cumplimiento_cero_retrabajo: retrabajo === 0 ? '1' : '0',

    // Campos "_expected" para que el reporte se vea completo
    piezas_retrabajo_expected: '0',
    tiempo_promedio_expected: '1h por dispositivo',
    potencia_laser_expected: '40 Watts (W)',
    velocidad_grabado_expected: '2000 mm/s',
    paros_mantenimiento_expected: '1/6 mes',
    cumplimiento_ficha_expected: 'Aceptable',
    cumplimiento_cero_retrabajo_expected: '0',
  };
}

function buildPavonadoMetrics({ piezasPavonadas, defectos }) {
  return {
    piezas_pavonadas: piezasPavonadas,
    piezas_defectos: defectos,
    temp_banho: '140°C',
    tiempo_inmersion: '25 minutos',
    consumo_quimico: '22 Litros / lote',
    piezas_reprocesadas: defectos > 0 ? String(Math.min(5, defectos)) : '0',
    piezas_rechazadas: defectos > 3 ? String(defectos - 3) : '0',
    temp_ambiente: '24°C',

    piezas_defectos_expected: '0-3',
    temp_banho_expected: '140°C',
    tiempo_inmersion_expected: '25Minutos',
    consumo_quimico_expected: '25Litros / lote',
    piezas_reprocesadas_expected: '0-5',
    piezas_rechazadas_expected: 0,
    temp_ambiente_expected: '25°C',
  };
}

function buildDemoLots({ imagePool }) {
  const baseTs = Date.now();

  const demoLots = {};

  // =========================
  // LÁSER
  // =========================
  {
    const lotKey = 'laser-lot-demo-0001';
    const lotName = 'LOTE 00-01 (Láser)';
    const imgs = pickMany(imagePool, 8, 0);
    const pieces = [
      { partNumber: '150-187', quantity: 2, incidents: 1, incidentType: 'laser', proceso: 'laser', imagen: imgs[0] },
      { partNumber: '070-390', quantity: 4, incidents: 0, incidentType: '', proceso: 'laser', imagen: imgs[1] },
      { partNumber: '033-641', quantity: 6, incidents: 0, incidentType: '', proceso: 'laser', imagen: imgs[2] },
      { partNumber: '888-999', quantity: 3, incidents: 1, incidentType: 'laser', proceso: 'laser', imagen: imgs[3] },
      { partNumber: '145-020', quantity: 5, incidents: 0, incidentType: '', proceso: 'laser', imagen: imgs[4] },
    ].map((p, idx) => ({
      uid: makeUid('demo_laser_0001', p.partNumber, idx + 1),
      lot_id: lotKey,
      timestamp: new Date(baseTs - (idx * 60_000)).toISOString(),
      sourceFile: null,
      clientId: null,
      messageId: null,
      metadata: { demo: true, seededAt: new Date().toISOString() },
      ...p,
    }));

    const piezasGrabadas = pieces.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
    const retrabajo = pieces.reduce((s, p) => s + (Number(p.incidents) || 0), 0);

    demoLots[lotKey] = {
      name: lotName,
      process: 'laser',
      pieces,
      laserMetrics: buildLaserMetrics({ piezasGrabadas, retrabajo }),
      pavonadoMetrics: {},
      metadata: { demo: true, note: 'Dataset demo para aprobación', createdAt: new Date().toISOString() },
    };
  }

  {
    const lotKey = 'laser-lot-demo-0002';
    const lotName = 'LOTE 00-02 (Láser)';
    const imgs = pickMany(imagePool, 10, 10);
    const pieces = [
      { partNumber: '211-010', quantity: 12, incidents: 0, incidentType: '', proceso: 'laser', imagen: imgs[0] },
      { partNumber: '211-011', quantity: 10, incidents: 0, incidentType: '', proceso: 'laser', imagen: imgs[1] },
      { partNumber: '211-012', quantity: 8, incidents: 2, incidentType: 'laser', proceso: 'laser', imagen: imgs[2] },
      { partNumber: '211-013', quantity: 7, incidents: 1, incidentType: 'laser', proceso: 'laser', imagen: imgs[3] },
      { partNumber: '211-014', quantity: 9, incidents: 0, incidentType: '', proceso: 'laser', imagen: imgs[4] },
    ].map((p, idx) => ({
      uid: makeUid('demo_laser_0002', p.partNumber, idx + 1),
      lot_id: lotKey,
      timestamp: new Date(baseTs - (20 * 60_000) - (idx * 60_000)).toISOString(),
      sourceFile: null,
      clientId: null,
      messageId: null,
      metadata: { demo: true, seededAt: new Date().toISOString() },
      ...p,
    }));

    const piezasGrabadas = pieces.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
    const retrabajo = pieces.reduce((s, p) => s + (Number(p.incidents) || 0), 0);

    demoLots[lotKey] = {
      name: lotName,
      process: 'laser',
      pieces,
      laserMetrics: buildLaserMetrics({ piezasGrabadas, retrabajo }),
      pavonadoMetrics: {},
      metadata: { demo: true, createdAt: new Date().toISOString() },
    };
  }

  // =========================
  // PAVONADO
  // =========================
  {
    const lotKey = 'pavonado-lot-demo-0001';
    const lotName = 'LOTE 00-01 (Pavonado)';
    const imgs = pickMany(imagePool, 10, 25);
    const pieces = [
      { partNumber: 'PV-100', quantity: 20, incidents: 0, incidentType: '', proceso: 'pavonado', imagen: imgs[0] },
      { partNumber: 'PV-101', quantity: 18, incidents: 1, incidentType: 'pavonado', proceso: 'pavonado', imagen: imgs[1] },
      { partNumber: 'PV-102', quantity: 16, incidents: 0, incidentType: '', proceso: 'pavonado', imagen: imgs[2] },
      { partNumber: 'PV-103', quantity: 22, incidents: 2, incidentType: 'pavonado', proceso: 'pavonado', imagen: imgs[3] },
    ].map((p, idx) => ({
      uid: makeUid('demo_pav_0001', p.partNumber, idx + 1),
      lot_id: lotKey,
      timestamp: new Date(baseTs - (50 * 60_000) - (idx * 60_000)).toISOString(),
      sourceFile: null,
      clientId: null,
      messageId: null,
      metadata: { demo: true, seededAt: new Date().toISOString() },
      ...p,
    }));

    const piezasPavonadas = pieces.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
    const defectos = pieces.reduce((s, p) => s + (Number(p.incidents) || 0), 0);

    demoLots[lotKey] = {
      name: lotName,
      process: 'pavonado',
      pieces,
      laserMetrics: {},
      pavonadoMetrics: buildPavonadoMetrics({ piezasPavonadas, defectos }),
      metadata: { demo: true, createdAt: new Date().toISOString() },
    };
  }

  {
    const lotKey = 'pavonado-lot-demo-0002';
    const lotName = 'LOTE 00-02 (Pavonado)';
    const imgs = pickMany(imagePool, 10, 40);
    const pieces = [
      { partNumber: 'PV-200', quantity: 30, incidents: 0, incidentType: '', proceso: 'pavonado', imagen: imgs[0] },
      { partNumber: 'PV-201', quantity: 28, incidents: 1, incidentType: 'pavonado', proceso: 'pavonado', imagen: imgs[1] },
      { partNumber: 'PV-202', quantity: 26, incidents: 0, incidentType: '', proceso: 'pavonado', imagen: imgs[2] },
      { partNumber: 'PV-203', quantity: 24, incidents: 0, incidentType: '', proceso: 'pavonado', imagen: imgs[3] },
      { partNumber: 'PV-204', quantity: 22, incidents: 2, incidentType: 'pavonado', proceso: 'pavonado', imagen: imgs[4] },
    ].map((p, idx) => ({
      uid: makeUid('demo_pav_0002', p.partNumber, idx + 1),
      lot_id: lotKey,
      timestamp: new Date(baseTs - (80 * 60_000) - (idx * 60_000)).toISOString(),
      sourceFile: null,
      clientId: null,
      messageId: null,
      metadata: { demo: true, seededAt: new Date().toISOString() },
      ...p,
    }));

    const piezasPavonadas = pieces.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
    const defectos = pieces.reduce((s, p) => s + (Number(p.incidents) || 0), 0);

    demoLots[lotKey] = {
      name: lotName,
      process: 'pavonado',
      pieces,
      laserMetrics: {},
      pavonadoMetrics: buildPavonadoMetrics({ piezasPavonadas, defectos }),
      metadata: { demo: true, createdAt: new Date().toISOString() },
    };
  }

  return demoLots;
}

function hideExistingLotsForDemo(data) {
  // Para que el reporte se vea limpio, ocultamos lotes existentes cambiando process a 'all'.
  // (Los datos se restauran con el backup).
  const out = { ...data };
  for (const [lotKey, lot] of Object.entries(out)) {
    if (!lot || typeof lot !== 'object') continue;

    const isDemo = String(lotKey).includes('-demo-') || (lot.metadata && lot.metadata.demo);
    if (isDemo) continue;

    // Mantener 'lotes' como lote base. Si tenía process laser/pavonado, dejarlo en all.
    const isProcessLot = (lotKey.startsWith('laser-lot-') || lotKey.startsWith('pavonado-lot-'));
    if (isProcessLot) {
      out[lotKey] = {
        ...lot,
        process: 'all',
        name: lot.name ? `ARCHIVO - ${lot.name}` : `ARCHIVO - ${lotKey}`,
        metadata: { ...(lot.metadata || {}), demoHidden: true },
      };
    }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  const server = String(args.server || DEFAULT_SERVER).replace(/\/$/, '');

  console.log('🧪 Demo seed: server =', server);

  // 1) Backup
  const backupData = await getJson(`${server}/api/export`);
  const backupDir = path.join(__dirname, 'demo_backups');
  ensureDir(backupDir);
  const backupFile = path.join(backupDir, `backup_${nowStamp()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2), 'utf-8');
  console.log('✅ Backup creado:', backupFile);

  // 2) Pool de imágenes (de lote base 'lotes')
  let imagePool = [];
  try {
    const lotesPieces = await getJson(`${server}/api/lotes/lotes/pieces`);
    imagePool = (Array.isArray(lotesPieces) ? lotesPieces : [])
      .map((p) => p && p.imagen)
      .filter((v) => typeof v === 'string' && v.trim() !== '' && !v.startsWith('data:'))
      .slice(0, 120);
  } catch (e) {
    // fallback al export
    const lotes = backupData && backupData.lotes;
    imagePool = (Array.isArray(lotes?.pieces) ? lotes.pieces : [])
      .map((p) => p && p.imagen)
      .filter((v) => typeof v === 'string' && v.trim() !== '' && !v.startsWith('data:'))
      .slice(0, 120);
  }

  if (imagePool.length === 0) {
    console.warn('⚠️ No se encontraron imágenes en lote "lotes". El reporte demo seguirá, pero sin fotos.');
  } else {
    console.log('🖼️ Imágenes disponibles para demo:', imagePool.length);
  }

  // 3) Construir dataset demo
  const demoLots = buildDemoLots({ imagePool });

  const merged = {
    ...backupData,
    ...demoLots,
  };

  const finalData = hideExistingLotsForDemo(merged);

  // Asegurar lote base
  if (!finalData.lotes) {
    finalData.lotes = { id: 'lotes', name: 'LOTES', process: 'all', pieces: [], metadata: { system: true } };
  } else {
    finalData.lotes = { ...finalData.lotes, process: 'all' };
  }

  const summary = {
    demoLots: Object.keys(demoLots).length,
    totalLots: Object.keys(finalData).length,
  };

  console.log('📦 Dataset demo preparado:', summary);

  if (!args.apply) {
    console.log('ℹ️ Modo DRY-RUN: no se aplicaron cambios. Ejecuta con --apply para sembrar el demo.');
    process.exitCode = 0;
    return;
  }

  // 4) Aplicar
  const result = await postJson(`${server}/api/sync`, { laserGrabadoData: finalData });
  console.log('✅ Demo aplicado:', result);
  console.log('🧯 Para restaurar, usa el backup:', backupFile);
})();
