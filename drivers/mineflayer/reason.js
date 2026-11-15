// drivers/mineflayer/reason.js — 断线原因成文
// mineflayer 的 kicked / end 事件载荷有三种形态：字符串、chat 组件对象、JSON 文本
// （协议包经 chat 组件序列化后常是后者）。运维需要一行可读文本，而不是裸 JSON，
// 也不该因为格式化失败把原因吞成空串。
export function reasonText(reason) {
  if (reason == null || reason === '') return '';
  const flat = (c) => {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(flat).join('');
    if (typeof c !== 'object') return String(c);
    const own = c.text ?? '';
    const tr = c.translate ? `{${c.translate}}` : '';
    const extra = Array.isArray(c.extra) ? c.extra.map(flat).join('') : '';
    return own + tr + extra;
  };
  if (typeof reason === 'string') {
    const trimmed = reason.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const text = flat(JSON.parse(trimmed)).trim();
        if (text) return text;
      } catch { /* 不是合法 JSON：按原文返回 */ }
    }
    return trimmed;
  }
  const text = flat(reason).trim();
  if (text) return text;
  try { return String(reason); } catch { return ''; }
}
