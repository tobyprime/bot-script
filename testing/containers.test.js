// testing/containers.test.js — 容器/背包编排（开箱、点击协议复合、bslib 搬运）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

test('container + container_lib：withdraw 精确取出、deposit、move 多趟', async () => {
  script('t6.lua', `
    local clib = require "container_lib"
    task("haul", function()
      local A = { x = 5, y = 64, z = 5 }
      local B = { x = 10, y = 64, z = 5 }
      local w = clib.open(A)
      __R_type = w:type()
      __R_size = w:size()
      local got = clib.withdraw(w, { id = "minecraft:pink_wool" }, 30)
      __R_withdrawn = got
      container.close(w)
      __R_inv_after_w = inv.count{ id = "minecraft:pink_wool" }
      local w2 = clib.open(B)
      local put = clib.deposit(w2, { id = "minecraft:pink_wool" }, got)
      __R_deposited = put
      container.close(w2)
      __R_moved = clib.move(A, B, { id = "minecraft:pink_wool" })
    end)
    on_start(function() task.spawn("haul") end)
  `);
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, [[0, 'minecraft:pink_wool', 64], [1, 'minecraft:pink_wool', 64]]);
  driver.setContainer({ x: 10, y: 64, z: 5 }, []);
  const { engine } = await makeEngine({ scripts: ['t6.lua'], driver });
  assert.ok(await waitFor(() => {
    const m = g(engine, '__R_moved');
    return m !== undefined && m !== null;
  }, 15000), 'move 未完成');
  assert.strictEqual(g(engine, '__R_type'), 'chest');
  assert.strictEqual(g(engine, '__R_size'), 27);
  assert.strictEqual(g(engine, '__R_withdrawn'), 30, '精确取出 30');
  assert.strictEqual(g(engine, '__R_inv_after_w'), 30);
  assert.strictEqual(g(engine, '__R_deposited'), 30);
  assert.strictEqual(g(engine, '__R_moved'), 98, 'A 剩余 98 块应全部转移');
  assert.strictEqual(driver.containerSlots.get('5,64,5').reduce((n, s) => n + (s?.count ?? 0), 0), 0, 'A 应空');
  assert.strictEqual(driver.containerSlots.get('10,64,5').reduce((n, s) => n + (s?.count ?? 0), 0), 128, 'B 应收齐 128');
  await engine.stop();
});

test('窗口归一化：容器打开时背包 = 玩家区合并视图（槽位映射唯一实现）', async () => {
  script('t-win.lua', `
    task("probe", function()
      local w = container.open({ x = 5, y = 64, z = 5 })
      __R_win = w and w:type() or "nil"
      local inv_slot = inv.find{ id = "minecraft:dirt" }
      __R_inv_slot = inv_slot
      container.close(w)
    end)
    on_start(function() task.spawn("probe") end)
  `);
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, [[0, 'minecraft:pink_wool', 64]]);
  driver.give(9, 'minecraft:dirt', 5);      // 主背包第一格 → 容器打开后应出现在背包 9
  const { engine } = await makeEngine({ scripts: ['t-win.lua'], driver });
  assert.ok(await waitFor(() => g(engine, '__R_inv_slot') != null, 5000));
  assert.strictEqual(g(engine, '__R_inv_slot'), 9, '主背包槽在合并视图里仍是 9');
  await engine.stop();
});

test('window.get fields=idcount：只回 id/count（count/find 不再展开整份 StackInfo）', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: [], driver });
  driver.give(0, 'minecraft:pink_wool', 10);
  driver.give(9, 'minecraft:dirt', 5);
  const full = JSON.parse(engine.abi.sync('window.get', JSON.stringify({ window: '0' })));
  const compact = JSON.parse(engine.abi.sync('window.get', JSON.stringify({ window: '0', fields: 'idcount' })));
  assert.ok(full.ok && compact.ok);
  const fullItem = full.value.slots.find((s) => s.item).item;
  const compactItem = compact.value.slots.find((s) => s.item).item;
  assert.deepStrictEqual(Object.keys(compactItem).sort(), ['count', 'id'],
    'idcount 投影只应包含 id/count，便于 Lua 侧 count/find 使用');
  assert.strictEqual(compactItem.id, fullItem.id);
  assert.strictEqual(compactItem.count, fullItem.count);
  assert.ok(fullItem.max_count != null, 'full 仍应展开 StackInfo（默认行为不变）');
  await engine.stop();
});

// ---------- 回归：deposit 进度判定（2026-11-22 生产现场） ----------
// 现象：回收指令只放进一件就报「存放 0 件」。旧实现比较「首个匹配叠」点击前后的
// 数量，两类假阴性都会提前中断：换叠后数量巧合相等；真实服 windowItems 晚到读到旧值。

// 慢同步驱动：点击立即生效，但窗口/背包快照推送延迟（模拟真实服 windowItems 晚到）
class SlowSyncDriver extends MockDriver {
  constructor(opts) { super(opts); this.slowSync = false; }
  async window_click(windowId, slot, button, mode, stateId) {
    if (!this.slowSync) return super.window_click(windowId, slot, button, mode, stateId);
    const pushW = this.pushWindow.bind(this);
    const pushI = this.pushInventory.bind(this);
    this.pushWindow = () => {};
    this.pushInventory = () => {};
    try {
      await super.window_click(windowId, slot, button, mode, stateId);
    } finally {
      this.pushWindow = pushW;
      this.pushInventory = pushI;
      setTimeout(() => { pushW(); pushI(); }, 120);
    }
  }
}

test('deposit 回归①：换叠数量巧合不再误判「没动」（×1 叠跟 ×1 叠）', async () => {
  script('t-dep1.lua', `
    local clib = require "container_lib"
    task("dep", function()
      local w = clib.open({ x = 5, y = 64, z = 5 })
      __R_moved = clib.deposit(w, function(it) return it ~= nil end, math.huge)
      container.close(w)
    end)
    on_start(function() task.spawn("dep") end)
  `);
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, [], 27);
  driver.give(0, 'minecraft:diamond_pickaxe', 1);   // 首叠 ×1
  driver.give(6, 'minecraft:diamond', 1);           // 次叠恰好也是 ×1：旧实现 1==1 误判
  driver.give(7, 'minecraft:dirt', 3);
  const { engine } = await makeEngine({ scripts: ['t-dep1.lua'], driver });
  assert.ok(await waitFor(() => g(engine, '__R_moved') != null, 15000), 'deposit 未完成');
  assert.strictEqual(g(engine, '__R_moved'), 5, '全部 5 件应入箱（旧实现会停在 0）');
  const chest = driver.containerSlots.get('5,64,5');
  assert.strictEqual(chest.reduce((n, s) => n + (s?.count ?? 0), 0), 5, '箱内应有 5 件');
  assert.strictEqual(driver.inv.reduce((n, s) => n + (s?.count ?? 0), 0), 0, '背包应清空');
  await engine.stop();
});

test('deposit 回归②：快照慢同步（120ms）下多叠全量入箱', async () => {
  script('t-dep2.lua', `
    local clib = require "container_lib"
    task("dep", function()
      local w = clib.open({ x = 5, y = 64, z = 5 })
      __R_moved = clib.deposit(w, function(it) return it ~= nil end, math.huge)
      container.close(w)
    end)
    on_start(function() task.spawn("dep") end)
  `);
  const driver = new SlowSyncDriver();
  driver.slowSync = true;
  driver.setContainer({ x: 5, y: 64, z: 5 }, [], 27);
  for (let i = 0; i < 5; i++) driver.give(9 + i, 'minecraft:diamond', 64);
  const { engine } = await makeEngine({ scripts: ['t-dep2.lua'], driver });
  assert.ok(await waitFor(() => g(engine, '__R_moved') != null, 30000), 'deposit 未完成');
  assert.strictEqual(g(engine, '__R_moved'), 320, '5×64 应全部入箱');
  const chest = driver.containerSlots.get('5,64,5');
  assert.strictEqual(chest.reduce((n, s) => n + (s?.count ?? 0), 0), 320, '箱内应有 320 件');
  assert.strictEqual(driver.invCount('minecraft:diamond'), 0, '背包应清空');
  await engine.stop();
});

test('withdraw 回归：总量判定下精确取出仍成立（不回归旧用例语义）', async () => {
  script('t-wd.lua', `
    local clib = require "container_lib"
    task("wd", function()
      local w = clib.open({ x = 5, y = 64, z = 5 })
      __R_got = clib.withdraw(w, { id = "minecraft:pink_wool" }, 30)
      container.close(w)
    end)
    on_start(function() task.spawn("wd") end)
  `);
  const driver = new SlowSyncDriver();
  driver.slowSync = true;
  driver.setContainer({ x: 5, y: 64, z: 5 }, [[0, 'minecraft:pink_wool', 64], [1, 'minecraft:pink_wool', 64]]);
  const { engine } = await makeEngine({ scripts: ['t-wd.lua'], driver });
  assert.ok(await waitFor(() => g(engine, '__R_got') != null, 30000), 'withdraw 未完成');
  assert.strictEqual(g(engine, '__R_got'), 30, '精确取出 30');
  assert.strictEqual(driver.invCount('minecraft:pink_wool'), 30);
  await engine.stop();
});
