// protocolPatch.js — teleport_confirm 补丁（服务端要六字段，minecraft-data 只给一字段）
//
// 反编译 26.3 服务端确认的事实：
//   ServerboundAcceptTeleportationPacket = (int id, double x, y, z, float yRot, xRot)
//   线格式 VAR_INT, DOUBLE, DOUBLE, DOUBLE, FLOAT, FLOAT（STREAM_CODEC 字节码为证）
// 而 minecraft-data（含最新 3.119）对 1.21.8 / 26.1 / 26.1.2 都只定义 { teleportId }。
//
// 服务端 handleAcceptTeleportPacket：
//   if (packet.id() == awaitingTeleport) {
//     if (awaitingPositionFromClient == null ||
//         containsInvalidValues(x, y, z, yRot, xRot))
//         → disconnect("multiplayer.disconnect.invalid_player_movement")
//   }
// containsInvalidValues 只判 NaN/Infinity —— 所以 x/y/z 必须有值且有限。
//
// 两个可选策略（由环境变量 BOTSCRIPT_TELEPORT_CONFIRM 选择）：
//   'full'（默认）：发六字段。适配 26.3/26.2/26.1 后端（含 via/geyser 翻译前的真实版本）。
//   'id'        ：只发 id（原版 1.21.8 行为）。用于后端确实只要 id 的环境。
//
// 注意：26.1 服务端实测只接受 1 个 varint（多 32 字节会报 "larger than I expected" 断开），
// 而 26.3 服务端要六字段。同一份代码无法同时满足——必须按目标服务器选。
export const TELEPORT_CONFIRM_FULL = ['container', [
  { name: 'teleportId', type: 'varint' },
  { name: 'x', type: 'f64' },
  { name: 'y', type: 'f64' },
  { name: 'z', type: 'f64' },
  { name: 'yRot', type: 'f32' },
  { name: 'xRot', type: 'f32' },
]];

// 默认发六字段：目标服是 26.3 后端（对外经代理报 775），只有六字段能让后端确认通过。
export function confirmMode(env = process.env) {
  const v = String(env.BOTSCRIPT_TELEPORT_CONFIRM ?? '').toLowerCase();
  return v === 'id' ? 'id' : 'full';
}

// customPackets：把 teleport_confirm 定义换成六字段。
// serializer 内部按 customPackets[majorVersion] 索引，故保持分组外层。
export function buildCustomPackets(majorVersion, mode = confirmMode()) {
  if (mode !== 'full') return undefined;
  if (!majorVersion) return undefined;
  return {
    [majorVersion]: {
      play: { toServer: { types: { packet_teleport_confirm: TELEPORT_CONFIRM_FULL } } },
    },
  };
}

// mineflayer 的 physics.js 写确认时只传 { teleportId }。挂钩补上 x/y/z/yRot/xRot：
// 位置取服务端刚下发的 position 目标点（那就是服务端期望客户端确认的位置），
// 朝向取该包里的角度，缺失时退回客户端当前朝向。
export function installTeleportConfirmPatch(bot, mode = confirmMode()) {
  if (mode !== 'full') return () => {};
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return () => {};

  let target = null;
  const onPosition = (p) => {
    const toDeg = (deg, rad) => (Number.isFinite(deg) ? deg : (Number.isFinite(rad) ? (rad * 180) / Math.PI : 0));
    target = {
      x: p.x, y: p.y, z: p.z,
      yRot: toDeg(p.yaw, p.yRot),
      xRot: toDeg(p.pitch, p.xRot),
    };
  };
  client.on('position', onPosition);

  const origWrite = client.write.bind(client);
  const patched = (name, params) => {
    if (name === 'teleport_confirm') {
      const p = params ?? {};
      const full = p.x !== undefined && p.y !== undefined && p.z !== undefined;
      if (!full) {
        if (target) {
          return origWrite(name, {
            teleportId: p.teleportId,
            x: target.x, y: target.y, z: target.z,
            yRot: target.yRot, xRot: target.xRot,
          });
        }
        // 还没有目标点：不发（服务端会重发 position，补上再确认）
        return;
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
