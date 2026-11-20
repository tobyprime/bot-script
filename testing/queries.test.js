// testing/queries.test.js — 查询数据面（实时性 / 活读 / 装备谓词）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';
import { WorldState } from '../hosts/node/state/world.js';

test('entity 查询是实时的：查询之间的目标移动立即可见（不经任何缓存层）', async () => {
  script('live-ent.lua', `
    __R_snaps = {}
    task('probe', { single = true }, function()
      for i = 1, 4 do
        local e = entity.nearest{ type = 'player', alive = true, within = 30 }
        __R_snaps[#__R_snaps + 1] = e and string.format('%.2f', e.pos.x) or 'nil'
        time.sleep(150)
      end
    end)
    on_start(function() task.spawn('probe') end)
  `);
  const driver = new MockDriver({ username: 'SelfBot', start: { x: 0, y: 64, z: 0 } });
  driver.addPlayer('Mover', { x: 1, y: 64, z: 0 });
  const { engine } = await makeEngine({ scripts: ['live-ent.lua'], driver });

  let moved = 0;
  for (let round = 0; round < 3; round++) {
    await waitFor(() => (g(engine, '__R_snaps') ?? []).length > moved, 3000);
    moved += 1;
    driver.movePlayer('Mover', { x: moved + 1, y: 64, z: 0 });
  }
  await waitFor(() => (g(engine, '__R_snaps') ?? []).length >= 4, 3000);
  const snaps = (g(engine, '__R_snaps') ?? []).map(String);
  assert.ok(new Set(snaps).size >= 3, `目标持续移动时每轮应读到新位置，实际读到 ${JSON.stringify(snaps)}`);
  await engine.stop();
});

test('entity 句柄活读：句柄字段每次访问都取当前值', async () => {
  script('halt-ent.lua', `
    __R = nil
    task('grab', { single = true }, function()
      local e = entity.nearest{ type = 'player', alive = true, within = 30 }
      if not e then __R = 'no-entity' return end
      __R = string.format('%.2f', e.pos.x)
      time.sleep(300)
      __R2 = string.format('%.2f', e.pos.x)
    end)
    on_start(function() task.spawn('grab') end)
  `);
  const driver = new MockDriver({ username: 'SelfBot', start: { x: 0, y: 64, z: 0 } });
  driver.addPlayer('Mover', { x: 1, y: 64, z: 0 });
  const { engine } = await makeEngine({ scripts: ['halt-ent.lua'], driver });
  await waitFor(() => g(engine, '__R') != null, 3000);
  const first = String(g(engine, '__R'));
  driver.movePlayer('Mover', { x: 7, y: 64, z: 0 });
  await waitFor(() => g(engine, '__R2') != null, 3000);
  assert.notStrictEqual(String(g(engine, '__R2')), first,
    `句柄字段应活读：拿到句柄后目标移动，再读应变（实际 ${first} → ${g(engine, '__R2')}）`);
  await engine.stop();
});

test('自身查询是实时的：移动后立刻读到新坐标（不经 200ms 推送缓存）', async () => {
  script('live-self.lua', `
    __R = nil
    task('probe', { single = true }, function()
      local before = string.format('%.2f', self.pos().x)
      time.sleep(250)
      local after = string.format('%.2f', self.pos().x)
      __R = before .. '|' .. after
    end)
    on_start(function() task.spawn('probe') end)
  `);
  const driver = new MockDriver({ username: 'SelfBot', start: { x: 0, y: 64, z: 0 } });
  const { engine } = await makeEngine({ scripts: ['live-self.lua'], driver });
  await new Promise((r) => setTimeout(r, 60));
  driver.botPos = { x: 12, y: 64, z: 0 };
  await waitFor(() => g(engine, '__R') != null, 3000);
  const [before, after] = String(g(engine, '__R')).split('|');
  assert.strictEqual(before, '0.00', '第一次读应是初始位置');
  assert.strictEqual(after, '12.00', `移动后应立即读到新坐标（实际 ${after}）`);
  await engine.stop();
});

test('方块查询实时优先：协议未推送也能读到当前方块，读到后标记非陈旧', async () => {
  script('live-block.lua', `
    __R = nil
    task('probe', { single = true }, function()
      local b = world.block({ x = 5, y = 64, z = 5 })
      __R = (b and b.id or 'nil') .. '|' .. tostring(b and b.stale)
    end)
    on_start(function() task.spawn('probe') end)
  `);
  const driver = new MockDriver({ username: 'SelfBot', start: { x: 0, y: 64, z: 0 } });
  driver.blocks.set('5,64,5', 'minecraft:chest');
  const { engine } = await makeEngine({ scripts: ['live-block.lua'], driver });
  await waitFor(() => g(engine, '__R') != null, 3000);
  const [name, stale] = String(g(engine, '__R')).split('|');
  assert.strictEqual(name, 'minecraft:chest', '实时查询应读到方块（缓存为空也不影响）');
  assert.strictEqual(stale, 'false', '实时命中不应标记为陈旧');
  await engine.stop();
});

test('entity.find 按装备名筛选：找戴钻石头盔的僵尸（不暴露槽位索引）', async () => {
  script('equip-find.lua', `
    __R = nil
    task('probe', { single = true }, function()
      local list = entity.find({ type = 'minecraft:zombie', equipment = { helmet = 'minecraft:diamond_helmet' } })
      local names = {}
      for _, e in ipairs(list) do names[#names + 1] = tostring(e.pos.x) end
      __R_found = #list
      __R_xs = table.concat(names, ',')
      local list2 = entity.find({
        type = 'minecraft:zombie',
        equipment = { helmet = 'minecraft:diamond_helmet', chestplate = false },
      })
      __R_found2 = #list2
      local one = entity.nearest({ type = 'minecraft:zombie', equipment = { helmet = 'minecraft:diamond_helmet' } })
      __R_helmet = one and one.equipment and one.equipment.helmet and one.equipment.helmet.id or 'nil'
    end)
    on_start(function() task.spawn('probe') end)
  `);
  const driver = new MockDriver({ username: 'SelfBot', start: { x: 0, y: 64, z: 0 } });
  driver.addEntity('minecraft:zombie', { x: 2, y: 64, z: 0 }, { equipment: { helmet: { id: 'minecraft:diamond_helmet', count: 1 } } });
  driver.addEntity('minecraft:zombie', { x: 4, y: 64, z: 0 }, { equipment: { helmet: { id: 'minecraft:iron_helmet', count: 1 } } });
  driver.addEntity('minecraft:zombie', { x: 6, y: 64, z: 0 }, { equipment: {} });
  driver.addEntity('minecraft:zombie', { x: 8, y: 64, z: 0 }, {
    equipment: {
      helmet: { id: 'minecraft:diamond_helmet', count: 1 },
      chestplate: { id: 'minecraft:diamond_chestplate', count: 1 },
    },
  });
  driver.addEntity('minecraft:skeleton', { x: 3, y: 64, z: 0 }, { equipment: { helmet: { id: 'minecraft:diamond_helmet', count: 1 } } });

  const { engine } = await makeEngine({ scripts: ['equip-find.lua'], driver });
  assert.ok(await waitFor(() => g(engine, '__R_found') != null && g(engine, '__R_helmet') != null, 5000), '查询应完成');
  assert.strictEqual(g(engine, '__R_found'), 2, '两个僵尸戴钻石头盔（x=2 与 x=8），骷髅不算');
  assert.strictEqual(String(g(engine, '__R_xs')), '2,8', '命中的是两个戴钻石头盔的僵尸');
  assert.strictEqual(g(engine, '__R_found2'), 1, '再要求不戴胸甲 → 只剩 x=2');
  assert.strictEqual(String(g(engine, '__R_helmet')), 'minecraft:diamond_helmet', 'e.equipment.helmet.id 应可读');
  await engine.stop();
});

test('entity 句柄装备按名字暴露：hand/offhand/boots/leggings/chestplate/helmet', async () => {
  script('equip-slots.lua', `
    __R = nil
    task('probe', { single = true }, function()
      local e = entity.nearest({ type = 'minecraft:zombie' })
      if not e then __R = 'no-entity' return end
      local parts = {}
      for _, k in ipairs({ 'hand', 'offhand', 'boots', 'leggings', 'chestplate', 'helmet' }) do
        local it = e.equipment and e.equipment[k]
        parts[#parts + 1] = k .. '=' .. (it and it.id or 'nil')
      end
      __R = table.concat(parts, ' ')
    end)
    on_start(function() task.spawn('probe') end)
  `);
  const driver = new MockDriver({ username: 'SelfBot', start: { x: 0, y: 64, z: 0 } });
  driver.addEntity('minecraft:zombie', { x: 2, y: 64, z: 0 }, {
    equipment: {
      hand: { id: 'minecraft:iron_sword', count: 1 },
      offhand: { id: 'minecraft:shield', count: 1 },
      boots: { id: 'minecraft:leather_boots', count: 1 },
      leggings: { id: 'minecraft:leather_leggings', count: 1 },
      chestplate: { id: 'minecraft:leather_chestplate', count: 1 },
      helmet: { id: 'minecraft:diamond_helmet', count: 1 },
    },
  });
  const { engine } = await makeEngine({ scripts: ['equip-slots.lua'], driver });
  await waitFor(() => g(engine, '__R') != null, 5000);
  const r = String(g(engine, '__R'));
  assert.ok(r.includes('helmet=minecraft:diamond_helmet'), `头盔应按名字可读，实际 ${r}`);
  assert.ok(r.includes('chestplate=minecraft:leather_chestplate'), `胸甲应可读，实际 ${r}`);
  assert.ok(r.includes('offhand=minecraft:shield'), `副手应可读，实际 ${r}`);
  await engine.stop();
});

test('world 观测缓存有界：持续 block_update 不得让 Map 只增不减', () => {
  const w = new WorldState();
  for (let i = 0; i < 6000; i++) w.onBlockChanged({ x: i, y: 64, z: 0 }, 'minecraft:stone');
  assert.ok(w.cache.size <= 4096, `cache 应有界，实际 ${w.cache.size}`);
  assert.ok(w.cache.has('5999,64,0'), '最近更新的位置必须保留');
});

test('entities.list 支持宿主侧过滤：高频 entity.nearest 不再序列化无关实体', async () => {
  const driver = new MockDriver({ username: 'SelfBot', start: { x: 0, y: 64, z: 0 } });
  driver.addPlayer('Near', { x: 3, y: 64, z: 3 }, null);
  for (let i = 0; i < 200; i++) {
    driver.addEntity('minecraft:zombie', { x: 20 + (i % 20), y: 64, z: 20 + Math.floor(i / 20) }, {});
  }
  const { engine } = await makeEngine({ scripts: [], driver });
  const raw = JSON.parse(engine.abi.sync('entities.list', '{"type":"player"}'));
  assert.ok(raw.ok, 'Result 应成功');
  assert.strictEqual(raw.value.length, 1, 'type=player 只应返回玩家');
  assert.strictEqual(raw.value[0].name, 'Near');
  const near = JSON.parse(engine.abi.sync('entities.list', '{"type":"player","within":10}'));
  assert.strictEqual(near.value.length, 1, 'within 过滤保留近处玩家');
  const far = JSON.parse(engine.abi.sync('entities.list', '{"type":"player","within":2}'));
  assert.strictEqual(far.value.length, 0, 'within 过滤应排除范围外玩家');
  await engine.stop();
});
