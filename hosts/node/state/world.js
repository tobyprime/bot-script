// 方块观测（实时优先，回落协议流缓存并标记 stale）
// cache 必须有界：服务器会持续推送 block_update（水/草/火/红石），无上限 Map 会让
// 长跑实例内存只增不减。保留最近 MAX_CACHE 个位置，旧位置查询回落到实时读取。
const MAX_CACHE = 4096;
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
    const key = posKey(pos);
    if (this.cache.has(key)) this.cache.delete(key);   // 重新插入 => LRU 顺序
    this.cache.set(key, { name, ts: this.now() });
    while (this.cache.size > MAX_CACHE) {
      this.cache.delete(this.cache.keys().next().value);
    }
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
