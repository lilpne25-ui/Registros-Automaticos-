const { app, BrowserWindow, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

let mainWindow = null;
let serverProcess = null;
let appQuitting = false;

const SERVER_PORT = Number(process.env.PORT || 3000);
const SERVER_HOST = '127.0.0.1';
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_POLL_INTERVAL_MS = 500;
const SERVER_START_TIMEOUT_MS = 60000;
const SHOW_RETRY_INTERVAL_MS = 1000;
const SHOW_RETRY_MAX = 10;

const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const FORCED_USER_DATA = path.join(LOCAL_APPDATA, 'LaserControl');
const FORCED_CACHE_DIR = path.join(FORCED_USER_DATA, 'Cache');

try {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
} catch (e) { /* noop */ }

try {
  fs.mkdirSync(FORCED_USER_DATA, { recursive: true });
  fs.mkdirSync(FORCED_CACHE_DIR, { recursive: true });
  app.setPath('userData', FORCED_USER_DATA);
  app.setPath('cache', FORCED_CACHE_DIR);
  app.commandLine.appendSwitch('user-data-dir', FORCED_USER_DATA);
  app.commandLine.appendSwitch('disk-cache-dir', FORCED_CACHE_DIR);
} catch (e) { /* noop */ }

try {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
} catch (e) { /* noop */ }

const FALLBACK_LOG_PATH = path.join(os.tmpdir(), 'lasercontrol.log');
let logPathCache = null;

const EXE_DIR = (() => {
  try {
    return path.dirname(process.execPath || '');
  } catch (e) {
    return process.cwd();
  }
})();

const BOOT_LOG_PATH = path.join(EXE_DIR, 'lasercontrol-boot.log');

try {
  const bootLine = `[${new Date().toISOString()}] boot-preload${os.EOL}`;
  fs.appendFileSync(BOOT_LOG_PATH, bootLine, 'utf8');
} catch (e) { /* noop */ }

function getCandidateLogPaths() {
  const out = [];
  try {
    if (EXE_DIR) out.push(path.join(EXE_DIR, 'lasercontrol.log'));
  } catch (e) { /* noop */ }
  try {
    const dir = app.getPath('userData');
    if (dir) out.push(path.join(dir, 'lasercontrol.log'));
  } catch (e) { /* noop */ }
  try {
    const home = os.homedir && os.homedir();
    if (home) {
      out.push(path.join(home, 'lasercontrol.log'));
      out.push(path.join(home, 'Desktop', 'lasercontrol.log'));
      out.push(path.join(home, 'Documents', 'lasercontrol.log'));
    }
  } catch (e) { /* noop */ }
  try {
    out.push(path.join('C:\\Users\\Public', 'lasercontrol.log'));
  } catch (e) { /* noop */ }
  out.push(FALLBACK_LOG_PATH);
  return out;
}

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}${os.EOL}`;
    const candidates = logPathCache ? [logPathCache] : getCandidateLogPaths();
    for (const p of candidates) {
      try {
        const dir = path.dirname(p);
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(p, line, 'utf8');
        logPathCache = p;
        return;
      } catch (e) { /* try next */ }
    }
  } catch (e) { /* noop */ }
}

log('boot');

try {
  if (EXE_DIR) shell.openPath(EXE_DIR);
} catch (e) { /* noop */ }

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err && err.message ? err.message : String(err)}`);
});

process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason && reason.message ? reason.message : String(reason)}`);
});

// Evitar múltiples instancias
const gotLock = app.requestSingleInstanceLock && app.requestSingleInstanceLock();
if (!gotLock) {
  try { app.quit(); } catch (e) { process.exit(0); }
}

app.on('second-instance', (event, argv, workingDirectory) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  try {
    if (mainWindow.isMinimized && mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => { try { mainWindow.setAlwaysOnTop(false); } catch (e) {} }, 800);
  } catch (e) { console.warn('second-instance focus error', e); }
});

function showWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(false);
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
    if (typeof win.center === 'function') win.center();
    win.show();
    if (typeof win.moveTop === 'function') win.moveTop();
    try { app.focus({ steal: true }); } catch (e) { /* noop */ }
    win.focus();
    win.setAlwaysOnTop(true, 'screen-saver');
    setTimeout(() => { try { win.setAlwaysOnTop(false); } catch (e) {} }, 1500);
  } catch (e) { console.warn('showWindow error', e); }
}

function getCenteredBounds({ width, height }) {
  try {
    const display = screen.getPrimaryDisplay();
    const work = display.workArea || display.bounds;
    const w = Math.min(width, work.width);
    const h = Math.min(height, work.height);
    const x = Math.max(work.x, work.x + Math.floor((work.width - w) / 2));
    const y = Math.max(work.y, work.y + Math.floor((work.height - h) / 2));
    return { x, y, width: w, height: h };
  } catch (e) {
    return null;
  }
}

function getServerPaths() {
  const appRoot = app.getAppPath();
  if (!app.isPackaged) {
    const serverRoot = path.resolve(appRoot, '..');
    return { appRoot, serverRoot, serverScript: path.join(serverRoot, 'server.js') };
  }

  const resourcesRoot = process.resourcesPath || path.resolve(appRoot, '..');
  const candidates = [
    path.join(resourcesRoot, 'server'),
    path.join(resourcesRoot, 'app', 'server'),
    appRoot,
    path.resolve(appRoot, '..')
  ];

  for (const root of candidates) {
    try {
      const script = path.join(root, 'server.js');
      if (fs.existsSync(script)) return { appRoot, serverRoot: root, serverScript: script };
    } catch (e) { /* noop */ }
  }

  const serverRoot = appRoot;
  return { appRoot, serverRoot, serverScript: path.join(serverRoot, 'server.js') };
}

function findChromeExecutablePath() {
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

function resolveDbPath(userDataDir) {
  const envDb = String(process.env.LASER_DB_PATH || '').trim();
  if (envDb) return envDb;

  const userDb = path.join(userDataDir, 'laser_engraving.db');
  const exeDb = path.join(EXE_DIR, 'laser_engraving.db');

  if (!fs.existsSync(userDb) && fs.existsSync(exeDb)) {
    try {
      fs.copyFileSync(exeDb, userDb);
      log(`DB copiada desde EXE: ${exeDb}`);
    } catch (e) {
      log(`DB copy failed: ${e && e.message ? e.message : String(e)}`);
    }
  }

  return userDb;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildStatusPage(title, message) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 32px; }
      .panel { max-width: 560px; width: 100%; background: #111827; border: 1px solid #1f2937; border-radius: 14px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.35); }
      h1 { margin: 0 0 12px 0; font-size: 20px; color: #f8fafc; }
      p { margin: 0; line-height: 1.5; color: #cbd5f5; }
      .muted { margin-top: 14px; font-size: 12px; color: #94a3b8; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="panel">
        <h1>${safeTitle}</h1>
        <p>${safeMessage}</p>
        <div class="muted">Si el problema persiste, cierra y abre la app.</div>
      </div>
    </div>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function buildLoadingPage() {
  return buildStatusPage('Iniciando Laser Control', 'Preparando el servidor local...');
}

function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function buildRuntimeEnvFile(templateText) {
  const adminUser = 'admin';
  const adminPassword = randomSecret(18);
  const authSecret = randomSecret(32);
  const resetPassword = randomSecret(18);
  const baseTemplate = templateText && String(templateText).trim()
    ? String(templateText)
    : [
        '# Laser Control runtime config',
        'AUTH_ENABLED=true',
        'AUTH_REQUIRE_PASSWORD=true',
        `AUTH_ADMIN_USER=${adminUser}`,
        'AUTH_ADMIN_PASSWORD=__GENERATE_ADMIN_PASSWORD__',
        'AUTH_SECRET=__GENERATE_AUTH_SECRET__',
        'RESET_PASSWORD=__GENERATE_RESET_PASSWORD__',
        'WRITE_TO_ENGRAVE_FILES=false'
      ].join(os.EOL);

  const content = baseTemplate
    .replace(/__GENERATE_ADMIN_PASSWORD__/g, adminPassword)
    .replace(/__GENERATE_AUTH_SECRET__/g, authSecret)
    .replace(/__GENERATE_RESET_PASSWORD__/g, resetPassword);

  return {
    content,
    credentials: {
      adminUser,
      adminPassword,
      resetPassword
    }
  };
}

function ensureRuntimeEnvFile(serverRoot, userDataDir) {
  const envDst = path.join(userDataDir, 'server.env');
  const credsDst = path.join(userDataDir, 'server-credentials.txt');
  if (fs.existsSync(envDst)) return envDst;

  const templateCandidates = [
    path.join(serverRoot, 'server.env.example'),
    path.join(serverRoot, '.env.example'),
    path.join(serverRoot, '.env')
  ];

  let templateText = '';
  for (const candidate of templateCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        templateText = fs.readFileSync(candidate, 'utf8');
        log(`Config template found: ${candidate}`);
        break;
      }
    } catch (e) { /* noop */ }
  }

  const runtime = buildRuntimeEnvFile(templateText);
  fs.writeFileSync(envDst, runtime.content, 'utf8');

  const credentialsText = [
    'Laser Control - credenciales iniciales',
    `Archivo de configuracion: ${envDst}`,
    `Usuario admin: ${runtime.credentials.adminUser}`,
    `Contrasena admin: ${runtime.credentials.adminPassword}`,
    `Contrasena reset: ${runtime.credentials.resetPassword}`,
    'Cambia estas credenciales en server.env despues del primer inicio.'
  ].join(os.EOL);
  fs.writeFileSync(credsDst, credentialsText, 'utf8');

  log(`Runtime env created: ${envDst}`);
  log(`Credentials note created: ${credsDst}`);
  return envDst;
}

function startServerProcess() {
  if (serverProcess) return { ok: true };

  const { serverRoot, serverScript } = getServerPaths();
  if (!fs.existsSync(serverScript)) {
    log(`ERROR: server.js no encontrado: ${serverScript}`);
    return { ok: false, error: `No se encontro server.js en: ${serverScript}` };
  }

  const userDataDir = app.getPath('userData');
  log(`Server root: ${serverRoot}`);
  log(`Server script: ${serverScript}`);
  log(`User data: ${userDataDir}`);
  let runtimeEnvPath = '';
  try {
    runtimeEnvPath = ensureRuntimeEnvFile(serverRoot, userDataDir);
  } catch (e) {
    log(`Runtime env setup failed: ${e && e.message ? e.message : String(e)}`);
  }
  const puppeteerCacheDir = path.join(userDataDir, 'puppeteer-cache');
  const puppeteerTmpDir = path.join(userDataDir, 'puppeteer-tmp');
  const puppeteerDownloadDir = path.join(userDataDir, 'puppeteer-browser');
  try { fs.mkdirSync(puppeteerCacheDir, { recursive: true }); } catch (e) { /* noop */ }
  try { fs.mkdirSync(puppeteerTmpDir, { recursive: true }); } catch (e) { /* noop */ }
  try { fs.mkdirSync(puppeteerDownloadDir, { recursive: true }); } catch (e) { /* noop */ }

  const chromePath = findChromeExecutablePath();
  if (chromePath) log(`Chrome detected: ${chromePath}`);

  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    HOST: SERVER_HOST,
    LASER_DB_PATH: resolveDbPath(userDataDir),
    LASER_BACKUP_DIR: path.join(userDataDir, 'backups'),
    LASER_LOG_DIR: path.join(userDataDir, 'logs'),
    ALLOWED_GROUPS_FILE: path.join(userDataDir, 'allowed_groups.json'),
    TO_ENGRAVE_DIR: path.join(userDataDir, 'to_engrave'),
    ELECTRON_RUN_AS_NODE: '1',
    LASERCONTROL_ENV_PATH: runtimeEnvPath,
    PUPPETEER_CACHE_DIR: puppeteerCacheDir,
    PUPPETEER_TMP_DIR: puppeteerTmpDir,
    PUPPETEER_DOWNLOAD_PATH: puppeteerDownloadDir,
    CHROME_PATH: chromePath || '',
    PUPPETEER_EXECUTABLE_PATH: chromePath || ''
  };

  log(`Server env: ELECTRON_RUN_AS_NODE=1 LASERCONTROL_ENV_PATH=${runtimeEnvPath} PUPPETEER_CACHE_DIR=${puppeteerCacheDir}`);

  serverProcess = spawn(process.execPath, [serverScript], {
    cwd: userDataDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (data) => {
    try { process.stdout.write(`[server] ${data}`); } catch (e) { /* noop */ }
    try { log(`[server] ${String(data).trim()}`); } catch (e) { /* noop */ }
  });
  serverProcess.stderr.on('data', (data) => {
    try { process.stderr.write(`[server] ${data}`); } catch (e) { /* noop */ }
    try { log(`[server:err] ${String(data).trim()}`); } catch (e) { /* noop */ }
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    log(`Server exit code=${code || 0} signal=${signal || ''}`);
    if (appQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      const msg = `El servidor se detuvo (codigo ${code || 0}${signal ? `, ${signal}` : ''}).`;
      mainWindow.loadURL(buildStatusPage('Servidor detenido', msg));
    }
  });

  serverProcess.on('error', (err) => {
    serverProcess = null;
    log(`Server error: ${err && err.message ? err.message : String(err)}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(buildStatusPage('Error al iniciar servidor', err.message || String(err)));
    }
  });

  return { ok: true };
}

function stopServerProcess() {
  if (!serverProcess) return;
  try { serverProcess.kill('SIGTERM'); } catch (e) { /* noop */ }
  setTimeout(() => {
    try { if (serverProcess) serverProcess.kill(); } catch (e) { /* noop */ }
  }, 3000);
}

function waitForServerReady(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const deadline = Date.now() + timeoutMs;

    const ping = () => {
      if (settled) return;
      const req = http.get(`${url}/healthz`, (res) => {
        res.resume();
        if (res.statusCode) {
          settled = true;
          return resolve(true);
        }
        if (Date.now() >= deadline) {
          settled = true;
          return resolve(false);
        }
        setTimeout(ping, SERVER_POLL_INTERVAL_MS);
      });

      req.on('error', () => {
        if (Date.now() >= deadline) {
          settled = true;
          return resolve(false);
        }
        setTimeout(ping, SERVER_POLL_INTERVAL_MS);
      });

      req.setTimeout(2000, () => {
        try { req.destroy(); } catch (e) { /* noop */ }
      });
    };

    ping();
  });
}

async function createWindow() {
  log('createWindow: start');
  const initialBounds = getCenteredBounds({ width: 1280, height: 780 });
  const win = new BrowserWindow({
    width: initialBounds ? initialBounds.width : 1280,
    height: initialBounds ? initialBounds.height : 780,
    x: initialBounds ? initialBounds.x : undefined,
    y: initialBounds ? initialBounds.y : undefined,
    resizable: true,
    minWidth: 900,
    minHeight: 600,
    center: true,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow = win;
  log('createWindow: window created');
  win.once('ready-to-show', () => showWindow(win));
  win.webContents.on('did-finish-load', () => showWindow(win));
  win.webContents.on('render-process-gone', (event, details) => {
    log(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  win.on('unresponsive', () => log('window unresponsive'));
  win.on('closed', () => log('window closed'));

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    try {
      if (!isMainFrame) return;
      if (String(validatedURL || '').startsWith('data:')) return;
      const msg = `No se pudo cargar la UI (${errorDescription || errorCode}).`;
      win.loadURL(buildStatusPage('Error de carga', msg));
    } catch (e) {
      console.warn('did-fail-load handler error', e);
    }
  });

  try {
    await win.loadURL(buildLoadingPage());
  } catch (e) {
    log(`loadURL loading page failed: ${e && e.message ? e.message : String(e)}`);
  }
  log('createWindow: loading page loaded');
  showWindow(win);
  if (initialBounds) {
    try { win.setBounds(initialBounds); } catch (e) { /* noop */ }
  }
  let showAttempts = 0;
  const showTimer = setInterval(() => {
    showAttempts += 1;
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(showTimer);
      return;
    }
    showWindow(mainWindow);
    if (showAttempts >= SHOW_RETRY_MAX) clearInterval(showTimer);
  }, SHOW_RETRY_INTERVAL_MS);

  const started = startServerProcess();
  if (!started.ok) {
    log(`createWindow: server start failed: ${started.error || 'unknown'}`);
    await win.loadURL(buildStatusPage('Error de inicio', started.error || 'No se pudo iniciar el servidor.'));
    return;
  }

  const ready = await waitForServerReady(SERVER_URL, SERVER_START_TIMEOUT_MS);
  if (!ready) {
    log('createWindow: server not ready within timeout');
    try {
      await win.loadURL(buildStatusPage('Servidor iniciando', 'El servidor esta tardando en arrancar. Reintentando...'));
    } catch (e) {
      log(`loadURL status failed: ${e && e.message ? e.message : String(e)}`);
    }
    const retryReady = async () => {
      if (appQuitting || !mainWindow || mainWindow.isDestroyed()) return;
      const ok = await waitForServerReady(SERVER_URL, 5000);
      if (ok) {
        log('createWindow: server ready after retry');
        try {
          await mainWindow.loadURL(SERVER_URL);
          showWindow(mainWindow);
        } catch (e) {
          log(`loadURL ui failed after retry: ${e && e.message ? e.message : String(e)}`);
        }
        return;
      }
      setTimeout(retryReady, 2000);
    };
    setTimeout(retryReady, 2000);
    return;
  }

  log('createWindow: server ready, loading UI');
  try {
    await win.loadURL(SERVER_URL);
  } catch (e) {
    log(`loadURL ui failed: ${e && e.message ? e.message : String(e)}`);
    try {
      await win.loadURL(buildStatusPage('Error de carga', 'No se pudo abrir la UI local.'));
    } catch (e2) { /* noop */ }
  }
  showWindow(win);
  if (!app.isPackaged) win.webContents.openDevTools();
}

app.whenReady().then(() => {
  log(`app ready (packaged=${app.isPackaged}) name=${app.getName()} userData=${app.getPath('userData')}`);
  try { app.on('gpu-process-crashed', (event, killed) => log(`gpu-process-crashed killed=${killed}`)); } catch (e) { /* noop */ }
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  log('before-quit');
  appQuitting = true;
  stopServerProcess();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
