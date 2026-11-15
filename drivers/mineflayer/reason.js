// drivers/mineflayer/reason.js — 断线原因成文
//
// mineflayer 的 kicked / end 事件载荷有四种形态：
//   1) 纯字符串（end 事件常见）
//   2) chat 组件对象 { text, extra, translate }
//   3) JSON 文本（协议包经 chat 组件序列化后）
//   4) **NBT 数据**（kick_disconnect 包的 reason 是 anonymousNbt —— prismarine-nbt 解析后的
//      { type:'compound', name, value: { text: {type:'string', value:'...'} } }）
//
// 运维需要一行可读文本。第 4 种是最容易被漏掉的：不处理就会输出 `[object Object]`，
// 而这恰恰是「服务器明确告诉你为什么踢你」的那条信息。
import nbt from 'prismarine-nbt';

// 把 chat 组件 / NBT 简化结果统一压成一行文本
function flatten(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  if (Array.isArray(c)) return c.map(flatten).join('');
  if (typeof c !== 'object') return '';
  // NBT 原始形态：{ type, name, value } —— 取 value 继续展开
  if (typeof c.type === 'string' && 'value' in c) return flatten(c.value);
  const own = c.text ?? '';
  const tr = c.translate ? `{${c.translate}}` : '';
  const extra = Array.isArray(c.extra) ? c.extra.map(flatten).join('') : '';
  return own + tr + extra;
}

// 判断像不像 NBT（anonymousNbt 解析后的形态）
function looksLikeNbt(x) {
  if (!x || typeof x !== 'object') return false;
  if (Array.isArray(x)) return false;
  if (typeof x.type === 'string' && 'value' in x) return true;
  const vals = Object.values(x);
  return vals.length > 0 && vals.every((v) => v && typeof v === 'object' && typeof v.type === 'string' && 'value' in v);
}

export function reasonText(reason) {
  if (reason == null || reason === '') return '';

  // 1) 字符串：可能是 JSON 文本
  if (typeof reason === 'string') {
    const trimmed = reason.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const text = flatten(JSON.parse(trimmed)).trim();
        if (text) return text;
      } catch { /* 不是合法 JSON：按原文返回 */ }
    }
    return trimmed;
  }

  // 2/4) 对象：NBT 先经 prismarine-nbt 简化，再按 chat 组件展开
  if (typeof reason === 'object') {
    let obj = reason;
    if (looksLikeNbt(obj)) {
      try { obj = nbt.simplify(obj); } catch { /* 简化失败：退回原对象 */ }
    }
    const text = flatten(obj).trim();
    if (text) return text;
    // 兜底：至少给出键名，避免 [object Object] 这种零信息输出
    try {
      const keys = Object.keys(reason);
      if (keys.length) return `(无法解析的断线原因，字段: ${keys.join(',')})`;
      return String(reason);
    } catch { return ''; }
  }

  return String(reason);
}
