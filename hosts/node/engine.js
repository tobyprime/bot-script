// hosts/node/engine.js — Node 宿主组装（vm + tokens + state + abi + obs + 实例状态 + driver）
//
// 这里只做接线与生命周期；语义在 runtime/lua（调度/命令/参数/bsl），原语在 abi.js，
// 策略在 policy.js，实例级小状态在 stateStore.js。组装层不讲业务。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { LuaVm } from './vm.js';
import { TokenHub, TimerBank, TYPE_ERR } from './tokens.js';
import { Observation } from './obs.js';
import { StateStore } from './stateStore.js';
import { Policy } from './policy.js';
import { DataRegistry } from './data.js';
import { AbiDispatcher } from './abi.js';
import { SelfState } from './state/self.js';
import { WorldState, normalizePos } from './state/world.js';
import { WindowState } from './state/windows.js';
import { SessionState } from './state/session.js';

const nowMs = () => Date.now();

export class BotEngine {
  /**
   * @param cfg  bot.yaml 解析结果（name/scripts/params）
   * @param driver 驱动实例（in-process 或 WS）
   * @param opts { scriptDir, statePath, log, dryRun, boundary, runtime, connect, instanceParams, onParamsChanged }
   */
  constructor(cfg, driver, opts = {}) {
    this.cfg = cfg;
    this.driver = driver;
    this.opts = opts;
    this.name = cfg.name ?? 'bot';
    this.boundary = opts.boundary ?? null;
    this.runtimeCfg = { ...(opts.runtime ?? {}) };
    if (opts.dryRun) this.runtimeCfg.dry_run = true;
    this.connectCfg = opts.connect ?? {};

    this.obs = new Observation({ name: this.name, outerLog: opts.log });
    this.hub = new TokenHub({
      resume: (taskId, okj, ej) => this._resume(taskId, okj, ej),
      log: (level, msg) => this.obs.log(level, msg),
    });
    this.timers = new TimerBank();
    this.session = new SessionState();
    this.stateStore = new StateStore(opts.statePath || ':memory:');
    this.policy = new Policy(this.boundary, {
      entityLookup: (id) => driver.query_entity?.(id) ?? null,
      selfPos: () => this.selfState?.pos() ?? null,
      isContainerOpen: () => this.windows?.current() != null,
    });
    this.data = new DataRegistry({
      version: this.connectCfg.version,
      log: (level, msg) => this.obs.log(level, msg),
      // minecraft-data 装配失败不致命：data.registry=false 会出现在 /caps
    });
    this.selfState = new SelfState({ driver });
    this.world = new WorldState({ driver, data: this.data });
    this.windows = new WindowState();
    this.eventQueue = [];
    this.eventWaiters = [];
    this.scriptTimers = [];      // 待生效（脚本加载期注册）
    this.scriptTimerSeq = 0;
    this.rex = new Map();
    this.reconAttempts = 0;
    this.reconnectDueAt = null;
    this.credentialUpdatedAt = null;
    this.started = false;
    this.stopped = false;
    this.handledSpawn = false;
    this.readyPending = false;
    this._mounted = new Set();
    this._loading = false;      // 新脚本声明期：timer.after 先入队，swap 后统一生效
    this._reloading = false;    // 热重载窗口：动作拒绝（runtime.reloading），查询照常

    this.abi = new AbiDispatcher({
      name: this.name,
      driver,
      data: this.data,
      policy: this.policy,
      obs: this.obs,
      stateStore: this.stateStore,
      hub: this.hub,
      selfState: this.selfState,
      world: this.world,
      windows: this.windows,
      session: this.session,
      connectCfg: this.connectCfg,
      runtime: { dryRun: !!this.runtimeCfg.dry_run, reloading: () => this._reloading },
      timerArm: (fn, ms) => this.timers.arm(fn, ms),
      scriptTimer: {
        after: (delay) => this._registerTimer({ once: true, delay }),
        interval: (ms) => this._registerTimer({ once: false, interval: ms }),
      },
      events: {
        emit: (type, data) => this.obs.publish('event', {
          ts: nowMs(), name: String(type).slice(0, 64), data: data ?? {},
        }).seq,
        next: (token, timeout) => this._nextEvent(token, timeout),
      },
      control: {
        pause: (reason) => this.pause(reason),
        resume: () => this.resume(),
        status: () => this.status(),
      },
      runtimeState: {
        sessionState: () => this.session.state,
        paused: () => this.hub.paused,
        pauseReason: () => this.pauseReason ?? null,
      },
    });
    this.lua = null;
  }

  // ================= 生命周期 =================

  async start() {
    // 1) 参数值由部署层经 instanceParams 传入；核心不落盘（真源在平台实例配置）
    // 2) 驱动事件接线
    const d = this.driver;
    d.on('session', (p) => this.onSession(p));
    d.on('chat', (p) => this.onChat(p));
    d.on('self', (p) => this.onSelf(p));
    d.on('entity_appeared', (p) => this.event('entity.appeared', p));
    d.on('entity_gone', (p) => this.event('entity.gone', p));
    d.on('window', (p) => this.windows.apply(p));
    d.on('window_close', (p) => this.onWindowClose(p));
    d.on('block_update', (p) => {
      this.world.onBlockChanged(p.pos, p.name);
      this.event('world.block_changed', normalizePos(p.pos));
    });
    d.on('death', () => {
      this.event('self.died', {});
      // 自动重生：会话生命周期 timer，不进 timer 冻结域（pause 期间也应回到出生点）
      setTimeout(() => { if (!this.stopped) d.respawn?.().catch?.(() => {}); }, 1200);
    });
    d.on('respawn', () => this.event('self.respawned', {}));
    d.on('damaged', (p) => this.event('self.damaged', p));
    // 自定义网络包入站：与出站共用 boundary.packets 权限位（未授权时连监听都不可见）
    d.on('custom_payload', (p) => {
      if (this.policy.packetsAllowed()) this.event('net.payload', p);
    });

    // 2.5) 连接。dry-run 跳过实连（对齐「不实连服务器」语义）
    if (this.runtimeCfg.dry_run) {
      this.session.apply({ state: 'dry', info: { dry: true } });
      this.obs.log('info', 'dry-run：跳过实连（脚本、HTTP 控制通道照常，动作空转）');
    } else {
      await d.connect(this.connectCfg);
    }

    // 3) Lua VM + 核心
    await this.createLua();

    // 4) 脚本加载（声明期）
    await this._loadScripts(this.lua, this.cfg);

    // 5) 参数绑定（核心持有 schema/values；宿主 HTTP 经 __core_call 读取）
    this.paramsSnapshotCache = this.coreCall('params.bind', {
      manifest: this.cfg.params ?? {},
      instance: this.opts.instanceParams ?? {},
    });

    // 6) 启动序：on_start
    this.event('lifecycle', { kind: 'on_start' });

    // 7) 定时器生效
    for (const t of this.scriptTimers) this._activateScriptTimer(t);
    this.scriptTimers = [];
    if (this.hub.paused) this.timers.freeze();

    this.started = true;
    if (this.readyPending) {
      this.readyPending = false;
      this.fireReady();
    }
    this.obs.log('info', `引擎启动完成 driver=${d.constructor.name} paused=${this.hub.paused}`);
  }

  /** 把清单里的脚本（连同同目录 .lua）载入指定 VM；返回本次挂载的文件名集合。 */
  async _loadScripts(lua, cfg) {
    const mounted = new Set();
    const scriptDir = this.opts.scriptDir ?? process.cwd();
    for (const s of cfg?.scripts ?? []) {
      const file = path.isAbsolute(s) ? s : path.join(scriptDir, s);
      const dir = path.dirname(file);
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter((f2) => f2.endsWith('.lua') && f2 !== path.basename(file))) {
          if (mounted.has(f)) continue;
          mounted.add(f);
          await lua.mount(f, readFileSync(path.join(dir, f), 'utf8'));
        }
      }
      const src = readFileSync(file, 'utf8');
      mounted.add(path.basename(file));
      this.driver.mountFile?.(path.basename(file), src);
      await lua.doString(src);
    }
    return mounted;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectDueAt = null;
    this.timers.clearAll();
    try { await this.driver.stop?.(); } catch { /* ignore */ }
    try { this.lua?.close(); } catch { /* ignore */ }
    this.stateStore?.close();
  }

  async createLua() {
    this.lua = await new LuaVm({
      scriptDir: this.opts.scriptDir ?? process.cwd(),
      log: (level, msg) => this.obs.log(level, msg),
    }).start();
    this._registerBridges(this.lua);
    this._mounted = new Set();
  }

  _registerBridges(lua = this.lua) {
    lua.setGlobal('__host_q', (op, argsJson) => this.abi.sync(op, argsJson));
    lua.setGlobal('__host_a', (op, argsJson) => this.abi.asyncOp(op, argsJson));
  }

  _resume(taskId, okj, ej) {
    this.lua.fn('__core_resume')(taskId, okj ?? '', ej ?? '');
  }

  /** 宿主 → 核心同步（显式反向契约；返回信封解包后的结果，失败抛类型化错误） */
  coreCall(op, args = {}) {
    return this._coreCallOn(this.lua, op, args);
  }

  _coreCallOn(lua, op, args = {}) {
    if (!lua) throw TYPE_ERR('runtime.error', 'Lua 未就绪');
    const raw = lua.fn('__core_call')(op, JSON.stringify(args ?? {}));
    let env;
    try { env = JSON.parse(raw || '{}'); } catch { env = { ok: false, error: { kind: 'runtime.error', detail: String(raw) } }; }
    if (!env.ok) {
      const e = env.error ?? {};
      const err = new Error(e.detail ?? e.kind ?? op);
      err.kind = e.kind;
      err.detail = e.detail ?? null;
      throw err;
    }
    return env.result;
  }

  // ================= 脚本热重载 =================
  //
  // 语义：重读 scriptDir/bot.yaml 与脚本文件，在**新 VM** 里完整跑一遍声明期；
  // 全部成功后才取消旧任务、换 VM（编译/声明失败则旧脚本继续跑，连接不断）。
  // 保持：MC 会话、driver、state、日志/聊天环、HTTP 控制通道、暂停状态。
  // 不保持：旧任务、旧脚本定时器、旧闭包状态（脚本需从 state 恢复自己的状态）。
  async reloadScripts({ reason = 'hot-reload' } = {}) {
    if (this.stopped || !this.started) throw TYPE_ERR('runtime.error', '引擎未启动，无法热重载');
    if (this._reloading) throw TYPE_ERR('runtime.busy', '已有热重载在进行中');
    this._reloading = true;

    let next = null;
    let committed = false;
    const scriptDir = this.opts.scriptDir ?? process.cwd();
    try {
      const nextCfg = readManifest(scriptDir, this.cfg);
      next = await new LuaVm({
        scriptDir,
        log: (level, msg) => this.obs.log(level, msg),
      }).start();
      this._registerBridges(next);

      // 声明期：timer.after/interval 先入队，不落到旧 TimerBank
      const prevLoading = this._loading;
      this._loading = true;
      this.scriptTimers = [];
      const mounted = await this._loadScripts(next, nextCfg);
      this._loading = prevLoading;

      const snapshot = this._coreCallOn(next, 'params.bind', {
        manifest: nextCfg.params ?? {},
        instance: this.opts.instanceParams ?? {},
      });

      // ---- commit：以下不再可失败的 Lua 编译；旧脚本此时才停止 ----
      const old = this.lua;
      try { old?.doString('task.cancel_all("hot-reload")'); } catch { /* 旧 VM 收尾失败不阻断换轨 */ }
      // 旧任务的移动/寻路不会随 VM 关闭自动停止：显式停走，避免换轨后继续移动
      try { Promise.resolve(this.driver.path_cancel?.()).catch(() => {}); } catch { /* ignore */ }
      try { Promise.resolve(this.driver.dig_stop?.()).catch(() => {}); } catch { /* ignore */ }
      try { Promise.resolve(this.driver.input?.({ forward: 0, right: 0, up: 0, sprint: false, sneak: false })).catch(() => {}); } catch { /* ignore */ }
      try { old?.close(); } catch { /* ignore */ }
      this.timers.clearAll();
      this.hub.tokens.clear();
      this.hub.settled.clear();
      this.hub.pendingResume.length = 0;
      this.hub.frozen.length = 0;
      this.eventQueue.length = 0;    // 旧脚本的 events.next 等待者/排队属于旧 VM
      this.eventWaiters.length = 0;

      this.lua = next;
      this.cfg = nextCfg;
      this._mounted = mounted;
      this.paramsSnapshotCache = snapshot;
      committed = true;
      this._reloading = false;   // 换轨完成：新脚本从现在起可以发包

      this.obs.log('info', `脚本热重载完成（${reason}）：${(nextCfg.scripts ?? []).join(', ') || '无脚本'}`);
      this.event('lifecycle', { kind: 'on_start' });
      // 新脚本的 on_event("session.ready") 不应等到下次重连：当前已进服就重放一次
      if (this.session.state === 'playing') {
        this.event('session.ready', { dimension: this.session.info?.dimension ?? null });
      }
      for (const t of this.scriptTimers) this._activateScriptTimer(t);
      this.scriptTimers = [];
      if (this.hub.paused) this.timers.freeze();
      return { ok: true, scripts: nextCfg.scripts ?? [], manifest: nextCfg.name ?? null };
    } catch (e) {
      this._loading = false;
      if (!committed) {
        this.scriptTimers = [];   // 声明期登记的 timer 属于未换轨的新脚本，丢弃
        try { next?.close(); } catch { /* ignore */ }
      }
      const err = e?.kind ? e : Object.assign(new Error(String(e?.message ?? e)), {
        kind: 'lua.compile',
        detail: String(e?.message ?? e),
      });
      if (committed) {
        this.obs.log('error', `脚本热重载已换轨，但新脚本启动序报错：${err.detail ?? err.message}`);
      } else {
        this.obs.log('error', `脚本热重载失败，保持旧脚本运行：${err.detail ?? err.message}`);
      }
      throw err;
    } finally {
      this._reloading = false;
    }
  }

  // ================= 状态 / 事件 =================

  onSession(p) {
    const prev = this.session.state;
    this.session.apply({ state: p.state, info: p.info });
    if (p.state === 'playing' && prev !== 'playing') {
      this.reconAttempts = 0;
      this.reconnectDueAt = null;
      // item.stack 数据源：连接拿到真实版本后重建注册表
      this.data.setVersion(this.session.info?.version ?? this.connectCfg.version);
      if (!this.handledSpawn) {
        this.handledSpawn = true;
        setTimeout(() => this.fireReady(), 1500);
      } else if (this.hub.paused && (this.pauseReason === 'disconnect' || this.pauseReason === 'kicked')) {
        this.obs.log('info', '重连成功，自动 resume');
        this.resume();
      }
    }
    if ((p.state === 'kicked' || p.state === 'disconnected') && !this.stopped) {
      this.invalidateSessionCache();
      const reason = p.reason ?? '';
      if (!this.hub.paused) {
        this.obs.log('warn', `会话 ${p.state}: ${reason} -> 自动 pause`);
        this.pause(p.state === 'kicked' ? 'kicked' : 'disconnect');
      } else {
        // kicked 后 mineflayer 还会再发 end：此时已在暂停，降为 debug，避免重复告警
        this.obs.log('debug', `会话 ${p.state}: ${reason}（已暂停：${this.pauseReason ?? '-'}）`);
      }
      this.scheduleReconnect();
    }
  }

  invalidateSessionCache() {
    this.windows.clear();
    this.world.clear();
  }

  static backoffDelay(attempts, baseMs = 30000, maxMs = 120000, rnd = Math.random) {
    const base = Math.min(maxMs, baseMs * attempts);
    return Math.round(base * (1 + (2 * rnd() - 1) * 0.2));
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer || this.runtimeCfg.dry_run) return;
    const rc = this.runtimeCfg.reconnect ?? {};
    const baseMs = Number(rc.base_ms) || 30000;
    const maxMs = Number(rc.max_ms) || 120000;
    this.reconAttempts = (this.reconAttempts ?? 0) + 1;
    const delay = BotEngine.backoffDelay(this.reconAttempts, baseMs, maxMs);
    this.reconnectDueAt = nowMs() + delay;
    this.obs.log('info', `${Math.round(delay / 1000)}s 后尝试重连（第 ${this.reconAttempts} 次）`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDueAt = null;
      if (this.stopped || this.session.state === 'playing') return;
      try {
        if (this.driver.reconnect) await this.driver.reconnect(this.connectCfg);
        else await this.driver.connect(this.connectCfg);
        this.session.apply({ state: 'connecting' });
        this.obs.log('info', '重连尝试已发起');
      } catch (e) {
        this.obs.log('error', `重连发起失败: ${e.message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  fireReady() {
    if (this.stopped) return;
    if (!this.lua) { this.readyPending = true; return; }
    this.event('session.ready', { dimension: this.session.info?.dimension ?? null });
  }

  onChat(p) {
    // ABI v2：没有命令体系；聊天只作为 chat 事件进入核心（on_chat / await_chat）
    this.event('chat', p);
    this.obs.publish('chat', {
      ts: p.ts ?? nowMs(),
      text: String(p.text ?? ''),
      raw: String(p.raw ?? ''),
      sender: p.sender ?? null,
      sender_kind: p.sender_kind === 'player' ? 'player' : 'system',
    });
  }

  onSelf(p) {
    this.selfState.update(p);
    if (p.pos && !this.policy.inFence(p.pos)) {
      if (!this.hub.paused) {
        this.obs.log('warn', `越出活动围栏 ${JSON.stringify(p.pos)} -> 自动 pause`);
        this.pause('fence');
      }
    }
  }

  onWindowClose(p) {
    const r = this.windows.close(p.id);
    if (r.closedCurrent) this.event('container.closed', { id: String(p.id) });
  }

  // ================= 暂停门控 =================

  pause(reason) {
    if (this.hub.paused) return;
    this.hub.paused = true;
    this.pauseReason = reason ?? 'manual';
    try { Promise.resolve(this.driver.path_cancel?.()).catch?.(() => {}); } catch { /* ignore */ }
    try { Promise.resolve(this.driver.input?.({ forward: 0, right: 0, up: 0, sprint: false, sneak: false })).catch?.(() => {}); } catch { /* ignore */ }
    this.timers.freeze();
    this.hub.settleActionsOnPause(this.pauseReason);
    this.event('lifecycle', { kind: 'on_pause', payload: { reason: this.pauseReason } });
    this.obs.log('warn', `PAUSE (${this.pauseReason})`);
  }

  resume() {
    if (!this.hub.paused) return;
    this.hub.paused = false;
    const wasReason = this.pauseReason;
    this.pauseReason = null;
    this.obs.log('info', `RESUME（原暂停原因 ${wasReason}）`);
    this.timers.unfreeze();
    this.event('lifecycle', { kind: 'on_resume', payload: { reason: wasReason } });
    this.hub.releaseFrozen();
  }

  event(kind, payload) {
    if (!this.lua) return;
    const fj = this.lua.fn('__core_event');
    this.hub.depth++;
    try {
      fj(kind, payload === undefined ? '' : JSON.stringify(payload));
    } catch (e) {
      this.obs.log('error', `事件 ${kind} 分发失败: ${e.message}`);
    } finally {
      this.hub.depth--;
    }
    this.hub.flushPending();
  }

  /** 平台事件入站（控制通道 /event）：有等待者直付，否则入队（容量 64，溢出丢最旧） */
  _nextEvent(token, timeout) {
    const rec = this.hub.tokens.get(token);
    if (rec) rec.kind = 'event';   // 不参与 pause 的动作结算域
    const ev = this.eventQueue.shift();
    if (ev) {
      this.hub.settleOk(token, ev);
      return;
    }
    const w = { token };
    w.timer = this.timers.arm(() => {
      const i = this.eventWaiters.indexOf(w);
      if (i >= 0) this.eventWaiters.splice(i, 1);
      const t = this.hub.tokens.get(token);
      if (t && !t.settled) this.hub.settleOk(token, null);   // 超时交付 nil（events.next 返回 {ok=true,value=nil}）
    }, Math.max(0, Number(timeout) || 30000));
    this.eventWaiters.push(w);
  }

  pushEvent(type, data) {
    const ev = { type: String(type), data: (data && typeof data === 'object') ? data : {}, ts: nowMs() };
    const w = this.eventWaiters.shift();
    if (w) {
      this.timers.clear(w.timer);
      this.hub.settleOk(w.token, ev);
      return;
    }
    if (this.eventQueue.length >= 64) this.eventQueue.shift();
    this.eventQueue.push(ev);
  }

  // ================= 脚本定时器（on_timer / after） =================

  _registerTimer(t) {
    const id = ++this.scriptTimerSeq;
    const spec = { id, ...t };
    if (this.started && !this._loading) this._activateScriptTimer(spec);
    else this.scriptTimers.push(spec);
    return id;
  }

  _activateScriptTimer(t) {
    if (t.once) this.timers.arm(() => this.event('after', { id: t.id }), t.delay);
    else this.timers.arm(() => this.event('timer', { id: t.id }), t.interval, { repeat: true });
  }

  // ================= 会话凭据（POST /session） =================

  updateSessionCredential({ access_token: token, username, uuid } = {}) {
    const acct = this.connectCfg.account;
    if (!acct || acct.auth !== 'session') {
      const e = new Error('account is not auth=session mode');
      e.kind = 'session.account_mode';
      throw e;
    }
    if (typeof token !== 'string' || !token.trim()) {
      const e = new Error('access_token required (non-empty string)');
      e.kind = 'session.bad_request';
      throw e;
    }
    if ((username != null && username !== acct.username) || (uuid != null && uuid !== acct.uuid)) {
      const e = new Error('credential identity mismatch');
      e.kind = 'session.identity_mismatch';
      throw e;
    }
    acct.accessToken = token;
    this.credentialUpdatedAt = nowMs();
    const effective = this.session.state === 'playing' ? 'next_connect' : 'next_reconnect';
    this.obs.log('info', `会话凭据已更新（生效时机=${effective}，在线连接不受影响）`);
    return { applied: true, effective };
  }

  // ================= 控制面（HTTP 用） =================

  status() {
    return {
      state: this.session.state,
      paused: this.hub.paused,
      pause_reason: this.pauseReason ?? null,
      pos: this.selfState.pos(),
    };
  }

  paramsSnapshot() {
    this.paramsSnapshotCache = this.coreCall('params.get');
    return this.paramsSnapshotCache;
  }

  setParam(k, v) {
    const r = this.coreCall('params.set', { key: String(k), value: v });
    this.paramsSnapshot();   // 刷新缓存（/params 与 paramValues 观察面）
    if (r?.ok !== false) {
      const values = Object.fromEntries(this.paramValues);
      this.opts.instanceParams = values;   // 热重载重新 bind 时沿用最新值（引擎不再落盘）
      try { this.opts.onParamsChanged?.(values); } catch { /* 落盘由宿主负责，失败不影响热更 */ }
    }
    return r;
  }

  taskListFull() {
    try { return this.coreCall('tasks.list'); } catch { return []; }
  }

  cancelTask(name) {
    try { return this.coreCall('tasks.cancel', { name: String(name) }); } catch (e) {
      return { ok: false, found: false, error: String(e?.message ?? e) };
    }
  }

  evalOnce(name, code) {
    return this.coreCall('eval.once', { name: String(name), code: String(code) });
  }

  /** 操作者直接发消息/命令（POST /chat）：console 级，不过脚本 chat 策略 */
  async outboundChat(text) {
    const s = String(text ?? '');
    if (!s.trim()) throw TYPE_ERR('chat.bad_request', 'text 必填');
    if (this.session.state !== 'playing' && this.session.state !== 'dry') {
      throw TYPE_ERR('chat.offline', `当前会话状态 ${this.session.state}，无法发言`);
    }
    if (!this.runtimeCfg.dry_run) await this.driver.chat_send(s);
    return this.obs.publish('chat', { ts: nowMs(), text: s, raw: s, sender: this.name, sender_kind: 'self' });
  }

  checkChatPolicy(text, kind = 'command') {
    const err = this.policy.checkChat(kind, String(text));
    if (err) {
      const e = new Error(err.detail ?? err.kind);
      e.kind = err.kind;
      throw e;
    }
  }

  /** 观测面（http17/测试用） */
  subscribeStream(fn) { return this.obs.subscribe(fn); }
  ringSince(type, seq) { return this.obs.ringSince(type, seq); }
  get streamSeq() { return this.obs.seq; }
  get paused() { return this.hub.paused; }
  get sessionState() { return this.session.state; }
  get sessionInfo() { return this.session.info; }
  get self() { return this.selfState.last; }
  get currentWindowId() { return this.windows.current(); }
  get actionLog() { return this.obs.actionRing; }
  get logRing() { return this.obs.logRing; }
  get chatRing() { return this.obs.chatRing; }
  get eventRing() { return this.obs.eventRing; }
  get timerSpecs() { return this.timers.specs; }
  get paramValues() { const p = this.paramsSnapshotCache ?? { values: {} }; return new Map(Object.entries(p.values ?? {})); }
  get paramPersist() { return this.paramValues; }
  luaFn(name) { return this.lua.fn(name); }
}

/** 热重载：重读包清单；文件缺失/解析失败沿用启动时的清单。state 数据源始终沿用已打开实例。 */
function readManifest(dir, fallback) {
  const p = path.join(dir, 'bot.yaml');
  if (!existsSync(p)) return fallback;
  try {
    const m = parseYaml(readFileSync(p, 'utf8')) ?? {};
    if (!m || typeof m !== 'object' || Array.isArray(m)) return fallback;
    return m;
  } catch {
    return fallback;
  }
}
