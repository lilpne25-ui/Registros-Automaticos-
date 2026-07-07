const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Cargar .env del proyecto (para LASER_DB_PATH)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
  // noop
}

// Por defecto, usar el mismo archivo que el servidor
const dbPathArg = process.argv[2];
const envDb = (process.env.LASER_DB_PATH || process.env.SQLITE_DB_PATH || process.env.DB_PATH || '').trim();
const dbPathDefault = envDb ? envDb : path.join(__dirname, '..', 'laser_engraving.db');
const dbPath = path.resolve(dbPathArg || dbPathDefault);
const lotId = process.argv[3] || 'lotes';

if (!fs.existsSync(dbPath)) {
  console.error('❌ No existe el archivo de BD:', dbPath);
  console.error('   (Esto evita crear una BD vacía por error de carpeta actual)');
  process.exit(2);
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('❌ Error abriendo BD:', err && err.message ? err.message : err);
    process.exit(2);
  }
});

try { db.configure('busyTimeout', 5000); } catch (e) { /* noop */ }

function q(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function q1(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

(async () => {
  try {
    const st = fs.statSync(dbPath);
    console.log('DB (abs):', dbPath);
    console.log('DB size:', st.size, 'bytes');
    console.log('DB mtime:', st.mtime.toISOString());

    const dbList = await q('PRAGMA database_list');
    console.log('PRAGMA database_list:');
    console.table(dbList);

    const journal = await q1('PRAGMA journal_mode');
    console.log('PRAGMA journal_mode:', journal && (journal.journal_mode || journal['journal_mode'] || Object.values(journal)[0]));

    const tables = await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    console.log('Tables:', tables.map(t => t.name).join(', '));

    const cols = await q(`PRAGMA table_info(pieces)`);
    console.log('pieces columns:', cols.map(c => `${c.name}:${c.type}`).join(', '));

    const totalAll = await q1('SELECT COUNT(*) AS c FROM pieces');
    const totalLot = await q1('SELECT COUNT(*) AS c FROM pieces WHERE lot_id = ?', [lotId]);
    console.log('Total pieces:', totalAll?.c);
    console.log(`Total pieces in lot_id='${lotId}':`, totalLot?.c);

    const nullPart = await q1('SELECT COUNT(*) AS c FROM pieces WHERE lot_id = ? AND (partNumber IS NULL OR TRIM(partNumber) = "")', [lotId]);
    const nullImg = await q1('SELECT COUNT(*) AS c FROM pieces WHERE lot_id = ? AND (imagen IS NULL OR TRIM(imagen) = "")', [lotId]);
    const base64Img = await q1("SELECT COUNT(*) AS c FROM pieces WHERE lot_id = ? AND imagen LIKE 'data:%;base64,%'", [lotId]);
    const relImg = await q1("SELECT COUNT(*) AS c FROM pieces WHERE lot_id = ? AND imagen LIKE 'images/%'", [lotId]);
    console.log('Null/empty partNumber:', nullPart?.c);
    console.log('Null/empty imagen:', nullImg?.c);
    console.log('Base64 imagen rows:', base64Img?.c);
    console.log("'images/...' imagen rows:", relImg?.c);

    const sample = await q(
      'SELECT uid, lot_id, partNumber, quantity, timestamp, substr(imagen,1,40) AS imagenPrefix FROM pieces WHERE lot_id = ? ORDER BY timestamp DESC LIMIT 15',
      [lotId]
    );
    console.table(sample);

    const weirdLots = await q('SELECT lot_id, COUNT(*) AS c FROM pieces GROUP BY lot_id ORDER BY c DESC LIMIT 10');
    console.log('Top lot_id values:');
    console.table(weirdLots);

  } catch (e) {
    console.error('ERROR:', e);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
