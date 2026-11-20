// hosts/node/state/windows.js — 窗口归一化（唯一实现 size+27 / 45 / 玩家区映射）
//
// 宿主事件进（驱动推送的原始快照）→ 契约 Window 出（slot 布局已归一化）。
// 核心与宿主业务代码里不得再出现槽位常量（contract-lint 会扫）。

export class WindowState {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.windows = new Map();   // id -> {id,type,title,size,slots:Map,cursor,revision,ts}
    this.currentWindowId = null;
  }

  /** 输入：驱动已归一化为引擎空间的原始快照 {id,type,title,size,slots:[{index,item}],cursor} */
  apply(p) {
    const id = String(p.id);
    const slots = new Map();
    for (const s of p.slots ?? []) {
      if (!s.item) continue;
      slots.set(Number(s.index), s.item);
    }
    const prev = this.windows.get(id);
    const w = {
      id,
      type: p.type ?? 'custom',
      title: p.title ?? '',
      size: p.size ?? 0,
      state_id: p.state_id ?? null,
      slots,
      cursor: p.cursor ?? null,
      revision: (prev?.revision ?? 0) + 1,
      ts: this.now(),
    };
    this.windows.set(id, w);
    if (w.type !== 'inventory' && this.currentWindowId == null && id !== '0') this.currentWindowId = id;
    return w;
  }

  close(id) {
    const sid = String(id);
    const existed = this.windows.delete(sid);
    if (this.currentWindowId === sid) {
      this.currentWindowId = null;
      return { closedCurrent: true, existed };
    }
    return { closedCurrent: false, existed };
  }

  clear() {
    this.windows.clear();
    this.currentWindowId = null;
  }

  current() { return this.currentWindowId; }

  revision(id) {
    return this.windows.get(String(id))?.revision ?? 0;
  }

  /** 契约 Window：{id,type,title,size,slots:[{index,item|null} 0..size+35],cursor,revision} */
  view(id) {
    const sid = String(id);
    if (sid === '0') {
      const cont = this.currentWindowId != null ? this.windows.get(this.currentWindowId) : null;
      if (cont) return this._inventoryView(cont);
      const w = this.windows.get('0');
      return w ? this._denseView(w) : null;
    }
    const w = this.windows.get(sid);
    return w ? this._denseView(w) : null;
  }

  _denseView(w) {
    const slots = [];
    for (let i = 0; i < (w.size || 0) + 36; i++) slots.push({ index: i, item: w.slots.get(i) ?? null });
    return { id: w.id, type: w.type, title: w.title, size: w.size, state_id: w.state_id, slots, cursor: w.cursor, revision: w.revision };
  }

  /** 容器打开时的「背包」合并视图：容器窗口的玩家区（27 主背包 + 9 快捷栏）→ 36 格 */
  _inventoryView(cont) {
    const slots = [];
    for (let i = 0; i < 36; i++) slots.push({ index: i, item: null });
    for (const [idx, item] of cont.slots) {
      const inv = this.playerZoneToInventory(cont.size, idx);
      if (inv != null) slots[inv] = { index: inv, item };
    }
    return {
      id: '0', type: 'inventory', title: '背包', size: 36, state_id: cont.state_id,
      slots, cursor: cont.cursor, revision: cont.revision,
    };
  }

  /** 容器窗口槽 → 背包槽（0-8 快捷栏 / 9-35 主背包）；不在玩家区返回 null */
  playerZoneToInventory(size, idx) {
    if (idx >= size && idx < size + 27) return idx - size + 9;      // 主背包
    if (idx >= size + 27 && idx < size + 36) return idx - size - 27; // 快捷栏
    return null;
  }

  /** 背包槽 → 容器窗口玩家区槽（反向映射） */
  inventoryToPlayerZone(size, invSlot) {
    return invSlot >= 9 ? size + (invSlot - 9) : size + 27 + invSlot;
  }

  /** act.window_click 的槽位归一：window='0' 但容器打开时，落到容器窗口的玩家区 */
  clickTarget(windowId, slot) {
    const wid = String(windowId ?? '0');
    if (wid !== '0' || this.currentWindowId == null) return { window: wid, slot: Number(slot) };
    const cont = this.windows.get(this.currentWindowId);
    if (!cont) return { window: wid, slot: Number(slot) };
    return { window: cont.id, slot: this.inventoryToPlayerZone(cont.size, Number(slot)) };
  }
}
