// hosts/node/data.js — ItemStack 数据（组件真值）与方块/容器注册表事实
//
// v2：不再按 item id 猜堆叠数/攻击力。容量与属性从 **stack** 读：
//   Node 侧 stack 来自 prismarine-item（含网络 components / maxDurability / durabilityUsed）；
//   没有组件时回落到 minecraft-data 的默认值（明确标记来源，不冒充组件真值）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(HERE, '..', '..', 'contracts', 'data');
const CONTAINERS = JSON.parse(readFileSync(path.join(CONTRACTS, 'containers.json'), 'utf8'));
const CONTAINER_SET = new Set(CONTAINERS.paths);

let mcd = null;
const dbCache = new Map();

export function resolveVersion(version) {
  if (!mcd) return '1.21.8';
  const list = mcd.versions?.pc?.map((v) => v.minecraftVersion) ?? [];
  if (!version) return '1.21.8';
  if (list.includes(version)) return version;
  const num = (v) => v.split('.').map((x) => Number(x.replace(/[^0-9]/g, '')) || 0);
  const target = num(version);
  let best = null;
  let bestDist = Infinity;
  for (const v of list) {
    const a = num(v);
    const dist = Math.abs((a[0] ?? 0) - (target[0] ?? 0)) * 1e6
      + Math.abs((a[1] ?? 0) - (target[1] ?? 0)) * 1e3
      + Math.abs((a[2] ?? 0) - (target[2] ?? 0));
    if (dist < bestDist) { best = v; bestDist = dist; }
  }
  return best ?? '1.21.8';
}

const CANON = (name) => {
  if (!name) return null;
  return String(name).includes(':') ? String(name) : `minecraft:${name}`;
};

export class DataRegistry {
  constructor({ version, log = () => {} } = {}) {
    this.log = log;
    this.version = null;
    this.items = null;       // Map<name, {stackSize,maxDurability,enchantCategories}>
    this.registry = false;
    this.idStatic = new Map();   // CANON id -> {maxCount, maxDamage}（注册表只读，跨调用缓存）
    this.compCache = new WeakMap(); // components 数组对象 -> 解析结果（同一物品重复展开时命中）
    this.initSync(version);
  }

  setVersion(version) {
    const want = mcd ? resolveVersion(version) : '1.21.8';
    if (want === this.version && (this.items !== null || mcd === null)) return;
    this.version = want;
    this.idStatic = new Map();
    const cache = dbCache.get(want);
    if (cache) { this.items = cache.items; this.registry = !!cache.items; return; }
    try {
      const d = mcd(want);
      const map = new Map();
      for (const it of Object.values(d.items)) {
        map.set(it.name, {
          stackSize: it.stackSize,
          maxDurability: it.maxDurability ?? null,
          enchantCategories: it.enchantCategories ?? null,
        });
      }
      dbCache.set(want, { items: map });
      this.items = map;
      this.registry = true;
    } catch (e) {
      this.log('warn', `data registry 不可用（${want}）：${e.message}`);
      dbCache.set(want, { items: null });
      this.items = null;
      this.registry = false;
    }
  }

  initSync(version) {
    try {
      const req = DataRegistry.requireFn;
      const mod = req('minecraft-data');
      mcd = mod.default ?? mod;
      this.setVersion(version);
      return this.registry;
    } catch (e) {
      this.log('warn', `data registry 初始化失败：${e.message}`);
      return false;
    }
  }

  itemEnum(id) {
    const name = String(id ?? '').replace(/^minecraft:/, '');
    return this.items?.get(name) ?? null;
  }

  /** 注册表默认值（只读）：按 id 缓存，避免每个槽重复查 minecraft-data。 */
  staticOf(id) {
    let hit = this.idStatic.get(id);
    if (hit) return hit;
    const en = this.itemEnum(id);
    hit = { maxCount: en?.stackSize ?? 64, maxDamage: en?.maxDurability ?? null };
    this.idStatic.set(id, hit);
    return hit;
  }

  /**
   * 组件解析（每个 components 数组只解析一次）：
   * 网络组件形态 [{type|name, data|value}]，只需一次遍历建索引，替代 5 次线性 findComp。
   */
  parseComponents(components) {
    let hit = this.compCache.get(components);
    if (hit) return hit;
    const by = new Map();
    for (const c of components) {
      const key = String(c?.type ?? c?.name ?? '').split(':').pop();
      if (key && !by.has(key)) by.set(key, c?.data ?? c?.value ?? null);
    }
    const parsed = {
      maxCount: typeof by.get('max_stack_size') === 'number' ? by.get('max_stack_size') : null,
      maxDamage: typeof by.get('max_damage') === 'number' ? by.get('max_damage') : null,
      customName: by.has('custom_name') ? by.get('custom_name') : null,
      enchantments: by.has('enchantments') ? by.get('enchantments') : null,
      attributes: null,
    };
    const attrs = by.get('attribute_modifiers');
    if (Array.isArray(attrs)) {
      const out = {};
      for (const a of attrs) {
        const key = String(a?.type ?? a?.name ?? a?.id ?? '').split(':').pop();
        const amount = Number(a?.amount ?? a?.value ?? NaN);
        if (!Number.isFinite(amount)) continue;
        if (key === 'attack_damage') out.attack_damage = amount;
        else if (key === 'attack_speed') out.attack_speed = amount;
        else if (key === 'armor') out.armor = amount;
        else if (key === 'armor_toughness') out.armor_toughness = amount;
        else if (key === 'max_health') out.max_health = amount;
        else if (key === 'movement_speed') out.movement_speed = amount;
        else if (key === 'knockback_resistance') out.knockback_resistance = amount;
      }
      if (Object.keys(out).length) parsed.attributes = out;
    }
    // 输入是调用方给的数组；WeakMap 以数组对象为键：同一物品被重复展开时直接命中
    this.compCache.set(components, parsed);
    return parsed;
  }

  /**
   * ItemStack 归一化（组件真值优先）：
   *   stack 可以是 {id,name,count,maxDurability,durabilityUsed,components,nbt...}
   *          或窗口/实体里的紧凑 item（id,count）
   * 输出契约 StackInfo；拿不到的字段为 null，不造假。
   */
  stack(input) {
    const raw = (input && typeof input === 'object') ? input : { id: input };
    const id = CANON(raw.id ?? raw.name);
    if (!id) return { id: null, count: 0, max_count: null, max_damage: null, damage: null, components: null, attributes: null, enchantments: null, custom_name: null };

    const st = this.staticOf(id);
    const components = Array.isArray(raw.components) && raw.components.length ? raw.components : null;
    const parsed = components ? this.parseComponents(components) : null;

    // max_count：优先组件里的 max_stack_size，其次注册表默认，最后 64
    let maxCount = parsed?.maxCount ?? st.maxCount;
    let damage = raw.damage ?? raw.durabilityUsed ?? null;
    let maxDamage = parsed?.maxDamage ?? raw.maxDurability ?? raw.max_damage ?? st.maxDamage;
    let customName = parsed?.customName ?? raw.customName ?? null;
    const attributes = parsed?.attributes ?? null;
    const enchantments = parsed?.enchantments ?? null;

    return {
      id,
      count: Number(raw.count ?? 1),
      max_count: maxCount,
      max_damage: maxDamage,
      damage,
      components,
      attributes,
      enchantments,
      custom_name: customName,
    };
  }

  containerPaths() { return [...CONTAINER_SET]; }
  isContainerName(namespaced) {
    return CONTAINER_SET.has(String(namespaced ?? '').replace('minecraft:', ''));
  }
  scanKinds(pred) {
    if (!pred || (typeof pred === 'object' && Object.keys(pred).length === 0)) return ['chest'];
    const keys = Object.keys(pred);
    if (keys.length === 1 && pred.type === 'container') return this.containerPaths();
    if (keys.length === 1 && Array.isArray(pred.names) && pred.names.length) {
      return pred.names.map((n) => String(n));
    }
    // 静默吞掉未知谓词会把「过滤生效」说成谎：显式失败（PERF-REFACTOR §2.2-5）
    const e = new Error(`world.scan: 不支持的 pred ${JSON.stringify(pred)}（支持 {type="container"} 或 {names=[...]}`);
    e.kind = 'abi.invalid_args';
    throw e;
  }
}

import { createRequire } from 'node:module';
DataRegistry.requireFn = createRequire(import.meta.url);
