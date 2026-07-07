const fs = require('fs');
const vm = require('vm');

const filePath = process.argv[2] || 'public/sistema_de_grabado_laserv1.html';
const html = fs.readFileSync(filePath, 'utf8');

const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
let idx = 0;
let failures = 0;

function analyzeUnclosedDelimiters(code) {
  const stack = [];
  let line = 1;
  let col = 0;
  let state = 'normal';
  let templateBraceDepth = 0;
  let prev = '';

  const push = (ch) => stack.push({ ch, line, col });
  const popMatch = (ch) => {
    const pairs = { '}': '{', ')': '(', ']': '[' };
    const expected = pairs[ch];
    const top = stack[stack.length - 1];
    if (top && top.ch === expected) stack.pop();
  };

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    col++;
    if (ch === '\n') {
      line++;
      col = 0;
      if (state === 'line-comment') state = 'normal';
      prev = ch;
      continue;
    }

    const next = code[i + 1];

    if (state === 'line-comment') {
      prev = ch;
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i++;
        col++;
      }
      prev = ch;
      continue;
    }
    if (state === 'single-quote') {
      if (ch === "'" && prev !== '\\') state = 'normal';
      prev = ch;
      continue;
    }
    if (state === 'double-quote') {
      if (ch === '"' && prev !== '\\') state = 'normal';
      prev = ch;
      continue;
    }
    if (state === 'template') {
      if (ch === '`' && prev !== '\\' && templateBraceDepth === 0) {
        state = 'normal';
        prev = ch;
        continue;
      }
      if (ch === '$' && next === '{' && prev !== '\\') {
        templateBraceDepth++;
        push('{');
        i++;
        col++;
        prev = '{';
        continue;
      }
      // dentro de template, solo procesamos cierres de ${...}
      if (ch === '}' && templateBraceDepth > 0) {
        templateBraceDepth--;
        popMatch('}');
        prev = ch;
        continue;
      }
      prev = ch;
      continue;
    }

    // normal
    if (ch === '/' && next === '/') {
      state = 'line-comment';
      i++;
      col++;
      prev = '/';
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      i++;
      col++;
      prev = '*';
      continue;
    }
    if (ch === "'") {
      state = 'single-quote';
      prev = ch;
      continue;
    }
    if (ch === '"') {
      state = 'double-quote';
      prev = ch;
      continue;
    }
    if (ch === '`') {
      state = 'template';
      templateBraceDepth = 0;
      prev = ch;
      continue;
    }

    if (ch === '{' || ch === '(' || ch === '[') push(ch);
    if (ch === '}' || ch === ')' || ch === ']') popMatch(ch);

    prev = ch;
  }

  return { stack, endState: state, endLine: line, endCol: col };
}

function countLines(s) {
  // counts \n; line numbers are 1-based
  let c = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) c++;
  return c;
}

while ((m = scriptTagRe.exec(html)) !== null) {
  idx++;
  const attrs = m[1] || '';
  const code = m[2] || '';

  // Skip external scripts
  if (/\bsrc\s*=\s*/i.test(attrs)) continue;

  // Ignore empty inline scripts
  if (!code.trim()) continue;

  // Calculate HTML line offset for this script content
  const before = html.slice(0, m.index);
  const tagAndNewline = html.slice(m.index, scriptTagRe.lastIndex - code.length);
  const startLine = countLines(before + tagAndNewline);

  try {
    new vm.Script(code, { filename: `${filePath}::inline-script#${idx}` });
  } catch (e) {
    failures++;
    const msg = (e && e.stack) ? e.stack : String(e);
    console.error(`\n❌ Syntax error in inline script #${idx} starting at HTML line ${startLine}`);
    console.error(msg);

    // En errores de fin inesperado, intentar inferir qué delimitador quedó abierto
    if (e && /Unexpected end of input/i.test(String(e.message))) {
      const a = analyzeUnclosedDelimiters(code);
      if (a.stack.length) {
        const tail = a.stack.slice(-10);
        console.error('🔎 Delimitadores abiertos (últimos 10):');
        tail.forEach((t) => {
          console.error(`  - '${t.ch}' abierto en script line ${t.line}, col ${t.col} (HTML aprox line ${startLine + t.line - 1})`);
        });
      } else {
        console.error(`🔎 No se detectaron delimitadores abiertos. Estado final: ${a.endState} en line ${a.endLine}, col ${a.endCol}`);
      }
    }
  }
}

if (failures === 0) {
  console.log('✅ All inline scripts parsed successfully');
  process.exit(0);
} else {
  console.error(`\nFound ${failures} inline script(s) with syntax errors.`);
  process.exit(1);
}
