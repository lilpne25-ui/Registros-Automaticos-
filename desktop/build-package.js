#!/usr/bin/env node
const fs = require('fs-extra');
const path = require('path');
const { prepareServerRuntime, runtimeDir } = require('./build-server-runtime');
const { validateReleaseArtifacts } = require('../scripts/validate_release_artifacts');
const packager = require('electron-packager');

const projectRoot = path.resolve(__dirname, '..');
const desktopDir = __dirname;
const distDir = path.resolve(projectRoot, 'dist');
const packagedAppDir = path.resolve(distDir, 'LaserControl-win32-x64');
const packagedRuntimeDir = path.resolve(packagedAppDir, 'resources', 'server');
const duplicateRuntimeDirs = [
  path.resolve(packagedAppDir, 'resources', 'app', 'server'),
  path.resolve(packagedAppDir, 'resources', 'app', 'server-runtime')
];

const iconPng = path.join(desktopDir, 'icon.png');
const iconIco = path.join(desktopDir, 'icon.ico');

function buildIcoFromPng(pngPath, icoPath) {
  const data = fs.readFileSync(pngPath);
  if (!data || data.length < 24) throw new Error('PNG invalido');

  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const w = width >= 256 ? 0 : width;
  const h = height >= 256 ? 0 : height;

  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(w, 6);
  header.writeUInt8(h, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(data.length, 14);
  header.writeUInt32LE(22, 18);

  fs.writeFileSync(icoPath, Buffer.concat([header, data]));
  return icoPath;
}

function ensureIconPath() {
  try {
    if (fs.existsSync(iconPng)) return buildIcoFromPng(iconPng, iconIco);
  } catch (error) {
    console.warn('No se pudo crear icon.ico:', error.message);
  }

  return fs.existsSync(iconIco) ? iconIco : null;
}

function validateEnvironment() {
  if (!fs.existsSync(path.join(projectRoot, 'server.js'))) {
    throw new Error('server.js no encontrado en la raiz del proyecto');
  }

  if (!fs.existsSync(path.join(desktopDir, 'node_modules'))) {
    throw new Error('desktop/node_modules no encontrado. Ejecuta npm install en desktop/');
  }
}

function cleanDist() {
  fs.removeSync(distDir);
  fs.ensureDirSync(distDir);
}

async function packageApp() {
  console.log('Empaquetando Electron...');
  const iconPath = ensureIconPath();
  await packager({
    dir: desktopDir,
    name: 'LaserControl',
    platform: 'win32',
    arch: 'x64',
    out: distDir,
    overwrite: true,
    icon: iconPath || undefined,
    ignore: [
      /^\/server-runtime($|\/)/,
      /^\/dist($|\/)/
    ],
    quiet: false
  });
}

function copyRuntimeTo(targetDir) {
  fs.removeSync(targetDir);
  fs.ensureDirSync(targetDir);
  fs.copySync(runtimeDir, targetDir, { overwrite: true });

  const critical = ['server.js', 'node_modules/express', 'server/routes/auth-admin.js'];
  for (const relativePath of critical) {
    const absolutePath = path.join(targetDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Falta archivo critico en paquete: ${relativePath}`);
    }
  }
}

function installPackagedRuntime() {
  console.log('Copiando runtime minimo al paquete...');
  copyRuntimeTo(packagedRuntimeDir);
  for (const duplicateDir of duplicateRuntimeDirs) {
    fs.removeSync(duplicateDir);
  }
}

function validatePackagedOutput() {
  validateReleaseArtifacts({
    packageRoot: packagedAppDir,
    requirePackage: true
  });
}

function printSummary() {
  console.log('Empaquetado completado');
  console.log(`EXE: ${path.resolve(packagedAppDir, 'LaserControl.exe')}`);
  console.log(`Runtime: ${packagedRuntimeDir}`);
  console.log('Release limpio: runtime unico en resources/server y sin .env empaquetado.');
}

async function main() {
  validateEnvironment();
  cleanDist();
  prepareServerRuntime();
  await packageApp();
  installPackagedRuntime();
  validatePackagedOutput();
  printSummary();
}

main().catch((error) => {
  console.error('Error de empaquetado:', error.message);
  process.exit(1);
});
