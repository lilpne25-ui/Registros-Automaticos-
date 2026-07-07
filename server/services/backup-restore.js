const fs = require('fs');
const path = require('path');

const VALID_LOT_PREFIXES = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];

function getDefaultDataRoot() {
  const runtimeEnvPath = String(process.env.LASERCONTROL_ENV_PATH || '').trim();
  if (runtimeEnvPath) return path.dirname(runtimeEnvPath);
  return process.cwd();
}

function getBackupDir() {
  const configured = String(process.env.LASER_BACKUP_DIR || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(getDefaultDataRoot(), 'backups');
}

function getBackupKeepCount() {
  const raw = Number.parseInt(String(process.env.LASER_BACKUP_KEEP_COUNT || '30').trim(), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return raw;
}

function ensureBackupDir() {
  const backupDir = getBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function buildBackupFileName(label = '') {
  const iso = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const safeLabel = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `laser-control-backup-${iso}${safeLabel ? `-${safeLabel}` : ''}.json`;
}

function resolveBackupPath(fileName) {
  const safeName = path.basename(String(fileName || '').trim());
  if (!safeName || safeName !== fileName) {
    throw new Error('fileName invalido');
  }
  return path.join(ensureBackupDir(), safeName);
}

async function buildLotsExport(db) {
  const allLotes = await db.getAllLots();
  const lotes = allLotes.filter((lot) => (
    VALID_LOT_PREFIXES.some((prefix) => lot.id === prefix || lot.id.startsWith(prefix))
  ));

  const result = {};
  for (const lot of lotes) {
    const pieces = await db.getPiecesInLot(lot.id);
    const metrics = await db.getLotMetrics(lot.id);
    result[lot.id] = {
      name: lot.name,
      process: lot.process,
      pieces,
      laserMetrics: metrics.find((item) => item.metric_type === 'laser')?.data || {},
      pavonadoMetrics: metrics.find((item) => item.metric_type === 'pavonado')?.data || {},
      metadata: lot.metadata || {}
    };
  }

  return result;
}

async function safeAll(allSql, database, sql, params = []) {
  try {
    return await allSql(database, sql, params);
  } catch (error) {
    return [];
  }
}

async function safeRun(runSql, database, sql, params = []) {
  try {
    return await runSql(database, sql, params);
  } catch (error) {
    return null;
  }
}

async function collectBackupArtifact(ctx) {
  const {
    db,
    allSql,
    readAllowedGroupsDb,
    readAllowedGroupsFile
  } = ctx;

  const database = db.getDb();
  const lots = await buildLotsExport(db);

  const snapshotsMeta = await db.getAllMonthlySnapshots().catch(() => []);
  const monthlySnapshots = [];
  for (const item of snapshotsMeta) {
    const full = await db.getMonthlySnapshot(item.id).catch(() => null);
    if (!full) continue;
    monthlySnapshots.push({
      month: full.month,
      year: full.year,
      reportType: full.report_type,
      label: full.label,
      createdAt: full.created_at,
      snapshotData: full.snapshot_data
    });
  }

  let allowedGroups = [];
  try {
    allowedGroups = await readAllowedGroupsDb(database);
  } catch (error) {
    allowedGroups = [];
  }
  if (!allowedGroups.length) {
    try {
      allowedGroups = readAllowedGroupsFile();
    } catch (error) {
      allowedGroups = [];
    }
  }

  const authUsers = await safeAll(
    allSql,
    database,
    'SELECT username, password_hash, role, permissions_json, active, created_at, updated_at FROM auth_users ORDER BY username ASC'
  );

  const systemKv = await safeAll(
    allSql,
    database,
    'SELECT key, value, updated_at FROM system_kv ORDER BY key ASC'
  );

  return {
    meta: {
      format: 'laser-control-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      dbKind: db.isMssql ? 'mssql' : 'sqlite',
      dbPath: typeof db.getDbPath === 'function' ? db.getDbPath() : null
    },
    data: {
      lots,
      monthlySnapshots,
      allowedGroups,
      authUsers,
      systemKv
    }
  };
}

function pruneBackupFiles() {
  const keepCount = getBackupKeepCount();
  const files = listBackupFiles();
  if (files.length <= keepCount) {
    return {
      keepCount,
      deleted: []
    };
  }

  const deleted = [];
  for (const file of files.slice(keepCount)) {
    try {
      fs.unlinkSync(file.filePath);
      deleted.push(file.fileName);
    } catch (error) {
      // ignore prune failures and keep creating the fresh backup
    }
  }

  return { keepCount, deleted };
}

async function createBackupFile(ctx, { label = '' } = {}) {
  const artifact = await collectBackupArtifact(ctx);
  const backupDir = ensureBackupDir();
  const fileName = buildBackupFileName(label);
  const filePath = path.join(backupDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf8');
  const retention = pruneBackupFiles();

  return {
    fileName,
    filePath,
    backupDir,
    artifact,
    stats: fs.statSync(filePath),
    retention
  };
}

function listBackupFiles() {
  const backupDir = ensureBackupDir();
  return fs.readdirSync(backupDir)
    .filter((fileName) => fileName.toLowerCase().endsWith('.json'))
    .map((fileName) => {
      const filePath = path.join(backupDir, fileName);
      const stats = fs.statSync(filePath);
      return {
        fileName,
        filePath,
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function readBackupFile(fileName) {
  const filePath = resolveBackupPath(fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error('Backup no encontrado');
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const artifact = JSON.parse(raw);
  return { filePath, artifact };
}

async function restoreBackupArtifact(ctx, artifact, options = {}) {
  const {
    db,
    runSql,
    writeAllowedGroupsDb,
    writeAllowedGroupsFile,
    setAllowedGroups,
    ensureAuthUsersTable
  } = ctx;

  const restoreAuthUsers = options.restoreAuthUsers === true;
  const lots = artifact?.data?.lots;
  if (!lots || typeof lots !== 'object' || Array.isArray(lots)) {
    throw new Error('Backup invalido: falta data.lots');
  }

  const monthlySnapshots = Array.isArray(artifact?.data?.monthlySnapshots)
    ? artifact.data.monthlySnapshots
    : [];
  const allowedGroups = Array.isArray(artifact?.data?.allowedGroups)
    ? artifact.data.allowedGroups
    : [];
  const systemKv = Array.isArray(artifact?.data?.systemKv)
    ? artifact.data.systemKv
    : [];
  const authUsers = Array.isArray(artifact?.data?.authUsers)
    ? artifact.data.authUsers
    : [];

  const database = db.getDb();

  await safeRun(runSql, database, 'DELETE FROM pieces');
  await safeRun(runSql, database, 'DELETE FROM lot_metrics');
  await safeRun(runSql, database, 'DELETE FROM sync_log');
  await safeRun(runSql, database, 'DELETE FROM monthly_snapshots');
  await safeRun(runSql, database, 'DELETE FROM system_kv');
  await safeRun(runSql, database, 'DELETE FROM lotes');

  if (restoreAuthUsers && typeof ensureAuthUsersTable === 'function') {
    await ensureAuthUsersTable(database);
    await safeRun(runSql, database, 'DELETE FROM auth_users');
  }

  const lotEntries = Object.entries(lots);
  for (const [lotId, lotData] of lotEntries) {
    await db.saveLot(
      lotId,
      lotData?.name || lotId,
      lotData?.process || 'all',
      lotData?.metadata || {}
    );

    if (lotData?.laserMetrics && Object.keys(lotData.laserMetrics).length) {
      await db.saveLotMetrics(lotId, 'laser', lotData.laserMetrics);
    }
    if (lotData?.pavonadoMetrics && Object.keys(lotData.pavonadoMetrics).length) {
      await db.saveLotMetrics(lotId, 'pavonado', lotData.pavonadoMetrics);
    }

    const pieces = Array.isArray(lotData?.pieces) ? lotData.pieces : [];
    for (const piece of pieces) {
      await db.savePiece({
        ...piece,
        lot_id: lotId
      });
    }
  }

  if (!lotEntries.some(([lotId]) => lotId === 'lotes')) {
    await db.saveLot('lotes', 'LOTES', 'all', { system: true });
  }

  for (const item of monthlySnapshots) {
    const saved = await db.saveMonthlySnapshot(
      item.month,
      item.year,
      item.reportType || 'all',
      item.label || `${item.month}/${item.year}`,
      item.snapshotData || {}
    );
    if (saved?.id && item.createdAt && typeof db.updateMonthlySnapshotMeta === 'function') {
      await db.updateMonthlySnapshotMeta(saved.id, { createdAt: item.createdAt });
    }
  }

  if (systemKv.length) {
    await safeRun(
      runSql,
      database,
      'CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)'
    );
    for (const row of systemKv) {
      await safeRun(
        runSql,
        database,
        'INSERT INTO system_kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [row.key, row.value, row.updated_at || new Date().toISOString()]
      );
    }
  }

  if (allowedGroups.length) {
    if (typeof writeAllowedGroupsDb === 'function') {
      await writeAllowedGroupsDb(database, allowedGroups);
    }
    if (typeof writeAllowedGroupsFile === 'function') {
      writeAllowedGroupsFile(allowedGroups);
    }
    if (typeof setAllowedGroups === 'function') {
      setAllowedGroups(allowedGroups, 'db');
    }
  }

  if (restoreAuthUsers && authUsers.length && typeof ensureAuthUsersTable === 'function') {
    await ensureAuthUsersTable(database);
    for (const row of authUsers) {
      await safeRun(
        runSql,
        database,
        'INSERT INTO auth_users (username, password_hash, role, permissions_json, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))',
        [
          row.username,
          row.password_hash,
          row.role || 'viewer',
          row.permissions_json || '[]',
          row.active === false ? 0 : 1,
          row.created_at || null,
          row.updated_at || null
        ]
      );
    }
  }

  return {
    restoredLots: lotEntries.length,
    restoredSnapshots: monthlySnapshots.length,
    restoredAllowedGroups: allowedGroups.length,
    restoredAuthUsers: restoreAuthUsers ? authUsers.length : 0,
    restoredSystemKv: systemKv.length
  };
}

async function restoreBackupFile(ctx, fileName, options = {}) {
  const { artifact, filePath } = readBackupFile(fileName);
  const summary = await restoreBackupArtifact(ctx, artifact, options);
  return {
    fileName: path.basename(filePath),
    filePath,
    summary
  };
}

module.exports = {
  createBackupFile,
  listBackupFiles,
  readBackupFile,
  restoreBackupFile,
  restoreBackupArtifact,
  collectBackupArtifact,
  getBackupDir,
  getBackupKeepCount
};
