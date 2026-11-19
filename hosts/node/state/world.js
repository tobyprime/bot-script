// hosts/node/state/world.js — 方块观测（实时优先，回落协议流缓存并标记 stale）
export function posKey(p) { return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`; }
export function normalizePos(p) {
  if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] };
  return { x: +p.x, y: +p.y, z: +p.z };
}

export class WorldState {
  constructor({ driver, data, now = Date.now } = {}) {
    this.driver = driver;
    this.data = data;
    this.now = now;
    this.cache = new Map();   // posKey -> {name, ts}
  }

  /** 事件进：world.block_changed */
  onBlockChanged(pos, name) {
    if (!pos || !name) return;
    this.cache.set(posKey(pos), { name, ts: this.now() });
  }

  /** 查询出：实时优先；实时不可用才回落缓存（并标记 stale） */
  block(pos) {
    if (!pos) return null;
    const key = posKey(pos);
    const live = this.driver?.query_block_sync?.(pos) ?? null;
    let hit = null;
    let stale = false;
    if (live) {
      hit = { name: live, ts: this.now() };
      this.cache.set(key, hit);
    } else {
      hit = this.cache.get(key);
      stale = !!hit;
    }
    if (!hit) return null;
    return {
      name: hit.name,
      is_container: this.data?.isContainerName?.(hit.name) ?? false,
      ts: hit.ts,
      stale,
    };
  }

  stalenessMs(pos) {
    const hit = this.cache.get(posKey(pos));
    return hit ? this.now() - hit.ts : -1;
  }

  clear() { this.cache.clear(); }
}
