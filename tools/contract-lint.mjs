#!/usr/bin/env node
// tools/contract-lint.mjs — 契约门禁（CI）：生成物与 manifest 一致 + 核心不手写桥名
//
// 1) codegen --check：五份生成物必须与 contracts/*.yaml 完全一致
// 2) 核心 Lua（除 bridge.generated.lua）不得直接引用旧桥名（__q_/__act_/__persist_/…）
// 3) 宿主业务代码不得出现协议槽位常量（size+27 / 45）——归一化只在 state/windows 与 WindowLayout
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const fail = (msg) => { console.error(`[contract-lint] ${msg}`); bad++; };

// 1) 生成物一致
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'codegen.mjs'), '--check'], { stdio: 'inherit' });
} catch {
  fail('codegen 生成物与契约不一致');
}

const LEGACY_BRIDGES = [
  '__q_', '__act_', '__persist_', '__kv_', '__log_append', '__evt_', '__timer_register',
  '__after_register', '__sleep_register', '__new_waiter', '__resolve_waiter',
  '__command_register', '__params_decl', '__param_get', '__q_caps',
];

function walk(dir, ext) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (f.endsWith(ext)) out.push(p);
  }
  return out;
}

// 2) 核心 Lua 不写旧桥名
for (const f of walk(path.join(ROOT, 'runtime', 'lua', 'core'), '.lua')) {
  if (path.basename(f) === 'bridge.generated.lua') continue;
  const src = readFileSync(f, 'utf8');
  for (const b of LEGACY_BRIDGES) {
    if (src.includes(b)) fail(`${path.relative(ROOT, f)} 仍直接引用旧桥名 ${b}（必须走 bridge.*）`);
  }
}

// 3) 协议布局常量不得散落在宿主业务代码
const SLOT_MAGIC = [/size\s*\+\s*27/, /size\s*\+\s*36/, /\b45\b.*offhand/i];
const forbiddenZones = [
  path.join(ROOT, 'hosts', 'node', 'abi.js'),
  path.join(ROOT, 'hosts', 'node', 'engine.js'),
  path.join(ROOT, 'hosts', 'node', 'policy.js'),
  path.join(ROOT, 'runtime', 'lua', 'core', 'bootstrap.lua'),
];
for (const f of forbiddenZones) {
  if (!existsSync(f)) continue;
  const src = readFileSync(f, 'utf8');
  for (const re of SLOT_MAGIC) {
    if (re.test(src)) fail(`${path.relative(ROOT, f)} 出现协议槽位常量（${re}）：归一化只能在 state/windows / WindowLayout`);
  }
}

if (bad) {
  console.error(`[contract-lint] FAIL：${bad} 项`);
  process.exit(1);
}
console.log('[contract-lint] OK');
