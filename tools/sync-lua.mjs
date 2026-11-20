#!/usr/bin/env node
// tools/sync-lua.mjs — Lua 单一源门禁（lua-sync）
//
// 唯一源码：runtime/lua/core/*.lua + runtime/lua/lib/*.lua + runtime/lua/compat/luaj.lua
// Fabric 构建由 mod/build.gradle 的 processResources 直接拷入资源（不提交第二份拷贝）。
//
// 用法：
//   node tools/sync-lua.mjs --check   门禁：仓内不得存在 mod/src/main/resources/lua；
//                                     否则打印应拷贝的文件与 sha256，退出 1
//   node tools/sync-lua.mjs --print   打印哈希清单（供发布记录/排查）
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'runtime', 'lua', 'core');
const LIB = path.join(ROOT, 'runtime', 'lua', 'lib');
const COMPAT = path.join(ROOT, 'runtime', 'lua', 'compat');
const SECOND_COPY = path.join(ROOT, 'mod', 'src', 'main', 'resources', 'lua');

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function list(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.lua')).sort()
    .map((f) => ({ rel: path.relative(ROOT, path.join(dir, f)).replaceAll('\\', '/'), hash: sha(path.join(dir, f)) }));
}

const files = [...list(CORE), ...list(LIB), ...list(COMPAT)];

if (process.argv.includes('--print') || !process.argv.includes('--check')) {
  for (const f of files) console.log(`${f.hash}  ${f.rel}`);
}

if (process.argv.includes('--check')) {
  let bad = 0;
  if (existsSync(SECOND_COPY) && statSync(SECOND_COPY).isDirectory()) {
    console.error(`[lua-sync] 发现第二份 Lua 拷贝：${path.relative(ROOT, SECOND_COPY)}（构建期由 processResources 拷贝，仓内不得提交）`);
    bad++;
  }
  const core = list(CORE).map((f) => path.basename(f.rel));
  for (const required of ['bootstrap.lua', 'json.lua', 'bridge.generated.lua']) {
    if (!core.includes(required)) {
      console.error(`[lua-sync] runtime/lua/core 缺少 ${required}`);
      bad++;
    }
  }
  const lib = list(LIB).map((f) => path.basename(f.rel));
  for (const required of ['bslib.lua', 'container_lib.lua']) {
    if (!lib.includes(required)) {
      console.error(`[lua-sync] runtime/lua/lib 缺少 ${required}`);
      bad++;
    }
  }
  if (files.length < 6) {
    console.error('[lua-sync] runtime/lua 文件数异常（core + lib + compat 至少 6 个）');
    bad++;
  }
  if (bad) process.exit(1);
  console.log(`[lua-sync] OK（${files.length} 个 Lua 源文件，无第二份拷贝）`);
}
