const mssql = require('mssql');

const MSSQL_SCHEMA = process.env.MSSQL_SCHEMA || 'dbo';
const DB_NAME = process.env.MSSQL_DATABASE || '';
const DB_SERVER = process.env.MSSQL_SERVER || '';

function quoteIdent(name) {
    return `[${String(name).replace(/]/g, ']]')}]`;
}

function tableName(name) {
    return `${quoteIdent(MSSQL_SCHEMA)}.${quoteIdent(name)}`;
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

let poolPromise = null;
let dbHandle = null;

function getPool() {
    if (!poolPromise) {
        const config = getMssqlConfig();
        poolPromise = mssql.connect(config);
    }
    return poolPromise;
}

function addInput(request, name, value) {
    if (value === undefined || value === null) {
        request.input(name, mssql.NVarChar(mssql.MAX), null);
        return;
    }
    if (typeof value === 'string') {
        request.input(name, mssql.NVarChar(mssql.MAX), value);
        return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        request.input(name, Number.isInteger(value) ? mssql.Int : mssql.Float, value);
        return;
    }
    if (typeof value === 'boolean') {
        request.input(name, mssql.Bit, value ? 1 : 0);
        return;
    }
    if (value instanceof Date) {
        request.input(name, mssql.DateTime2, value);
        return;
    }
    if (Buffer.isBuffer(value)) {
        request.input(name, mssql.VarBinary(mssql.MAX), value);
        return;
    }
    request.input(name, mssql.NVarChar(mssql.MAX), String(value));
}

function bindParams(sql, params) {
    let idx = 0;
    const names = [];
    const out = sql.replace(/\?/g, () => {
        const name = `@p${idx}`;
        names.push(name);
        idx += 1;
        return name;
    });
    return { sql: out, names };
}

function applyLimitTop(sql) {
    if (!/\s+LIMIT\s+1\s*$/i.test(sql)) return sql;
    let out = sql.replace(/\s+LIMIT\s+1\s*$/i, '');
    out = out.replace(/^\s*SELECT\s+(DISTINCT\s+)?/i, (m, distinct) => {
        return `SELECT ${distinct || ''}TOP 1 `;
    });
    return out;
}

function translateSql(sql) {
    const trimmed = String(sql || '').trim();

    if (/^INSERT\s+OR\s+IGNORE\s+INTO\s+lotes\b/i.test(trimmed)) {
        return `IF NOT EXISTS (SELECT 1 FROM ${tableName('lotes')} WHERE id = @p0)
BEGIN
  INSERT INTO ${tableName('lotes')} (id, name, [process], metadata)
  VALUES (@p0, @p1, @p2, @p3);
END`;
    }

    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+system_kv\b/i.test(trimmed)) {
        return `IF OBJECT_ID('${MSSQL_SCHEMA}.system_kv', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('system_kv')} (
    ${quoteIdent('key')} NVARCHAR(255) NOT NULL PRIMARY KEY,
    ${quoteIdent('value')} NVARCHAR(MAX) NULL,
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME()
  );
END`;
    }

    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+auth_users\b/i.test(trimmed)) {
        return `IF OBJECT_ID('${MSSQL_SCHEMA}.auth_users', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('auth_users')} (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    username NVARCHAR(255) NOT NULL UNIQUE,
    password_hash NVARCHAR(255) NOT NULL,
    role NVARCHAR(50) NULL DEFAULT 'viewer',
    permissions_json NVARCHAR(MAX) NULL DEFAULT '[]',
    active INT NULL DEFAULT 1,
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME()
  );
END`;
    }

    if (/^INSERT\s+INTO\s+system_kv\b/i.test(trimmed) && /ON\s+CONFLICT\b/i.test(trimmed)) {
        return `UPDATE ${tableName('system_kv')} SET ${quoteIdent('value')} = @p1, updated_at = SYSUTCDATETIME()
WHERE ${quoteIdent('key')} = @p0;
IF @@ROWCOUNT = 0
BEGIN
  INSERT INTO ${tableName('system_kv')} (${quoteIdent('key')}, ${quoteIdent('value')}, updated_at)
  VALUES (@p0, @p1, SYSUTCDATETIME());
END`;
    }

    let out = applyLimitTop(sql);
    out = out.replace(/(?<!CURRENT_)\btimestamp\b/gi, quoteIdent('timestamp'));
    return out;
}

async function executeRaw(handle, sql, params = []) {
    const trimmed = String(sql || '').trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('BEGIN')) {
        if (!handle._tx) {
            const pool = await getPool();
            handle._tx = new mssql.Transaction(pool);
            await handle._tx.begin();
        }
        return { rowsAffected: [0], recordset: [] };
    }

    if (upper.startsWith('COMMIT')) {
        if (handle._tx) {
            await handle._tx.commit();
            handle._tx = null;
        }
        return { rowsAffected: [0], recordset: [] };
    }

    if (upper.startsWith('ROLLBACK')) {
        if (handle._tx) {
            await handle._tx.rollback();
            handle._tx = null;
        }
        return { rowsAffected: [0], recordset: [] };
    }

    const pool = await getPool();
    const request = handle._tx ? new mssql.Request(handle._tx) : pool.request();
    request.multiple = true;

    const translated = translateSql(sql);
    const bound = bindParams(translated, params);
    bound.names.forEach((name, idx) => {
        addInput(request, name.slice(1), params[idx]);
    });

    return request.query(bound.sql);
}

function createDbHandle() {
    return {
        _tx: null,
        run(sql, params, cb) {
            let actualParams = params;
            let actualCb = cb;
            if (typeof actualParams === 'function') {
                actualCb = actualParams;
                actualParams = [];
            }
            executeRaw(this, sql, actualParams)
                .then((result) => {
                    const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
                    const ctx = { changes, lastID: null };
                    if (typeof actualCb === 'function') actualCb.call(ctx, null);
                })
                .catch((err) => {
                    if (typeof actualCb === 'function') actualCb(err);
                });
        },
        get(sql, params, cb) {
            let actualParams = params;
            let actualCb = cb;
            if (typeof actualParams === 'function') {
                actualCb = actualParams;
                actualParams = [];
            }
            executeRaw(this, sql, actualParams)
                .then((result) => {
                    const row = (result.recordset && result.recordset[0]) ? result.recordset[0] : null;
                    if (typeof actualCb === 'function') actualCb(null, row);
                })
                .catch((err) => {
                    if (typeof actualCb === 'function') actualCb(err);
                });
        },
        all(sql, params, cb) {
            let actualParams = params;
            let actualCb = cb;
            if (typeof actualParams === 'function') {
                actualCb = actualParams;
                actualParams = [];
            }
            executeRaw(this, sql, actualParams)
                .then((result) => {
                    const rows = result.recordset || [];
                    if (typeof actualCb === 'function') actualCb(null, rows);
                })
                .catch((err) => {
                    if (typeof actualCb === 'function') actualCb(err);
                });
        }
    };
}

function getDb() {
    if (!dbHandle) dbHandle = createDbHandle();
    return dbHandle;
}

async function queryWithParams(sql, params = {}) {
    const pool = await getPool();
    const request = pool.request();
    Object.entries(params).forEach(([name, value]) => addInput(request, name, value));
    return request.query(sql);
}

function normalizeImagenValue(imagen) {
    try {
        if (typeof imagen !== 'string') return imagen;
        if (!imagen) return imagen;
        if (imagen.startsWith('data:')) return imagen;

        let v = String(imagen);
        v = v.replace(/\\/g, '/');
        if (v.toLowerCase().startsWith('images/')) v = v.slice('images/'.length);
        const parts = v.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : v;
    } catch (e) {
        return imagen;
    }
}

async function initializeDatabase() {
    const sql = `
IF OBJECT_ID('${MSSQL_SCHEMA}.lotes', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('lotes')} (
    id NVARCHAR(255) NOT NULL PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    [process] NVARCHAR(50) DEFAULT 'all',
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    metadata NVARCHAR(MAX) DEFAULT '{}'
  );
END

IF OBJECT_ID('${MSSQL_SCHEMA}.pieces', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('pieces')} (
    uid NVARCHAR(255) NOT NULL PRIMARY KEY,
    lot_id NVARCHAR(255) NOT NULL,
    partNumber NVARCHAR(255) NULL,
    quantity INT DEFAULT 0,
    incidents INT DEFAULT 0,
    incidentType NVARCHAR(255) DEFAULT '',
    [timestamp] DATETIME2 DEFAULT SYSUTCDATETIME(),
    imagen NVARCHAR(MAX) NULL,
    sourceFile NVARCHAR(255) NULL,
    clientId NVARCHAR(255) NULL,
    messageId NVARCHAR(255) NULL,
    proceso NVARCHAR(255) DEFAULT '',
    metadata NVARCHAR(MAX) DEFAULT '{}'
  );
END

DECLARE @schema sysname = N'${MSSQL_SCHEMA}';
DECLARE @piecesTable sysname = N'pieces';

IF EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema
        AND TABLE_NAME = @piecesTable
        AND COLUMN_NAME = 'lot_id'
        AND DATA_TYPE = 'nvarchar'
        AND CHARACTER_MAXIMUM_LENGTH = -1
)
BEGIN
    DECLARE @lotNullable nvarchar(3) = (
        SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @piecesTable AND COLUMN_NAME = 'lot_id'
    );
    DECLARE @lotSql nvarchar(max) = N'ALTER TABLE ' + QUOTENAME(@schema) + '.' + QUOTENAME(@piecesTable)
        + ' ALTER COLUMN ' + QUOTENAME('lot_id') + ' NVARCHAR(450) ' + CASE WHEN @lotNullable = 'YES' THEN 'NULL' ELSE 'NOT NULL' END;
    EXEC sp_executesql @lotSql;
END

IF EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema
        AND TABLE_NAME = @piecesTable
        AND COLUMN_NAME = 'messageId'
        AND DATA_TYPE = 'nvarchar'
        AND CHARACTER_MAXIMUM_LENGTH = -1
)
BEGIN
    DECLARE @msgNullable nvarchar(3) = (
        SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @piecesTable AND COLUMN_NAME = 'messageId'
    );
    DECLARE @msgSql nvarchar(max) = N'ALTER TABLE ' + QUOTENAME(@schema) + '.' + QUOTENAME(@piecesTable)
        + ' ALTER COLUMN ' + QUOTENAME('messageId') + ' NVARCHAR(450) ' + CASE WHEN @msgNullable = 'YES' THEN 'NULL' ELSE 'NOT NULL' END;
    EXEC sp_executesql @msgSql;
END

IF EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema
        AND TABLE_NAME = @piecesTable
        AND COLUMN_NAME = 'clientId'
        AND DATA_TYPE = 'nvarchar'
        AND CHARACTER_MAXIMUM_LENGTH = -1
)
BEGIN
    DECLARE @clientNullable nvarchar(3) = (
        SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @piecesTable AND COLUMN_NAME = 'clientId'
    );
    DECLARE @clientSql nvarchar(max) = N'ALTER TABLE ' + QUOTENAME(@schema) + '.' + QUOTENAME(@piecesTable)
        + ' ALTER COLUMN ' + QUOTENAME('clientId') + ' NVARCHAR(450) ' + CASE WHEN @clientNullable = 'YES' THEN 'NULL' ELSE 'NOT NULL' END;
    EXEC sp_executesql @clientSql;
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_pieces_lot_id' AND object_id = OBJECT_ID('${MSSQL_SCHEMA}.pieces'))
  CREATE INDEX idx_pieces_lot_id ON ${tableName('pieces')} (lot_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_pieces_messageId' AND object_id = OBJECT_ID('${MSSQL_SCHEMA}.pieces'))
  CREATE INDEX idx_pieces_messageId ON ${tableName('pieces')} (messageId);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_pieces_clientId' AND object_id = OBJECT_ID('${MSSQL_SCHEMA}.pieces'))
  CREATE INDEX idx_pieces_clientId ON ${tableName('pieces')} (clientId);

IF OBJECT_ID('${MSSQL_SCHEMA}.lot_metrics', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('lot_metrics')} (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    lot_id NVARCHAR(255) NOT NULL,
    metric_type NVARCHAR(50) NOT NULL,
    data NVARCHAR(MAX) NULL,
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_lot_metrics UNIQUE (lot_id, metric_type)
  );
END

DECLARE @lotMetricsTable sysname = N'lot_metrics';
IF EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema
        AND TABLE_NAME = @lotMetricsTable
        AND COLUMN_NAME = 'lot_id'
        AND DATA_TYPE = 'nvarchar'
        AND CHARACTER_MAXIMUM_LENGTH = -1
)
BEGIN
    DECLARE @lmNullable nvarchar(3) = (
        SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @lotMetricsTable AND COLUMN_NAME = 'lot_id'
    );
    DECLARE @lmSql nvarchar(max) = N'ALTER TABLE ' + QUOTENAME(@schema) + '.' + QUOTENAME(@lotMetricsTable)
        + ' ALTER COLUMN ' + QUOTENAME('lot_id') + ' NVARCHAR(450) ' + CASE WHEN @lmNullable = 'YES' THEN 'NULL' ELSE 'NOT NULL' END;
    EXEC sp_executesql @lmSql;
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_lot_metrics_lot_id' AND object_id = OBJECT_ID('${MSSQL_SCHEMA}.lot_metrics'))
  CREATE INDEX idx_lot_metrics_lot_id ON ${tableName('lot_metrics')} (lot_id);

IF OBJECT_ID('${MSSQL_SCHEMA}.sync_log', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('sync_log')} (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    action NVARCHAR(255) NULL,
    entity_type NVARCHAR(255) NULL,
    entity_id NVARCHAR(255) NULL,
    data NVARCHAR(MAX) NULL,
    status NVARCHAR(50) DEFAULT 'pending',
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    synced_at DATETIME2 NULL
  );
END

IF OBJECT_ID('${MSSQL_SCHEMA}.monthly_snapshots', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('monthly_snapshots')} (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    month INT NOT NULL,
    year INT NOT NULL,
    report_type NVARCHAR(50) NOT NULL DEFAULT 'all',
    label NVARCHAR(255) NOT NULL,
    snapshot_data NVARCHAR(MAX) NOT NULL,
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_monthly_snapshots UNIQUE (month, year, report_type)
  );
END

IF OBJECT_ID('${MSSQL_SCHEMA}.auth_users', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('auth_users')} (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    username NVARCHAR(255) NOT NULL UNIQUE,
    password_hash NVARCHAR(255) NOT NULL,
    role NVARCHAR(50) NULL DEFAULT 'viewer',
    permissions_json NVARCHAR(MAX) NULL DEFAULT '[]',
    active INT NULL DEFAULT 1,
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME()
  );
END

IF OBJECT_ID('${MSSQL_SCHEMA}.system_kv', 'U') IS NULL
BEGIN
  CREATE TABLE ${tableName('system_kv')} (
    ${quoteIdent('key')} NVARCHAR(255) NOT NULL PRIMARY KEY,
    ${quoteIdent('value')} NVARCHAR(MAX) NULL,
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME()
  );
END
`;

    await queryWithParams(sql);
    console.log('✅ Tablas de BD inicializadas correctamente');
}

async function saveLot(id, name, process = 'all', metadata = {}) {
    const sql = `
UPDATE ${tableName('lotes')}
SET name = @name,
    [process] = @process,
    metadata = @metadata,
    updated_at = SYSUTCDATETIME()
WHERE id = @id;
IF @@ROWCOUNT = 0
BEGIN
  INSERT INTO ${tableName('lotes')} (id, name, [process], metadata, created_at, updated_at)
  VALUES (@id, @name, @process, @metadata, SYSUTCDATETIME(), SYSUTCDATETIME());
END`;

    await queryWithParams(sql, {
        id: String(id),
        name: String(name),
        process: String(process),
        metadata: JSON.stringify(metadata || {})
    });

    return { id, name, process, metadata };
}

async function getLot(id) {
    const sql = `SELECT TOP 1 * FROM ${tableName('lotes')} WHERE id = @id`;
    const result = await queryWithParams(sql, { id: String(id) });
    const row = result.recordset && result.recordset[0];
    if (!row) return null;
    return { ...row, metadata: JSON.parse(row.metadata || '{}') };
}

async function getAllLots() {
    const sql = `SELECT * FROM ${tableName('lotes')} ORDER BY created_at DESC`;
    const result = await queryWithParams(sql);
    return (result.recordset || []).map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata || '{}')
    }));
}

async function deleteLot(id) {
    const sql = `DELETE FROM ${tableName('lotes')} WHERE id = @id`;
    const result = await queryWithParams(sql, { id: String(id) });
    const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
    return { deleted: changes };
}

async function savePiece(piece) {
    const {
        uid, lot_id, partNumber, quantity, incidents, incidentType,
        timestamp, imagen, sourceFile, clientId, messageId, proceso, metadata
    } = piece;

    const normalizedImagen = normalizeImagenValue(imagen);

    const incomingQtyNum = (quantity === undefined || quantity === null || quantity === '') ? null : Number(quantity);
    const incomingQty = (incomingQtyNum !== null && Number.isFinite(incomingQtyNum)) ? incomingQtyNum : 0;

    const incomingPart = (partNumber !== undefined && partNumber !== null) ? String(partNumber) : '';
    const incomingPartTrim = incomingPart.trim();

    const incomingImg = normalizedImagen;
    const incomingImgIsEmpty = (incomingImg === undefined || incomingImg === null || incomingImg === '');

    const metaIn = (metadata && typeof metadata === 'object') ? metadata : {};
    const allowOverwriteQty = metaIn && metaIn.allowOverwriteQuantity === true;

    const needsExisting = (!allowOverwriteQty && incomingQty === 0) || (incomingPartTrim === '') || incomingImgIsEmpty || !metaIn || Object.keys(metaIn || {}).length === 0;

    let existingRow = null;
    if (needsExisting) {
        const rowRes = await queryWithParams(
            `SELECT TOP 1 quantity, partNumber, imagen, metadata FROM ${tableName('pieces')} WHERE uid = @uid`,
            { uid: String(uid) }
        );
        existingRow = rowRes.recordset && rowRes.recordset[0] ? rowRes.recordset[0] : null;
    }

    const existingQtyNum = existingRow ? Number(existingRow.quantity) : 0;
    const existingQty = (Number.isFinite(existingQtyNum) ? existingQtyNum : 0);

    const qtyToSave = (!allowOverwriteQty && existingRow && existingQty > 0 && incomingQty === 0)
        ? existingQty
        : Math.max(0, incomingQty);

    const partToSave = (incomingPartTrim !== '')
        ? incomingPartTrim
        : (existingRow && existingRow.partNumber ? String(existingRow.partNumber) : '');

    const imgToSave = (!incomingImgIsEmpty)
        ? incomingImg
        : (existingRow ? normalizeImagenValue(existingRow.imagen) : incomingImg);

    let metaExisting = {};
    try {
        metaExisting = existingRow && existingRow.metadata ? JSON.parse(existingRow.metadata || '{}') : {};
    } catch (e) {
        metaExisting = {};
    }

    const metaToSave = {
        ...(metaExisting || {}),
        ...(metaIn || {})
    };

    const sql = `
UPDATE ${tableName('pieces')}
SET lot_id = @lot_id,
    partNumber = @partNumber,
    quantity = @quantity,
    incidents = @incidents,
    incidentType = @incidentType,
    [timestamp] = COALESCE(@timestamp, [timestamp], SYSUTCDATETIME()),
    imagen = @imagen,
    sourceFile = @sourceFile,
    clientId = @clientId,
    messageId = @messageId,
    proceso = @proceso,
    metadata = @metadata
WHERE uid = @uid;
IF @@ROWCOUNT = 0
BEGIN
  INSERT INTO ${tableName('pieces')}
  (uid, lot_id, partNumber, quantity, incidents, incidentType, [timestamp], imagen, sourceFile, clientId, messageId, proceso, metadata)
  VALUES (@uid, @lot_id, @partNumber, @quantity, @incidents, @incidentType, COALESCE(@timestamp, SYSUTCDATETIME()), @imagen, @sourceFile, @clientId, @messageId, @proceso, @metadata);
END`;

    await queryWithParams(sql, {
        uid: String(uid),
        lot_id: String(lot_id),
        partNumber: partToSave,
        quantity: qtyToSave,
        incidents: Number.isFinite(Number(incidents)) ? Number(incidents) : 0,
        incidentType: incidentType == null ? '' : String(incidentType),
        timestamp: timestamp ? new Date(timestamp) : null,
        imagen: imgToSave,
        sourceFile: sourceFile == null ? null : String(sourceFile),
        clientId: clientId == null ? null : String(clientId),
        messageId: messageId == null ? null : String(messageId),
        proceso: proceso == null ? '' : String(proceso),
        metadata: JSON.stringify(metaToSave)
    });

    return { ...piece, partNumber: partToSave, quantity: qtyToSave, imagen: imgToSave, metadata: metaToSave };
}

async function getPiecesInLot(lot_id) {
    const sql = `SELECT * FROM ${tableName('pieces')} WHERE lot_id = @lot_id ORDER BY [timestamp] DESC`;
    const result = await queryWithParams(sql, { lot_id: String(lot_id) });
    return (result.recordset || []).map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata || '{}'),
        quantity: parseInt(row.quantity, 10),
        incidents: parseInt(row.incidents, 10),
        imagen: normalizeImagenValue(row.imagen)
    }));
}

async function movePieceLotId(uid, newLotId, proceso = undefined) {
    if (!uid || !newLotId) return { changes: 0 };

    if (proceso !== undefined && proceso !== null) {
        const sql = `UPDATE ${tableName('pieces')} SET lot_id = @lot_id, proceso = @proceso, [timestamp] = COALESCE([timestamp], SYSUTCDATETIME()) WHERE uid = @uid`;
        const result = await queryWithParams(sql, { lot_id: String(newLotId), proceso: String(proceso), uid: String(uid) });
        const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
        return { changes };
    }

    const sql = `UPDATE ${tableName('pieces')} SET lot_id = @lot_id, [timestamp] = COALESCE([timestamp], SYSUTCDATETIME()) WHERE uid = @uid`;
    const result = await queryWithParams(sql, { lot_id: String(newLotId), uid: String(uid) });
    const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
    return { changes };
}

async function getPiecesInLotPaged(lot_id, { page = 0, pageSize = 500, search = '' } = {}) {
    const safePage = Number.isFinite(page) ? Math.max(0, parseInt(page, 10)) : 0;
    const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.min(5000, parseInt(pageSize, 10))) : 500;
    const q = String(search || '').trim();

    let where = `WHERE lot_id = @lot_id`;
    const params = { lot_id: String(lot_id) };

    if (q) {
        where += ` AND (partNumber LIKE @like OR messageId LIKE @like OR uid LIKE @like)`;
        params.like = `%${q}%`;
    }

    const countRes = await queryWithParams(`SELECT COUNT(*) AS total FROM ${tableName('pieces')} ${where}`, params);
    const total = countRes.recordset && countRes.recordset[0] ? Number(countRes.recordset[0].total || 0) : 0;
    const totalPages = Math.max(1, Math.ceil((total || 0) / safePageSize));
    const offset = safePage * safePageSize;

    const rowsRes = await queryWithParams(
        `SELECT * FROM ${tableName('pieces')} ${where}
         ORDER BY COALESCE([timestamp], '1900-01-01') DESC, uid DESC
         OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
        { ...params, offset, pageSize: safePageSize }
    );

    const mapped = (rowsRes.recordset || []).map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata || '{}'),
        quantity: parseInt(row.quantity, 10),
        incidents: parseInt(row.incidents, 10),
        imagen: normalizeImagenValue(row.imagen)
    }));

    return {
        rows: mapped,
        total: total || 0,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasMore: safePage < totalPages - 1
    };
}

async function deletePiece(uid) {
    const result = await queryWithParams(`DELETE FROM ${tableName('pieces')} WHERE uid = @uid`, { uid: String(uid) });
    const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
    return { deleted: changes };
}

async function getPieceByUid(uid) {
    const result = await queryWithParams(`SELECT TOP 1 * FROM ${tableName('pieces')} WHERE uid = @uid`, { uid: String(uid) });
    const row = result.recordset && result.recordset[0];
    if (!row) return null;
    return {
        ...row,
        metadata: JSON.parse(row.metadata || '{}'),
        quantity: parseInt(row.quantity, 10),
        incidents: parseInt(row.incidents, 10)
    };
}

async function saveLotMetrics(lot_id, metric_type, data) {
    const sql = `
UPDATE ${tableName('lot_metrics')}
SET data = @data,
    updated_at = SYSUTCDATETIME()
WHERE lot_id = @lot_id AND metric_type = @metric_type;
IF @@ROWCOUNT = 0
BEGIN
  INSERT INTO ${tableName('lot_metrics')} (lot_id, metric_type, data, created_at, updated_at)
  VALUES (@lot_id, @metric_type, @data, SYSUTCDATETIME(), SYSUTCDATETIME());
END`;

    await queryWithParams(sql, {
        lot_id: String(lot_id),
        metric_type: String(metric_type),
        data: JSON.stringify(data || {})
    });

    return { lot_id, metric_type, data };
}

async function getLotMetrics(lot_id, metric_type = null) {
    let query = `SELECT * FROM ${tableName('lot_metrics')} WHERE lot_id = @lot_id`;
    const params = { lot_id: String(lot_id) };

    if (metric_type) {
        query += ` AND metric_type = @metric_type`;
        params.metric_type = String(metric_type);
    }

    const result = await queryWithParams(query, params);
    return (result.recordset || []).map((row) => ({
        ...row,
        data: JSON.parse(row.data || '{}')
    }));
}

async function logSync(action, entity_type, entity_id, data, status = 'pending') {
    const sql = `INSERT INTO ${tableName('sync_log')} (action, entity_type, entity_id, data, status)
                 OUTPUT INSERTED.id
                 VALUES (@action, @entity_type, @entity_id, @data, @status)`;
    const result = await queryWithParams(sql, {
        action: action == null ? null : String(action),
        entity_type: entity_type == null ? null : String(entity_type),
        entity_id: entity_id == null ? null : String(entity_id),
        data: JSON.stringify(data || {}),
        status: String(status || 'pending')
    });
    const id = result.recordset && result.recordset[0] ? result.recordset[0].id : null;
    return { id };
}

async function markSyncComplete(sync_id) {
    const result = await queryWithParams(
        `UPDATE ${tableName('sync_log')} SET status = 'complete', synced_at = SYSUTCDATETIME() WHERE id = @id`,
        { id: Number(sync_id) }
    );
    const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
    return { updated: changes };
}

async function getPendingSyncs() {
    const result = await queryWithParams(`SELECT * FROM ${tableName('sync_log')} WHERE status = 'pending' ORDER BY created_at DESC`);
    return result.recordset || [];
}

async function saveMonthlySnapshot(month, year, reportType, label, snapshotData) {
    const sql = `
UPDATE ${tableName('monthly_snapshots')}
SET label = @label,
    snapshot_data = @snapshot_data,
    created_at = SYSUTCDATETIME()
WHERE month = @month AND year = @year AND report_type = @report_type;
IF @@ROWCOUNT = 0
BEGIN
  INSERT INTO ${tableName('monthly_snapshots')} (month, year, report_type, label, snapshot_data, created_at)
  VALUES (@month, @year, @report_type, @label, @snapshot_data, SYSUTCDATETIME());
END`;

    await queryWithParams(sql, {
        month: Number(month),
        year: Number(year),
        report_type: String(reportType),
        label: String(label),
        snapshot_data: JSON.stringify(snapshotData || {})
    });

    const idRes = await queryWithParams(
        `SELECT TOP 1 id FROM ${tableName('monthly_snapshots')} WHERE month = @month AND year = @year AND report_type = @report_type`,
        { month: Number(month), year: Number(year), report_type: String(reportType) }
    );
    const id = idRes.recordset && idRes.recordset[0] ? idRes.recordset[0].id : null;
    return { id, month, year, reportType, label };
}

async function getAllMonthlySnapshots() {
    const result = await queryWithParams(
        `SELECT id, month, year, report_type, label, created_at FROM ${tableName('monthly_snapshots')} ORDER BY year DESC, month DESC`
    );
    return result.recordset || [];
}

async function getMonthlySnapshot(id) {
    const result = await queryWithParams(
        `SELECT TOP 1 * FROM ${tableName('monthly_snapshots')} WHERE id = @id`,
        { id: Number(id) }
    );
    const row = result.recordset && result.recordset[0];
    if (!row) return null;
    return { ...row, snapshot_data: JSON.parse(row.snapshot_data || '{}') };
}

async function getMonthlySnapshotByMonth(month, year, reportType) {
    const result = await queryWithParams(
        `SELECT TOP 1 * FROM ${tableName('monthly_snapshots')} WHERE month = @month AND year = @year AND report_type = @report_type`,
        { month: Number(month), year: Number(year), report_type: String(reportType) }
    );
    const row = result.recordset && result.recordset[0];
    if (!row) return null;
    return { ...row, snapshot_data: JSON.parse(row.snapshot_data || '{}') };
}

async function deleteMonthlySnapshot(id) {
    const result = await queryWithParams(
        `DELETE FROM ${tableName('monthly_snapshots')} WHERE id = @id`,
        { id: Number(id) }
    );
    const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
    return { deleted: changes };
}

async function updateMonthlySnapshotMeta(id, updates = {}) {
    const snapshotId = Number(id);
    if (!Number.isFinite(snapshotId)) return { updated: 0 };

    const fields = [];
    const params = { id: snapshotId };

    if (Object.prototype.hasOwnProperty.call(updates, 'label')) {
        fields.push('label = @label');
        params.label = String(updates.label || '');
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'month')) {
        fields.push('month = @month');
        params.month = Number(updates.month);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'year')) {
        fields.push('year = @year');
        params.year = Number(updates.year);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'createdAt')) {
        fields.push('created_at = @created_at');
        params.created_at = String(updates.createdAt || '');
    }

    if (fields.length === 0) return { updated: 0 };

    const sql = `UPDATE ${tableName('monthly_snapshots')} SET ${fields.join(', ')} WHERE id = @id`;
    const result = await queryWithParams(sql, params);
    const changes = Array.isArray(result.rowsAffected) ? (result.rowsAffected[0] || 0) : 0;
    return { updated: changes };
}

function getDbPath() {
    if (DB_SERVER && DB_NAME) return `mssql://${DB_SERVER}/${DB_NAME}`;
    return 'mssql://';
}

module.exports = {
    isMssql: true,
    getDbPath,
    getDb,
    initializeDatabase,
    saveLot,
    getLot,
    getAllLots,
    deleteLot,
    savePiece,
    getPiecesInLot,
    getPiecesInLotPaged,
    movePieceLotId,
    deletePiece,
    getPieceByUid,
    saveLotMetrics,
    getLotMetrics,
    logSync,
    markSyncComplete,
    getPendingSyncs,
    saveMonthlySnapshot,
    getAllMonthlySnapshots,
    getMonthlySnapshot,
    getMonthlySnapshotByMonth,
    deleteMonthlySnapshot,
    updateMonthlySnapshotMeta
};
