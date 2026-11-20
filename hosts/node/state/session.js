// hosts/node/state/session.js — 会话状态（host 归一化模型，revision 递增供上层观察）
export class SessionState {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.state = 'connecting';
    this.info = {};
    this.revision = 0;
  }

  apply({ state, info }) {
    this.state = state ?? this.state;
    if (info) this.info = info;
    this.revision++;
    return this;
  }

  get playing() { return this.state === 'playing'; }

  clearCacheSignals() {
    // 会话已终：旧会话数据面（windows/world）由 engine 清空；这里只记录语义
    this.revision++;
  }
}
