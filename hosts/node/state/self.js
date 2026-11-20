// hosts/node/state/self.js — 自身状态（驱动实时查询优先，事件推送为回落）
export class SelfState {
  constructor({ driver, now = Date.now } = {}) {
    this.driver = driver;
    this.now = now;
    this.last = null;   // 最近一次驱动推向（fence 判定与降级用）
  }

  update(p) {
    this.last = { ...p, ts: this.now() };
    return this.last;
  }

  snapshot() {
    return this.driver?.query_self?.() ?? this.last;
  }

  pos() {
    return this.snapshot()?.pos ?? null;
  }
}
