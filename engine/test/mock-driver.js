// engine/test/mock-driver.js — 进程内模拟 Minecraft 服务器/客户端（离线测试用）
// 实现与 mineflayer 驱动相同的事件/动词契约；点击语义模拟 vanilla ClickType 主路径。
import EventEmitter from 'node:events';

const NORM = (v) => ({ x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) });
const key = (p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
const STACK_MAX = (id) => (id === 'minecraft:iron_sword' || id === 'minecraft:diamond_sword' ? 1 : 64);

export class MockDriver {
  constructor({ start = { x: 0, y: 64, z: 0 }, username = 'TestBot', log = () => {} } = {}) {
    this.emitter = new EventEmitter();
    this.log = log;
    this.username = username;
    // 世界
    this.blocks = new Map();       // key -> block name
    this.containerSlots = new Map(); // key -> Array(size) of {id,count}|null
    this.entities = new Map();     // id -> snapshot
    this.nextEntityId = 1000;
    // bot 自身
    this.botPos = { ...start };
    this.botYaw = 0; this.botPitch = 0;
    this.botHealth = 20; this.botFood = 20;
    this.inv = new Array(36).fill(null);   // 0-8 hotbar, 9-35 main
    this.heldSlot = 0;
    // 窗口会话
    this.currentWindow = null;     // {id, posKey, size, cursor}
    this.windowSeq = 10;
    this.outgoingChat = [];
    this.outgoingCommands = [];
    this.gotoDelay = 0;            // path_to 模拟行走耗时 ms
    this.gotoSpeed = null;
  }

  on(evt, cb) { this.emitter.on(evt, cb); }
  emit(evt, p) { this.emitter.emit(evt, p); }

  caps() {
    return {
      'nav.pathfinder': true, 'world_stream': false,
      'entity.equipment': true, 'entity.holding': true,
      'input.move': true, 'window.click_authentic': false, 'hud.full': false,
    };
  }

  // ================= 测试侧 API =================

  setBlock(pos, name) {
    this.blocks.set(key(pos), name);
    if (name === 'chest' && !this.containerSlots.has(key(pos))) {
      this.containerSlots.set(key(pos), new Array(27).fill(null));
    }
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
      id, type: 'player', name, pos: { ...pos }, alive: true, health: null,
      equipment: { hand: held },
    });
    this.emit('entity_appeared', { id, type: 'player', name });
    return id;
  }
  // 任意实体（含装备）：type 用规范 id（如 'minecraft:zombie'），equipment 用部件名
  addEntity(type, pos, opts = {}) {
    const id = this.nextEntityId++;
    this.entities.set(String(id), {
      id, type, name: opts.name ?? null, pos: { ...pos }, alive: opts.alive !== false,
      health: null, equipment: opts.equipment ?? {},
    });
    this.emit('entity_appeared', { id, type, name: opts.name ?? null });
    return id;
  }
  setPlayerHeld(name, held) {
    for (const e of this.entities.values()) {
      if (e.name === name) { e.equipment = { hand: held }; }
    }
  }
  movePlayer(name, pos) {
    for (const e of this.entities.values()) {
      if (e.name === name) e.pos = { ...pos };
    }
  }
  removePlayer(name) {
    for (const [id, e] of [...this.entities]) {
      if (e.name === name) {
        this.entities.delete(id);
        this.emit('entity_gone', { id: e.id, type: e.type, name: e.name });
      }
    }
  }
  // 实时查询（与 mineflayer 驱动同契约：直读当前状态，无快照层）
  query_entities() {
    return [...this.entities.values()];
  }
  query_entity(id) {
    return this.entities.get(String(id)) ?? null;
  }
  playerSay(name, text) {
    this.emit('chat', { text, raw: `<${name}> ${text}`, sender: name, sender_kind: 'player', ts: Date.now() });
  }
  serverSay(text) {
    this.emit('chat', { text, raw: text, sender: null, sender_kind: 'system', ts: Date.now() });
  }
  give(slot, id, count) {
    this.inv[slot] = { id, count };
    this.pushInventory();
  }
  invCount(id) {
    return this.inv.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0);
  }

  // ================= L1 =================

  pushInventory() {
    this.emit('window', this.invSnapshot());
  }

  invSnapshot() {
    const slots = [];
    this.inv.forEach((item, idx) => { if (item) slots.push({ index: idx, item: { ...item } }); });
    return { id: '0', type: 'inventory', title: '背包', size: 36, slots, cursor: this.invCursor ? { ...this.invCursor } : null };
  }

  // 窗口模型：容器 [0,size) + 主背包 [size,size+26)（inv 9-35）+ 快捷栏 [size+27,size+35)（inv 0-8）
  winSnapshot() {
    const w = this.currentWindow;
    const slots = [];
    const c = this.containerSlots.get(w.posKey);
    c.forEach((item, i) => { if (item) slots.push({ index: i, item: { ...item } }); });
    for (let k = 0; k < 27; k++) {
      const it = this.inv[9 + k];
      if (it) slots.push({ index: w.size + k, item: { ...it } });
    }
    for (let k = 0; k < 9; k++) {
      const it = this.inv[k];
      if (it) slots.push({ index: w.size + 27 + k, item: { ...it } });
    }
    return {
      id: String(w.id), type: w.size === 54 ? 'chest' : 'chest', title: '箱子',
      size: w.size, slots, cursor: w.cursor ? { ...w.cursor } : null,
    };
  }

  pushWindow() {
    if (this.currentWindow) this.emit('window', this.winSnapshot());
  }

  // ================= L2 动词 =================

  async chat_send(text) {
    if (text.startsWith('/')) this.outgoingCommands.push(text);
    else this.outgoingChat.push(text);
  }

  async rot(yaw, pitch) {
    // 记录发包次数：原版客户端每 tick 最多发一个 looking 包，
    // 高频瞄准时若每轮发两个（yaw/pitch 分开），服务器会判 invalid_player_movement
    this.rotCalls = (this.rotCalls ?? 0) + 1;
    if (yaw != null) this.botYaw = yaw;
    if (pitch != null) this.botPitch = pitch;
  }

  async hop() { /* 模拟：无操作 */ }

  async move_input() { /* 模拟：直线导航控制器内部自算，无真实物理 */ }

  async path_to(target, opts = {}) {
    const arrive = opts.arrive ?? 1.5;
    if (this.gotoDelay > 0) await new Promise((r) => setTimeout(r, this.gotoDelay));
    // 模拟走到目标附近
    const dx = target.x - this.botPos.x, dz = target.z - this.botPos.z;
    const d = Math.hypot(dx, dz);
    if (d > arrive) {
      this.botPos = { x: target.x - dx / d * arrive, y: target.y, z: target.z - dz / d * arrive };
    }
    this.emit('self', this.selfSnapshot());
    return { ok: true };
  }

  selfSnapshot() {
    const held = this.inv[this.heldSlot];
    return {
      username: this.username,
      pos: { ...this.botPos }, yaw: this.botYaw, pitch: this.botPitch,
      health: this.botHealth, food: this.botFood, gamemode: 'survival',
      held: held ? { ...held } : null, heldSlot: this.heldSlot,
    };
  }
  // 实时自身查询（与 mineflayer 驱动同契约）
  query_self() {
    return this.selfSnapshot();
  }

  async path_cancel() { return; }

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

  dropOrReturnCursor() {
    // 简化：光标物品直接消失（真实服务器会尝试放回/掉落）
    this.currentWindow.cursor = null;
  }

  slotRef(w, slot) {
    // 返回 {arr, idx}：数组 + 索引（写入点）
    const c = this.containerSlots.get(w.posKey);
    if (slot < w.size) return { arr: c, idx: slot };
    if (slot < w.size + 27) return { arr: this.inv, idx: 9 + (slot - w.size) };
    if (slot < w.size + 36) return { arr: this.inv, idx: slot - w.size - 27 };
    return null;
  }

  invRef(slot) {
    if (slot < 0 || slot > 40) return null;
    return { arr: this.inv, idx: slot };
  }

  async window_click(windowId, slot, button, mode) {
    if (windowId === '0') {
      // 背包直点（无容器）：mode 0/1/2 作用于 inv 数组
      const w = { size: 36, cursor: null, posKey: '__inv__' };
      const ref = this.invRef(slot);
      if (!ref) return;
      const cur = this.invCursor ?? null;
      if (mode === 0) {
        const it = this.inv[ref.idx];
        if (!cur) {
          if (it) { this.invCursor = { ...it }; this.inv[ref.idx] = null; }
        } else if (!it) {
          if (button === 1) {
            this.inv[ref.idx] = { id: cur.id, count: 1 };
            cur.count -= 1;
          } else {
            this.inv[ref.idx] = { ...cur }; this.invCursor = null;
          }
        } else if (it.id === cur.id) {
          const max = STACK_MAX(it.id);
          const mv = button === 1 ? 1 : Math.min(cur.count, max - it.count);
          it.count += mv; cur.count -= mv;
        } else {
          this.inv[ref.idx] = { ...cur }; this.invCursor = { ...it };
        }
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
    const getAt = (s) => {
      const r = this.slotRef(w, s);
      return r ? r.arr[r.idx] : undefined;
    };
    const setAt = (s, v) => {
      const r = this.slotRef(w, s);
      if (r) r.arr[r.idx] = v;
    };

    if (mode === 0) {
      // pickup / place（button 1 = 右键）
      if (slot === -999) {
        if (w.cursor) {
          if (button === 1 && w.cursor.count > 1) w.cursor.count -= 1;
          else w.cursor = null;
        }
      } else {
        const it = getAt(slot);
        if (!w.cursor) {
          if (it) {
            if (button === 1) {
              // 右键拿半叠
              const half = Math.ceil(it.count / 2);
              w.cursor = { id: it.id, count: half };
              it.count -= half;
              if (it.count <= 0) setAt(slot, null);
            } else {
              w.cursor = it; setAt(slot, null);
            }
          }
        } else if (!it) {
          if (button === 1) {
            setAt(slot, { id: w.cursor.id, count: 1 });
            w.cursor.count -= 1;
          } else {
            setAt(slot, { ...w.cursor }); w.cursor = null;
          }
        } else if (it.id === w.cursor.id) {
          const max = STACK_MAX(it.id);
          const mv = button === 1 ? 1 : Math.min(w.cursor.count, max - it.count);
          it.count += mv; w.cursor.count -= mv;
        } else {
          const tmp = { ...it }; setAt(slot, { ...w.cursor }); w.cursor = tmp;
        }
        if (w.cursor && w.cursor.count <= 0) w.cursor = null;
      }
    } else if (mode === 1) {
      // quick_move：容器 <-> 背包
      const it = getAt(slot);
      if (it) {
        const inContainer = slot < w.size;
        const targetRefs = [];
        if (inContainer) {
          for (let k = 0; k < 27; k++) targetRefs.push({ arr: this.inv, idx: 9 + k });  // 主背包
          for (let k = 0; k < 9; k++) targetRefs.push({ arr: this.inv, idx: k });        // 快捷栏
        } else {
          for (let i = 0; i < w.size; i++) targetRefs.push({ arr: c, idx: i });
        }
        let left = it.count;
        const max = STACK_MAX(it.id);
        for (const r of targetRefs) {   // 先并入同类
          const t = r.arr[r.idx];
          if (t && t.id === it.id && t.count < max) {
            const mv = Math.min(left, max - t.count);
            t.count += mv; left -= mv;
            if (left <= 0) break;
          }
        }
        if (left > 0) {
          for (const r of targetRefs) {
            if (!r.arr[r.idx]) {
              r.arr[r.idx] = { id: it.id, count: left };
              left = 0; break;
            }
          }
        }
        if (left <= 0) setAt(slot, null);
        else { it.count = left; }
      }
    } else if (mode === 2) {
      // swap：button = hotbar 索引（0-8）或 40（副手，模拟忽略）
      const it = getAt(slot);
      const hot = button >= 0 && button <= 8 ? button : null;
      if (hot != null) {
        const b = this.inv[hot];
        this.inv[hot] = it ?? null;
        setAt(slot, b ?? null);
      }
    } else if (mode === 4) {
      // throw
      if (slot === -999) { w.cursor = null; }
      else {
        const it = getAt(slot);
        if (it) {
          if (button === 1 || it.count === 1) setAt(slot, null);
          else it.count -= 1;
        }
      }
    } else {
      throw new Error(`mock 未实现 ClickType mode=${mode}`);
    }

    await new Promise((r) => setTimeout(r, 2));
    this.pushWindow();
    this.pushInventory();   // 引擎合并视图实时性
  }

  async use_entity() { /* 模拟 */ }
  async use_block() { /* 模拟 */ }
  async use_item() { /* 模拟 */ }
  async dig() { /* 模拟 */ }
  async respawn() { /* 模拟 */ }

  // ================= 查询 =================

  query_block_sync(pos) { return this.blocks.get(key(pos)) ?? null; }

  async query_scan(region, kinds, limit) {
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
        out.push({ x, y, z });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  // 引擎可能调用的其它接口
  mountFile() {}
  async connect() {
    this.emit('session', { state: 'logged_in' });
    this.emit('session', { state: 'playing', info: { version: '1.21.8', brand: 'mock' } });
    this.emit('self', this.selfSnapshot());
    this.pushInventory();
  }
  async stop() {}
}
