const sqlite3 = require('sqlite3').verbose();

const dbPath = 'E:\\BASE DATOS SISTEMA DE GRABADO LASER Y PAVONADO\\laser_engraving.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('open error:', err.message || err);
    process.exit(1);
  }
});

function all(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

(async () => {
  try {
    const tableInfo = await all("PRAGMA table_info('auth_users')");
    const indexList = await all("PRAGMA index_list('auth_users')");
    const sampleRows = await all('SELECT * FROM auth_users LIMIT 1');

    const indexInfo = [];
    for (const idx of indexList) {
      if (!idx || !idx.name) continue;
      const cols = await all(`PRAGMA index_info('${String(idx.name).replace(/'/g, "''")}')`);
      indexInfo.push({ name: idx.name, unique: idx.unique, cols });
    }

    console.log('table_info', tableInfo);
    console.log('index_list', indexList);
    console.log('index_info', indexInfo);
    if (sampleRows.length) {
      const row = sampleRows[0];
      const typed = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v, type: typeof v }]));
      console.log('sample_row', typed);
    } else {
      console.log('sample_row', null);
    }
  } catch (err) {
    console.error('error:', err.message || err);
  } finally {
    db.close();
  }
})();
