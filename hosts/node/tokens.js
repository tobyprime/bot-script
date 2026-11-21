// hosts/node/tokens.js — token 结算 + 重入门控 + 定时器台账（唯一实现）
//
// 规则（ARCHITECTURE-REFACTOR §3.3）：
//   * 宿主不得在核心→宿主调用帧内反向调核心：Lua 帧深度 > 0 时交付排队，帧尾统一 flush。
//   * pause 期间交付冻结，resume 后于冻结点重抛（含 runtime.paused 的动作错误）。
//   * 一次性 timer 到点即出账：freeze/unfreeze 不得重放已触发的 after/sleep。

export const TYPE_ERR = (kind, detail) => ({ kind, detail: detail === undefined ? null : detail });

/** 跨平台稳定 Result：{ok:true,value} | {ok:false,error:{code,message}} */
export const okResult = (value) => ({ ok: true, value: value === undefined ? null : value });
export const errResult = (code, message) => ({
  ok: false,
  error: { code: String(code), message: message === undefined || message === null ? '' : String(message) },
});

export class TokenHub {
  constructor({ resume, log = () => {} }) {
    this._resume = resume;      // (taskId, okj, ej) => void
    this._log = log;
    this.tokens = new Map();    // token -> rec
    this.settled = new Map();   // token -> [okj, ej]（先于登记结算）
    this.nextToken = 1;
    this.depth = 0;             // 当前 Lua 帧深度
    this.pendingResume = [];
    this.frozen = [];
    this.paused = false;
    this.flushing = false;      // flush 重入护栏：rawResume 结束会再调 flush，不能在循环里递归
  }

  newToken(kind) {
    const token = this.nextToken++;
    this.tokens.set(token, { settled: false, waiterRegistered: false, kind, taskId: null });
    return token;
  }

  /** 挂起点登记（核心 pump 在 yield 后调用） */
  bind(taskId, token, kind) {
    const rec = this.tokens.get(Number(token));
    if (!rec) return;
    rec.waiterRegistered = true;
    rec.taskId = Number(taskId);
    rec.waitKind = String(kind);
    if (rec.settled) this.deliverToken(Number(token));
  }

  detach(token) {
    const rec = this.tokens.get(Number(token));
    if (!rec) return;
    rec.detached = true;
    // fire-and-forget 若已结算，没人会来 bind/交付：立刻出账，避免 tokens/settled 永久增长
    if (rec.settled && !rec.waiterRegistered) {
      this.tokens.delete(Number(token));
      this.settled.delete(Number(token));
    }
  }

  settle(token, okj, ej) {
    const rec = this.tokens.get(token);
    if (!rec) return;
    // 已 detach 的 token 不会有人再 await：直接出账（高频 look/rot 的审计口径）
    if (rec.detached && !rec.waiterRegistered) {
      this.tokens.delete(token);
      this.settled.delete(token);
      return;
    }
    rec.settled = true;
    this.settled.set(token, [okj ?? '', ej ?? '']);
    if (rec.waiterRegistered) this.deliverToken(token);
  }

  /** 交付 Result（ABI 的唯一成功/失败通道；失败不是 Lua 异常） */
  settleResult(token, result) {
    this.settle(token, JSON.stringify(result ?? okResult(null)), '');
  }

  settleOk(token, value) { this.settleResult(token, okResult(value)); }

  settleErr(token, code, message) { this.settleResult(token, errResult(code, message)); }

  /** 取消是独立通道（不进 Result、不进 on_error）：核心看到后展开当前任务并跑 on_cancel */
  settleCancel(token, source) {
    this.settle(token, '', JSON.stringify({ cancel: String(source ?? 'external') }));
  }

  deliverToken(token) {
    const rec = this.tokens.get(token);
    if (!rec) return;
    const [okj, ej] = this.settled.get(token) ?? ['', ''];
    this.tokens.delete(token);
    this.settled.delete(token);
    if (rec.detached) return;        // fire-and-forget
    if (rec.taskId == null) return;  // 无归属（清理钩里的动作）
    this.deliver(rec.taskId, okj, ej);
  }

  /** 交付（含 pause 冻结与 Lua 帧内排队） */
  deliver(taskId, okj, ej) {
    if (this.paused) {
      this.frozen.push([taskId, okj, ej]);
      return;
    }
    if (this.depth > 0) {
      this.pendingResume.push([taskId, okj, ej]);
      return;
    }
    this.rawResume(taskId, okj, ej);
  }

  rawResume(taskId, okj, ej) {
    this.depth++;
    try {
      this._resume(taskId, okj ?? '', ej ?? '');
    } catch (e) {
      this._log('error', `resume 失败 task=${taskId}: ${e.message}\n${e.stack ?? ''}`);
    } finally {
      this.depth--;
    }
    this.flushPending();
  }

  flushPending() {
    // rawResume 末尾会再次调用本函数；重入时必须直接返回，否则 pending 队列长时会递归爆栈。
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pendingResume.length && this.depth === 0 && !this.paused) {
        const [id, okj, ej] = this.pendingResume.shift();
        this.rawResume(id, okj, ej);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** 暂停：进行中的动作以 Result 失败（runtime.paused），脚本自行决定退避/退出 */
  settleActionsOnPause(reason) {
    for (const [tok, rec] of this.tokens) {
      if (rec.kind === 'action' && rec.taskId != null && !rec.settled) {
        this.settleErr(tok, 'runtime.paused', `pause(${reason}) 期间动作中止`);
      }
    }
  }

  releaseFrozen() {
    const q = this.frozen;
    this.frozen = [];
    for (const [id, okj, ej] of q) this.deliver(id, okj, ej);
  }
}

const nowMs = () => Date.now();

export class TimerBank {
  constructor() {
    this.specs = new Set();
  }

  /** 引擎侧 timer 统一经此登记：pause 冻结（保留剩余时相）、resume 重建、stop 清理 */
  arm(fn, delay, { repeat = false } = {}) {
    const d = Math.max(0, Number(delay) || 0);
    const spec = { fn, delay: d, repeat, handle: null, startedAt: nowMs(), remain: d };
    this.specs.add(spec);
    this.start(spec);
    return spec;
  }

  start(spec) {
    spec.startedAt = nowMs();
    if (spec.repeat) {
      spec.handle = setInterval(spec.fn, spec.delay);
    } else {
      // 一次性 spec 到点即从台账移除：已触发的 after/sleep 不得被 freeze/unfreeze 重放
      spec.handle = setTimeout(() => {
        spec.handle = null;
        this.specs.delete(spec);
        spec.fn();
      }, spec.remain);
    }
  }

  clear(spec) {
    if (spec.repeat) clearInterval(spec.handle);
    else clearTimeout(spec.handle);
    spec.handle = null;
    this.specs.delete(spec);
  }

  freeze() {
    const now = nowMs();
    for (const spec of this.specs) {
      if (spec.repeat) clearInterval(spec.handle);
      else clearTimeout(spec.handle);
      spec.handle = null;
      spec.remain = spec.repeat ? spec.delay : Math.max(0, spec.delay - (now - spec.startedAt));
    }
  }

  unfreeze() {
    for (const spec of this.specs) {
      if (spec.handle) continue;
      this.start(spec);
    }
  }

  clearAll() {
    for (const spec of this.specs) this.clear(spec);
    this.specs.clear();
  }
}
