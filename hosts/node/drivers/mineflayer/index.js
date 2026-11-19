// hosts/node/drivers/mineflayer/index.js — mineflayer 驱动（进程内；协议 = 函数调用）
// L0 连接（mineflayer 代劳）+ L1 数据面（通道翻译）+ L2 协议原语 + L3 pathfinder。
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { serviceDegToBotYaw, shortestYaw } from './units.js';
import { reasonText } from './reason.js';
import { installProtocolTrace } from './protocolTrace.js';
import { installPatches } from './patches/index.js';

const NORM = (v) => ({ x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) });
const CANON = (name) => (name && !name.includes(':') ? `minecraft:${name}` : name);
// ItemStack 紧凑形态（组件保留原始引用，由 data.stack 展开）
const itemOf = (it) => (it ? {
  id: CANON(it.name),
  count: it.count,
  damage: it.durabilityUsed ?? null,
  max_damage: it.maxDurability ?? null,
  components: Array.isArray(it.components) && it.components.length ? it.components : null,
} : null);

const require = createRequire(import.meta.url);

const DIRS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];

export class MineflayerDriver {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.handlers = new Map();
    this.bot = null;
    this.cfg = {};
    this.windowSeq = 1;
    this.selfDirty = false;
    this.pathWait = null;
    this.alive = false;
    this.transportErrLogged = false;
  }

  on(evt, cb) {
    (this.handlers[evt] = this.handlers[evt] ?? []).push(cb);
  }
  emit(evt, payload) {
    for (const cb of this.handlers[evt] ?? []) {
      try { cb(payload); } catch (e) { this.log(`[${this.constructor.name}] handler ${evt} 出错: ${e.message}`); }
    }
  }

  caps() {
    return {
      'nav.pathfinder': true,
      'item.components': true,     // prismarine-item 保留网络组件
      'world.block_entity': true,  // block.entity（方块 NBT）
    };
  }

  /** /caps：已应用的版本适配补丁 */
  patches() {
    return this._patchRuntime?.applied ?? [];
  }

  async connect(cfg) {
    this.cfg = cfg;
    this.alive = false;
    this.transportErrLogged = false;
    const mineflayer = (await import('mineflayer')).default;
    const pfMod = await import('mineflayer-pathfinder');
    const pf = pfMod.default ?? pfMod;
    this.pf = typeof pf === 'function' ? pf : pf.pathfinder;
    this.pfMod = pf;
    const acct = cfg.account ?? {};
    const vd = Math.max(2, Math.min(12, Number(cfg.viewDistance) || 6));
    const botOpts = {
      host: cfg.host ?? '127.0.0.1',
      port: cfg.port ?? 25565,
      username: acct.username ?? 'bot',
      version: cfg.version ?? undefined,
      hideErrors: false,
      settings: { viewDistance: vd },
      clientSettings: { viewDistance: vd },
    };
    if (acct.auth === 'session') {
      botOpts.auth = (client, options) => {
        const profile = { id: acct.uuid, name: acct.username };
        options.haveCredentials = true;
        options.accessToken = acct.accessToken;
        client.session = { accessToken: acct.accessToken, selectedProfile: profile, availableProfiles: [profile] };
        client.username = acct.username;
        client.emit('session', client.session);
        options.connect(client);
      };
    } else if (acct.password) {
      botOpts.password = acct.password;
      botOpts.auth = 'microsoft';
    } else if (acct.uuid) {
      botOpts.auth = (client, options) => {
        client.session = { selectedProfile: { id: acct.uuid, name: acct.username } };
        client.username = acct.username;
        options.connect(client);
      };
    } else {
      botOpts.auth = 'offline';
    }
    const bot = mineflayer.createBot(botOpts);
    this.bot = bot;

    this.trace = installProtocolTrace(bot, (line, level) => this.log(line, level ?? 'debug'));
    this._patchRuntime = installPatches(bot, { version: cfg.version, log: (line) => this.log(line, 'info') });

    bot._client.on('add_resource_pack', (p) => {
      bot._client.write('resource_pack_receive', { uuid: p.uuid, result: 3 });
      bot._client.write('resource_pack_receive', { uuid: p.uuid, result: 0 });
    });

    bot.once('login', () => this.emit('session', { state: 'logged_in' }));
    bot.once('spawn', () => {
      this.alive = true;
      this.emit('session', {
        state: 'playing',
        info: {
          version: bot.version, brand: bot.game?.brand ?? 'vanilla',
          dimension: bot.game?.dimension, view_distance: bot.game?.serverViewDistance,
        },
      });
      this.startSampling();
      this.bindChat();
      this.bindWorld();
    });
    bot.on('kicked', (reason) => {
      this.alive = false;
      const text = reasonText(reason).slice(0, 500);
      this.trace?.flush(`kicked: ${text}`);
      this.emit('session', { state: 'kicked', reason: text });
    });
    bot.on('end', (reason) => {
      this.alive = false;
      this.stopSampling();
      const text = reasonText(reason).slice(0, 500);
      this.trace?.flush(`disconnected: ${text}`);
      this.emit('session', { state: 'disconnected', reason: text });
    });
    bot.on('error', (e) => {
      this.alive = false;
      const code = e?.code ?? '';
      if (code === 'EPIPE' || code === 'ECONNRESET') {
        if (!this.transportErrLogged) {
          this.transportErrLogged = true;
          this.log(`[mineflayer] 连接已断开（${code}）：对端关闭了连接，具体原因见 kick/end 事件`, 'debug');
        }
        return;
      }
      this.log(`[mineflayer] error: ${e.message}`);
    });

    bot.loadPlugin(this.pf);
    const Movements = this.pfMod.Movements;
    bot.once('spawn', () => {
      bot.physics.yawSpeed = 20;
      bot.physics.pitchSpeed = 20;
      const movements = new Movements(bot, bot.registry);
      movements.allowSprinting = true;
      movements.allowParkour = true;
      movements.canDig = false;
      movements.canPlace = false;
      bot.pathfinder.setMovements(movements);
    });
    bot.on('goal_reached', () => this.pathWait?.({ ok: true }));
    bot.on('path_update', (r) => {
      if (r.status === 'noPath') this.pathWait?.({ ok: false, reason: 'unreachable' });
      else if (r.status === 'timeout') this.pathWait?.({ ok: false, reason: 'timeout' });
    });
    bot.on('path_stop', () => this.pathWait?.({ ok: false, reason: 'cancelled' }));
  }

  async stop() {
    this.stopSampling();
    this.teardownBot();
    try { this.bot?.quit(); } catch { /* ignore */ }
  }

  async reconnect(cfg) {
    this.stopSampling();
    this.teardownBot();
    this.bot = null;
    await this.connect(cfg);
  }

  teardownBot() {
    const b = this.bot;
    if (!b) return;
    try { this.trace?.off(); } catch { /* ignore */ }
    this.trace = null;
    try { this._patchRuntime?.uninstall(); } catch { /* ignore */ }
    this._patchRuntime = null;
    try { b.removeAllListeners(); } catch { /* ignore */ }
    try { b._client?.removeAllListeners?.(); } catch { /* ignore */ }
    try { b._client?.end?.(); } catch { /* ignore */ }
    try { b.end(); } catch { /* ignore */ }
  }

  // ================= L1 数据面 =================

  startSampling() {
    const bot = this.bot;
    this.selfTimer = setInterval(() => this.pushSelf(), 200);
    bot.on('forcedMove', () => this.pushSelf());
    bot.on('health', () => this.pushSelf());
    bot.on('entitySwingArm', () => this.pushSelf());
    bot.on('entitySpawn', (e) => {
      if (e === bot.entity) return;
      const s = this.snapshotOf(e);
      this.emit('entity_appeared', { id: s.id, type: s.type, name: s.name });
    });
    bot.on('entityGone', (e) => {
      if (e === bot.entity) return;
      const isPlayer = e.type === 'player';
      this.emit('entity_gone', { id: e.id, type: isPlayer ? 'player' : `minecraft:${e.name ?? e.type}`, name: e.username ?? null });
    });
    this.pushInventory();
    bot.on('spawn', () => this.pushInventory());
    bot.on('windowOpen', (win) => {
      win?.on?.('update', () => this.pushWindowsDirty());
      this.pushWindowsDirty();
    });
    bot.inventory?.on?.('update', () => this.pushWindowsDirty());
    bot.on('blockUpdate', (oldBlock, newBlock) => {
      if (newBlock) this.emit('block_update', { pos: NORM(newBlock.position ?? oldBlock?.position), name: CANON(newBlock.name) });
    });
    bot.on('death', () => this.emit('death', {}));
    bot.on('respawn', () => this.emit('respawn', {}));
    bot.on('damage', () => this.emit('damaged', {}));
  }

  stopSampling() {
    clearInterval(this.selfTimer);
    clearInterval(this.windowTimer);
  }

  selfSnapshot() {
    const bot = this.bot;
    if (!bot?.entity) return null;
    const e = bot.entity;
    const effects = Object.values(e.effects ?? {}).map((x) => ({
      id: x.id ?? x.effectId ?? null,
      amplifier: x.amplifier ?? 0,
      duration: x.duration ?? 0,
    }));
    return {
      username: bot.username ?? null,
      pos: { x: e.position.x, y: e.position.y, z: e.position.z },
      velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
      yaw: (e.yaw * 180) / Math.PI,
      pitch: (e.pitch * 180) / Math.PI,
      health: bot.health, food: bot.food,
      gamemode: bot.game?.gameMode,
      held: itemOf(bot.heldItem),
      held_slot: bot.quickBarSlot ?? 0,
      pose: e.pose ?? null,
      on_fire: e.onFire ?? null,
      sneaking: e.sneaking ?? null,
      sprinting: e.sprinting ?? null,
      effects,
      attributes: {
        armor: null,   // Node 无完整属性表（组件可读时由 data.stack 提供物品属性）
        absorption: bot.entity?.absorption ?? null,
        xp_level: bot.experience?.level ?? null,
        xp_progress: bot.experience?.progress ?? null,
      },
      ping: bot.players?.[bot.username]?.ping ?? null,
    };
  }

  // 实时查询（直读 bot.entity，不经缓存）
  query_self() {
    return this.selfSnapshot();
  }

  pushSelf() {
    const s = this.query_self();
    if (!s) return;
    const inv = [];
    for (const it of this.bot.inventory?.items() ?? []) {
      if (it.slot >= 9 && it.slot <= 44) {
        inv.push({ slot: it.slot, id: it.name, count: it.count, name: it.displayName ?? it.name });
      }
    }
    this.emit('self', { ...s, inv });
  }

  snapshotOf(e) {
    const isPlayer = e.type === 'player';
    const eq = e.equipment ?? [];
    return {
      id: e.id,
      uuid: e.uuid ?? null,
      type: isPlayer ? 'player' : `minecraft:${e.name ?? e.type}`,
      name: e.username ?? (isPlayer ? null : e.name),
      pos: e.position ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
      velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
      yaw: typeof e.yaw === 'number' ? (e.yaw * 180) / Math.PI : null,
      pitch: typeof e.pitch === 'number' ? (e.pitch * 180) / Math.PI : null,
      alive: e.isValid !== false,
      health: null,
      effects: Object.values(e.effects ?? {}).map((x) => ({
        id: x.id ?? x.effectId ?? null, amplifier: x.amplifier ?? 0, duration: x.duration ?? 0,
      })),
      equipment: {
        hand: itemOf(eq[0] ?? e.heldItem),
        offhand: itemOf(eq[1]),
        boots: itemOf(eq[2]),
        leggings: itemOf(eq[3]),
        chestplate: itemOf(eq[4]),
        helmet: itemOf(eq[5]),
      },
      pose: e.pose ?? null,
      flags: {
        on_fire: e.onFire ?? null,
        sneaking: e.sneaking ?? null,
        sprinting: e.sprinting ?? null,
        invisible: e.invisible ?? null,
        glowing: e.glowing ?? null,
      },
      vehicle_id: e.vehicle?.id != null ? String(e.vehicle.id) : null,
    };
  }

  query_entities() {
    const bot = this.bot;
    if (!bot?.entities) return [];
    const out = [];
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position) continue;
      out.push(this.snapshotOf(e));
    }
    return out;
  }

  query_entity(id) {
    const e = this.bot?.entities?.[id];
    if (!e || e === this.bot.entity || !e.position) return null;
    return this.snapshotOf(e);
  }

  bindChat() {
    const bot = this.bot;
    bot.on('message', (jsonMsg, position, sender) => {
      const raw = jsonMsg.toString();
      if (!raw) return;
      let senderName = null;
      let kind = 'system';
      let text = raw;
      if (sender && bot.players[sender]?.username) {
        senderName = bot.players[sender].username;
        kind = 'player';
        text = raw.replace(/^<[^>]+>\s*/, '');
      } else {
        const m = raw.match(/^[<\[]([^\]>\s]+)[>\]]\s*(.*)$/s);
        if (m) { senderName = m[1]; kind = 'player'; text = m[2]; }
        else {
          const w = raw.match(/^(\S+) (?:whispers to you:|whispers:)\s*(.*)$/s)
                 ?? raw.match(/^你悄悄对 (\S+) 说: (.*)$/s);
          if (w) { senderName = w[1]; kind = 'player'; text = w[2]; }
        }
      }
      if (senderName === bot.username) return;
      this.emit('chat', { text, raw, sender: senderName, sender_kind: kind, ts: Date.now() });
    });
  }

  bindWorld() {
    const bot = this.bot;
    bot.on('windowOpen', (win) => this.pushWindow(win));
    bot.on('closeWindow', (win) => {
      this.emit('window_close', { id: String(win.id) });
      if (win.id === 0) this.scheduleInventoryPush();
    });
    let dirty = false;
    this.pushWindowsDirty = () => { dirty = true; };
    this.windowTimer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      if (bot.currentWindow && bot.currentWindow.id !== 0) this.pushWindow(bot.currentWindow);
      else this.pushInventory();
    }, 50);
    bot.inventory?.on?.('update', () => { dirty = true; });
    bot.on('spawn', () => {
      bot.inventory?.on?.('update', () => { dirty = true; });
      this.pushInventory();
    });
  }

  windowSnapshot(win) {
    const typeStr = String(win.type ?? '');
    const isInv = typeStr.includes('inventory');
    const size = isInv ? 36 : Math.max(0, win.slots.length - 36);
    const slots = [];
    win.slots.forEach((item, idx) => {
      if (!item) return;
      if (isInv) {
        // mineflayer 玩家背包布局 -> 契约布局：36-44 hotbar→0-8；9-35 main；5-8 armor→36-39；45 offhand→40
        let e = null;
        if (idx >= 36 && idx <= 44) e = idx - 36;
        else if (idx >= 9 && idx <= 35) e = idx;
        else if (idx >= 5 && idx <= 8) e = idx + 31;
        else if (idx === 45) e = 40;
        if (e != null) slots.push({ index: e, item: itemOf(item) });
      } else {
        slots.push({ index: idx, item: itemOf(item) });
      }
    });
    return {
      id: String(win.id),
      type: isInv ? 'inventory' : typeStr.replace('minecraft:', ''),
      title: typeof win.title === 'string' ? win.title : JSON.stringify(win.title ?? ''),
      size,
      state_id: win.stateId ?? null,   // mineflayer 不暴露服务端同步号时为空
      slots,
      cursor: win.cursorItem ? itemOf(win.cursorItem) : null,
    };
  }

  pushWindow(win) {
    if (!win) return;
    this.emit('window', this.windowSnapshot(win));
  }

  scheduleInventoryPush() { setTimeout(() => this.pushInventory(), 30); }

  pushInventory() {
    const bot = this.bot;
    if (!bot?.inventory) return;
    this.emit('window', this.windowSnapshot(bot.inventory));
  }

  // ================= L2 协议原语 =================

  get connected() {
    return this.alive && !!this.bot?.entity && !this.bot?._client?.socket?.destroyed;
  }

  async chat_send(text, kind = 'chat') {
    if (!this.connected) return;
    const isCommand = kind === 'command' || text.startsWith('/');   // reply 有 msg_command 时自带前导 /
    this.bot.chat(isCommand && !text.startsWith('/') ? `/${text}` : text);
  }

  // 原版 rotation 包：force=false，限速推进；不 await（等到位会把脚本循环压到 ~7Hz）
  look(yaw, pitch) {
    if (!this.connected) return;
    const curYaw = this.bot.entity.yaw;
    let botYaw = curYaw;
    if (yaw != null) botYaw = shortestYaw(serviceDegToBotYaw(yaw), curYaw);
    const botPitch = pitch == null ? this.bot.entity.pitch : Math.max(-Math.PI / 2, Math.min(Math.PI / 2, (-pitch * Math.PI) / 180));
    this.bot.look(botYaw, botPitch, false).catch(() => { /* 发包期临时错误不冒泡到动作层 */ });
  }

  // 原版 player_input 状态位（有符号轴向；0 = 停）
  async input(state = {}) {
    if (!this.connected) return;
    const fwd = Number(state.forward ?? 0);
    const right = Number(state.right ?? 0);
    const b = this.bot;
    b.setControlState('forward', fwd > 0);
    b.setControlState('back', fwd < 0);
    b.setControlState('right', right > 0);
    b.setControlState('left', right < 0);
    b.setControlState('jump', Number(state.up ?? 0) > 0);
    b.setControlState('sneak', !!state.sneak);
    b.setControlState('sprint', !!state.sprint);
  }

  async path_to(target, opts = {}) {
    if (!this.connected) return { ok: false, reason: 'disconnected' };
    const GoalNear = (this.pfMod.goals ?? this.pfMod).GoalNear;
    const arrive = Math.max(0, Math.round(opts.arrive ?? 1.5));
    this.bot.pathfinder.setGoal(new GoalNear(target.x, target.y, target.z, arrive));
    const result = await new Promise((resolve) => { this.pathWait = resolve; });
    this.pathWait = null;
    return result;
  }

  async path_cancel() {
    if (!this.pathWait) {
      try { this.bot.pathfinder?.stop?.(); } catch { this.bot.pathfinder?.setGoal?.(null); }
      return;
    }
    const w = this.pathWait;
    this.pathWait = null;
    try { this.bot.pathfinder?.stop?.(); } catch { this.bot.pathfinder?.setGoal?.(null); }
    w({ ok: false, reason: 'cancelled' });
  }

  async window_open(target) {
    let win;
    if (target.entity != null) {
      const e = this.bot.entities[target.entity];
      if (!e) throw new Error('entity 不存在');
      win = await this.bot.openEntity(e);
    } else {
      const block = this.bot.blockAt(new Vec3(target.x, target.y, target.z));
      if (!block) {
        throw new Error(`方块未加载 ${JSON.stringify(target)}（bot@${this.bot.entity?.position ?? '?'}, cols=${Object.keys(this.bot.world?.getColumns?.() ?? {}).length}）`);
      }
      if (block.name === 'chest' || block.name === 'trapped_chest') win = await this.bot.openChest(block);
      else win = await this.bot.openContainer(block);
    }
    this.pushWindow(win);
    return { id: String(win.id) };
  }

  async window_close() {
    const win = this.bot.currentWindow;
    if (win && win.id !== 0) {
      await this.bot.closeWindow(win);
      this.emit('window_close', { id: String(win.id) });
      this.pushInventory();
    }
  }

  engineInvToMineflayer(slot) {
    if (slot >= 0 && slot <= 8) return 36 + slot;
    if (slot >= 9 && slot <= 35) return slot;
    if (slot >= 36 && slot <= 39) return 5 + (slot - 36);
    if (slot === 40) return 45;
    return slot;
  }

  async window_click(windowId, slot, button, mode, stateId = null) {
    void stateId;   // mineflayer clickWindow 自行携带最新同步号
    if (String(windowId) === '0') slot = this.engineInvToMineflayer(slot);
    const bot = this.bot;
    const snap = (w) => JSON.stringify(w.slots.map((s) => (s ? [s.name, s.count] : 0)));
    for (let attempt = 0; attempt < 4; attempt++) {
      const win = bot.currentWindow;
      if (!win || win.id === 0) break;
      const before = snap(win);
      await Promise.race([bot.clickWindow(slot, button, mode), new Promise((r) => setTimeout(r, 2000))]);
      await new Promise((r) => setTimeout(r, 250));
      if (snap(win) !== before) return;
    }
  }

  // ---- 协议动作（按原版包建模） ----

  async dig(pos, face = 1) {
    const block = this.bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) throw new Error(`方块未加载 ${JSON.stringify(pos)}`);
    await this.bot.dig(block, false, face);
  }

  async dig_stop() { this.bot.stopDigging(); }

  async use_block(pos, face = 1, hand = 'main', cursor = null) {
    const block = this.bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) throw new Error(`方块未加载 ${JSON.stringify(pos)}`);
    const dir = DIRS[Number(face) % 6] ?? DIRS[1];
    const cur = cursor && cursor.x !== undefined
      ? new Vec3(Number(cursor.x), Number(cursor.y), Number(cursor.z))
      : null;
    await this.bot.activateBlock(block, dir, cur);
    void hand;   // mineflayer block_place 固定主手；副手交互由 use_item 覆盖
  }

  async use_entity(id, kind, target, hand = 'main') {
    const e = this.bot.entities[id];
    if (!e) throw new Error(`实体 ${id} 不存在`);
    if (kind === 'attack') await this.bot.attack(e);
    else if (kind === 'interact_at') {
      const t = target ?? { x: e.position.x, y: e.position.y, z: e.position.z };
      await this.bot.activateEntityAt(e, new Vec3(t.x, t.y, t.z));
    } else await this.bot.activateEntity(e);
    void hand;
  }

  async swing(hand = 'main') {
    this.bot.swingArm(hand === 'offhand' ? 'left' : 'right');
  }

  async use_item(phase, hand = 'main') {
    if (phase === 'release') await this.bot.deactivateItem();
    else await this.bot.activateItem(hand === 'offhand');
  }

  async select_slot(slot) {
    this.bot.setQuickBarSlot(Number(slot));
  }

  async drop(slot, all = false) {
    const bot = this.bot;
    if (slot == null) {
      const held = bot.heldItem;
      if (!held) return;
      if (all) await bot.tossStack(held);
      else await bot.toss(held.type, held.metadata, 1);
      return;
    }
    const invSlot = slot >= 0 && slot <= 35 ? this.engineInvToMineflayer(slot) : slot;
    const item = bot.inventory?.slots?.[invSlot];
    if (!item) return;
    if (all) await bot.tossStack(item);
    else await bot.toss(item.type, item.metadata, 1);
  }

  async respawn() {
    this.bot.respawn();
  }

  // ================= 查询 =================

  query_block_sync(pos) {
    const b = this.bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
    return b?.name ?? null;
  }

  block_info(pos) {
    const bot = this.bot;
    const b = bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
    if (!b) return null;
    let props = null;
    try { props = b.getProperties?.() ?? null; } catch { props = null; }
    return {
      id: CANON(b.name),
      properties: props,
      state_id: b.stateId ?? null,
      hardness: b.hardness ?? null,
      is_container: false,   // 由宿主数据层（DataRegistry）填
      block_entity: b.entity ? { type: CANON(b.entity?.value?.id?.value ?? b.entity?.name ?? 'unknown'), data: null } : null,
    };
  }

  block_entity(pos) {
    const b = this.bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
    if (!b?.entity) return null;
    try {
      const nbt = require('prismarine-nbt');
      const data = nbt.simplify ? nbt.simplify(b.entity) : b.entity;
      return { type: CANON(b.entity?.value?.id?.value ?? b.entity?.name ?? 'unknown'), data };
    } catch {
      return { type: 'unknown', data: null, snbt: String(b.entity) };
    }
  }

  reach(pos, maxDistance = 4.5) {
    const bot = this.bot;
    const b = bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
    if (!b || !bot.entity) return { reachable: false, distance: null, hit_block: null };
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const center = b.position.offset(0.5, 0.5, 0.5);
    const distance = eye.distanceTo(center);
    let reachable = false;
    try { reachable = bot.canSeeBlock(b) && distance <= maxDistance; } catch { reachable = false; }
    return { reachable, distance, hit_block: reachable ? CANON(b.name) : null };
  }

  world_env() {
    const bot = this.bot;
    if (!bot) return { dimension: null, time_of_day: null, weather: null };
    const weather = bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear';
    return {
      dimension: bot.game?.dimension ?? null,
      time_of_day: typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay : null,
      weather,
    };
  }

  session_info() {
    const bot = this.bot;
    return {
      version: bot?.version ?? null,
      brand: bot?.game?.brand ?? null,
      dimension: bot?.game?.dimension ?? null,
      view_distance: bot?.game?.serverViewDistance ?? null,
      ping: bot?.players?.[bot.username]?.ping ?? null,
      players: bot ? Object.keys(bot.players ?? {}).length : null,
    };
  }

  scan_blocks(region, kinds, limit) {
    const bot = this.bot;
    if (!bot) return [];
    const kindSet = new Set(kinds.map((k) => k.replace('minecraft:', '')));
    const [c1, c2] = region;
    const x1 = Math.min(c1.x, c2.x), x2 = Math.max(c1.x, c2.x);
    const y1 = Math.min(c1.y, c2.y), y2 = Math.max(c1.y, c2.y);
    const z1 = Math.min(c1.z, c2.z), z2 = Math.max(c1.z, c2.z);
    const center = new Vec3((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    const maxDistance = Math.ceil(Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2 + (z2 - z1) ** 2) / 2) + 2;
    const found = bot.findBlocks({
      point: center,
      maxDistance,
      count: limit * 2,
      useExtraInfo: true,
      matching: (block) => kindSet.has(block.name),
    }) ?? [];
    return found
      .map((p) => ({ x: p.x, y: p.y, z: p.z, id: CANON(bot.blockAt(p)?.name ?? null) }))
      .filter((p) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2 && p.z >= z1 && p.z <= z2)
      .slice(0, limit);
  }

  async window_refresh() { this.pushInventory(); }
}
