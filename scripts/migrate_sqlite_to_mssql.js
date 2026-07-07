const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const mssql = require('mssql');

const SQLITE_PATH = String(process.env.SQLITE_PATH || '').trim();
const MSSQL_SCHEMA = process.env.MSSQL_SCHEMA || 'dbo';
const BATCH_SIZE = Math.max(1, parseInt(process.env.MIGRATE_BATCH_SIZE || '1000', 10));
const DROP_EXISTING = String(process.env.MSSQL_DROP_EXISTING || '').toLowerCase() === 'true';
const CREATE_DATABASE = String(process.env.MSSQL_CREATE_DATABASE || '').toLowerCase() === 'true';
const SKIP_INDEXES = String(process.env.MSSQL_SKIP_INDEXES || '').toLowerCase() === 'true';
const SKIP_CONSTRAINTS = String(process.env.MSSQL_SKIP_CONSTRAINTS || '').toLowerCase() === 'true';

function mask(v) {
  if (!v) return '';
  return '***';
}

function getMssqlConfig() {
  const connStr = String(process.env.MSSQL_CONNECTION_STRING || '').trim();
  if (connStr) return connStr;

  const server = String(process.env.MSSQL_SERVER || '').trim();
  const database = String(process.env.MSSQL_DATABASE || '').trim();
  const user = String(process.env.MSSQL_USER || '').trim();
  const password = String(process.env.MSSQL_PASSWORD || '').trim();
  const port = parseInt(process.env.MSSQL_PORT || '1433', 10);
  const requestTimeout = parseInt(process.env.MSSQL_REQUEST_TIMEOUT || '300000', 10);
  const encrypt = String(process.env.MSSQL_ENCRYPT || '').toLowerCase() === 'true';
  const trust = String(process.env.MSSQL_TRUST_SERVER_CERT || 'true').toLowerCase() !== 'false';

  if (!server || !database) {
    throw new Error('MSSQL_SERVER y MSSQL_DATABASE son requeridos (o usa MSSQL_CONNECTION_STRING).');
  }

  if (!user || !password) {
    throw new Error('MSSQL_USER y MSSQL_PASSWORD son requeridos (o usa MSSQL_CONNECTION_STRING).');
  }

  return {
    server,
    database,
    user,
    password,
    port,
    requestTimeout,
    options: {
      encrypt,
      trustServerCertificate: trust
    }
  };
}

function mapSqliteType(sqliteType, options = {}) {
  const indexed = Boolean(options.indexed);
  const forceText = Boolean(options.forceText);
  const t = String(sqliteType || '').toUpperCase();
  if (t.includes('INT')) return { ddl: 'INT', bulk: mssql.Int };
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT') || t.includes('JSON')) {
    if (indexed) return { ddl: 'NVARCHAR(450)', bulk: mssql.NVarChar(450) };
    return { ddl: 'NVARCHAR(MAX)', bulk: mssql.NVarChar(mssql.MAX) };
  }
  if (t.includes('BLOB')) {
    if (forceText) {
      if (indexed) return { ddl: 'NVARCHAR(450)', bulk: mssql.NVarChar(450) };
      return { ddl: 'NVARCHAR(MAX)', bulk: mssql.NVarChar(mssql.MAX) };
    }
    if (indexed) return { ddl: 'VARBINARY(900)', bulk: mssql.VarBinary(900) };
    return { ddl: 'VARBINARY(MAX)', bulk: mssql.VarBinary(mssql.MAX) };
  }
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return { ddl: 'FLOAT', bulk: mssql.Float };
  if (t.includes('NUM') || t.includes('DEC')) return { ddl: 'DECIMAL(18,6)', bulk: mssql.Decimal(18, 6) };
  if (t.includes('DATE') || t.includes('TIME')) return { ddl: 'DATETIME2', bulk: mssql.DateTime2 };
  return { ddl: 'NVARCHAR(MAX)', bulk: mssql.NVarChar(mssql.MAX) };
}

function quoteIdent(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

function getSqlitePath() {
  if (!SQLITE_PATH) {
    throw new Error('SQLITE_PATH es requerido para migrar a MSSQL.');
  }
  return path.resolve(SQLITE_PATH);
}

function quoteSqliteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function ensureDatabaseExists(config) {
  if (!CREATE_DATABASE) return;
  if (typeof config === 'string') return;

  const dbName = config.database;
  const masterConfig = { ...config, database: 'master' };
  const masterPool = await mssql.connect(masterConfig);
  await masterPool.request().query(`IF DB_ID('${dbName.replace(/'/g, "''")}') IS NULL CREATE DATABASE ${quoteIdent(dbName)}`);
  await masterPool.close();
}

async function createTable(pool, tableName, columns, indexedColumns, blobTextColumns) {
  const tableIdent = `${quoteIdent(MSSQL_SCHEMA)}.${quoteIdent(tableName)}`;
  const pkCols = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const hasSingleIntPk = pkCols.length === 1 && mapSqliteType(columns.find(c => c.name === pkCols[0])?.type).ddl === 'INT';

  const colDefs = columns.map(col => {
    const indexed = indexedColumns && indexedColumns.has(col.name);
    const forceText = blobTextColumns && blobTextColumns.has(col.name);
    const mapped = mapSqliteType(col.type, { indexed, forceText });
    const isPk = pkCols.includes(col.name);
    const identity = isPk && hasSingleIntPk ? ' IDENTITY(1,1)' : '';
    const nullable = isPk ? ' NOT NULL' : (col.notnull ? ' NOT NULL' : ' NULL');
    const def = col.dflt_value ? ` DEFAULT ${col.dflt_value}` : '';
    return `${quoteIdent(col.name)} ${mapped.ddl}${identity}${nullable}${def}`;
  });

  let pkClause = '';
  if (!SKIP_CONSTRAINTS && pkCols.length > 0) {
    pkClause = `, CONSTRAINT ${quoteIdent(`PK_${tableName}`)} PRIMARY KEY (${pkCols.map(quoteIdent).join(', ')})`;
  }

  const createSql = `CREATE TABLE ${tableIdent} (${colDefs.join(', ')}${pkClause})`;

  try {
    if (DROP_EXISTING) {
      await pool.request().query(`IF OBJECT_ID('${MSSQL_SCHEMA}.${tableName}', 'U') IS NOT NULL DROP TABLE ${tableIdent}`);
      await pool.request().query(createSql);
    } else {
      await pool.request().query(`IF OBJECT_ID('${MSSQL_SCHEMA}.${tableName}', 'U') IS NULL ${createSql}`);
    }
  } catch (err) {
    console.error(`❌ Error creando tabla ${tableName}:`, err && err.message ? err.message : err);
    console.error('SQL:', createSql);
    throw err;
  }
}

async function createIndexes(pool, db, tableName, columns, blobTextColumns) {
  if (SKIP_INDEXES) {
    console.warn(`⚠️  Índices omitidos en ${tableName} (MSSQL_SKIP_INDEXES=true)`);
    return;
  }
  const idxList = await all(db, `PRAGMA index_list('${tableName.replace(/'/g, "''")}')`);
  for (const idx of idxList) {
    if (!idx || idx.origin === 'pk') continue;
    const cols = await all(db, `PRAGMA index_info('${idx.name.replace(/'/g, "''")}')`);
    if (!cols.length) continue;
    const hasMax = cols.some(c => {
      const colInfo = columns.find(col => col.name === c.name);
      if (!colInfo) return false;
      const forceText = blobTextColumns && blobTextColumns.has(colInfo.name);
      const mapped = mapSqliteType(colInfo.type, { indexed: true, forceText });
      return String(mapped.ddl || '').toUpperCase().includes('MAX');
    });
    if (hasMax) {
      console.warn(`⚠️  Índice omitido en ${tableName}: ${idx.name} (columna MAX)`);
      continue;
    }
    const idxName = idx.name || `IX_${tableName}_${Math.random().toString(16).slice(2, 8)}`;
    const unique = idx.unique ? 'UNIQUE' : '';
    const colList = cols.map(c => quoteIdent(c.name)).join(', ');
    const sql = `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${idxName.replace(/'/g, "''")}') CREATE ${unique} INDEX ${quoteIdent(idxName)} ON ${quoteIdent(MSSQL_SCHEMA)}.${quoteIdent(tableName)} (${colList})`;
    try {
      await pool.request().query(sql);
    } catch (e) {
      console.warn(`⚠️  Índice falló en ${tableName}: ${idxName} (${e && e.message ? e.message : e})`);
    }
  }
}

async function bulkInsert(pool, tableName, columns, rows, blobTextColumns) {
  if (!rows.length) return;
  const table = new mssql.Table(tableName);
  table.schema = MSSQL_SCHEMA;
  table.create = false;

  const pkCols = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const hasSingleIntPk = pkCols.length === 1 && mapSqliteType(columns.find(c => c.name === pkCols[0])?.type).ddl === 'INT';
  const identityCol = hasSingleIntPk ? pkCols[0] : null;

  for (const col of columns) {
    const forceText = blobTextColumns && blobTextColumns.has(col.name);
    const mapped = mapSqliteType(col.type, { forceText });
    table.columns.add(col.name, mapped.bulk, { nullable: !col.notnull });
  }

  for (const row of rows) {
    const values = columns.map(col => row[col.name]);
    table.rows.add(...values);
  }

  const tableIdent = `${quoteIdent(MSSQL_SCHEMA)}.${quoteIdent(tableName)}`;
  try {
    if (identityCol) {
      const transaction = new mssql.Transaction(pool);
      await transaction.begin();
      const request = new mssql.Request(transaction);
      let identityOn = false;
      try {
        await request.query(`SET IDENTITY_INSERT ${tableIdent} ON`);
        identityOn = true;
        await request.bulk(table);
        await request.query(`SET IDENTITY_INSERT ${tableIdent} OFF`);
        identityOn = false;
        await transaction.commit();
      } catch (err) {
        if (identityOn) {
          try {
            await request.query(`SET IDENTITY_INSERT ${tableIdent} OFF`);
          } catch (_) {
          }
        }
        await transaction.rollback();
        throw err;
      }
    } else {
      await pool.request().bulk(table);
    }
  } catch (err) {
    console.warn(`⚠️  Bulk insert falló en ${tableName}. Intentando inserción por filas...`);
    await insertRowsFallback(pool, tableName, columns, rows, blobTextColumns);
  }
}

function normalizeValue(value, mapped) {
  if (value === undefined) return null;
  if (value === null) return null;
  const ddl = String(mapped.ddl || '').toUpperCase();
  if (ddl.includes('INT')) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' && value.trim() !== '') {
      const num = Number(value);
      if (!Number.isNaN(num)) return num;
    }
  }
  if (ddl.includes('DATE') || ddl.includes('TIME')) {
    if (value instanceof Date) return value;
    if (typeof value === 'string' && value.trim()) {
      const d = new Date(value.replace(' ', 'T'));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return value;
}

async function insertRowsFallback(pool, tableName, columns, rows, blobTextColumns) {
  if (!rows.length) return;

  const tableIdent = `${quoteIdent(MSSQL_SCHEMA)}.${quoteIdent(tableName)}`;
  const pkCols = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const hasSingleIntPk = pkCols.length === 1 && mapSqliteType(columns.find(c => c.name === pkCols[0])?.type).ddl === 'INT';
  const identityCol = hasSingleIntPk ? pkCols[0] : null;

  const colList = columns.map(col => quoteIdent(col.name)).join(', ');

  if (identityCol) {
    const maxRows = Math.max(1, Math.floor(2000 / Math.max(1, columns.length)));
    for (let start = 0; start < rows.length; start += maxRows) {
      const batchRows = rows.slice(start, start + maxRows);
      const request = pool.request();
      request.multiple = true;
      const statements = [`SET IDENTITY_INSERT ${tableIdent} ON`];

      batchRows.forEach((row, rowIndex) => {
        const paramNames = columns.map((_, colIndex) => `@p${rowIndex}_${colIndex}`);
        columns.forEach((col, colIndex) => {
          const forceText = blobTextColumns && blobTextColumns.has(col.name);
          const mapped = mapSqliteType(col.type, { forceText });
          request.input(`p${rowIndex}_${colIndex}`, mapped.bulk, normalizeValue(row[col.name], mapped));
        });
        statements.push(`INSERT INTO ${tableIdent} (${colList}) VALUES (${paramNames.join(', ')})`);
      });

      statements.push(`SET IDENTITY_INSERT ${tableIdent} OFF`);
      await request.query(statements.join('; '));
    }
    return;
  }

  const ps = new mssql.PreparedStatement(pool);
  const paramList = columns.map((_, i) => `@p${i}`).join(', ');

  columns.forEach((col, i) => {
    const forceText = blobTextColumns && blobTextColumns.has(col.name);
    const mapped = mapSqliteType(col.type, { forceText });
    ps.input(`p${i}`, mapped.bulk);
  });

  try {
    await ps.prepare(`INSERT INTO ${tableIdent} (${colList}) VALUES (${paramList})`);
    for (const row of rows) {
      const params = {};
      columns.forEach((col, i) => {
        const forceText = blobTextColumns && blobTextColumns.has(col.name);
        const mapped = mapSqliteType(col.type, { forceText });
        params[`p${i}`] = normalizeValue(row[col.name], mapped);
      });
      await ps.execute(params);
    }
    await ps.unprepare();
  } catch (err) {
    try {
      await ps.unprepare();
    } catch (unprepErr) {
      console.warn('⚠️  No se pudo cerrar prepared statement:', unprepErr && unprepErr.message ? unprepErr.message : unprepErr);
    }
    console.error(`❌ Error insertando filas en ${tableName}:`, err && err.message ? err.message : err);
    throw err;
  }
}

async function getIndexedColumns(db, tableName, columns) {
  const indexed = new Set();
  (columns || []).forEach(c => { if (c && c.pk > 0) indexed.add(c.name); });
  const idxList = await all(db, `PRAGMA index_list('${tableName.replace(/'/g, "''")}')`);
  for (const idx of idxList) {
    if (!idx) continue;
    const cols = await all(db, `PRAGMA index_info('${idx.name.replace(/'/g, "''")}')`);
    cols.forEach(c => indexed.add(c.name));
  }
  return indexed;
}

async function getBlobTextColumns(db, tableName, columns) {
  const textBlobs = new Set();
  const tableIdent = quoteSqliteIdent(tableName);

  for (const col of columns) {
    const t = String(col.type || '').toUpperCase();
    if (!t.includes('BLOB')) continue;
    const colIdent = quoteSqliteIdent(col.name);
    const rows = await all(db, `SELECT typeof(${colIdent}) as t FROM ${tableIdent} WHERE ${colIdent} IS NOT NULL LIMIT 1`);
    if (rows.length && rows[0] && rows[0].t === 'text') {
      textBlobs.add(col.name);
    }
  }

  return textBlobs;
}

async function migrateTable(pool, db, tableName) {
  const columns = await all(db, `PRAGMA table_info('${tableName.replace(/'/g, "''")}')`);
  const indexedColumns = await getIndexedColumns(db, tableName, columns);
  const blobTextColumns = await getBlobTextColumns(db, tableName, columns);
  await createTable(pool, tableName, columns, indexedColumns, blobTextColumns);
  await createIndexes(pool, db, tableName, columns, blobTextColumns);

  let offset = 0;
  while (true) {
    const rows = await all(db, `SELECT * FROM "${tableName}" LIMIT ${BATCH_SIZE} OFFSET ${offset}`);
    if (!rows.length) break;
    await bulkInsert(pool, tableName, columns, rows, blobTextColumns);
    offset += rows.length;
    console.log(`  ${tableName}: ${offset} filas migradas...`);
  }
}

async function main() {
  const sqlitePath = getSqlitePath();
  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite no encontrado: ${sqlitePath}`);
    process.exit(1);
  }

  const config = getMssqlConfig();
  console.log('SQLite:', sqlitePath);
  if (typeof config === 'string') {
    console.log('MSSQL: connection string (oculto)');
  } else {
    console.log('MSSQL:', {
      server: config.server,
      database: config.database,
      user: config.user,
      password: mask(config.password),
      port: config.port
    });
  }

  await ensureDatabaseExists(config);

  const db = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
  const pool = await mssql.connect(config);

  const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const t of tables) {
    const tableName = t.name;
    console.log(`Migrando tabla: ${tableName}`);
    await migrateTable(pool, db, tableName);
  }

  await pool.close();
  db.close();
  console.log('✅ Migración completada');
}

main().catch(err => {
  console.error('❌ Error en migración:', err && err.message ? err.message : err);
  process.exit(1);
});
