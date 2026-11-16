// protocolTrace.js — 协议层诊断（临时排查用，环境变量开启）
//
// 用途：把 mineflayer 发出的移动/确认包与收到服务端 position 包逐条记到实例日志，
// 用于定位 invalid_player_movement 这类「发包内容不对」的问题。
// 默认关闭（BOTSCRIPT_PROTO_TRACE=1 时开启），不产生性能开销。
//
// 记录内容刻意只含包名与关键数值（不含 token 等凭据）。
const TRACE_ENV = 'BOTSCRIPT_PROTO_TRACE';
const FOLLOW_NAMES = ['look', 'position', 'position_look', 'flying', 'teleport_confirm'];

export function traceEnabled(env = process.env) {
  return env[TRACE_ENV] === '1' || env[TRACE_ENV] === 'true';
}

// 给已创建的 bot 挂上诊断钩子；返回卸载函数
export function installProtocolTrace(bot, log = console.log) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return () => {};

  const t0 = Date.now();
  let outCount = 0;
  const lastByKind = {};   // 关键：同种包相邻两次的间隔，用来判「同 tick 多包」

  const origWrite = client.write.bind(client);
  const patched = (name, params) => {
    if (FOLLOW_NAMES.includes(name)) {
      outCount += 1;
      const ms = Date.now() - t0;
      const prev = lastByKind[name];
      lastByKind[name] = ms;
      const gap = prev == null ? '-' : `${ms - prev}ms`;
      log(`[trace→${ms}ms] ${name} ${summarize(name, params)} (间隔 ${gap}, 累计 ${outCount})`);
    }
    return origWrite(name, params);
  };
  client.write = patched;

  // 服务端下发 position（= 要求客户端回报的位置与朝向）
  const onPosition = (p) => {
    log(`[trace←${Date.now() - t0}ms] position id=${p.teleportId} `
      + `pos=(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}) `
      + `yaw=${fmt(p.yaw !== undefined ? p.yaw : rad2deg(p.yRot))} `
      + `pitch=${fmt(p.pitch !== undefined ? p.pitch : rad2deg(p.xRot))} `
      + `flags=${typeof p.flags === 'object' ? JSON.stringify(p.flags) : p.flags}`);
  };
  client.on('position', onPosition);

  return () => {
    client.write = origWrite;
    try { client.removeListener('position', onPosition); } catch { /* ignore */ }
  };
}

function rad2deg(rad) {
  return typeof rad === 'number' ? (rad * 180) / Math.PI : undefined;
}
function fmt(v) {
  return typeof v === 'number' ? (Math.abs(v) < 1e-6 ? '0' : v.toFixed(3)) : String(v);
}

// 只摘关键字段，避免日志被大对象淹没
function summarize(name, params) {
  const p = params ?? {};
  if (name === 'teleport_confirm') {
    // 特别标注字段数：26.3 服务端要 6 个（id+x+y+z+yRot+xRot），旧结构只有 id
    const keys = Object.keys(p);
    return `id=${p.teleportId} 字段=[${keys.join(',')}](${keys.length} 个)`
      + (p.x === undefined ? ' ⚠️缺坐标（26.3 会判 invalid_player_movement）' : ` pos=(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)})`);
  }
  if (name === 'position_look' || name === 'position') {
    return `pos=(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)})` + (p.yaw !== undefined ? ` yaw=${fmt(rad2deg(p.yaw))}` : '');
  }
  if (name === 'look') {
    return `yaw=${fmt(rad2deg(p.yaw))} pitch=${fmt(rad2deg(p.pitch))}`;
  }
  return JSON.stringify(p).slice(0, 120);
}
