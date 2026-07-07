/* eslint-disable no-console */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (e) {
      // retry
    }
    await sleep(250);
  }
  return false;
}

async function requestJson(url, { method = 'GET', body, cookie, expectedStatus } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (expectedStatus !== undefined) {
    assert.strictEqual(res.status, expectedStatus, `Expected ${expectedStatus} for ${method} ${url}, got ${res.status}`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  return { res, data };
}

async function runIntegrationCase({ requirePassword, loginBody }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `laser-control-int-${requirePassword ? 'pw' : 'nopw'}-`));
  const dbPath = path.join(tempRoot, 'integration.db');
  const envPath = path.join(tempRoot, 'integration.env');
  const port = requirePassword ? 3217 : 3218;
  const adminUser = 'admin';
  const adminPassword = 'CodexPass123!';
  const resetPassword = 'ResetPass123!';

  fs.writeFileSync(envPath, [
    `PORT=${port}`,
    'HOST=127.0.0.1',
    'AUTH_ENABLED=true',
    `AUTH_REQUIRE_PASSWORD=${requirePassword ? 'true' : 'false'}`,
    `AUTH_ADMIN_USER=${adminUser}`,
    `AUTH_ADMIN_PASSWORD=${adminPassword}`,
    'AUTH_SECRET=integration-secret-key',
    `RESET_PASSWORD=${resetPassword}`,
    `LASER_DB_PATH=${dbPath}`,
    `LASER_BACKUP_DIR=${path.join(tempRoot, 'backups')}`,
    `TO_ENGRAVE_DIR=${path.join(tempRoot, 'to_engrave')}`,
    'WRITE_TO_ENGRAVE_FILES=false'
  ].join('\n'));

  process.env.LASERCONTROL_ENV_PATH = envPath;

  const { startServer, stopServer } = require('../server');

  let serverStarted = false;
  try {
    await startServer();
    serverStarted = true;

    const healthy = await waitFor(`http://127.0.0.1:${port}/healthz`);
    assert.ok(healthy, 'healthz should become available');

    const health = await requestJson(`http://127.0.0.1:${port}/healthz`, { expectedStatus: 200 });
    assert.strictEqual(health.data.ok, true, 'healthz should report ok');
    assert.strictEqual(health.data.auth.requirePassword, requirePassword, 'healthz should expose requirePassword');

    await requestJson(`http://127.0.0.1:${port}/status`, { expectedStatus: 401 });

    const login = await requestJson(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      body: loginBody({ adminUser, adminPassword }),
      expectedStatus: 200
    });
    assert.ok(login.data && login.data.ok, 'login should return ok');

    const setCookie = login.res.headers.get('set-cookie');
    assert.ok(setCookie, 'login should set cookie');
    const cookie = setCookie.split(';')[0];

    const status = await requestJson(`http://127.0.0.1:${port}/status`, {
      cookie,
      expectedStatus: 200
    });
    assert.strictEqual(status.data.auth.enabled, true, 'status should expose auth enabled');
    assert.strictEqual(status.data.auth.requirePassword, requirePassword, 'status should expose auth mode');

    await requestJson(`http://127.0.0.1:${port}/qr`, {
      cookie,
      expectedStatus: 200
    });

    await requestJson(`http://127.0.0.1:${port}/api/whatsapp/groups`, {
      cookie,
      expectedStatus: 200
    });

    await requestJson(`http://127.0.0.1:${port}/api/whatsapp/logs`, {
      cookie,
      expectedStatus: 200
    });

    await requestJson(`http://127.0.0.1:${port}/api/whatsapp/restart`, {
      method: 'POST',
      cookie,
      body: { killLockedBrowser: 'invalid' },
      expectedStatus: 400
    });

    const enqueue = await requestJson(`http://127.0.0.1:${port}/enqueue`, {
      method: 'POST',
      cookie,
      body: { numParte: 'INT-001', numPiezas: 5, messageId: `test-${Date.now()}` },
      expectedStatus: 200
    });
    assert.ok(enqueue.data && enqueue.data.ok, 'enqueue should return ok');

    const pieces = await requestJson(`http://127.0.0.1:${port}/api/lotes/lotes/pieces`, {
      cookie,
      expectedStatus: 200
    });
    assert.ok(Array.isArray(pieces.data), 'pieces endpoint should return array');
    assert.ok(pieces.data.some((item) => item.partNumber === 'INT-001'), 'enqueued piece should exist');

    const snapshot = await requestJson(`http://127.0.0.1:${port}/api/monthly-snapshots`, {
      method: 'POST',
      cookie,
      body: { label: 'Snapshot Integracion', reportType: 'all' },
      expectedStatus: 200
    });
    assert.ok(snapshot.data && snapshot.data.snapshot, 'snapshot create should return snapshot');

    const list = await requestJson(`http://127.0.0.1:${port}/api/monthly-snapshots`, {
      cookie,
      expectedStatus: 200
    });
    assert.ok(Array.isArray(list.data.snapshots), 'snapshot list should return array');
    assert.ok(list.data.snapshots.some((item) => item.label === 'Snapshot Integracion'), 'snapshot list should include created snapshot');

    const createdBackup = await requestJson(`http://127.0.0.1:${port}/api/backups`, {
      method: 'POST',
      cookie,
      body: { label: 'integracion' },
      expectedStatus: 200
    });
    assert.ok(createdBackup.data && createdBackup.data.backup && createdBackup.data.backup.fileName, 'backup create should return fileName');
    const backupFileName = createdBackup.data.backup.fileName;

    const backupList = await requestJson(`http://127.0.0.1:${port}/api/backups`, {
      cookie,
      expectedStatus: 200
    });
    assert.ok(Array.isArray(backupList.data.backups), 'backup list should return array');
    assert.ok(backupList.data.backups.some((item) => item.fileName === backupFileName), 'backup list should include created backup');

    await requestJson(`http://127.0.0.1:${port}/enqueue`, {
      method: 'POST',
      cookie,
      body: { numParte: 'INT-RESTORE', numPiezas: 2, messageId: `restore-${Date.now()}` },
      expectedStatus: 200
    });

    const piecesBeforeRestore = await requestJson(`http://127.0.0.1:${port}/api/lotes/lotes/pieces`, {
      cookie,
      expectedStatus: 200
    });
    assert.ok(piecesBeforeRestore.data.some((item) => item.partNumber === 'INT-RESTORE'), 'mutated piece should exist before restore');

    const restoredBackup = await requestJson(`http://127.0.0.1:${port}/api/backups/${encodeURIComponent(backupFileName)}/restore`, {
      method: 'POST',
      cookie,
      body: {},
      expectedStatus: 200
    });
    assert.ok(restoredBackup.data && restoredBackup.data.ok, 'backup restore should return ok');

    const piecesAfterRestore = await requestJson(`http://127.0.0.1:${port}/api/lotes/lotes/pieces`, {
      cookie,
      expectedStatus: 200
    });
    assert.ok(piecesAfterRestore.data.some((item) => item.partNumber === 'INT-001'), 'original piece should survive restore');
    assert.ok(!piecesAfterRestore.data.some((item) => item.partNumber === 'INT-RESTORE'), 'mutated piece should be removed by restore');

    console.log(`✅ [Integration] Auth (${requirePassword ? 'user+password' : 'user-only'}), status, WhatsApp admin routes, enqueue y snapshots OK`);
  } finally {
    if (serverStarted) {
      try { await stopServer(); } catch (e) { /* noop */ }
    }
    await sleep(200);
    delete process.env.LASERCONTROL_ENV_PATH;
  }
}

(async () => {
  try {
    await runIntegrationCase({
      requirePassword: false,
      loginBody: ({ adminUser }) => ({ username: adminUser })
    });
  } catch (err) {
    console.error('❌ [Integration] Falló:', err && err.message ? err.message : err);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})();
