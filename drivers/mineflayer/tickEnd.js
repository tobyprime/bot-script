// tickEnd.js — tick 节拍守卫：补发 client_tick_end + 同 tick 只发一个位置包
//
// ── 两个必要条件（均经本地红绿测确认，缺任一都会被踢）──
//
// ① 每 tick 发 client_tick_end
//   26.3 服务端 ServerGamePacketListenerImpl：
//     handleMovePlayer: if (hasPosition() && receivedPositionThisTick) → disconnect(invalid_player_movement)
//     receivedPositionThisTick = true;                       // 收到位置包即置真
//     handleClientTickEnd: receivedPositionThisTick = false;   // 唯一重置点：由客户端发包重置
//   `client_tick_end` 是 26.x 新增的空载荷包（minecraft-data 名 tick_end，ID 0x0c）。
//   原版客户端每 tick 结束时发；mineflayer 从不发 → 计数永不清零 → 第二个位置包即被踢。
//
// ② 同一 tick 只发一个位置包
//   mineflayer 的 physics.js 有 catch-up 循环：事件循环一卡就连跑多个 tick，
//   实测线上出现过 4 个 position 包在 6ms 内连发（y 递减，正在下落）。
//   这些包落在同一服务器 tick 内 → 第 2 个起全部非法，tick_end 也救不回来。
//
// ── 红绿测证据（本地 Paper 26.3 + ViaVersion）──
//   无 tick_end                     → invalid_player_movement 1.2s
//   有 tick_end、同 tick 突发 4 包  → invalid_player_movement 0.1s
//   有 tick_end、同 tick 单包       → 存活 15.3s
//   纯净 1.21.8（两者都不需要）     → 存活，无回归
//
// ⚠️ 两条踩过的坑：
//   · tick_end 必须在 spawn 之后才开始发（play 状态的包不能在登录/配置阶段发，
//     否则服务端直接断开，实例根本起不来）。
//   · 位置包只能**延后**不能丢弃（physics 在调用 write 前已更新内部 lastSent，
//     丢弃会让它以为已发送而永不重发 → 服务端收不到位置 → 断连）。
const TICK_MS = 50;
const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying']);

export function installTickEndSender(bot, opts = {}) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') {
    return { stop: () => {}, stats: () => ({ sent: 0, deferred: 0 }) };
  }

  const tickMs = opts.tickMs ?? TICK_MS;
  let sent = 0;
  let deferred = 0;
  let timer = null;

  // ---- ② 同 tick 只放行一个移动包：其余延后到下一 tick（不丢弃）----
  let lastMoveAt = 0;
  const queue = [];          // 等待补发的移动包（同类只留最新）
  let flushTimer = null;
  const origWrite = client.write.bind(client);

  const flush = () => {
    flushTimer = null;
    const wait = tickMs - (Date.now() - lastMoveAt);
    if (wait > 0) { flushTimer = setTimeout(flush, wait); return; }
    const next = queue.shift();
    if (!next) return;
    lastMoveAt = Date.now();
    origWrite(next.name, next.params);
    if (queue.length && !flushTimer) flushTimer = setTimeout(flush, tickMs);
  };
  const enqueue = (name, params) => {
    const i = queue.findIndex((q) => q.name === name);
    if (i >= 0) queue[i] = { name, params };   // 同类取最新（坐标/朝向都是越新越好）
    else queue.push({ name, params });
    deferred += 1;
    if (!flushTimer) flushTimer = setTimeout(flush, tickMs);
  };

  client.write = (name, params) => {
    if (!MOVE_PACKETS.has(name)) return origWrite(name, params);
    if (Date.now() - lastMoveAt >= tickMs) {
      lastMoveAt = Date.now();
      return origWrite(name, params);
    }
    enqueue(name, params);
    return undefined;
  };

  // ---- ① 每 tick 发 client_tick_end（进入 play 之后才开始）----
  const start = () => {
    if (timer) return;
    // tick_end 紧跟在移动包之后发，确保服务端先看到本 tick 的位置包再看到结束标记
    timer = setInterval(() => {
      try {
        client.write('tick_end', {});
        sent += 1;
      } catch { /* 连接已断或版本不支持：静默 */ }
    }, tickMs);
    timer.unref?.();
  };

  if (bot.entity) start();
  else if (typeof bot.once === 'function') bot.once('spawn', start);
  else start();

  return {
    stop: () => {
      if (timer) { clearInterval(timer); timer = null; }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      client.write = origWrite;          // 还原写入路径
      for (const q of queue) { try { origWrite(q.name, q.params); } catch { /* ignore */ } }
      queue.length = 0;
    },
    stats: () => ({ sent, deferred }),
  };
}
