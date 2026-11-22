// hosts/node/drivers/mineflayer/index.js — mineflayer 驱动（进程内；协议 = 函数调用）
// L0 连接（mineflayer 代劳）+ L1 数据面（通道翻译）+ L2 协议原语 + L3 pathfinder。
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { serviceDegToBotYaw, shortestYaw } from './units.js';
import { classifyChat } from './chat-classify.js';
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

// 自定义网络包（custom payload / 插件消息）单包上限：与服务端自定义载荷上限对齐。
// 入站超限直接丢弃（不把异常大包塞进事件 JSON/Lua 堆），出站由 ABI 层先拒。
const CUSTOM_PAYLOAD_MAX = 1 << 20;

const DIRS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];

// 宿主侧谓词：直接在实体对象上判定，避免为每条候选构造完整快照（PERF-REFACTOR §3.3）
const SLOT_INDEX = { hand: 0, offhand: 1, boots: 2, leggings: 3, chestplate: 4, helmet: 5 };
const entityTypeOf = (e) => {
  const raw = String(e.type ?? '');
  return raw === 'player' ? 'player' : (raw.includes(':') ? raw : `minecraft:${e.name ?? raw}`);
};
const entityNameOf = (e) => (e.type === 'player' ? (e.username ?? null) : (e.name ?? null));
const equipOf = (e, slot) => {
  const i = SLOT_INDEX[slot];
  return i === 0 ? (e.equipment?.[0] ?? e.heldItem ?? null) : (e.equipment?.[i] ?? null);
};
const dist2 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

function rawPredMatch(e, pred, selfPos) {
  if (pred.type != null && entityTypeOf(e) !== String(pred.type)) return false;
  if (pred.name != null && entityNameOf(e) !== pred.name) return false;
  if (pred.uuid != null && (e.uuid ?? null) !== pred.uuid) return false;
  if (pred.alive != null && (e.isValid !== false) !== !!pred.alive) return false;
  if (pred.region) {
    const p = e.position, [r1, r2] = pred.region;
    if (!p || !r1 || !r2) return false;
    const x1 = Math.min(r1.x, r2.x), x2 = Math.max(r1.x, r2.x);
    const y1 = Math.min(r1.y, r2.y), y2 = Math.max(r1.y, r2.y);
    const z1 = Math.min(r1.z, r2.z), z2 = Math.max(r1.z, r2.z);
    if (p.x < x1 || p.x > x2 || p.y < y1 || p.y > y2 || p.z < z1 || p.z > z2) return false;
  }
  if (pred.within != null) {
    if (!selfPos || !e.position || dist2(selfPos, e.position) > Number(pred.within) ** 2) return false;
  }
  if (pred.holding != null) {
    const it = equipOf(e, 'hand');
    if (!(it && CANON(it.name) === pred.holding)) return false;
  }
  if (pred.equipment) {
    for (const [slot, want] of Object.entries(pred.equipment)) {
      const got = equipOf(e, slot);
      if (want === false) {
        if (got) return false;
      } else if (typeof want === 'string') {
        if (!(got && CANON(got.name) === want)) return false;
      }
    }
  }
  return true;
}

/**
 * 组装 mineflayer createBot 选项（连接层契约 {host, port, version, account, viewDistance}）。
 *
 * ⚠️ view_distance 必须放在顶层 `viewDistance`：mineflayer 的 settings 插件只读
 * `options.viewDistance`（缺省 'far' = 12），嵌套的 `settings`/`clientSettings` 根本不会
 * 被它采用。只给嵌套键的后果是实例里设的 view_distance 被静默忽略，服务端按 12 区块
 * 推送世界数据 —— 单 bot 就能把 agent 的 0.6 CPU 配额打满（区块解析 + 物理），而 Lua
 * 脚本本身并不忙。`clientSettings` 仍保留：minecraft-protocol 建连时的初始 settings 包用它。
 */
export function botOptions(cfg = {}) {
  const acct = cfg.account ?? {};
  const vd = Math.max(2, Math.min(12, Number(cfg.viewDistance) || 6));
  const opts = {
    host: cfg.host ?? '127.0.0.1',
    port: cfg.port ?? 25565,
    username: acct.username ?? 'bot',
    version: cfg.version ?? undefined,
    hideErrors: false,
    viewDistance: vd,
    settings: { viewDistance: vd },
    clientSettings: { viewDistance: vd },
  };
  if (acct.auth === 'session') {
    opts.auth = (client, options) => {
      const profile = { id: acct.uuid, name: acct.username };
      options.haveCredentials = true;
      options.accessToken = acct.accessToken;
      client.session = { accessToken: acct.accessToken, selectedProfile: profile, availableProfiles: [profile] };
      client.username = acct.username;
      client.emit('session', client.session);
      options.connect(client);
    };
  } else if (acct.password) {
    opts.password = acct.password;
    opts.auth = 'microsoft';
  } else if (acct.uuid) {
    opts.auth = (client, options) => {
      client.session = { selectedProfile: { id: acct.uuid, name: acct.username } };
      client.username = acct.username;
      options.connect(client);
    };
  } else {
    opts.auth = 'offline';
  }
  return opts;
}

export class MineflayerDriver {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.handlers = new Map();
    this.bot = null;
    this.cfg = {};
    this.windowSeq = 1;
    this.selfDirty = false;
    this.invDirty = true;      // 背包变化才重建 self 事件里的 inv 列表
    this.invSnapshot = null;
    this.pathWait = null;
    this.alive = false;
    this.transportErrLogged = false;
    // 主动拆旧 bot 期间为 true：此时 bot 的 kicked/end/error 不得再向外发 session 事件
    // （否则引擎会把「我们自己拆掉的连接」当成一次断线，安排重复重连）
    this.tearingDown = false;
    // 引擎设置：返回 false 时连 payload 都不构造（密集区实体快照/插件包 base64 很贵）
    this.eventGate = null;
    // 排障计数器：每包类型 / 驱动事件 / 被门控数量（/state 的 driver_stats 暴露）
    this._stats = { packets: {}, events: {}, gated: {}, since: Date.now() };
  }

  stats() {
    return {
      since: this._stats.since,
      uptime_ms: Date.now() - this._stats.since,
      packets: this._stats.packets,
      events: this._stats.events,
      gated: this._stats.gated,
    };
  }
  _gated(name) {
    this._stats.gated[name] = (this._stats.gated[name] || 0) + 1;
  }

  on(evt, cb) {
    (this.handlers[evt] = this.handlers[evt] ?? []).push(cb);
  }
  emit(evt, payload) {
    this._stats.events[evt] = (this._stats.events[evt] || 0) + 1;
    for (const cb of this.handlers[evt] ?? []) {
      try { cb(payload); } catch (e) { this.log(`[${this.constructor.name}] handler ${evt} 出错: ${e.message}`); }
    }
  }

  caps() {
    return {
      'nav.pathfinder': true,
      'item.components': true,     // prismarine-item 保留网络组件
      'world.block_entity': true,  // block.entity（方块 NBT）
      'net.custom_payload': true,  // custom_payload 双向（插件消息）
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
    this.tearingDown = false;
    const mineflayer = (await import('mineflayer')).default;
    const pfMod = await import('mineflayer-pathfinder');
    const pf = pfMod.default ?? pfMod;
    this.pf = typeof pf === 'function' ? pf : pf.pathfinder;
    this.pfMod = pf;
    const botOpts = botOptions(cfg);
    const bot = mineflayer.createBot(botOpts);
    this.bot = bot;
    // 排障：按包名计数（minecraft-protocol 对每个解析后的包发 'packet'）——密集区定位用
    bot._client.on('packet', (data, meta) => {
      const n = (meta && meta.name) || (data && data.name) || 'unknown';
      const p = this._stats.packets;
      p[n] = (p[n] || 0) + 1;
    });

    this.trace = installProtocolTrace(bot, (line, level) => this.log(line, level ?? 'debug'));
    this._patchRuntime = installPatches(bot, { version: cfg.version, log: (line) => this.log(line, 'info') });
    this.bindMoveThrottle(bot);
    this.bindWindowProtocolTrace(bot);
    this.bindCustomPayload(bot);

    // 配置阶段资源包：必须用字符串 uuid 应答 ACCEPTED+LOADED。mineflayer 内置插件传
    // uuid-1345 对象，服务器（如 Velocity 群组服）无法匹配其推送，形同未确认。
    bot._client.on('add_resource_pack', (p) => {
      bot._client.write('resource_pack_receive', { uuid: p.uuid, result: 3 });   // ACCEPTED
      bot._client.write('resource_pack_receive', { uuid: p.uuid, result: 0 });   // SUCCESSFULLY_LOADED
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
      if (this.tearingDown) return;
      const text = reasonText(reason).slice(0, 500);
      this.trace?.flush(`kicked: ${text}`);
      this.emit('session', { state: 'kicked', reason: text });
    });
    bot.on('end', (reason) => {
      this.alive = false;
      this.stopSampling();
      if (this.tearingDown) return;
      const text = reasonText(reason).slice(0, 500);
      this.trace?.flush(`disconnected: ${text}`);
      this.emit('session', { state: 'disconnected', reason: text });
    });
    bot.on('error', (e) => {
      this.alive = false;
      if (this.tearingDown) return;
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
      // 疾跑/跳跑步伐会被本服移动校验判 invalid_player_movement 连续踢线（生产实测：
      // 短途平地无碍，长距离寻路（拾取/撤退）必踢）。关闭跳跑；疾跑保留（平地疾跑合法），
      // 若仍被踢可再关。
      movements.allowParkour = false;
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
    await this.teardownBot();
  }

  async reconnect(cfg) {
    this.stopSampling();
    await this.teardownBot();
    await this.connect(cfg);
  }

  /**
   * 拆掉当前 bot。顺序很关键：**必须让 mineflayer 自己的 'end' 路径先跑完**再摘监听器。
   *
   * mineflayer 的插件（physics 每 50ms 的 setInterval、keepalive 等）把清理函数挂在
   * bot.on('end') 上，而 bot 'end' 由 loader 的 client.on('end') 转发。若先
   * removeAllListeners() 再 end()，两侧的 'end' 清理都被摘掉 → physics interval 永久
   * 存活并拖住整个 bot 图（world/chunks/registry/实体）；每次重连泄漏一个 bot，
   * 长跑后共享 host 进程内存持续上涨，最终被容器 cgroup OOM 杀掉（实例侧表现为
   * 「worker 消失但 host 无退出记录」）。
   *
   * 另外 minecraft-protocol 的 Client.end() 只挂 30s 的 closeTimer；对端不主动关连接时
   * 'end' 可能迟迟不来，所以这里主动 destroy socket 把 close→end 提前。
   */
  async teardownBot() {
    const b = this.bot;
    this.bot = null;
    if (!b) return;
    this.tearingDown = true;   // 抑制本驱动在拆机期间外发 session 事件
    try { this.trace?.off(); } catch { /* ignore */ }
    this.trace = null;
    try { this._patchRuntime?.uninstall(); } catch { /* ignore */ }
    this._patchRuntime = null;
    const c = b._client;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hard);
        clearTimeout(force);
        resolve();
      };
      const hard = setTimeout(finish, 2000);   // 兜底：2s 内 end 不到也不能卡住重连
      const force = setTimeout(() => { try { c?.socket?.destroy?.(); } catch { /* ignore */ } }, 250);
      try { b.once('end', finish); } catch { /* ignore */ }
      try {
        if (typeof b.quit === 'function') b.quit('driver teardown');
        else b.end();
      } catch {
        try { b.end(); } catch { /* ignore */ }
      }
    });
    this.alive = false;
    try { b.removeAllListeners(); } catch { /* ignore */ }
    try { c?.removeAllListeners?.(); } catch { /* ignore */ }
    this.tearingDown = false;
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
      if (this.eventGate && !this.eventGate('entity_appeared')) { this._gated('entity_appeared'); return; }
      const s = this.snapshotOf(e);
      this.emit('entity_appeared', { id: s.id, type: s.type, name: s.name });
    });
    bot.on('entityGone', (e) => {
      if (e === bot.entity) return;
      if (this.eventGate && !this.eventGate('entity_gone')) { this._gated('entity_gone'); return; }
      const isPlayer = e.type === 'player';
      this.emit('entity_gone', { id: e.id, type: isPlayer ? 'player' : `minecraft:${e.name ?? e.type}`, name: e.username ?? null });
    });
    this.pushInventory();
    bot.on('spawn', () => this.pushInventory());
    bot.on('windowOpen', (win) => {
      // prismarine-windows 只发 updateSlot（没有 'update' 事件）：此前容器窗口槽位变化
      // 从不标脏，引擎快照只在开窗时更新一次——容器点击后 Lua 读到的背包/箱子恒为旧值
      // （生产实测：主背包区物品转移后匹配总量不变，deposit/withdraw 误判停滞提前中断；
      // hotbar 区因 bot.inventory 镜像另有推送而例外地正常）。两条事件都挂。
      win?.on?.('update', () => this.pushWindowsDirty());
      win?.on?.('updateSlot', () => this.pushWindowsDirty());
      this.pushWindowsDirty();
    });
    bot.inventory?.on?.('update', () => { this.invDirty = true; this.pushWindowsDirty(); });
    bot.on('blockUpdate', (oldBlock, newBlock) => {
      if (newBlock) this.emit('block_update', { pos: NORM(newBlock.position ?? oldBlock?.position), name: CANON(newBlock.name) });
    });
    bot.on('death', () => this.emit('death', {}));
    bot.on('respawn', () => this.emit('respawn', {}));
    bot.on('damage', () => this.emit('damaged', {}));
  }

  stopSampling() {
    this.invSnapshot = null;
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
    // inv 只在背包变化时重建：原先每 200ms 全量遍历一次，对 UI/诊断字段来说纯属浪费
    if (this.invDirty || !this.invSnapshot) {
      const inv = [];
      for (const it of this.bot.inventory?.items() ?? []) {
        if (it.slot >= 9 && it.slot <= 44) {
          inv.push({ slot: it.slot, id: it.name, count: it.count, name: it.displayName ?? it.name });
        }
      }
      this.invSnapshot = inv;
      this.invDirty = false;
    }
    this.emit('self', { ...s, inv: this.invSnapshot });
  }

  /** 公共字段（core/full 投影共享；装备由调用方按投影补齐） */
  commonOf(e) {
    const isPlayer = e.type === 'player';
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

  fullEquipmentOf(e) {
    const eq = e.equipment ?? [];
    return {
      hand: itemOf(eq[0] ?? e.heldItem),
      offhand: itemOf(eq[1]),
      boots: itemOf(eq[2]),
      leggings: itemOf(eq[3]),
      chestplate: itemOf(eq[4]),
      helmet: itemOf(eq[5]),
    };
  }

  /** core 投影：装备只留 {id,count}（组件展开由脚本按需 item.stack，见 PERF-REFACTOR P1） */
  coreEquipmentOf(e) {
    const eq = e.equipment ?? [];
    const slim = (it) => (it ? { id: CANON(it.name), count: it.count } : null);
    return {
      hand: slim(eq[0] ?? e.heldItem),
      offhand: slim(eq[1]),
      boots: slim(eq[2]),
      leggings: slim(eq[3]),
      chestplate: slim(eq[4]),
      helmet: slim(eq[5]),
    };
  }

  snapshotOf(e) {
    return { ...this.commonOf(e), equipment: this.fullEquipmentOf(e) };
  }

  coreSnapshotOf(e) {
    return { ...this.commonOf(e), equipment: this.coreEquipmentOf(e) };
  }

  query_entities(filter = {}) {
    const bot = this.bot;
    if (!bot?.entities) return [];
    const pred = filter.pred ?? null;
    const wantType = filter.type != null ? String(filter.type) : (pred?.type != null ? String(pred.type) : null);
    const within = filter.within != null ? Number(filter.within) : (pred?.within != null ? Number(pred.within) : null);
    const projection = String(filter.projection ?? 'full') === 'core' ? 'core' : 'full';
    const selfPos = bot.entity?.position;
    const matched = [];
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position) continue;
      if (wantType != null && entityTypeOf(e) !== wantType) continue;
      const d2 = selfPos ? dist2(selfPos, e.position) : null;
      if (within != null && Number.isFinite(within) && d2 != null && d2 > within * within) continue;
      if (pred && !rawPredMatch(e, pred, selfPos)) continue;
      matched.push({ e, d2 });
    }
    if (String(filter.order ?? '') === 'distance') {
      matched.sort((a, b) => (a.d2 ?? Infinity) - (b.d2 ?? Infinity));
    }
    const limit = filter.limit == null ? null : Math.max(0, Number(filter.limit) || 0);
    const picked = limit == null ? matched : matched.slice(0, limit);
    const core = projection === 'core';
    return picked.map(({ e }) => (core ? this.coreSnapshotOf(e) : this.snapshotOf(e)));
  }

  query_entity(id, projection = 'full') {
    const e = this.bot?.entities?.[id];
    if (!e || e === this.bot.entity || !e.position) return null;
    return String(projection) === 'core' ? this.coreSnapshotOf(e) : this.snapshotOf(e);
  }

  bindChat() {
    const bot = this.bot;
    bot.on('message', (jsonMsg, position, sender) => {
      const raw = jsonMsg.toString();
      if (!raw) return;
      // 只按协议事实分类：playerChat 包带 sender UUID（解析为在线玩家名），
      // systemChat 包 sender 为 null。不从 raw 文本猜发送者/频道；
      // 不过滤自己的发言——是否是自己、是不是命令，交给脚本与服务器判断。
      const senderName = sender
        ? (bot._playerFromUUID?.(sender)?.username
          ?? Object.values(bot.players ?? {}).find((p) => p.uuid === sender)?.username
          ?? null)
        : null;
      this.emit('chat', { ...classifyChat(raw, senderName), ts: Date.now() });
    });
  }

  // 自定义网络包入站：binary 经 base64 走事件 JSON（Lua 核心再解成原始字节串）。
  // 门控在引擎层（boundary.packets）；驱动只负责翻译，不决定脚本可见性。
  /**
   * 移动包节流（2026-11-23 生产踢线根因）：Paper 26.x 的 handleMovePlayer 新增
   * receivedPositionThisTick 校验——同一服务器 tick 内第二个含位置的移动包直接以
   * multiplayer.disconnect.invalid_player_movement 踢线（先于一切物理/飞行判定）。
   * mineflayer 在转向+微移时可能同 tick 连发 position + position_look；经 ViaVersion
   * 翻译到 26.x 后更易撞上（现场：静止每秒一包无事，一动即被踢）。
   * 对含位置的出站包做 ≥60ms 节流：间隔不足则丢弃本包（服务器采用最新位置，
   * 丢一个采样无副作用；原版客户端本身每 tick 至多一个位置包）。
   */
  bindMoveThrottle(bot) {
    const client = bot._client;
    let lastMoveAt = 0;
    let dropped = 0;
    const origWrite = client.write.bind(client);
    client.write = (name, params) => {
      if (name === 'position' || name === 'position_look') {
        const now = Date.now();
        if (now - lastMoveAt < 60) {
          dropped++;
          if (dropped === 1 || dropped % 200 === 0) {
            this.log(`[move-throttle] 已丢弃 ${dropped} 个过密移动包（防 26.x 同 tick 双位置包踢线）`, 'info');
          }
          return;
        }
        lastMoveAt = now;
      }
      return origWrite(name, params);
    };
  }

  /**
   * 窗口协议层（2026-11-23 生产排障）：
   * 1) 抓现场：记录出站 window_click、入站 window_items / set_slot / 关窗、开窗。
   *    入站仅容器窗口打开期间记录（挖矿背包变动不刷屏）。
   * 2) stateId 按窗口跟踪并覆写出站点击：mineflayer 用单一全局 stateId 变量，
   *    被 w=0（背包）的 set_slot 污染后，发给容器的点击携带完全错位的 stateId
   *    （现场实测：箱子 state 1/2/3，我们发 7/8）。多数服务器容忍几个错位点击后
   *    开始静默无视，本地窗口状态随之漂移直至点击层抛错。这里按包内 windowId
   *    各自维护最新 stateId，出站时替换为该窗口的真值。
   */
  bindWindowProtocolTrace(bot) {
    const fmtItem = (it) => (it && (it.name ?? it.itemId) != null ? `${it.name ?? it.itemId}×${it.count ?? '?'}` : '空');
    const winOpen = () => bot.currentWindow && bot.currentWindow.id !== 0;
    const client = bot._client;
    const stateByWindow = new Map();

    const origWrite = client.write.bind(client);
    client.write = (name, params) => {
      if (name === 'window_click') {
        const p = params ?? {};
        const wid = p.windowId;
        const truth = stateByWindow.get(wid);
        if (truth !== undefined && p.stateId !== truth) {
          this.log(`[win-proto] stateId 纠偏 w=${wid} ${p.stateId}→${truth}（全局变量被其它窗口污染）`, 'info');
          p.stateId = truth;
        }
        this.log(`[win-proto] >> click w=${wid} state=${p.stateId} slot=${p.slot} btn=${p.mouseButton} mode=${p.mode} cursor=${fmtItem(p.cursorItem)} 变更槽=${(p.changedSlots ?? []).length}`, 'info');
      }
      return origWrite(name, params);
    };

    const track = (wid, stateId) => {
      if (Number.isFinite(stateId)) stateByWindow.set(Number(wid), Number(stateId));
    };
    client.on('window_items', (p) => {
      track(p.windowId, p.stateId);
      if (!winOpen()) return;
      this.log(`[win-proto] << window_items w=${p.windowId} state=${p.stateId} 非空槽=${(p.items ?? []).filter(Boolean).length}/${(p.items ?? []).length}`, 'info');
    });
    client.on('set_slot', (p) => {
      track(p.windowId, p.stateId);
      if (!winOpen()) return;
      this.log(`[win-proto] << set_slot w=${p.windowId} state=${p.stateId} slot=${p.slot} item=${fmtItem(p.item)}`, 'info');
    });
    client.on('close_window', (p) => {
      this.log(`[win-proto] << close_window w=${p?.windowId}`, 'info');
    });
    bot.on('windowOpen', (win) => {
      this.log(`[win-proto] << open w=${win.id} type=${win.type} 总槽=${win.slots.length}`, 'info');
    });
  }

  bindCustomPayload(bot) {
    bot._client.on('custom_payload', (p) => {
      const channel = p?.channel;
      if (typeof channel !== 'string' || !channel) return;
      // 没有脚本消费者时不做 base64/JSON（机器/插件密集区插件消息可能很密集）
      if (this.eventGate && !this.eventGate('custom_payload')) { this._gated('custom_payload'); return; }
      const raw = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data ?? []);
      if (raw.length > CUSTOM_PAYLOAD_MAX) {
        this.log(`[custom_payload] ${channel} 载荷过大（${raw.length} 字节），已丢弃`, 'warn');
        return;
      }
      this.emit('custom_payload', { channel, data_b64: raw.toString('base64'), ts: Date.now() });
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
    bot.inventory?.on?.('update', () => { this.invDirty = true; dirty = true; });
    bot.on('spawn', () => {
      bot.inventory?.on?.('update', () => { this.invDirty = true; dirty = true; });
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

  // 原版 serverbound custom_payload（插件消息）。data 已是 Buffer（ABI 层解码 base64）。
  async custom_payload(channel, data) {
    if (!this.connected) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
    this.bot._client.write('custom_payload', { channel: String(channel), data: buf });
  }

  async chat_send(text, kind = 'chat') {
    if (!this.connected) return;
    // kind=command 或文本自带 /：按命令发送；其余原样发送
    const isCommand = kind === 'command' || text.startsWith('/');
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
    // 无容器窗口时落到背包窗口（inv.equip 的热键换持等背包点击此前被直接丢弃——
    // 生产实测：背包里有矿镐却一直空手挖、挖掘全部超时，就是 equip 点击空转所致）。
    // 连背包窗口都没有属异常态：显式抛错，不允许静默成功（静默 = 上层永远不知道没点上）。
    const win = bot.currentWindow || bot.inventory;
    if (!win) throw new Error('window.missing: 无可用窗口（currentWindow 与 inventory 均缺失）');
    const snap = (w) => JSON.stringify(w.slots.map((s) => (s ? [s.name, s.count] : 0)));
    const fmt = (it) => (it ? `${it.name}×${it.count}` : '空');
    const before = snap(win);
    const beforeItem = win.slots[slot];
    // clickWindow 可能同步抛错（本地 acceptClick 断言/槽位状态漂移）：捕获并记录
    try {
      await Promise.race([bot.clickWindow(slot, button, mode), new Promise((r) => setTimeout(r, 2000))]);
    } catch (e) {
      this.log(`[win] click 异常 w=${win.id} slot=${slot}(${fmt(beforeItem)}): ${e.message}`, 'warn');
      throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
    const changed = snap(win) !== before;
    this.log(`[win] click w=${win.id} slot=${slot}(${fmt(beforeItem)}→${fmt(win.slots[slot])}) ${changed ? '本地有变化' : '本地无变化'}`, changed ? 'info' : 'warn');
  }

  // ---- 协议动作（按原版包建模） ----

  /**
   * 1.21.x 组件附魔消毒：prismarine-item 的 enchants getter 对 component 形态直接
   * 返回原始 NBT 对象（{levels:{...}, show_in_tooltip}），而 prismarine-block 的
   * digTime 按数组迭代——带附魔的工具一挖就抛「enchantments is not iterable」
   * （生产实测：附魔钻石镐每次 dig 必炸）。这里在 dig 前把组件数据归一成
   * [{name,lvl}]（name 去掉 minecraft: 前缀，与 legacy NBT 路径同口径）。
   */
  sanitizeEnchantComponents(item) {
    if (!item?.componentMap?.has('enchantments')) return;
    const comp = item.componentMap.get('enchantments');
    const d = comp?.data;
    if (Array.isArray(d) || d == null || typeof d !== 'object') return;
    const lv = d.levels && typeof d.levels === 'object' ? d.levels : null;
    comp.data = lv
      ? Object.entries(lv).map(([name, lvl]) => ({ name: String(name).replace(/^minecraft:/, ''), lvl: Number(lvl) }))
      : [];
  }

  async dig(pos, face = 1) {
    const block = this.bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) throw new Error(`方块未加载 ${JSON.stringify(pos)}`);
    this.sanitizeEnchantComponents(this.bot.heldItem);          // digTime 会迭代 enchants
    const headSlot = this.bot.getEquipmentDestSlot?.('head');
    if (headSlot != null) this.sanitizeEnchantComponents(this.bot.inventory?.slots?.[headSlot]);
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
    // useExtraInfo=true 会短路 mineflayer 的 section palette 剪枝（blocks.js:178），
    // 退化成「区域体积 × 4096 次 blockAt」。谓词只读 name/position，不需要 extraInfo。
    // 区域边界并入谓词：count 只统计域内命中，无需 limit*2 + 事后过滤。
    // palette 预筛传入的合成 Block 没有 position（prismarine-block 默认 null）→ 只做名字判断。
    const inRegion = (block) => {
      const p = block?.position;
      if (!p) return true;
      return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2 && p.z >= z1 && p.z <= z2;
    };
    const matching = (block) => !!block && inRegion(block) && kindSet.has(block.name);
    const found = bot.findBlocks({
      point: center,
      maxDistance,
      count: limit,
      useExtraInfo: false,
      matching,
    }) ?? [];
    return found
      .map((p) => ({ x: p.x, y: p.y, z: p.z, id: CANON(bot.blockAt(p)?.name ?? null) }))
      .slice(0, limit);
  }

  async window_refresh() { this.pushInventory(); }
}
