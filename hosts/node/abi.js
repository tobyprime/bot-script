// hosts/node/abi.js — 宿主 ABI v2 唯一 dispatch（策略 / 速率 / 预算 / 审计 / 结算）
import { ASYNC_OPS, SYNC_OPS, ABI_VERSION, validateArgs } from './abi.generated.js';
import { okResult, errResult, TYPE_ERR } from './tokens.js';

const nowMs = () => Date.now();

function parseArgs(j) {
  if (j == null || j === '') return {};
  try {
    const v = JSON.parse(j);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

const roundPos = (p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });

function withTimeout(p, ms, err) {
  let to;
  const t = new Promise((_, rej) => { to = setTimeout(() => rej(err), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(to));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 自定义网络包（custom payload）：通道 = 资源位置；载荷经 base64 过 JSON，宿主解码后限额。
const CUSTOM_PAYLOAD_CHANNEL = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,128}$/;
const CUSTOM_PAYLOAD_MAX = 1 << 20;   // 1 MiB（与服务端自定义载荷上限对齐）

function decodeCustomPayload(b64) {
  const s = String(b64 ?? '');
  if (!s) return Buffer.alloc(0);
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw withKind(new Error('自定义网络包载荷不是合法 base64'), 'net.bad_payload');
  }
  const buf = Buffer.from(s, 'base64');
  if (buf.length > CUSTOM_PAYLOAD_MAX) {
    throw withKind(new Error(`载荷过大（${buf.length} > ${CUSTOM_PAYLOAD_MAX} 字节）`), 'net.bad_payload');
  }
  return buf;
}

export class AbiDispatcher {
  constructor(services) {
    this.s = services;
    this.rex = new Map();
    this.rexSeq = 0;
    this.handlers = this._buildHandlers();
    // 查询成本观测（PERF-REFACTOR §3.7）：每 op 的调用数/进出字节/耗时，`/state.perf` 可读。
    this.metrics = new Map();
    this.metricsSince = Date.now();
  }

  _record(op, kind, bytesIn, bytesOut, us, addCall = true) {
    let m = this.metrics.get(op);
    if (!m) { m = { calls: 0, bytes_in: 0, bytes_out: 0, us: 0, max_us: 0, kind }; this.metrics.set(op, m); }
    if (addCall) m.calls += 1;
    m.bytes_in += bytesIn;
    m.bytes_out += bytesOut;
    m.us += us;
    if (us > m.max_us) m.max_us = us;
  }

  /** /state.perf：按出站字节/秒排序的 top-N（查询 CPU 的代理指标） */
  perf(limit = 12) {
    const sec = Math.max(1, (Date.now() - this.metricsSince) / 1000);
    return [...this.metrics.entries()]
      .map(([op, m]) => ({
        op, kind: m.kind,
        calls: m.calls,
        hz: +(m.calls / sec).toFixed(1),
        bytes_out: m.bytes_out,
        kb_s: +(m.bytes_out / sec / 1024).toFixed(1),
        us_avg: +(m.us / (m.calls || 1)).toFixed(0),
        us_max: m.max_us,
      }))
      .sort((a, b) => b.kb_s - a.kb_s)
      .slice(0, limit);
  }

  /**
   * 确定性失败 -> Result；宿主意外异常只进宿主日志，Lua 只看到稳定的 internal 码。
   * 绝不把 JS 异常/栈带进 Lua。
   */
  _resultOf(e, op) {
    const kind = e && typeof e === 'object' ? (e.kind ?? e.botscriptKind) : null;
    if (kind) return errResult(kind, e.detail ?? e.message ?? '');
    const trace = `abi-${nowMs()}`;
    try {
      this.s.obs.log('error', `[${trace}] ${op} 宿主异常: ${e?.stack ?? e?.message ?? e}`);
    } catch { /* 日志失败不影响结算 */ }
    return errResult('internal', `内部错误（追踪 ${trace}）`);
  }

  /** 同步 op：永远返回 JSON Result，不向 Lua 抛异常 */
  sync(op, argsJson) {
    const spec = SYNC_OPS[op];
    const fn = this.handlers[op];
    if (!spec || !fn) {
      this._record(op, 'sync', 0, 0, 0);
      return JSON.stringify(errResult('abi.unknown_op', op));
    }
    let args;
    try {
      args = validateArgs(op, spec, parseArgs(argsJson));
    } catch (e) {
      this._record(op, 'sync', (argsJson ?? '').length, 0, 0);
      return JSON.stringify(this._resultOf(e, op));
    }
    const t0 = performance.now();
    try {
      const out = fn(args);
      const body = JSON.stringify(okResult(out === undefined ? null : out));
      this._record(op, 'sync', (argsJson ?? '').length, body.length, performance.now() - t0);
      return body;
    } catch (e) {
      this._record(op, 'sync', (argsJson ?? '').length, 0, performance.now() - t0);
      return JSON.stringify(this._resultOf(e, op));
    }
  }

  asyncOp(op, argsJson) {
    const { hub, policy, runtime, obs } = this.s;
    const token = hub.newToken('action');
    const spec = ASYNC_OPS[op];
    const fn = this.handlers[op];
    const bytesIn = (argsJson ?? '').length;
    this._record(op, 'async', bytesIn, 0, 0);
    if (!spec || !fn) {
      hub.settleErr(token, 'abi.unknown_op', op);
      return token;
    }
    let args;
    try {
      args = validateArgs(op, spec, parseArgs(argsJson));
    } catch (e) {
      const r = this._resultOf(e, op);
      hub.settleErr(token, r.error.code, r.error.message);
      return token;
    }
    // 热重载窗口：新脚本声明期可能调用动作；与旧脚本换轨前一律拒绝，避免双份脚本同时发包。
    // 只拦 act.*：sleep/events.next 等调度原语不受影响。
    if (op.startsWith('act.') && runtime.reloading?.()) {
      hub.settleErr(token, 'runtime.reloading', '脚本热重载中：动作暂不可用');
      return token;
    }
    const polErr = policy.check(op, args);
    if (polErr) { hub.settleErr(token, polErr.kind, polErr.detail); return token; }
    if (runtime.dryRun) {
      obs.log('info', `${op} ${JSON.stringify(args).slice(0, 120)} [dry]`);
      hub.settleOk(token, {});
      return token;
    }
    // 只有协议动作（act.*）计入速率/预算并写动作审计。
    // 调度/查询类 op（util.sleep、events.next、waiter.new、world.get…）不是「动作」，
    // 不得占预算、不得刷动作日志。
    if (op.startsWith('act.')) {
      const rateErr = policy.rateCheck();
      if (rateErr) { hub.settleErr(token, rateErr.kind, rateErr.detail); return token; }
      if (policy.countAction()) this.s.control.pause('budget');
      obs.publish('action', { ts: nowMs(), action: op, args: brief(args) });
    }

    const t0 = performance.now();
    (async () => {
      try {
        const result = await fn(args, token);
        if (result !== null) hub.settleOk(token, result ?? {});
      } catch (e) {
        const r = this._resultOf(e, op);
        hub.settleErr(token, r.error.code, r.error.message);
      }
    })().finally(() => {
      this._record(op, 'async', 0, 0, performance.now() - t0, false);
      // 动作耗时观测（排障用）：BOTSCRIPT_ACT_DEBUG=1 时逐条打印，定位「动作内部固定等待」。
      if (process.env.BOTSCRIPT_ACT_DEBUG && op.startsWith('act.')) {
        const dt = performance.now() - t0;
        if (dt >= (Number(process.env.BOTSCRIPT_ACT_DEBUG_MIN_MS) || 0)) {
          try { obs.log('info', `[act] ${op} dt=${dt.toFixed(0)}ms ${brief(args)}`); } catch { /* ignore */ }
        }
      }
    });
    return token;
  }

  _buildHandlers() {
    const s = this.s;
    const { driver, data, policy, obs, stateStore, windows, selfState } = s;
    const hub = s.hub;

    // 契约 Stack：完整组件/属性（窗口槽位与实体装备都按组件真值返回）
    const stackOf = (raw) => (raw == null ? null : data.stack(raw));
    const entityOf = (e, projection) => {
      if (!e) return null;
      // core 投影由驱动直接给出紧凑装备（{id,count}），不再展开组件
      if (String(projection ?? 'full') === 'core') return e;
      const equipment = {};
      for (const [k, v] of Object.entries(e.equipment ?? {})) equipment[k] = stackOf(v);
      return { ...e, equipment };
    };

    const q = {
      // ---- 基础设施 ----
      log: ({ level, msg }) => { obs.log(String(level), String(msg), 'script'); },
      'util.now': () => nowMs(),
      'util.regex_new': ({ pattern }) => {
        const id = ++this.rexSeq;
        try { this.rex.set(id, new RegExp(pattern)); } catch (e) {
          throw withKind(new Error(`rex 编译失败: ${e.message} (${pattern})`), 'abi.invalid_args');
        }
        return id;
      },
      'util.regex_match': ({ id, text }) => {
        const re = this.rex.get(Number(id));
        if (!re || text == null) return null;
        const m = re.exec(String(text));
        return m ? (m.groups ?? {}) : null;
      },
      'token.bind': ({ task_id: taskId, token, kind }) => { hub.bind(Number(taskId), Number(token), kind); },
      'token.detach': ({ token }) => { hub.detach(Number(token)); },
      'timer.after': ({ delay }) => s.scriptTimer.after(Math.max(0, Number(delay) || 0)),
      'timer.interval': ({ interval }) => s.scriptTimer.interval(Math.max(50, Number(interval) || 1000)),
      'events.emit': ({ type, data }) => s.events.emit(String(type ?? '').slice(0, 64), data ?? {}),
      'waiter.resolve': ({ token, match }) => {
        let value = null;
        try { value = match ? JSON.parse(match) : null; } catch { value = match ?? null; }
        hub.settleOk(Number(token), value);
      },

      // ---- 自身 / 会话 ----
      'self.get': () => {
        const st = selfState.snapshot();
        if (!st) return null;
        return {
          username: st.username ?? null,
          pos: st.pos ?? null,
          velocity: st.velocity ?? null,
          yaw: st.yaw ?? 0,
          pitch: st.pitch ?? 0,
          health: st.health ?? null,
          food: st.food ?? null,
          gamemode: st.gamemode ?? null,
          held: st.held ? data.stack(st.held) : null,
          held_slot: st.held_slot ?? st.heldSlot ?? 0,
          pose: st.pose ?? null,
          on_fire: st.on_fire ?? null,
          sneaking: st.sneaking ?? null,
          sprinting: st.sprinting ?? null,
          effects: st.effects ?? [],
          attributes: st.attributes ?? null,
        };
      },
      'session.get': () => ({
        state: s.runtimeState.sessionState(),
        paused: s.runtimeState.paused(),
        pause_reason: s.runtimeState.pauseReason(),
        info: driver.session_info?.() ?? s.session.info,
      }),
      'caps.get': ({ flag }) => driver.caps?.()?.[flag] === true,
      'caps.list': () => ({
        flags: driver.caps?.() ?? {},
        patches: driver.patches?.() ?? [],
        abi: ABI_VERSION,
      }),

      // ---- 实体 ----
      'entities.list': ({ type, within, pred, projection, order, limit }) =>
        (driver.query_entities?.({ type, within, pred, projection, order, limit }) ?? [])
          .map((e) => entityOf(e, projection)),
      'entities.get': ({ id, projection }) =>
        entityOf(driver.query_entity?.(String(id), projection ?? 'full') ?? null, projection),

      // ---- 世界 ----
      'world.block': ({ pos }) => s.world.block(pos),
      'world.block_entity': ({ pos }) => driver.block_entity?.(pos) ?? null,
      'world.scan': ({ region, pred, limit }) => driver.scan_blocks?.(region, data.scanKinds(pred), limit ?? 200) ?? [],
      'world.env': () => {
        const env = driver.world_env?.() ?? {};
        return {
          dimension: env.dimension ?? s.session.info?.dimension ?? null,
          time_of_day: env.time_of_day ?? null,
          weather: env.weather ?? null,
        };
      },
      'world.reach': ({ pos, max_distance: max }) => driver.reach?.(pos, max ?? 4.5)
        ?? { reachable: false, distance: null, hit_block: null },

      // ---- 容器窗口 ----
      'window.current': () => windows.current(),
      'window.get': ({ window: wid, fields }) => {
        const v = windows.view(wid);
        if (!v) return null;
        // fields=idcount：只回 {id,count}，供 inv/win 的 count/find 使用。
        // 全量 StackInfo 的组件展开 + 90 槽解码是查询 CPU 的主项（PERF-REFACTOR §2.3）。
        const idcount = String(fields ?? 'full') === 'idcount';
        const itemOfSlot = idcount
          ? (it) => (it ? { id: it.id, count: it.count } : null)
          : stackOf;
        return {
          ...v,
          slots: v.slots.map((sl) => ({ index: sl.index, item: itemOfSlot(sl.item) })),
          cursor: itemOfSlot(v.cursor),
        };
      },

      // ---- 物品 ----
      'item.stack': ({ stack }) => data.stack(stack),

      // ---- state（实例级 localStorage；固定路径，包无权指定） ----
      'state.get': ({ key }) => {
        const v = stateStore.get(String(key));
        return v === undefined ? null : v;
      },
      'state.all': () => stateStore.all(),
      'state.set': ({ key, value }) => { stateStore.set(String(key), value); return {}; },
      'state.delete': ({ key }) => { stateStore.delete(String(key)); return {}; },
      'state.seen': ({ key, window_ms: win }) => stateStore.seen(String(key), Number(win ?? 5000)),

      // ---- 调度原语 ----
      'util.sleep': ({ ms }, token) => {
        setKind(hub, token, 'sleep');
        s.timerArm(() => hub.settleOk(token, null), Math.max(0, Number(ms) || 0));
        return null;
      },
      'events.next': ({ timeout }, token) => {
        s.events.next(token, Math.max(0, Number(timeout) || 30000));
        return null;
      },
      'waiter.new': ({ timeout }, token) => {
        setKind(hub, token, 'waiter');
        s.timerArm(() => {
          const rec = hub.tokens.get(token);
          if (rec && !rec.settled) hub.settleOk(token, null);   // 超时 = 成功交付 nil
        }, Math.max(0, Number(timeout) || 5000));
        return null;
      },

      // ---- 协议动作原语 ----
      'act.custom_payload': async ({ channel, data }) => {
        const ch = String(channel ?? '');
        if (!CUSTOM_PAYLOAD_CHANNEL.test(ch)) {
          throw withKind(new Error(`非法 channel：${ch}（应为 namespace:path）`), 'net.bad_request');
        }
        if (typeof driver.custom_payload !== 'function') {
          throw withKind(new Error('宿主未实现自定义网络包收发'), 'net.unsupported');
        }
        await driver.custom_payload(ch, decodeCustomPayload(data));
        return {};
      },
      'act.chat_send': async ({ text, kind }) => {
        await driver.chat_send(String(text ?? ''), String(kind ?? 'chat'));
        return {};
      },
      'act.look': async ({ yaw, pitch }) => {
        driver.look?.(yaw != null ? Number(yaw) : undefined, pitch != null ? Number(pitch) : undefined);
        return {};
      },
      'act.input': async ({ forward, right, up, sprint, sneak }) => {
        await driver.input?.({ forward, right, up, sprint, sneak });
        return {};
      },
      'act.path_to': async ({ target, arrive, timeout_ms: timeoutMs }) => {
        let done = false;
        return await new Promise((resolve) => {
          const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
          };
          const timer = setTimeout(() => {
            try { Promise.resolve(driver.path_cancel?.()).catch(() => {}); } catch { /* ignore */ }
            finish({ ok: false, reason: 'timeout' });
          }, timeoutMs ?? 30000);
          Promise.resolve(driver.path_to(roundPos(target), { arrive })).then(
            (r) => finish(r?.ok ? { ok: true } : { ok: false, reason: r?.reason ?? 'unreachable' }),
            () => finish({ ok: false, reason: 'unreachable' }),
          );
        });
      },
      'act.path_cancel': async () => { await driver.path_cancel?.(); return {}; },
      'act.dig': async ({ pos, face }) => { await driver.dig?.(roundPos(pos), face ?? 1); return {}; },
      'act.dig_stop': async () => { await driver.dig_stop?.(); return {}; },
      'act.use_block': async ({ pos, face, hand, intent, cursor }) => {
        await driver.use_block?.(roundPos(pos), face ?? 1, hand ?? 'main', cursor ?? null);
        void intent;
        return {};
      },
      'act.use_entity': async ({ id, kind, target, hand }) => {
        await driver.use_entity?.(String(id), String(kind ?? 'attack'), target ?? null, hand ?? 'main');
        return {};
      },
      'act.swing': async ({ hand }) => { await driver.swing?.(hand ?? 'main'); return {}; },
      'act.use_item': async ({ hand, phase }) => {
        await driver.use_item?.(String(phase ?? 'start'), hand ?? 'main');
        return {};
      },
      'act.select_slot': async ({ slot }) => { await driver.select_slot?.(Number(slot)); return {}; },
      'act.drop': async ({ slot, all }) => { await driver.drop?.(slot ?? null, !!all); return {}; },
      'act.window_open': async ({ target }) => {
        const res = await withTimeout(
          Promise.resolve(driver.window_open(target)),
          6000, TYPE_ERR('container.missing', JSON.stringify(target)),
        );
        return { id: String(res.id) };
      },
      'act.window_click': async ({ window: wid, slot, button, mode, state_id: stateId }) => {
        const { window: target, slot: s2 } = windows.clickTarget(wid, slot);
        const rev = windows.revision(target);
        if (target === '0' && !windows.view('0')) await driver.window_refresh?.('0');
        await withTimeout(
          Promise.resolve(driver.window_click(target, Number(s2), Number(button) || 0, Number(mode) || 0, stateId ?? null)),
          5000, TYPE_ERR('container.closed', target),
        );
        await this._waitRevision(target, rev, 3000);
        return {};
      },
      'act.window_close': async () => { await driver.window_close?.(); return {}; },
    };
    return q;
  }

  async _waitRevision(winId, prevRev, timeoutMs) {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      if (this.s.windows.revision(winId) > prevRev) return true;
      await sleep(40);
    }
    return false;
  }
}

function brief(args) {
  const str = JSON.stringify(args);
  return str.length > 160 ? str.slice(0, 157) + '...' : str;
}

function withKind(err, kind) { err.kind = kind; return err; }

function setKind(hub, token, kind) {
  const rec = hub.tokens.get(token);
  if (rec) rec.kind = kind;
}
