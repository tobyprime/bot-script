// tickEnd.js — 发送 client_tick_end（26.x 服务端的 tick 结束标记）
//
// 根因（2026-11-16 红绿测确认）：
//   26.3 的 ServerGamePacketListenerImpl：
//     if (packet.hasPosition() && this.receivedPositionThisTick)
//         → disconnect("multiplayer.disconnect.invalid_player_movement");
//     this.receivedPositionThisTick = true;
//   receivedPositionThisTick 的唯一重置点在 handleClientTickEnd：
//     public void handleClientTickEnd(ServerboundClientTickEndPacket packet) {
//         receivedMovementThisTick = false;
//         receivedPositionThisTick = false;      // ← 由客户端发包重置，不是每 tick 自动清零
//     }
//
//   `client_tick_end` 是 26.x 新增的空载荷包（minecraft-data 里名 tick_end，ID 0x0c）。
//   原版客户端每 tick 结束时发它；**mineflayer 从不发**（整个库 0 处引用）
//   → 计数永不清零 → 第二个带坐标包立刻被判非法 → 每 1.2 秒被踢。
//
// 红绿测（本地 Paper 26.3 + Via，mineflayer 客户端）：
//   不发 tick_end：❌ invalid_player_movement 1.2s
//   每 tick 发 tick_end：✅ 存活 19.2s
//   纯净 1.21.8（不需要此包）发与不发均存活 → 无回归
//
// 因此：无条件每 50ms 发一次 tick_end。这是**补上原版客户端固有的行为**，
// 服务端本就会忽略多余/无意义的 tick_end（空载荷、无副作用）。
const TICK_MS = 50;

// 返回 { stop, stats }；stop 用于停机时清理
// ⚠️ 必须等 bot 进入 play 状态（spawn）之后才开始发：登录/配置阶段发 play 状态的包是非法的，
//    实测在 spawn 前开始发会让服务端直接断开，实例根本起不来（spawned=false）。
export function installTickEndSender(bot, opts = {}) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return { stop: () => {}, stats: () => ({ sent: 0 }) };

  let sent = 0;
  let timer = null;
  const tickMs = opts.tickMs ?? TICK_MS;

  const start = () => {
    if (timer) return;
    timer = setInterval(() => {
      try {
        client.write('tick_end', {});
        sent += 1;
      } catch { /* 连接已断或版本不支持：静默 */ }
    }, tickMs);
    timer.unref?.();   // 不阻止进程退出
  };

  // 只有在 play 状态才发（spawn 事件即进入 play）。
  // bot 必须是真 mineflayer bot（有 once）；测试用的最小替身直接当作已在 play。
  if (bot.entity) start();
  else if (typeof bot.once === 'function') bot.once('spawn', start);
  else start();

  return {
    stop: () => { if (timer) { clearInterval(timer); timer = null; } },
    stats: () => ({ sent }),
  };
}
