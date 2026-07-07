const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

function normalizeImagenValue(imagen) {
    try {
        if (typeof imagen !== 'string') return imagen;
        if (!imagen) return imagen;
        if (imagen.startsWith('data:')) return imagen; // data URL (base64)

        let v = String(imagen);
        v = v.replace(/\\/g, '/');
        // Si viene como 'images/<file>' o 'images\\<file>' quedarnos con el archivo
        if (v.toLowerCase().startsWith('images/')) v = v.slice('images/'.length);
        // Si viene como ruta completa o relativa, quedarnos con el basename
        const parts = v.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : v;
    } catch (e) {
        return imagen;
    }
}

function resolveDbPath() {
    // Prioridad: variable de entorno (útil para mover a red/servidor)
    const configured = (process.env.LASER_DB_PATH || process.env.SQLITE_DB_PATH || process.env.DB_PATH || '').trim();
    if (configured) {
        try {
            // En Windows esto soporta rutas UNC: \\servidor\share\...\file.db
            return path.normalize(configured);
        } catch (e) {
            return configured;
        }
    }

    // Fallback: BD local en el directorio del proyecto
    return path.join(__dirname, 'laser_engraving.db');
}

// Ruta de la BD
const dbPath = resolveDbPath();

// Crear conexión a BD
let db = null;

function getDb() {
    if (!db) {
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('❌ Error conectando a BD:', err);
                console.error('   Ruta configurada:', dbPath);
                process.exit(1);
            } else {
                console.log('✅ Conectado a BD SQLite:', dbPath);
            }
        });
        // Habilitar foreign keys
        db.run('PRAGMA foreign_keys = ON');
    }
    return db;
}

function maybeMigratePiecesSchema(database) {
    return new Promise((resolve, reject) => {
        try {
            // Detectar UNIQUE sobre clientId/messageId (además de la PK uid).
            // Esto rompe multi-destino porque un INSERT OR REPLACE puede borrar/mover filas existentes.
            database.all(`PRAGMA index_list('pieces')`, (err, indexes) => {
                if (err) return reject(err);
                const idx = Array.isArray(indexes) ? indexes : [];
                const uniqueIndexes = idx.filter(i => i && (i.unique === 1 || i.unique === '1'));
                if (uniqueIndexes.length === 0) return resolve({ migrated: false, reason: 'no_unique_indexes' });

                let pending = uniqueIndexes.length;
                let needsMigration = false;

                uniqueIndexes.forEach(i => {
                    const name = i && i.name ? String(i.name) : '';
                    if (!name) {
                        pending--;
                        if (pending === 0) {
                            if (!needsMigration) return resolve({ migrated: false, reason: 'no_messageId_clientId_unique' });
                            // shouldn't happen here
                            return resolve({ migrated: false, reason: 'unknown' });
                        }
                        return;
                    }
                    database.all(`PRAGMA index_info('${name.replace(/'/g, "''")}')`, (err2, cols) => {
                        if (!err2) {
                            const colNames = (Array.isArray(cols) ? cols : []).map(c => c && c.name ? String(c.name) : '').filter(Boolean);
                            // Si cualquier UNIQUE incluye messageId o clientId (además de uid), migrar.
                            if (colNames.includes('messageId') || colNames.includes('clientId')) {
                                // Excluir el caso de PK uid (normalmente es otro autoindex con solo uid)
                                if (!(colNames.length === 1 && colNames[0] === 'uid')) {
                                    needsMigration = true;
                                }
                            }
                        }

                        pending--;
                        if (pending !== 0) return;

                        if (!needsMigration) return resolve({ migrated: false, reason: 'no_messageId_clientId_unique' });

                        console.log('🧬 Migración automática: removiendo UNIQUE de pieces.clientId/messageId (multi-destino)');

                                                const sql = `
BEGIN;
DROP TABLE IF EXISTS pieces_new;
CREATE TABLE pieces_new (
  uid TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL,
  partNumber TEXT,
  quantity INTEGER DEFAULT 0,
  incidents INTEGER DEFAULT 0,
  incidentType TEXT DEFAULT '',
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  imagen LONGBLOB,
  sourceFile TEXT,
  clientId TEXT,
  messageId TEXT,
  proceso TEXT DEFAULT '',
  metadata JSON DEFAULT '{}',
  FOREIGN KEY (lot_id) REFERENCES lotes(id) ON DELETE CASCADE
);
INSERT INTO pieces_new (uid, lot_id, partNumber, quantity, incidents, incidentType, timestamp, imagen, sourceFile, clientId, messageId, proceso, metadata)
  SELECT uid, lot_id, partNumber, quantity, incidents, incidentType, timestamp, imagen, sourceFile, clientId, messageId, proceso, metadata
  FROM pieces;
DROP TABLE pieces;
ALTER TABLE pieces_new RENAME TO pieces;
CREATE INDEX IF NOT EXISTS idx_pieces_lot_id ON pieces(lot_id);
CREATE INDEX IF NOT EXISTS idx_pieces_messageId ON pieces(messageId);
CREATE INDEX IF NOT EXISTS idx_pieces_clientId ON pieces(clientId);
COMMIT;`;

                        database.exec(sql, (err3) => {
                            if (err3) {
                                console.error('❌ Falló migración de pieces:', err3);
                                try {
                                    database.exec('ROLLBACK;', () => reject(err3));
                                } catch (e) {
                                    reject(err3);
                                }
                                return;
                            }
                            console.log('✅ Migración de pieces completada');
                            resolve({ migrated: true });
                        });
                    });
                });
            });
        } catch (e) {
            reject(e);
        }
    });
}

// Migración: corregir tabla lot_metrics para permitir laser + pavonado por lote
function maybeMigrateLotMetricsSchema(database) {
    return new Promise((resolve, reject) => {
        try {
            // Verificar si existe el índice UNIQUE incorrecto (solo lot_id en vez de lot_id+metric_type)
            database.all(`PRAGMA index_list('lot_metrics')`, (err, indexes) => {
                if (err) return resolve({ migrated: false, reason: 'no_table' });
                
                const idx = Array.isArray(indexes) ? indexes : [];
                let needsMigration = false;
                
                // Buscar índice UNIQUE que solo tenga lot_id (sin metric_type)
                let pending = idx.length;
                if (pending === 0) return resolve({ migrated: false, reason: 'no_indexes' });
                
                idx.forEach(i => {
                    const name = i && i.name ? String(i.name) : '';
                    if (!name || !i.unique) {
                        pending--;
                        if (pending === 0 && !needsMigration) return resolve({ migrated: false, reason: 'no_problematic_index' });
                        return;
                    }
                    
                    database.all(`PRAGMA index_info('${name.replace(/'/g, "''")}')`, (err2, cols) => {
                        if (!err2) {
                            const colNames = (Array.isArray(cols) ? cols : []).map(c => c && c.name ? String(c.name) : '').filter(Boolean);
                            // Si hay un UNIQUE que tiene lot_id pero NO metric_type, migrar
                            if (colNames.includes('lot_id') && !colNames.includes('metric_type') && colNames.length === 1) {
                                needsMigration = true;
                            }
                        }
                        
                        pending--;
                        if (pending !== 0) return;
                        
                        if (!needsMigration) return resolve({ migrated: false, reason: 'schema_ok' });
                        
                        console.log('🧬 Migración automática: corrigiendo UNIQUE de lot_metrics (lot_id → lot_id+metric_type)');
                        
                        const sql = `
BEGIN;
DROP TABLE IF EXISTS lot_metrics_new;
CREATE TABLE lot_metrics_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    data JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lot_id) REFERENCES lotes(id) ON DELETE CASCADE,
    UNIQUE(lot_id, metric_type)
);
INSERT OR IGNORE INTO lot_metrics_new (lot_id, metric_type, data, created_at, updated_at)
    SELECT lot_id, metric_type, data, created_at, updated_at FROM lot_metrics;
DROP TABLE lot_metrics;
ALTER TABLE lot_metrics_new RENAME TO lot_metrics;
CREATE INDEX IF NOT EXISTS idx_lot_metrics_lot_id ON lot_metrics(lot_id);
COMMIT;`;

                        database.exec(sql, (err3) => {
                            if (err3) {
                                console.error('❌ Falló migración de lot_metrics:', err3);
                                try {
                                    database.exec('ROLLBACK;', () => resolve({ migrated: false, error: err3 }));
                                } catch (e) {
                                    resolve({ migrated: false, error: err3 });
                                }
                                return;
                            }
                            console.log('✅ Migración de lot_metrics completada');
                            resolve({ migrated: true });
                        });
                    });
                });
            });
        } catch (e) {
            resolve({ migrated: false, error: e });
        }
    });
}

function initializeDatabase() {
    return new Promise((resolve, reject) => {
        const database = getDb();
        
        // Tabla para lotes (colecciones de piezas)
        database.run(`
            CREATE TABLE IF NOT EXISTS lotes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                process TEXT DEFAULT 'all',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                metadata JSON DEFAULT '{}'
            )
        `, (err) => {
            if (err) {
                console.error('Error creando tabla lotes:', err);
                reject(err);
                return;
            }
            
            // Tabla para piezas
            database.run(`
                CREATE TABLE IF NOT EXISTS pieces (
                    uid TEXT PRIMARY KEY,
                    lot_id TEXT NOT NULL,
                    partNumber TEXT,
                    quantity INTEGER DEFAULT 0,
                    incidents INTEGER DEFAULT 0,
                    incidentType TEXT DEFAULT '',
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    imagen LONGBLOB,
                    sourceFile TEXT,
                    clientId TEXT,
                    messageId TEXT,
                    proceso TEXT DEFAULT '',
                    metadata JSON DEFAULT '{}',
                    FOREIGN KEY (lot_id) REFERENCES lotes(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) {
                    console.error('Error creando tabla pieces:', err);
                    reject(err);
                    return;
                }

                // Migración automática (si aplica) para permitir duplicados por messageId/clientId.
                // Nota: si no hay UNIQUE en esos campos, no hace nada.
                maybeMigratePiecesSchema(database)
                    .then(() => {
                        // Tabla para métricas de lotes (KPIs)
                        // ✅ CORREGIDO: UNIQUE sobre (lot_id, metric_type) para permitir laser + pavonado por lote
                        database.run(`
                    CREATE TABLE IF NOT EXISTS lot_metrics (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        lot_id TEXT NOT NULL,
                        metric_type TEXT NOT NULL,
                        data JSON,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (lot_id) REFERENCES lotes(id) ON DELETE CASCADE,
                        UNIQUE(lot_id, metric_type)
                    )
                `, (err) => {
                            if (err) {
                                console.error('Error creando tabla lot_metrics:', err);
                                reject(err);
                                return;
                            }
                            
                            // Migrar schema de lot_metrics si tiene UNIQUE incorrecto
                            maybeMigrateLotMetricsSchema(database)
                                .then(() => {
                            
                            // Tabla para sincronización y auditoría
                            database.run(`
                        CREATE TABLE IF NOT EXISTS sync_log (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            action TEXT,
                            entity_type TEXT,
                            entity_id TEXT,
                            data JSON,
                            status TEXT DEFAULT 'pending',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            synced_at DATETIME
                        )
                    `, (err) => {
                                if (err) {
                                    console.error('Error creando tabla sync_log:', err);
                                    reject(err);
                                    return;
                                }

                                // Tabla para snapshots mensuales (historial de reportes)
                                database.run(`
                                    CREATE TABLE IF NOT EXISTS monthly_snapshots (
                                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                                        month INTEGER NOT NULL,
                                        year INTEGER NOT NULL,
                                        report_type TEXT NOT NULL DEFAULT 'all',
                                        label TEXT NOT NULL,
                                        snapshot_data JSON NOT NULL,
                                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                        UNIQUE(month, year, report_type)
                                    )
                                `, (err) => {
                                    if (err) {
                                        console.error('Error creando tabla monthly_snapshots:', err);
                                        // No bloquear: tabla opcional
                                    }
                                    console.log('✅ Tablas de BD inicializadas correctamente');
                                    resolve();
                                });
                            });
                                }).catch((mErr2) => {
                                    console.warn('⚠️ Error en migración lot_metrics:', mErr2);
                                    // Continuar de todos modos
                                    resolve();
                                });
                        });
                    })
                    .catch((mErr) => {
                        reject(mErr);
                    });
            });
        });
    });
}

// CRUD para Lotes
function saveLot(id, name, process = 'all', metadata = {}) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        // IMPORTANTE:
        // NO usar "INSERT OR REPLACE" aquí.
        // En SQLite, REPLACE borra la fila existente y la inserta de nuevo.
        // Como `pieces.lot_id` tiene ON DELETE CASCADE, eso puede borrar TODAS las piezas del lote.
        db.run(
            `
            INSERT INTO lotes (id, name, process, metadata, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                process = excluded.process,
                metadata = excluded.metadata,
                updated_at = CURRENT_TIMESTAMP
            `,
            [id, name, process, JSON.stringify(metadata)],
            function (err) {
                if (err) reject(err);
                else resolve({ id, name, process, metadata });
            }
        );
    });
}

function getLot(id) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get(`SELECT * FROM lotes WHERE id = ?`, [id], (err, row) => {
            if (err) reject(err);
            else resolve(row ? {
                ...row,
                metadata: JSON.parse(row.metadata || '{}')
            } : null);
        });
    });
}

function getAllLots() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(`SELECT * FROM lotes ORDER BY created_at DESC`, (err, rows) => {
            if (err) reject(err);
            else resolve((rows || []).map(row => ({
                ...row,
                metadata: JSON.parse(row.metadata || '{}')
            })));
        });
    });
}

function deleteLot(id) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(`DELETE FROM lotes WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve({ deleted: this.changes });
        });
    });
}

// CRUD para Piezas
function savePiece(piece) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        const {
            uid, lot_id, partNumber, quantity, incidents, incidentType,
            timestamp, imagen, sourceFile, clientId, messageId, proceso, metadata
        } = piece;

        // Normalizar imagen antes de guardar.
        const normalizedImagen = normalizeImagenValue(imagen);

        // Blindaje a nivel BD:
        // - Evita que un sync parcial reemplace quantity>0 con 0
        // - Preserva partNumber/imagen cuando el incoming viene vacío
        // - Preserva metadata existente (merge) para no perder flags de restauración
        const incomingQtyNum = (quantity === undefined || quantity === null || quantity === '') ? null : Number(quantity);
        const incomingQty = (incomingQtyNum !== null && Number.isFinite(incomingQtyNum)) ? incomingQtyNum : 0;

        const incomingPart = (partNumber !== undefined && partNumber !== null) ? String(partNumber) : '';
        const incomingPartTrim = incomingPart.trim();

        const incomingImg = normalizedImagen;
        const incomingImgIsEmpty = (incomingImg === undefined || incomingImg === null || incomingImg === '');

        const metaIn = (metadata && typeof metadata === 'object') ? metadata : {};
        const allowOverwriteQty = metaIn && metaIn.allowOverwriteQuantity === true;

        const needsExisting = (!allowOverwriteQty && incomingQty === 0) || (incomingPartTrim === '') || incomingImgIsEmpty || !metaIn || Object.keys(metaIn || {}).length === 0;

        const finishSave = (existingRow) => {
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

            // IMPORTANTE:
            // NO usar "INSERT OR REPLACE" aquí.
            // REPLACE puede borrar otra fila si choca con un UNIQUE (p.ej. messageId/clientId) y luego insertar.
            // Para el caso multi-destino eso provoca que "se vaya" de un lote al otro.
            db.run(`
                INSERT INTO pieces
                (uid, lot_id, partNumber, quantity, incidents, incidentType, timestamp, imagen, sourceFile, clientId, messageId, proceso, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(uid) DO UPDATE SET
                    lot_id = excluded.lot_id,
                    partNumber = excluded.partNumber,
                    quantity = excluded.quantity,
                    incidents = excluded.incidents,
                    incidentType = excluded.incidentType,
                    timestamp = excluded.timestamp,
                    imagen = excluded.imagen,
                    sourceFile = excluded.sourceFile,
                    clientId = excluded.clientId,
                    messageId = excluded.messageId,
                    proceso = excluded.proceso,
                    metadata = excluded.metadata
            `, [
                uid, lot_id, partToSave, qtyToSave, incidents, incidentType,
                timestamp, imgToSave, sourceFile, clientId, messageId, proceso,
                JSON.stringify(metaToSave)
            ], function (err) {
                if (err) reject(err);
                else resolve({ ...piece, partNumber: partToSave, quantity: qtyToSave, imagen: imgToSave, metadata: metaToSave });
            });
        };

        if (!needsExisting) {
            return finishSave(null);
        }

        db.get('SELECT quantity, partNumber, imagen, metadata FROM pieces WHERE uid = ? LIMIT 1', [uid], (err, row) => {
            if (err) return reject(err);
            finishSave(row || null);
        });
    });
}

function getPiecesInLot(lot_id) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(`SELECT * FROM pieces WHERE lot_id = ? ORDER BY timestamp DESC`, [lot_id], (err, rows) => {
            if (err) reject(err);
            else resolve((rows || []).map(row => ({
                ...row,
                metadata: JSON.parse(row.metadata || '{}'),
                quantity: parseInt(row.quantity),
                incidents: parseInt(row.incidents),
                imagen: normalizeImagenValue(row.imagen)
            })));
        });
    });
}

// Mover una pieza entre lotes SIN reescribir otros campos.
// Esto evita reenviar imagen/base64 y evita perder datos por upserts parciales.
function movePieceLotId(uid, newLotId, proceso = undefined) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        if (!uid || !newLotId) return resolve({ changes: 0 });

        // Si proceso es null/undefined, no tocarlo.
        // Si proceso es string (incluye ''), actualizarlo.
        const shouldUpdateProceso = (proceso !== undefined && proceso !== null);

        if (shouldUpdateProceso) {
            db.run(
                `UPDATE pieces SET lot_id = ?, proceso = ?, timestamp = COALESCE(timestamp, CURRENT_TIMESTAMP) WHERE uid = ?`,
                [String(newLotId), String(proceso), String(uid)],
                function (err) {
                    if (err) return reject(err);
                    resolve({ changes: this.changes });
                }
            );
        } else {
            db.run(
                `UPDATE pieces SET lot_id = ?, timestamp = COALESCE(timestamp, CURRENT_TIMESTAMP) WHERE uid = ?`,
                [String(newLotId), String(uid)],
                function (err) {
                    if (err) return reject(err);
                    resolve({ changes: this.changes });
                }
            );
        }
    });
}

// Consulta paginada para lotes con muchos registros
function getPiecesInLotPaged(lot_id, { page = 0, pageSize = 500, search = '' } = {}) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        const safePage = Number.isFinite(page) ? Math.max(0, parseInt(page)) : 0;
        const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.min(5000, parseInt(pageSize))) : 500;
        const q = String(search || '').trim();

        let where = `WHERE lot_id = ?`;
        const params = [lot_id];

        if (q) {
            where += ` AND (partNumber LIKE ? OR messageId LIKE ? OR uid LIKE ?)`;
            const like = `%${q}%`;
            params.push(like, like, like);
        }

        db.get(`SELECT COUNT(*) AS total FROM pieces ${where}`, params, (err, countRow) => {
            if (err) return reject(err);
            const total = (countRow && typeof countRow.total === 'number') ? countRow.total : parseInt(countRow?.total || '0');
            const totalPages = Math.max(1, Math.ceil((total || 0) / safePageSize));
            const offset = safePage * safePageSize;

            db.all(
                `SELECT * FROM pieces ${where} ORDER BY COALESCE(timestamp, '') DESC, rowid DESC LIMIT ? OFFSET ?`,
                [...params, safePageSize, offset],
                (err2, rows) => {
                    if (err2) return reject(err2);
                    const mapped = (rows || []).map(row => ({
                        ...row,
                        metadata: JSON.parse(row.metadata || '{}'),
                        quantity: parseInt(row.quantity),
                        incidents: parseInt(row.incidents),
                        imagen: normalizeImagenValue(row.imagen)
                    }));
                    resolve({
                        rows: mapped,
                        total: total || 0,
                        page: safePage,
                        pageSize: safePageSize,
                        totalPages,
                        hasMore: safePage < totalPages - 1
                    });
                }
            );
        });
    });
}

function deletePiece(uid) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(`DELETE FROM pieces WHERE uid = ?`, [uid], function(err) {
            if (err) reject(err);
            else resolve({ deleted: this.changes });
        });
    });
}

function getPieceByUid(uid) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get(`SELECT * FROM pieces WHERE uid = ?`, [uid], (err, row) => {
            if (err) reject(err);
            else resolve(row ? {
                ...row,
                metadata: JSON.parse(row.metadata || '{}'),
                quantity: parseInt(row.quantity),
                incidents: parseInt(row.incidents)
            } : null);
        });
    });
}

// CRUD para Métricas
function saveLotMetrics(lot_id, metric_type, data) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(`
            INSERT OR REPLACE INTO lot_metrics (lot_id, metric_type, data, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `, [lot_id, metric_type, JSON.stringify(data)], function(err) {
            if (err) reject(err);
            else resolve({ lot_id, metric_type, data });
        });
    });
}

function getLotMetrics(lot_id, metric_type = null) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        let query = `SELECT * FROM lot_metrics WHERE lot_id = ?`;
        let params = [lot_id];
        
        if (metric_type) {
            query += ` AND metric_type = ?`;
            params.push(metric_type);
        }
        
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve((rows || []).map(row => ({
                ...row,
                data: JSON.parse(row.data || '{}')
            })));
        });
    });
}

// Log de sincronización (auditoría)
function logSync(action, entity_type, entity_id, data, status = 'pending') {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(`
            INSERT INTO sync_log (action, entity_type, entity_id, data, status)
            VALUES (?, ?, ?, ?, ?)
        `, [action, entity_type, entity_id, JSON.stringify(data), status], function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
        });
    });
}

function markSyncComplete(sync_id) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(`
            UPDATE sync_log SET status = 'complete', synced_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [sync_id], function(err) {
            if (err) reject(err);
            else resolve({ updated: this.changes });
        });
    });
}

function getPendingSyncs() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(`SELECT * FROM sync_log WHERE status = 'pending' ORDER BY created_at DESC`, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

// ===== Snapshots mensuales (historial de reportes) =====

function saveMonthlySnapshot(month, year, reportType, label, snapshotData) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(`
            INSERT INTO monthly_snapshots (month, year, report_type, label, snapshot_data)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(month, year, report_type) DO UPDATE SET
                label = excluded.label,
                snapshot_data = excluded.snapshot_data,
                created_at = CURRENT_TIMESTAMP
        `, [month, year, reportType, label, JSON.stringify(snapshotData)], function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, month, year, reportType, label });
        });
    });
}

function getAllMonthlySnapshots() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(`SELECT id, month, year, report_type, label, created_at FROM monthly_snapshots ORDER BY year DESC, month DESC`, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function getMonthlySnapshot(id) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get(`SELECT * FROM monthly_snapshots WHERE id = ?`, [id], (err, row) => {
            if (err) reject(err);
            else resolve(row ? { ...row, snapshot_data: JSON.parse(row.snapshot_data || '{}') } : null);
        });
    });
}

function getMonthlySnapshotByMonth(month, year, reportType) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get(`SELECT * FROM monthly_snapshots WHERE month = ? AND year = ? AND report_type = ?`, [month, year, reportType], (err, row) => {
            if (err) reject(err);
            else resolve(row ? { ...row, snapshot_data: JSON.parse(row.snapshot_data || '{}') } : null);
        });
    });
}

function deleteMonthlySnapshot(id) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(`DELETE FROM monthly_snapshots WHERE id = ?`, [id], function (err) {
            if (err) reject(err);
            else resolve({ deleted: this.changes });
        });
    });
}

function updateMonthlySnapshotMeta(id, updates = {}) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        const snapshotId = Number(id);
        if (!Number.isFinite(snapshotId)) return resolve({ updated: 0 });

        const fields = [];
        const params = [];

        if (Object.prototype.hasOwnProperty.call(updates, 'label')) {
            fields.push('label = ?');
            params.push(String(updates.label || ''));
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'month')) {
            fields.push('month = ?');
            params.push(Number(updates.month));
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'year')) {
            fields.push('year = ?');
            params.push(Number(updates.year));
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'createdAt')) {
            fields.push('created_at = ?');
            params.push(String(updates.createdAt || ''));
        }

        if (fields.length === 0) return resolve({ updated: 0 });

        params.push(snapshotId);
        db.run(
            `UPDATE monthly_snapshots SET ${fields.join(', ')} WHERE id = ?`,
            params,
            function (err) {
                if (err) reject(err);
                else resolve({ updated: this.changes });
            }
        );
    });
}

// Exportar todas las funciones y la BD
module.exports = {
    getDbPath: () => dbPath,
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
