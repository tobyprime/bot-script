// hosts/node/tokens.js — token 结算 + 重入门控 + 定时器台账（唯一实现）
//
// 规则（ARCHITECTURE-REFACTOR §3.3）：
//   * 宿主不得在核心→宿主调用帧内反向调核心：Lua 帧深度 > 0 时交付排队，帧尾统一 flush。
//   * pause 期间交付冻结，resume 后于冻结点重抛（含 runtime.paused 的动作错误）。
//   * 一次性 timer 到点即出账：freeze/unfreeze 不得重放已触发的 after/sleep。

export const TYPE_ERR = (kind, detail) => ({ kind, detail: detail === undefined ? null : detail });
export const errJson = (kind, detail) => JSON.stringify(TYPE_ERR(kind, detail));

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
    if (rec) rec.detached = true;
  }

  settle(token, okj, ej) {
    const rec = this.tokens.get(token);
    if (!rec) return;
    rec.settled = true;
    this.settled.set(token, [okj ?? '', ej ?? '']);
    if (rec.waiterRegistered) this.deliverToken(token);
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
    while (this.pendingResume.length && this.depth === 0 && !this.paused) {
      const [id, okj, ej] = this.pendingResume.shift();
      this.rawResume(id, okj, ej);
    }
  }

  /** 暂停：进行中的动作以 runtime.paused 结算（脚本在冻结点重抛） */
  settleActionsOnPause(reason) {
    for (const [tok, rec] of this.tokens) {
      if (rec.kind === 'action' && rec.taskId != null && !rec.settled) {
        this.settle(tok, '', errJson('runtime.paused', `pause(${reason}) 期间动作中止`));
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
