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

export class AbiDispatcher {
  constructor(services) {
    this.s = services;
    this.rex = new Map();
    this.rexSeq = 0;
    this.handlers = this._buildHandlers();
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
    if (!spec || !fn) return JSON.stringify(errResult('abi.unknown_op', op));
    let args;
    try {
      args = validateArgs(op, spec, parseArgs(argsJson));
    } catch (e) {
      return JSON.stringify(this._resultOf(e, op));
    }
    try {
      const out = fn(args);
      return JSON.stringify(okResult(out === undefined ? null : out));
    } catch (e) {
      return JSON.stringify(this._resultOf(e, op));
    }
  }

  asyncOp(op, argsJson) {
    const { hub, policy, runtime, obs } = this.s;
    const token = hub.newToken('action');
    const spec = ASYNC_OPS[op];
    const fn = this.handlers[op];
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

    (async () => {
      try {
        const result = await fn(args, token);
        if (result !== null) hub.settleOk(token, result ?? {});
      } catch (e) {
        const r = this._resultOf(e, op);
        hub.settleErr(token, r.error.code, r.error.message);
      }
    })();
    return token;
  }

  _buildHandlers() {
    const s = this.s;
    const { driver, data, policy, obs, persist, windows, selfState } = s;
    const hub = s.hub;

    // 契约 Stack：完整组件/属性（窗口槽位与实体装备都按组件真值返回）
    const stackOf = (raw) => (raw == null ? null : data.stack(raw));
    const entityOf = (e) => {
      if (!e) return null;
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
      'entities.list': () => (driver.query_entities?.() ?? []).map(entityOf),
      'entities.get': ({ id }) => entityOf(driver.query_entity?.(String(id)) ?? null),

      // ---- 世界 ----
      'world.block': ({ pos }) => {
        const live = driver.block_info?.(pos);
        if (live) {
          return {
            ...live,
            is_container: data.isContainerName(live.id),
            stale: false,
          };
        }
        const cached = s.world.cache.get(`${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`);
        if (!cached) return null;
        return { id: cached.name, properties: null, state_id: null, hardness: null, block_entity: null, is_container: data.isContainerName(cached.name), stale: true };
      },
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
      'window.get': ({ window: wid }) => {
        const v = windows.view(wid);
        if (!v) return null;
        return {
          ...v,
          slots: v.slots.map((sl) => ({ index: sl.index, item: stackOf(sl.item) })),
          cursor: stackOf(v.cursor),
        };
      },

      // ---- 物品 ----
      'item.stack': ({ stack }) => data.stack(stack),

      // ---- 聊天策略（只读） ----
      'chat.config': () => policy.chatConfig(),

      // ---- persist ----
      'persist.table': ({ name, schema }) => { persist.declareTable(String(name), schema ?? {}); },
      'persist.find': ({ name, where }) => persist.find(String(name), where ?? {}),
      'persist.all': ({ name }) => persist.all(String(name)),
      'persist.upsert': ({ name, row }) => { persist.upsert(String(name), row); },
      'persist.del': ({ name, where }) => { persist.del(String(name), where ?? {}); },
      'persist.adjust': ({ name, key, delta }) => persist.adjust(String(name), key, Number(delta)),
      'persist.seen': ({ key, window_ms: win }) => persist.seen(String(key), Number(win)),
      'kv.get': ({ name, key }) => persist.kvGet(String(name), String(key)),
      'kv.set': ({ name, key, value }) => { persist.kvSet(String(name), String(key), String(value)); },
      'persist.log_declare': ({ name }) => { persist.logDeclare(String(name)); },
      'persist.log_append': ({ name, fields }) => persist.logAppend(String(name), fields ?? {}),
      'persist.log_find': ({ name, where }) => persist.logFind(String(name), where ?? {}),
      'persist.log_mark': ({ name, id, state }) => { persist.logMark(String(name), Number(id), String(state)); },
      'txn.begin': () => { persist.txnBegin(); },
      'txn.commit': () => { persist.txnCommit(); },
      'txn.rollback': () => { persist.txnRollback(); },

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
