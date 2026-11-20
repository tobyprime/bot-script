// testing/vectors.test.js — 契约向量（跨宿主一致性的唯一机制）
//
// scheduler：Node（wasmoon）+ Java（Luaj）跑同一份 vector，日志序列必须一致。
// policy/windows/persist：Node 实现与 Fabric 实现各跑同一份 vector，判定必须一致。
// abi-conformance：清单里的每个 op 都至少能被 dispatch 一次（不得 abi.unknown_op）。
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from './registry.js';
import { runSchedulerVector } from './vector-host.mjs';
import { Policy } from '../hosts/node/policy.js';
import { WindowState } from '../hosts/node/state/windows.js';
import { Persist } from '../hosts/node/persist.js';
import { SYNC_OPS, ASYNC_OPS, REVERSE_OPS } from '../hosts/node/abi.generated.js';
import { makeEngine, waitFor, g } from './harness.js';

const V = (dir) => new URL(`../contracts/vectors/${dir}/`, import.meta.url);
const readJson = (u) => JSON.parse(readFileSync(u, 'utf8'));
const filesOf = (dir) => readdirSync(V(dir)).filter((f) => f.endsWith('.json')).map((f) => new URL(f, V(dir)));

// ---------------------------------------------------------------- scheduler

test('scheduler-vectors：race/parallel/cancel/txn 在 wasmoon 上产出确定序列', async () => {
  for (const u of filesOf('scheduler')) {
    const vec = readJson(u);
    const r = await runSchedulerVector(vec);
    assert.deepStrictEqual(r.logs, vec.expectLogs,
      `${vec.name}: 日志序列不一致\n实际: ${JSON.stringify(r.logs)}\n期望: ${JSON.stringify(vec.expectLogs)}`);
  }
});

// ---------------------------------------------------------------- policy

test('policy-vectors：同一 boundary + 动作 => 同允许/拒绝与同 error kind', () => {
  for (const u of filesOf('policy')) {
    const vec = readJson(u);
    const policy = new Policy(vec.boundary, {
      entityLookup: (id) => (vec.entity && String(vec.entity.id) === id ? vec.entity : null),
      selfPos: () => vec.self_pos ?? null,
      isContainerOpen: () => false,
    });
    const err = policy.check(vec.op, vec.args ?? {});
    if (vec.expect.allow) {
      assert.strictEqual(err, null, `${vec.name}: 应允许（实际 ${JSON.stringify(err)}）`);
    } else {
      assert.ok(err, `${vec.name}: 应拒绝`);
      assert.strictEqual(err.kind, vec.expect.error, `${vec.name}: error kind 不一致`);
    }
  }
});

// ---------------------------------------------------------------- windows

test('window-vectors：同一原始快照 => 归一化逐槽一致 + 点击映射一致', () => {
  for (const u of filesOf('windows')) {
    const vec = readJson(u);
    const ws = new WindowState();
    ws.apply(vec.raw);
    const sparse = (view) => {
      const out = {};
      for (const s of view.slots) if (s.item) out[String(s.index)] = s.item.id;
      return out;
    };
    const win = ws.view(String(vec.raw.id));
    assert.strictEqual(win.size, vec.expect.window.size, `${vec.name}: window size`);
    assert.deepStrictEqual(sparse(win), vec.expect.window.occupied, `${vec.name}: window 槽位不一致`);
    const inv = ws.view('0');
    assert.strictEqual(inv.size, vec.expect.inventory.size);
    assert.deepStrictEqual(sparse(inv), vec.expect.inventory.occupied, `${vec.name}: 背包视图不一致`);
    for (const c of vec.expect.clicks) {
      const t = ws.clickTarget('0', c.slot);
      assert.strictEqual(t.window, c.target, `${vec.name}: 点击目标窗口`);
      assert.strictEqual(t.slot, c.target_slot, `${vec.name}: 点击槽映射`);
    }
  }
});

// ---------------------------------------------------------------- persist

test('persist-vectors：同一操作序列 => 相同表行 / seen / kv / 日志语义', () => {
  for (const u of filesOf('persist')) {
    const vec = readJson(u);
    const p = new Persist(':memory:');
    const seen = [];
    const logIds = {};
    for (const op of vec.ops) {
      const [a1, a2, a3, a4, a5] = op.args;
      switch (op.op) {
        case 'declareTable': p.declareTable(a1, a2); break;
        case 'upsert': p.upsert(a1, a2); break;
        case 'del': p.del(a1, a2 ?? {}); break;
        case 'adjust': p.adjust(a1, a2, a3); break;
        case 'seen': seen.push(p.seen(a1, a2)); break;
        case 'kvSet': p.kvSet(a1, a2, a3); break;
        case 'logDeclare': p.logDeclare(a1); break;
        case 'logAppend': logIds[a1] = (logIds[a1] ?? []).concat([(p.logAppend(a1, a2), a2.state ?? 'new')]); break;
        default: throw new Error(`未实现向量 op ${op.op}`);
      }
    }
    for (const [name, rows] of Object.entries(vec.expect.rows)) {
      assert.deepStrictEqual(p.all(name), rows, `${vec.name}: 表 ${name}`);
    }
    for (const [k, v] of Object.entries(vec.expect.kv)) {
      const [ns, key] = k.split('/');
      assert.strictEqual(p.kvGet(ns, key), v, `${vec.name}: kv ${k}`);
    }
    if (vec.expect.seen) assert.deepStrictEqual(seen, vec.expect.seen, `${vec.name}: seen 判定`);
    for (const [name, states] of Object.entries(vec.expect.logCounts ?? {})) {
      for (const [state, n] of Object.entries(states)) {
        assert.strictEqual(p.logFind(name, { state }).length, n, `${vec.name}: ${name}/${state} 行数`);
      }
    }
    p.close();
  }
});

// ---------------------------------------------------------------- abi conformance

test('abi-conformance：清单里的每个 op 都有 dispatch 实现（不得 abi.unknown_op）', async () => {
  const { engine } = await makeEngine({
    scripts: [],
    boundary: { chat: { commands: ['/say'] }, blocks: { dig: 'allow', place: 'allow' }, combat: { targets: 'player', max_engage: 10 }, rate: {}, packets: true },
  });
  const bad = [];
  const minimal = {
    log: { level: 'info', msg: 'x' },
    'util.regex_new': { pattern: '^x' },
    'util.regex_match': { id: 1, text: 'x' },
    'token.bind': { task_id: 1, token: 999, kind: 'a' },
    'token.detach': { token: 999 },
    'timer.after': { delay: 1 },
    'timer.interval': { interval: 50 },
    'events.emit': { type: 'x', data: {} },
    'waiter.resolve': { token: 999, match: '{}' },
    'self.get': {},
    'session.get': {},
    'caps.get': { flag: 'nav.pathfinder' },
    'caps.list': {},
    'entities.list': {},
    'entities.get': { id: '1' },
    'world.block': { pos: { x: 0, y: 64, z: 0 } },
    'world.block_entity': { pos: { x: 0, y: 64, z: 0 } },
    'world.scan': { region: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }] },
    'world.env': {},
    'world.reach': { pos: { x: 0, y: 64, z: 0 } },
    'window.current': {},
    'window.get': { window: '0' },
    'item.stack': { stack: { id: 'minecraft:dirt' } },
    'chat.config': {},
    'persist.table': { name: 'VT', schema: { k: 'string:key', v: 'number' } },
    'persist.find': { name: 'VT', where: {} },
    'persist.all': { name: 'VT' },
    'persist.upsert': { name: 'VT', row: { k: 'a', v: 1 } },
    'persist.del': { name: 'VT', where: { k: 'a' } },
    'persist.adjust': { name: 'VT', key: 'a', delta: 1 },
    'persist.seen': { key: 'x', window_ms: 1000 },
    'kv.get': { name: 'n', key: 'k' },
    'kv.set': { name: 'n', key: 'k', value: 'v' },
    'persist.log_declare': { name: 'L' },
    'persist.log_append': { name: 'L', fields: {} },
    'persist.log_find': { name: 'L', where: {} },
    'persist.log_mark': { name: 'L', id: 1, state: 's' },
    'txn.begin': {},
    'txn.commit': {},
    'txn.rollback': {},
    'util.sleep': { ms: 1 },
    'events.next': { timeout: 1 },
    'waiter.new': { timeout: 1 },
    'act.chat_send': { text: 'hi', kind: 'chat' },
    'act.custom_payload': { channel: 'minecraft:brand', data: '' },
    'act.look': { yaw: 0, pitch: 0 },
    'act.input': { forward: 0, right: 0, up: 0, sprint: false, sneak: false },
    'act.path_to': { target: { x: 1, y: 64, z: 1 }, arrive: 1, timeout_ms: 1000 },
    'act.path_cancel': {},
    'act.dig': { pos: { x: 1, y: 64, z: 1 }, face: 1 },
    'act.dig_stop': {},
    'act.use_block': { pos: { x: 1, y: 64, z: 1 }, face: 1, hand: 'main', intent: 'use' },
    'act.use_entity': { id: '1', kind: 'attack', hand: 'main' },
    'act.swing': { hand: 'main' },
    'act.use_item': { hand: 'main', phase: 'start' },
    'act.select_slot': { slot: 0 },
    'act.drop': { slot: null, all: false },
    'act.window_open': { target: { x: 5, y: 64, z: 5 } },
    'act.window_click': { window: '0', slot: 0, button: 0, mode: 0, state_id: null },
    'act.window_close': {},
  };
  for (const op of Object.keys(SYNC_OPS)) {
    const r = JSON.parse(engine.abi.sync(op, JSON.stringify(minimal[op] ?? {})) || '{}');
    if (r.ok === false && r.error?.code === 'abi.unknown_op') bad.push(`sync:${op}`);
  }
  for (const op of Object.keys(ASYNC_OPS)) {
    const token = engine.abi.asyncOp(op, JSON.stringify(minimal[op] ?? {}));
    await waitFor(() => {
      const rec = engine.hub.tokens.get(token);
      return !rec || rec.settled || (rec.taskId == null && engine.hub.settled.has(token));
    }, 8000);
  }
  assert.deepStrictEqual(bad, [], `未实现的 op: ${bad.join(',')}`);
  // 反向：宿主注册的 handler 必须都在 manifest 里（「注册名 ⊆ manifest」门禁）
  const specNames = new Set([...Object.keys(SYNC_OPS), ...Object.keys(ASYNC_OPS)]);
  const extra = Object.keys(engine.abi.handlers).filter((k) => !specNames.has(k));
  assert.deepStrictEqual(extra, [], `宿主注册了清单外的 op: ${extra.join(',')}`);
  // 反向 op 也必须实现（在核心）
  for (const op of Object.keys(REVERSE_OPS)) {
    if (op === 'eval.once') continue;   // 会真的执行 Lua；由 http 测试覆盖
    try {
      const r = engine.coreCall(op,
        op === 'params.set' ? { key: '__no_such_param__', value: 1 }
          : op === 'tasks.cancel' ? { name: 'ghost' }
            : op === 'params.bind' ? {} : {});
      assert.ok(r !== undefined, `reverse op ${op} 应有结果`);
      if (op === 'params.set') assert.fail('未知参数应抛 param.unknown');
    } catch (e) {
      assert.strictEqual(e.kind, 'param.unknown', `reverse op ${op} 不应是 abi.unknown_op（实际 ${e.kind}）`);
    }
  }
  await engine.stop();
});
