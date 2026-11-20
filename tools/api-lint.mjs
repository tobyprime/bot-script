// tools/api-lint.mjs — 包 API lint（契约外调用判死）
//
// 规则来源 contracts/api-surface.yaml（唯一真源）：
//   * 硬错误：任何 __ 前缀标识符（内部桥）、stdlib_deny 里的名字（io/os/debug/load/_G…）
//   * 警告：契约外的全局标识符（Lua 无静态作用域，按「文件内 local 并集」近似判定；
//     用 --strict-api 可把警告升为错误）
//
// 这不是编译器：不做完整作用域分析，只保证「不可能绕过契约」这一类判定是硬错误。
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if',
  'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

export function loadSurface(file = path.join(ROOT, 'contracts', 'api-surface.yaml')) {
  const s = parse(readFileSync(file, 'utf8'));
  return {
    globals: Object.keys(s.globals ?? {}),
    allow: new Set(s.stdlib_allow ?? []),
    deny: new Set(s.stdlib_deny ?? []),
  };
}

/** 去掉注释与字符串字面量（保留换行，便于报行号） */
export function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const longBracket = (at) => {
    const m = /^\[(=*)\[/.exec(src.slice(at, at + 40));
    if (!m) return null;
    return { open: m[0], eq: m[1] };
  };
  while (i < n) {
    const c = src[i];
    // 注释
    if (c === '-' && src[i + 1] === '-') {
      const lb = longBracket(i + 2);
      if (lb) {
        const close = `]${lb.eq}]`;
        const end = src.indexOf(close, i + 2 + lb.open.length);
        const stop = end < 0 ? n : end + close.length;
        out += '""'.padEnd(stop - i, ' ').replace(/\n/g, '\n');
        i = stop;
        continue;
      }
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    // 长字符串
    if (c === '[') {
      const lb = longBracket(i);
      if (lb) {
        const close = `]${lb.eq}]`;
        const end = src.indexOf(close, i + lb.open.length);
        const stop = end < 0 ? n : end + close.length;
        out += '""'.padEnd(stop - i, ' ').replace(/\n/g, '\n');
        i = stop;
        continue;
      }
    }
    // 普通字符串
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) { j++; break; }
        if (src[j] === '\n') break;
        j++;
      }
      out += '"'.padEnd(j - i, ' ').replace(/\n/g, '\n');
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function collectLocals(code, raw = '') {
  const locals = new Set();
  const add = (names) => { for (const x of names) if (x) locals.add(x); };
  // persist.table "Account" / persist.kv "meta" / persist.log "Intent" 会把同名表注入全局
  // （必须从原始源码里找：strip 之后字符串已经变成空白）
  for (const m of raw.matchAll(/\bpersist\.(?:table|kv|log)\s*[("\s]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) add([m[1]]);
  for (const m of code.matchAll(/\blocal\s+([^=\n;]+)/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (nm) add([nm[1]]);
    }
  }
  for (const m of code.matchAll(/\blocal\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/g)) add([m[1]]);
  for (const m of code.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([A-Za-z_][A-Za-z0-9_]*))?\s*(?:in|=)/g)) {
    add([m[1], m[2]]);
  }
  // 函数参数（含方法定义 a:b / a.b）
  for (const m of code.matchAll(/\bfunction\s*(?:[A-Za-z_][A-Za-z0-9_.:]*)?\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (nm) add([nm[1]]);
    }
  }
  return locals;
}

/**
 * @returns {{level:'error'|'warn', file:string, line:number, msg:string}[]}
 */
export function lintSource(src, { file = '<script>', surface = loadSurface(), strict = false, extraGlobals = [] } = {}) {
  const code = stripCommentsAndStrings(src);
  const locals = collectLocals(code, src);
  for (const g of extraGlobals) locals.add(g);
  const problems = [];
  const lines = code.split('\n');
  const apiGlobals = new Set(surface.globals);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const m of line.matchAll(/(?<![.:\w])([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1];
      if (KEYWORDS.has(name)) continue;
      if (locals.has(name)) continue;
      // 行内先出现的 local 声明已在并集里；表字段被 (?<![.\w]) 排除
      if (name.startsWith('__')) {
        problems.push({ level: 'error', file, line: li + 1, msg: `调用了内部桥 ${name}（契约外 API，见 contracts/api-surface.yaml）` });
        continue;
      }
      const isAssignTarget = /^\s*(?:=|,|\})/.test(line.slice(m.index + name.length));
      if (surface.deny.has(name) && !isAssignTarget) {
        problems.push({ level: 'error', file, line: li + 1, msg: `使用被禁止的全局 ${name}（脚本沙箱边界）` });
        continue;
      }
      if (apiGlobals.has(name) || surface.allow.has(name)) continue;
      // 只对「调用/成员访问」报契约外 API；纯赋值目标（脚本自用全局）不报
      const after = line.slice(m.index + name.length);
      if (/^\s*(?:\(|\.|:)\s*/.test(after)) {
        problems.push({
          level: strict ? 'error' : 'warn', file, line: li + 1,
          msg: `契约外的全局调用 ${name}（不在 api-surface.yaml）`,
        });
      }
    }
  }
  return problems;
}

/** 包级：把 persist.table/kv/log 注入的同名全局收成一组（跨文件可见，模块文件要用） */
export function collectPersistGlobals(sources) {
  const out = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/\bpersist\.(?:table|kv|log)\s*[("\s]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) out.add(m[1]);
  }
  return [...out];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { statSync, readdirSync } = await import('node:fs');
  const files = [];
  for (const t of process.argv.slice(2)) {
    if (statSync(t).isDirectory()) {
      for (const f of readdirSync(t)) if (f.endsWith('.lua')) files.push(path.join(t, f));
    } else files.push(t);
  }
  const surface2 = loadSurface();
  const extra = collectPersistGlobals(files.map((f) => readFileSync(f, 'utf8')));
  for (const f of files) {
    for (const p of lintSource(readFileSync(f, 'utf8'), { file: f, surface: surface2, extraGlobals: extra })) {
      console.log(`${p.level.toUpperCase()} ${p.file}:${p.line} ${p.msg}`);
    }
  }
}
