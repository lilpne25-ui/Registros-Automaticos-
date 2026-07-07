const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const oldDbPath = path.join(__dirname, '..', 'laser_grabado.db');

if (!fs.existsSync(oldDbPath)) {
  console.error('❌ No existe:', oldDbPath);
  process.exit(1);
}

const db = new sqlite3.Database(oldDbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('❌ Error abriendo BD:', err.message);
    process.exit(1);
  }
});

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

(async () => {
  try {
    console.log('📦 old DB:', oldDbPath);
    const tables = await all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    console.log('Tables:', tables.map(t => t.name));

    const cols = await all('PRAGMA table_info(pieces)');
    console.log('pieces columns:', cols.map(c => `${c.name}:${c.type}`));

    const total = await get('SELECT COUNT(*) AS c FROM pieces');
    console.log('Total rows in pieces:', total ? total.c : 0);

    const sample = await all('SELECT * FROM pieces LIMIT 3');
    console.log('Sample rows:', sample);

  } catch (e) {
    console.error('❌ Error:', e.message);
  } finally {
    db.close();
  }
})();
