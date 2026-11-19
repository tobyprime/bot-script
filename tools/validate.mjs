// tools/validate.mjs — 包静态校验（schema + Lua 编译 + API lint）
//
// 不连服务器、不执行脚本。用法：
//   node tools/validate.mjs <包目录 | deploy.yaml>
//   node engine/cli.js validate <...>（子进程封装，见 engine/cli.js）
//
// 结果经 stdout 的 __BS_VALIDATE__ 标记行上抛（平台闸门以标记行为准，
// 因为 wasmoon/emscripten 的退出期断言会污染退出码）。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { lintSource, loadSurface, collectPersistGlobals } from './api-lint.mjs';
import { validateDeploy } from '../hosts/node/deploy.js';

const KNOWN_PARAM_TYPES = new Set([
  'string', 'number', 'boolean', 'blockpos', 'region', 'list<blockpos>',
]);
const KNOWN_TOP_KEYS = new Set(['name', 'scripts', 'params', 'persist']);

async function makeLua() {
  const { LuaFactory } = await import('wasmoon');
  // Windows 下 emscripten 对非 file:// 路径误用 fetch：初始化期间屏蔽 fetch 强制走 fs
  const realFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    return await new LuaFactory().createEngine();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function listLua(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isFile() && f.endsWith('.lua')) out.push(p);
  }
  return out;
}

function isBlockpos(v) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
}

/**
 * @returns {{level:'error'|'warn', file?:string, msg:string}[]} 空数组 = 通过
 */
export async function validatePackage(pkgDir, { strictApi = true } = {}) {
  const problems = [];
  const err = (msg, file) => problems.push({ level: 'error', msg, file });
  const warn = (msg, file) => problems.push({ level: 'warn', msg, file });

  const manifestPath = path.join(pkgDir, 'bot.yaml');
  if (!existsSync(manifestPath)) {
    err(`bot.yaml 不存在（${pkgDir} 不是脚本包目录）`);
    return problems;
  }
  let pkg;
  try {
    pkg = parse(readFileSync(manifestPath, 'utf8')) ?? {};
  } catch (e) {
    err(`bot.yaml 解析失败: ${e.message}`, 'bot.yaml');
    return problems;
  }
  if (typeof pkg !== 'object' || Array.isArray(pkg)) {
    err('bot.yaml 顶层必须是映射', 'bot.yaml');
    return problems;
  }

  // 1) 顶层字段 lint（拼写错误防护：引擎对未知键静默忽略）
  for (const k of Object.keys(pkg)) {
    if (!KNOWN_TOP_KEYS.has(k)) warn(`未知顶层字段 "${k}"（引擎会忽略；拼写错误？）`, 'bot.yaml');
  }
  if (pkg.name !== undefined && (typeof pkg.name !== 'string' || !pkg.name.trim())) {
    err('name 必须是非空字符串', 'bot.yaml');
  }

  // 2) scripts：非空字符串数组，逐项存在性
  const scripts = pkg.scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    err('scripts 必须是非空数组（入口 .lua 列表）', 'bot.yaml');
  } else {
    for (const s of scripts) {
      if (typeof s !== 'string' || !s.endsWith('.lua')) {
        err(`scripts 项必须是 .lua 路径: ${JSON.stringify(s)}`, 'bot.yaml');
        continue;
      }
      if (!existsSync(path.join(pkgDir, s))) err(`入口脚本不存在: ${s}`, 'bot.yaml');
    }
  }

  // 3) params：schema 形态 {type,default,...} 或字面量默认值；类型/形状检查
  if (pkg.params !== undefined) {
    if (typeof pkg.params !== 'object' || pkg.params === null || Array.isArray(pkg.params)) {
      err('params 必须是映射', 'bot.yaml');
    } else {
      for (const [k, entry] of Object.entries(pkg.params)) {
        const isSchema = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          && entry.type !== undefined;
        if (!isSchema) continue;   // 字面量默认值形态：任何 JSON 值合法
        const t = entry.type;
        if (typeof t !== 'string' || !KNOWN_PARAM_TYPES.has(t)) {
          warn(`参数 "${k}" 类型 "${t}" 不在已知集合（${[...KNOWN_PARAM_TYPES].join('/')}）；引擎将按原值透传`, 'bot.yaml');
          continue;
        }
        if (entry.default === undefined) continue;
        const d = entry.default;
        const shapeOk = t === 'blockpos' ? isBlockpos(d)
          : t === 'region' ? Array.isArray(d) && d.length === 2 && d.every(isBlockpos)
          : t === 'list<blockpos>' ? Array.isArray(d) && d.every(isBlockpos)
          : true;
        if (!shapeOk) err(`参数 "${k}" 默认值与类型 ${t} 形状不符: ${JSON.stringify(d)}`, 'bot.yaml');
      }
    }
  }

  // 4) persist：可选，字符串路径
  if (pkg.persist !== undefined && typeof pkg.persist !== 'string') {
    err('persist 必须是字符串路径（或省略）', 'bot.yaml');
  }

  // 5) 目录内全部 .lua：API lint + Lua 编译（入口 + require 模块；load 只编译不执行）
  const luaFiles = listLua(pkgDir);
  if (luaFiles.length === 0) warn('包目录没有任何 .lua 文件');
  const surface = loadSurface();
  const extraGlobals = collectPersistGlobals(luaFiles.map((f) => readFileSync(f, 'utf8')));
  for (const f of luaFiles) {
    const rel = path.relative(pkgDir, f);
    for (const p of lintSource(readFileSync(f, 'utf8'), { file: rel, surface, strict: strictApi, extraGlobals })) {
      problems.push(p);
    }
  }

  let lua;
  try {
    lua = await makeLua();
  } catch (e) {
    err(`无法启动 Lua 5.4 编译器（wasmoon）: ${e.message}`);
    return problems;
  }
  for (const f of luaFiles) {
    const rel = path.relative(pkgDir, f);
    try {
      lua.global.set('__V_SRC', readFileSync(f, 'utf8'));
      lua.global.set('__V_CH', '@' + rel);
      await lua.doString('local f2, err = load(__V_SRC, __V_CH); if not f2 then error(err, 0) end');
    } catch (e) {
      err(`Lua 5.4 编译失败: ${e.message}`, rel);
    }
  }
  // 显式关闭 Lua 状态：跳过 wasmoon/emscripten 的退出期清理（Windows libuv 断言会污染退出码）
  try { lua.global.close(); } catch { /* 已关闭 */ }
  return problems;
}

/** deploy.yaml 的静态校验（同一份 schema 的引擎侧落地） */
export function validateDeployFile(file) {
  let deploy;
  try {
    deploy = parse(readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    return [{ level: 'error', msg: `deploy.yaml 解析失败: ${e.message}`, file: 'deploy.yaml' }];
  }
  return validateDeploy(deploy).map((p) => ({ ...p, file: 'deploy.yaml' }));
}

/** CLI 入口：node tools/validate.mjs <包目录 | deploy.yaml> */
export async function validateFromArgv(arg, opts = {}) {
  // 包闸门默认严格：契约外的全局调用（api-surface.yaml 之外）判为错误，直接拒绝入库
  const options = { strictApi: true, ...opts };
  let pkgDir = arg;
  let deployProblems = [];
  if (arg.endsWith('.yaml') && existsSync(arg)) {
    deployProblems = validateDeployFile(arg);
    const deploy = parse(readFileSync(arg, 'utf8')) ?? {};
    pkgDir = path.resolve(path.dirname(path.resolve(arg)), deploy.package ?? '.');
  }
  console.log(`校验脚本包: ${path.resolve(pkgDir)}`);
  const problems = [...deployProblems, ...(await validatePackage(pkgDir, options))];
  for (const p of problems) {
    console[p.level === 'error' ? 'error' : 'warn'](
      `  [${p.level.toUpperCase()}]${p.file ? ' ' + p.file + ':' : ''} ${p.msg}`);
  }
  const errors = problems.filter((p) => p.level === 'error').length;
  console.log(errors ? `FAIL：${errors} 个错误，${problems.length - errors} 个警告` : 'PASS（包校验通过）');
  const ok = errors === 0;
  // marker 先于退出 flush：父进程以行为准，无视子进程退出阶段的库断言。
  let manifest = null;
  try {
    const pkg = parse(readFileSync(path.join(pkgDir, 'bot.yaml'), 'utf8')) ?? {};
    manifest = { name: pkg.name ?? null, scripts: pkg.scripts ?? [], params: pkg.params ?? {}, persist: pkg.persist ?? null };
  } catch { /* 清单已在前面的校验里报错 */ }
  process.stdout.write(`__BS_VALIDATE__ ${JSON.stringify({ ok, report: problems, manifest })}\n`, () => process.exit(0));
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('用法：node tools/validate.mjs <包目录 | deploy.yaml>');
    process.exit(1);
  }
  validateFromArgv(target, process.argv.includes('--loose-api') ? { strictApi: false } : {}).catch((e) => {
    console.error('[validate] 失败:', e);
    process.stdout.write(`__BS_VALIDATE__ ${JSON.stringify({ ok: false })}\n`, () => process.exit(0));
  });
}
