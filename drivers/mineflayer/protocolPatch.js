// protocolPatch.js — 移动包节拍守卫（只做一件事：同 tick 只发一个移动包）
//
// 依据（26.3 反编译 ServerGamePacketListenerImpl.handleMovePlayer）：
//   if (packet.hasPosition() && this.receivedPositionThisTick)
//       → disconnect("multiplayer.disconnect.invalid_player_movement")
//   this.receivedPositionThisTick = true;      // 每服务器 tick(50ms) 重置
//   // 另有：位置包与 flying/朝向包应分散在不同 tick
//
// mineflayer 的实际行为（线上 trace 实测）：
//   → position @9190ms
//   → flying   @9200ms     ← 同一 tick 内第二个移动包
//   → position @12389ms
// 原版客户端每 tick 只发一个移动包。
//
// 设计约束（两条踩过的坑，务必保留）：
//   1) 不能丢弃位置包：physics 在调用 write 前已更新内部 lastSent，丢弃会导致它永不重发
//      → 服务端收不到位置 → 断连。只能**延迟**。
//   2) 确认包必须按客户端声明的版本发（1.21.x/26.1 都是单字段 teleportId）。
//      多发坐标会让代理层按低版本解析后剩垃圾字节 → 协议错误断连。
const TICK_GAP_MS = 55;   // 略大于一个服务器 tick

export function confirmMode(env = process.env) {
  return String(env.BOTSCRIPT_TELEPORT_CONFIRM ?? '').toLowerCase() === 'full' ? 'full' : 'id';
}

export const TELEPORT_CONFIRM_FULL = ['container', [
  { name: 'teleportId', type: 'varint' },
  { name: 'x', type: 'f64' },
  { name: 'y', type: 'f64' },
  { name: 'z', type: 'f64' },
  { name: 'yRot', type: 'f32' },
  { name: 'xRot', type: 'f32' },
]];

export function buildCustomPackets(majorVersion, mode = confirmMode()) {
  if (mode !== 'full' || !majorVersion) return undefined;
  return { [majorVersion]: { play: { toServer: { types: { packet_teleport_confirm: TELEPORT_CONFIRM_FULL } } } } };
}

// 所有「玩家移动类」包：同一服务器 tick 内只放行一个，其余延后到下一 tick。
const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying', 'teleport_confirm']);

export function installProtocolGuards(bot, opts = {}) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return () => {};
  const gap = opts.tickMs ?? TICK_GAP_MS;

  let lastAt = 0;
  const queue = [];          // 等待补发的移动包（保留每类最新一份）
  let timer = null;

  const orig = client.write.bind(client);

  const flush = () => {
    timer = null;
    const wait = gap - (Date.now() - lastAt);
    if (wait > 0) { timer = setTimeout(flush, wait); return; }
    const next = queue.shift();
    if (!next) return;
    lastAt = Date.now();
    orig(next.name, next.params);
    if (queue.length && !timer) timer = setTimeout(flush, gap);
  };

  const enqueue = (name, params) => {
    // 同类只保留最新（位置包取最新坐标；朝向包取最新角度）
    const i = queue.findIndex((q) => q.name === name);
    if (i >= 0) queue[i] = { name, params };
    else queue.push({ name, params });
    if (!timer) timer = setTimeout(flush, gap);
  };

  const patched = (name, params) => {
    if (!MOVE_PACKETS.has(name)) return orig(name, params);
    // teleport_confirm 必须尽快发（服务端在等），但它同样占本 tick 名额
    if (Date.now() - lastAt >= gap) {
      lastAt = Date.now();
      return orig(name, params);
    }
    enqueue(name, params);
    return undefined;
  };
  client.write = patched;

  return () => {
    client.write = orig;
    if (timer) { clearTimeout(timer); timer = null; }
    for (const q of queue) { try { orig(q.name, q.params); } catch { /* ignore */ } }
    queue.length = 0;
  };
}

// 兼容旧导出名
export const installSinglePositionPatch = (bot, opts) => installProtocolGuards(bot, opts);
export const installTeleportConfirmPatch = () => () => {};
