-- 生成物，勿手改：源 contracts/*.yaml，重建 `node tools/codegen.mjs`
-- 核心只通过本模块访问宿主（bridge.self.get / bridge.act.chat_send …），不再手写桥名字符串。
local json = require "json"

local function dec(j)
  if j == nil or j == "" then return nil end
  return json.decode(j)
end

local function q(op, args)
  local r = dec(__host_q(op, json.encode(args or {})))
  if type(r) == "table" and r.ok ~= nil then return r end
  -- 兼容尚未迁移到 Result 的宿主（Fabric 旧实现）：成功值按 Ok 包装
  return { ok = true, value = r }
end

-- Result 解包（核心/bslib 内部取纯数据用；失败 -> default，不抛错）
local function value(r, default)
  if type(r) == "table" and r.ok == true then return r.value end
  return default
end

local function a(op, args)
  return __host_a(op, json.encode(args or {}))
end

local bridge = {}
bridge.abi = 2
bridge.q = q
bridge.value = value
bridge.a = a

-- 命名空间（bridge.self / bridge.act / bridge.persist …）
bridge.act = {}
bridge.caps = {}
bridge.chat = {}
bridge.entities = {}
bridge.events = {}
bridge.item = {}
bridge.kv = {}
bridge.persist = {}
bridge.self = {}
bridge.session = {}
bridge.timer = {}
bridge.token = {}
bridge.txn = {}
bridge.util = {}
bridge.waiter = {}
bridge.window = {}
bridge.world = {}

-- 同步 op
--- log(level, msg) → void
bridge.log = function(level, msg)
  return q("log", {
    level = level,
    msg = msg,
  })
end
--- util.now() → number
bridge.util.now = function()
  return q("util.now", {
})
end
--- util.regex_new(pattern) → number
bridge.util.regex_new = function(pattern)
  return q("util.regex_new", {
    pattern = pattern,
  })
end
--- util.regex_match(id, text) → object|null
bridge.util.regex_match = function(id, text)
  return q("util.regex_match", {
    id = id,
    text = text,
  })
end
--- token.bind(task_id, token, kind) → void
bridge.token.bind = function(task_id, token, kind)
  return q("token.bind", {
    task_id = task_id,
    token = token,
    kind = kind,
  })
end
--- token.detach(token) → void
bridge.token.detach = function(token)
  return q("token.detach", {
    token = token,
  })
end
--- timer.after(delay) → number
bridge.timer.after = function(delay)
  return q("timer.after", {
    delay = delay,
  })
end
--- timer.interval(interval) → number
bridge.timer.interval = function(interval)
  return q("timer.interval", {
    interval = interval,
  })
end
--- events.emit(type, data) → number
bridge.events.emit = function(type, data)
  return q("events.emit", {
    type = type,
    data = data,
  })
end
--- waiter.resolve(token, match) → void
bridge.waiter.resolve = function(token, match)
  return q("waiter.resolve", {
    token = token,
    match = match,
  })
end
--- self.get() → Self|null
bridge.self.get = function()
  return q("self.get", {
})
end
--- session.get() → SessionInfo
bridge.session.get = function()
  return q("session.get", {
})
end
--- caps.get(flag) → boolean
bridge.caps.get = function(flag)
  return q("caps.get", {
    flag = flag,
  })
end
--- caps.list() → object
bridge.caps.list = function()
  return q("caps.list", {
})
end
--- entities.list(type, within, pred, projection, order, limit) → Entity[]
bridge.entities.list = function(type, within, pred, projection, order, limit)
  return q("entities.list", {
    type = type,
    within = within,
    pred = pred,
    projection = projection ~= nil and projection or "full",
    order = order,
    limit = limit,
  })
end
--- entities.get(id, projection) → Entity|null
bridge.entities.get = function(id, projection)
  return q("entities.get", {
    id = id,
    projection = projection ~= nil and projection or "full",
  })
end
--- world.block(pos) → Block|null
bridge.world.block = function(pos)
  return q("world.block", {
    pos = pos,
  })
end
--- world.block_entity(pos) → BlockEntity|null
bridge.world.block_entity = function(pos)
  return q("world.block_entity", {
    pos = pos,
  })
end
--- world.scan(region, pred, limit) → BlockPosInfo[]
bridge.world.scan = function(region, pred, limit)
  return q("world.scan", {
    region = region,
    pred = pred,
    limit = limit ~= nil and limit or 200,
  })
end
--- world.env() → WorldEnv
bridge.world.env = function()
  return q("world.env", {
})
end
--- world.reach(pos, max_distance) → ReachInfo
bridge.world.reach = function(pos, max_distance)
  return q("world.reach", {
    pos = pos,
    max_distance = max_distance ~= nil and max_distance or 4.5,
  })
end
--- window.current() → string|null
bridge.window.current = function()
  return q("window.current", {
})
end
--- window.get(window, fields) → Window|null
bridge.window.get = function(window, fields)
  return q("window.get", {
    window = window,
    fields = fields ~= nil and fields or "full",
  })
end
--- item.stack(stack) → StackInfo
bridge.item.stack = function(stack)
  return q("item.stack", {
    stack = stack,
  })
end
--- chat.config() → object
bridge.chat.config = function()
  return q("chat.config", {
})
end
--- persist.table(name, schema) → void
bridge.persist.table = function(name, schema)
  return q("persist.table", {
    name = name,
    schema = schema,
  })
end
--- persist.find(name, where) → object|null
bridge.persist.find = function(name, where)
  return q("persist.find", {
    name = name,
    where = where,
  })
end
--- persist.all(name) → object[]
bridge.persist.all = function(name)
  return q("persist.all", {
    name = name,
  })
end
--- persist.upsert(name, row) → void
bridge.persist.upsert = function(name, row)
  return q("persist.upsert", {
    name = name,
    row = row,
  })
end
--- persist.del(name, where) → void
bridge.persist.del = function(name, where)
  return q("persist.del", {
    name = name,
    where = where,
  })
end
--- persist.adjust(name, key, delta) → object
bridge.persist.adjust = function(name, key, delta)
  return q("persist.adjust", {
    name = name,
    key = key,
    delta = delta,
  })
end
--- persist.seen(key, window_ms) → number
bridge.persist.seen = function(key, window_ms)
  return q("persist.seen", {
    key = key,
    window_ms = window_ms,
  })
end
--- kv.get(name, key) → string
bridge.kv.get = function(name, key)
  return q("kv.get", {
    name = name,
    key = key,
  })
end
--- kv.set(name, key, value) → void
bridge.kv.set = function(name, key, value)
  return q("kv.set", {
    name = name,
    key = key,
    value = value,
  })
end
--- persist.log_declare(name) → void
bridge.persist.log_declare = function(name)
  return q("persist.log_declare", {
    name = name,
  })
end
--- persist.log_append(name, fields) → number
bridge.persist.log_append = function(name, fields)
  return q("persist.log_append", {
    name = name,
    fields = fields,
  })
end
--- persist.log_find(name, where) → object[]
bridge.persist.log_find = function(name, where)
  return q("persist.log_find", {
    name = name,
    where = where,
  })
end
--- persist.log_mark(name, id, state) → void
bridge.persist.log_mark = function(name, id, state)
  return q("persist.log_mark", {
    name = name,
    id = id,
    state = state,
  })
end
--- txn.begin() → void
bridge.txn.begin = function()
  return q("txn.begin", {
})
end
--- txn.commit() → void
bridge.txn.commit = function()
  return q("txn.commit", {
})
end
--- txn.rollback() → void
bridge.txn.rollback = function()
  return q("txn.rollback", {
})
end

-- 异步 op（返回 token；结果经 __core_resume 交付）
--- util.sleep(ms) → void  [async: token]
bridge.util.sleep = function(ms)
  return a("util.sleep", {
    ms = ms,
  })
end
--- events.next(timeout) → Event|null  [async: token]
bridge.events.next = function(timeout)
  return a("events.next", {
    timeout = timeout ~= nil and timeout or 30000,
  })
end
--- waiter.new(timeout) → object|null  [async: token]
bridge.waiter.new = function(timeout)
  return a("waiter.new", {
    timeout = timeout ~= nil and timeout or 5000,
  })
end
--- act.custom_payload(channel, data) → object  [gate: packet]  [async: token]
bridge.act.custom_payload = function(channel, data)
  return a("act.custom_payload", {
    channel = channel,
    data = data ~= nil and data or "",
  })
end
--- act.chat_send(text, kind) → object  [gate: chat]  [async: token]
bridge.act.chat_send = function(text, kind)
  return a("act.chat_send", {
    text = text,
    kind = kind ~= nil and kind or "chat",
  })
end
--- act.look(yaw, pitch) → object  [async: token]
bridge.act.look = function(yaw, pitch)
  return a("act.look", {
    yaw = yaw,
    pitch = pitch,
  })
end
--- act.input(forward, right, up, sprint, sneak) → object  [gate: move]  [async: token]
bridge.act.input = function(forward, right, up, sprint, sneak)
  return a("act.input", {
    forward = forward ~= nil and forward or 0,
    right = right ~= nil and right or 0,
    up = up ~= nil and up or 0,
    sprint = sprint ~= nil and sprint or false,
    sneak = sneak ~= nil and sneak or false,
  })
end
--- act.path_to(target, arrive, timeout_ms) → NavResult  [gate: move]  [async: token]
bridge.act.path_to = function(target, arrive, timeout_ms)
  return a("act.path_to", {
    target = target,
    arrive = arrive ~= nil and arrive or 1.5,
    timeout_ms = timeout_ms ~= nil and timeout_ms or 30000,
  })
end
--- act.path_cancel() → object  [async: token]
bridge.act.path_cancel = function()
  return a("act.path_cancel", {
})
end
--- act.dig(pos, face) → object  [gate: dig]  [async: token]
bridge.act.dig = function(pos, face)
  return a("act.dig", {
    pos = pos,
    face = face ~= nil and face or 1,
  })
end
--- act.dig_stop() → object  [async: token]
bridge.act.dig_stop = function()
  return a("act.dig_stop", {
})
end
--- act.use_block(pos, face, hand, intent, cursor) → object  [gate: place]  [async: token]
bridge.act.use_block = function(pos, face, hand, intent, cursor)
  return a("act.use_block", {
    pos = pos,
    face = face ~= nil and face or 1,
    hand = hand ~= nil and hand or "main",
    intent = intent ~= nil and intent or "use",
    cursor = cursor,
  })
end
--- act.use_entity(id, kind, target, hand) → object  [gate: combat]  [async: token]
bridge.act.use_entity = function(id, kind, target, hand)
  return a("act.use_entity", {
    id = id,
    kind = kind ~= nil and kind or "attack",
    target = target,
    hand = hand ~= nil and hand or "main",
  })
end
--- act.swing(hand) → object  [async: token]
bridge.act.swing = function(hand)
  return a("act.swing", {
    hand = hand ~= nil and hand or "main",
  })
end
--- act.use_item(hand, phase) → object  [async: token]
bridge.act.use_item = function(hand, phase)
  return a("act.use_item", {
    hand = hand ~= nil and hand or "main",
    phase = phase ~= nil and phase or "start",
  })
end
--- act.select_slot(slot) → object  [async: token]
bridge.act.select_slot = function(slot)
  return a("act.select_slot", {
    slot = slot,
  })
end
--- act.drop(slot, all) → object  [async: token]
bridge.act.drop = function(slot, all)
  return a("act.drop", {
    slot = slot,
    all = all ~= nil and all or false,
  })
end
--- act.window_open(target) → WindowRef  [gate: container]  [async: token]
bridge.act.window_open = function(target)
  return a("act.window_open", {
    target = target,
  })
end
--- act.window_click(window, slot, button, mode, state_id) → object  [gate: container]  [async: token]
bridge.act.window_click = function(window, slot, button, mode, state_id)
  return a("act.window_click", {
    window = window ~= nil and window or "0",
    slot = slot,
    button = button ~= nil and button or 0,
    mode = mode ~= nil and mode or 0,
    state_id = state_id,
  })
end
--- act.window_close(window) → object  [gate: container]  [async: token]
bridge.act.window_close = function(window)
  return a("act.window_close", {
    window = window,
  })
end

-- 能力与补丁（/caps 与启动日志共用）
bridge.capabilities = { "nav.pathfinder", "item.components", "world.block_entity", "net.custom_payload" }

return bridge
