// testing/mock-driver.js — 进程内模拟 Minecraft 服务器/客户端（离线测试用）
// 实现与 mineflayer 驱动相同的事件/原语契约（ABI v2）。
import EventEmitter from 'node:events';

const NORM = (v) => ({ x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) });
const key = (p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
const CANON = (n) => (n && !n.includes(':') ? `minecraft:${n}` : n);
const STACK_MAX = (id) => (id === 'minecraft:iron_sword' || id === 'minecraft:diamond_sword' ? 1 : 64);

export class MockDriver {
  constructor({ start = { x: 0, y: 64, z: 0 }, username = 'TestBot', log = () => {} } = {}) {
    this.emitter = new EventEmitter();
    this.log = log;
    this.username = username;
    this.blocks = new Map();
    this.containerSlots = new Map();
    this.entities = new Map();
    this.nextEntityId = 1000;
    this.botPos = { ...start };
    this.botYaw = 0; this.botPitch = 0;
    this.botHealth = 20; this.botFood = 20;
    this.inv = new Array(36).fill(null);
    this.heldSlot = 0;
    this.currentWindow = null;
    this.windowSeq = 10;
    this.outgoingChat = [];
    this.outgoingCommands = [];
    this.gotoDelay = 0;
    this.lastInput = { forward: 0, right: 0, up: 0, sprint: false, sneak: false };
    this.usedItems = [];
  }

  on(evt, cb) { this.emitter.on(evt, cb); }
  emit(evt, p) { this.emitter.emit(evt, p); }

  caps() {
    return { 'nav.pathfinder': true, 'item.components': true, 'world.block_entity': true };
  }
  patches() { return []; }

  // ================= 测试侧 API =================
  setBlock(pos, name) {
    this.blocks.set(key(pos), name);
    if (name === 'chest' && !this.containerSlots.has(key(pos))) this.containerSlots.set(key(pos), new Array(27).fill(null));
    this.emit('block_update', { pos: NORM(pos), name });
  }
  setContainer(pos, slots, size = 27) {
    this.blocks.set(key(pos), 'chest');
    const arr = new Array(size).fill(null);
    slots.forEach(([i, id, count]) => { arr[i] = { id, count }; });
    this.containerSlots.set(key(pos), arr);
    this.emit('block_update', { pos: NORM(pos), name: 'chest' });
  }
  addPlayer(name, pos, held = null) {
    const id = this.nextEntityId++;
    this.entities.set(String(id), {
      id, uuid: `uuid-${id}`, type: 'player', name, pos: { ...pos }, velocity: { x: 0, y: 0, z: 0 },
      alive: true, health: null, yaw: 0, pitch: 0, effects: [], pose: 'standing',
      flags: { on_fire: false, sneaking: false, sprinting: false, invisible: false, glowing: false },
      equipment: { hand: held },
    });
    this.emit('entity_appeared', { id, type: 'player', name });
    return id;
  }
  addEntity(type, pos, opts = {}) {
    const id = this.nextEntityId++;
    this.entities.set(String(id), {
      id, uuid: `uuid-${id}`, type, name: opts.name ?? null, pos: { ...pos }, velocity: { x: 0, y: 0, z: 0 },
      alive: opts.alive !== false, health: null, yaw: 0, pitch: 0, effects: [], pose: 'standing',
      flags: { on_fire: false, sneaking: false, sprinting: false, invisible: false, glowing: false },
      equipment: opts.equipment ?? {},
    });
    this.emit('entity_appeared', { id, type, name: opts.name ?? null });
    return id;
  }
  setPlayerHeld(name, held) {
    for (const e of this.entities.values()) if (e.name === name) e.equipment = { hand: held };
  }
  movePlayer(name, pos) { for (const e of this.entities.values()) if (e.name === name) e.pos = { ...pos }; }
  removePlayer(name) {
    for (const [id, e] of [...this.entities]) {
      if (e.name === name) {
        this.entities.delete(id);
        this.emit('entity_gone', { id: e.id, type: e.type, name: e.name });
      }
    }
  }
  query_entities(filter = {}) {
    const wantType = filter.type == null ? null : String(filter.type);
    const within = filter.within == null ? null : Number(filter.within);
    return [...this.entities.values()].filter((e) => {
      if (wantType != null && String(e.type) !== wantType) return false;
      if (within != null && Number.isFinite(within) && e.pos) {
        const dx = e.pos.x - this.botPos.x, dy = e.pos.y - this.botPos.y, dz = e.pos.z - this.botPos.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > within) return false;
      }
      return true;
    });
  }
  query_entity(id) { return this.entities.get(String(id)) ?? null; }
  playerSay(name, text) {
    this.emit('chat', { text, raw: `<${name}> ${text}`, sender: name, sender_kind: 'player', ts: Date.now() });
  }
  serverSay(text) {
    this.emit('chat', { text, raw: text, sender: null, sender_kind: 'system', ts: Date.now() });
  }
  give(slot, id, count) { this.inv[slot] = { id, count, damage: null, max_damage: null, components: null }; this.pushInventory(); }
  invCount(id) { return this.inv.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0); }

  // ================= L1 =================
  pushInventory() { this.emit('window', this.invSnapshot()); }
  invSnapshot() {
    const slots = [];
    this.inv.forEach((item, idx) => { if (item) slots.push({ index: idx, item: { ...item } }); });
    return { id: '0', type: 'inventory', title: '背包', size: 36, state_id: null, slots, cursor: this.invCursor ? { ...this.invCursor } : null };
  }
  winSnapshot() {
    const w = this.currentWindow;
    const slots = [];
    const c = this.containerSlots.get(w.posKey);
    c.forEach((item, i) => { if (item) slots.push({ index: i, item: { ...item } }); });
    for (let k = 0; k < 27; k++) { const it = this.inv[9 + k]; if (it) slots.push({ index: w.size + k, item: { ...it } }); }
    for (let k = 0; k < 9; k++) { const it = this.inv[k]; if (it) slots.push({ index: w.size + 27 + k, item: { ...it } }); }
    return { id: String(w.id), type: 'chest', title: '箱子', size: w.size, state_id: null, slots, cursor: w.cursor ? { ...w.cursor } : null };
  }
  pushWindow() { if (this.currentWindow) this.emit('window', this.winSnapshot()); }

  // ================= L2 协议原语 =================
  async chat_send(text, kind = 'chat') {
    const out = (kind === 'command' || text.startsWith('/'))
      ? (text.startsWith('/') ? text : `/${text}`)
      : text;
    if (out.startsWith('/')) this.outgoingCommands.push(out);
    else this.outgoingChat.push(out);
  }

  async look(yaw, pitch) {
    this.rotCalls = (this.rotCalls ?? 0) + 1;
    if (yaw != null) this.botYaw = yaw;
    if (pitch != null) this.botPitch = pitch;
  }

  async input(state = {}) {
    this.lastInput = { forward: state.forward ?? 0, right: state.right ?? 0, up: state.up ?? 0, sprint: !!state.sprint, sneak: !!state.sneak };
  }

  async path_to(target, opts = {}) {
    const arrive = opts.arrive ?? 1.5;
    if (this.gotoDelay > 0) await new Promise((r) => setTimeout(r, this.gotoDelay));
    const dx = target.x - this.botPos.x, dz = target.z - this.botPos.z;
    const d = Math.hypot(dx, dz);
    if (d > arrive) this.botPos = { x: target.x - dx / d * arrive, y: target.y, z: target.z - dz / d * arrive };
    this.emit('self', this.selfSnapshot());
    return { ok: true };
  }
  selfSnapshot() {
    const held = this.inv[this.heldSlot];
    return {
      username: this.username,
      pos: { ...this.botPos },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: this.botYaw, pitch: this.botPitch,
      health: this.botHealth, food: this.botFood, gamemode: 'survival',
      held: held ? { ...held } : null,
      held_slot: this.heldSlot,
      pose: 'standing', on_fire: false, sneaking: false, sprinting: false,
      effects: [], attributes: { armor: null, absorption: 0, xp_level: 0, xp_progress: 0 },
    };
  }
  query_self() { return this.selfSnapshot(); }
  async path_cancel() { return; }

  async dig(pos, face = 1) {
    void face;
    const k = key(pos);
    if (this.blocks.has(k)) {
      this.blocks.delete(k);
      this.emit('block_update', { pos: NORM(pos), name: 'minecraft:air' });
    }
  }
  async dig_stop() { return; }

  async use_block(pos, face = 1, hand = 'main', cursor = null) {
    void face; void hand; void cursor;
    return;
  }

  async use_entity(id, kind, target, hand = 'main') {
    void kind; void target; void hand;
    this.lastEntityTarget = id;
  }

  async swing(hand = 'main') { void hand; }

  async use_item(phase, hand = 'main') {
    this.usedItems.push(`${hand}:${phase}`);
  }

  async select_slot(slot) { this.heldSlot = Number(slot); }

  async drop(slot, all = false) {
    if (slot == null) {
      if (this.inv[this.heldSlot]) {
        if (all) this.inv[this.heldSlot] = null;
        else {
          this.inv[this.heldSlot].count -= 1;
          if (this.inv[this.heldSlot].count <= 0) this.inv[this.heldSlot] = null;
        }
        this.pushInventory();
      }
      return;
    }
    const it = this.inv[slot];
    if (!it) return;
    if (all) this.inv[slot] = null;
    else { it.count -= 1; if (it.count <= 0) this.inv[slot] = null; }
    this.pushInventory();
  }

  async window_open(target) {
    if (this.currentWindow) {
      const old = this.currentWindow.id;
      this.currentWindow = null;
      this.emit('window_close', { id: String(old) });
    }
    const posKey = key(target);
    if (!this.containerSlots.has(posKey)) throw new Error(`container.missing: ${posKey}`);
    const id = ++this.windowSeq;
    this.currentWindow = { id, posKey, size: this.containerSlots.get(posKey).length, cursor: null };
    await new Promise((r) => setTimeout(r, 5));
    this.pushWindow();
    return { id: String(id) };
  }
  async window_close() {
    if (!this.currentWindow) return;
    const id = this.currentWindow.id;
    if (this.currentWindow.cursor) this.dropOrReturnCursor();
    this.currentWindow = null;
    this.emit('window_close', { id: String(id) });
    this.pushInventory();
  }
  dropOrReturnCursor() { this.currentWindow.cursor = null; }

  slotRef(w, slot) {
    const c = this.containerSlots.get(w.posKey);
    if (slot < w.size) return { arr: c, idx: slot };
    if (slot < w.size + 27) return { arr: this.inv, idx: 9 + (slot - w.size) };
    if (slot < w.size + 36) return { arr: this.inv, idx: slot - w.size - 27 };
    return null;
  }
  invRef(slot) { if (slot < 0 || slot > 40) return null; return { arr: this.inv, idx: slot }; }

  async window_click(windowId, slot, button, mode, stateId = null) {
    void stateId;
    if (windowId === '0') {
      const ref = this.invRef(slot);
      if (!ref) return;
      const cur = this.invCursor ?? null;
      if (mode === 0) {
        const it = this.inv[ref.idx];
        if (!cur) { if (it) { this.invCursor = { ...it }; this.inv[ref.idx] = null; } }
        else if (!it) {
          if (button === 1) { this.inv[ref.idx] = { id: cur.id, count: 1 }; cur.count -= 1; }
          else { this.inv[ref.idx] = { ...cur }; this.invCursor = null; }
        } else if (it.id === cur.id) {
          const max = STACK_MAX(it.id);
          const mv = button === 1 ? 1 : Math.min(cur.count, max - it.count);
          it.count += mv; cur.count -= mv;
        } else { this.inv[ref.idx] = { ...cur }; this.invCursor = { ...it }; }
        if (this.invCursor && this.invCursor.count <= 0) this.invCursor = null;
      } else if (mode === 2) {
        const other = this.invRef(button);
        const a = this.inv[ref.idx], b = this.inv[other.idx];
        this.inv[ref.idx] = b; this.inv[other.idx] = a;
      }
      this.pushInventory();
      return;
    }

    const w = this.currentWindow;
    if (!w) throw new Error('container.closed');
    const c = this.containerSlots.get(w.posKey);
    const getAt = (s) => { const r = this.slotRef(w, s); return r ? r.arr[r.idx] : undefined; };
    const setAt = (s, v) => { const r = this.slotRef(w, s); if (r) r.arr[r.idx] = v; };

    if (mode === 0) {
      if (slot === -999) {
        if (w.cursor) { if (button === 1 && w.cursor.count > 1) w.cursor.count -= 1; else w.cursor = null; }
      } else {
        const it = getAt(slot);
        if (!w.cursor) {
          if (it) {
            if (button === 1) {
              const half = Math.ceil(it.count / 2);
              w.cursor = { id: it.id, count: half };
              it.count -= half;
              if (it.count <= 0) setAt(slot, null);
            } else { w.cursor = it; setAt(slot, null); }
          }
        } else if (!it) {
          if (button === 1) { setAt(slot, { id: w.cursor.id, count: 1 }); w.cursor.count -= 1; }
          else { setAt(slot, { ...w.cursor }); w.cursor = null; }
        } else if (it.id === w.cursor.id) {
          const max = STACK_MAX(it.id);
          const mv = button === 1 ? 1 : Math.min(w.cursor.count, max - it.count);
          it.count += mv; w.cursor.count -= mv;
        } else { const tmp = { ...it }; setAt(slot, { ...w.cursor }); w.cursor = tmp; }
        if (w.cursor && w.cursor.count <= 0) w.cursor = null;
      }
    } else if (mode === 1) {
      const it = getAt(slot);
      if (it) {
        const inContainer = slot < w.size;
        const targetRefs = [];
        if (inContainer) {
          for (let k = 0; k < 27; k++) targetRefs.push({ arr: this.inv, idx: 9 + k });
          for (let k = 0; k < 9; k++) targetRefs.push({ arr: this.inv, idx: k });
        } else {
          for (let i = 0; i < w.size; i++) targetRefs.push({ arr: c, idx: i });
        }
        let left = it.count;
        const max = STACK_MAX(it.id);
        for (const r of targetRefs) {
          const t = r.arr[r.idx];
          if (t && t.id === it.id && t.count < max) {
            const mv = Math.min(left, max - t.count);
            t.count += mv; left -= mv;
            if (left <= 0) break;
          }
        }
        if (left > 0) {
          for (const r of targetRefs) {
            if (!r.arr[r.idx]) { r.arr[r.idx] = { id: it.id, count: left }; left = 0; break; }
          }
        }
        if (left <= 0) setAt(slot, null); else it.count = left;
      }
    } else if (mode === 2) {
      const it = getAt(slot);
      const hot = button >= 0 && button <= 8 ? button : null;
      if (hot != null) { const b = this.inv[hot]; this.inv[hot] = it ?? null; setAt(slot, b ?? null); }
    } else if (mode === 4) {
      if (slot === -999) w.cursor = null;
      else {
        const it = getAt(slot);
        if (it) { if (button === 1 || it.count === 1) setAt(slot, null); else it.count -= 1; }
      }
    } else {
      throw new Error(`mock 未实现 ClickType mode=${mode}`);
    }

    await new Promise((r) => setTimeout(r, 2));
    this.pushWindow();
    this.pushInventory();
  }

  // ================= 查询 =================
  block_info(pos) {
    const name = this.blocks.get(key(pos));
    if (!name) return null;
    return {
      id: CANON(name),
      properties: {},
      state_id: null,
      hardness: 1,
      block_entity: null,
      is_container: name === 'chest',
      stale: false,
    };
  }
  block_entity() { return null; }
  world_env() { return { dimension: 'overworld', time_of_day: 6000, weather: 'clear' }; }
  session_info() { return { version: '1.21.8', brand: 'mock', dimension: 'overworld', view_distance: 6, ping: 0, players: 1 }; }
  reach(pos, maxDistance = 4.5) {
    const d = Math.hypot(pos.x - this.botPos.x, pos.y - this.botPos.y, pos.z - this.botPos.z);
    return { reachable: d <= maxDistance, distance: d, hit_block: d <= maxDistance ? CANON(this.blocks.get(key(pos))) : null };
  }
  query_block_sync(pos) { return this.blocks.get(key(pos)) ?? null; }

  scan_blocks(region, kinds, limit) {
    const kindSet = new Set(kinds.map((k) => k.replace('minecraft:', '')));
    const [c1, c2] = region;
    const x1 = Math.min(c1.x, c2.x), x2 = Math.max(c1.x, c2.x);
    const y1 = Math.min(c1.y, c2.y), y2 = Math.max(c1.y, c2.y);
    const z1 = Math.min(c1.z, c2.z), z2 = Math.max(c1.z, c2.z);
    const out = [];
    for (const [k, name] of this.blocks) {
      if (!kindSet.has(name.replace('minecraft:', ''))) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2 && z >= z1 && z <= z2) {
        out.push({ x, y, z, id: CANON(name) });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  mountFile() {}
  async connect() {
    this.emit('session', { state: 'logged_in' });
    this.emit('session', { state: 'playing', info: { version: '1.21.8', brand: 'mock', dimension: 'overworld' } });
    this.emit('self', this.selfSnapshot());
    this.pushInventory();
  }
  async stop() {}
}
