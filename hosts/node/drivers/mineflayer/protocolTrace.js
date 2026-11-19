// protocolTrace.js — 协议层自动诊断（环形缓冲 + 断线时一次性倒出）
//
// 目的：定位 invalid_player_movement 这类「发包内容不对」的问题，且**不需要用户改环境变量**。
//
// 设计：
//   · 始终开启，但只在内存里留最近 N 条（环形缓冲），不往日志写 → 平时零噪音、开销极小
//   · 一旦发生 kicked / disconnected（尤其 invalid_player_movement），把缓冲区一次性倒进日志
//   · BOTSCRIPT_PROTO_TRACE=1 时恢复「逐条实时打印」，用于深度调试
//
// 记录内容只含包名与关键数值，不含 token 等凭据。
const TRACE_ENV = 'BOTSCRIPT_PROTO_TRACE';
const FOLLOW_NAMES = [
  'look', 'position', 'position_look', 'flying', 'teleport_confirm',
  // 连接被服务器/代理主动终止时，最需要看到的是「断前发了什么」：
  // keep_alive（保活是否被答）、resource_pack_receive（资源包状态是否被接受）
  'keep_alive', 'resource_pack_receive',
];
const RING_MAX = 40;   // 环形缓冲条数：足够覆盖「被踢前的几秒」

export function traceVerbose(env = process.env) {
  return env[TRACE_ENV] === '1' || env[TRACE_ENV] === 'true';
}

// 挂上诊断钩子；返回 { flush, off }
//   flush(reason)：把缓冲区内容连同原因一次性写进日志（断线时调用）
export function installProtocolTrace(bot, log = console.log, opts = {}) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') {
    return { flush: () => {}, off: () => {} };
  }
  const verbose = opts.verbose ?? traceVerbose();

  const t0 = Date.now();
  const ring = [];
  const lastByKind = {};
  let flushed = false;

  const push = (line) => {
    const entry = `[trace ${Date.now() - t0}ms] ${line}`;
    if (verbose) log(entry);
    ring.push(entry);
    if (ring.length > RING_MAX) ring.shift();
  };

  const origWrite = client.write.bind(client);
  const patched = (name, params) => {
    if (FOLLOW_NAMES.includes(name)) {
      const ms = Date.now() - t0;
      const prev = lastByKind[name];
      lastByKind[name] = ms;
      const gap = prev == null ? '-' : `${ms - prev}ms`;
      push(`→ ${name} ${summarize(name, params)} (间隔 ${gap})`);
    }
    return origWrite(name, params);
  };
  client.write = patched;

  const onPosition = (p) => {
    push(`← position id=${p.teleportId} pos=(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}) `
      + `yaw=${fmt(p.yaw !== undefined ? p.yaw : rad2deg(p.yRot))} `
      + `pitch=${fmt(p.pitch !== undefined ? p.pitch : rad2deg(p.xRot))} `
      + `flags=${typeof p.flags === 'object' ? JSON.stringify(p.flags) : p.flags}`);
  };
  client.on('position', onPosition);

  // 结论性事件：服务器主动断开 / 转移 / 资源包要求 / 配置阶段切换。
  // 这些包名此前不在环里，导致断线只能看到「socketClosed」，看不到服务器意图。
  const extraListeners = [
    ['add_resource_pack', (p) => push(`← add_resource_pack forced=${p.forcedPrompt ?? p.forced ?? '?'} `
      + `url=${String(p.url ?? '').slice(0, 120)}`)],
    ['resource_pack_send', (p) => push(`← resource_pack_send url=${String(p.url ?? '').slice(0, 120)}`)],
    ['disconnect', (p) => push(`← disconnect reason=${JSON.stringify(p.reason ?? '').slice(0, 300)}`)],
    ['transfer', (p) => push(`← transfer host=${String(p.host ?? '')} port=${p.port}`)],
    ['start_configuration', () => push('← start_configuration（进入 configuration 阶段）')],
    ['keep_alive', (p) => push(`← keep_alive id=${p.keepAliveId}`)],
  ];
  for (const [name, fn] of extraListeners) client.on(name, fn);

  // 一次性倒出（重复调用无副作用）
  const flush = (reason) => {
    if (flushed || !ring.length) return;
    flushed = true;
    log(`[trace] 断线诊断（${reason}）——最近 ${ring.length} 条协议记录：`, 'debug');
    for (const line of ring) log(`  ${line}`, 'debug');
  };

  const off = () => {
    client.write = origWrite;
    try { client.removeListener('position', onPosition); } catch { /* ignore */ }
    for (const [name, fn] of extraListeners) {
      try { client.removeListener(name, fn); } catch { /* ignore */ }
    }
  };

  return { flush, off };
}

function rad2deg(rad) {
  return typeof rad === 'number' ? (rad * 180) / Math.PI : undefined;
}
function fmt(v) {
  return typeof v === 'number' ? (Math.abs(v) < 1e-6 ? '0' : v.toFixed(3)) : String(v);
}

function summarize(name, params) {
  const p = params ?? {};
  if (name === 'teleport_confirm') {
    const keys = Object.keys(p);
    return `id=${p.teleportId} 字段=[${keys.join(',')}](${keys.length} 个)`
      + (p.x === undefined ? ' ⚠️缺坐标' : ` pos=(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)})`);
  }
  if (name === 'position_look' || name === 'position') {
    return `pos=(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)})` + (p.yaw !== undefined ? ` yaw=${fmt(p.yaw)}°` : '');
  }
  if (name === 'look') return `yaw=${fmt(p.yaw)}° pitch=${fmt(p.pitch)}°`;
  if (name === 'resource_pack_receive') {
    const RESULTS = ['successfully_loaded', 'declined', 'failed_download', 'accepted',
      'downloaded', 'invalid_url', 'failed_reload', 'discarded'];
    return `uuid=${String(p.uuid ?? '').slice(0, 8)} result=${p.result}(${RESULTS[p.result] ?? '?'})`;
  }
  if (name === 'keep_alive') return `id=${p.keepAliveId}`;
  return JSON.stringify(p).slice(0, 120);
}
