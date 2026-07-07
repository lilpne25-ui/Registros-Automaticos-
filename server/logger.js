const fs = require('fs');
const path = require('path');
const util = require('util');
const diagnosticsChannel = require('node:diagnostics_channel');

// Electron 26 embeds Node 18.16, which lacks diagnostics_channel.tracingChannel.
// Pino v10 uses that API opportunistically, so provide a no-op fallback there.
if (typeof diagnosticsChannel.tracingChannel !== 'function') {
  diagnosticsChannel.tracingChannel = function tracingChannelShim() {
    return {
      hasSubscribers: false,
      traceSync(fn, _store, thisArg, ...args) {
        return fn.apply(thisArg, args);
      }
    };
  };
}

const pino = require('pino');

function resolveLogDir(baseDir) {
  const configured = String(process.env.LASER_LOG_DIR || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(baseDir || process.cwd(), 'logs');
}

function createServerLogger(options = {}) {
  const logDir = resolveLogDir(options.baseDir);
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'server.jsonl');
  const destination = pino.destination({
    dest: logFile,
    mkdir: true,
    sync: false
  });
  const logger = pino({
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  }, destination);
  return { logger, logDir, logFile };
}

function installConsoleMirroring(logger) {
  if (!logger || console.__laserMirrorInstalled) return;

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  function mirror(level, method, args) {
    original[method](...args);
    try {
      const message = util.formatWithOptions({ colors: false, depth: 6 }, ...args);
      logger[level]({ source: 'console' }, message);
    } catch (error) {
      original.error('logger mirror error', error && error.message ? error.message : error);
    }
  }

  console.log = (...args) => mirror('info', 'log', args);
  console.info = (...args) => mirror('info', 'info', args);
  console.warn = (...args) => mirror('warn', 'warn', args);
  console.error = (...args) => mirror('error', 'error', args);
  console.__laserMirrorInstalled = true;
}

module.exports = {
  createServerLogger,
  installConsoleMirroring
};
