// tools/codegen.mjs — 契约 → 代码（唯一生成入口）
//
//   contracts/host-abi.yaml ─┬─▶ runtime/lua/core/bridge.generated.lua
//                            └─▶ hosts/node/abi.generated.js
//   contracts/api-surface.yaml ─▶ engine/lua/bot-api.d.lua（编辑器补全 + api-lint 依据）
//   contracts/http17.openapi.yaml ─▶ hosts/node/http17.routes.generated.js
//
// Fabric mod 已归档（archive/fabric-mod），不再生成 Java 产物。
//
// 用法：node tools/codegen.mjs [--check]
//   --check：只比对磁盘产物与生成结果，不一致即退出 1（CI 的 contract-lint 用它）。
// 生成物一律带 "生成物，勿手改" 头；任何手改都会被 contract-lint 打红。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const abi = parse(read('contracts/host-abi.yaml'));
const surface = parse(read('contracts/api-surface.yaml'));
const openapi = parse(read('contracts/http17.openapi.yaml'));

const GEN = '生成物，勿手改：源 contracts/*.yaml，重建 `node tools/codegen.mjs`';
const luaStr = (s) => JSON.stringify(String(s));

// ---------------------------------------------------------------- helpers

function argList(op) {
  const names = Object.keys(op.args ?? {});
  const jsonBlock = names.map((n) => {
    const a = op.args[n];
    if (a && a.default !== undefined) {
      return `    ${n} = ${n} ~= nil and ${n} or ${luaDefault(a.default)},`;
    }
    return `    ${n} = ${n},`;
  }).join('\n');
  return { names, jsonBlock };
}

function luaDefault(v) {
  if (typeof v === 'string') return luaStr(v);
  if (v === true || v === false) return String(v);
  if (typeof v === 'number') return String(v);
  return 'nil';
}

function luaDoc(op, kind) {
  const names = Object.keys(op.args ?? {});
  const sig = names.join(', ');
  const ret = op.result ?? 'void';
  return `--- ${op.name}(${sig}) → ${ret}${op.gate ? `  [gate: ${op.gate}]` : ''}${kind === 'async' ? '  [async: token]' : ''}`;
}

function nsPath(name) {
  return name.split('.');
}

/** 把 op 挂到嵌套命名空间：M.a.b.c = fn */
function emitLuaOps(ops, kind) {
  const out = [];
  for (const op of ops) {
    const { names, jsonBlock } = argList(op);
    const fn = kind === 'async' ? 'a' : 'q';
    out.push(`${luaDoc(op, kind)}\nbridge.${op.name} = function(${names.join(', ')})`);
    out.push(`  return ${fn}(${luaStr(op.name)}, {\n${jsonBlock}${names.length ? '\n  ' : ''}})`);
    out.push(`end`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- Lua bridge

const luaRoots = [...new Set([...abi.sync_ops, ...abi.async_ops].map((o) => o.name.split('.').slice(0, -1).join('.')))].filter(Boolean)
  .sort();

const luaBridge = `-- ${GEN}
-- 核心只通过本模块访问宿主（bridge.self.get / bridge.act.chat_send …），不再手写桥名字符串。
local json = require "json"

local function dec(j)
  if j == nil or j == "" then return nil end
  return json.decode(j)
end

local function q(op, args)
  local r = dec(__host_q(op, json.encode(args or {})))
  if type(r) == "table" and r.ok ~= nil then return r end
  -- 兼容尚未迁移到 Result 的宿主（Fabric 旧实现）：成功值按 Ok 包装
  return { ok = true, value = r }
end

-- Result 解包（核心/可选库内部取纯数据用；失败 -> default，不抛错）
local function value(r, default)
  if type(r) == "table" and r.ok == true then return r.value end
  return default
end

local function a(op, args)
  return __host_a(op, json.encode(args or {}))
end

local bridge = {}
bridge.abi = ${abi.abi}
bridge.q = q
bridge.value = value
bridge.a = a

-- 命名空间（bridge.self / bridge.act / bridge.state …）
${luaRoots.map((n) => `bridge${n.split('.').map((s) => `.${s}`).join('')} = {}`).join('\n')}

-- 同步 op
${emitLuaOps(abi.sync_ops ?? [], 'sync')}

-- 异步 op（返回 token；结果经 __core_resume 交付）
${emitLuaOps(abi.async_ops ?? [], 'async')}

-- 能力与补丁（/caps 与启动日志共用）
bridge.capabilities = { ${Object.keys(abi.capabilities ?? {}).map((c) => luaStr(c)).join(', ')} }

return bridge
`;

// ---------------------------------------------------------------- JS op table

function jsSchema(args) {
  if (!args || !Object.keys(args).length) return '{}';
  const entries = Object.entries(args).map(([k, a]) => {
    const spec = { type: a?.type ?? 'any' };
    // 只有显式 required: true 才强制；其余参数可省略（缺省值由 manifest/default 或宿主处理）
    spec.required = a?.required === true;
    if (a?.default !== undefined) spec.default = a.default;
    return `    ${JSON.stringify(k)}: ${JSON.stringify(spec)},`;
  });
  return `{\n${entries.join('\n')}\n  }`;
}

const jsTable = (ops, withGate) => ops.map((op) => {
  const gate = withGate && op.gate ? `gate: ${luaStr(op.gate)}, ` : '';
  return `  ${luaStr(op.name)}: { ${gate}args: ${jsSchema(op.args)}, result: ${luaStr(op.result ?? 'void')} },`;
}).join('\n');

const jsAbi = `// ${GEN}
export const ABI_VERSION = ${abi.abi};
export const CAPABILITIES = ${JSON.stringify(Object.keys(abi.capabilities ?? {}), null, 2)};
export const GATES = ${JSON.stringify(Object.fromEntries(Object.entries(abi.gates ?? {}).map(([k, v]) => [k, v.description])), null, 2)};

export const SYNC_OPS = {
${jsTable(abi.sync_ops ?? [], false)}
};

export const ASYNC_OPS = {
${jsTable(abi.async_ops ?? [], true)}
};

export const REVERSE_OPS = {
${jsTable(abi.reverse_ops ?? [], false)}
};

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  blockpos: (v) => v !== null && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
  region: (v) => Array.isArray(v) && v.length === 2 && v.every((c) => c && Number.isFinite(c.x)),
};

/** 按 manifest 声明校验参数；不合法抛 {kind:'abi.invalid_args', detail} */
export function validateArgs(op, spec, args) {
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const [key, a] of Object.entries(spec?.args ?? {})) {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (a.required) {
        const e = new Error(\`\${op}: 缺少参数 \${key}\`);
        e.kind = 'abi.invalid_args';
        throw e;
      }
      continue;
    }
    const t = String(a.type);
    const base = t.split('|')[0];            // "string|null" → 校验 string（null 已放行）
    if (base === 'any' || base === 'void') continue;
    const check = TYPE_CHECKS[base];
    if (check && !check(v)) {
      const e = new Error(\`\${op}: 参数 \${key} 应为 \${t}\`);
      e.kind = 'abi.invalid_args';
      throw e;
    }
  }
  return obj;
}
`;

// ---------------------------------------------------------------- Java op table

const javaSet = (names) => names.length
  ? `Set.of(${names.map((n) => `"${n}"`).join(', ')})`
  : 'Set.of()';

const javaGate = (ops) => {
  const entries = ops.filter((o) => o.gate).map((o) => `            Map.entry("${o.name}", "${o.gate}")`);
  return entries.length ? `Map.ofEntries(${entries.join(',\n')})` : 'Map.of()';
};

const javaRequired = (ops) => {
  const entries = ops.filter((o) => Object.values(o.args ?? {}).some((a) => a?.required))
    .map((o) => `            Map.entry("${o.name}", ${javaSet(Object.entries(o.args).filter(([, a]) => a?.required).map(([k]) => k))})`);
  return entries.length ? `Map.ofEntries(${entries.join(',\n')})` : 'Map.of()';
};

const javaAbi = `package com.botscript.mod.runtime;

import java.util.Map;
import java.util.Set;

/** ${GEN} */
public final class AbiOps {
    private AbiOps() {}

    public static final int ABI_VERSION = ${abi.abi};

    public static final Set<String> CAPABILITIES = ${javaSet(Object.keys(abi.capabilities ?? {}))};

    public static final Set<String> SYNC_OPS = ${javaSet((abi.sync_ops ?? []).map((o) => o.name))};

    public static final Set<String> ASYNC_OPS = ${javaSet((abi.async_ops ?? []).map((o) => o.name))};

    public static final Set<String> REVERSE_OPS = ${javaSet((abi.reverse_ops ?? []).map((o) => o.name))};

    public static final Map<String, String> GATE = ${javaGate(abi.async_ops ?? [])};

    public static final Map<String, Set<String>> REQUIRED =
${javaRequired([...(abi.sync_ops ?? []), ...(abi.async_ops ?? []), ...(abi.reverse_ops ?? [])])};
}
`;

// ---------------------------------------------------------------- bot-api.d.lua

const surfaceLua = [`-- ${GEN}
---@meta
`, ''];
function emitSurface(name, spec, indent) {
  const pad = '  '.repeat(indent);
  if (spec.kind === 'namespace') {
    surfaceLua.push(`${pad}---@class ${name}`);
    surfaceLua.push(`${pad}${name.split('.').pop()} = {}`);
    for (const [m, doc] of Object.entries(spec.members ?? {})) {
      surfaceLua.push(`${pad}--- ${String(doc).replace(/\n/g, ' ')}`);
      surfaceLua.push(`${pad}function ${name.split('.').pop()}.${m}(...) end`);
    }
    return;
  }
  surfaceLua.push(`${pad}--- ${String(spec.doc ?? '').replace(/\n/g, ' ')}`);
  if (spec.kind === 'callable' || spec.kind === 'function') {
    surfaceLua.push(`${pad}function ${name}(...) end`);
  }
  if (spec.kind === 'callable') {
    for (const [m, doc] of Object.entries(spec.members ?? {})) {
      surfaceLua.push(`${pad}--- ${String(doc).replace(/\n/g, ' ')}`);
      surfaceLua.push(`${pad}function ${name}.${m}(...) end`);
    }
  }
}
for (const [name, spec] of Object.entries(surface.globals ?? {})) emitSurface(name, spec, 0);
const luaApi = surfaceLua.join('\n') + '\n';

// ---------------------------------------------------------------- HTTP routes

const routes = [];
for (const [p, item] of Object.entries(openapi.paths ?? {})) {
  for (const [method, op] of Object.entries(item)) {
    routes.push({ method: method.toUpperCase(), path: p, operationId: op.operationId });
  }
}

const jsRoutes = `// ${GEN}
export const OPENAPI_VERSION = ${luaStr(openapi.info?.version ?? '')};
export const ROUTES = [
${routes.map((r) => `  { method: ${luaStr(r.method)}, path: ${luaStr(r.path)}, operationId: ${luaStr(r.operationId)} },`).join('\n')}
];
`;

const javaRoutes = `package com.botscript.mod.runtime;

import java.util.List;

/** ${GEN} */
public final class HttpRoutes {
    private HttpRoutes() {}

    public record Route(String method, String path, String operationId) {}

    public static final String OPENAPI_VERSION = "${openapi.info?.version ?? ''}";

    public static final List<Route> ROUTES = List.of(
${routes.map((r) => `            new Route("${r.method}", "${r.path}", "${r.operationId}")${routes.indexOf(r) === routes.length - 1 ? '' : ','}`).join('\n')}
    );
}
`;

// ---------------------------------------------------------------- write / check

const ARTIFACTS = [
  ['runtime/lua/core/bridge.generated.lua', luaBridge],
  ['hosts/node/abi.generated.js', jsAbi],
  ['engine/lua/bot-api.d.lua', luaApi],
  ['hosts/node/http17.routes.generated.js', jsRoutes],
];

const checkMode = process.argv.includes('--check');
let bad = 0;
for (const [rel, content] of ARTIFACTS) {
  const abs = path.join(ROOT, rel);
  const norm = content.endsWith('\n') ? content : content + '\n';
  if (checkMode) {
    const cur = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (cur !== norm) {
      console.error(`[codegen] 不一致：${rel}（跑 \`node tools/codegen.mjs\` 重建）`);
      bad++;
    }
    continue;
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, norm);
  console.log(`[codegen] ${rel}`);
}
if (checkMode && bad) process.exit(1);
