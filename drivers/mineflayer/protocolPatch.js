// protocolPatch.js — teleport 确认包与「重复位置包」修补
//
// 26.3 服务端（反编译证实）：
//   handleMovePlayer：  if (packet.hasPosition() && receivedPositionThisTick)
//                          → disconnect("multiplayer.disconnect.invalid_player_movement")
//                       receivedPositionThisTick = true   // 每 tick 由 serverTick 重置
//   handleAcceptTeleportPacket： 确认包本身也带 x/y/z/yRot/xRot（26.3 起）
//
// 于是 mineflayer 的老行为会撞车 —— 收到服务端 position 后它**连发两个带位置的包**：
//   physics.js:446  sendPacketPositionAndLook  （位置回执）
//   physics.js:422  teleport_confirm           （确认包）
// 在 1.21.x 上这没问题（确认包只带 id，服务端不把它算作「位置包」）；
// 在 26.3 上确认包已含坐标，两者落在同一个 tick → 第二个被判非法 → 被踢。
//
// 修法：收到 position 后只保留一个「带位置」的回报，并推迟到下一个 tick 再发，
// 避免与确认包挤在同一 tick。同时把确认包补齐六字段（26.3 需要）。
export const TELEPORT_CONFIRM_FULL = ['container', [
  { name: 'teleportId', type: 'varint' },
  { name: 'x', type: 'f64' },
  { name: 'y', type: 'f64' },
  { name: 'z', type: 'f64' },
  { name: 'yRot', type: 'f32' },
  { name: 'xRot', type: 'f32' },
]];

export function confirmMode(env = process.env) {
  const v = String(env.BOTSCRIPT_TELEPORT_CONFIRM ?? '').toLowerCase();
  return v === 'id' ? 'id' : 'full';
}

export function buildCustomPackets(majorVersion, mode = confirmMode()) {
  if (mode !== 'full' || !majorVersion) return undefined;
  return {
    [majorVersion]: {
      play: { toServer: { types: { packet_teleport_confirm: TELEPORT_CONFIRM_FULL } } },
    },
  };
}

// 核心：给 bot 打「同一 tick 只发一个带位置包」的补丁。
//
// 冲突根源：收到服务端 position 后 mineflayer 会连发两个带位置的包——
//   physics.js:446  position_look  （位置回执）
//   physics.js:422  teleport_confirm（确认包；26.3 起含坐标）
// 两个落在同一 tick → 服务端 receivedPositionThisTick 判定触发 → 踢。
//
// 解法：确认包保留坐标（服务端要求用它把玩家传到位），随后那个位置回执降级为只发朝向。
// 朝向更新不丢，位置不再重复。
export function installSinglePositionPatch(bot, opts = {}) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return () => {};
  const tickMs = opts.tickMs ?? 50;

  let windowStart = 0;
  let positionSentThisWindow = false;

  const markWindow = (now) => {
    if (now - windowStart >= tickMs) { windowStart = now; positionSentThisWindow = false; }
  };

  const origWrite = client.write.bind(client);
  const patched = (name, params) => {
    markWindow(Date.now());
    const positional = name === 'position' || name === 'position_look' || name === 'teleport_confirm';
    if (positional && positionSentThisWindow) {
      // 本窗口已有带位置包：位置回执降级成纯朝向包；纯位置包直接丢弃（下窗口补发）
      if (name === 'position_look' && params) {
        return origWrite('look', { yaw: params.yaw, pitch: params.pitch, flags: params.flags });
      }
      if (name === 'position') return undefined;
    }
    if (positional) positionSentThisWindow = true;
    return origWrite(name, params);
  };
  client.write = patched;

  return () => { client.write = origWrite; };
}

// teleport_confirm 补六字段：位置取服务端刚下发的目标点（= 服务端期望客户端确认的位置）
export function installTeleportConfirmPatch(bot, mode = confirmMode()) {
  if (mode !== 'full') return () => {};
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return () => {};

  let target = null;
  const onPosition = (p) => {
    const toDeg = (deg, rad) => (Number.isFinite(deg) ? deg : (Number.isFinite(rad) ? (rad * 180) / Math.PI : 0));
    target = { x: p.x, y: p.y, z: p.z, yRot: toDeg(p.yaw, p.yRot), xRot: toDeg(p.pitch, p.xRot) };
  };
  client.on('position', onPosition);

  const origWrite = client.write.bind(client);
  const patched = (name, params) => {
    if (name === 'teleport_confirm') {
      const p = params ?? {};
      if (p.x === undefined && target) {
        return origWrite(name, {
          teleportId: p.teleportId,
          x: target.x, y: target.y, z: target.z, yRot: target.yRot, xRot: target.xRot,
        });
      }
    }
    return origWrite(name, params);
  };
  client.write = patched;

  return () => {
    client.write = origWrite;
    try { client.removeListener('position', onPosition); } catch { /* ignore */ }
  };
}
