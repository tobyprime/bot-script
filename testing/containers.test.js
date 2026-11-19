// testing/containers.test.js — 容器/背包编排（开箱、点击协议复合、bslib 搬运）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

test('container + bslib：withdraw 精确取出、deposit、move 多趟', async () => {
  script('t6.lua', `
    task("haul", function()
      local A = { x = 5, y = 64, z = 5 }
      local B = { x = 10, y = 64, z = 5 }
      local w = container.open(A)
      __R_type = w:type()
      __R_size = w:size()
      local got = bslib.withdraw(w, { id = "minecraft:pink_wool" }, 30)
      __R_withdrawn = got
      container.close(w)
      __R_inv_after_w = inv.count{ id = "minecraft:pink_wool" }
      local w2 = container.open(B)
      local put = bslib.deposit(w2, { id = "minecraft:pink_wool" }, got)
      __R_deposited = put
      container.close(w2)
      __R_moved = bslib.move(A, B, { id = "minecraft:pink_wool" })
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
