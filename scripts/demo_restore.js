/* eslint-disable no-console */

// Restaura la BD a partir de un backup JSON generado por /api/export
// (por ejemplo, uno creado por scripts/demo_seed.js).
//
// Uso:
//   node scripts/demo_restore.js --file scripts/demo_backups/<backup>.json --apply
//   node scripts/demo_restore.js --latest --apply
//
const fs = require('fs');
const path = require('path');

const DEFAULT_SERVER = 'http://localhost:3000';

function parseArgs(argv) {
  const args = { server: DEFAULT_SERVER, apply: false, file: null, latest: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--latest') args.latest = true;
    else if (a === '--file') args.file = argv[i + 1] || null;
    else if (a.startsWith('--file=')) args.file = a.split('=')[1] || null;
    else if (a === '--server') args.server = argv[i + 1] || DEFAULT_SERVER;
    else if (a.startsWith('--server=')) args.server = a.split('=')[1] || DEFAULT_SERVER;
  }
  return args;
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

function findLatestBackup(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('backup_') && f.endsWith('.json'))
    .map((f) => path.join(dir, f));
  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

(async () => {
  const args = parseArgs(process.argv);
  const server = String(args.server || DEFAULT_SERVER).replace(/\/$/, '');

  const backupDir = path.join(__dirname, 'demo_backups');
  const file = args.latest ? findLatestBackup(backupDir) : args.file;

  if (!file) {
    console.error('❌ Debes indicar --file <ruta> o usar --latest');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(file)) {
    console.error('❌ No existe el archivo:', file);
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(file, 'utf-8');
  const data = JSON.parse(raw);

  const summary = { lots: Object.keys(data || {}).length, file };
  console.log('🧯 Restore: server =', server);
  console.log('📦 Backup cargado:', summary);

  if (!args.apply) {
    console.log('ℹ️ Modo DRY-RUN: no se aplicaron cambios. Ejecuta con --apply para restaurar.');
    process.exitCode = 0;
    return;
  }

  const result = await postJson(`${server}/api/sync`, { laserGrabadoData: data });
  console.log('✅ Restauración aplicada:', result);
})();
