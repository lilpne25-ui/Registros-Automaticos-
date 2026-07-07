#!/usr/bin/env node
/**
 * Script para ejecutar LaserControl en desarrollo
 * Electron ahora arranca el servidor internamente
 * 
 * Uso: node start-laser-control.js
 */

const { spawn } = require('child_process');
const path = require('path');

const desktopDir = path.join(path.resolve(__dirname), 'desktop');

let electronProcess = null;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function main() {
  log('🚀 LaserControl Control Panel - Desarrollo\n');

  // Electron arranca el servidor interno
  log('1️⃣  Arrancando interfaz Electron...');
  electronProcess = spawn('npx', ['electron', '.'], {
    cwd: desktopDir,
    stdio: 'inherit'
  });

  electronProcess.on('error', (err) => {
    log(`✗ Error en Electron: ${err.message}`);
  });

  electronProcess.on('exit', (code) => {
    log('ℹ Interfaz cerrada');
    process.exit(code || 0);
  });

  // Manejo de cierre
  process.on('SIGINT', () => {
    log('\n🛑 Cerrando aplicación...');
    if (electronProcess && !electronProcess.killed) electronProcess.kill();
    process.exit(0);
  });

  log('\n✅ LaserControl iniciado\n');
}

main().catch(err => {
  log(`ERROR: ${err.message}`);
  process.exit(1);
});
