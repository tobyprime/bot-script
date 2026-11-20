// 生成物，勿手改：源 contracts/*.yaml，重建 `node tools/codegen.mjs`
export const ABI_VERSION = 2;
export const CAPABILITIES = [
  "nav.pathfinder",
  "item.components",
  "world.block_entity"
];
export const GATES = {
  "chat": "发言（boundary.chat：say 限速/命令白名单/正则黑白名单；缺省不限）",
  "move": "移动（boundary.allow_move=false 才禁止；fence 对移动目标生效）",
  "combat": "攻击实体（boundary.combat.targets 设置后才限制目标 / max_engage）",
  "dig": "开始挖掘（boundary.blocks.dig 显式拒绝才禁止）；停止挖掘不受门控",
  "place": "放置（boundary.blocks.place 显式拒绝才禁止），由 act.use_block.intent=place 触发",
  "container": "容器访问（boundary.containers=false 才拒绝），作用于 window_open/click/close"
};

export const SYNC_OPS = {
  "log": { args: {
    "level": {"type":"string","required":true},
    "msg": {"type":"string","required":true},
  }, result: "void" },
  "util.now": { args: {}, result: "number" },
  "util.regex_new": { args: {
    "pattern": {"type":"string","required":true},
  }, result: "number" },
  "util.regex_match": { args: {
    "id": {"type":"number","required":true},
    "text": {"type":"string","required":true},
  }, result: "object|null" },
  "token.bind": { args: {
    "task_id": {"type":"number","required":true},
    "token": {"type":"number","required":true},
    "kind": {"type":"string","required":true},
  }, result: "void" },
  "token.detach": { args: {
    "token": {"type":"number","required":true},
  }, result: "void" },
  "timer.after": { args: {
    "delay": {"type":"number","required":true},
  }, result: "number" },
  "timer.interval": { args: {
    "interval": {"type":"number","required":true},
  }, result: "number" },
  "events.emit": { args: {
    "type": {"type":"string","required":true},
    "data": {"type":"object","required":false},
  }, result: "number" },
  "waiter.resolve": { args: {
    "token": {"type":"number","required":true},
    "match": {"type":"string","required":true},
  }, result: "void" },
  "self.get": { args: {}, result: "Self|null" },
  "session.get": { args: {}, result: "SessionInfo" },
  "caps.get": { args: {
    "flag": {"type":"string","required":true},
  }, result: "boolean" },
  "caps.list": { args: {}, result: "object" },
  "entities.list": { args: {
    "type": {"type":"string","required":false},
    "within": {"type":"number","required":false},
  }, result: "Entity[]" },
  "entities.get": { args: {
    "id": {"type":"string","required":true},
  }, result: "Entity|null" },
  "world.block": { args: {
    "pos": {"type":"blockpos","required":true},
  }, result: "Block|null" },
  "world.block_entity": { args: {
    "pos": {"type":"blockpos","required":true},
  }, result: "BlockEntity|null" },
  "world.scan": { args: {
    "region": {"type":"region","required":true},
    "pred": {"type":"object","required":false},
    "limit": {"type":"number","required":false,"default":200},
  }, result: "BlockPosInfo[]" },
  "world.env": { args: {}, result: "WorldEnv" },
  "world.reach": { args: {
    "pos": {"type":"blockpos","required":true},
    "max_distance": {"type":"number","required":false,"default":4.5},
  }, result: "ReachInfo" },
  "window.current": { args: {}, result: "string|null" },
  "window.get": { args: {
    "window": {"type":"string","required":true},
  }, result: "Window|null" },
  "item.stack": { args: {
    "stack": {"type":"object","required":true},
  }, result: "StackInfo" },
  "chat.config": { args: {}, result: "object" },
  "persist.table": { args: {
    "name": {"type":"string","required":true},
    "schema": {"type":"object","required":true},
  }, result: "void" },
  "persist.find": { args: {
    "name": {"type":"string","required":true},
    "where": {"type":"object","required":false},
  }, result: "object|null" },
  "persist.all": { args: {
    "name": {"type":"string","required":true},
  }, result: "object[]" },
  "persist.upsert": { args: {
    "name": {"type":"string","required":true},
    "row": {"type":"object","required":true},
  }, result: "void" },
  "persist.del": { args: {
    "name": {"type":"string","required":true},
    "where": {"type":"object","required":false},
  }, result: "void" },
  "persist.adjust": { args: {
    "name": {"type":"string","required":true},
    "key": {"type":"any","required":true},
    "delta": {"type":"number","required":true},
  }, result: "object" },
  "persist.seen": { args: {
    "key": {"type":"string","required":true},
    "window_ms": {"type":"number","required":true},
  }, result: "number" },
  "kv.get": { args: {
    "name": {"type":"string","required":true},
    "key": {"type":"string","required":true},
  }, result: "string" },
  "kv.set": { args: {
    "name": {"type":"string","required":true},
    "key": {"type":"string","required":true},
    "value": {"type":"string","required":true},
  }, result: "void" },
  "persist.log_declare": { args: {
    "name": {"type":"string","required":true},
  }, result: "void" },
  "persist.log_append": { args: {
    "name": {"type":"string","required":true},
    "fields": {"type":"object","required":false},
  }, result: "number" },
  "persist.log_find": { args: {
    "name": {"type":"string","required":true},
    "where": {"type":"object","required":false},
  }, result: "object[]" },
  "persist.log_mark": { args: {
    "name": {"type":"string","required":true},
    "id": {"type":"number","required":true},
    "state": {"type":"string","required":true},
  }, result: "void" },
  "txn.begin": { args: {}, result: "void" },
  "txn.commit": { args: {}, result: "void" },
  "txn.rollback": { args: {}, result: "void" },
};

export const ASYNC_OPS = {
  "util.sleep": { args: {
    "ms": {"type":"number","required":true},
  }, result: "void" },
  "events.next": { args: {
    "timeout": {"type":"number","required":false,"default":30000},
  }, result: "Event|null" },
  "waiter.new": { args: {
    "timeout": {"type":"number","required":false,"default":5000},
  }, result: "object|null" },
  "act.chat_send": { gate: "chat", args: {
    "text": {"type":"string","required":true},
    "kind": {"type":"string","required":false,"default":"chat"},
  }, result: "object" },
  "act.look": { args: {
    "yaw": {"type":"number|null","required":false},
    "pitch": {"type":"number|null","required":false},
  }, result: "object" },
  "act.input": { gate: "move", args: {
    "forward": {"type":"number","required":false,"default":0},
    "right": {"type":"number","required":false,"default":0},
    "up": {"type":"number","required":false,"default":0},
    "sprint": {"type":"boolean","required":false,"default":false},
    "sneak": {"type":"boolean","required":false,"default":false},
  }, result: "object" },
  "act.path_to": { gate: "move", args: {
    "target": {"type":"blockpos","required":true},
    "arrive": {"type":"number","required":false,"default":1.5},
    "timeout_ms": {"type":"number","required":false,"default":30000},
  }, result: "NavResult" },
  "act.path_cancel": { args: {}, result: "object" },
  "act.dig": { gate: "dig", args: {
    "pos": {"type":"blockpos","required":true},
    "face": {"type":"number","required":false,"default":1},
  }, result: "object" },
  "act.dig_stop": { args: {}, result: "object" },
  "act.use_block": { gate: "place", args: {
    "pos": {"type":"blockpos","required":true},
    "face": {"type":"number","required":false,"default":1},
    "hand": {"type":"string","required":false,"default":"main"},
    "intent": {"type":"string","required":false,"default":"use"},
    "cursor": {"type":"object","required":false},
  }, result: "object" },
  "act.use_entity": { gate: "combat", args: {
    "id": {"type":"string","required":true},
    "kind": {"type":"string","required":false,"default":"attack"},
    "target": {"type":"object","required":false},
    "hand": {"type":"string","required":false,"default":"main"},
  }, result: "object" },
  "act.swing": { args: {
    "hand": {"type":"string","required":false,"default":"main"},
  }, result: "object" },
  "act.use_item": { args: {
    "hand": {"type":"string","required":false,"default":"main"},
    "phase": {"type":"string","required":false,"default":"start"},
  }, result: "object" },
  "act.select_slot": { args: {
    "slot": {"type":"number","required":true},
  }, result: "object" },
  "act.drop": { args: {
    "slot": {"type":"number|null","required":false},
    "all": {"type":"boolean","required":false,"default":false},
  }, result: "object" },
  "act.window_open": { gate: "container", args: {
    "target": {"type":"any","required":true},
  }, result: "WindowRef" },
  "act.window_click": { gate: "container", args: {
    "window": {"type":"string","required":false,"default":"0"},
    "slot": {"type":"number","required":true},
    "button": {"type":"number","required":false,"default":0},
    "mode": {"type":"number","required":false,"default":0},
    "state_id": {"type":"number|null","required":false},
  }, result: "object" },
  "act.window_close": { gate: "container", args: {
    "window": {"type":"string|null","required":false},
  }, result: "object" },
};

export const REVERSE_OPS = {
  "params.bind": { args: {
    "manifest": {"type":"object","required":false},
    "instance": {"type":"object","required":false},
  }, result: "object" },
  "params.get": { args: {}, result: "object" },
  "params.set": { args: {
    "key": {"type":"string","required":true},
    "value": {"type":"any","required":false},
  }, result: "object" },
  "tasks.list": { args: {}, result: "object[]" },
  "tasks.cancel": { args: {
    "name": {"type":"string","required":true},
  }, result: "object" },
  "eval.once": { args: {
    "name": {"type":"string","required":true},
    "code": {"type":"string","required":true},
  }, result: "object" },
};

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  blockpos: (v) => v !== null && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
  region: (v) => Array.isArray(v) && v.length === 2 && v.every((c) => c && Number.isFinite(c.x)),
};

/** 按 manifest 声明校验参数；不合法抛 {kind:'abi.invalid_args', detail} */
export function validateArgs(op, spec, args) {
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const [key, a] of Object.entries(spec?.args ?? {})) {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (a.required) {
        const e = new Error(`${op}: 缺少参数 ${key}`);
        e.kind = 'abi.invalid_args';
        throw e;
      }
      continue;
    }
    const t = String(a.type);
    const base = t.split('|')[0];            // "string|null" → 校验 string（null 已放行）
    if (base === 'any' || base === 'void') continue;
    const check = TYPE_CHECKS[base];
    if (check && !check(v)) {
      const e = new Error(`${op}: 参数 ${key} 应为 ${t}`);
      e.kind = 'abi.invalid_args';
      throw e;
    }
  }
  return obj;
}
