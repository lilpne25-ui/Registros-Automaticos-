const path = require('path');
const dotenv = require('dotenv');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
// const xlsx = require('xlsx'); // EXCEL writing removed - replaced by engrave JSON
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const RUNTIME_ENV_PATH = String(process.env.LASERCONTROL_ENV_PATH || '').trim();
if (RUNTIME_ENV_PATH) {
    dotenv.config({ path: RUNTIME_ENV_PATH, override: true });
} else {
    dotenv.config();
}
const useMssql = String(process.env.USE_MSSQL || '').toLowerCase() === 'true'
    || Boolean(process.env.MSSQL_CONNECTION_STRING || process.env.MSSQL_SERVER);
const db = useMssql ? require('./db_mssql') : require('./db');
const { registerAuthAdminRoutes } = require('./server/routes/auth-admin');
const { registerWhatsAppStatusRoutes } = require('./server/routes/whatsapp-status');
const { registerSnapshotRoutes } = require('./server/routes/snapshots');
const { createServerLogger, installConsoleMirroring } = require('./server/logger');
const {
    createBackupFile,
    listBackupFiles,
    readBackupFile,
    restoreBackupFile,
    restoreBackupArtifact,
    collectBackupArtifact,
    getBackupDir
} = require('./server/services/backup-restore');

const DEFAULT_CONFIG_DIR = RUNTIME_ENV_PATH ? path.dirname(RUNTIME_ENV_PATH) : __dirname;
const RUNTIME_CONFIG_DIR = path.resolve(String(process.env.LASERCONTROL_CONFIG_DIR || DEFAULT_CONFIG_DIR).trim());
const { logger: serverLogger, logFile: SERVER_LOG_FILE } = createServerLogger({ baseDir: RUNTIME_CONFIG_DIR });
installConsoleMirroring(serverLogger);

const app = express();
const PORT = Number(process.env.PORT || 3000);
// Para multiusuario en LAN: escuchar en todas las interfaces.
// Puedes sobreescribir con HOST=127.0.0.1 si quieres solo local.
const HOST = String(process.env.HOST || '0.0.0.0');
const SERVER_STARTED_AT = new Date().toISOString();

function envFlagDefaultTrue(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return true;
    return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function getLanUrls(port) {
    const urls = new Set();
    try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets || {})) {
            const addrs = nets[name] || [];
            for (const a of addrs) {
                if (!a) continue;
                if (a.internal) continue;
                if (a.family !== 'IPv4') continue;
                if (!a.address) continue;
                urls.add(`http://${a.address}:${port}`);
            }
        }
    } catch (e) {
        // ignore
    }
    return Array.from(urls);
}

// Endpoint de reseteo/borrado (protegido por contraseña)
const RESET_PASSWORD = String(process.env.RESET_PASSWORD || '').trim();

// =============================
// Auth (inicio de sesión)
// =============================

const AUTH_ENABLED = envFlagDefaultTrue('AUTH_ENABLED');
const AUTH_ADMIN_USER = String(process.env.AUTH_ADMIN_USER || 'admin');
const AUTH_ADMIN_PASSWORD = String(process.env.AUTH_ADMIN_PASSWORD || '');
const AUTH_SECRET = String(process.env.AUTH_SECRET || '').trim();
const AUTH_REQUIRE_PASSWORD = envFlagDefaultTrue('AUTH_REQUIRE_PASSWORD');
const AUTH_COOKIE_SECURE = ['1', 'true', 'yes', 'on'].includes(String(process.env.AUTH_COOKIE_SECURE || '').trim().toLowerCase());

// Sesiones en memoria (suficiente para LAN; al reiniciar servidor, todos vuelven a loguear)
const AUTH_COOKIE_NAME = 'lc_auth';
const AUTH_TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const authTokens = new Map(); // token -> { username, role, permissions, expiresAt }

function assertSecureStartupConfig() {
    const missing = [];
    if (AUTH_ENABLED && !AUTH_SECRET) missing.push('AUTH_SECRET');
    if (!RESET_PASSWORD) missing.push('RESET_PASSWORD');
    if (!missing.length) return;

    const sourceHint = RUNTIME_ENV_PATH
        ? `Define ${missing.join(', ')} en ${RUNTIME_ENV_PATH}.`
        : `Define ${missing.join(', ')} en .env o en variables de entorno antes de iniciar.`;
    throw new Error(`Configuracion insegura detectada. ${sourceHint}`);
}

function getCookieSecuritySuffix() {
    return AUTH_COOKIE_SECURE ? '; Secure' : '';
}

// Permisos disponibles (clave -> etiqueta)
const PERMISSIONS = Object.freeze({
    'admin.users': 'Administrar usuarios y permisos',
    'whatsapp.groups': 'Gestionar grupos autorizados de WhatsApp',
    'whatsapp.logs': 'Ver logs de WhatsApp',
    'whatsapp.restart': 'Reiniciar conexion WhatsApp',
    'system.reset': 'Cierre de mes / reset',
    'system.sync_images': 'Sincronizar imágenes (admin)',
    'data.export': 'Exportar datos',
    'data.import': 'Importar datos',
    'data.sync': 'Sincronizar con servidor',
    'pieces.create': 'Crear piezas',
    'pieces.edit': 'Editar piezas',
    'pieces.delete': 'Eliminar piezas',
    'pieces.move': 'Mover piezas entre lotes',
    'lotes.manage': 'Crear/eliminar lotes',
    'metrics.edit': 'Editar/guardar métricas',
    'report.signatures.edit': 'Editar/Reemplazar firmas ya capturadas (reportes)'
});

function getAllPermissionKeys() {
    return Object.keys(PERMISSIONS);
}

function normalizePermissionsArray(v) {
    if (!v) return [];
    if (v === '*') return ['*'];
    if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
    if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return [];
        if (s === '*') return ['*'];
        // Permitir CSV
        return s.split(',').map(x => x.trim()).filter(Boolean);
    }
    return [];
}

function hasPermission(effectivePerms, perm) {
    const arr = normalizePermissionsArray(effectivePerms);
    if (arr.includes('*')) return true;
    return arr.includes(String(perm));
}

// =============================
// Users DB (SQLite)
// =============================

async function ensureAuthUsersTable(database) {
    await runSql(
        database,
        `CREATE TABLE IF NOT EXISTS auth_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'viewer',
            permissions_json TEXT DEFAULT '[]',
            active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
    );
}

function pbkdf2HashPassword(password) {
    const pw = String(password || '');
    if (!pw) throw new Error('Empty password');
    const iterations = 120000;
    const salt = crypto.randomBytes(16);
    const dk = crypto.pbkdf2Sync(pw, salt, iterations, 32, 'sha256');
    return `pbkdf2$${iterations}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function pbkdf2VerifyPassword(password, stored) {
    try {
        const pw = String(password || '');
        const s = String(stored || '');
        const parts = s.split('$');
        if (parts.length !== 4) return false;
        if (parts[0] !== 'pbkdf2') return false;
        const iterations = Number(parts[1]);
        if (!Number.isFinite(iterations) || iterations < 10000) return false;
        const salt = Buffer.from(parts[2], 'base64');
        const hash = Buffer.from(parts[3], 'base64');
        const dk = crypto.pbkdf2Sync(pw, salt, iterations, hash.length, 'sha256');
        return crypto.timingSafeEqual(dk, hash);
    } catch (e) {
        return false;
    }
}

async function getUserRecordByUsername(database, username) {
    const u = String(username || '').trim();
    if (!u) return null;
    const row = await getSql(database, 'SELECT username, password_hash, role, permissions_json, active FROM auth_users WHERE username = ? LIMIT 1', [u]);
    return row || null;
}

async function ensureAdminUserSeed(database) {
    if (!AUTH_ENABLED) return;
    await ensureAuthUsersTable(database);

    const existing = await getUserRecordByUsername(database, AUTH_ADMIN_USER);
    if (existing) return;
    let seedPassword = AUTH_ADMIN_PASSWORD;
    if (AUTH_REQUIRE_PASSWORD) {
        if (!seedPassword) {
            console.warn('⚠️ AUTH_ENABLED=true pero AUTH_ADMIN_PASSWORD está vacío. No habrá admin por defecto.');
            return;
        }
    } else {
        seedPassword = seedPassword || AUTH_ADMIN_USER || 'admin';
    }
    const hash = pbkdf2HashPassword(seedPassword);
    await runSql(
        database,
        'INSERT INTO auth_users (username, password_hash, role, permissions_json, active) VALUES (?, ?, ?, ?, 1)',
        [AUTH_ADMIN_USER, hash, 'admin', JSON.stringify(['*'])]
    );
    console.log(`✅ Usuario admin creado en BD: ${AUTH_ADMIN_USER}`);
}

function parseCookies(headerValue) {
    const out = {};
    try {
        const raw = headerValue || '';
        raw.split(';').forEach(part => {
            const idx = part.indexOf('=');
            if (idx < 0) return;
            const k = part.slice(0, idx).trim();
            const v = part.slice(idx + 1).trim();
            if (!k) return;
            out[k] = decodeURIComponent(v);
        });
    } catch (e) {
        // ignore
    }
    return out;
}

function issueAuthToken({ username, role, permissions }) {
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + AUTH_TOKEN_TTL_MS;
    authTokens.set(token, {
        username,
        role: role || 'viewer',
        permissions: normalizePermissionsArray(permissions),
        expiresAt
    });
    return token;
}

function getAuthUserFromRequest(req) {
    try {
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[AUTH_COOKIE_NAME];
        if (!token) return null;
        const entry = authTokens.get(token);
        if (!entry) return null;
        if (!entry.expiresAt || Date.now() > entry.expiresAt) {
            authTokens.delete(token);
            return null;
        }
        return {
            username: entry.username,
            role: entry.role || 'viewer',
            permissions: normalizePermissionsArray(entry.permissions),
            token
        };
    } catch (e) {
        return null;
    }
}

function clearAuthCookie(res) {
    // Max-Age=0 para borrar cookie
    res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${getCookieSecuritySuffix()}`);
}

function setAuthCookie(res, token) {
    const maxAgeSeconds = Math.max(60, Math.floor(AUTH_TOKEN_TTL_MS / 1000));
    res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${getCookieSecuritySuffix()}`);
}

async function validateLogin(username, password) {
    const u = String(username || '').trim();
    const p = String(password || '');
    if (!u) return { ok: false };

    // Validar contra BD
    try {
        const database = db.getDb();
        await ensureAuthUsersTable(database);

        // Sembrar admin si hace falta
        await ensureAdminUserSeed(database);

        const rec = await getUserRecordByUsername(database, u);
        if (!rec) return { ok: false };
        if (rec.active === 0 || rec.active === '0') return { ok: false, disabled: true };

        let perms = [];
        try {
            perms = JSON.parse(rec.permissions_json || '[]');
        } catch (e) {
            perms = [];
        }

        if (AUTH_REQUIRE_PASSWORD) {
            const ok = pbkdf2VerifyPassword(p, rec.password_hash);
            if (!ok) return { ok: false };
        }

        return {
            ok: true,
            username: rec.username,
            role: rec.role || 'viewer',
            permissions: normalizePermissionsArray(perms)
        };
    } catch (e) {
        console.warn('validateLogin error', e && e.message ? e.message : e);
        return { ok: false };
    }
}

function requirePermission(permissionKey) {
    return function (req, res, next) {
        if (!AUTH_ENABLED) return next();
        const user = req.authUser || getAuthUserFromRequest(req);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        if (!hasPermission(user.permissions, permissionKey)) {
            return res.status(403).json({ error: 'Forbidden', missingPermission: permissionKey });
        }
        return next();
    };
}

function requireAnyPermission(permissionKeys) {
    const keys = Array.isArray(permissionKeys) ? permissionKeys.map(k => String(k)).filter(Boolean) : [String(permissionKeys || '')].filter(Boolean);
    return function (req, res, next) {
        if (!AUTH_ENABLED) return next();
        const user = req.authUser || getAuthUserFromRequest(req);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });

        for (const k of keys) {
            if (hasPermission(user.permissions, k)) return next();
        }
        return res.status(403).json({ error: 'Forbidden', missingPermission: keys[0] || null, anyOf: keys });
    };
}

function dbGetAsync(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            database.get(sql, params, (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            });
        } catch (e) {
            reject(e);
        }
    });
}

async function getDatabaseHealth() {
    const summary = {
        ok: false,
        kind: useMssql ? 'mssql' : 'sqlite',
        path: null,
        error: null
    };

    try {
        summary.path = (typeof db.getDbPath === 'function') ? db.getDbPath() : null;
    } catch (e) {
        summary.path = null;
    }

    try {
        const database = db.getDb();
        const row = await dbGetAsync(database, 'SELECT 1 AS ok', []);
        summary.ok = !!(row && Number(row.ok || 0) === 1);
    } catch (e) {
        summary.error = e && e.message ? e.message : String(e);
    }

    return summary;
}

async function buildHealthPayload() {
    const dbHealth = await getDatabaseHealth();
    return {
        ok: !!dbHealth.ok,
        startedAt: SERVER_STARTED_AT,
        uptimeSec: Math.max(0, Math.round(process.uptime())),
        envPath: RUNTIME_ENV_PATH || null,
        auth: {
            enabled: AUTH_ENABLED,
            requirePassword: AUTH_REQUIRE_PASSWORD
        },
        db: dbHealth,
        whatsapp: {
            authenticated: !!isAuthenticated,
            initInProgress: !!waInitInProgress,
            initAttempt: waInitAttempt,
            lastError: waLastError || null
        }
    };
}

const loginBodySchema = z.object({
    username: z.string().trim().min(1).max(120),
    password: z.string().max(200).optional().default('')
});

const restartWhatsAppSchema = z.object({
    killLockedBrowser: z.boolean().optional().default(true)
});

const backupCreateSchema = z.object({
    label: z.string().trim().max(80).optional().default('')
});

const backupRestoreSchema = z.object({
    restoreAuthUsers: z.boolean().optional().default(false)
});

const backupImportSchema = z.object({
    artifact: z.any(),
    restoreAuthUsers: z.boolean().optional().default(false)
});

const loginRateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' }
});

const sensitiveMutationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down and try again.' }
});

app.disable('x-powered-by');
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use('/api/auth/login', loginRateLimiter);
app.use('/enqueue', sensitiveMutationLimiter);
app.use('/engrave/delete', sensitiveMutationLimiter);
app.use('/api/reset', sensitiveMutationLimiter);
app.use('/api/reset-monthly-pavonado', sensitiveMutationLimiter);
app.use('/api/reset-monthly-all', sensitiveMutationLimiter);
app.use('/api/whatsapp/restart', sensitiveMutationLimiter);
app.use('/api/backups', sensitiveMutationLimiter);
app.use('/api/import', sensitiveMutationLimiter);
// Configurar servidor web
// Evitar que express sirva automáticamente `index.html` como raíz para que usemos
// nuestro HTML principal del sistema de grabado.
// Usar ruta absoluta para evitar problemas si el proceso se inicia desde otro CWD.

// Deshabilitar caché para archivos HTML en desarrollo
app.use((req, res, next) => {
    if (req.path.endsWith('.html')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

// Gate de autenticación (protege UI, API y SSE)
app.use((req, res, next) => {
    if (!AUTH_ENABLED) return next();

    // Rutas públicas
    const p = req.path || '';
    if (p === '/login' || p === '/login.html') return next();
    if (p.startsWith('/api/auth/')) return next();
    if (p === '/healthz' || p === '/readyz') return next();

    // Permitir servir recursos mínimos del login si se accede directo (por compatibilidad)
    // (En nuestro login no dependemos de assets, pero no molesta.)
    if (p === '/public/login.html') return next();
    
    // Permitir logo de la empresa (recurso público para la página de login)
    if (p === '/innovax-logo.jpg' || p === '/innovax-logo.png') return next();

    const user = getAuthUserFromRequest(req);
    if (!user) {
        // Si el navegador pide HTML, redirigir
        const accept = String(req.headers.accept || '');
        if (accept.includes('text/html')) {
            return res.redirect('/login');
        }
        return res.status(401).json({ error: 'Unauthorized' });
    }

    req.authUser = user;
    return next();
});

app.get('/healthz', async (req, res) => {
    const payload = await buildHealthPayload();
    return res.status(payload.ok ? 200 : 503).json(payload);
});

app.get('/readyz', async (req, res) => {
    const payload = await buildHealthPayload();
    return res.status(payload.ok ? 200 : 503).json({
        ...payload,
        ready: !!payload.ok
    });
});

// Recurso eliminado: ya no se usa en el sistema
app.get('/formato_asistencia_semanal.html', (req, res) => {
    return res.status(410).send('Este recurso fue eliminado.');
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Permitir payloads JSON grandes (imágenes en data URLs pueden ser grandes)
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));

// ========================================
// Report Signatures (persistencia de firmas en BD)
// ========================================

app.post('/api/report-signatures/:reportType', async (req, res) => {
    try {
        // Gate global ya exige auth cuando AUTH_ENABLED=true.
        const reportType = String(req.params.reportType || '').toLowerCase();
        if (reportType !== 'laser' && reportType !== 'pavonado') {
            return res.status(400).json({ error: 'reportType inválido' });
        }

        const signerName = String(req.body?.signerName || '').trim();
        const signatureDataUrl = String(req.body?.signatureDataUrl || '').trim();

        if (!signerName) return res.status(400).json({ error: 'signerName requerido' });
        if (!signatureDataUrl) return res.status(400).json({ error: 'signatureDataUrl requerido' });

        // Validación básica del data URL (evita basura y tamaños extremos)
        if (!signatureDataUrl.startsWith('data:image/png;base64,')) {
            return res.status(400).json({ error: 'Firma inválida (se requiere PNG base64)' });
        }
        // Límite suave (aprox) para evitar inflar BD por error
        if (signatureDataUrl.length > 600_000) {
            return res.status(413).json({ error: 'Firma demasiado grande' });
        }

        // Cargar o crear lote raíz
        let rootLot = null;
        try {
            rootLot = await db.getLot('lotes');
        } catch (e) {
            rootLot = null;
        }

        const name = rootLot?.name || 'LOTES';
        const process = rootLot?.process || 'all';
        const metadata = (rootLot && rootLot.metadata && typeof rootLot.metadata === 'object') ? rootLot.metadata : {};

        if (!metadata.reportSignatures || typeof metadata.reportSignatures !== 'object') metadata.reportSignatures = {};
        if (!metadata.reportSignatures[reportType] || typeof metadata.reportSignatures[reportType] !== 'object') {
            metadata.reportSignatures[reportType] = { signedBy: {} };
        }
        if (!metadata.reportSignatures[reportType].signedBy || typeof metadata.reportSignatures[reportType].signedBy !== 'object') {
            metadata.reportSignatures[reportType].signedBy = {};
        }

        // Si ya existe firma para ese firmante, solo permitir reemplazarla con permiso explícito.
        const existing = metadata.reportSignatures[reportType].signedBy[signerName];
        const effectivePerms = (!AUTH_ENABLED) ? ['*'] : (req.authUser?.permissions || []);
        if (existing && !hasPermission(effectivePerms, 'report.signatures.edit')) {
            return res.status(403).json({ error: 'No tienes permiso para modificar una firma ya registrada.' });
        }

        metadata.reportSignatures[reportType].signedBy[signerName] = {
            signedAt: new Date().toISOString(),
            signatureDataUrl
        };

        await db.saveLot('lotes', name, process, metadata);
        try { broadcastDataChanged({ entity: 'reportSignatures', action: 'upsert', reportType, signerName }); } catch (e) { /* noop */ }

        return res.json({ ok: true });
    } catch (err) {
        console.error('Error en POST /api/report-signatures:', err);
        return res.status(500).json({ error: err.message });
    }
});

function runSql(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function getSql(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, function (err, row) {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function allSql(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, function (err, rows) {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

// Guardar flags/estado del sistema en BD (para persistir comportamiento entre reinicios)
async function ensureSystemKvTable(database) {
    // Tabla súper simple key/value para flags del servidor
    await runSql(
        database,
        "CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    );
}

async function getSystemKv(database, key) {
    await ensureSystemKvTable(database);
    const row = await getSql(database, 'SELECT value FROM system_kv WHERE key = ? LIMIT 1', [key]);
    return row && typeof row.value === 'string' ? row.value : null;
}

async function setSystemKv(database, key, value) {
    await ensureSystemKvTable(database);
    const v = value == null ? '' : String(value);
    // Upsert
    await runSql(
        database,
        "INSERT INTO system_kv(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        [String(key), v]
    );
}

function isDataUrlImage(v) {
    try {
        return typeof v === 'string' && v.startsWith('data:') && v.includes(';base64,');
    } catch (e) {
        return false;
    }
}

function toForwardSlash(v) {
    return String(v || '').replace(/\\/g, '/');
}

function basenameSafe(p) {
    try {
        if (!p) return '';
        const norm = toForwardSlash(p);
        return norm.split('/').pop() || '';
    } catch (e) {
        return '';
    }
}

function toMs(v) {
    try {
        if (!v) return null;
        const d = new Date(v);
        const t = d.getTime();
        return Number.isFinite(t) ? t : null;
    } catch (e) {
        return null;
    }
}

function parseEngraveFilename(fileName) {
    // fileName: engrave_2025-12-17T14-00-15.843Z_033-641.jpeg
    // Devuelve { isoTimestamp, partNumber } si es posible.
    const base = String(fileName || '');
    const noExt = base.replace(/\.(jpe?g|png|gif|webp)$/i, '');
    const m = noExt.match(/^engrave_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,6}))?Z_(.+)$/i);
    if (!m) {
        // Fallback: usar último '_' como separador
        const idx = noExt.lastIndexOf('_');
        if (idx > 0) {
            const part = noExt.slice(idx + 1).trim();
            return { isoTimestamp: null, partNumber: part || null };
        }
        return { isoTimestamp: null, partNumber: null };
    }
    const date = m[1];
    const hh = m[2];
    const mm = m[3];
    const ss = m[4];
    const ms = m[5];
    const part = (m[6] || '').trim();
    const iso = `${date}T${hh}:${mm}:${ss}${ms ? '.' + ms : ''}Z`;
    return { isoTimestamp: iso, partNumber: part || null };
}

async function syncNetworkImagesToDb({ verbose = true } = {}) {
    // Fuente de verdad: carpeta \\ociserver\...\images
    const database = db.getDb();
    const imagesDir = path.join(TO_ENGRAVE_DIR, 'images');

    // Cutoff: si se ejecutó un cierre de mes, NO reimportar imágenes antiguas.
    // Esto evita que el sistema “reaparezca” tras un reset cuando los archivos siguen en la red.
    let cutoffMs = null;
    try {
        const cutoffIso = await getSystemKv(database, 'images_import_cutoff_iso');
        const ms = toMs(cutoffIso);
        cutoffMs = (ms !== null && Number.isFinite(ms)) ? ms : null;
    } catch (e) {
        cutoffMs = null;
    }

    // Asegurar pool
    if (db.isMssql) {
        await db.saveLot('lotes', 'LOTES', 'all', { system: true });
    } else {
        await runSql(
            database,
            'INSERT OR IGNORE INTO lotes (id, name, process, metadata) VALUES (?, ?, ?, ?)',
            ['lotes', 'LOTES', 'all', JSON.stringify({ system: true })]
        );
    }

    if (!fs.existsSync(imagesDir)) {
        if (verbose) console.warn('⚠️ No existe carpeta de imágenes:', imagesDir);
        return { ok: true, scanned: 0, inserted: 0, updated: 0, normalized: 0 };
    }

    const files = fs.readdirSync(imagesDir)
        .filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f))
        .map(f => path.basename(f));

    let inserted = 0;
    let updated = 0;
    let normalized = 0;
    let skippedByCutoff = 0;

    // 1) Normalizar registros existentes con imagen tipo 'images/...'
    const toNormalize = await allSql(
        database,
        "SELECT uid, imagen, partNumber FROM pieces WHERE imagen LIKE 'images/%' OR imagen LIKE 'images\\\\%'")
        .catch(() => []);

    for (const row of toNormalize) {
        const base = basenameSafe(row.imagen);
        if (!base) continue;
        const parsed = parseEngraveFilename(base);
        const newPart = (row.partNumber && String(row.partNumber).trim()) ? row.partNumber : (parsed.partNumber || null);
        await runSql(database, 'UPDATE pieces SET imagen = ?, partNumber = COALESCE(?, partNumber) WHERE uid = ?', [base, newPart, row.uid]);
        normalized++;
    }

    // 2) Insertar registros faltantes por cada archivo
    for (const file of files) {
        // Si hay cutoff, saltar imágenes antiguas/iguales al cierre de mes
        if (cutoffMs !== null) {
            try {
                const parsedForCutoff = parseEngraveFilename(file);
                let fileMs = toMs(parsedForCutoff.isoTimestamp);
                if (fileMs === null) {
                    try {
                        const st = fs.statSync(path.join(imagesDir, file));
                        fileMs = st && typeof st.mtimeMs === 'number' ? st.mtimeMs : null;
                    } catch (e) {
                        fileMs = null;
                    }
                }
                if (fileMs !== null && fileMs <= cutoffMs) {
                    skippedByCutoff++;
                    continue;
                }
            } catch (e) {
                // Si falla el parseo/stat, continuar sin bloquear
            }
        }

        const uid = `img_${file}`;
        const existing = await getSql(
            database,
            'SELECT uid, partNumber, imagen FROM pieces WHERE uid = ? OR imagen = ? LIMIT 1',
            [uid, file]
        );

        const parsed = parseEngraveFilename(file);
        const ts = parsed.isoTimestamp || new Date().toISOString();
        const part = parsed.partNumber || null;

        if (!existing) {
            try {
                await db.savePiece({
                    uid,
                    lot_id: 'lotes',
                    partNumber: part || '',
                    quantity: 0,
                    incidents: 0,
                    incidentType: '',
                    timestamp: ts,
                    imagen: file,
                    sourceFile: null,
                    clientId: null,
                    messageId: null,
                    proceso: 'laser',
                    metadata: { source: 'images_scan', file }
                });
                inserted++;
            } catch (e) {
                // si falla por PK/messageId unique u otros, ignorar
            }
        } else {
            // Completar partNumber si faltaba
            const needsPart = !existing.partNumber || String(existing.partNumber).trim() === '' || String(existing.partNumber).trim().toLowerCase() === 'null';
            const needsImg = existing.imagen && (String(existing.imagen).includes('/') || String(existing.imagen).includes('\\\\'));
            if ((needsPart && part) || needsImg) {
                const newImg = needsImg ? basenameSafe(existing.imagen) : existing.imagen;
                const newPart = (needsPart && part) ? part : existing.partNumber;
                await runSql(database, 'UPDATE pieces SET imagen = ?, partNumber = ? WHERE uid = ?', [newImg, newPart, existing.uid]);
                updated++;
            }
        }
    }

    if (verbose) {
        const cutoffTxt = cutoffMs ? new Date(cutoffMs).toISOString() : 'N/A';
        console.log(`🖼️ Sync imágenes -> BD: escaneadas=${files.length}, insertadas=${inserted}, actualizadas=${updated}, normalizadas=${normalized}, omitidasPorCutoff=${skippedByCutoff}, cutoff=${cutoffTxt}`);
    }

    return { ok: true, scanned: files.length, inserted, updated, normalized, skippedByCutoff, cutoffMs };
}

async function restoreQuantitiesFromLegacyDb({ verbose = true } = {}) {
    // Si existe un backup legacy (laser_grabado.db), restaurar quantity>0 por imagen.
    // Esto resuelve la columna Cantidad=0 cuando reconstruimos desde /images.
    const legacyPath = path.join(__dirname, 'laser_grabado.db');
    if (!fs.existsSync(legacyPath)) {
        if (verbose) console.log('ℹ️ No existe BD legacy para restaurar cantidades:', legacyPath);
        return { ok: true, legacyFound: false, legacyRows: 0, matched: 0, updated: 0, skipped: 0 };
    }

    const database = db.getDb();
    const startedAt = new Date().toISOString();

    const legacyDb = await new Promise((resolve, reject) => {
        const ldb = new sqlite3.Database(legacyPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) return reject(err);
            resolve(ldb);
        });
    });

    function legacyAll(sql, params = []) {
        return new Promise((resolve, reject) => {
            legacyDb.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    try {
        const cols = await legacyAll("PRAGMA table_info(pieces)");
        const colNames = new Set((cols || []).map(c => String(c?.name || '').toLowerCase()));
        const hasPart = colNames.has('part_number');
        const hasQty = colNames.has('quantity');
        const hasImg = colNames.has('image_data');
        const hasCreatedAt = colNames.has('created_at');
        const hasUpdatedAt = colNames.has('updated_at');
        if (!hasQty || !hasImg) {
            if (verbose) console.warn('⚠️ BD legacy no tiene columnas esperadas (quantity/image_data). Se omite restauración.');
            return { ok: true, legacyFound: true, legacyRows: 0, matched: 0, updated: 0, skipped: 0 };
        }

        const legacyRows = await legacyAll(
            `SELECT ${hasPart ? 'part_number,' : ''} quantity, image_data${hasCreatedAt ? ', created_at' : ''}${hasUpdatedAt ? ', updated_at' : ''} FROM pieces WHERE quantity IS NOT NULL AND quantity > 0 AND image_data IS NOT NULL AND TRIM(image_data) <> ''`
        );

        // Map: filename -> { qty, part }
        const byFile = new Map();
        const byPart = new Map();
        for (const r of legacyRows) {
            const img = r && r.image_data ? String(r.image_data) : '';
            const file = basenameSafe(img);
            const qty = Number(r && r.quantity);
            if (!file || !Number.isFinite(qty) || qty <= 0) continue;
            const part = hasPart ? (r && r.part_number ? String(r.part_number) : null) : null;
            const createdAt = (hasCreatedAt && r && r.created_at)
                ? String(r.created_at)
                : ((hasUpdatedAt && r && r.updated_at) ? String(r.updated_at) : null);
            const prev = byFile.get(file);
            if (!prev || qty > prev.qty) byFile.set(file, { qty, part, created_at: createdAt });

            if (part) {
                if (!byPart.has(part)) byPart.set(part, []);
                byPart.get(part).push({ qty, created_at: createdAt, file });
            }
        }

        for (const arr of byPart.values()) {
            arr.sort((a, b) => (toMs(b.created_at) || 0) - (toMs(a.created_at) || 0));
        }

        let matched = 0;
        let updated = 0;
        let skipped = 0;
        let updatedByPart = 0;

        for (const [file, info] of byFile.entries()) {
            const cur = await getSql(
                database,
                'SELECT uid, quantity, partNumber, metadata FROM pieces WHERE lot_id = ? AND imagen = ? LIMIT 1',
                ['lotes', file]
            );
            if (!cur || !cur.uid) {
                continue;
            }

            matched++;
            const curQty = Number(cur.quantity);
            if (Number.isFinite(curQty) && curQty > 0) {
                skipped++;
                continue;
            }

            let meta = {};
            try {
                meta = cur.metadata ? JSON.parse(cur.metadata) : {};
            } catch (e) {
                meta = {};
            }

            meta = {
                ...(meta || {}),
                quantityMissing: false,
                restored: {
                    ...(meta && meta.restored ? meta.restored : {}),
                    from: 'laser_grabado.db',
                    at: startedAt,
                    file,
                    qty: info.qty
                }
            };

            const newPart = (cur.partNumber && String(cur.partNumber).trim())
                ? cur.partNumber
                : (info.part || cur.partNumber || '');

            const res = await runSql(
                database,
                'UPDATE pieces SET quantity = ?, partNumber = ?, metadata = ? WHERE uid = ?',
                [info.qty, newPart, JSON.stringify(meta), cur.uid]
            );

            if (res && res.changes) updated++;
        }

        // Fallback: recuperar por part_number + timestamp aproximado (si aún queda quantity=0)
        const remaining = await allSql(
            database,
            "SELECT uid, partNumber, timestamp, metadata FROM pieces WHERE lot_id='lotes' AND quantity = 0 AND partNumber IS NOT NULL AND TRIM(partNumber) <> ''"
        ).catch(() => []);

        const MAX_DIFF_MS = 21 * 24 * 60 * 60 * 1000; // 21 días

        for (const p of remaining) {
            const part = p && p.partNumber ? String(p.partNumber) : '';
            if (!part) continue;
            const candidates = byPart.get(part) || [];
            if (!candidates.length) continue;

            const tMs = toMs(p.timestamp);
            let chosen = candidates[0];
            let bestDiff = Infinity;

            if (tMs !== null) {
                for (const c of candidates) {
                    const cMs = toMs(c.created_at);
                    if (cMs === null) continue;
                    const diff = Math.abs(cMs - tMs);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        chosen = c;
                    }
                }
            }

            if (tMs !== null) {
                if (!(bestDiff < Infinity && bestDiff <= MAX_DIFF_MS)) continue;
            } else {
                if (candidates.length !== 1) continue;
            }

            let meta = {};
            try {
                meta = p.metadata ? JSON.parse(p.metadata) : {};
            } catch (e) {
                meta = {};
            }

            meta = {
                ...(meta || {}),
                quantityMissing: false,
                restored: {
                    ...(meta && meta.restored ? meta.restored : {}),
                    from: 'laser_grabado.db',
                    at: startedAt,
                    method: 'part_match',
                    part,
                    qty: chosen.qty,
                    legacyFile: chosen.file || null,
                    legacyAt: chosen.created_at || null
                }
            };

            const res = await runSql(database, 'UPDATE pieces SET quantity = ?, metadata = ? WHERE uid = ?', [chosen.qty, JSON.stringify(meta), p.uid]);
            if (res && res.changes) updatedByPart++;
        }

        if (verbose) {
            console.log(`🧩 Restauración cantidades (legacy): filas=${legacyRows.length}, matched=${matched}, updated=${updated}, updatedByPart=${updatedByPart}, skipped=${skipped}`);
        }

        return { ok: true, legacyFound: true, legacyRows: legacyRows.length, matched, updated, updatedByPart, skipped };
    } catch (e) {
        if (verbose) console.warn('⚠️ Restauración cantidades (legacy) falló:', e && e.message ? e.message : e);
        return { ok: false, legacyFound: true, error: e && e.message ? e.message : String(e) };
    } finally {
        try {
            legacyDb.close();
        } catch (e) { /* ignore */ }
    }
}

// Auto-restauración (debounced): si por alguna sincronización parcial las cantidades
// quedan en 0, y existe la BD legacy, re-aplicar cantidades > 0 desde el backup.
let restoreQtyInFlight = null;
let lastRestoreQtyAt = 0;
const RESTORE_QTY_MIN_INTERVAL_MS = 30_000;

async function maybeAutoRestoreQuantitiesFromLegacy({ verbose = false, reason = '' } = {}) {
    try {
        const now = Date.now();
        if (restoreQtyInFlight) return await restoreQtyInFlight;
        if ((now - lastRestoreQtyAt) < RESTORE_QTY_MIN_INTERVAL_MS) return null;

        const legacyPath = path.join(__dirname, 'laser_grabado.db');
        if (!fs.existsSync(legacyPath)) return null;

        const database = db.getDb();
        const row = await getSql(database, 'SELECT COUNT(*) AS c FROM pieces WHERE lot_id = ? AND quantity > 0', ['lotes']);
        const countPos = row && typeof row.c === 'number' ? row.c : parseInt(row?.c || '0', 10);
        if ((countPos || 0) > 0) return null;

        restoreQtyInFlight = (async () => {
            lastRestoreQtyAt = Date.now();
            if (verbose) console.warn(`🧯 Auto-restore cantidades: detectado quantity=0 en lote 'lotes'. Restaurando desde legacy... (${reason})`);
            return await restoreQuantitiesFromLegacyDb({ verbose: !!verbose });
        })();

        return await restoreQtyInFlight;
    } catch (e) {
        return null;
    } finally {
        restoreQtyInFlight = null;
    }
}

// Auto-recuperación: si la BD quedó vacía pero existen imágenes en la carpeta fuente,
// re-poblar el lote 'lotes'. Se protege con debounce para evitar escaneos repetidos.
let autoRecoverInFlight = null;
let lastAutoRecoverAt = 0;
const AUTO_RECOVER_MIN_INTERVAL_MS = 30_000;

async function maybeAutoRecoverLotesFromImages({ verbose = false, reason = '' } = {}) {
    try {
        // IMPORTANTE:
        // Esto puede hacer que los datos "reaparezcan" después de un reset/cierre de mes,
        // porque si hay archivos en TO_ENGRAVE_DIR\images repoblará la BD.
        // Por eso se deja desactivado por defecto y se habilita solo si se requiere:
        // AUTO_RECOVER_FROM_IMAGES=true
        const autoRecoverEnabled = String(process.env.AUTO_RECOVER_FROM_IMAGES || '').toLowerCase() === 'true';
        if (!autoRecoverEnabled) return null;

        const now = Date.now();
        if (autoRecoverInFlight) return await autoRecoverInFlight;
        if ((now - lastAutoRecoverAt) < AUTO_RECOVER_MIN_INTERVAL_MS) return null;

        const database = db.getDb();
        const row = await getSql(database, 'SELECT COUNT(*) AS c FROM pieces WHERE lot_id = ?', ['lotes']);
        const count = row && typeof row.c === 'number' ? row.c : parseInt(row?.c || '0', 10);
        if ((count || 0) > 0) return null;

        // Solo intentar si existe la carpeta images con al menos un archivo.
        const imagesDir = path.join(TO_ENGRAVE_DIR, 'images');
        if (!fs.existsSync(imagesDir)) return null;
        const files = fs.readdirSync(imagesDir).filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f));
        if (!files || files.length === 0) return null;

        autoRecoverInFlight = (async () => {
            lastAutoRecoverAt = Date.now();
            if (verbose) console.warn(`🧯 Auto-recovery: BD sin piezas en 'lotes'. Re-sincronizando desde images... (${reason})`);
            const result = await syncNetworkImagesToDb({ verbose: !!verbose });
            return result;
        })();

        const out = await autoRecoverInFlight;
        return out;
    } catch (e) {
        return null;
    } finally {
        autoRecoverInFlight = null;
    }
}

function ensureResetPassword(reqPassword) {
    // Comparación simple (entorno local). Si quieres mayor seguridad: rate-limit + timingSafeEqual.
    if (!AUTH_REQUIRE_PASSWORD) return true;
    return typeof reqPassword === 'string' && reqPassword.length > 0 && reqPassword === RESET_PASSWORD;
}

// Manejar errores de body-parser (p.ej. PayloadTooLargeError) y devolver 413
app.use((err, req, res, next) => {
    if (!err) return next();
    try {
        if (err.type === 'entity.too.large' || err.status === 413) {
            console.error('PayloadTooLargeError:', err.message || err);
            return res.status(413).json({ error: 'Payload too large' });
        }
    } catch (e) {
        // ignore and pass to next
    }
    return next(err);
});

function getChromeExecutablePath() {
    const envPath = String(process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
    if (envPath && fs.existsSync(envPath)) return envPath;

    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (e) { /* noop */ }
    }

    return null;
}

const chromePath = getChromeExecutablePath();
if (chromePath) {
    console.log(`✅ Usando Chrome/Edge para WhatsApp: ${chromePath}`);
} else {
    console.warn('⚠️ No se encontró Chrome/Edge. Instala Google Chrome o Microsoft Edge para habilitar QR.');
}

const puppeteerOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
};
if (chromePath) puppeteerOptions.executablePath = chromePath;

const WHATSAPP_AUTH_DIR = path.resolve(process.cwd(), '.wwebjs_auth');
const WHATSAPP_SESSION_DIR = path.join(WHATSAPP_AUTH_DIR, 'session');

function psSingleQuoted(value) {
    return `'${String(value || '').replace(/'/g, "''")}'`;
}

function normalizeCommandPath(value) {
    return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function runPowerShell(script, timeoutMs = 10000) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            return resolve({ ok: false, skipped: true, stdout: '', stderr: 'win32 only' });
        }

        execFile(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { windowsHide: true, timeout: timeoutMs },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    error: error ? (error.message || String(error)) : null,
                    stdout: String(stdout || ''),
                    stderr: String(stderr || '')
                });
            }
        );
    });
}

async function stopWhatsAppBrowserProcesses(reason = '') {
    const sessionNeedle = normalizeCommandPath(WHATSAPP_SESSION_DIR);
    const authNeedle = normalizeCommandPath(WHATSAPP_AUTH_DIR);
    const script = `
$needles = @(${psSingleQuoted(sessionNeedle)}, ${psSingleQuoted(authNeedle)})
$names = @('chrome.exe','msedge.exe','chromium.exe')
$killed = @()
Get-CimInstance Win32_Process | Where-Object {
    $names -contains $_.Name -and $_.CommandLine
} | ForEach-Object {
    $cmd = $_.CommandLine.ToLower().Replace('/', '\\')
    foreach ($needle in $needles) {
        if ($needle -and $cmd.Contains($needle)) {
            try {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
                $killed += $_.ProcessId
            } catch {}
            break
        }
    }
}
$killed -join ','
`;

    const result = await runPowerShell(script, 12000);
    const killed = result.stdout
        .split(',')
        .map(x => parseInt(String(x).trim(), 10))
        .filter(n => Number.isFinite(n));

    if (killed.length) {
        console.warn(`WhatsApp restart: procesos Chrome/Edge cerrados (${killed.join(', ')}). Motivo: ${reason || 'reinicio'}`);
    }

    return { ok: result.ok, killedProcesses: killed.length, killedPids: killed, error: result.error || result.stderr || null };
}

function cleanupWhatsAppSessionLocks() {
    const removed = [];
    const candidates = [
        path.join(WHATSAPP_SESSION_DIR, 'SingletonLock'),
        path.join(WHATSAPP_SESSION_DIR, 'SingletonSocket'),
        path.join(WHATSAPP_SESSION_DIR, 'SingletonCookie'),
        path.join(WHATSAPP_SESSION_DIR, 'Default', 'LOCK')
    ];

    for (const file of candidates) {
        try {
            if (fs.existsSync(file)) {
                fs.rmSync(file, { force: true });
                removed.push(path.basename(file));
            }
        } catch (e) {
            console.warn('No se pudo limpiar lock de WhatsApp:', file, e?.message || e);
        }
    }

    return removed;
}

function isWhatsAppProfileLockError(message) {
    const msg = String(message || '').toLowerCase();
    return msg.includes('browser is already running')
        || msg.includes('used by another process')
        || msg.includes('userdata')
        || msg.includes('userdatadir')
        || (msg.includes('failed to launch the browser process') && msg.includes('code: 0'));
}

// Cliente WhatsApp: se recrea en cada reinicio. Reusar una instancia destruida
// puede dejar whatsapp-web.js sin volver a emitir QR.
let client = null;
let waClientGeneration = 0;

function createWhatsAppClient() {
    const generation = ++waClientGeneration;
    const nextClient = new Client({
        authStrategy: new LocalAuth({ dataPath: WHATSAPP_AUTH_DIR }),
        puppeteer: puppeteerOptions
    });

    attachWhatsAppEventHandlers(nextClient, generation);
    return nextClient;
}

function ensureWhatsAppClient({ recreate = false } = {}) {
    if (!client || recreate) {
        client = createWhatsAppClient();
    }
    return client;
}

client = createWhatsAppClient();

// Inicialización robusta de WhatsApp (evita quedar atascado en authenticated=false y qr=null)
let waInitInProgress = false;
let waInitRetryTimer = null;
let waInitAttempt = 0;
const WA_INIT_RETRY_BASE_MS = 2000;
const WA_INIT_RETRY_MAX_MS = 15000;
let waLastError = null;
let waLastRestartAt = null;
let waLastRestartReason = null;
let waAutoRecoverAt = 0;
const WA_AUTO_RECOVER_MIN_INTERVAL_MS = 30000;
let waSuppressDisconnectUntil = 0;

function clearWaInitRetryTimer() {
    try {
        if (waInitRetryTimer) {
            clearTimeout(waInitRetryTimer);
            waInitRetryTimer = null;
        }
    } catch (e) {
        waInitRetryTimer = null;
    }
}

function computeWaInitRetryDelayMs(attempt) {
    const n = Math.max(1, Number(attempt) || 1);
    return Math.min(WA_INIT_RETRY_BASE_MS * Math.pow(2, Math.min(n - 1, 3)), WA_INIT_RETRY_MAX_MS);
}

function scheduleWhatsAppInitialize(reason = 'startup', delayMs = 0) {
    const wait = Math.max(0, Number(delayMs) || 0);
    clearWaInitRetryTimer();
    waInitRetryTimer = setTimeout(() => {
        waInitRetryTimer = null;
        void initializeWhatsAppClient(reason);
    }, wait);
}

async function initializeWhatsAppClient(reason = 'startup') {
    if (waInitInProgress) {
        return false;
    }

    waInitInProgress = true;
    waInitAttempt += 1;
    const attempt = waInitAttempt;

    try {
        console.log(`🔌 Inicializando cliente WhatsApp (intento ${attempt})${reason ? ` | ${reason}` : ''}`);
        const waClient = ensureWhatsAppClient();
        await waClient.initialize();
        return true;
    } catch (err) {
        const msg = String(err && err.message ? err.message : err || 'unknown error');
        waLastError = msg;
        console.error(`❌ client.initialize() falló (intento ${attempt}):`, msg);
        if (isWhatsAppProfileLockError(msg)) {
            const recovered = await autoRecoverLockedWhatsAppProfile(msg);
            if (recovered) return false;
        }
        try { await client?.destroy(); } catch (e) { /* noop */ }
        ensureWhatsAppClient({ recreate: true });
        const delay = computeWaInitRetryDelayMs(attempt);
        scheduleWhatsAppInitialize(`reintento tras error: ${msg.slice(0, 120)}`, delay);
        return false;
    } finally {
        waInitInProgress = false;
    }
}

// Recarga suave de WhatsApp Web (throttled) para errores intermitentes en downloadMedia
let lastWaWebReloadAt = 0;
const WA_WEB_RELOAD_MIN_INTERVAL_MS = 1000 * 60; // 1 minuto

let lastWaHardResetAt = 0;
const WA_HARD_RESET_MIN_INTERVAL_MS = 1000 * 60 * 5; // 5 minutos
let waResetting = false;

async function maybeReloadWaWeb(reason = '') {
    try {
        const now = Date.now();
        if ((now - lastWaWebReloadAt) < WA_WEB_RELOAD_MIN_INTERVAL_MS) return false;
        if (!client || !client.pupPage || typeof client.pupPage.reload !== 'function') return false;

        lastWaWebReloadAt = now;
        console.warn(`🧩 Recargando WhatsApp Web (soft reload). Motivo: ${reason || 'error transitorio'}`);
        await client.pupPage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        return true;
    } catch (e) {
        console.warn('⚠️ No se pudo recargar WhatsApp Web:', e?.message || e);
        return false;
    }
}

async function maybeHardResetWa(reason = '') {
    try {
        const now = Date.now();
        if ((now - lastWaHardResetAt) < WA_HARD_RESET_MIN_INTERVAL_MS) return false;
        if (waResetting) return false;
        waResetting = true;
        waSuppressDisconnectUntil = Date.now() + 8000;
        lastWaHardResetAt = now;
        console.warn(`🧯 Reiniciando cliente WhatsApp (hard reset). Motivo: ${reason || 'inestabilidad'}`);
        try { await client?.destroy(); } catch (e) { /* ignore */ }
        ensureWhatsAppClient({ recreate: true });
        qrCode = null;
        isAuthenticated = false;
        scheduleWhatsAppInitialize(`hard-reset: ${reason || 'inestabilidad'}`, 300);
        setTimeout(() => { waResetting = false; }, 5000);
        return true;
    } catch (e) {
        console.warn('⚠️ No se pudo hard-reset WhatsApp:', e?.message || e);
        waResetting = false;
        return false;
    }
}

async function restartWhatsAppClient({ reason = 'manual', killLockedBrowser = true } = {}) {
    const cleanReason = String(reason || 'manual');
    clearWaInitRetryTimer();
    waInitAttempt = 0;
    waResetting = true;
    waSuppressDisconnectUntil = Date.now() + 8000;
    waLastRestartAt = new Date().toISOString();
    waLastRestartReason = cleanReason;

    let killResult = { ok: true, killedProcesses: 0, killedPids: [] };
    let removedLocks = [];

    try {
        console.warn(`Reiniciando WhatsApp. Motivo: ${cleanReason}`);
        try { addWhatsAppLog('restart', 'Reinicio WhatsApp solicitado', { reason: cleanReason }, 'warn'); } catch (e) { /* noop */ }

        try {
            await client?.destroy();
        } catch (e) {
            const msg = e?.message || String(e || '');
            if (msg) console.warn('WhatsApp restart: destroy no completado:', msg);
        }

        if (killLockedBrowser) {
            killResult = await stopWhatsAppBrowserProcesses(cleanReason);
        }

        removedLocks = cleanupWhatsAppSessionLocks();
        ensureWhatsAppClient({ recreate: true });

        qrCode = null;
        isAuthenticated = false;
        waLastError = null;

        scheduleWhatsAppInitialize(`restart: ${cleanReason}`, 700);

        return {
            ok: true,
            message: 'WhatsApp se esta reiniciando. Espera unos segundos para ver conexion o QR.',
            sessionDir: WHATSAPP_SESSION_DIR,
            killedProcesses: killResult.killedProcesses || 0,
            killedPids: killResult.killedPids || [],
            removedLocks
        };
    } finally {
        setTimeout(() => { waResetting = false; }, 5000);
    }
}

async function autoRecoverLockedWhatsAppProfile(errorMessage) {
    const now = Date.now();
    if ((now - waAutoRecoverAt) < WA_AUTO_RECOVER_MIN_INTERVAL_MS) return false;
    waAutoRecoverAt = now;

    const reason = `perfil bloqueado: ${String(errorMessage || '').slice(0, 100)}`;
    try {
        addWhatsAppLog('restart', 'Perfil WhatsApp bloqueado; recuperacion automatica', { reason }, 'warn');
    } catch (e) { /* noop */ }

    await restartWhatsAppClient({ reason, killLockedBrowser: true });
    return true;
}

// =============================
// Cola de reintentos de media (WhatsApp)
// =============================
const mediaRetryQueue = [];
const MEDIA_RETRY_MAX = 6;
const MEDIA_RETRY_BASE_DELAY_MS = 2500;

function enqueueMediaRetry({ messageId, chatId, uid, numParte, numPiezas }) {
    try {
        if (!messageId) return false;
        const exists = mediaRetryQueue.some(x => x && x.messageId === messageId);
        if (exists) return false;

        mediaRetryQueue.push({
            messageId,
            chatId: chatId || null,
            uid: uid || null,
            numParte: numParte || null,
            numPiezas: (numPiezas !== undefined ? numPiezas : null),
            attempts: 0,
            nextAt: Date.now() + 1200
        });
        console.warn(`🕒 Encolada descarga de imagen pendiente: ${messageId}`);
        return true;
    } catch (e) {
        return false;
    }
}

async function tryFetchMessageById({ messageId, chatId }) {
    try {
        if (!client) return null;
        if (typeof client.getMessageById === 'function') {
            try {
                const msg = await client.getMessageById(messageId);
                if (msg) return msg;
            } catch (e) { /* ignore */ }
        }
        if (chatId && typeof client.getChatById === 'function') {
            const chat = await client.getChatById(chatId);
            if (!chat || typeof chat.fetchMessages !== 'function') return null;
            const recent = await chat.fetchMessages({ limit: 50 });
            const found = (recent || []).find(m => {
                const mid = m && m.id ? (m.id._serialized || m.id.id) : null;
                return mid && String(mid) === String(messageId);
            });
            return found || null;
        }
    } catch (e) {
        return null;
    }
    return null;
}

async function processMediaRetryQueue() {
    try {
        if (!mediaRetryQueue.length) return;
        if (!isAuthenticated || waResetting) return;
        const now = Date.now();
        const pending = mediaRetryQueue.filter(x => x && x.nextAt <= now);
        if (!pending.length) return;

        for (const item of pending) {
            item.attempts += 1;
            const attempt = item.attempts;

            const msg = await tryFetchMessageById({ messageId: item.messageId, chatId: item.chatId });
            if (!msg || !msg.hasMedia) {
                if (attempt >= MEDIA_RETRY_MAX) {
                    console.warn(`🧱 Media retry agotado para ${item.messageId} (sin mensaje/adjunto)`);
                    mediaRetryQueue.splice(mediaRetryQueue.indexOf(item), 1);
                } else {
                    if (attempt >= 3) {
                        await maybeHardResetWa('media retry sin mensaje');
                    }
                    item.nextAt = Date.now() + MEDIA_RETRY_BASE_DELAY_MS * attempt;
                }
                continue;
            }

            try {
                const media = await msg.downloadMedia();
                if (media) {
                    const imagenBase64 = `data:${media.mimetype};base64,${media.data}`;
                    const uid = item.uid || makeWhatsAppUid(item.messageId || `${Date.now()}_${item.numParte || 'SIN_PARTE'}`);

                    const existing = await db.getPieceByUid(uid).catch(() => null);
                    if (existing) {
                        await db.savePiece({
                            uid,
                            lot_id: existing.lot_id,
                            partNumber: existing.partNumber,
                            quantity: existing.quantity,
                            incidents: existing.incidents,
                            incidentType: existing.incidentType || '',
                            timestamp: existing.timestamp || new Date().toISOString(),
                            imagen: imagenBase64,
                            sourceFile: existing.sourceFile || null,
                            clientId: existing.clientId || null,
                            messageId: existing.messageId || item.messageId || null,
                            proceso: existing.proceso || '',
                            metadata: {
                                ...(existing.metadata || {}),
                                mediaRecoveredAt: new Date().toISOString()
                            }
                        });
                    } else {
                        await db.savePiece({
                            uid,
                            lot_id: WHATSAPP_INBOX_LOT_ID,
                            partNumber: item.numParte || '',
                            quantity: (item.numPiezas !== undefined && item.numPiezas !== null && !isNaN(Number(item.numPiezas))) ? Number(item.numPiezas) : 0,
                            incidents: 0,
                            incidentType: '',
                            timestamp: new Date().toISOString(),
                            imagen: imagenBase64,
                            sourceFile: null,
                            clientId: null,
                            messageId: item.messageId || null,
                            proceso: 'laser',
                            metadata: { source: 'whatsapp', mediaRecoveredAt: new Date().toISOString() }
                        });
                    }

                    try { broadcastDataChanged({ entity: 'piece', action: 'update', uid, messageId: item.messageId }); } catch (e) { /* noop */ }
                    console.log(`✅ Imagen recuperada y guardada para messageId=${item.messageId}`);
                    mediaRetryQueue.splice(mediaRetryQueue.indexOf(item), 1);
                    continue;
                }
            } catch (e) {
                const errMsg = String(e?.message || e || '');
                console.warn(`⚠️ Media retry fallo (${attempt}/${MEDIA_RETRY_MAX}) ${item.messageId}:`, errMsg.slice(0, 200));
                if (errMsg.includes('getChat') || errMsg.includes('Msg') || errMsg.includes('addAnnotations') || errMsg.includes('Evaluation failed')) {
                    await maybeReloadWaWeb('media retry');
                    if (attempt >= 3) {
                        await maybeHardResetWa('media retry persistente');
                    }
                }
            }

            if (attempt >= MEDIA_RETRY_MAX) {
                console.warn(`🧱 Media retry agotado para ${item.messageId}`);
                mediaRetryQueue.splice(mediaRetryQueue.indexOf(item), 1);
            } else {
                item.nextAt = Date.now() + MEDIA_RETRY_BASE_DELAY_MS * attempt;
            }
        }
    } catch (e) {
        console.warn('⚠️ Error procesando cola de media:', e?.message || e);
    }
}

setInterval(() => {
    processMediaRetryQueue().catch(() => { /* ignore */ });
}, 4000);

async function safeSendMessage(to, message, options = {}) {
    try {
        if (typeof message === 'string' && message.includes('Mensaje ya procesado')) {
            console.log('ℹ️ Respuesta omitida (Mensaje ya procesado)');
            return true;
        }
        await client.sendMessage(to, message, options);
        return true;
    } catch (e) {
        const errMsg = String(e?.message || e || '');
        console.warn('⚠️ sendMessage falló:', errMsg.slice(0, 200));
        if (errMsg.includes('getChat') || errMsg.includes('Msg') || errMsg.includes('Evaluation failed')) {
            await maybeReloadWaWeb('sendMessage failure');
            await maybeHardResetWa('sendMessage failure');
        }
        return false;
    }
}

// Variables globales
let qrCode = null;
let isAuthenticated = false;
let registros = [];
// SSE clients (Server-Sent Events) para notificar al frontend en tiempo real
let sseClients = [];

// =============================
// Presencia (usuarios conectados)
// =============================

function sanitizePresenceName(name) {
    try {
        if (name === null || name === undefined) return '';
        let s = String(name);
        // Limitar longitud para evitar abusos
        if (s.length > 80) s = s.slice(0, 80);
        // Limpiar control chars
        s = s.replace(/[\u0000-\u001F\u007F]/g, '').trim();
        // Reducir espacios múltiples
        s = s.replace(/\s{2,}/g, ' ');
        return s;
    } catch (e) {
        return '';
    }
}

function sanitizePresenceKey(v) {
    try {
        if (v === null || v === undefined) return '';
        let s = String(v).trim();
        if (s.length > 120) s = s.slice(0, 120);
        // Solo caracteres seguros para IDs
        s = s.replace(/[^a-zA-Z0-9_\-:.]/g, '');
        return s;
    } catch (e) {
        return '';
    }
}

function getPresenceSnapshot() {
    // Devolver lista única por clientKey (no por conexión), con conteo de pestañas.
    try {
        const map = new Map();
        const now = Date.now();

        for (const c of (sseClients || [])) {
            if (!c) continue;
            const user = c.user || {};
            const key = user.clientKey || '';
            if (!key) continue;

            const prev = map.get(key);
            if (!prev) {
                map.set(key, {
                    clientKey: key,
                    name: user.name || 'Usuario',
                    connections: 1,
                    connectedAt: user.connectedAt || now,
                    lastSeen: now
                });
            } else {
                prev.connections += 1;
                prev.lastSeen = now;
                // Mantener el nombre más reciente/no vacío
                if (user.name && user.name.trim()) prev.name = user.name;
            }
        }

        const users = Array.from(map.values());
        users.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
        return {
            count: users.length,
            users
        };
    } catch (e) {
        return { count: 0, users: [] };
    }
}

function broadcastPresenceUpdate() {
    try {
        const snap = getPresenceSnapshot();
        broadcastSsePayload({ type: 'presence', presence: snap });
    } catch (e) {
        // noop
    }
}
// Guardar messageIds recientes para evitar procesar el mismo mensaje varias veces
// Clave: messageId (string) -> timestamp (ms)
const recentMessageIds = new Map();
const RECENT_ID_TTL_MS = 1000 * 60 * 5; // 5 minutos

function isDuplicateMessageId(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    // Eliminar entradas antiguas
    for (const [id, ts] of recentMessageIds.entries()) {
        if (now - ts > RECENT_ID_TTL_MS) recentMessageIds.delete(id);
    }
    if (recentMessageIds.has(messageId)) return true;
    recentMessageIds.set(messageId, now);
    return false;
}

// Prevención adicional de duplicados por contenido (firma simple)
// Evita crear varios archivos casi simultáneos con mismo numParte+numPiezas+imagen
const recentSavedSignatures = new Map();
const SIGNATURE_TTL_MS = 1000 * 15; // 15s

function makeSignature(numParte, numPiezas, imagen) {
    // Usar una porción de la imagen/data para la firma si existe
    let imgSig = 'NOIMG';
    try {
        if (imagen && typeof imagen === 'string') {
            imgSig = 'IMG:' + imagen.slice(0, 80);
        }
    } catch (e) { imgSig = 'IMGERR'; }
    return `${String(numParte)}|${String(numPiezas)}|${imgSig}`;
}

function getRecentSavedRutaForSignature(sig) {
    const now = Date.now();
    const entry = recentSavedSignatures.get(sig);
    if (!entry) return null;
    if (now - entry.ts > SIGNATURE_TTL_MS) {
        recentSavedSignatures.delete(sig);
        return null;
    }
    return entry.ruta;
}

function rememberSavedSignature(sig, ruta) {
    recentSavedSignatures.set(sig, { ruta, ts: Date.now() });
}
// Nota: la gestión de tokens/ALTA fue eliminada. No se almacenan ni gestionan tokens en el servidor.

// Número del bot (puede establecerse por env BOT_NUMBER o detectarse al ready)
let BOT_NUMBER = process.env.BOT_NUMBER || null;

// 🔒 CONFIGURACIÓN DE GRUPO WHITELIST
// Solo procesar mensajes de grupos específicos
// Puede configurarse por variable de entorno ALLOWED_GROUPS_JSON
// Ejemplo: ALLOWED_GROUPS_JSON='{"grupo1":"Nombre Grupo Recepción","grupo2":"Grupo Producción"}'
// O dejar vacío para ACEPTAR TODOS LOS GRUPOS
let ALLOWED_GROUPS = {};
let ALLOWED_GROUPS_ALL = [];
let ALLOWED_GROUPS_SOURCE = 'file';
let USE_GROUP_FILTER = false;

const WHATSAPP_GROUPS_KV_KEY = 'whatsapp_allowed_groups_v1';
const ALLOWED_GROUPS_PATH = path.resolve(String(process.env.ALLOWED_GROUPS_FILE || path.join(RUNTIME_CONFIG_DIR, 'allowed_groups.json')).trim());

function normalizeAllowedGroupEntries(value) {
    const out = [];
    if (!value) return out;

    if (Array.isArray(value)) {
        value.forEach((item) => {
            if (!item) return;
            if (typeof item === 'string') {
                const id = String(item || '').trim();
                if (!id) return;
                out.push({ id, name: id, active: true });
                return;
            }
            if (typeof item === 'object') {
                const id = String(item.id || item.jid || item.groupId || item.key || '').trim();
                if (!id) return;
                const name = String(item.name || item.label || item.title || '').trim();
                const active = item.active !== false;
                out.push({ id, name: name || id, active });
            }
        });
        return out;
    }

    if (typeof value === 'object') {
        Object.entries(value).forEach(([key, val]) => {
            const id = String(key || '').trim();
            if (!id) return;
            if (val && typeof val === 'object') {
                const name = String(val.name || val.label || val.title || '').trim();
                const active = val.active !== false;
                out.push({ id, name: name || id, active });
            } else {
                const name = String(val || '').trim();
                out.push({ id, name: name || id, active: true });
            }
        });
    }

    return out;
}

function dedupeAllowedGroupEntries(entries) {
    const map = new Map();
    (entries || []).forEach((entry) => {
        if (!entry || !entry.id) return;
        map.set(entry.id, {
            id: String(entry.id).trim(),
            name: String(entry.name || entry.id || '').trim() || String(entry.id).trim(),
            active: entry.active !== false
        });
    });
    return Array.from(map.values());
}

function buildActiveGroupsMap(entries) {
    const out = {};
    (entries || []).forEach((entry) => {
        if (!entry || !entry.id) return;
        if (entry.active === false) return;
        const id = String(entry.id).trim();
        if (!id) return;
        const name = String(entry.name || entry.id || '').trim() || id;
        out[id] = name;
    });
    return out;
}

function entriesToLegacyMap(entries) {
    return buildActiveGroupsMap(entries);
}

function readAllowedGroupsFile() {
    try {
        if (!fs.existsSync(ALLOWED_GROUPS_PATH)) return [];
        const raw = fs.readFileSync(ALLOWED_GROUPS_PATH, 'utf-8');
        return dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(JSON.parse(raw || '{}')));
    } catch (e) {
        return [];
    }
}

function writeAllowedGroupsFile(entries) {
    const payload = JSON.stringify(entriesToLegacyMap(entries), null, 2);
    fs.writeFileSync(ALLOWED_GROUPS_PATH, payload, 'utf-8');
}

async function readAllowedGroupsDb(database) {
    const raw = await getSystemKv(database, WHATSAPP_GROUPS_KV_KEY);
    if (!raw) return [];
    try {
        return dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(JSON.parse(raw)));
    } catch (e) {
        return [];
    }
}

async function writeAllowedGroupsDb(database, entries) {
    const normalized = dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(entries));
    await setSystemKv(database, WHATSAPP_GROUPS_KV_KEY, JSON.stringify(normalized));
}

function setAllowedGroups(entries, source) {
    const normalized = dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(entries));
    ALLOWED_GROUPS_ALL = normalized;
    ALLOWED_GROUPS = buildActiveGroupsMap(normalized);
    USE_GROUP_FILTER = Object.keys(ALLOWED_GROUPS).length > 0;
    if (source) ALLOWED_GROUPS_SOURCE = source;
}

async function loadGroupConfig() {
    let usedEnv = false;
    if (process.env.ALLOWED_GROUPS_JSON) {
        usedEnv = true;
        try {
            setAllowedGroups(JSON.parse(process.env.ALLOWED_GROUPS_JSON), 'env');
            console.log('🔒 Filtro de grupo configurado por variable de entorno');
        } catch (err) {
            console.error('❌ Error parseando ALLOWED_GROUPS_JSON:', err);
            setAllowedGroups([], 'env');
        }
    }

    if (!usedEnv) {
        let entries = [];
        let source = 'db';
        try {
            const database = db.getDb();
            entries = await readAllowedGroupsDb(database);
        } catch (e) {
            entries = [];
        }

        if (!entries.length) {
            source = 'file';
            entries = readAllowedGroupsFile();
            if (entries.length) {
                try {
                    const database = db.getDb();
                    await writeAllowedGroupsDb(database, entries);
                } catch (e) { /* noop */ }
            }
        }

        setAllowedGroups(entries, source);

        try {
            writeAllowedGroupsFile(ALLOWED_GROUPS_ALL);
        } catch (e) { /* noop */ }
    }

    const activeCount = ALLOWED_GROUPS_ALL.filter(g => g.active !== false).length;
    if (USE_GROUP_FILTER) {
        console.log('🔒 Filtro de grupo ACTIVO. Grupos autorizados:');
        ALLOWED_GROUPS_ALL.filter(g => g.active !== false).forEach((g) => {
            console.log(`   ✅ ${g.name} (${g.id})`);
        });
    } else {
        console.log('🟢 Filtro de grupo INACTIVO - Aceptando mensajes de cualquier grupo/contacto');
    }
    addWhatsAppLog('filter', USE_GROUP_FILTER ? `Filtro activo (${activeCount})` : 'Filtro inactivo (sin grupos)', {
        source: ALLOWED_GROUPS_SOURCE,
        activeCount
    });
}

const WHATSAPP_LOG_LIMIT = Math.max(50, parseInt(process.env.WHATSAPP_LOG_LIMIT || '300', 10) || 300);
let whatsappLogBuffer = [];
let whatsappLogSeq = 0;

function pushWhatsAppLog(entry) {
    whatsappLogBuffer.push(entry);
    if (whatsappLogBuffer.length > WHATSAPP_LOG_LIMIT) {
        whatsappLogBuffer = whatsappLogBuffer.slice(-WHATSAPP_LOG_LIMIT);
    }
    try { broadcastSsePayload({ type: 'whatsapp-log', entry }); } catch (e) { /* noop */ }
}

function addWhatsAppLog(type, message, meta = null, level = 'info') {
    const entry = {
        id: ++whatsappLogSeq,
        ts: new Date().toISOString(),
        type: String(type || 'info'),
        level: String(level || 'info'),
        message: String(message || ''),
        meta: meta || null
    };
    pushWhatsAppLog(entry);
}

// Nota: se eliminó la gestión de usuarios autorizados para permitir
// que el sistema acepte mensajes de cualquier remitente (si no hay filtro de grupo).
function normalizeNumber(jid) {
    if (!jid) return jid;
    return String(jid).replace(/@.*$/, '').trim();
}

// Lote por defecto para guardar cualquier mensaje entrante de WhatsApp (incluye mensajes sin formato)
const WHATSAPP_INBOX_LOT_ID = process.env.WHATSAPP_INBOX_LOT_ID || 'lotes';
const WHATSAPP_INBOX_LOT_NAME = process.env.WHATSAPP_INBOX_LOT_NAME || 'LOTES';

function makeWhatsAppUid(messageId) {
    try {
        if (messageId) return `wa_${String(messageId)}`;
    } catch (e) { /* ignore */ }
    return `wa_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function ensureLotExists(id, name, process = 'all', metadata = {}) {
    try {
        const existing = await db.getLot(id);
        if (!existing) {
            await db.saveLot(id, name, process, metadata);
            console.log(`🧩 Lote creado automáticamente: ${name} (${id})`);
        }
    } catch (e) {
        console.warn('⚠️ No se pudo asegurar lote en BD:', id, e && e.message ? e.message : e);
    }
}

async function ensureSystemLots() {
    await ensureLotExists(WHATSAPP_INBOX_LOT_ID, WHATSAPP_INBOX_LOT_NAME, 'all', { system: true, source: 'whatsapp' });
}
let allowedUsers = []; // mantenemos la variable por compatibilidad (no usada)
// Carpeta para archivos del sistema de grabado
// Prioridad para decidir la carpeta `TO_ENGRAVE_DIR`:
// 1) Variable de entorno `TO_ENGRAVE_DIR` (permite configuración por PC/servidor)
// 2) Ruta de red por defecto (si existe)
// 3) Carpeta local del proyecto `to_engrave` como fallback universal
const DEFAULT_NETWORK_DIR = "\\\\ociserver\\INNOVAX\\AREA DE TRABAJO\\6.- ENSAMBLE\\Nueva carpeta";
const LOCAL_FALLBACK_DIR = path.join(__dirname, 'to_engrave');
const TO_ENGRAVE_DIR = (() => {
    // Usar variable de entorno si está definida
    if (process.env.TO_ENGRAVE_DIR && process.env.TO_ENGRAVE_DIR.trim() !== '') {
        // Resolver ruta relativa si se proporcionó
        return path.resolve(process.env.TO_ENGRAVE_DIR);
    }

    // Usar la ruta de red por defecto si existe
    try {
        if (fs.existsSync(DEFAULT_NETWORK_DIR)) return DEFAULT_NETWORK_DIR;
    } catch (e) {
        // ignore
    }

    // Fallback local (funciona en cualquier PC)
    return LOCAL_FALLBACK_DIR;
})();

// ✅ Modo persistencia
// Por defecto: NO crear archivos .json nuevos; guardar en BD (SQLite) como fuente de verdad.
// Si necesitas compatibilidad legacy con to_engrave, activa: WRITE_TO_ENGRAVE_FILES=true
const WRITE_TO_ENGRAVE_FILES = String(process.env.WRITE_TO_ENGRAVE_FILES || '').toLowerCase() === 'true';

// Hints por chat para unir mensajes consecutivos (ej. foto+"16pz" -> luego "001-058")
const chatHints = new Map();
const CHAT_HINT_TTL_MS = 1000 * 60 * 10; // 10 min

function extractQuantityHint(text) {
    const t = String(text || '');
    // Soportar formatos: "2pz", "2 pz", "(2pz)", "(2 pz)", "2PZS", etc.
    // También soportar formatos entre paréntesis al final del nombre: "ITEM 3 F (2pz)"
    const m = t.match(/\(?\s*(\d{1,5})\s*(?:pz|pzas|pza|pcs|pieza|piezas)\s*\)?/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
}

function setChatHint(chatId, hint) {
    if (!chatId) return;
    const now = Date.now();
    // limpiar expirados
    for (const [k, v] of chatHints.entries()) {
        if (!v || (now - (v.ts || 0)) > CHAT_HINT_TTL_MS) chatHints.delete(k);
    }
    // limitar tamaño
    if (chatHints.size > 300) {
        // eliminar el más viejo
        let oldestKey = null;
        let oldestTs = Infinity;
        for (const [k, v] of chatHints.entries()) {
            const ts = v && v.ts ? v.ts : 0;
            if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
        }
        if (oldestKey) chatHints.delete(oldestKey);
    }
    chatHints.set(chatId, { ...hint, ts: now });
}

function takeChatHint(chatId) {
    if (!chatId) return null;
    const h = chatHints.get(chatId);
    if (!h) return null;
    const now = Date.now();
    if ((now - (h.ts || 0)) > CHAT_HINT_TTL_MS) {
        chatHints.delete(chatId);
        return null;
    }
    chatHints.delete(chatId);
    return h;
}

// Función para obtener la ruta del Excel mensual
// NOTE: Excel-based routing removed. Keep function placeholder for compatibility if needed.
function obtenerRutaExcel() {
    const rutaBase = TO_ENGRAVE_DIR;
    const nombreArchivo = 'to_engrave';
    return { rutaBase, rutaCompleta: rutaBase, nombreArchivo };
}

// Función para crear directorios si no existen
function crearDirectorioSiNoExiste(ruta) {
    if (!fs.existsSync(ruta)) {
        fs.mkdirSync(ruta, { recursive: true });
        console.log(`📁 Directorio creado: ${ruta}`);
    }
}

/* Excel writing removed - using engraving JSON in to_engrave instead */

// Función de respaldo local - VERSIÓN MEJORADA
// Respaldo local: guarda un JSON local en root si todo falla
async function guardarRespaldoLocal(numParte, numPiezas, imagen) {
    try {
        const ahora = new Date();
        const mes = String(ahora.getMonth() + 1).padStart(2, '0');
        const año = ahora.getFullYear();
        const nombreMes = ahora.toLocaleString('es-ES', { month: 'long' }).toUpperCase();
        
    const nombreArchivo = `REGISTRO_${nombreMes}_GRABADO_LASER_RESpaldo.json`;
    const rutaLocal = nombreArchivo;
        
        let workbook;
        let datos = [];
        
        console.log(`📂 Intentando respaldo local: ${rutaLocal}`);
        
        if (fs.existsSync(rutaLocal)) {
            try {
                datos = JSON.parse(fs.readFileSync(rutaLocal, 'utf8')) || [];
                console.log(`📊 Respaldo existente: ${datos.length} registros`);
            } catch (error) {
                console.log('⚠️ Error leyendo respaldo JSON, creando nuevo...');
                datos = [];
            }
        } else {
            datos = [];
        }
        
        const fecha = new Date().toLocaleString('es-ES');
        const filaExistente = datos.findIndex(row => row['NUM PARTE'] === numParte);
        
        if (filaExistente !== -1) {
            datos[filaExistente]['NUM DE PIEZAS'] = numPiezas;
            datos[filaExistente]['FECHA'] = fecha;
            datos[filaExistente]['IMAGEN'] = imagen ? 'SI' : 'NO';
        } else {
            const nuevaFila = {
                'ORDEN NUM': datos.length + 1,
                'NUM PARTE': numParte,
                'NUM DE PIEZAS': numPiezas,
                'IMAGEN': imagen ? 'SI' : 'NO',
                'FECHA': fecha
            };
            datos.push(nuevaFila);
        }
        
        // Respaldo ya NO se guarda en archivo (todo va a BD)
        console.log(`✅ Datos listos en memoria`);
        console.log(`📊 Registros procesados: ${datos.length}`);
        
    return rutaLocal;
        
    } catch (error) {
        console.error('❌ Error crítico en respaldo local:', error);
        // Último intento - guardar en archivo simple
        await guardarUltimoRespaldo(numParte, numPiezas, imagen);
    }
}

// Guardar en el sistema de grabado (JSON files en carpeta to_engrave)
async function guardarEnSistemaGrabado(numParte, numPiezas, imagen, messageId) {
    try {
        const fecha = new Date();
        const fechaTexto = fecha.toLocaleString('es-ES');
        const iso = fecha.toISOString().replace(/:/g, '-');
        const safeParte = String(numParte || '').replace(/[^a-zA-Z0-9\-]/g, '_') || 'SIN_PARTE';

        // Prevención: duplicados cercanos por contenido
        try {
            const signature = makeSignature(numParte, numPiezas, imagen);
            const existing = getRecentSavedRutaForSignature(signature);
            if (existing) {
                console.log(`⚠️ Evitado duplicado cercano por firma, reusando: ${existing}`);
                return { uid: existing, sourceFile: null };
            }
        } catch (e) { /* noop */ }

        const qtyIsNumber = (numPiezas !== undefined && numPiezas !== null && !isNaN(Number(numPiezas)));
        const quantityValue = qtyIsNumber ? Number(numPiezas) : 0;
        const uid = makeWhatsAppUid(messageId || `${iso}_${safeParte}`);

        // Guardar SIEMPRE en BD
        await db.savePiece({
            uid,
            lot_id: WHATSAPP_INBOX_LOT_ID,
            partNumber: numParte || '',
            quantity: quantityValue,
            incidents: 0,
            incidentType: '',
            timestamp: new Date().toISOString(),
            imagen: imagen || null,
            sourceFile: null,
            clientId: null,
            messageId: messageId || null,
            proceso: 'laser',
            metadata: {
                source: 'whatsapp',
                parsed: true,
                fechaTexto,
                quantityMissing: !qtyIsNumber
            }
        });

        // Solo si se requiere compatibilidad legacy
        let ruta = null;
        if (WRITE_TO_ENGRAVE_FILES) {
            try {
                crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
                const filename = `engrave_${iso}_${safeParte}.json`;
                ruta = path.join(TO_ENGRAVE_DIR, filename);
                const objeto = {
                    numParte: numParte,
                    numPiezas: qtyIsNumber ? String(quantityValue) : null,
                    fecha: fechaTexto,
                    imagen: imagen || null,
                    messageId: messageId || null
                };
                fs.writeFileSync(ruta, JSON.stringify(objeto, null, 2), 'utf8');
                console.log(`📝 JSON guardado (legacy) en: ${ruta}`);
            } catch (e) {
                console.warn('⚠️ No se pudo guardar JSON legacy (continuando con BD):', e && e.message ? e.message : e);
                ruta = null;
            }
        }

        // Recordar firma (con uid como referencia)
        try {
            const signature = makeSignature(numParte, numPiezas, imagen);
            rememberSavedSignature(signature, uid);
        } catch (e) { /* noop */ }

        return { uid, sourceFile: ruta ? path.basename(ruta) : null };
    } catch (err) {
        console.error('❌ Error guardando en sistema de grabado:', err);
        throw err;
    }
}

// Guardar mensajes que no cumplen nomenclatura (texto libre) en BD
async function guardarMensajeGenericoEnBD({ mensaje, remitenteRaw, messageObj, imagenBase64, messageId }) {
    const uid = makeWhatsAppUid(messageId || Date.now());
    const fromNormalized = normalizeNumber(remitenteRaw);
    const chatId = (messageObj && messageObj.from) ? String(messageObj.from) : null;
    const isFromGroup = chatId ? chatId.includes('@g.us') : null;

    await db.savePiece({
        uid,
        lot_id: WHATSAPP_INBOX_LOT_ID,
        partNumber: '',
        quantity: 0,
        incidents: 0,
        incidentType: '',
        timestamp: new Date().toISOString(),
        imagen: imagenBase64 || null,
        sourceFile: null,
        clientId: null,
        messageId: messageId || null,
        proceso: '',
        metadata: {
            source: 'whatsapp',
            parsed: false,
            rawMessage: mensaje,
            from: fromNormalized,
            fromRaw: remitenteRaw || null,
            chatId,
            isFromGroup,
            hasMedia: !!(messageObj && messageObj.hasMedia),
            type: (messageObj && messageObj.type) ? String(messageObj.type) : null
        }
    });

    return uid;
}

// Endpoint para listar archivos en la cola de grabado
// ✅ OPTIMIZACIÓN PARA MILES DE REGISTROS: Paginación + Búsqueda
app.get('/engrave-list', (req, res) => {
    (async () => {
        try {
            const page = parseInt(req.query.page) || 0;
            const pageSize = parseInt(req.query.pageSize) || 500;
            const search = (req.query.search || '').toString();

            const result = await db.getPiecesInLotPaged(WHATSAPP_INBOX_LOT_ID, { page, pageSize, search });

            const data = (result.rows || [])
                .filter(r => r && r.partNumber && String(r.partNumber).trim() !== '')
                .map(row => {
                let imagen = row.imagen;
                try {
                    if (Buffer.isBuffer(imagen)) {
                        // Fallback: si vino como blob, exponer base64 genérico
                        imagen = `data:application/octet-stream;base64,${imagen.toString('base64')}`;
                    }
                } catch (e) { /* noop */ }

                const meta = row.metadata || {};
                const qtyMissing = !!meta.quantityMissing;

                return {
                    filename: row.uid,
                    content: {
                        uid: row.uid,
                        numParte: row.partNumber || null,
                        numPiezas: qtyMissing ? null : (row.quantity ?? null),
                        fecha: row.timestamp || null,
                        imagen: imagen || null,
                        messageId: row.messageId || null,
                        rawMessage: meta.rawMessage || null
                    }
                };
            });

            res.json({
                data,
                pagination: {
                    page: result.page,
                    pageSize: result.pageSize,
                    totalRegistros: result.total,
                    totalPages: result.totalPages,
                    hasMore: result.hasMore
                }
            });
        } catch (error) {
            console.error('❌ Error leyendo engrave-list desde BD:', error);
            res.status(500).json({ error: 'No se pudo leer la cola (BD)', details: error.message });
        }
    })();
});

// Endpoint para servir un archivo de la cola (raw) o imagen
app.get('/engrave/:file', (req, res) => {
    try {
        const file = req.params.file;
        // Permitir acceso a archivos en la carpeta base y subdirectorio 'images'
        let ruta = path.join(TO_ENGRAVE_DIR, file);
        
        // Protección contra directory traversal: solo permitir archivos en TO_ENGRAVE_DIR o subdirectorios
        const realPath = path.resolve(ruta);
        const baseDir = path.resolve(TO_ENGRAVE_DIR);
        if (!realPath.startsWith(baseDir)) {
            return res.status(403).send('Forbidden');
        }
        
        if (!fs.existsSync(ruta)) {
            // Si no existe como archivo directo, intentar en subdirectorio images
            ruta = path.join(TO_ENGRAVE_DIR, 'images', file);
            if (!fs.existsSync(ruta)) {
                return res.status(404).send('Not found');
            }
        }
        
        res.sendFile(ruta);
    } catch (error) {
        res.status(500).send('Error');
    }
});

// Respaldo de emergencia - guarda en BD
async function guardarUltimoRespaldo(numParte, numPiezas, imagen) {
    try {
        const fecha = new Date().toLocaleString('es-ES');
        const uid = 'emergency_' + Date.now();
        
        // Guardar en BD directamente
        await db.savePiece({
            uid: uid,
            lot_id: WHATSAPP_INBOX_LOT_ID,
            partNumber: numParte,
            quantity: (numPiezas !== undefined && numPiezas !== null && !isNaN(Number(numPiezas))) ? Number(numPiezas) : 0,
            incidents: 0,
            timestamp: fecha,
            imagen: imagen || null,
            metadata: { source: 'emergency_backup' }
        });
        
        console.log(`📝 Registro de emergencia guardado en BD`);
    } catch (error) {
        console.error('💥 Error crítico - No se pudo guardar en BD:', error);
    }
}

// Servir la página principal
registerAuthAdminRoutes(app, {
    fs,
    path,
    rootDir: __dirname,
    AUTH_ENABLED,
    AUTH_REQUIRE_PASSWORD,
    AUTH_ADMIN_USER,
    PERMISSIONS,
    db,
    allSql,
    ensureAuthUsersTable,
    getUserRecordByUsername,
    normalizePermissionsArray,
    validateLogin,
    issueAuthToken,
    setAuthCookie,
    getAuthUserFromRequest,
    clearAuthCookie,
    requirePermission,
    runSql,
    pbkdf2HashPassword,
    loginBodySchema,
    authTokens
});

registerWhatsAppStatusRoutes(app, {
    path,
    rootDir: __dirname,
    db,
    WHATSAPP_INBOX_LOT_ID,
    SERVER_STARTED_AT,
    AUTH_ENABLED,
    AUTH_REQUIRE_PASSWORD,
    USE_GROUP_FILTER,
    ALLOWED_GROUPS,
    ALLOWED_GROUPS_ALL,
    ALLOWED_GROUPS_SOURCE,
    isAuthenticated,
    waInitInProgress,
    waInitAttempt,
    waLastError,
    waLastRestartAt,
    waLastRestartReason,
    WHATSAPP_SESSION_DIR,
    registros,
    qrCode,
    restartWhatsAppSchema,
    restartWhatsAppClient,
    requirePermission,
    readAllowedGroupsDb,
    readAllowedGroupsFile,
    writeAllowedGroupsDb,
    writeAllowedGroupsFile,
    setAllowedGroups,
    dedupeAllowedGroupEntries,
    normalizeAllowedGroupEntries,
    addWhatsAppLog,
    getWhatsAppLogs: () => whatsappLogBuffer,
    setWhatsAppLogs: (value) => { whatsappLogBuffer = value; }
});

// auth-admin routes block
app.get('/', (req, res) => {
    // Si auth está habilitado y no hay sesión, redirigir a login
    try {
        if (AUTH_ENABLED) {
            const user = getAuthUserFromRequest(req);
            if (!user) return res.redirect('/login');
        }
    } catch (e) { /* noop */ }

    // Servir directamente el archivo principal del Sistema de Grabado Láser
    // Apuntar al archivo HTML correcto del sistema de grabado
    const mainPage = path.join(__dirname, 'public', 'sistema_de_grabado_laserv1.html');
    if (fs.existsSync(mainPage)) {
        res.sendFile(mainPage);
    } else {
        // Fallback a index si el archivo no existe
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Login UI
app.get('/login', (req, res) => {
    const loginPage = path.join(__dirname, 'public', 'login.html');
    if (fs.existsSync(loginPage)) return res.sendFile(loginPage);
    return res.status(404).send('login.html not found');
});

if (false) {
// Legacy routes kept disabled after modular extraction.
// Auth API
app.post('/api/auth/login', (req, res) => {
    try {
        if (!AUTH_ENABLED) {
            return res.status(400).json({ error: 'Auth disabled' });
        }
        const parsed = loginBodySchema.safeParse(req.body || {});
        if (!parsed.success) {
            return res.status(400).json({ error: 'Credenciales invalidas' });
        }
        const username = parsed.data.username;
        const password = parsed.data.password;
        Promise.resolve(validateLogin(username, password)).then((result) => {
            if (!result || !result.ok) {
                if (result && result.disabled) return res.status(403).json({ error: 'Usuario deshabilitado' });
                return res.status(401).json({ error: AUTH_REQUIRE_PASSWORD ? 'Credenciales inválidas' : 'Usuario inválido' });
            }

            const token = issueAuthToken({
                username: result.username,
                role: result.role,
                permissions: result.permissions
            });
            setAuthCookie(res, token);
            return res.json({ ok: true, username: result.username, role: result.role, permissions: result.permissions });
        }).catch((e) => {
            console.warn('login error', e);
            return res.status(500).json({ error: 'Login failed' });
        });
    } catch (e) {
        return res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/auth/me', (req, res) => {
    try {
        if (!AUTH_ENABLED) {
            return res.json({ authenticated: true, username: null, role: null, permissions: ['*'], authDisabled: true });
        }
        const user = getAuthUserFromRequest(req);
        if (!user) return res.status(401).json({ authenticated: false });
        return res.json({ authenticated: true, username: user.username, role: user.role || 'viewer', permissions: normalizePermissionsArray(user.permissions) });
    } catch (e) {
        return res.status(500).json({ error: 'me failed' });
    }
});

// =============================
// Admin: usuarios y permisos
// =============================

app.get('/api/admin/permissions', requirePermission('admin.users'), (req, res) => {
    return res.json({ ok: true, permissions: PERMISSIONS });
});

app.get('/api/admin/users', requirePermission('admin.users'), async (req, res) => {
    try {
        const database = db.getDb();
        await ensureAuthUsersTable(database);
        const rows = await allSql(database, 'SELECT username, role, permissions_json, active, created_at, updated_at FROM auth_users ORDER BY username ASC', []);
        const users = (rows || []).map(r => {
            let perms = [];
            try { perms = JSON.parse(r.permissions_json || '[]'); } catch (e) { perms = []; }
            return {
                username: r.username,
                role: r.role || 'viewer',
                permissions: normalizePermissionsArray(perms),
                active: !!(r.active === 1 || r.active === '1' || r.active === true),
                created_at: r.created_at,
                updated_at: r.updated_at
            };
        });
        return res.json({ ok: true, users });
    } catch (e) {
        console.error('GET /api/admin/users error:', e);
        return res.status(500).json({ error: 'Failed to list users' });
    }
});

app.post('/api/admin/users', requirePermission('admin.users'), async (req, res) => {
    try {
        const body = req.body || {};
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const role = String(body.role || 'viewer').trim() || 'viewer';
        const permissions = normalizePermissionsArray(body.permissions);
        const active = body.active === false ? 0 : 1;

        if (!username) return res.status(400).json({ error: 'username required' });
        if (username.length > 40) return res.status(400).json({ error: 'username too long' });
        if (AUTH_REQUIRE_PASSWORD && (!password || password.length < 4)) {
            return res.status(400).json({ error: 'password too short' });
        }

        const database = db.getDb();
        await ensureAuthUsersTable(database);
        const existing = await getUserRecordByUsername(database, username);
        if (existing) return res.status(409).json({ error: 'user already exists' });

        const seedPassword = AUTH_REQUIRE_PASSWORD ? password : (password || username || 'user');
        const hash = pbkdf2HashPassword(seedPassword);
        await runSql(
            database,
            'INSERT INTO auth_users (username, password_hash, role, permissions_json, active, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            [username, hash, role, JSON.stringify(permissions), active]
        );
        return res.json({ ok: true });
    } catch (e) {
        console.error('POST /api/admin/users error:', e);
        return res.status(500).json({ error: 'Failed to create user' });
    }
});

app.put('/api/admin/users/:username', requirePermission('admin.users'), async (req, res) => {
    try {
        const username = String(req.params.username || '').trim();
        const body = req.body || {};
        const role = String(body.role || '').trim();
        const permissions = normalizePermissionsArray(body.permissions);
        const active = (body.active === false || body.active === 0 || body.active === '0') ? 0 : 1;

        if (!username) return res.status(400).json({ error: 'username required' });
        const database = db.getDb();
        await ensureAuthUsersTable(database);
        const existing = await getUserRecordByUsername(database, username);
        if (!existing) return res.status(404).json({ error: 'user not found' });

        await runSql(
            database,
            'UPDATE auth_users SET role = COALESCE(NULLIF(?, \'\'), role), permissions_json = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?',
            [role, JSON.stringify(permissions), active, username]
        );
        return res.json({ ok: true });
    } catch (e) {
        console.error('PUT /api/admin/users/:username error:', e);
        return res.status(500).json({ error: 'Failed to update user' });
    }
});

app.post('/api/admin/users/:username/reset-password', requirePermission('admin.users'), async (req, res) => {
    try {
        const username = String(req.params.username || '').trim();
        const body = req.body || {};
        const password = String(body.password || '');
        if (!username) return res.status(400).json({ error: 'username required' });
        if (AUTH_REQUIRE_PASSWORD && (!password || password.length < 4)) {
            return res.status(400).json({ error: 'password too short' });
        }

        const database = db.getDb();
        await ensureAuthUsersTable(database);
        const existing = await getUserRecordByUsername(database, username);
        if (!existing) return res.status(404).json({ error: 'user not found' });

        const seedPassword = AUTH_REQUIRE_PASSWORD ? password : (password || username || 'user');
        const hash = pbkdf2HashPassword(seedPassword);
        await runSql(
            database,
            'UPDATE auth_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?',
            [hash, username]
        );
        return res.json({ ok: true });
    } catch (e) {
        console.error('reset-password error:', e);
        return res.status(500).json({ error: 'Failed to reset password' });
    }
});

app.delete('/api/admin/users/:username', requirePermission('admin.users'), async (req, res) => {
    try {
        const username = String(req.params.username || '').trim();
        if (!username) return res.status(400).json({ error: 'username required' });
        if (username === AUTH_ADMIN_USER) return res.status(400).json({ error: 'cannot delete admin' });

        const database = db.getDb();
        await ensureAuthUsersTable(database);
        await runSql(database, 'DELETE FROM auth_users WHERE username = ?', [username]);
        return res.json({ ok: true });
    } catch (e) {
        console.error('DELETE /api/admin/users/:username error:', e);
        return res.status(500).json({ error: 'Failed to delete user' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    try {
        if (!AUTH_ENABLED) return res.json({ ok: true, authDisabled: true });
        const user = getAuthUserFromRequest(req);
        if (user && user.token) {
            authTokens.delete(user.token);
        }
        clearAuthCookie(res);
        return res.json({ ok: true });
    } catch (e) {
        clearAuthCookie(res);
        return res.status(500).json({ error: 'logout failed' });
    }
});

// Obtener QR code
app.get('/qr', async (req, res) => {
    res.json({
        qr: qrCode || null,
        authenticated: !!isAuthenticated,
        initInProgress: !!waInitInProgress,
        initAttempt: waInitAttempt,
        lastError: waLastError,
        lastRestartAt: waLastRestartAt,
        sessionDir: WHATSAPP_SESSION_DIR
    });
});

// Endpoint /generate-qr eliminado (funcionalidad de autorizaciones removida).

// Endpoint /qr-reg/:token eliminado (funcionalidad de autorizaciones removida).

// Obtener estado de conexión
app.get('/status', async (req, res) => {
    let engraveCount = 0;
    let lotesTotal = 0;
    let lotesNonZero = 0;
    let dbFile = null;
    try {
        const database = db.getDb();
        try {
            dbFile = (typeof db.getDbPath === 'function') ? db.getDbPath() : path.join(__dirname, 'laser_engraving.db');
        } catch (e) {
            dbFile = null;
        }
        engraveCount = await new Promise((resolve) => {
            database.get(
                'SELECT COUNT(*) AS total FROM pieces WHERE lot_id = ?',
                [WHATSAPP_INBOX_LOT_ID],
                (err, row) => {
                    if (err) return resolve(0);
                    resolve(parseInt(row?.total || '0'));
                }
            );
        });

        // Stats rápidos del lote "lotes" (UI principal)
        lotesTotal = await new Promise((resolve) => {
            database.get(
                "SELECT COUNT(*) AS total FROM pieces WHERE lot_id = 'lotes'",
                (err, row) => {
                    if (err) return resolve(0);
                    resolve(parseInt(row?.total || '0'));
                }
            );
        });
        lotesNonZero = await new Promise((resolve) => {
            database.get(
                "SELECT COUNT(*) AS total FROM pieces WHERE lot_id = 'lotes' AND quantity IS NOT NULL AND CAST(quantity AS INTEGER) > 0",
                (err, row) => {
                    if (err) return resolve(0);
                    resolve(parseInt(row?.total || '0'));
                }
            );
        });
    } catch (e) { /* ignore */ }

    res.json({
        startedAt: SERVER_STARTED_AT,
        auth: {
            enabled: AUTH_ENABLED,
            requirePassword: AUTH_REQUIRE_PASSWORD
        },
        authenticated: isAuthenticated,
        groupFilter: {
            enabled: USE_GROUP_FILTER,
            allowedCount: (() => { try { return Object.keys(ALLOWED_GROUPS || {}).length; } catch (e) { return 0; } })(),
            totalCount: (() => { try { return (ALLOWED_GROUPS_ALL || []).length; } catch (e) { return 0; } })()
        },
        whatsapp: {
            initInProgress: waInitInProgress,
            initAttempt: waInitAttempt,
            lastError: waLastError,
            lastRestartAt: waLastRestartAt,
            lastRestartReason: waLastRestartReason,
            sessionDir: WHATSAPP_SESSION_DIR
        },
        registros: registros,
        engraveCount: engraveCount,
        lotes: {
            total: lotesTotal,
            nonZeroQty: lotesNonZero
        },
        db: {
            file: dbFile
        }
    });
});

app.post('/api/whatsapp/restart', requirePermission('whatsapp.restart'), async (req, res) => {
    try {
        const parsed = restartWhatsAppSchema.safeParse(req.body || {});
        if (!parsed.success) {
            return res.status(400).json({ ok: false, error: 'Payload invalido' });
        }
        const killLockedBrowser = parsed.data.killLockedBrowser;
        const result = await restartWhatsAppClient({
            reason: 'manual desde UI',
            killLockedBrowser
        });
        return res.json(result);
    } catch (e) {
        console.error('POST /api/whatsapp/restart error:', e);
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// Obtener y administrar grupos autorizados (WhatsApp)
app.get('/api/whatsapp/groups', requirePermission('whatsapp.groups'), (req, res) => {
    try {
        let entries = ALLOWED_GROUPS_ALL || [];
        let source = ALLOWED_GROUPS_SOURCE || 'file';
        let editable = true;

        if (process.env.ALLOWED_GROUPS_JSON) {
            source = 'env';
            editable = false;
            try {
                entries = dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(JSON.parse(process.env.ALLOWED_GROUPS_JSON)));
            } catch (e) {
                entries = dedupeAllowedGroupEntries(normalizeAllowedGroupEntries(ALLOWED_GROUPS_ALL));
            }
        }

        const totalCount = entries.length;
        const activeCount = entries.filter(e => e && e.active !== false).length;

        return res.json({
            ok: true,
            groups: entries,
            totalCount,
            activeCount,
            filterActive: activeCount > 0,
            source,
            editable
        });
    } catch (e) {
        console.error('GET /api/whatsapp/groups error:', e);
        return res.status(500).json({ error: 'Failed to load groups' });
    }
});

app.post('/api/whatsapp/groups', requirePermission('whatsapp.groups'), async (req, res) => {
    try {
        if (process.env.ALLOWED_GROUPS_JSON) {
            return res.status(409).json({ error: 'ALLOWED_GROUPS_JSON activo. Edicion bloqueada.' });
        }

        const body = req.body || {};
        const id = String(body.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id required' });

        const name = String(body.name || '').trim();
        const active = body.active !== false;

        const database = db.getDb();
        let entries = await readAllowedGroupsDb(database);
        if (!entries.length) entries = readAllowedGroupsFile();

        const existing = entries.find(e => e.id === id);
        if (existing) {
            existing.name = name || existing.name || id;
            existing.active = active;
        } else {
            entries.push({ id, name: name || id, active });
        }

        const normalized = dedupeAllowedGroupEntries(entries);
        await writeAllowedGroupsDb(database, normalized);
        writeAllowedGroupsFile(normalized);
        setAllowedGroups(normalized, 'db');

        addWhatsAppLog('group', `Grupo agregado/actualizado: ${id}`, { id, name: name || id, active }, 'info');

        const totalCount = normalized.length;
        const activeCount = normalized.filter(e => e.active !== false).length;
        return res.json({ ok: true, groups: normalized, totalCount, activeCount, filterActive: activeCount > 0 });
    } catch (e) {
        console.error('POST /api/whatsapp/groups error:', e);
        return res.status(500).json({ error: 'Failed to save group' });
    }
});

app.put('/api/whatsapp/groups/:id', requirePermission('whatsapp.groups'), async (req, res) => {
    try {
        if (process.env.ALLOWED_GROUPS_JSON) {
            return res.status(409).json({ error: 'ALLOWED_GROUPS_JSON activo. Edicion bloqueada.' });
        }

        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id required' });

        const body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim() : null;
        const active = body.active !== undefined ? body.active !== false : undefined;

        const database = db.getDb();
        let entries = await readAllowedGroupsDb(database);
        if (!entries.length) entries = readAllowedGroupsFile();

        const existing = entries.find(e => e.id === id);
        if (!existing) return res.status(404).json({ error: 'group not found' });

        if (name !== null) existing.name = name || existing.name || id;
        if (active !== undefined) existing.active = active;

        const normalized = dedupeAllowedGroupEntries(entries);
        await writeAllowedGroupsDb(database, normalized);
        writeAllowedGroupsFile(normalized);
        setAllowedGroups(normalized, 'db');

        addWhatsAppLog('group', `Grupo actualizado: ${id}`, { id, name: existing.name, active: existing.active }, 'info');

        const totalCount = normalized.length;
        const activeCount = normalized.filter(e => e.active !== false).length;
        return res.json({ ok: true, groups: normalized, totalCount, activeCount, filterActive: activeCount > 0 });
    } catch (e) {
        console.error('PUT /api/whatsapp/groups error:', e);
        return res.status(500).json({ error: 'Failed to update group' });
    }
});

app.delete('/api/whatsapp/groups/:id', requirePermission('whatsapp.groups'), async (req, res) => {
    try {
        if (process.env.ALLOWED_GROUPS_JSON) {
            return res.status(409).json({ error: 'ALLOWED_GROUPS_JSON activo. Edicion bloqueada.' });
        }

        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ error: 'id required' });

        const database = db.getDb();
        let entries = await readAllowedGroupsDb(database);
        if (!entries.length) entries = readAllowedGroupsFile();

        const filtered = entries.filter(e => e.id !== id);
        const normalized = dedupeAllowedGroupEntries(filtered);
        await writeAllowedGroupsDb(database, normalized);
        writeAllowedGroupsFile(normalized);
        setAllowedGroups(normalized, 'db');

        addWhatsAppLog('group', `Grupo eliminado: ${id}`, { id }, 'warn');

        const totalCount = normalized.length;
        const activeCount = normalized.filter(e => e.active !== false).length;
        return res.json({ ok: true, groups: normalized, totalCount, activeCount, filterActive: activeCount > 0 });
    } catch (e) {
        console.error('DELETE /api/whatsapp/groups error:', e);
        return res.status(500).json({ error: 'Failed to delete group' });
    }
});

// Logs de WhatsApp
app.get('/api/whatsapp/logs', requirePermission('whatsapp.logs'), (req, res) => {
    try {
        const limit = Math.max(10, Math.min(1000, parseInt(req.query.limit || '200', 10) || 200));
        const logs = whatsappLogBuffer.slice(-limit);
        return res.json({ ok: true, logs, total: whatsappLogBuffer.length });
    } catch (e) {
        console.error('GET /api/whatsapp/logs error:', e);
        return res.status(500).json({ error: 'Failed to load logs' });
    }
});

app.post('/api/whatsapp/logs/clear', requirePermission('whatsapp.logs'), (req, res) => {
    try {
        whatsappLogBuffer = [];
        return res.json({ ok: true });
    } catch (e) {
        console.error('POST /api/whatsapp/logs/clear error:', e);
        return res.status(500).json({ error: 'Failed to clear logs' });
    }
});
}

// Reset/limpieza total de datos (SQLite) + opcional borrar JSONs de TO_ENGRAVE_DIR
app.post('/api/reset', requirePermission('system.reset'), async (req, res) => {
    try {
        const body = req.body || {};
        const password = body.password;
        const deleteFiles = Boolean(body.deleteFiles);

        if (!ensureResetPassword(password)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Auto-guardar snapshot ANTES de borrar datos
        try {
            const now = new Date();
            const snapMonth = now.getMonth() + 1;
            const snapYear = now.getFullYear();
            const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
            const snapLabel = `${MONTHS_ES[snapMonth - 1]} ${snapYear}`;
            const snapData = await generateCurrentSnapshot();
            await db.saveMonthlySnapshot(snapMonth, snapYear, 'all', snapLabel, snapData);
            console.log(`📸 Snapshot mensual guardado: ${snapLabel} (all)`);
        } catch (snapErr) {
            console.warn('⚠️ No se pudo guardar snapshot antes de reset:', snapErr);
        }

        const database = db.getDb();
        const result = {
            deleted: {
                pieces: 0,
                lot_metrics: 0,
                sync_log: 0,
                lotes: 0
            },
            ensuredPool: false,
            filesDeleted: 0
        };

        await runSql(database, 'BEGIN IMMEDIATE TRANSACTION');
        try {
            // Borrar dependientes primero
            result.deleted.pieces = (await runSql(database, 'DELETE FROM pieces')).changes || 0;
            result.deleted.lot_metrics = (await runSql(database, 'DELETE FROM lot_metrics')).changes || 0;
            result.deleted.sync_log = (await runSql(database, 'DELETE FROM sync_log')).changes || 0;
            // Mantener el pool "lotes" (inbox) como contenedor general
            result.deleted.lotes = (await runSql(database, 'DELETE FROM lotes WHERE id <> ?', ['lotes'])).changes || 0;
            if (db.isMssql) {
                await db.saveLot('lotes', 'LOTES', 'all', { system: true });
            } else {
                await runSql(
                    database,
                    'INSERT OR IGNORE INTO lotes (id, name, process, metadata) VALUES (?, ?, ?, ?) ',
                    ['lotes', 'LOTES', 'all', JSON.stringify({ system: true })]
                );
            }
            // Normalizar el pool
            await runSql(database, 'UPDATE lotes SET name = ?, process = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['LOTES', 'all', 'lotes']);
            result.ensuredPool = true;
            await runSql(database, 'COMMIT');
        } catch (e) {
            try { await runSql(database, 'ROLLBACK'); } catch (e2) { /* ignore */ }
            throw e;
        }

        // Reset memoria
        try { registros = []; } catch (e) { /* ignore */ }

        if (deleteFiles) {
            // Seguridad: solo borrar archivos .json (engrave_*.json) dentro de TO_ENGRAVE_DIR
            try {
                const dir = TO_ENGRAVE_DIR;
                const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
                let deletedCount = 0;
                for (const f of files) {
                    if (!f || typeof f !== 'string') continue;
                    if (!f.toLowerCase().endsWith('.json')) continue;
                    const full = path.join(dir, f);
                    try {
                        fs.unlinkSync(full);
                        deletedCount++;
                    } catch (e) {
                        // En red/locks puede fallar: ignorar por archivo
                    }
                }
                result.filesDeleted = deletedCount;
            } catch (e) {
                // No fallar el reset por archivos
            }
        }

        return res.json({ ok: true, ...result });
    } catch (e) {
        console.error('api/reset error:', e);
        return res.status(500).json({ error: 'Reset failed', detail: e && e.message ? e.message : String(e) });
    }
});

// Limpieza mensual: Pavonado (NO borra lotes; solo contenido/métricas) + lote global 'lotes'
app.post('/api/reset-monthly-pavonado', requirePermission('system.reset'), async (req, res) => {
    try {
        const body = req.body || {};
        const password = body.password;
        if (!ensureResetPassword(password)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Auto-guardar snapshot ANTES de borrar datos
        try {
            const now = new Date();
            const snapMonth = now.getMonth() + 1;
            const snapYear = now.getFullYear();
            const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
            const snapLabel = `${MONTHS_ES[snapMonth - 1]} ${snapYear}`;
            const snapData = await generateCurrentSnapshot();
            await db.saveMonthlySnapshot(snapMonth, snapYear, 'pavonado', snapLabel, snapData);
            console.log(`📸 Snapshot mensual guardado: ${snapLabel} (pavonado)`);
        } catch (snapErr) {
            console.warn('⚠️ No se pudo guardar snapshot antes de cierre:', snapErr);
        }

        const database = db.getDb();
        const cutoffIso = new Date().toISOString();

        // Determinar lotes Pavonado
        const pavRows = await allSql(
            database,
            "SELECT id, name, process FROM lotes WHERE process = 'pavonado' OR id LIKE 'pavonado-lot-%' OR LOWER(name) LIKE '%pavonado%'"
        );
        const pavIds = Array.from(new Set((pavRows || []).map(r => String(r.id)).filter(Boolean)));

        // Siempre incluir el lote global (pool)
        const targetLotIds = Array.from(new Set(['lotes', ...pavIds]));

        const result = {
            ok: true,
            lotsTargeted: targetLotIds,
            imagesImportCutoff: cutoffIso,
            deleted: {
                pieces: 0,
                lot_metrics_pavonado: 0
            }
        };

        await runSql(database, 'BEGIN IMMEDIATE TRANSACTION');
        try {
            if (targetLotIds.length > 0) {
                const placeholders = targetLotIds.map(() => '?').join(',');
                // Borrar piezas dentro de esos lotes
                result.deleted.pieces = (await runSql(database, `DELETE FROM pieces WHERE lot_id IN (${placeholders})`, targetLotIds)).changes || 0;
                // Borrar métricas Pavonado asociadas (no tocar laser)
                result.deleted.lot_metrics_pavonado = (await runSql(
                    database,
                    `DELETE FROM lot_metrics WHERE lot_id IN (${placeholders}) AND metric_type = 'pavonado'`,
                    targetLotIds
                )).changes || 0;

                // Actualizar timestamps de los lotes (opcional)
                await runSql(database, `UPDATE lotes SET updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, targetLotIds);
            }

            // Guardar cutoff para que el arranque/sync no reimporte imágenes antiguas
            await setSystemKv(database, 'images_import_cutoff_iso', cutoffIso);

            await runSql(database, 'COMMIT');
        } catch (e) {
            try { await runSql(database, 'ROLLBACK'); } catch (e2) { /* ignore */ }
            throw e;
        }

        res.json(result);
    } catch (err) {
        console.error('Error en POST /api/reset-monthly-pavonado:', err);
        res.status(500).json({ error: err.message });
    }
});

// Limpieza mensual: TODO (Láser + Pavonado) + lote global 'lotes'
// - NO borra lotes (mantiene estructura)
// - SÍ borra piezas dentro de lotes de proceso y el pool 'lotes'
// - SÍ borra métricas laser/pavonado asociadas a esos lotes
app.post('/api/reset-monthly-all', requirePermission('system.reset'), async (req, res) => {
    try {
        const body = req.body || {};
        const password = body.password;
        if (!ensureResetPassword(password)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Auto-guardar snapshot ANTES de borrar datos
        try {
            const now = new Date();
            const snapMonth = now.getMonth() + 1;
            const snapYear = now.getFullYear();
            const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
            const snapLabel = `${MONTHS_ES[snapMonth - 1]} ${snapYear}`;
            const snapData = await generateCurrentSnapshot();
            await db.saveMonthlySnapshot(snapMonth, snapYear, 'all', snapLabel, snapData);
            console.log(`📸 Snapshot mensual guardado: ${snapLabel} (all)`);
        } catch (snapErr) {
            console.warn('⚠️ No se pudo guardar snapshot antes de cierre:', snapErr);
        }

        const database = db.getDb();
        const cutoffIso = new Date().toISOString();

        // Determinar lotes de procesos (laser/pavonado) por process o prefijos
        const procRows = await allSql(
            database,
            "SELECT id, name, process FROM lotes WHERE process IN ('laser','pavonado') OR id LIKE 'laser-lot-%' OR id LIKE 'pavonado-lot-%' OR LOWER(name) LIKE '%laser%' OR LOWER(name) LIKE '%láser%' OR LOWER(name) LIKE '%pavonado%'"
        );
        const procIds = Array.from(new Set((procRows || []).map(r => String(r.id)).filter(Boolean)));

        // Solo lotes de procesos (Láser/Pavonado). El lote global LOTES se conserva.
        const targetLotIds = Array.from(new Set(procIds));

        const result = {
            ok: true,
            lotsTargeted: targetLotIds,
            imagesImportCutoff: cutoffIso,
            deleted: {
                pieces: 0,
                lot_metrics_laser: 0,
                lot_metrics_pavonado: 0
            }
        };

        await runSql(database, 'BEGIN IMMEDIATE TRANSACTION');
        try {
            if (targetLotIds.length > 0) {
                const placeholders = targetLotIds.map(() => '?').join(',');

                result.deleted.pieces = (await runSql(database, `DELETE FROM pieces WHERE lot_id IN (${placeholders})`, targetLotIds)).changes || 0;

                result.deleted.lot_metrics_laser = (await runSql(
                    database,
                    `DELETE FROM lot_metrics WHERE lot_id IN (${placeholders}) AND metric_type = 'laser'`,
                    targetLotIds
                )).changes || 0;

                result.deleted.lot_metrics_pavonado = (await runSql(
                    database,
                    `DELETE FROM lot_metrics WHERE lot_id IN (${placeholders}) AND metric_type = 'pavonado'`,
                    targetLotIds
                )).changes || 0;

                await runSql(database, `UPDATE lotes SET updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, targetLotIds);
            }

            // Guardar cutoff para que el arranque/sync no reimporte imágenes antiguas
            await setSystemKv(database, 'images_import_cutoff_iso', cutoffIso);

            await runSql(database, 'COMMIT');
        } catch (e) {
            try { await runSql(database, 'ROLLBACK'); } catch (e2) { /* ignore */ }
            throw e;
        }

        res.json(result);
    } catch (err) {
        console.error('Error en POST /api/reset-monthly-all:', err);
        res.status(500).json({ error: err.message });
    }
});

// Re-sincronizar carpeta de imágenes -> BD (protegido por contraseña)
app.post('/api/sync-images', requirePermission('system.sync_images'), async (req, res) => {
    try {
        const body = req.body || {};
        const password = body.password;
        if (!ensureResetPassword(password)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const result = await syncNetworkImagesToDb({ verbose: false });
        return res.json({ ok: true, ...result });
    } catch (e) {
        console.error('api/sync-images error:', e);
        return res.status(500).json({ error: 'Sync-images failed', detail: e && e.message ? e.message : String(e) });
    }
});

// Endpoint SSE: emitir eventos en tiempo real al frontend
app.get('/events', (req, res) => {
    // Cabeceras necesarias para SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    // Limitar cantidad de clientes SSE para evitar DoS accidental
    const MAX_SSE_CLIENTS = 200;
    if (sseClients.length >= MAX_SSE_CLIENTS) {
        console.warn('Demasiados clientes SSE conectados, rechazando nueva conexión');
        res.status(503).end('Too many SSE clients');
        return;
    }

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };

    sseClients.push(newClient);
    console.log(`🔔 SSE client connected: ${clientId} (total: ${sseClients.length})`);

    // Enviar un evento de bienvenida/estado inicial opcional
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'connected', time: new Date().toISOString() })}\n\n`);

    // Cuando el cliente cierre la conexión, eliminarlo
    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
        console.log(`🔕 SSE client disconnected: ${clientId} (total: ${sseClients.length})`);
    });
});

// Función para emitir un nuevo registro a todos los clientes SSE conectados
function broadcastSsePayload(obj) {
    try {
        const payload = JSON.stringify(obj || {});
        // Escribir a cada cliente; si falla la escritura eliminar al cliente
        sseClients = sseClients.filter(client => {
            try {
                if (!client || !client.res) return false;
                // Si la respuesta está cerrada ya, filtrar fuera
                if (client.res.writableEnded || client.res.closed) {
                    return false;
                }
                client.res.write(`data: ${payload}\n\n`);
                return true;
            } catch (e) {
                try { client.res.end(); } catch (ee) { /* noop */ }
                return false;
            }
        });
    } catch (err) {
        console.error('❌ Error broadcasting SSE payload:', err);
    }
}

function broadcastNewRegistro(registro) {
    try {
        console.log(`📡 broadcastNewRegistro: enviando a ${sseClients.length} clientes, parte:`, registro?.numeroParte || registro?.numParte);
        broadcastSsePayload({ type: 'nuevo-registro', registro });
    } catch (err) {
        console.error('❌ Error broadcasting registro:', err);
    }
}

// ✅ Broadcast genérico: cuando cualquier usuario cambia datos (editar/mover/borrar)
function broadcastDataChanged(change = {}) {
    try {
        const safe = {
            at: new Date().toISOString(),
            ...((change && typeof change === 'object') ? change : {})
        };
        console.log(`📣 data-changed: ${safe.entity || 'unknown'} ${safe.action || ''}`.trim());
        broadcastSsePayload({ type: 'data-changed', change: safe });
    } catch (e) {
        // no-op
    }
}

// Al iniciar el servidor, escanear la carpeta TO_ENGRAVE_DIR y cargar
// cualquier archivo JSON pendiente en memoria (registros[]) y emitirlos
// a los clientes SSE para que el front-end los vea como registros nuevos.
async function importPendingFilesAtStartup() {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        if (!files || files.length === 0) {
            console.log('📦 No hay archivos pendientes en to_engrave al iniciar');
            return;
        }

        console.log(`📥 Importando ${files.length} archivos pendientes desde: ${TO_ENGRAVE_DIR}`);

        const importedMessageIds = new Set();

        // Si ya hay registros en memoria, recopilar messageIds para evitar duplicados
        registros.forEach(r => { if (r && r.messageId) importedMessageIds.add(r.messageId); });

        // Importar de más reciente a más antiguo para mantener orden similar al resto
        files.sort().reverse();

        for (const file of files) {
            try {
                const fullPath = path.join(TO_ENGRAVE_DIR, file);
                const raw = fs.readFileSync(fullPath, 'utf8');
                let obj = null;
                try { obj = JSON.parse(raw); } catch (e) { obj = null; }
                // Si el archivo no es JSON válido, omitir
                if (!obj) {
                    console.warn(`⚠️ Archivo pendiente no JSON omitido: ${file}`);
                    continue;
                }

                const messageId = obj.messageId || null;
                if (messageId && importedMessageIds.has(messageId)) {
                    // Ya importado según messageId
                    console.log(`↩️ Omitiendo duplicado por messageId: ${messageId} (${file})`);
                    continue;
                }

                // Crear estructura de registro compatible con el resto del sistema
                let partNumber = obj.numParte || obj.partNumber || null;
                
                // Si no hay número de parte, extraerlo del nombre del archivo
                if (!partNumber) {
                    const match = file.match(/_([A-Za-z0-9\-]+)(?:\.(json|jpeg|jpg))?$/i);
                    if (match && match[1]) {
                        partNumber = match[1];
                        console.log(`✓ Extraído numParte del nombre: ${partNumber} (de ${file})`);
                    }
                }
                
                const nuevoRegistro = {
                    numeroParte: partNumber || '',
                    piezas: obj.numPiezas || obj.piezas || null,
                    imagen: obj.imagen || null,
                    timestamp: obj.fecha || new Date().toLocaleString('es-ES'),
                    rutaBackup: null,
                    rutaEngrave: file,
                    messageId: messageId
                };

                // Importar a BD (si aún no existe). Esto permite dejar de depender de archivos.
                try {
                    const qtyNum = (nuevoRegistro.piezas !== undefined && nuevoRegistro.piezas !== null && !isNaN(Number(nuevoRegistro.piezas)))
                        ? Number(nuevoRegistro.piezas)
                        : 0;
                    const uid = makeWhatsAppUid(messageId || `file_${file}`);
                    await db.savePiece({
                        uid,
                        lot_id: WHATSAPP_INBOX_LOT_ID,
                        partNumber: nuevoRegistro.numeroParte || '',
                        quantity: qtyNum,
                        incidents: 0,
                        incidentType: '',
                        timestamp: new Date().toISOString(),
                        imagen: nuevoRegistro.imagen || null,
                        sourceFile: file,
                        clientId: null,
                        messageId: messageId || null,
                        proceso: 'laser',
                        metadata: {
                            source: 'to_engrave_import',
                            parsed: true,
                            quantityMissing: !(nuevoRegistro.piezas !== undefined && nuevoRegistro.piezas !== null && !isNaN(Number(nuevoRegistro.piezas))),
                            originalTimestamp: nuevoRegistro.timestamp || null
                        }
                    });
                } catch (e) {
                    // UNIQUE constraint puede disparar si ya existe; lo ignoramos.
                    console.warn('ℹ️ Import BD omitido (posible duplicado):', file, e && e.message ? e.message : e);
                }

                // Añadir a la cabeza de registros (mostramos lo más nuevo primero)
                registros.unshift(nuevoRegistro);
                if (registros.length > 20) registros.pop();

                if (messageId) importedMessageIds.add(messageId);

                // Emitir al front-end
                try { broadcastNewRegistro(nuevoRegistro); } catch (e) { console.warn('⚠️ Error broadcast al importar:', e); }

                console.log(`✅ Importado pendiente: ${file} -> parte=${nuevoRegistro.numeroParte}`);
            } catch (errFile) {
                console.error('❌ Error importando archivo pendiente', file, errFile);
            }
        }
    } catch (err) {
        console.error('❌ Error escaneando TO_ENGRAVE_DIR al iniciar:', err);
    }
}

// Obtener información del archivo Excel actual
// Endpoint legacy: info-excel — ahora devuelve info sobre la cola de grabado
app.get('/info-excel', (req, res) => {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        res.json({
            archivo: 'to_engrave',
            ruta: TO_ENGRAVE_DIR,
            existe: true,
            registros: files.length
        });
    } catch (error) {
        res.json({ archivo: 'No disponible', ruta: 'Error', existe: false, registros: 0 });
    }
});

// Inventario: devuelve lista formateada (similar estructura a inventario.xlsx)
app.get('/inventario', (req, res) => {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        const data = files.map((f, idx) => {
            const raw = fs.readFileSync(path.join(TO_ENGRAVE_DIR, f), 'utf8');
            const obj = JSON.parse(raw);
            return {
                'ORDEN NUM': idx + 1,
                'NUM PARTE': obj.numParte || '',
                'NUM DE PIEZAS': obj.numPiezas || '',
                'IMAGEN': obj.imagen ? 'SI' : 'NO',
                'FECHA': obj.fecha || ''
            };
        });
        res.json(data);
    } catch (error) {
        console.error('Error leyendo inventario (engrave):', error);
        res.status(500).json([]);
    }
});

function attachWhatsAppEventHandlers(waClient, generation) {
    const isCurrentClient = () => waClient === client && generation === waClientGeneration;

waClient.on('qr', async (qr) => {
    if (!isCurrentClient()) return;
    console.log('🔸 QR generado - Escanear en: http://localhost:3000');
    addWhatsAppLog('qr', 'QR generado', { url: `http://localhost:${PORT}` }, 'info');
    qrCode = await qrcode.toDataURL(qr);
    waInitAttempt = 0;
    clearWaInitRetryTimer();
});

waClient.on('ready', () => {
    if (!isCurrentClient()) return;
    console.log('✅ WhatsApp conectado!');
    console.log('🤖 Bot listo - Envía mensajes como: "888-999 4pz"');
    
    // Mostrar información del sistema de grabado al iniciar
    console.log(`📁 Carpeta to_engrave: ${TO_ENGRAVE_DIR}`);
    
    isAuthenticated = true;
    qrCode = null;
    waLastError = null;
    waInitAttempt = 0;
    clearWaInitRetryTimer();
    // Intentar detectar número del bot
    try {
        // client.info may contain phone info depending on the lib version
        if (waClient.info && waClient.info.wid) {
            const wid = waClient.info.wid; // could be string or object
            if (typeof wid === 'string') {
                BOT_NUMBER = wid.split('@')[0];
            } else if (wid && wid._serialized) {
                BOT_NUMBER = String(wid._serialized).split('@')[0];
            }
        }
    } catch (e) { /* ignore */ }
    if (BOT_NUMBER) console.log(`🤖 Bot number detected: ${BOT_NUMBER}`);
    addWhatsAppLog('ready', 'WhatsApp conectado y listo', { botNumber: BOT_NUMBER || null }, 'info');
});

// Manejar fallos de autenticación y desconexiones para depuración
waClient.on('auth_failure', (msg) => {
    if (!isCurrentClient()) return;
    // msg puede contener información sobre el fallo (por ejemplo, invalid session)
    console.error('❌ auth_failure:', msg);
    addWhatsAppLog('auth_failure', 'Fallo de autenticacion', { message: String(msg || '') }, 'error');
    isAuthenticated = false;
    qrCode = null;
    waLastError = String(msg || 'auth_failure');
    // Intento de reiniciar el cliente para forzar un nuevo QR
    setTimeout(() => {
        restartWhatsAppClient({ reason: 'auth_failure', killLockedBrowser: false }).catch((e) => {
            console.warn('No se pudo reiniciar tras auth_failure:', e?.message || e);
        });
    }, 1200);
});

waClient.on('disconnected', (reason) => {
    if (!isCurrentClient()) return;
    if (Date.now() < waSuppressDisconnectUntil) return;
    console.warn('⚠️ WhatsApp client disconnected:', reason);
    addWhatsAppLog('disconnected', 'WhatsApp desconectado', { reason: String(reason || '') }, 'warn');
    isAuthenticated = false;
    qrCode = null;
    waLastError = String(reason || 'disconnected');
    // Intento de reiniciar el cliente tras un pequeño retraso
    setTimeout(() => {
        restartWhatsAppClient({ reason: `disconnected: ${reason || 'unknown'}`, killLockedBrowser: false }).catch((e) => {
            console.warn('No se pudo reiniciar tras disconnected:', e?.message || e);
        });
    }, 1200);
});


    waClient.on('message', async (message) => {
        if (!isCurrentClient()) return;
        await handleWhatsAppMessage(message);
    });
}

// Función para procesar mensajes - CORREGIDA
async function procesarMensaje(mensaje, remitente, messageObj) {
    try {
        const chatId = (messageObj && messageObj.from) ? String(messageObj.from) : (remitente || null);

        // Obtener messageId (para deduplicación)
        let messageId = null;
        try {
            if (messageObj && messageObj.id) {
                // whatsapp-web.js message id puede estar en _serialized o id
                messageId = messageObj.id._serialized || messageObj.id.id || null;
            }
        } catch (e) { messageId = null; }

        // Si ya procesamos este messageId recientemente, evitar duplicado
        if (messageId && isDuplicateMessageId(messageId)) {
            console.log('↩️ Mensaje duplicado detectado (omitiendo):', messageId);
            return;
        }

        // Obtener imagen si existe (con reintentos para errores intermitentes de WhatsApp Web)
        let imagenBase64 = null;
        if (messageObj && messageObj.hasMedia) {
            const MAX_RETRIES = 3;
            const RETRY_DELAY_MS = 1500;
            let lastErrMsg = '';
            let lastWasTransient = false;
            const msgIdForRetry = messageId || (messageObj && messageObj.id ? (messageObj.id._serialized || messageObj.id.id || null) : null);

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const media = await messageObj.downloadMedia();
                    if (media) {
                        imagenBase64 = `data:${media.mimetype};base64,${media.data}`;
                    }
                    break; // éxito, salir del loop
                } catch (mediaError) {
                    const errMsg = String(mediaError?.message || mediaError || '');
                    lastErrMsg = errMsg;
                    // Errores conocidos de WhatsApp Web que pueden ser transitorios
                    const isTransient = errMsg.includes('addAnnotations') ||
                                        errMsg.includes('Evaluation failed') ||
                                        errMsg.includes('Protocol error') ||
                                        errMsg.includes('Session closed');
                    lastWasTransient = isTransient;
                    if (isTransient && attempt < MAX_RETRIES) {
                        console.log(`⚠️ Error descargando imagen (intento ${attempt}/${MAX_RETRIES}), reintentando en ${RETRY_DELAY_MS}ms...`);
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    } else {
                        console.log(`⚠️ Error descargando imagen (intento ${attempt}/${MAX_RETRIES}):`, errMsg.slice(0, 200));
                        break; // error no transitorio o ya agotamos reintentos
                    }
                }
            }

            // Último intento con recarga suave si el error fue transitorio
            if (!imagenBase64 && lastWasTransient) {
                const reloaded = await maybeReloadWaWeb('downloadMedia addAnnotations');
                if (reloaded) {
                    try {
                        await new Promise(r => setTimeout(r, 1200));
                        const media = await messageObj.downloadMedia();
                        if (media) {
                            imagenBase64 = `data:${media.mimetype};base64,${media.data}`;
                        }
                    } catch (mediaError) {
                        const errMsg = String(mediaError?.message || mediaError || '');
                        console.log('⚠️ Error descargando imagen tras recarga:', errMsg.slice(0, 200));
                    }
                } else if (lastErrMsg) {
                    console.log('⚠️ Error descargando imagen persistente:', lastErrMsg.slice(0, 200));
                }
            }

            // Si sigue sin imagen, encolar reintento en background
            if (!imagenBase64 && msgIdForRetry) {
                enqueueMediaRetry({
                    messageId: msgIdForRetry,
                    chatId: chatId || (messageObj && messageObj.from ? String(messageObj.from) : null),
                    uid: makeWhatsAppUid(msgIdForRetry),
                    numParte: null,
                    numPiezas: null
                });
            }
        }

        // Parseo de número de parte:
        // - Soporta formatos con separadores (033-641, 131-012-ZP)
        // - Soporta formatos alfanuméricos sin separadores pero con dígitos (ITEM15A)
        // - Soporta formatos con espacios y cantidad al final: "ITEM 3 F 2pz" o "ITEM 3 F (2pz)"
        // - Evita falsos positivos típicos (pz, pzs, piezas, etc.)
        const msgText = String(mensaje || '');
        const qtyHintInline = extractQuantityHint(msgText);
        const numParte = (function () {
            try {
                // 0) NUEVO: Detectar formato "NOMBRE (Npz)" o "NOMBRE Npz" al final del mensaje
                // Ejemplo: "ITEM 3 F 2pz" -> numParte = "ITEM 3 F", cantidad = 2
                // Ejemplo: "ITEM 3 F (2pz)" -> numParte = "ITEM 3 F", cantidad = 2
                const qtyPattern = /\(?\s*\d{1,5}\s*(?:pz|pzas|pza|pcs|pieza|piezas)\s*\)?$/i;
                const textWithoutQty = msgText.replace(qtyPattern, '').trim();
                
                // Si después de quitar la cantidad queda algo significativo (con espacios internos y alfanuméricos)
                // y contiene al menos una letra, usarlo como numParte
                if (textWithoutQty && textWithoutQty.length >= 3) {
                    const hasLetter = /[A-Za-z]/.test(textWithoutQty);
                    const hasNumber = /[0-9]/.test(textWithoutQty);
                    // Formato "ITEM X Y" (con espacios, letras y opcionalmente números)
                    if (hasLetter && (hasNumber || textWithoutQty.includes(' '))) {
                        // Evitar que sea solo palabras banned
                        const banned = new Set(['PZ', 'PZS', 'PZA', 'PZAS', 'PC', 'PCS', 'PIEZA', 'PIEZAS', 'UND', 'UNDS', 'UNIDAD', 'UNIDADES']);
                        const words = textWithoutQty.toUpperCase().split(/\s+/);
                        const allBanned = words.every(w => banned.has(w) || /^\d+$/.test(w));
                        if (!allBanned) {
                            return textWithoutQty;
                        }
                    }
                }

                // 1) Preferir patrones con separadores
                const m1 = msgText.match(/([A-Z0-9]{1,24}(?:[-_\/][A-Z0-9]{1,24}){1,6})/i);
                if (m1 && m1[1]) return String(m1[1]).trim();

                // 2) Fallback: token alfanumérico con al menos un dígito
                const tokens = msgText.match(/[A-Z0-9][A-Z0-9\-_\/]{2,30}/ig) || [];
                const banned = new Set(['PZ', 'PZS', 'PZA', 'PZAS', 'PC', 'PCS', 'PIEZA', 'PIEZAS', 'UND', 'UNDS', 'UNIDAD', 'UNIDADES']);
                for (const t of tokens) {
                    const clean = String(t || '').trim();
                    if (!clean) continue;
                    const up = clean.toUpperCase();
                    if (banned.has(up)) continue;
                    if (/^\d+$/.test(clean)) continue; // solo número
                    if (!/[0-9]/.test(clean) && !/[-_\/]/.test(clean)) continue; // texto libre
                    return clean;
                }
            } catch (e) {
                return null;
            }
            return null;
        })();

        // Cantidad: preferir un número explícito DESPUÉS del numParte (ej: "001-058 16"), si existe.
        let cantidadMatch = null;
        if (numParte) {
            try {
                const esc = String(numParte).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(esc + "\\D*(\\d{1,5})\\b", 'i');
                cantidadMatch = msgText.match(re);
            } catch (e) {
                cantidadMatch = null;
            }
        }

        let numPiezas = cantidadMatch ? parseInt(cantidadMatch[1], 10) : (qtyHintInline !== null ? qtyHintInline : null);

        if (!numParte) {
            try {
                await guardarMensajeGenericoEnBD({ mensaje, remitenteRaw: remitente, messageObj, imagenBase64, messageId });
            } catch (e) {
                console.error('❌ No se pudo guardar mensaje genérico en BD:', e);
            }

            // Guardar hint para el siguiente mensaje del mismo chat (qty/imagen)
            if (qtyHintInline !== null || imagenBase64) {
                setChatHint(chatId, {
                    qty: qtyHintInline !== null ? qtyHintInline : null,
                    imagenBase64: imagenBase64 || null
                });
            }

            const preview = String(mensaje || '').slice(0, 80);
            const nuevoRegistro = {
                // Mostrar el texto para que en UI se vea que "sí se aceptó"
                numeroParte: preview || '(mensaje)',
                piezas: (qtyHintInline !== null ? qtyHintInline : null),
                imagen: imagenBase64,
                rawMessage: mensaje,
                timestamp: new Date().toLocaleString('es-ES'),
                rutaBackup: null,
                rutaEngrave: null,
                messageId: messageId || null
            };

            registros.unshift(nuevoRegistro);
            if (registros.length > 20) registros.pop();
            try { broadcastNewRegistro(nuevoRegistro); } catch (e) { console.log('⚠️ Error emitiendo SSE:', e); }

            const previewLong = String(mensaje || '').slice(0, 250);
            let respuesta = `✅ MENSAJE GUARDADO\n📝 Texto: ${previewLong}`;
            if (String(mensaje || '').length > 250) respuesta += '…';
            if (qtyHintInline !== null || imagenBase64) {
                respuesta += `\nℹ️ Si este mensaje corresponde a una pieza, ahora envía el NÚMERO DE PARTE.`;
                if (qtyHintInline !== null) respuesta += `\n🔢 Cantidad detectada: ${qtyHintInline}`;
                if (imagenBase64) respuesta += '\n📷 Imagen recibida';
            }
            try { await safeSendMessage(remitente, respuesta, { sendSeen: false }); } catch (e) { /* noop */ }
            return;
        }

        // Si no hay cantidad o imagen en este mensaje, intentar usar hint del chat
        let appliedHint = false;
        if ((numPiezas === null || isNaN(numPiezas)) || !imagenBase64) {
            const hint = takeChatHint(chatId);
            if (hint) {
                if ((numPiezas === null || isNaN(numPiezas)) && hint.qty !== null && hint.qty !== undefined) {
                    numPiezas = hint.qty;
                    appliedHint = true;
                }
                if (!imagenBase64 && hint.imagenBase64) {
                    imagenBase64 = hint.imagenBase64;
                    appliedHint = true;
                }
            }
        }

        console.log(`📊 Procesando: ${numParte} - ${numPiezas} piezas`);
        
        // Guardar en el sistema de grabado - si falla, caemos a Excel/respaldo local
        let engraveResult = null;
        let rutaBackup = null;
        try {
            engraveResult = await guardarEnSistemaGrabado(numParte, numPiezas, imagenBase64, messageId);
        } catch (engraveError) {
            console.log('🔄 Error guardando en sistema de grabado, realizando respaldo local...');
            try {
                rutaBackup = await guardarRespaldoLocal(numParte, numPiezas, imagenBase64);
            } catch (backupErr) {
                console.log('⚠️ No se pudo guardar respaldo local, registrando de emergencia...');
                await guardarUltimoRespaldo(numParte, numPiezas, imagenBase64);
            }
        }

        // Si no se pudo descargar imagen, encolar reintento con datos completos
        if (!imagenBase64 && messageObj && messageObj.hasMedia) {
            const msgIdForRetry = messageId || (messageObj && messageObj.id ? (messageObj.id._serialized || messageObj.id.id || null) : null);
            if (msgIdForRetry) {
                enqueueMediaRetry({
                    messageId: msgIdForRetry,
                    chatId: chatId || (messageObj && messageObj.from ? String(messageObj.from) : null),
                    uid: engraveResult?.uid || makeWhatsAppUid(msgIdForRetry),
                    numParte,
                    numPiezas
                });
            }
        }
        
        // Agregar a registros en tiempo real
        const nuevoRegistro = {
            numeroParte: numParte,
            piezas: numPiezas,
            imagen: imagenBase64,
            timestamp: new Date().toLocaleString('es-ES'),
            rutaBackup: rutaBackup ? path.basename(rutaBackup) : null,
            rutaEngrave: engraveResult ? (engraveResult.uid || null) : null,
            messageId: messageId || null
        };
        
        registros.unshift(nuevoRegistro);
        if (registros.length > 20) registros.pop();
        // Emitir el nuevo registro a clientes conectados (SSE)
        try {
            broadcastNewRegistro(nuevoRegistro);
        } catch (e) {
            console.log('⚠️ Error emitiendo SSE:', e);
        }
        
        // Confirmación - si faltan piezas indicar claramente
        let respuesta = `✅ REGISTRADO EXITOSAMENTE\n📦 Parte: ${numParte}`;
        if (numPiezas !== null && !isNaN(numPiezas)) {
            respuesta += `\n🔢 Piezas: ${numPiezas}`;
        } else {
            respuesta += `\n🔢 Piezas: (FALTA) — por favor confirma la cantidad cuando puedas.`;
        }

        if (appliedHint) {
            respuesta += `\n🧩 Se combinó con tu mensaje anterior (cantidad/imagen).`;
        }

        if (engraveResult && engraveResult.uid) {
            // No mostrar uid en el chat (evita confusión y ruido para el operador)
            respuesta += `\n🗄️ Guardado en: BASE DE DATOS`;
            if (WRITE_TO_ENGRAVE_FILES && engraveResult.sourceFile) {
                respuesta += `\n🗂️ Archivo legacy: ${engraveResult.sourceFile}`;
            }
        } else if (rutaBackup) {
            respuesta += `\n📂 Guardado en: RESPALDO LOCAL (${path.basename(rutaBackup)})`;
        } else {
            respuesta += '\n⚠️ No se pudo guardar en BD ni en respaldo';
        }
        
        if (imagenBase64) {
            respuesta += '\n📷 Imagen recibida';
        }
        
        await safeSendMessage(remitente, respuesta, { sendSeen: false });
        
    } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
        try {
            await safeSendMessage(remitente,
                '❌ Error al procesar el mensaje.\n' +
                'El sistema sigue funcionando para nuevos registros.',
                { sendSeen: false }
            );
        } catch (e) { /* noop */ }
    }
}

// Evento de mensajes de WhatsApp - CORREGIDO
async function handleWhatsAppMessage(message) {
    const mensaje = (message.body || '').trim();
    const remitenteRaw = message.from;
    const remitente = normalizeNumber(remitenteRaw);

    console.log(`📩 Mensaje de ${remitente}: ${mensaje}`);
    addWhatsAppLog('message', `Mensaje recibido de ${remitenteRaw || remitente || 'desconocido'}`, {
        from: remitenteRaw || remitente || null,
        preview: String(mensaje || '').slice(0, 180)
    });

    // El comando ALTA y la gestión de tokens/autorizaciones fueron eliminados.

    // 🔒 FILTRO DE GRUPO: Si el filtro está activo, validar que el mensaje venga del grupo autorizado
    if (USE_GROUP_FILTER) {
        const senderJid = message.from || '';
        const isFromGroup = senderJid.includes('@g.us');
        const senderNumber = normalizeNumber(senderJid); // número sin sufijo

        // Comprobar autorizaciones posibles:
        // 1) JID de grupo (12036...@g.us)
        // 2) JID de contacto (5214428750295@c.us)
        // 3) Número limpio (5214428750295)
        const authorizedName = ALLOWED_GROUPS[senderJid] || ALLOWED_GROUPS[`${senderNumber}@c.us`] || ALLOWED_GROUPS[senderNumber];

        if (!isFromGroup && !authorizedName) {
            // No es grupo y tampoco está autorizado como contacto -> rechazar sin responder
            console.log(`⛔ Mensaje rechazado: No viene de un grupo (es mensaje privado de ${remitente}) - no se enviará respuesta`);
            addWhatsAppLog('rejected', 'Mensaje privado rechazado (no autorizado)', {
                from: senderJid,
                reason: 'not_authorized_contact'
            }, 'warn');
            return;
        }

        if (!authorizedName) {
            // Es un grupo pero no está en la lista -> rechazar sin responder
            const groupId = senderJid;
            const groupNameGuess = senderJid.substring(0, senderJid.indexOf('@g.us')) || 'desconocido';
            console.log(`⛔ Mensaje rechazado: Grupo no autorizado (${groupId} - ${groupNameGuess}) - no se enviará respuesta`);
            addWhatsAppLog('rejected', 'Grupo no autorizado', {
                from: senderJid,
                groupId,
                groupName: groupNameGuess
            }, 'warn');
            return;
        }

        // Si llegamos aquí, está autorizado (ya sea grupo o contacto)
        console.log(`✅ Mensaje autorizado de: ${authorizedName} (${senderJid})`);
        addWhatsAppLog('authorized', `Autorizado: ${authorizedName}`, {
            from: senderJid,
            name: authorizedName
        }, 'info');
    }

    // Ya no se exige autorización por lista; aceptar mensajes de cualquier remitente (si no hay filtro de grupo).

    // ✅ Sin filtro de nomenclatura: cualquier mensaje autorizado se guarda.
    await procesarMensaje(mensaje, remitenteRaw, message);
}

// Iniciar servidor y capturar la instancia para ajustes y manejo de errores
let server = null;

async function startServer() {
    if (server) return server;
    assertSecureStartupConfig();
    console.log(`🧾 Log estructurado del servidor: ${SERVER_LOG_FILE}`);

    // Inicializar base de datos
    try {
        await db.initializeDatabase();
        try {
            const database = db.getDb();
            await ensureAuthUsersTable(database);
            await ensureAdminUserSeed(database);
        } catch (e) {
            console.warn('Auth bootstrap warning:', e && e.message ? e.message : e);
        }
        console.log('✅ Base de datos inicializada');
        // Cargar configuración de grupos autorizados (DB/file/env)
        try { await loadGroupConfig(); } catch (e) { console.warn('⚠️ No se pudo cargar filtro de grupos:', e && e.message ? e.message : e); }
        await ensureSystemLots();
        // Reconciliar piezas con la carpeta de imágenes de red (evita "no hay registros" tras reset)
        try { await syncNetworkImagesToDb({ verbose: true }); } catch (e) { console.warn('⚠️ Sync imágenes falló:', e && e.message ? e.message : e); }
        // Restaurar cantidades desde BD legacy si existe (evita Cantidad=0 tras reconstrucción desde /images)
        try { await restoreQuantitiesFromLegacyDb({ verbose: true }); } catch (e) { console.warn('⚠️ Restore cantidades falló:', e && e.message ? e.message : e); }
    } catch (err) {
        console.error('❌ Error inicializando BD:', err);
        process.exit(1);
    }
    
    server = app.listen(PORT, HOST, () => {
        try {
            // Ensure to_engrave directory exists at startup
            crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
            console.log(`🌐 Servidor activo (local): http://localhost:${PORT}`);
            console.log(`🌐 Host bind: ${HOST}:${PORT}`);
            const lan = getLanUrls(PORT);
            if (lan.length) {
                console.log('🌐 URLs en red (multiusuario):');
                lan.forEach(u => console.log('   - ' + u));
            } else {
                console.log('ℹ️ No se detectaron IPs LAN (¿sin red o adaptador deshabilitado?)');
            }
            console.log(`📱 Abre esa URL en el navegador para escanear QR`);
            // Importar archivos pendientes (legacy JSON) SOLO si está habilitado
            if (WRITE_TO_ENGRAVE_FILES) {
                importPendingFilesAtStartup().catch((impErr) => {
                    console.error('❌ Error importando pendientes al iniciar:', impErr);
                });
            } else {
                console.log('🧹 JSON legacy deshabilitado: no se importan engrave_*.json al iniciar');
            }
            scheduleWhatsAppInitialize('startup', 0);
        } catch (e) {
            console.error('Error en startup:', e);
        }
    });

    // Ajustes de timeouts para mejorar estabilidad en algunas plataformas
    try {
        server.keepAliveTimeout = 65000; // 65s
        server.headersTimeout = 70000; // 70s
    } catch (e) { /* ignore if not supported */ }

    server.on('error', (err) => {
        console.error('❌ Server error:', err);
    });

    return server;
}

async function stopServer() {
    try {
        if (client) {
            try { await client.destroy(); } catch (e) { /* noop */ }
        }
    } catch (e) { /* ignore */ }

    return new Promise((resolve) => {
        try {
            if (!server) return resolve(true);
            server.close(() => {
                console.log('Servidor cerrado');
                server = null;
                resolve(true);
            });
            // forzar después de 3s
            setTimeout(() => {
                try { server && server.close && server.close(); } catch (e) {}
                server = null;
                resolve(true);
            }, 3000);
        } catch (e) {
            server = null;
            resolve(false);
        }
    });
}

// Si el archivo se ejecuta directamente, iniciar el servidor
if (require.main === module) {
    startServer().catch(err => {
        console.error('Error arrancando servidor:', err);
        process.exit(1);
    });
}

// Exportar funciones para ser controladas por Electron u otros wrappers
module.exports = { startServer, stopServer };

let lastWaTransientRejectionLogAt = 0;
function isExpectedWaTransientRejection(msg) {
    try {
        const s = String(msg || '').toLowerCase();
        if (!s) return false;
        // Errores típicos de Puppeteer/WA al reiniciar pestaña o destruir el cliente.
        const hasTargetClosed = s.includes('target closed');
        const hasProtocolOrBinding = s.includes('protocol error') || s.includes('runtime.addbinding');
        const hasContextReset = s.includes('execution context was destroyed') || s.includes('session closed');
        return hasTargetClosed || (hasProtocolOrBinding && hasContextReset) || (hasProtocolOrBinding && s.includes('target'));
    } catch (e) {
        return false;
    }
}

// Manejo de excepciones no capturadas para registrar y continuar cuando sea posible
process.on('unhandledRejection', (reason, promise) => {
    try {
        const msg = String(reason && reason.message ? reason.message : reason || '');
        if (isExpectedWaTransientRejection(msg)) {
            // Durante un hard reset de WA, estos rechazos son esperados: silenciar.
            if (waResetting) return;

            // Si ocurre fuera de reset, dejar una traza breve con throttling.
            const now = Date.now();
            if ((now - lastWaTransientRejectionLogAt) > 60_000) {
                lastWaTransientRejectionLogAt = now;
                console.warn('ℹ️ Rechazo transitorio WA (ignorado):', msg.slice(0, 200));
            }
            return;
        }
    } catch (e) { /* noop */ }
    console.error('❗ Unhandled Rejection at:', promise, 'reason:', reason);
    // No terminar el proceso automáticamente; logueamos para investigar.
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    // Try to perform a graceful shutdown; if not possible, exit
    try {
        server.close(() => {
            console.log('Servidor cerrado tras excepción no capturada');
            process.exit(1);
        });
    } catch (e) {
        console.error('Error durante shutdown tras uncaughtException:', e);
        process.exit(1);
    }
});

// Gestión de usuarios autorizados removida (aceptar mensajes de cualquier remitente).

// Endpoint útil para forzar re-conexión / reautenticación y obtener un nuevo QR
app.post('/force-reconnect', async (req, res) => {
    try {
        const result = await restartWhatsAppClient({
            reason: 'force-reconnect endpoint',
            killLockedBrowser: true
        });
        return res.json(result);
    } catch (err) {
        console.error('Error en /force-reconnect:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Endpoint para agregar un registro a la cola (usable por bots o scripts)
app.post('/enqueue', async (req, res) => {
    try {
        const { numParte, numPiezas, piezas, cantidad, imagen, clientId, messageId } = req.body || {};
        // numParte es obligatorio; numPiezas es opcional (permitir registro sin cantidad)
        if (!numParte) return res.status(400).json({ error: 'numParte es requerido' });

        const piecesRaw = (numPiezas !== undefined ? numPiezas : (piezas !== undefined ? piezas : (cantidad !== undefined ? cantidad : undefined)));
        let piecesParsed = null;
        if (piecesRaw !== undefined && piecesRaw !== null && piecesRaw !== '') {
            const n = Number(piecesRaw);
            if (Number.isFinite(n)) piecesParsed = n;
            else {
                // Permitir formatos tipo "16pz" o "16 pzas" por compatibilidad
                const hinted = extractQuantityHint(String(piecesRaw));
                piecesParsed = (hinted !== null && hinted !== undefined) ? hinted : null;
            }
        }

        // Si se proporcionó messageId y ya lo procesamos, evitar crear duplicado
        if (messageId && isDuplicateMessageId(messageId)) {
            console.log('➡️ /enqueue recibido pero messageId ya procesado, omitiendo creación:', messageId, numParte);
            return res.json({ ok: true, skippedDuplicate: true, messageId });
        }
        const result = await guardarEnSistemaGrabado(numParte, piecesParsed, imagen || null, messageId || null);
        // También agregamos a registros en memoria y emitimos SSE para actualizar frontends
        const nuevoRegistro = {
            numeroParte: numParte,
            piezas: piecesParsed,
            imagen: imagen || null,
            timestamp: new Date().toLocaleString('es-ES'),
            rutaEngrave: result ? (result.uid || null) : null,
            clientId: clientId || null,
            messageId: messageId || null
        };
        registros.unshift(nuevoRegistro);
        if (registros.length > 20) registros.pop();
        try {
            console.log(`➡️ /enqueue guardado: parte=${nuevoRegistro.numeroParte} piezas=${nuevoRegistro.piezas} clientId=${nuevoRegistro.clientId}`);
            broadcastNewRegistro(nuevoRegistro);
        } catch (e) { console.log('⚠️ Error emitiendo SSE desde /enqueue', e); }

        // Devolver también el clientId para confirmación (si fue enviado)
        res.json({ ok: true, uid: result?.uid || null, clientId: clientId || null });
    } catch (error) {
        console.error('Error en /enqueue:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Handler de errores genérico de Express (último middleware)
app.use((err, req, res, next) => {
    try {
        console.error('Express error handler:', err && err.stack ? err.stack : err);
        if (res.headersSent) return next(err);
        res.status(err && err.status ? err.status : 500).json({ error: err && err.message ? err.message : 'Internal Server Error' });
    } catch (e) {
        console.error('Error en error-handler:', e);
        try { res.status(500).json({ error: 'Internal Server Error' }); } catch (ee) { /* noop */ }
    }
});

// Endpoint para limpiar el campo numParte dentro de un archivo de la cola `to_engrave`
app.post('/engrave/clear-part', async (req, res) => {
    try {
        const { filename } = req.body || {};
        if (!filename) return res.status(400).json({ ok: false, error: 'filename requerido' });

        // Asegurar que filename sea solo basename para evitar traversal
        const safeName = path.basename(String(filename));
        if (!safeName.endsWith('.json')) return res.status(400).json({ ok: false, error: 'archivo no válido' });

        const filePath = path.join(TO_ENGRAVE_DIR, safeName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'archivo no encontrado' });

        // Leer y modificar
        const raw = fs.readFileSync(filePath, 'utf8');
        let obj;
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'JSON inválido' });
        }

        // Limpiar numParte (o propiedad análoga)
        if (Object.prototype.hasOwnProperty.call(obj, 'numParte')) {
            obj.numParte = null;
        } else if (Object.prototype.hasOwnProperty.call(obj, 'numeroParte')) {
            obj.numeroParte = null;
        } else if (Object.prototype.hasOwnProperty.call(obj, 'part')) {
            obj.part = null;
        } else {
            // Si no existe la propiedad esperada, devolver ok (no bloquear)
        }

        // Reescribir el archivo
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');

        console.log(`✳️ numParte limpiado en: ${filePath}`);
        return res.json({ ok: true, file: safeName });
    } catch (err) {
        console.error('Error en /engrave/clear-part:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Endpoint para detener el cliente WhatsApp sin cerrar el proceso Node
app.post('/stop-client', async (req, res) => {
    try {
        try {
            // Intentar destruir el cliente si existe
            if (client) {
                try { await client.destroy(); } catch (e) { console.warn('Error destruyendo client en stop-client:', e); }
            }
        } catch (e) { /* noop */ }

        // Actualizar estado
        isAuthenticated = false;
        qrCode = null;

        console.log('🛑 stop-client: cliente WhatsApp detenido (si existía)');
        return res.json({ ok: true, message: 'Client stopped (if it was running)' });
    } catch (err) {
        console.error('Error en /stop-client:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Endpoint para eliminar un archivo de la cola de grabado y su imagen asociada (si existe)
app.post('/engrave/delete', requirePermission('pieces.delete'), async (req, res) => {
    try {
        const { filename, messageId } = req.body || {};

        let targetFile = filename && String(filename).trim() ? path.basename(String(filename)) : null;
        let targetUid = null;

        // Si filename parece UID (no .json), borrar por BD
        if (targetFile && !String(targetFile).toLowerCase().endsWith('.json')) {
            targetUid = String(targetFile);
        }

        // Si se proporcionó messageId, intentar localizar UID en BD
        if (!targetUid && messageId) {
            try {
                const database = db.getDb();
                targetUid = await new Promise((resolve) => {
                    database.get(
                        'SELECT uid FROM pieces WHERE messageId = ? ORDER BY rowid DESC LIMIT 1',
                        [String(messageId)],
                        (err, row) => {
                            if (err) return resolve(null);
                            resolve(row?.uid || null);
                        }
                    );
                });
            } catch (e) {
                targetUid = null;
            }
        }

        // Si tenemos UID, borrar en BD y salir
        if (targetUid) {
            const del = await db.deletePiece(targetUid);
            // También eliminar de memoria `registros`
            try {
                registros = registros.filter(r => {
                    if (!r) return false;
                    if (r.rutaEngrave && String(r.rutaEngrave) === String(targetUid)) return false;
                    if (messageId && r.messageId && String(r.messageId) === String(messageId)) return false;
                    return true;
                });
            } catch (e) { /* noop */ }
            try { broadcastNewRegistro({ deleted: true, uid: targetUid }); } catch (e) { /* noop */ }
            return res.json({ ok: true, deletedUid: targetUid, deleted: del?.deleted || 0 });
        }

        // Si se proporcionó messageId en lugar de filename, buscar el JSON que lo contenga
        if (!targetFile && messageId) {
            try {
                crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
                const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
                for (const f of files) {
                    try {
                        const raw = fs.readFileSync(path.join(TO_ENGRAVE_DIR, f), 'utf8');
                        const obj = JSON.parse(raw);
                        if (obj && (obj.messageId === messageId || obj.messageId === String(messageId))) {
                            targetFile = f;
                            break;
                        }
                    } catch (e) { /* ignore malformed */ }
                }
            } catch (e) { /* ignore search errors */ }
        }

        if (!targetFile) return res.status(400).json({ ok: false, error: 'filename or messageId required' });

        // Evitar traversal y obtener ruta segura
        const safeName = path.basename(targetFile);
        const filePath = path.join(TO_ENGRAVE_DIR, safeName);

        if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'file not found', file: safeName });

        // Intentar leer el JSON para detectar imagen asociada y borrarla
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            let obj = null;
            try { obj = JSON.parse(raw); } catch (e) { obj = null; }
            if (obj && obj.imagen) {
                // imagen puede ser ruta relativa 'images/xxx' o ruta completa
                const imagenRel = String(obj.imagen).replace(/\\\\/g, '/').replace(/\\/g, '/');
                const imgName = imagenRel.split('/').pop();
                if (imgName) {
                    const imgPath = path.join(TO_ENGRAVE_DIR, 'images', imgName);
                    try { if (fs.existsSync(imgPath)) { fs.unlinkSync(imgPath); console.log('🗑️ Imagen eliminada:', imgPath); } } catch (e) { console.warn('No se pudo eliminar imagen asociada:', e); }
                }
            }
        } catch (e) {
            console.warn('No se pudo leer JSON antes de eliminar:', e);
        }

        // Eliminar el JSON
        try { fs.unlinkSync(filePath); console.log('🗑️ Archivo de cola eliminado:', filePath); } catch (e) { console.error('Error eliminando archivo:', e); return res.status(500).json({ ok: false, error: 'delete failed' }); }

        // También eliminar de memoria `registros` si coincidiera con la ruta o messageId
        try {
            registros = registros.filter(r => {
                if (!r) return false;
                if (r.rutaEngrave && path.basename(r.rutaEngrave) === safeName) return false;
                if (req.body.messageId && r.messageId && String(r.messageId) === String(req.body.messageId)) return false;
                return true;
            });
        } catch (e) { /* noop */ }

        // Emitir broadcast para indicar que hubo eliminación (opcional)
        try { broadcastNewRegistro({ deleted: true, filename: safeName }); } catch (e) { /* noop */ }

        return res.json({ ok: true, deleted: safeName });
    } catch (err) {
        console.error('Error en /engrave/delete:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ========================================
// API para gestión de BD (CRUD de Lotes y Piezas)
// ========================================

// GET: Obtener todos los lotes con sus piezas
app.get('/api/lotes', async (req, res) => {
    try {
        const allLotes = await db.getAllLots();
        
        // ✅ FILTRAR: Solo lotes con IDs válidos
        const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
        const lotes = allLotes.filter(lot => {
            const isValid = validPrefixes.some(prefix => lot.id === prefix || lot.id.startsWith(prefix));
            if (!isValid) {
                console.log('🚫 [API] Ignorando lote con ID inválido:', lot.id);
            }
            return isValid;
        });
        
        const result = {};
        
        for (const lot of lotes) {
            const pieces = await db.getPiecesInLot(lot.id);
            const metrics = await db.getLotMetrics(lot.id);
            
            result[lot.id] = {
                name: lot.name,
                process: lot.process,
                pieces: pieces,
                laserMetrics: metrics.find(m => m.metric_type === 'laser')?.data || {},
                pavonadoMetrics: metrics.find(m => m.metric_type === 'pavonado')?.data || {}
            };
        }
        
        res.json(result);
    } catch (err) {
        console.error('Error en /api/lotes:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST: Guardar/actualizar un lote
app.post('/api/lotes', requirePermission('lotes.manage'), async (req, res) => {
    try {
        const { id, name, process, metadata } = req.body;
        if (!id || !name) {
            return res.status(400).json({ error: 'id y name requeridos' });
        }
        
        const result = await db.saveLot(id, name, process, metadata);
        try { broadcastDataChanged({ entity: 'lote', action: 'upsert', id }); } catch (e) { /* noop */ }
        res.json(result);
    } catch (err) {
        console.error('Error en POST /api/lotes:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE: Eliminar un lote
app.delete('/api/lotes/:id', requirePermission('lotes.manage'), async (req, res) => {
    try {
        const id = req.params.id;
        const result = await db.deleteLot(id);
        try { broadcastDataChanged({ entity: 'lote', action: 'delete', id }); } catch (e) { /* noop */ }
        res.json(result);
    } catch (err) {
        console.error('Error en DELETE /api/lotes:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST: Guardar una pieza
app.post('/api/pieces', requireAnyPermission(['pieces.create', 'pieces.edit']), async (req, res) => {
    try {
        const piece = req.body;
        if (!piece.uid || !piece.lot_id) {
            return res.status(400).json({ error: 'uid y lot_id requeridos' });
        }
        
        const result = await db.savePiece(piece);
        try { broadcastDataChanged({ entity: 'piece', action: 'upsert', uid: piece.uid, lot_id: piece.lot_id }); } catch (e) { /* noop */ }
        res.json(result);
    } catch (err) {
        console.error('Error en POST /api/pieces:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET: Obtener piezas de un lote
app.get('/api/lotes/:id/pieces', async (req, res) => {
    try {
        if (req.params.id === 'lotes') {
            try { await maybeAutoRecoverLotesFromImages({ verbose: true, reason: 'GET /api/lotes/lotes/pieces' }); } catch (e) { /* noop */ }
            try { await maybeAutoRestoreQuantitiesFromLegacy({ verbose: true, reason: 'GET /api/lotes/lotes/pieces' }); } catch (e) { /* noop */ }
        }
        const pieces = await db.getPiecesInLot(req.params.id);
        res.json(pieces);
    } catch (err) {
        console.error('Error en GET /api/lotes/:id/pieces:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE: Eliminar una pieza
app.delete('/api/pieces/:uid', requirePermission('pieces.delete'), async (req, res) => {
    try {
        const uid = req.params.uid;

        // Intentar obtener datos antes de borrar para limpiar artefactos (JSON de cola / imágenes)
        let existing = null;
        try {
            existing = await db.getPieceByUid(uid);
        } catch (e) {
            existing = null;
        }

        // 1) Borrar de BD
        const result = await db.deletePiece(uid);

        // 2) Best-effort: eliminar archivos en disco asociados.
        // Esto evita que rutinas de auto-recovery (basadas en /to_engrave) re-inserten piezas borradas.
        try {
            const candidates = [];
            if (uid && String(uid).toLowerCase().endsWith('.json')) candidates.push(String(uid));
            if (existing && existing.sourceFile && String(existing.sourceFile).toLowerCase().endsWith('.json')) candidates.push(String(existing.sourceFile));

            for (const cand of candidates) {
                try {
                    const safeName = path.basename(String(cand));
                    const filePath = path.join(TO_ENGRAVE_DIR, safeName);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log('🗑️ [API] Archivo de cola eliminado por deletePiece:', filePath);
                    }
                } catch (e) {
                    console.warn('No se pudo eliminar JSON asociado en deletePiece:', e);
                }
            }

            // Imagen asociada (si es nombre de archivo y no data URL)
            if (existing && existing.imagen && typeof existing.imagen === 'string' && !existing.imagen.startsWith('data:')) {
                const imgName = path.basename(existing.imagen);
                const imgPath1 = path.join(TO_ENGRAVE_DIR, 'images', imgName);
                const imgPath2 = path.join(TO_ENGRAVE_DIR, imgName);
                for (const p of [imgPath1, imgPath2]) {
                    try {
                        if (fs.existsSync(p)) {
                            fs.unlinkSync(p);
                            console.log('🗑️ [API] Imagen eliminada por deletePiece:', p);
                        }
                    } catch (e) {
                        console.warn('No se pudo eliminar imagen asociada en deletePiece:', e);
                    }
                }
            }
        } catch (e) {
            // No bloquear el delete por fallos de limpieza
        }

        try { broadcastDataChanged({ entity: 'piece', action: 'delete', uid }); } catch (e) { /* noop */ }
        res.json(result);
    } catch (err) {
        console.error('Error en DELETE /api/pieces:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST: Mover una pieza a otro lote (operación ligera)
// Body: { lot_id: "destLotId", proceso?: "laser"|"pavonado"|"ambos"|"" }
app.post('/api/pieces/:uid/move', requirePermission('pieces.move'), async (req, res) => {
    try {
        const uid = req.params.uid;
        const body = req.body || {};
        const destLotId = body.lot_id;
        const proceso = Object.prototype.hasOwnProperty.call(body, 'proceso') ? body.proceso : undefined;

        if (!uid || !destLotId) {
            return res.status(400).json({ error: 'uid y lot_id requeridos' });
        }

        if (typeof db.movePieceLotId !== 'function') {
            return res.status(500).json({ error: 'movePieceLotId no disponible' });
        }

        const result = await db.movePieceLotId(uid, destLotId, proceso);
        try { broadcastDataChanged({ entity: 'piece', action: 'move', uid, lot_id: destLotId }); } catch (e) { /* noop */ }
        return res.json({ ok: true, ...result, uid, lot_id: destLotId });
    } catch (err) {
        console.error('Error en POST /api/pieces/:uid/move:', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE: Eliminar un registro reciente (de memoria y opcionalmente de la BD)
app.delete('/api/registros/:identifier', requirePermission('pieces.delete'), async (req, res) => {
    try {
        const identifier = req.params.identifier;
        const deletePermanent = req.query.permanent === 'true';
        
        // Buscar el registro en memoria por messageId, rutaEngrave (uid) o índice
        let found = null;
        let foundIndex = -1;
        
        for (let i = 0; i < registros.length; i++) {
            const reg = registros[i];
            if (reg.messageId === identifier || 
                reg.rutaEngrave === identifier ||
                String(i) === identifier) {
                found = reg;
                foundIndex = i;
                break;
            }
        }
        
        if (foundIndex === -1) {
            return res.status(404).json({ error: 'Registro no encontrado', identifier });
        }
        
        // Eliminar de memoria
        registros.splice(foundIndex, 1);
        
        // Si se solicita eliminación permanente, también eliminar de la BD
        let dbDeleted = false;
        if (deletePermanent && found.rutaEngrave) {
            try {
                await db.deletePiece(found.rutaEngrave);
                dbDeleted = true;
            } catch (dbErr) {
                console.warn('No se pudo eliminar de BD:', dbErr.message);
            }
        }
        
        console.log(`🗑️ Registro eliminado: ${found.numeroParte || identifier} (permanent: ${deletePermanent}, dbDeleted: ${dbDeleted})`);

        // Notificar a todos los clientes que cambió el estado (lista de recientes / BD si aplica)
        try {
            broadcastDataChanged({
                entity: 'registro',
                action: 'delete',
                identifier,
                permanent: !!deletePermanent,
                dbDeleted: !!dbDeleted
            });
        } catch (e) { /* noop */ }
        
        res.json({ 
            ok: true, 
            deleted: found,
            permanent: deletePermanent,
            dbDeleted
        });
    } catch (err) {
        console.error('Error en DELETE /api/registros:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST: Guardar métricas de un lote
app.post('/api/lotes/:id/metrics', requirePermission('metrics.edit'), async (req, res) => {
    try {
        const { metric_type, data } = req.body;
        if (!metric_type) {
            return res.status(400).json({ error: 'metric_type requerido' });
        }
        
        const lotId = req.params.id;
        const result = await db.saveLotMetrics(lotId, metric_type, data);
        try { broadcastDataChanged({ entity: 'metrics', action: 'upsert', lot_id: lotId, metric_type }); } catch (e) { /* noop */ }
        res.json(result);
    } catch (err) {
        console.error('Error en POST /api/lotes/:id/metrics:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET: Obtener métricas de un lote
app.get('/api/lotes/:id/metrics', async (req, res) => {
    try {
        const metrics = await db.getLotMetrics(req.params.id);
        res.json(metrics);
    } catch (err) {
        console.error('Error en GET /api/lotes/:id/metrics:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST: Sincronizar todos los datos (exportar localStorage a BD)
app.post('/api/sync', requirePermission('data.sync'), async (req, res) => {
    try {
        const { laserGrabadoData } = req.body;
        if (!laserGrabadoData) {
            return res.status(400).json({ error: 'laserGrabadoData requerido' });
        }
        
        let savedCount = 0;
        let skippedByCutoff = 0;

        // Cutoff: si hubo cierre de mes, no aceptar datos viejos re-subidos por un cliente desactualizado.
        const database = db.getDb();
        let cutoffMs = null;
        try {
            const cutoffIso = await getSystemKv(database, 'images_import_cutoff_iso');
            const ms = toMs(cutoffIso);
            cutoffMs = (ms !== null && Number.isFinite(ms)) ? ms : null;
        } catch (e) {
            cutoffMs = null;
        }

        // ✅ FILTRAR: Solo permitir IDs de lotes válidos para que no se re-creen duplicados legacy
        const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
        
        // Iterar sobre cada lote
        for (const [lotKey, lotData] of Object.entries(laserGrabadoData)) {
            const isValidLotId = validPrefixes.some(prefix => lotKey === prefix || String(lotKey).startsWith(prefix));
            if (!isValidLotId) {
                // Importante: NO guardar lote ni piezas/metrics de IDs inválidos
                console.log('🚫 [API] Ignorando lote inválido en sync:', lotKey);
                continue;
            }
            // Guardar lote
            await db.saveLot(
                lotKey,
                lotData.name || lotKey,
                lotData.process || 'all',
                { metadata: lotData.metadata || {} }
            );
            savedCount++;
            
            // Guardar piezas del lote
            if (Array.isArray(lotData.pieces)) {
                for (const piece of lotData.pieces) {
                    if (piece.uid) {
                        // Si hay cutoff y la pieza es anterior o igual, omitirla para evitar reaparición tras cierre de mes
                        const pieceTsMs = (function() {
                            // 1) timestamp explícito
                            const ts = toMs(piece.timestamp || piece.fecha || piece.fechaTexto);
                            if (ts !== null) return ts;
                            // 2) parsear nombre de imagen o uid (engrave_*.jpeg)
                            try {
                                const name = piece.imagen || piece.uid || '';
                                const parsed = parseEngraveFilename(name);
                                const ms = toMs(parsed.isoTimestamp);
                                if (ms !== null) return ms;
                            } catch (e) { /* noop */ }
                            // 3) metadata.lastSync
                            try {
                                const metaTs = piece.metadata && piece.metadata.lastSync && piece.metadata.lastSync.at ? toMs(piece.metadata.lastSync.at) : null;
                                if (metaTs !== null) return metaTs;
                            } catch (e) { /* noop */ }
                            return null;
                        })();

                        if (cutoffMs !== null && pieceTsMs !== null && pieceTsMs <= cutoffMs) {
                            skippedByCutoff++;
                            continue;
                        }

                        // Evitar que una sincronización parcial pise datos válidos.
                        // Caso crítico: quantity>0 existente NO debe bajarse a 0.
                        const existing = await db.getPieceByUid(piece.uid).catch(() => null);

                        const incomingQtyRaw = (piece.quantity !== undefined ? piece.quantity : (piece.numPiezas !== undefined ? piece.numPiezas : (piece.piezas !== undefined ? piece.piezas : undefined)));
                        const incomingQtyNum = (incomingQtyRaw === null || incomingQtyRaw === undefined || incomingQtyRaw === '') ? null : Number(incomingQtyRaw);
                        const incomingQtyFinite = (incomingQtyNum !== null && Number.isFinite(incomingQtyNum)) ? incomingQtyNum : null;

                        const metaIn = (piece.metadata && typeof piece.metadata === 'object') ? piece.metadata : {};
                        const metaExisting = (existing && existing.metadata && typeof existing.metadata === 'object') ? existing.metadata : {};
                        const incomingMarksMissing = metaIn && metaIn.quantityMissing === true;

                        const quantityToSave = (function () {
                            // Si viene un qty > 0, usarlo.
                            if (incomingQtyFinite !== null && incomingQtyFinite > 0) return incomingQtyFinite;
                            // Si el cliente marca missing (o manda 0) pero ya existe qty>0, preservarlo.
                            if ((incomingMarksMissing || incomingQtyFinite === 0 || incomingQtyFinite === null) && existing && Number(existing.quantity) > 0) {
                                return Number(existing.quantity);
                            }
                            // fallback
                            if (incomingQtyFinite !== null) return Math.max(0, incomingQtyFinite);
                            return existing && Number.isFinite(Number(existing.quantity)) ? Number(existing.quantity) : 0;
                        })();

                        const incidentsToSave = (piece.incidents === undefined || piece.incidents === null)
                            ? (existing && Number.isFinite(Number(existing.incidents)) ? Number(existing.incidents) : 0)
                            : (Number.isFinite(Number(piece.incidents)) ? Math.max(0, Number(piece.incidents)) : 0);

                        const partToSave = (piece.partNumber && String(piece.partNumber).trim())
                            ? String(piece.partNumber)
                            : (existing && existing.partNumber ? existing.partNumber : '');

                        const imagenToSave = (piece.imagen !== undefined && piece.imagen !== null && piece.imagen !== '')
                            ? piece.imagen
                            : (existing ? (existing.imagen || null) : null);

                        const mergedMeta = {
                            ...(metaExisting || {}),
                            ...(metaIn || {}),
                            lastSync: {
                                at: new Date().toISOString(),
                                source: 'api/sync'
                            }
                        };

                        await db.savePiece({
                            uid: piece.uid,
                            lot_id: lotKey,
                            partNumber: partToSave,
                            quantity: quantityToSave,
                            incidents: incidentsToSave,
                            incidentType: piece.incidentType || '',
                            timestamp: piece.timestamp || new Date().toISOString(),
                            imagen: imagenToSave,
                            sourceFile: piece.sourceFile || null,
                            clientId: piece.clientId || null,
                            messageId: piece.messageId || null,
                            proceso: piece.proceso || '',
                            metadata: mergedMeta
                        });
                        savedCount++;
                    }
                }
            }
            
            // Guardar métricas del lote
            if (lotData.laserMetrics) {
                await db.saveLotMetrics(lotKey, 'laser', lotData.laserMetrics);
            }
            if (lotData.pavonadoMetrics) {
                await db.saveLotMetrics(lotKey, 'pavonado', lotData.pavonadoMetrics);
            }
        }
        
        try { broadcastDataChanged({ entity: 'sync', action: 'apply', saved: savedCount, skippedByCutoff }); } catch (e) { /* noop */ }
        res.json({ ok: true, message: `Sincronizados ${savedCount} items`, saved: savedCount, skippedByCutoff, cutoffMs });
    } catch (err) {
        console.error('Error en POST /api/sync:', err);
        res.status(500).json({ error: err.message });
    }
});

registerSnapshotRoutes(app, {
    db,
    requirePermission
});

if (false) {
// Legacy snapshot routes kept disabled after modular extraction.
// ========================================
// API: Snapshots mensuales (historial de reportes)
// ========================================

const MONTH_NAMES_ES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

// Función auxiliar: generar snapshot de datos actuales
async function generateCurrentSnapshot() {
    const allLotes = await db.getAllLots();
    const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
    const lotes = allLotes.filter(lot => validPrefixes.some(prefix => lot.id === prefix || lot.id.startsWith(prefix)));

    const result = {};
    for (const lot of lotes) {
        const pieces = await db.getPiecesInLot(lot.id);
        const metrics = await db.getLotMetrics(lot.id);

        result[lot.id] = {
            name: lot.name,
            process: lot.process,
            pieces: pieces,
            laserMetrics: metrics.find(m => m.metric_type === 'laser')?.data || {},
            pavonadoMetrics: metrics.find(m => m.metric_type === 'pavonado')?.data || {},
            metadata: lot.metadata
        };
    }
    return result;
}

// POST: Crear snapshot manualmente o desde cierre de mes
app.post('/api/monthly-snapshots', requirePermission('system.reset'), async (req, res) => {
    try {
        const body = req.body || {};
        const now = new Date();
        const month = Number.isFinite(body.month) ? body.month : (now.getMonth() + 1);
        const year = Number.isFinite(body.year) ? body.year : now.getFullYear();
        const reportType = body.reportType || 'all';
        const label = body.label || `${MONTH_NAMES_ES[month - 1] || ('Mes ' + month)} ${year}`;

        const snapshotData = await generateCurrentSnapshot();
        const saved = await db.saveMonthlySnapshot(month, year, reportType, label, snapshotData);

        res.json({ ok: true, snapshot: saved });
    } catch (err) {
        console.error('Error en POST /api/monthly-snapshots:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET: Listar todos los snapshots (sin data, solo metadatos)
app.get('/api/monthly-snapshots', async (req, res) => {
    try {
        const snapshots = await db.getAllMonthlySnapshots();
        res.json({ ok: true, snapshots });
    } catch (err) {
        console.error('Error en GET /api/monthly-snapshots:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET: Obtener un snapshot completo por ID
app.get('/api/monthly-snapshots/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
        const snapshot = await db.getMonthlySnapshot(id);
        if (!snapshot) return res.status(404).json({ error: 'Snapshot no encontrado' });
        res.json({ ok: true, snapshot });
    } catch (err) {
        console.error('Error en GET /api/monthly-snapshots/:id:', err);
        res.status(500).json({ error: err.message });
    }
});

// PATCH: Actualizar metadatos de snapshot (mes, año, etiqueta y fecha visible)
app.patch('/api/monthly-snapshots/:id', requirePermission('system.reset'), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

        const body = req.body || {};
        const updates = {};

        if (Object.prototype.hasOwnProperty.call(body, 'label')) {
            const label = String(body.label || '').trim();
            if (!label) return res.status(400).json({ error: 'label requerido' });
            if (label.length > 120) return res.status(400).json({ error: 'label demasiado largo (máx 120)' });
            updates.label = label;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'month')) {
            const month = Number(body.month);
            if (!Number.isInteger(month) || month < 1 || month > 12) {
                return res.status(400).json({ error: 'month inválido (1-12)' });
            }
            updates.month = month;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'year')) {
            const year = Number(body.year);
            if (!Number.isInteger(year) || year < 2000 || year > 3000) {
                return res.status(400).json({ error: 'year inválido (2000-3000)' });
            }
            updates.year = year;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'createdAt')) {
            const d = new Date(body.createdAt);
            if (!Number.isFinite(d.getTime())) return res.status(400).json({ error: 'createdAt inválido' });
            updates.createdAt = d.toISOString();
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'Sin campos para actualizar' });
        }

        const result = await db.updateMonthlySnapshotMeta(id, updates);
        if (!result || !result.updated) return res.status(404).json({ error: 'Snapshot no encontrado' });

        const snapshot = await db.getMonthlySnapshot(id);
        return res.json({ ok: true, snapshot });
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (msg.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'Ya existe un snapshot para ese mes/año/tipo' });
        }
        console.error('Error en PATCH /api/monthly-snapshots/:id:', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE: Eliminar un snapshot
app.delete('/api/monthly-snapshots/:id', requirePermission('system.reset'), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
        const result = await db.deleteMonthlySnapshot(id);
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('Error en DELETE /api/monthly-snapshots/:id:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET: Exportar todos los datos (para recuperación/backup)
}
app.get('/api/export', requirePermission('data.export'), async (req, res) => {
    try {
        try { await maybeAutoRecoverLotesFromImages({ verbose: true, reason: 'GET /api/export' }); } catch (e) { /* noop */ }
        const allLotes = await db.getAllLots();
        
        // ✅ FILTRAR: Solo lotes con IDs válidos
        const validPrefixes = ['lotes', 'whatsapp_inbox', 'laser-lot-', 'pavonado-lot-'];
        const lotes = allLotes.filter(lot => {
            const isValid = validPrefixes.some(prefix => lot.id === prefix || lot.id.startsWith(prefix));
            if (!isValid) {
                console.log('🚫 [API] Ignorando lote inválido en export:', lot.id);
            }
            return isValid;
        });
        
        const result = {};
        
        for (const lot of lotes) {
            const pieces = await db.getPiecesInLot(lot.id);
            const metrics = await db.getLotMetrics(lot.id);
            
            result[lot.id] = {
                name: lot.name,
                process: lot.process,
                pieces: pieces,
                laserMetrics: metrics.find(m => m.metric_type === 'laser')?.data || {},
                pavonadoMetrics: metrics.find(m => m.metric_type === 'pavonado')?.data || {},
                metadata: lot.metadata
            };
        }
        
        res.json(result);
    } catch (err) {
        console.error('Error en GET /api/export:', err);
        res.status(500).json({ error: err.message });
    }
});

function buildBackupContext() {
    return {
        db,
        allSql,
        runSql,
        readAllowedGroupsDb,
        readAllowedGroupsFile,
        writeAllowedGroupsDb,
        writeAllowedGroupsFile,
        setAllowedGroups,
        ensureAuthUsersTable
    };
}

app.get('/api/backups', requirePermission('data.export'), async (req, res) => {
    try {
        const backups = listBackupFiles();
        res.json({ ok: true, backupDir: getBackupDir(), backups });
    } catch (err) {
        console.error('Error en GET /api/backups:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/backups', requirePermission('data.export'), async (req, res) => {
    try {
        try { await maybeAutoRecoverLotesFromImages({ verbose: true, reason: 'POST /api/backups' }); } catch (e) { /* noop */ }
        const parsed = backupCreateSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ error: 'Payload invalido' });

        const created = await createBackupFile(buildBackupContext(), parsed.data);
        res.json({
            ok: true,
            backup: {
                fileName: created.fileName,
                filePath: created.filePath,
                size: created.stats.size,
                createdAt: created.stats.mtime.toISOString()
            }
        });
    } catch (err) {
        console.error('Error en POST /api/backups:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/backups/:fileName', requirePermission('data.export'), async (req, res) => {
    try {
        const { filePath } = readBackupFile(String(req.params.fileName || ''));
        res.download(filePath);
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const status = message.includes('no encontrado') ? 404 : 400;
        console.error('Error en GET /api/backups/:fileName:', err);
        res.status(status).json({ error: message });
    }
});

app.post('/api/backups/:fileName/restore', requirePermission('data.import'), async (req, res) => {
    try {
        const parsed = backupRestoreSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ error: 'Payload invalido' });

        const restored = await restoreBackupFile(
            buildBackupContext(),
            String(req.params.fileName || ''),
            parsed.data
        );
        res.json({ ok: true, restored });
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const status = message.includes('no encontrado') ? 404 : 400;
        console.error('Error en POST /api/backups/:fileName/restore:', err);
        res.status(status).json({ error: message });
    }
});

app.post('/api/import', requirePermission('data.import'), async (req, res) => {
    try {
        const parsed = backupImportSchema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ error: 'Payload invalido' });

        const summary = await restoreBackupArtifact(
            buildBackupContext(),
            parsed.data.artifact,
            { restoreAuthUsers: parsed.data.restoreAuthUsers }
        );
        res.json({ ok: true, restored: summary });
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.error('Error en POST /api/import:', err);
        res.status(400).json({ error: message });
    }
});
