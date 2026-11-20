// testing/data.test.js — ItemStack 组件真值（ABI v2：不再按 id 猜堆叠/攻击）
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from './registry.js';
import { DataRegistry } from '../hosts/node/data.js';

const VECTOR = (v) => JSON.parse(readFileSync(new URL(`../contracts/vectors/data/items.${v}.json`, import.meta.url), 'utf8'));

// 旧规则（engine.js 12-39 逐字复制）：证明它确实算错，作为「不许回退」的护栏
const STACK16 = new Set(['minecraft:snowball', 'minecraft:egg', 'minecraft:honey_bottle', 'minecraft:sign',
  'minecraft:oak_sign', 'minecraft:spruce_sign', 'minecraft:birch_sign', 'minecraft:acacia_sign',
  'minecraft:dark_oak_sign', 'minecraft:mangrove_sign', 'minecraft:cherry_sign', 'minecraft:bamboo_sign',
  'minecraft:crimson_sign', 'minecraft:warped_sign', 'minecraft:banner', 'minecraft:white_banner']);
const STACK1_PREFIX = ['minecraft:wooden_', 'minecraft:stone_', 'minecraft:iron_', 'minecraft:golden_',
  'minecraft:diamond_', 'minecraft:netherite_'];
const STACK1 = new Set(['minecraft:fishing_rod', 'minecraft:bow', 'minecraft:crossbow', 'minecraft:trident',
  'minecraft:mace', 'minecraft:shield', 'minecraft:elytra', 'minecraft:saddle', 'minecraft:bucket',
  'minecraft:water_bucket', 'minecraft:lava_bucket', 'minecraft:milk_bucket', 'minecraft:powder_snow_bucket',
  'minecraft:shears', 'minecraft:flint_and_steel', 'minecraft:compass', 'minecraft:clock',
  'minecraft:totem_of_undying']);
function oldStackSize(id) {
  if (!id || !id.startsWith('minecraft:')) return 64;
  if (STACK16.has(id)) return 16;
  if (STACK1.has(id)) return 1;
  if (STACK1_PREFIX.some((p) => id.startsWith(p))) return 1;
  return 64;
}

test('data-parity：三版本默认 stack 的 max_count 与 minecraft-data 一致（旧启发式仍判错上百项）', () => {
  for (const v of ['1.21.8', '1.21.4', '1.20.1']) {
    const reg = new DataRegistry({ version: v });
    assert.ok(reg.registry, `${v}: 应拿到注册表`);
    const vec = VECTOR(v);
    let bad = 0;
    let oldBad = 0;
    const samples = [];
    for (const [name, size] of Object.entries(vec.items)) {
      const id = `minecraft:${name}`;
      const got = reg.stack({ id }).max_count;
      if (got !== size) { bad++; if (samples.length < 8) samples.push(`${name}: ${got} != ${size}`); }
      if (oldStackSize(id) !== size) oldBad++;
    }
    assert.strictEqual(bad, 0, `${v}: 默认 stack 判错 ${bad} 项 ${samples.join('; ')}`);
    assert.ok(oldBad > 100, `${v}: 旧启发式应判错上百项（实际 ${oldBad}），复核向量是否退化`);
  }
});

test('item.stack：组件动态覆盖 max_count / max_damage / 属性（不再按 id 写死）', () => {
  const reg = new DataRegistry({ version: '1.21.8' });
  // 默认组件
  assert.strictEqual(reg.stack({ id: 'minecraft:iron_ingot' }).max_count, 64);
  assert.strictEqual(reg.stack({ id: 'minecraft:shulker_box' }).max_count, 1);
  assert.strictEqual(reg.stack({ id: 'minecraft:diamond_sword' }).max_damage, 1561);
  // 组件覆盖（1.20.5+ 的物品组件可动态改堆叠数/最大耐久）
  const dyn = reg.stack({
    id: 'minecraft:diamond_sword', count: 1, damage: 3,
    components: [
      { type: 'minecraft:max_stack_size', data: 16 },
      { type: 'minecraft:max_damage', data: 100 },
      { type: 'minecraft:attribute_modifiers', data: [
        { type: 'minecraft:attack_damage', amount: 9 },
        { type: 'minecraft:attack_speed', amount: 1.2 },
      ] },
    ],
  });
  assert.strictEqual(dyn.max_count, 16, 'max_stack_size 组件应覆盖默认 1');
  assert.strictEqual(dyn.max_damage, 100, 'max_damage 组件应覆盖默认 1561');
  assert.strictEqual(dyn.damage, 3, '已损耗值应透传');
  assert.strictEqual(dyn.attributes.attack_damage, 9);
  assert.strictEqual(dyn.attributes.attack_speed, 1.2);
  assert.deepStrictEqual(dyn.components.length, 3, '原始组件应保留');
});

test('data：容器方块表补齐 1.21.8 新容器', () => {
  const reg = new DataRegistry({ version: '1.21.8' });
  for (const n of ['crafter', 'chiseled_bookshelf', 'decorated_pot', 'lectern']) {
    assert.ok(reg.isContainerName(`minecraft:${n}`), `${n} 应判为容器`);
  }
  assert.ok(reg.isContainerName('minecraft:chest'));
  assert.ok(reg.isContainerName('minecraft:red_shulker_box'));
  assert.ok(!reg.isContainerName('minecraft:stone'));
  assert.deepStrictEqual(reg.scanKinds({ type: 'container' }), reg.containerPaths());
  assert.deepStrictEqual(reg.scanKinds({ names: ['minecraft:chest'] }), ['minecraft:chest']);
});

test('data：world.scan 的未知谓词必须显式失败（不得静默降级成 chest）', () => {
  const reg = new DataRegistry({ version: '1.21.8' });
  assert.throws(() => reg.scanKinds({ type: 'chest' }), (e) => e.kind === 'abi.invalid_args');
  assert.throws(() => reg.scanKinds({ names: [] }), (e) => e.kind === 'abi.invalid_args');
});

test('data：组件解析按数组对象缓存（同一物品重复展开不重复扫描）', () => {
  const reg = new DataRegistry({ version: '1.21.8' });
  const components = [{ type: 'minecraft:max_stack_size', data: 16 }];
  const p1 = reg.parseComponents(components);
  const p2 = reg.parseComponents(components);
  assert.strictEqual(p1, p2, '同一 components 数组应命中同一解析结果');
  const raw = { id: 'minecraft:stone', count: 1, components };
  const a = reg.stack(raw);
  const b = reg.stack({ ...raw });
  assert.strictEqual(a.max_count, 16);
  assert.strictEqual(b.max_count, 16);
});

test('lua data.stack：读到 stack 的 max_count/属性，而不是 id 写死值', async () => {
  const { makeEngine, script, g, waitFor } = await import('./harness.js');
  script('data.lua', `
    on_start(function()
      local iron = data.stack({ id = "minecraft:iron_ingot" })
      __R_iron = iron.max_count
      local shulker = data.stack({ id = "minecraft:shulker_box" })
      __R_shulker = shulker.max_count
      local held = data.stack({ id = "minecraft:diamond_sword", count = 1,
        components = { { type = "minecraft:max_stack_size", data = 16 } } })
      __R_dyn = held.max_count
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['data.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_iron') != null, 3000));
  assert.strictEqual(g(engine, '__R_iron'), 64);
  assert.strictEqual(g(engine, '__R_shulker'), 1);
  assert.strictEqual(g(engine, '__R_dyn'), 16, '组件覆盖应经 Lua 可见');
  await engine.stop();
});
