// 实体快照必须能处理真实 prismarine-entity 对象（isValid 是布尔属性，不是方法）。
// 线上事故：snapshotOf 里写 `e.isValid?.(this.bot)`，对布尔值调用必抛
// "e.isValid is not a function" → worker 崩溃 → host 跟着挂 → agent 报「worker 退出 code=0」。
// 之前的 mock 驱动没有 isValid 字段，测不到这条路径，所以必须用真对象覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 直接构造真实 prismarine-entity 实例（与 mineflayer 运行时同一份实现）
const makeRealEntity = async (id = 42) => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const minecraftDataMod = require('minecraft-data');
  const md = minecraftDataMod.default ?? minecraftDataMod;
  const registry = md('1.21.8');
  const Entity = require('prismarine-entity')(registry);
  const e = new Entity(id);
  e.position = { x: 1, y: 64, z: 2 };
  e.username = 'RealBot';
  e.type = 'player';
  return e;
};

test('snapshotOf 接受真实 prismarine-entity：isValid 是布尔属性，不得当函数调用', async () => {
  const { MineflayerDriver } = await import('../../drivers/mineflayer/index.js');
  const d = new MineflayerDriver({ log: () => {} });
  const e = await makeRealEntity();

  // isValid 的真实形态
  assert.equal(typeof e.isValid, 'boolean', 'isValid 应是布尔属性');

  // 核心断言：这条调用在一个真实实体上不得抛错
  let snap;
  assert.doesNotThrow(() => { snap = d.snapshotOf(e); },
    'snapshotOf 处理真实实体时不得抛错（线上 "isValid is not a function" 即此）');
  assert.equal(snap.id, 42);
  assert.equal(snap.name, 'RealBot');
  assert.equal(snap.type, 'player');
  assert.equal(snap.alive, true, 'isValid=true 应映射为 alive=true');
  assert.deepEqual(snap.pos, { x: 1, y: 64, z: 2 });
  assert.ok(snap.equipment && 'helmet' in snap.equipment, '装备六件套应按名字暴露');
});

test('snapshotOf：isValid=false 的实体映射为 alive=false', async () => {
  const { MineflayerDriver } = await import('../../drivers/mineflayer/index.js');
  const d = new MineflayerDriver({ log: () => {} });
  const e = await makeRealEntity(7);
  e.isValid = false;
  const snap = d.snapshotOf(e);
  assert.equal(snap.alive, false);
});
