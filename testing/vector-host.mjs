// testing/vector-host.mjs — 调度向量的假宿主（只验证契约逻辑，不做根因定位）
//
// 这是 vectors/scheduler 的执行器：核心 Lua 在真实运行时上跑，宿主侧用虚拟时钟 +
// 内存 state，产出确定的事件/日志序列。Node（wasmoon）与 Java（Luaj）跑同一份向量，
// 输出序列必须一致 —— 这是防 Lua 拷贝漂移的唯一可行机制（ARCHITECTURE-REFACTOR §5）。
import { LuaVm } from '../hosts/node/vm.js';

export async function runSchedulerVector(vec, { scriptDir = null } = {}) {
  const logs = [];
  let now = 1000;
  let paused = false;
  const tokens = new Map();
  const settled = new Map();
  const timers = [];          // {token, at}
  const pending = [];         // 待交付（帧尾 flush）
  let nextToken = 1;
  let depth = 0;
  const paramValues = {};

  const state = new Map();
  const seen = new Map();

  const flush = () => {
    while (pending.length && depth === 0 && !paused) {
      const [taskId, okj, ej] = pending.shift();
      depth++;
      try { vm.fn('__core_resume')(taskId, okj, ej); } finally { depth--; }
    }
  };

  const deliver = (token, okj, ej) => {
    const rec = tokens.get(token);
    if (!rec) return;
    tokens.delete(token);
    if (rec.detached) return;              // fire-and-forget
    if (!rec.bound) { settled.set(token, [okj, ej]); return; }
    pending.push([rec.taskId, okj, ej]);
  };

  const settle = (token, okj, ej) => {
    const rec = tokens.get(token);
    if (!rec || rec.settled) return;
    rec.settled = true;
    if (rec.bound) deliver(token, okj, ej);
    else settled.set(token, [okj, ej]);
  };

  const newToken = (kind) => {
    const t = nextToken++;
    tokens.set(t, { kind, bound: false, settled: false });
    return t;
  };

  const q = {
    'util.now': () => now,
    log: ({ level, msg }) => { logs.push(`${level}|${msg}`); },
    'token.bind': ({ task_id: taskId, token }) => {
      const rec = tokens.get(token);
      if (!rec) return;
      rec.bound = true;
      rec.taskId = Number(taskId);
      if (rec.settled) deliver(token, ...(settled.get(token) ?? ['', '']));
    },
    'token.detach': ({ token }) => { const r = tokens.get(token); if (r) r.detached = true; },
    'waiter.resolve': ({ token, match }) => settle(Number(token), String(match ?? ''), ''),
    'timer.after': () => 1,
    'timer.interval': () => 2,
    'events.emit': ({ type }) => { logs.push(`event|${type}`); return 1; },
    'caps.get': () => false,
    'state.get': ({ key }) => (state.has(key) ? JSON.parse(state.get(key)) : null),
    'state.all': () => Object.fromEntries([...state].map(([k, v]) => [k, JSON.parse(v)])),
    'state.set': ({ key, value }) => { state.set(key, JSON.stringify(value ?? null)); return {}; },
    'state.delete': ({ key }) => { state.delete(key); return {}; },
    'state.seen': ({ key, window_ms: win }) => {
      const prev = seen.get(key);
      if (prev != null && now - prev <= win) return true;
      seen.set(key, now);
      return false;
    },
    'self.get': () => ({ username: 'VecBot', pos: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, held_slot: 0 }),
    'entities.list': () => [],
    'entities.get': () => null,
    'world.block': () => null,
    'window.current': () => null,
    'window.get': () => null,
    'session.get': () => ({ state: 'playing', info: {} }),
  };

  const vm = await new LuaVm({ scriptDir: scriptDir ?? __dirnameSafe(), log: (l, m) => logs.push(`${l}|${m}`) }).start();
  vm.setGlobal('__host_q', (op, argsJson) => {
    const fn = q[op];
    if (!fn) return '';
    const out = fn(JSON.parse(argsJson || '{}'));
    return out === undefined || out === null ? '' : JSON.stringify(out);
  });
  vm.setGlobal('__host_a', (op, argsJson) => {
    const args = JSON.parse(argsJson || '{}');
    if (op === 'util.sleep' || op === 'waiter.new' || op === 'events.next') {
      const token = newToken('timer');
      const ms = Number(args.ms ?? args.timeout ?? 0);
      timers.push({ token, at: now + ms });
      return token;
    }
    const token = newToken('action');
    settle(token, '{}', '');
    return token;
  });

  // 初始参数（向量的 params 包清单）
  void vec.params;
  await vm.doString(vec.script);

  const coreEvent = (kind, payload) => {
    depth++;
    try { vm.fn('__core_event')(kind, payload === undefined ? '' : JSON.stringify(payload)); } finally { depth--; }
    flush();
  };
  const coreCall = (op, args) => JSON.parse(vm.fn('__core_call')(op, JSON.stringify(args ?? {})) || '{}');

  for (const step of vec.steps ?? []) {
    if (step.event) coreEvent(step.event[0], step.event[1]);
    else if (step.call) {
      depth++;
      try { vm.fn('__core_call')(step.call[0], JSON.stringify(step.call[1] ?? {})); } finally { depth--; }
      flush();
    } else if (step.advance) {
      now += step.advance;
      let due;
      do {
        due = timers.filter((t) => t.at <= now);
        for (const t of due) {
          timers.splice(timers.indexOf(t), 1);
          settle(t.token, '', '');
        }
        flush();
      } while (due.length);
    } else if (step.pause) {
      paused = true;
    } else if (step.resume) {
      paused = false;
      flush();
    }
  }
  // 末尾把剩余到期定时器结算掉（向量应以显式 advance 覆盖，剩余视为泄漏）
  const left = timers.filter((t) => t.at <= now).length;
  try { vm.close(); } catch { /* ignore */ }
  return { logs, coreCall, leftoverTimers: left };
}

function __dirnameSafe() {
  return process.cwd();
}
