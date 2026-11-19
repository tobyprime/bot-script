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
    this.initSync(version);
  }

  setVersion(version) {
    const want = mcd ? resolveVersion(version) : '1.21.8';
    if (want === this.version && (this.items !== null || mcd === null)) return;
    this.version = want;
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

    const en = this.itemEnum(id);
    const components = Array.isArray(raw.components) && raw.components.length ? raw.components : null;

    // max_count：优先组件里的 max_stack_size，其次注册表默认，最后 64
    let maxCount = en?.stackSize ?? 64;
    let damage = raw.damage ?? raw.durabilityUsed ?? null;
    let maxDamage = raw.maxDurability ?? en?.maxDurability ?? null;
    let customName = raw.customName ?? null;
    let attributes = null;
    let enchantments = null;

    if (components) {
      const findComp = (suffix) => {
        const c = components.find((x) => String(x?.type ?? x?.name ?? '').split(':').pop() === suffix);
        return c ? (c.data ?? c.value ?? null) : null;
      };
      const mcs = findComp('max_stack_size');
      if (typeof mcs === 'number') maxCount = mcs;
      const md = findComp('max_damage');
      if (typeof md === 'number') maxDamage = md;
      const cn = findComp('custom_name');
      if (cn != null) customName = cn;
      const enchs = findComp('enchantments');
      if (enchs != null) enchantments = enchs;
      const attrs = findComp('attribute_modifiers');
      if (Array.isArray(attrs)) {
        // 网络组件形态：[{type/name, amount, operation, slot, id}]；只取通用属性
        attributes = {};
        for (const a of attrs) {
          const key = String(a?.type ?? a?.name ?? a?.id ?? '').split(':').pop();
          const amount = Number(a?.amount ?? a?.value ?? NaN);
          if (!Number.isFinite(amount)) continue;
          if (key === 'attack_damage') attributes.attack_damage = amount;
          else if (key === 'attack_speed') attributes.attack_speed = amount;
          else if (key === 'armor') attributes.armor = amount;
          else if (key === 'armor_toughness') attributes.armor_toughness = amount;
          else if (key === 'max_health') attributes.max_health = amount;
          else if (key === 'movement_speed') attributes.movement_speed = amount;
          else if (key === 'knockback_resistance') attributes.knockback_resistance = amount;
        }
        if (!Object.keys(attributes).length) attributes = null;
      }
    }

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
    if (!pred) return ['chest'];
    if (pred.type === 'container') return this.containerPaths();
    return pred.names ?? ['chest'];
  }
}

import { createRequire } from 'node:module';
DataRegistry.requireFn = createRequire(import.meta.url);
