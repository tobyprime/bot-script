-- ============================================================
-- bootstrap.lua — bot-script 引擎侧 Lua 运行时（随引擎分发，脚本不可见）
--
-- yield 协议：任务体在挂起点 yield 描述串 "<token>|<kind>|<txn>"
--   kind: a=动作 t=sleep j=join(race/parallel) w=await_chat
-- JS 侧约定（全局函数）：
--   __core_resume(id, okj, ej)   挂起点交付（ej 非空 => await 处抛错）
--   __core_event(kind, json)     驱动事件/定时器/命令/生命周期 入 Lua
--   __core_yield(id, tok, kind, txn)  yield 登记（txn=1 => 事务回滚）
--   __act_<name>(json, taskid)   动作 => token（一切动作错误经 token 交付）
--   __q_<name>(json)             同步查询 => JSON（"" / nil 表示 nil）
--   __join_report(token, idx, status, resultj, errj)  join 子任务结算
-- 结构化数据一律 JSON 字符串过桥（engine/lua/json.lua）。
-- ============================================================

local json = require "json"

local raw_tostring = tostring

__T = {}              -- taskid -> task record
__T_NEXT = 0
__READY = {}          -- 调度队列 {id, okj, ej, drop}
__CHAT_HANDLERS = {}
__EVENT_HANDLERS = {}
__AWAITERS = {}       -- await_chat {rexid, token}
__DECL = { tasks = {}, timers = {}, afters = {} }
__LIFE = {}
__COMMANDS = {}
__CLEANUP_FLAG = {}   -- taskid -> true（on_cancel 清理中：动作改 fire-and-forget）
__IN_CLEANUP = false

local function encode(v) return json.encode(v) end
local function decode(j) return json.decode(j) end

local function is_cancel(e) return type(e) == "table" and e.kind == "task.cancelled" end
local function errstr(e)
  if type(e) == "table" and e.kind then
    return e.kind .. (e.detail ~= nil and (": " .. raw_tostring(e.detail)) or "")
  end
  return raw_tostring(e)
end

-- tostring 覆盖：vec3/blockpos 可读化（脚本有 "已登记 " .. tostring(a.pos) 用法）
tostring = function(v)
  if type(v) == "table" and type(v.x) == "number" and type(v.y) == "number" and type(v.z) == "number" then
    return math.floor(v.x) .. " " .. math.floor(v.y) .. " " .. math.floor(v.z)
  end
  return raw_tostring(v)
end

function contains(list, v)
  for _, x in ipairs(list or {}) do if x == v then return true end end
  return false
end

function sec(n) return math.floor(n * 1000) end

-- ---------- await / 动作调用 ----------

local function current_id()
  local co = coroutine.running()
  for id, t in pairs(__T) do
    if t.co == co then return id end
  end
  return nil
end

-- 动作 await：交付值解码返回；交付错误在挂起点抛类型化错误（table）
local function await(token)
  local okj, ej = coroutine.yield(token, __TXN_FLAG and 1 or 0)
  if ej ~= nil and ej ~= "" then
    local e = decode(ej)
    if type(e) ~= "table" then error(raw_tostring(e), 0) end
    error(e, 0)
  end
  if okj == nil or okj == "" then return nil end
  return decode(okj)
end

local function call_action(jsname, args)   -- (local；末尾 _G.call_action 暴露给示例引导脚本)

  local id = current_id() or 0
  local tok = _G[jsname](encode(args), id)
  if __IN_CLEANUP or __CLEANUP_FLAG[id] then
    __fire_token(tok)   -- 清理钩中的动作：fire-and-forget（钩子运行在 pump 上下文，不可挂起）
    return nil
  end
  return await(tok)
end
_G.call_action = call_action

local function call_query(jsname, args)
  local j = _G[jsname](encode(args))
  if j == nil or j == "" then return nil end
  if type(j) == "number" or type(j) == "boolean" then return j end
  return decode(j)
end

-- ---------- 调度核心 ----------

local function cancel_children(id)
  for _, t in pairs(__T) do
    if t.parent == id and (t.status == "ready" or t.status == "suspended") then
      task.cancel(t, "parent:" .. id)
    end
  end
end

local function finish(t, ok, errv)
  if ok then
    t.status = "done"
  elseif is_cancel(errv) then
    t.status = "cancelled"
  else
    t.status = "failed"
    t.error = errv
  end
  if not t.detached then cancel_children(t.id) end   -- 事件处理器是脱离根：完成不级联
  if t.join then
    __join_report(t.join.token, t.join.idx, t.status,
                  t.status == "done" and encode(t.result) or "",
                  t.status == "failed" and encode(t.error) or "")
  end
  if t.status == "failed" and not t.join then
    local e = t.error
    for _, fn in ipairs(__LIFE.on_error or {}) do
      local okr, r = pcall(fn, type(e) == "table" and e or { kind = "runtime.error", detail = errstr(e) })
      if not okr then __log("error", "on_error handler 出错: " .. errstr(r)) end
    end
    __log("error", "任务 [" .. (t.decl_name or t.name) .. "] 失败: " .. errstr(e))
  end
end

local function run_cancel_hooks(t)
  __IN_CLEANUP = true
  __CLEANUP_FLAG[t.id] = true
  for _, fn in ipairs(t.cancel_hooks) do
    local okr, r = pcall(fn)
    if not okr then __log("warn", "on_cancel 清理钩出错: " .. errstr(r)) end
  end
  __CLEANUP_FLAG[t.id] = nil
  __IN_CLEANUP = false
end

local function pump()
  while #__READY > 0 do
    local item = table.remove(__READY, 1)
    local t = __T[item.id]
    if t then
      if item.drop then
        if t.status == "ready" or t.status == "suspended" then
          t.status = "cancelled"
          cancel_children(t.id)
        end
      elseif t.status == "ready" or t.status == "suspended" then
        t.status = "running"
        if item.ej ~= nil and item.ej ~= "" and is_cancel(decode(item.ej)) then
          run_cancel_hooks(t)   -- 取消交付：先清理（fire 模式），再注入取消错误
        end
        local okr, r1, r2 = coroutine.resume(t.co, item.okj, item.ej)
        if coroutine.status(t.co) == "dead" then
          if okr then
            t.result = r1
            finish(t, true)
          else
            finish(t, false, r1)
          end
        else
          t.status = "suspended"
          local tok = tonumber(r1)
          if not tok then
            finish(t, false, "bad yield descriptor: " .. raw_tostring(r1))
          elseif __JOINS[tok] then
            -- join 等待：纯 Lua 登记/补交（JS 不可重入 Lua）
            local j = __JOINS[tok]
            if j.out_okj then
              __READY[#__READY + 1] = { id = t.id, okj = j.out_okj, ej = j.out_ej }
              __JOINS[tok] = nil
            else
              j.waiter = t.id
            end
          else
            __core_yield(t.id, tok, "a", r2 == 1 or r2 == true)
          end
        end
      end
      -- 其余状态：陈旧交付，丢弃
    end
  end
end

local function new_task(fn, name, decl_name, opts, parent)
  __T_NEXT = __T_NEXT + 1
  local t = {
    id = __T_NEXT,
    co = coroutine.create(fn),
    name = name or ("anon#" .. __T_NEXT),
    decl_name = decl_name,
    opts = opts or {},
    parent = parent,
    status = "ready",
    cancel_hooks = {},
    progress = 0,
  }
  __T[t.id] = t
  __READY[#__READY + 1] = { id = t.id }
  return t
end

task = setmetatable({}, {
  __call = function(_, name, opts, fn)
    if type(opts) == "function" then fn = opts; opts = nil end
    __DECL.tasks[name] = { opts = opts or {}, fn = fn }
    return name
  end,
})

function task.spawn(name_or_fn, ...)
  local spec, decl_name
  if type(name_or_fn) == "string" then
    spec = __DECL.tasks[name_or_fn]
    if not spec then error{ kind = "task.unknown", detail = name_or_fn } end
    decl_name = name_or_fn
    if spec.opts.single then
      for _, t in pairs(__T) do
        if t.decl_name == name_or_fn and (t.status == "ready" or t.status == "suspended") then
          __log("warn", "任务 [" .. name_or_fn .. "] 防重入：丢弃本次触发")
          return nil
        end
      end
    end
  end
  local args = { ... }
  local parent = current_id()
  local fn = spec and spec.fn or name_or_fn
  local t = new_task(function() fn(table.unpack(args)) end, decl_name, decl_name,
                     spec and spec.opts or nil, parent)
  pump()
  return t
end

-- 事件处理器形态：脱离根（完成不级联取消其 spawn 的任务）
function task.spawn_detached(fn, ...)
  local args = { ... }
  local t = new_task(function() fn(table.unpack(args)) end, nil, nil, nil, current_id())
  t.detached = true
  pump()
  return t
end

function task.cancel(target, source)
  source = source or "external"
  local id
  if type(target) == "table" and rawget(target, "id") then id = target.id
  elseif type(target) == "number" then id = target
  else
    for _, t in pairs(__T) do
      if t.decl_name == target and (t.status == "ready" or t.status == "suspended") then
        id = t.id; break
      end
    end
  end
  if not id then return false end
  local t = __T[id]
  if not (t.status == "ready" or t.status == "suspended") then return false end
  -- 取消留痕：显式取消/级联（parent:N）/race 败者/超时全部经此一处，留审计线索
  __log("info", "任务 [" .. (t.decl_name or t.name) .. "] 取消（" .. source .. "）")
  local err = encode({ kind = "task.cancelled", source = source })
  if t.status == "suspended" then
    __READY[#__READY + 1] = { id = id, ej = err }
  else
    for _, item in ipairs(__READY) do
      if item.id == id then item.drop = true end
    end
    t.status = "cancelled"
    cancel_children(id)
  end
  pump()
  return true
end

function task.cancel_all(source)
  for _, t in pairs(__T) do
    if t.status == "ready" or t.status == "suspended" then
      task.cancel(t, source or "cancel_all")
    end
  end
end

function task.all()
  local out = {}
  for _, t in pairs(__T) do
    if t.status == "ready" or t.status == "suspended" then
      out[#out + 1] = { id = t.id, name = t.decl_name or t.name, status = t.status }
    end
  end
  return out
end

function __task_list_json()
  local out = {}
  for _, t in pairs(__T) do
    if t.status == "ready" or t.status == "suspended" then
      out[#out + 1] = (t.decl_name or t.name) .. ":" .. t.status
    end
  end
  return encode(out)
end

task.list_json = __task_list_json

-- 控制通道（HTTP /tasks、/tasks/cancel，CAPABILITIES §17）
function __task_list_full_json()
  local out = {}
  for _, t in pairs(__T) do
    if t.status == "ready" or t.status == "suspended" then
      out[#out + 1] = {
        id = t.id,
        name = t.decl_name or t.name,
        status = t.status,
        progress = t.progress or 0,
      }
    end
  end
  return encode(out)
end

function __task_cancel_by_name(name)
  for _, t in pairs(__T) do
    if (t.decl_name == name or t.name == name)
        and (t.status == "ready" or t.status == "suspended") then
      local ok = task.cancel(t.id, "control")
      return encode({ ok = ok, found = true })
    end
  end
  return encode({ ok = false, found = false })
end

function task.progress(delta)
  local id = current_id()
  if id then __T[id].progress = (__T[id].progress or 0) + delta end
end

function on_cancel(fn)
  local id = current_id()
  if id then table.insert(__T[id].cancel_hooks, fn) end
end

-- JS => Lua：挂起点交付（pause 门控由 JS 保证：pause 期间不进来）
-- wasmoon 的 JS->Lua 调用是无保护 lua_callk：顶层 Lua 错误会 wasm abort。
-- 所有入口必须内部 pcall，把错误降级为日志。
function __core_resume(id, okj, ej)
  local ok, err = pcall(__core_resume_inner, id, okj, ej)
  if not ok then __log("error", "resume panic: " .. errstr(err)) end
end

function __core_resume_inner(id, okj, ej)
  __READY[#__READY + 1] = { id = id, okj = okj, ej = ej }
  pump()
end

-- JS => Lua：任务 yield 后登记等待；事务内挂起 => 回滚 + 抛 persist.txn_yielded
function __core_yield(id, token, kind, txn)
  if txn then
    __txn_rollback()
    __TXN_FLAG = false
    __core_resume(id, nil, encode({ kind = "persist.txn_yielded",
                                    detail = "txn 体内出现挂起点，事务已回滚" }))
    return
  end
  __core_register_waiter(id, token, kind)
end

-- JS => Lua：事件/定时器/命令/生命周期分发（同 __core_resume：内部 pcall 防 wasm abort）
function __core_event(kind, j)
  local ok, err = pcall(__core_event_inner, kind, j)
  if not ok then __log("error", "event panic (" .. raw_tostring(kind) .. "): " .. errstr(err)) end
end

function __core_event_inner(kind, j)
  local p = (j ~= nil and j ~= "") and decode(j) or nil
  if kind == "timer" then
    local spec = p and __DECL.timers[p.id]
    if spec then task.spawn_detached(spec.fn) end
  elseif kind == "after" then
    local fn = p and __DECL.afters[p.id]
    if fn then
      __DECL.afters[p.id] = nil   -- 一次性：触发即注销，防止重复事件重放回调
      task.spawn_detached(fn)
    end
  elseif kind == "chat" then
    __chat_pipeline(p)
  elseif kind == "lifecycle" then
    for _, fn in ipairs(__LIFE[p.kind] or {}) do
      task.spawn_detached(fn, p.payload)
    end
  elseif kind == "command" then
    local h = p and __COMMANDS[p.index]
    if h then task.spawn_detached(h.fn, p.args or {}) end
  else
    for _, h in ipairs(__EVENT_HANDLERS[kind] or {}) do
      task.spawn_detached(h.fn, p)
    end
  end
  pump()
end

function on_event(name, fn)
  __EVENT_HANDLERS[name] = __EVENT_HANDLERS[name] or {}
  table.insert(__EVENT_HANDLERS[name], { fn = fn })
end

function on_start(fn) __LIFE.on_start = __LIFE.on_start or {}; table.insert(__LIFE.on_start, fn) end
function on_pause(fn) __LIFE.on_pause = __LIFE.on_pause or {}; table.insert(__LIFE.on_pause, fn) end
function on_resume(fn) __LIFE.on_resume = __LIFE.on_resume or {}; table.insert(__LIFE.on_resume, fn) end
function on_error(fn) __LIFE.on_error = __LIFE.on_error or {}; table.insert(__LIFE.on_error, fn) end

function on_timer(interval, fn)
  local id = __timer_register(encode({ interval = interval }))
  __DECL.timers[id] = { fn = fn, interval = interval }
end

function after(d, fn)
  local id = __after_register(encode({ delay = d }))
  __DECL.afters[id] = fn
end

-- ---------- 结构化并发组合子（join 状态全在 Lua，规避 wasm 重入） ----------

__JOINS = {}
__JOIN_NEXT = 1000000000   -- 与 JS 侧 token 数值空间隔离（pump 按整数查 join 表）

local function join_wake(jt)
  local j = __JOINS[jt]
  if j.waiter then
    __READY[#__READY + 1] = { id = j.waiter, okj = j.out_okj, ej = j.out_ej }
    j.waiter = nil
    __JOINS[jt] = nil
  end
  -- waiter 未登记（父尚未 await）：pump 登记时补交
end

-- finish() 调用：子任务结算（始终运行在 pump 的 Lua 帧内）
function __join_report(jt, idx, status, resultj, errj)
  local j = __JOINS[jt]
  if not j or j.done then return end
  if status == "done" then
    j.results[idx] = resultj ~= "" and resultj or "null"
    j.settled[idx] = "ok"
  elseif status == "cancelled" then
    j.settled[idx] = "cancelled"
  else
    j.settled[idx] = "error"
    j.err = errj ~= "" and errj or '{ "kind": "runtime.error" }'
  end
  if j.mode == "race" then
    if j.settled[idx] == "ok" or j.settled[idx] == "error" then
      j.done = true
      if j.settled[idx] == "error" then
        j.out_okj, j.out_ej = "", j.err
      else
        j.out_okj = '{"index":' .. idx .. ',"val":' .. j.results[idx] .. '}'
        j.out_ej = ""
      end
      join_wake(jt)
    end
    -- cancelled 分支：等首个真实完成（全 cancelled 由父自身的取消路径兜底）
  else
    if j.settled[idx] == "error" then
      j.done = true
      j.out_okj, j.out_ej = "", j.err      -- parallel：任一真实错误 => 重抛首错（其余由父级联取消）
      join_wake(jt)
      return
    end
    local all = true
    for i = 1, j.total do
      if j.settled[i] == nil then all = false break end
    end
    if all then
      j.done = true
      local parts = {}
      for i = 1, j.total do parts[i] = j.results[i] or "null" end
      j.out_okj = '{"results":[' .. table.concat(parts, ",") .. ']}'
      j.out_ej = ""
      join_wake(jt)
    end
  end
end

function race(fns)
  __JOIN_NEXT = __JOIN_NEXT + 1
  local jt = __JOIN_NEXT
  __JOINS[jt] = { mode = "race", total = #fns, results = {}, settled = {} }
  local parent = current_id()
  for i, f in ipairs(fns) do
    local t = new_task(f, "race#" .. i, nil, nil, parent)
    t.join = { token = jt, idx = i }
  end
  pump()
  local r = await(jt)              -- {index, val} 或在挂起点抛错
  return r and r.val
end

function parallel(fns)
  __JOIN_NEXT = __JOIN_NEXT + 1
  local jt = __JOIN_NEXT
  __JOINS[jt] = { mode = "parallel", total = #fns, results = {}, settled = {} }
  local parent = current_id()
  for i, f in ipairs(fns) do
    local t = new_task(f, "par#" .. i, nil, nil, parent)
    t.join = { token = jt, idx = i }
  end
  pump()
  local r = await(jt)              -- {results=[...]} 或抛首错
  return r and r.results
end

function with_timeout(d, fn)
  return race({ fn, function()
    time.sleep(d)
    error{ kind = "timeout", detail = "with_timeout 超时" }
  end })
end

function try(fn)
  local ok, e = pcall(fn)
  if ok then return true, nil end
  if is_cancel(e) then error(e, 0) end   -- 取消穿透（DESIGN §2.2 规则 6）
  return false, e
end

function guard(cond, fn)
  if not cond then
    if fn then pcall(fn) end
    error{ kind = "guard.failed" }
  end
end

-- ---------- wait_until / await_chat ----------

function wait_until(pred, opts)
  opts = opts or {}
  local poll = opts.poll or 100
  local deadline = opts.timeout and (__now() + opts.timeout) or nil
  while true do
    local ok, r = pcall(pred)
    if ok and r then return true end
    if deadline and __now() > deadline then
      error{ kind = "timeout", detail = "wait_until 超时" }
    end
    time.sleep(poll)
  end
end

-- ---------- params（统一参数） ----------

params = setmetatable({}, {
  __call = function(_, schema) __params_decl(encode(schema)) end,
  __index = function(_, k)
    local j = __param_get(k)
    if j == nil or j == "" then return nil end
    return decode(j)
  end,
  __newindex = function() error{ kind = "params.readonly", detail = "params 只能经控制总线修改" } end,
})

-- params 校验钩（TOB-522）：脚本对单个参数注册校验函数，控制总线 setParam 同步调用。
-- 约定：fn(value) -> true 通过；nil/false[, 消息] 或 error = 拒绝（消息回传调用方，旧值继续生效）。
__PARAM_VALIDATORS = {}

function params_validator(key, fn)
  if type(key) ~= "string" or key == "" or type(fn) ~= "function" then
    error{ kind = "params.validator_bad", detail = "params_validator(字符串 key, 校验函数)" }
  end
  __PARAM_VALIDATORS[key] = fn
end

-- 引擎侧入口：返回 "" = 通过，非空 = 拒绝理由
function __params_validate(key, valuej)
  local fn = __PARAM_VALIDATORS[key]
  if fn == nil then return "" end
  local ok, r1, r2 = pcall(fn, decode(valuej))
  if ok then
    if r1 == false or r1 == nil then return tostring(r2 or "参数校验失败") end
    return ""
  end
  if type(r1) == "table" then return tostring(r1.detail or r1.kind or "参数校验失败") end
  return tostring(r1)
end

-- ---------- persist（引擎 SQLite） ----------

persist = {}

__TXN_FLAG = false

function txn(fn)
  if __TXN_FLAG then return fn() end
  __TXN_FLAG = true
  __txn_begin()
  local ok, err = pcall(fn)
  if ok then __txn_commit() else __txn_rollback() end
  __TXN_FLAG = false
  if not ok then error(err, 0) end
end

function persist.seen(key, window_ms)
  return __persist_seen(key, math.floor(window_ms or 5000)) == 1
end

-- persist.table "Name" { schema } 语法 = 柯里化调用
function persist.table(name)
  return function(schema)
  __persist_table(name, encode(schema))
  local key_field, num_field
  for f, t in pairs(schema) do
    if tostring(t):find(":key", 1, true) then key_field = f end
    if tostring(t):gsub("%?", "") == "number" and not num_field then num_field = f end
  end
  local T = {}
  T.find = function(where) return call_query("__persist_find", { name = name, where = where or {} }) end
  T.all = function()
    local rows = call_query("__persist_all", { name = name }) or {}
    local i = 0
    return function() i = i + 1; return rows[i] end
  end
  T.upsert = function(row) __persist_upsert(name, encode(row)) end
  T.del = function(where) __persist_del(name, encode(where or {})) end
  T.adjust = function(key, delta)
    return call_query("__persist_adjust", { name = name, key = key, delta = delta,
                                            num_field = num_field, key_field = key_field })
  end
  -- 条件原子加减：协程单线程 + 同步原语（无挂起点）=> 读-判-写天然串行，双花不可能
  T.adjust_if = function(key, pred, delta)
    local row = T.find{ [key_field] = key }
    if not row then
      row = { [key_field] = key }
      for f, t in pairs(schema) do
        if tostring(t):gsub("%?", "") == "number" then row[f] = 0 end
      end
    end
    local okp, verdict = pcall(pred, row)
    if not okp then error(verdict, 0) end
    if not verdict then return false end
    row[num_field] = (row[num_field] or 0) + delta
    __persist_upsert(name, encode(row))
    return true
  end
  _G[name] = T
  end
end

function persist.kv(name)
  local K = {
    get = function(k)
      local j = __kv_get(name, k)
      if j == nil or j == "" then return nil end
      return decode(j)
    end,
    set = function(k, v) __kv_set(name, k, encode(v)) end,
  }
  _G[name] = K
end

function persist.log(name)
  __persist_log(name)
  local L = {
    append = function(fields) return call_query("__log_append", { name = name, fields = fields }) end,
    find = function(where) return call_query("__log_find", { name = name, where = where or {} }) or {} end,
    mark = function(id, state) __log_mark(name, id, state) end,
  }
  _G[name] = L
end

-- ---------- chat / rex / 命令声明 ----------

rex = setmetatable({}, { __call = function(_, pat) return __rex_new(pat) end })

chat = {}
function chat.say(text) return call_action("__act_chat_send", { text = text }) end
function chat.reply(m, text)
  if text == nil then
    return call_action("__act_chat_reply", { text = m })   -- 单参：公开回复
  end
  local to = type(m) == "table" and (m.sender or m.from) or m
  return call_action("__act_chat_reply", { to = to, text = text })
end
chat.msg = function(to, text) return call_action("__act_chat_reply", { to = to, text = text }) end
function chat.run_command(str) return call_action("__act_chat_send", { text = str }) end

local function rex_search(rid, msg)
  local m = __rex_match(rid, msg.text or "")
  if m ~= nil and m ~= "" then return m end
  return __rex_match(rid, msg.raw or "")
end

function on_chat(rexid, opts, fn)
  if type(opts) == "function" then fn = opts; opts = nil end
  __CHAT_HANDLERS[#__CHAT_HANDLERS + 1] = { rexid = rexid, opts = opts or {}, fn = fn }
end

function chat.await_chat(rexid, timeout)
  local tok = __new_waiter(encode({ timeout = timeout or 5000 }))
  __AWAITERS[#__AWAITERS + 1] = { rexid = rexid, token = tok }
  return await(tok)   -- 命中: {<命名分组>...}；超时: nil
end
await_chat = chat.await_chat

function __chat_pipeline(msg)
  -- 1) await_chat 等待者（独立广播，不吞消息）
  for _, w in ipairs(__AWAITERS) do
    local m = rex_search(w.rexid, msg)
    if m and m ~= "" then
      __resolve_waiter(w.token, m)
      w.hit = true
    end
  end
  for i = #__AWAITERS, 1, -1 do
    if __AWAITERS[i].hit then table.remove(__AWAITERS, i) end
  end
  -- 2) on_chat 处理器（可多命中）
  for _, h in ipairs(__CHAT_HANDLERS) do
    local o = h.opts
    if (not o.source or o.source == msg.sender_kind)
       and (not o.from or o.from == msg.sender) then
      local m = rex_search(h.rexid, msg)
      if m and m ~= "" then
        local payload = decode(m)
        payload.text = msg.text
        payload.raw = msg.raw
        payload.sender = msg.sender
        payload.sender_kind = msg.sender_kind
        payload.ts = msg.ts
        task.spawn_detached(h.fn, payload)
      end
    end
  end
end

function on_command(pattern, opts, fn)
  if type(opts) == "function" then fn = opts; opts = nil end
  local index = #__COMMANDS + 1
  __COMMANDS[index] = { pattern = pattern, opts = opts or {}, fn = fn }
  __command_register(encode({ pattern = pattern, perm = (opts and opts.perm) or nil, index = index }))
end

-- ---------- time / log ----------

time = {
  sleep = function(d) await(__sleep_register(encode({ ms = d }))) end,
  now = function() return __now() end,
}

log = {
  info = function(...) __log("info", string.format(...)) end,
  warn = function(...) __log("warn", string.format(...)) end,
  error = function(...) __log("error", string.format(...)) end,
}

-- ---------- events（平台事件入站；控制通道 /event → events.next） ----------
-- 控制面经 agent 代理 POST /event {type, data} 注入；脚本事件循环 events.next 取走。
-- 返回 {type, data, ts}；超时返回 nil（脚本可循环长等）。
events = {}
function events.next(timeout)
  local tok = __evt_next(encode({ timeout = timeout or 30000 }))
  return await(tok)
end

-- 上行：脚本 → 宿主（进入实时流 event 通道，宿主决定转发/丢弃/落库）。
-- 非阻塞、无返回数据；data 必须是 table（JSON 编码后经宿主通道送出）。
function events.emit(type, data)
  if type == nil then error({ error = "event.bad_request", detail = "type 必填" }, 0) end
  return __evt_emit(encode({ type = tostring(type), data = data or {} }))
end

-- ---------- 实体句柄（活读：动态字段每次访问穿透到最新缓存） ----------

local function snap_of(id)
  if id == nil then return nil end
  local j = __q_entity_snap(encode({ id = id }))
  if j == nil or j == "" then return nil end
  return decode(j)
end

local ent_mt = {
  __index = function(e, k)
    local id = rawget(e, "__id")
    if k == "id" then return id end
    if k == "snapshot" then
      return function()
        local s = snap_of(id)
        if not s then return nil end
        local copy = {}
        for kk, vv in pairs(s) do copy[kk] = vv end
        return copy
      end
    end
    if k == "exists" then return function() return snap_of(id) ~= nil end end
    local s = snap_of(id)
    if not s then return nil end
    return s[k]
  end,
}

local function make_entity(id) return setmetatable({ __id = id }, ent_mt) end

entity = {
  exists = function(e) return snap_of(type(e) == "table" and (rawget(e, "__id") or e.id) or e) ~= nil end,
}

local function self_pos()
  local sp = call_query("__q_self", {})
  return sp and sp.pos or nil
end

local function within_ok(s, pred)
  if not pred or not pred.within then return true end
  if not s.pos then return false end
  local sp = self_pos()
  if not sp then return false end
  local dx, dy, dz = s.pos.x - sp.x, s.pos.y - sp.y, s.pos.z - sp.z
  return math.sqrt(dx * dx + dy * dy + dz * dz) <= pred.within
end

local function pred_match(s, pred)
  if not pred then return true end
  if type(pred) == "function" then
    local ok, r = pcall(pred, s)
    return ok and r or false
  end
  if pred.type and s.type ~= pred.type then return false end
  if pred.name and s.name ~= pred.name then return false end
  if pred.uuid and s.uuid ~= pred.uuid then return false end
  if pred.alive ~= nil and s.alive ~= pred.alive then return false end
  if pred.holding then
    local h = s.equipment and s.equipment.hand
    if not (h and h.id == pred.holding) then return false end
  end
  if pred.region then
    local p, r = s.pos, pred.region
    if not p then return false end
    local x1, x2 = math.min(r[1].x, r[2].x), math.max(r[1].x, r[2].x)
    local y1, y2 = math.min(r[1].y, r[2].y), math.max(r[1].y, r[2].y)
    local z1, z2 = math.min(r[1].z, r[2].z), math.max(r[1].z, r[2].z)
    if p.x < x1 or p.x > x2 or p.y < y1 or p.y > y2 or p.z < z1 or p.z > z2 then return false end
  end
  return true
end

function entity.find(pred)
  local list = call_query("__q_entities", {}) or {}
  local out = {}
  for _, s in ipairs(list) do
    if within_ok(s, pred) and pred_match(s, pred) then
      out[#out + 1] = make_entity(s.id)
    end
  end
  return out
end

function entity.nearest(pred)
  local list = call_query("__q_entities", {}) or {}
  local sp = self_pos()
  local best, bd
  for _, s in ipairs(list) do
    if within_ok(s, pred) and pred_match(s, pred) and s.pos then
      local d
      if sp then
        local dx, dy, dz = s.pos.x - sp.x, s.pos.y - sp.y, s.pos.z - sp.z
        d = dx * dx + dy * dy + dz * dz
      end
      if not bd or (d and d < bd) then best, bd = s, d or 0 end
    end
  end
  return best and make_entity(best.id) or nil
end

-- ---------- world ----------

world = {
  block = function(pos)
    local j = __q_block(encode({ pos = pos }))
    return decode(j or "{}")     -- 未知方块 => 空表（.name == nil）
  end,
  scan = function(region, pred, opts)
    local r = call_action("__act_world_scan", { region = region, pred = pred, opts = opts })
    return (r and r.list) or {}
  end,
  staleness = function(pos) return call_query("__q_staleness", { pos = pos }) or -1 end,
  dimension = function() return call_query("__q_dimension", {}) end,
  time_of_day = function() return call_query("__q_time_of_day", {}) end,
  weather = function() return call_query("__q_weather", {}) end,
}

-- ---------- nav / look ----------

nav = {
  -- 命名 walk 而非 goto：goto 是 Lua 保留字，点号访问（nav.goto）是语法错误
  walk = function(target, opts) return call_action("__act_nav_goto", { target = target, opts = opts }) end,
  goto_near = function(pos, radius, opts)
    opts = opts or {}
    opts.arrive = radius or opts.arrive
    return nav.walk(pos, opts)
  end,
  follow = function(e, opts)
    local id = type(e) == "table" and (rawget(e, "__id") or e.id) or e
    return call_action("__act_nav_follow", { entity_id = id, opts = opts })
  end,
  stop = function() return call_action("__act_nav_stop", {}) end,
  flee = function(pos, opts) return call_action("__act_nav_goto", { target = pos, opts = opts or { arrive = 2 } }) end,
  distance_to = function(t)
    local pos = type(t) == "table" and (t.pos or t) or t
    if type(pos) ~= "table" or pos.x == nil then return nil end
    return call_query("__q_distance", { pos = pos })
  end,
  can_reach = function(pos) return call_query("__q_can_reach", { pos = pos }) == true end,
  hop = function() return call_action("__act_hop", {}) end,
}

look = {
  yaw = function(a) __fire_token(__act_rot(encode({ yaw = a }), 0)) end,
  pitch = function(a) __fire_token(__act_rot(encode({ pitch = a }), 0)) end,
  -- 一次写完两轴：原版客户端每 tick 最多发一个 looking 包，分两次调用会翻倍发包频率，
  -- 高频循环（如 20Hz 瞄准）下服务器会以 multiplayer.disconnect.invalid_player_movement 踢人。
  -- 只在需要的轴存在时才带上对应键（nil 轴 = 不动该轴）。
  aim = function(y, p)
    local t = {}
    if y ~= nil then t.yaw = y end
    if p ~= nil then t.pitch = p end
    __fire_token(__act_rot(encode(t), 0))
  end,
  current = function() return call_query("__q_look", {}) or { yaw = 0, pitch = 0 } end,
}

-- ---------- container / 窗口句柄 ----------

function item_match(item, filter)
  if type(filter) == "function" then
    local ok, r = pcall(filter, item)
    return ok and r or false
  end
  if not filter then return true end
  if filter.id and item.id ~= filter.id then return false end
  if filter.count and (item.count or 0) < filter.count then return false end
  return true
end

local function win_snap(id) return call_query("__q_window", { window = id }) end

local win_mt = {
  __index = function(w, k)
    local id = rawget(w, "__win")
    -- 兼容冒号/点两种调用：win:click(s, o) 与 win.click(s, o)（bslib 用点、脚本可用冒号）
    local function split(a, b, c)
      if type(a) == "table" and rawget(a, "__win") ~= nil then return a, b, c end
      return nil, a, b, c
    end
    local click = function(slot, button, mode)
      return call_action("__act_window_click", { window = id, slot = slot, button = button, mode = mode })
    end
    if k == "click" then
      return function(a, b, c)
        local _, slot, opts = split(a, b, c)
        opts = opts or {}
        return click(slot, opts.button == "right" and 1 or 0, opts.shift and 1 or 0)
      end
    elseif k == "click_hotbar" then
      return function(a, b, c)
        local _, slot, n = split(a, b, c)
        return click(slot, (n or 1) - 1, 2)
      end
    elseif k == "drop_slot" then
      return function(a, b, c)
        local _, slot, opts = split(a, b, c)
        opts = opts or {}
        return click(slot, opts.all and 1 or 0, 4)
      end
    elseif k == "drop_cursor" then
      return function(a, b, c)
        local _, opts = split(a, b, c)
        opts = opts or {}
        return click(-999, opts.all and 1 or 0, 4)
      end
    elseif k == "swap_offhand" then
      return function(a, b, c)
        local _, slot = split(a, b, c)
        return click(slot, 40, 2)
      end
    elseif k == "cursor" then
      return function() local s = win_snap(id); return s and s.cursor or nil end
    elseif k == "type" then
      return function() local s = win_snap(id); return s and s.type or "custom" end
    elseif k == "title" then
      return function() local s = win_snap(id); return s and s.title or "" end
    elseif k == "size" then
      return function() local s = win_snap(id); return s and s.size or 0 end
    elseif k == "slots" then
      return function()
        local s = win_snap(id)
        local out = {}
        if s and s.slots then
          for _, sl in ipairs(s.slots) do out[#out + 1] = { index = sl.index, item = sl.item } end
        end
        return out
      end
    elseif k == "peek" then
      return function(a, b, c)
        local _, i = split(a, b, c)
        local s = win_snap(id)
        if s and s.slots then
          for _, sl in ipairs(s.slots) do
            if sl.index == i then return sl.item end
          end
        end
        return nil
      end
    elseif k == "count" then
      return function(a, b, c)
        local _, filter = split(a, b, c)
        local s = win_snap(id)
        local n = 0
        if s and s.slots then
          for _, sl in ipairs(s.slots) do
            if sl.item and item_match(sl.item, filter) then n = n + (sl.item.count or 0) end
          end
        end
        return n
      end
    elseif k == "find" then
      return function(a, b, c)
        local _, filter = split(a, b, c)
        local s = win_snap(id)
        if s and s.slots then
          for _, sl in ipairs(s.slots) do
            if sl.item and item_match(sl.item, filter) then return sl.index end
          end
        end
        return nil
      end
    end
    return nil
  end,
}

local function make_win(id) return setmetatable({ __win = id }, win_mt) end

container = {
  open = function(target)
    local r = call_action("__act_container_open", { target = target })
    return r and make_win(r.id) or nil
  end,
  close = function(w)
    return call_action("__act_container_close", { window = type(w) == "table" and rawget(w, "__win") or w })
  end,
  current = function()
    local id = call_query("__q_current_window", {})
    return id and make_win(id) or nil
  end,
}

-- ---------- inv（背包；容器打开时引擎合并视图 + 槽位翻译） ----------

inv = {
  count = function(filter)
    local s = win_snap("0")
    local n = 0
    if s and s.slots then
      for _, sl in ipairs(s.slots) do
        if sl.item and sl.index <= 35 and item_match(sl.item, filter) then n = n + (sl.item.count or 0) end
      end
    end
    return n
  end,
  has = function(filter) return inv.count(filter) > 0 end,
  find = function(filter)
    local s = win_snap("0")
    if s and s.slots then
      for _, sl in ipairs(s.slots) do
        if sl.item and sl.index <= 35 and item_match(sl.item, filter) then return sl.index end
      end
    end
    return nil
  end,
  slots = function()
    local s = win_snap("0")
    return (s and s.slots) or {}
  end,
  held = function()
    local s = call_query("__q_self", {})
    return s and s.held or nil
  end,
  click = function(slot, opts)
    opts = opts or {}
    return call_action("__act_window_click", {
      window = "0", slot = slot,
      button = opts.mode == 4 and (opts.button == 1 and 1 or (opts.button and 1 or 0)) or (opts.button == "right" and 1 or 0),
      mode = opts.mode or (opts.shift and 1 or 0),
    })
  end,
  cursor = function()
    local s = win_snap("0")
    return s and s.cursor or nil
  end,
  equip = function(slot_or_filter)
    return call_action("__act_inv_equip", { slot = slot_or_filter })
  end,
  drop = function(filter, count) return call_action("__act_inv_drop", { filter = filter, count = count }) end,
}

-- ---------- combat / self / session / caps / data ----------

combat = {
  attack = function(e) return call_action("__act_use_entity", { id = rawget(e, "__id") or e.id, kind = "attack" }) end,
  interact_entity = function(e) return call_action("__act_use_entity", { id = rawget(e, "__id") or e.id, kind = "interact" }) end,
  range = function() return 3.0 end,
  cooldown = function() return call_query("__q_cooldown", {}) or 0 end,
  use_block = function(pos, opts) return call_action("__act_use_block", { pos = pos, opts = opts }) end,
  use_item = function(duration) return call_action("__act_use_item", { duration = duration }) end,
  dig = function(pos) return call_action("__act_dig", { pos = pos }) end,
  place = function(pos, item) return call_action("__act_use_block", { pos = pos, place = item }) end,
}

self = {
  username = function() local s = call_query("__q_self", {}); return s and s.username or nil end,
  pos = function() local s = call_query("__q_self", {}); return s and s.pos or nil end,
  health = function() local s = call_query("__q_self", {}); return s and s.health or nil end,
  food = function() local s = call_query("__q_self", {}); return s and s.food or nil end,
  held = function() local s = call_query("__q_self", {}); return s and s.held or nil end,
  gamemode = function() local s = call_query("__q_self", {}); return s and s.gamemode or nil end,
  effects = function() local s = call_query("__q_self", {}); return s and s.effects or nil end,
}

session = {
  state = function() return call_query("__q_session_state", {}) end,
  info = function() return call_query("__q_session_info", {}) end,
}

caps = {
  has = function(flag) return call_query("__q_caps", { flag = flag }) == true end,
  server_version = function() return call_query("__q_server_version", {}) end,
}

data = {
  stack_size = function(id) return call_query("__q_stack_size", { id = id }) or 64 end,
  weapon_score = function(id) return call_query("__q_weapon_score", { id = id }) end,
}
