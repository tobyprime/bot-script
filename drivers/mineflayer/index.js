// drivers/mineflayer/index.js — mineflayer 驱动（进程内；协议 = 函数调用）
// L0 连接（mineflayer 代劳）+ L1 数据面（通道翻译）+ L2 动词（14 动词映射）+ L3 pathfinder。
// 与引擎的事件/方法契约见 engine/engine.js 顶部注释与 README。
import { Vec3 } from 'vec3';
import { degToRad, radToDeg, serviceDegToBotYaw, shortestYaw } from './units.js';
import { reasonText } from './reason.js';

import { installProtocolTrace } from './protocolTrace.js';
import { installTickEndSender } from './tickEnd.js';

const NORM = (v) => ({ x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) });
// 规范物品 id：minecraft:x（引擎数据模型约定，CAPABILITIES §3.1）
const CANON = (name) => (name && !name.includes(':') ? `minecraft:${name}` : name);
const itemOf = (it) => (it ? { id: CANON(it.name), count: it.count } : null);

export class MineflayerDriver {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.handlers = new Map();
    this.bot = null;
    this.cfg = {};
    this.windowSeq = 1;
    this.selfDirty = false;
    this.pathWait = null; // { resolve }
    // 连接是否仍可写包：socket 关闭后置 false，动作动词据此静默跳过。没有这道守卫时，
    // 脚本里的 20Hz 循环（如 look_at_nearest_player 每 50ms 的 rot）会在死连接上持续写包，
    // 刷出成片的 write EPIPE 噪声，把真正的原因（kicked 的服务器提示）淹掉。
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
      'world_stream': false,       // 定点查询降级（CAPABILITIES §3.5）
      'entity.equipment': true,
      'entity.holding': true,
      'input.move': true,
      'window.click_authentic': false, // 协议端点击（非客户端本体路径）
      'hud.full': false,
    };
  }

  async connect(cfg) {
    this.cfg = cfg;
    this.alive = false;              // 新连接建立前先置不可写，避免旧会话残留动作写包
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
      settings: { viewDistance: vd },              // mineflayer 登录时发送的客户端设置
      clientSettings: { viewDistance: vd },        // mc-protocol play 期 settings（服务器据此发 chunk）
    };
    if (acct.auth === 'session') {
      // 平台注入会话（credential 服务签发 accessToken，引擎不做任何 OAuth 流程）。
      // 与 minecraft-protocol microsoftAuth.authenticate 的注入完成形态对齐：
      // 在线服时 encrypt.js 拿 options.accessToken + client.session.selectedProfile.id 走会务器 join
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
      // 离线 + 指定 UUID：Login Start 的 playerUUID 用它（仅离线服有效；在线服必须走 auth:session）
      botOpts.auth = (client, options) => {
        client.session = { selectedProfile: { id: acct.uuid, name: acct.username } };
        client.username = acct.username;
        options.connect(client);
      };
    } else {
      botOpts.auth = 'offline';   // mc-protocol 按 nameToMcOfflineUUID(username) 稳定派生
    }
    const bot = mineflayer.createBot(botOpts);
    this.bot = bot;

    // 协议诊断：常驻开启但只在内存留最近 40 条（环形缓冲），断线时才一次性倒进日志。
    // 这样无需用户配任何环境变量，出问题时日志里就自带现场；平时零噪音。
    // BOTSCRIPT_PROTO_TRACE=1 可切回逐条实时打印（深度调试用）。
    this.trace = installProtocolTrace(bot, (line) => this.log(line));

    // 协议守卫（三件事，都是 invalid_player_movement 的成因）：
    //   ① yaw/pitch 越界纠正 —— mineflayer 的 lastSentYaw 无界累加，会漂到 5109°/30759°，
    //      服务端 containsInvalidValues 判非法（线上 trace 实测）。
    //   ② 同一 tick 只放行一个带位置的包 —— 26.3 的 receivedPositionThisTick 判定。
    //   ③ teleport_confirm 补六字段 —— 26.3 的确认包带 x/y/z/yRot/xRot。
    // 补上原版客户端固有的 tick 结束标记（26.x 服务端靠它清零「本 tick 已收到位置包」计数；
    // mineflayer 从不发，导致第二个带坐标包总被判非法 → invalid_player_movement 每 1.2 秒被踢）。
    this.tickEnd = installTickEndSender(bot);

    // 配置阶段资源包：必须用字符串 uuid 应答 ACCEPTED+LOADED，否则服务器（如 Velocity 群组服
    // 推自定义资源包）会持有配置阶段不发 finish_configuration，登录卡死且无任何报错。
    // mineflayer 内置插件传 uuid-1345 对象，服务器无法匹配其推送，形同未确认。
    bot._client.on('add_resource_pack', (p) => {
      bot._client.write('resource_pack_receive', { uuid: p.uuid, result: 3 });   // ACCEPTED
      bot._client.write('resource_pack_receive', { uuid: p.uuid, result: 0 });   // SUCCESSFULLY_LOADED
    });

    bot.once('login', () => this.emit('session', { state: 'logged_in' }));
    bot.once('spawn', () => {
      this.alive = true;             // spawn 之后才允许动作写包（登录前写也是浪费）
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
      // 踢出理由要原样上抛：mineflayer 的 kick 包经过 chat 组件，String() 后是 JSON 文本，
      // 尽量取出可读的 text 段（否则运维只能看到裸 JSON 或干脆什么都看不到）
      const text = reasonText(reason).slice(0, 500);
      // 被踢时把协议环形缓冲一次性倒进日志：无需用户配置，现场自带
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
      // EPIPE / ECONNRESET 是「对端已关连接」的通用表现，本身不含任何业务信息；
      // 真正的踢出理由在 kicked/end 里。这里降噪：同类错误只报一次，且标明是传输层问题。
      this.alive = false;
      const code = e?.code ?? '';
      if (code === 'EPIPE' || code === 'ECONNRESET') {
        if (!this.transportErrLogged) {
          this.transportErrLogged = true;
          this.log(`[mineflayer] 连接已断开（${code}）：对端关闭了连接，具体原因见 kick/end 事件`);
        }
        return;
      }
      this.log(`[mineflayer] error: ${e.message}`);
    });

    bot.loadPlugin(this.pf);
    const Movements = this.pfMod.Movements;
    bot.once('spawn', () => {
      // mineflayer 的 physics 每 tick 只把「已发出的朝向」向目标推进 physics.yawSpeed × 50ms，
      // 默认 3.0 rad/s → 每 tick 8.59°、每秒 172°。转向 90° 要 0.52s、180° 要 1.05s，
      // 且脚本高频跟随时发包永远落后目标（实测持续滞后 100°+），观感就是「转一点停一下再转一点」。
      // 原版客户端并不限速（physics.js 注释亦如此），限速只是 mineflayer 为「跟得上」做的保守处理。
      // 提高到 20 rad/s ≈ 57°/tick，2 秒内可转满 360°，跟手且仍逐 tick 平滑推进。
      // 注意：bot.look 的 force=true 会直接跳包（绕过限速但可能触发 anticheat），故仍用 force=false。
      bot.physics.yawSpeed = 20;
      bot.physics.pitchSpeed = 20;
      const movements = new Movements(bot, bot.registry);
      movements.allowSprinting = true;
      movements.allowParkour = true;
      movements.canDig = false;   // 示例策略默认禁挖；寻路不开路
      movements.canPlace = false;
      bot.pathfinder.setMovements(movements);
    });
    // L3 进度事件
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

  // 重连专用：先完整拆掉旧 bot（解绑监听 + 断链），避免旧连接的延迟事件污染新会话状态
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
    try { this.tickEnd?.stop(); } catch { /* ignore */ }
    this.tickEnd = null;
    try { this.unpatchTeleport?.(); } catch { /* ignore */ }
    this.unpatchTeleport = null;
    try { b.removeAllListeners(); } catch { /* ignore */ }
    try { b._client?.removeAllListeners?.(); } catch { /* ignore */ }
    try { b._client?.end?.(); } catch { /* ignore */ }
    try { b.end(); } catch { /* ignore */ }
  }

  // ================= L1 数据面 =================

  startSampling() {
    const bot = this.bot;
    // 自身状态：变化即推 + 200ms 心跳合帧
    this.selfTimer = setInterval(() => this.pushSelf(), 200);
    bot.on('forcedMove', () => this.pushSelf());
    bot.on('health', () => this.pushSelf());
    bot.on('entitySwingArm', () => this.pushSelf());
    // 实体出现/消失：直接由协议事件驱动（状态查询本身是实时的，这里只负责发事件）
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
    // 窗口
    this.pushInventory();   // 初始背包快照（保证引擎 windows['0'] 存在）
    if (process.env.BS_PK) {
      for (const nm of ['window_items', 'set_slot', 'open_window', 'close_window']) {
        bot._client.on(nm, (p) => {
          console.log(`[pk] ${nm} win=${p.windowId} state=${p.stateId ?? ''} slot=${p.slot ?? ''} cnt=${p.items ? p.items.length : (p.item ? p.item.count : '')}`);
        });
      }
      const origClick = bot.clickWindow.bind(bot);
      bot.clickWindow = async (slot, button, mode) => {
        console.log(`[pk] >> click win slot=${slot} btn=${button} mode=${mode}`);
        return origClick(slot, button, mode);
      };
    }
    bot.on('spawn', () => this.pushInventory());
    bot.on('windowOpen', (win) => {
      win?.on?.('update', () => this.pushWindowsDirty());
      this.pushWindowsDirty();
    });
    bot.inventory?.on?.('update', () => this.pushWindowsDirty());
    // 方块更新（dig 完成确认源；方块名与物品 id 同用 CANON 形式）
    bot.on('blockUpdate', (oldBlock, newBlock) => {
      if (newBlock) this.emit('block_update', { pos: NORM(newBlock.position ?? oldBlock?.position), name: CANON(newBlock.name) });
    });
    // 死亡/重生
    bot.on('death', () => this.emit('death', {}));
    bot.on('respawn', () => this.emit('respawn', {}));
    bot.on('damage', () => this.emit('damaged', {}));
  }

  stopSampling() {
    clearInterval(this.selfTimer);
    clearInterval(this.windowTimer);
  }

  pushSelf() {
    const bot = this.bot;
    if (!bot?.entity) return;
    // 背包快照：主背包(9-35) + 快捷栏(36-44) 共 36 格，供仪表盘可视化
    const inv = [];
    for (const it of bot.inventory?.items() ?? []) {
      if (it.slot >= 9 && it.slot <= 44) {
        inv.push({ slot: it.slot, id: it.name, count: it.count, name: it.displayName ?? it.name });
      }
    }
    this.emit('self', {
      username: bot.username ?? null,
      pos: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
      yaw: radToDeg(bot.entity.yaw), pitch: radToDeg(bot.entity.pitch),
      health: bot.health, food: bot.food,
      gamemode: bot.game?.gameMode,
      held: itemOf(bot.heldItem),
      heldSlot: bot.quickBarSlot ?? 0,
      ping: bot.players?.[bot.username]?.ping ?? null,
      inv,
    });
  }

  // 实体实时查询（同步、直读 mineflayer 的活体对象，不维护任何快照）：
  // 脚本每次 entity.find/nearest/句柄字段访问都走到这里，拿到的是「此刻」的位置，
  // 不存在采样周期，也就不会出现「追上旧目标 → 目标其实是 250ms 前的 → 停住再追」。
  snapshotOf(e) {
    const isPlayer = e.type === 'player';
    return {
      id: e.id,
      type: isPlayer ? 'player' : `minecraft:${e.name ?? e.type}`,
      name: e.username ?? (isPlayer ? null : e.name),
      pos: e.position ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
      alive: e.isValid?.(this.bot) !== false,
      health: null,        // 协议端对玩家血量不可见
      equipment: { hand: itemOf(e.heldItem) },
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
      if (senderName === bot.username) return;   // 过滤自身回显
      this.emit('chat', { text, raw, sender: senderName, sender_kind: kind, ts: Date.now() });
    });
  }

  bindWorld() {
    const bot = this.bot;
    // 窗口推送：open 事件 + 槽位变化（50ms 合帧全量快照，最后值胜）
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
    // bot inventory 更新（无容器时；每次 spawn 后 inventory 对象可能重建）
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
        // mineflayer 玩家背包布局 -> 引擎布局：36-44 hotbar => 0-8；9-35 main 原样；5-8 armor => 36-39；45 offhand => 40
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
      slots,
      cursor: win.cursorItem ? itemOf(win.cursorItem) : null,
    };
  }

  pushWindow(win) {
    if (!win) return;
    this.emit('window', this.windowSnapshot(win));
  }

  scheduleInventoryPush() {
    setTimeout(() => this.pushInventory(), 30);
  }

  pushInventory() {
    const bot = this.bot;
    if (!bot?.inventory) return;
    this.emit('window', this.windowSnapshot(bot.inventory));
  }

  // ================= L2 动词 =================

  // 连接已断时动作静默跳过（引擎在断线后会 pause 任务并重连，期间仍有在途协程；
  // 不做这道守卫就会在死 socket 上持续写包，刷出成片的 write EPIPE）
  get connected() {
    return this.alive && !!this.bot?.entity && !this.bot?._client?.socket?.destroyed;
  }

  async chat_send(text) {
    if (!this.connected) return;
    this.bot.chat(text);
  }

  async rot(yaw, pitch) {
    if (!this.connected) return;
    // 引擎/Lua 侧 yaw 是「服务端度数」（0..360）；mineflayer 的 bot.look 用 bot.entity.yaw 坐标系。
    // 换算见 units.js：度数→botYaw，再取最短路径（否则跨 ±π 边界会绕远路，转得又慢又飘）。
    // bot.look 内部按 maxDeltaYaw 限速推进，不会瞬移视角。
    const curYaw = this.bot.entity.yaw;
    let botYaw = curYaw;
    if (yaw != null) botYaw = shortestYaw(serviceDegToBotYaw(yaw), curYaw);
    const botPitch = pitch == null ? this.bot.entity.pitch : Math.max(-Math.PI / 2, Math.min(Math.PI / 2, (-pitch * Math.PI) / 180));
    await this.bot.look(botYaw, botPitch, false);
  }

  async hop() {
    if (!this.connected) return;
    this.bot.setControlState('jump', true);
    await new Promise((r) => setTimeout(r, 100));
    if (!this.connected) return;
    this.bot.setControlState('jump', false);
  }

  async move_input(state) {
    if (!this.connected) return;
    const map = { fwd: 'forward', strafe: 'left', jump: 'jump', sneak: 'sneak', sprint: 'sprint' };
    this.bot.setControlState('left', !!state.strafe);   // v1: strafe 非零 = 左移
    this.bot.setControlState(map.fwd, !!state.fwd);
    this.bot.setControlState('jump', !!state.jump);
    this.bot.setControlState('sneak', !!state.sneak);
    this.bot.setControlState('sprint', !!state.sprint);
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
      this.pushInventory();   // 关箱后同步刷新背包快照（脚本 close 后立即读 inv.count/find）
    }
  }

  engineInvToMineflayer(slot) {
    if (slot >= 0 && slot <= 8) return 36 + slot;      // 快捷栏
    if (slot >= 9 && slot <= 35) return slot;          // 主背包
    if (slot >= 36 && slot <= 39) return 5 + (slot - 36); // 盔甲
    if (slot === 40) return 45;                        // 副手
    return slot;
  }

  async window_click(windowId, slot, button, mode) {
    // mode 对齐 vanilla ClickType：0 pickup / 1 quick_move / 2 swap / 4 throw / 6 pickup_all
    // mineflayer 签名 clickWindow(slot, mouseButton, mode)，engine 传 (slot, button, mode)，顺序一致
    if (String(windowId) === '0') {
      slot = this.engineInvToMineflayer(slot);   // 引擎背包布局 => mineflayer 背包窗口布局
    }
    const bot = this.bot;
    // Paper 对每次窗口点击都回全量 window_items（stateId 递增）。点击后等回包落地再比对
    // slots：服务器侧状态有变化 => 点击生效；无变化 => 真被拒/无副作用 => 重试。
    const snap = (w) => JSON.stringify(w.slots.map((s) => (s ? [s.name, s.count] : 0)));
    for (let attempt = 0; attempt < 4; attempt++) {
      const win = bot.currentWindow;
      if (!win || win.id === 0) break;
      const before = snap(win);
      await Promise.race([
        bot.clickWindow(slot, button, mode),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      await new Promise((r) => setTimeout(r, 250));   // 等全量回包覆盖本地预测
      if (snap(win) !== before) return;
    }
  }

  async use_entity(id, kind) {
    const e = this.bot.entities[id];
    if (!e) throw new Error(`实体 ${id} 不存在`);
    if (kind === 'attack') await this.bot.attack(e);
    else await this.bot.activateEntity(e);
  }

  async use_block(pos) {
    const block = this.bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) throw new Error(`方块未加载 ${JSON.stringify(pos)}`);
    await this.bot.activateBlock(block);
  }

  async use_item(phase) {
    if (phase === 'start') await this.bot.activateItem();
    else await this.bot.deactivateItem();
  }

  async dig(pos, phase) {
    const block = this.bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) throw new Error(`方块未加载 ${JSON.stringify(pos)}`);
    if (phase === 'cancel') {
      this.bot.stopDigging();
      return;
    }
    await this.bot.dig(block);
  }

  async respawn() {
    this.bot.respawn();
  }

  // ================= 查询 =================

  query_block_sync(pos) {
    const b = this.bot?.blockAt?.(new Vec3(pos.x, pos.y, pos.z));
    return b?.name ?? null;
  }

  async query_scan(region, kinds, limit) {
    const bot = this.bot;
    if (!bot) return [];
    const kindSet = new Set(kinds.map((k) => k.replace('minecraft:', '')));
    const [c1, c2] = region;
    const x1 = Math.min(c1.x, c2.x), x2 = Math.max(c1.x, c2.x);
    const y1 = Math.min(c1.y, c2.y), y2 = Math.max(c1.y, c2.y);
    const z1 = Math.min(c1.z, c2.z), z2 = Math.max(c1.z, c2.z);
    const center = new Vec3((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    void 0;
    const maxDistance = Math.ceil(Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2 + (z2 - z1) ** 2) / 2) + 2;
    const found = bot.findBlocks({
      point: center,
      maxDistance,
      count: limit * 2,
      useExtraInfo: true,   // 函数匹配器需要 true（否则按 stateId 匹配，函数不会被调用）
      matching: (block) => kindSet.has(block.name),
    }) ?? [];
    return found
      .map((p) => ({ x: p.x, y: p.y, z: p.z }))
      .filter((p) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2 && p.z >= z1 && p.z <= z2)
      .slice(0, limit);
  }
}
