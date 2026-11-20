// tools/bench/query-cost.mjs — 查询成本基线（Lua<->宿主桥 + JSON 解码 + 方块读取）
//
// 用途：为 PERF-REFACTOR.md §1.2 的预算提供可复现的基线。CI 可跑「不劣化」比较。
// 运行：node tools/bench/query-cost.mjs             （全部，min-of-3，约 1.5min）
//       node tools/bench/query-cost.mjs --quick     （单轮小样本，约 30s，适合冒烟）
//       node tools/bench/query-cost.mjs --decode    （只跑解码 / 也可 --block / --native）
//
// 重要：载荷是按 snapshotOf + data.stack 输出形状构造的合成数据，不是线上抓包。
// 它测的是「协议机制成本」，不能单独用来断言线上 CPU 分布（见 CLAUDE.md §2 的精神）。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const req = createRequire(path.join(REPO, 'package.json'));
const { LuaFactory } = req('wasmoon');

const comp = (type, data) => ({ type, data });
const armor = {
  id: 'minecraft:diamond_helmet', count: 1, damage: 12, max_damage: 363, max_count: 1,
  components: [
    comp('minecraft:max_stack_size', 1),
    comp('minecraft:max_damage', 363),
    comp('minecraft:attribute_modifiers', [
      { type: 'minecraft:armor', amount: 3, operation: 'add_value', slot: 'armor' },
      { type: 'minecraft:armor_toughness', amount: 2, operation: 'add_value', slot: 'armor' },
    ]),
    comp('minecraft:enchantments', [{ id: 'minecraft:protection', lvl: 2 }]),
    comp('minecraft:custom_name', '{"text":"hat"}'),
  ],
  attributes: { armor: 3, armor_toughness: 2 },
  enchantments: [{ id: 'minecraft:protection', lvl: 2 }],
  custom_name: '{"text":"hat"}',
};
const emptyEquipment = { hand: null, offhand: null, boots: null, leggings: null, chestplate: null, helmet: null };
const player = (i) => ({
  id: 100 + i, uuid: `00000000-0000-4000-8000-0000000000${i}`, type: 'player', name: `player${i}`,
  pos: { x: 100.5 + i, y: 64, z: -200.25 }, velocity: { x: 0, y: -0.0784, z: 0 },
  yaw: 31.4, pitch: -12.2, alive: true, health: null, effects: [],
  equipment: { ...emptyEquipment, helmet: armor, chestplate: { ...armor, id: 'minecraft:diamond_chestplate' } },
  pose: 'standing', flags: { on_fire: false, sneaking: false, sprinting: true, invisible: false, glowing: false },
  vehicle_id: null,
});
const mob = (i) => ({
  id: 200 + i, uuid: null, type: 'minecraft:zombie', name: 'zombie',
  pos: { x: 100 + i, y: 63, z: -200 }, velocity: { x: 0.1, y: 0, z: 0 }, yaw: 90, pitch: 0,
  alive: true, health: null, effects: [], equipment: { ...emptyEquipment }, pose: null,
  flags: { on_fire: false, sneaking: false, sprinting: false, invisible: false, glowing: false }, vehicle_id: null,
});
const stack = (n) => ({
  id: 'minecraft:cobblestone', count: n, max_count: 64, max_damage: null, damage: null,
  components: [comp('minecraft:max_stack_size', 64)],
  attributes: null, enchantments: null, custom_name: null,
});
const windowView = {
  id: '3', type: 'chest', title: '"仓库"', size: 54, state_id: 12, revision: 4,
  slots: Array.from({ length: 90 }, (_, i) => ({ index: i, item: i % 3 === 0 ? stack(32) : null })), cursor: null,
};
const compact = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, type: 'player', name: `player${i}`, pos: { x: 100.5 + i, y: 64, z: -200.25 }, alive: true }));

const payloads = {
  'no-op': JSON.stringify({ ok: true, value: null }),
  'entities.list 10 玩家(全量)': JSON.stringify({ ok: true, value: Array.from({ length: 10 }, (_, i) => player(i)) }),
  'entities.list 40 怪(全量)': JSON.stringify({ ok: true, value: Array.from({ length: 40 }, (_, i) => mob(i)) }),
  'entities.list 10 玩家(紧凑投影)': JSON.stringify({ ok: true, value: compact }),
  'window.get 90 槽(全量 StackInfo)': JSON.stringify({ ok: true, value: windowView }),
  'entities.get 单个玩家': JSON.stringify({ ok: true, value: player(0) }),
};

const factory = new LuaFactory();
const realFetch = globalThis.fetch;
globalThis.fetch = undefined;   // emscripten 在 Windows 下对非 file:// 路径误用 fetch（同 hosts/node/vm.js）
const lua = await factory.createEngine();
globalThis.fetch = realFetch;
await factory.mountFile('json.lua', readFileSync(path.join(REPO, 'runtime/lua/core/json.lua'), 'utf8'));
lua.doString(`
  local json = require "json"
  __d, __e = json.decode, json.encode
`);
let payload = payloads['no-op'];
lua.global.set('__host_q', () => payload);
lua.doString(`
  function __runFull(n)
    for i = 1, n do
      local r = __d(__host_q("q", "{}"))
      if type(r) ~= "table" then error("bad result") end
    end
    return n
  end
  function __setP() __P = __host_q("q", "{}") end
  function __gc() collectgarbage("collect") end
  function __decodeN(n)
    local s = __P
    for i = 1, n do __d(s) end
    return n
  end
  function __crossN(n)
    for i = 1, n do __host_q("q", "{}") end
    return n
  end
`);

const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const only = argv.find((a) => a.startsWith('--') && a !== '--quick');
const ROUNDS = quick ? 1 : 3;
const bigN = (k) => (quick ? Math.max(30, Math.round(k / 4)) : k);
if (!only || only === '--all') {
  console.log('[全链路：Lua 编码参数 → 跨桥 → JS → 回传 → json.decode]');
  for (const [label, json] of Object.entries(payloads)) {
    payload = json;
    const n = bigN(json.length > 4096 ? 300 : 1500);
    lua.global.get('__gc')();
    lua.global.get('__runFull')(50);
    let best = Infinity;
    for (let r = 0; r < ROUNDS; r++) {   // 取多轮最小值：抑制 GC/缓存噪声
      lua.global.get('__gc')();
      const t = performance.now();
      lua.global.get('__runFull')(n);
      best = Math.min(best, (performance.now() - t) / n * 1000);
    }
    console.log(`  ${label}: ${(json.length / 1024).toFixed(1)}KB  ${best.toFixed(0)}µs/次`);
  }
  payload = payloads['no-op'];
  let t = performance.now();
  lua.global.get('__crossN')(5000);
  console.log(`  仅跨桥(小载荷): ${(((performance.now() - t) / 5000) * 1000).toFixed(1)}µs/次`);
}

if (!only || only === '--decode') {
  console.log('\n[隔离解码：同一 payload 只跨桥一次]');
  for (const [label, json] of Object.entries(payloads)) {
    payload = json;
    lua.global.get('__setP')();
    const n = bigN(json.length > 4096 ? 150 : 1500);
    lua.global.get('__gc')();
    lua.global.get('__decodeN')(20);
    let best = Infinity;
    for (let r = 0; r < ROUNDS; r++) {
      lua.global.get('__gc')();
      const t = performance.now();
      lua.global.get('__decodeN')(n);
      best = Math.min(best, (performance.now() - t) / n * 1000);
    }
    console.log(`  ${label}: ${(json.length / 1024).toFixed(1)}KB  ${best.toFixed(0)}µs/次`);
  }
}

if (!only || only === '--block') {
  console.log('\n[方块读取：prismarine-chunk.getBlock 单块成本]');
  const Vec3 = req('vec3').Vec3;
  const Chunk = req('prismarine-chunk')('1.21.4');
  const chunk = new Chunk();
  for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, y, z), 1);
  const pos = new Vec3(0, 0, 0);
  const N = 100000;
  for (let i = 0; i < 1000; i++) { pos.set(i % 16, (i >> 4) % 16, (i >> 8) % 16); chunk.getBlock(pos); }
  let t = performance.now();
  for (let i = 0; i < N; i++) { pos.set(i % 16, (i >> 4) % 16, (i >> 8) % 16); chunk.getBlock(pos); }
  const per = (performance.now() - t) / N * 1000;
  const sections = 7, secCount = 575;   // 100³ 区域 ≈ 半径 7 section 的八面体
  console.log(`  ${per.toFixed(2)}µs/块；${secCount} sections ×4096 ≈ ${(secCount * 4096 / 1e6).toFixed(2)}M 次 ≈ ${(secCount * 4096 * per / 1e6).toFixed(1)}s（useExtraInfo=true 全扫）`);
}

if (!only || only === '--native') {
  console.log('\n[wasmoon 直接 JS 对象返回（userdata 代理，已否决方案）]');
  const list = Array.from({ length: 10 }, (_, i) => player(i));
  lua.global.set('__obj_q', () => ({ ok: true, value: list }));
  lua.doString(`
    function __objLen(n)
      local acc = 0
      for i = 1, n do acc = acc + #__obj_q().value end
      return acc
    end
    function __objFields(n)
      local e = __obj_q().value[1]
      local acc = 0
      for i = 1, n do acc = acc + e.pos.x + e.yaw end
      return acc
    end
    function __objSemantics()
      local e = __obj_q().value[1]
      local ok = pcall(function() local c = 0; for _ in pairs(e) do c = c + 1 end; return c end)
      return table.concat({
        "type=" .. type(e),
        "pairs_ok=" .. tostring(ok),
        "null_eq_nil=" .. tostring(e.health == nil),
      }, " | ")
    end
  `);
  console.log(`  语义: ${lua.global.get('__objSemantics')()}`);
  const n = 200;
  lua.global.get('__objLen')(20);
  let t = performance.now();
  lua.global.get('__objLen')(n);
  console.log(`  10 玩家列表(仅取长度): ${(((performance.now() - t) / n) * 1000).toFixed(0)}µs/次`);
  t = performance.now();
  lua.global.get('__objFields')(20000);
  console.log(`  单实体字段读 e.pos.x+e.yaw: ${(((performance.now() - t) / 20000) * 1000).toFixed(2)}µs/对`);
}

await lua.global.close();
