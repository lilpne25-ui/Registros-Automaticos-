#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const defaultDistRoot = path.join(projectRoot, 'dist');
const forbiddenNames = new Set([
  '.env',
  'tokens.json',
  'allowed_groups.json',
  'allowed_users.json',
  'laser_engraving.db',
  'laser_grabado.db'
]);
const forbiddenDirs = new Set([
  '.wwebjs_auth',
  '.wwebjs_cache'
]);

function parseArgs(argv) {
  const args = {
    distRoot: defaultDistRoot,
    packageRoot: '',
    requirePackage: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--dist-root') {
      args.distRoot = path.resolve(argv[i + 1] || defaultDistRoot);
      i += 1;
      continue;
    }
    if (current === '--package-root') {
      args.packageRoot = path.resolve(argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (current === '--require-package') {
      args.requirePackage = true;
    }
  }

  return args;
}

function collectPackageRoots(distRoot) {
  if (!fs.existsSync(distRoot)) return [];
  return fs.readdirSync(distRoot)
    .map((entry) => path.join(distRoot, entry))
    .filter((entryPath) => fs.existsSync(path.join(entryPath, 'resources')));
}

function walkFiles(rootDir, visitor) {
  const pending = [rootDir];
  while (pending.length) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(rootDir, absolutePath);
      visitor({ absolutePath, relativePath, entry });
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      }
    }
  }
}

function validatePackageRoot(packageRoot) {
  const issues = [];
  const runtimeRoot = path.join(packageRoot, 'resources', 'server');
  const duplicateRuntimeRoots = [
    path.join(packageRoot, 'resources', 'app', 'server'),
    path.join(packageRoot, 'resources', 'app', 'server-runtime')
  ];

  if (!fs.existsSync(path.join(runtimeRoot, 'server.js'))) {
    issues.push(`Falta runtime en ${path.relative(projectRoot, path.join(runtimeRoot, 'server.js'))}`);
  }

  for (const duplicateRoot of duplicateRuntimeRoots) {
    if (fs.existsSync(duplicateRoot)) {
      issues.push(`Runtime duplicado detectado: ${path.relative(projectRoot, duplicateRoot)}`);
    }
  }

  walkFiles(packageRoot, ({ absolutePath, relativePath, entry }) => {
    const normalized = relativePath.split(path.sep).join('/');
    if (entry.isDirectory() && forbiddenDirs.has(entry.name)) {
      issues.push(`Directorio prohibido en paquete: ${normalized}`);
      return;
    }

    if (!entry.isFile()) return;

    if (forbiddenNames.has(entry.name)) {
      issues.push(`Archivo prohibido en paquete: ${normalized}`);
      return;
    }

    if (entry.name === '.env' || normalized.endsWith('/.env')) {
      issues.push(`Archivo .env prohibido en paquete: ${normalized}`);
    }
  });

  return issues;
}

function validateReleaseArtifacts(options = {}) {
  const packageRoots = options.packageRoot
    ? [options.packageRoot]
    : collectPackageRoots(options.distRoot || defaultDistRoot);

  if (!packageRoots.length) {
    if (options.requirePackage) {
      throw new Error(`No se encontraron paquetes en ${path.relative(projectRoot, options.distRoot || defaultDistRoot)}`);
    }
    return [];
  }

  const failures = [];
  for (const packageRoot of packageRoots) {
    const issues = validatePackageRoot(packageRoot);
    if (issues.length) {
      failures.push({
        packageRoot,
        issues
      });
    }
  }

  if (failures.length) {
    const lines = failures.flatMap(({ packageRoot, issues }) => [
      `Paquete invalido: ${path.relative(projectRoot, packageRoot)}`,
      ...issues.map((issue) => `- ${issue}`)
    ]);
    throw new Error(lines.join('\n'));
  }

  return packageRoots;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const packageRoots = validateReleaseArtifacts(options);
    const summary = packageRoots.map((entry) => path.relative(projectRoot, entry)).join(', ');
    console.log(`Artifacts validados: ${summary}`);
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  validateReleaseArtifacts
};
