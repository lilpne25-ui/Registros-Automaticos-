/* eslint-disable no-console */

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function runStartup(extraEnv) {
  return spawnSync(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      AUTH_ENABLED: 'true',
      AUTH_REQUIRE_PASSWORD: 'true',
      AUTH_ADMIN_USER: 'admin',
      AUTH_ADMIN_PASSWORD: 'AdminPass123!',
      WRITE_TO_ENGRAVE_FILES: 'false',
      ...extraEnv
    },
    encoding: 'utf8',
    timeout: 15000
  });
}

(() => {
  const invalid = runStartup({
    AUTH_SECRET: '',
    RESET_PASSWORD: ''
  });
  assert.notStrictEqual(invalid.status, 0, 'manual startup without critical secrets must fail');
  assert.match(
    `${invalid.stdout}\n${invalid.stderr}`,
    /Configuracion insegura detectada/i,
    'manual startup should explain missing critical config'
  );

  console.log('startup-config OK');
})();
