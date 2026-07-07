#!/usr/bin/env node
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const desktopDir = __dirname;
const runtimeDir = path.join(desktopDir, 'server-runtime');

const runtimeFiles = [
  'server.js',
  'db.js',
  'db_mssql.js',
  'package-lock.json',
  'server.env.example',
  'allowed_groups.example.json'
];

const runtimeDirs = [
  'public',
  'scripts',
  'server'
];

function buildRuntimePackageJson() {
  const rootPackage = fs.readJsonSync(path.join(projectRoot, 'package.json'));
  return {
    name: rootPackage.name,
    version: rootPackage.version,
    private: true,
    main: 'server.js',
    dependencies: rootPackage.dependencies || {}
  };
}

function copyOptionalFile(relativePath) {
  const src = path.join(projectRoot, relativePath);
  if (!fs.existsSync(src)) return false;
  const dst = path.join(runtimeDir, relativePath);
  fs.ensureDirSync(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

function copyRuntimeDirs() {
  for (const relativePath of runtimeDirs) {
    const src = path.join(projectRoot, relativePath);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(runtimeDir, relativePath);
    fs.removeSync(dst);
    fs.copySync(src, dst);
  }
}

function installProductionDependencies() {
  const env = {
    ...process.env,
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false'
  };

  execSync('npm ci --omit=dev --no-audit --no-fund', {
    cwd: runtimeDir,
    env,
    stdio: 'inherit'
  });
}

function validateRuntime() {
  const checks = [
    'server.js',
    'package.json',
    'node_modules/express',
    'node_modules/sqlite3',
    'server/logger.js',
    'server/routes/auth-admin.js',
    'server/routes/whatsapp-status.js',
    'server/routes/snapshots.js'
  ];

  for (const relativePath of checks) {
    const absolutePath = path.join(runtimeDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Falta artefacto de runtime: ${relativePath}`);
    }
  }
}

function prepareServerRuntime() {
  console.log('📦 Preparando runtime mínimo de servidor...');
  fs.removeSync(runtimeDir);
  fs.ensureDirSync(runtimeDir);

  fs.writeJsonSync(
    path.join(runtimeDir, 'package.json'),
    buildRuntimePackageJson(),
    { spaces: 2 }
  );

  for (const relativePath of runtimeFiles) {
    copyOptionalFile(relativePath);
  }

  copyRuntimeDirs();
  installProductionDependencies();
  validateRuntime();
  console.log(`✅ Runtime listo: ${runtimeDir}`);
  return runtimeDir;
}

if (require.main === module) {
  try {
    prepareServerRuntime();
  } catch (error) {
    console.error('❌ No se pudo preparar server-runtime:', error.message);
    process.exit(1);
  }
}

module.exports = {
  prepareServerRuntime,
  runtimeDir
};
