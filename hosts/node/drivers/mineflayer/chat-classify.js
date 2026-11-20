// chat-classify.js — 聊天事件分类（只按协议事实，不从文本猜）
//
// senderName 由驱动从 playerChat 包的 sender UUID 解析而来；解析不到就是 null。
// 没有 senderName 一律 system：不支持 [频道]、[名字]、"X whispers to you:" 之类文本猜测
// ——那样会把插件服的频道前缀误判成玩家，见 2026-11 的 afk_bot 回归。
export function classifyChat(raw, senderName = null) {
  const name = senderName || null;
  return {
    // 玩家聊天剥掉原版 <名字> 前缀作为正文；system 消息原样。
    text: name ? raw.replace(/^<[^>]+>\s*/, '') : raw,
    raw,
    sender: name,
    sender_kind: name ? 'player' : 'system',
  };
}
