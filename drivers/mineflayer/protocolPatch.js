// protocolPatch.js — teleport 确认 + 位置包节流 + **yaw 越界纠正**
//
// ── yaw 越界（invalid_player_movement 的真根因）──
// mineflayer 的 physics.js 里 lastSentYaw 是**无界累加**：
//     lastSentYaw += clamp(-maxDeltaYaw, dYaw, maxDeltaYaw)
// 而 bot.entity.yaw 归一在 [0, 2π)。lastSentYaw 一旦漂出该区间（例如 3π），
// toNotchianYaw(3π) = (π - 3π)·180/π = -360°，服务端收到的 yaw 就远超 ±180 → 判非法。
// 线上实测：yaw 一路涨到 5109°、30759°，随即 multiplayer.disconnect.invalid_player_movement 踢人。
//
// 修法：在驱动发包前把 yaw/pitch 归一到合法区间（±180 / ±90）。
// 视角目标本身不变（角度等价），只是避免把越界值发出去。
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
  return { [majorVersion]: { play: { toServer: { types: { packet_teleport_confirm: TELEPORT_CONFIRM_FULL } } } } };
}

// 角度归一到 [-limit, limit]（周期 360）
export function wrapAngle(deg, limit = 180) {
  if (!Number.isFinite(deg)) return 0;
  const period = limit * 2;
  let v = ((deg % period) + period) % period;
  if (v > limit) v -= period;
  return v;
}

// 包一层 _client.write：
//   ① 所有带 yaw/pitch 的包，角度先归一到 ±180 / ±90（修 lastSentYaw 无界漂移）
//   ② 同一 50ms 窗口只放行一个带位置的包（26.3 的 receivedPositionThisTick 判定）
//   ③ teleport_confirm 补六字段（26.3 要坐标）
export function installProtocolGuards(bot, opts = {}) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return () => {};
  const tickMs = opts.tickMs ?? 50;
  const mode = opts.mode ?? confirmMode();

  let windowStart = 0;
  let positionSentThisWindow = false;
  let target = null;

  const onPosition = (p) => {
    const toDeg = (deg, rad) => (Number.isFinite(deg) ? deg : (Number.isFinite(rad) ? (rad * 180) / Math.PI : 0));
    target = { x: p.x, y: p.y, z: p.z, yRot: toDeg(p.yaw, p.yRot), xRot: toDeg(p.pitch, p.xRot) };
  };
  client.on('position', onPosition);

  const origWrite = client.write.bind(client);
  const patched = (name, params) => {
    const now = Date.now();
    if (now - windowStart >= tickMs) { windowStart = now; positionSentThisWindow = false; }

    // ① 角度归一（yaw/pitch 在协议里是度数 f32）
    let p = params;
    if (p && typeof p === 'object' && (p.yaw !== undefined || p.pitch !== undefined)) {
      p = { ...p };
      if (p.yaw !== undefined) p.yaw = wrapAngle(p.yaw, 180);
      if (p.pitch !== undefined) p.pitch = wrapAngle(p.pitch, 90);
    }

    const positional = name === 'position' || name === 'position_look' || name === 'teleport_confirm';

    // ③ 确认包补坐标（在节流判定之前，确认包不参与节流）
    if (name === 'teleport_confirm') {
      const q = p ?? {};
      if (mode === 'full' && q.x === undefined && target) {
        positionSentThisWindow = true;
        return origWrite(name, {
          teleportId: q.teleportId, x: target.x, y: target.y, z: target.z,
          yRot: wrapAngle(target.yRot, 180), xRot: wrapAngle(target.xRot, 90),
        });
      }
      if (mode === 'full') {
        p = { ...q, yRot: wrapAngle(q.yRot ?? target?.yRot ?? 0, 180), xRot: wrapAngle(q.xRot ?? target?.xRot ?? 0, 90) };
      }
      positionSentThisWindow = true;
      return origWrite(name, p);
    }

    // ② 同窗口第二个位置包：回执降级为纯朝向，纯位置包丢弃
    if (positional && positionSentThisWindow) {
      if (name === 'position_look' && p) {
        return origWrite('look', { yaw: p.yaw, pitch: p.pitch, flags: p.flags });
      }
      if (name === 'position') return undefined;
    }
    if (positional) positionSentThisWindow = true;
    return origWrite(name, p);
  };
  client.write = patched;

  return () => {
    client.write = origWrite;
    try { client.removeListener('position', onPosition); } catch { /* ignore */ }
  };
}

// 兼容旧导出名
export const installSinglePositionPatch = (bot, opts) => installProtocolGuards(bot, opts);
export const installTeleportConfirmPatch = () => () => {};
