-- ============================================================
-- runtime/lua/core/bootstrap.lua — 核心调度器（唯一源码，Node/Fabric 共用）
--
-- yield 协议：任务体在挂起点 yield "<token>, 0"
--   宿主对每个挂起点调用 bridge.token.bind(task_id, token, kind) 登记；
--   结算经 __core_resume(id, resultJson, ctlJson) 交付：
--     resultJson = {ok:true,value:...} | {ok:false,error:{code,message}}——所有确定性结果；
--     ctlJson    = {cancel:"<source>"} | {fail:{kind,detail}}——取消/内部任务失败，独立于 Result。
--   宿主绝不把 JS 异常/栈传进 Lua；意外异常只记宿主日志，Lua 侧只会看到稳定的 internal 码。
-- 宿主入口（由宿主实现，见 contracts/host-abi.yaml）：
--   __host_q(op, argsJson)      核心→宿主同步查询
--   __host_a(op, argsJson)      核心→宿主异步动作（返回 token）
--   __core_call(op, argsJson)   宿主→核心同步调用（返回 {ok,result}|{ok=false,error} 信封）
--   __core_event(kind, json)    宿主→核心事件
--
-- 本文件不再出现任何桥名字符串：一切跨界经 bridge（runtime/lua/core/bridge.generated.lua）。
-- LuaJ 兼容补丁在 runtime/lua/compat/luaj.lua（仅 Fabric 加载）。
-- ============================================================

local json = require "json"
local bridge = require "bridge"

local raw_tostring = tostring

__T = {}              -- taskid -> task record
__T_NEXT = 0
__READY = {}          -- 调度队列 {id, okj, ej, drop}
__TASK_ERR = {}       -- LuaJ 兼容：任务体未捕获错误经此旁路带出（见 new_task）
__CHAT_HANDLERS = {}
__EVENT_HANDLERS = {}
__NET_HANDLERS = {}   -- channel -> handlers（net.on；"*" = 全部通道）
__AWAITERS = {}       -- await_chat {rexid, token}
__DECL = { tasks = {}, timers = {}, afters = {} }
__LIFE = {}
__CLEANUP_FLAG = {}   -- taskid -> true（on_cancel 清理中：动作改 fire-and-forget）
__IN_CLEANUP = false
-- 帧编号：每次宿主交互（await 返回 / 事件 / resume）自增。
-- 实体句柄与 self 快照在同帧内复用，跨帧至多刷新一次（PERF-REFACTOR §3.3）。
__EPOCH = 0
__SELF = nil
__SELF_EPOCH = -1
__YIELD_COUNT = 0     -- 挂起点计数：state.update 用来判定回调是否发生挂起

local TASK_ERR_BYPASS = __COMPAT_TASK_ERR == true   -- LuaJ 由 compat/luaj.lua 置真

local function encode(v) return json.encode(v) end
local function decode(j) return json.decode(j) end

local function is_cancel(e)
  return type(e) == "table" and (e.__cancel == true or e.kind == "task.cancelled")
end
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

-- ---------- base64（二进制载荷跨 JSON 边界；Node/Fabric 共用） ----------
-- JSON 只安全携带文本；custom payload 是原始字节。Lua 侧统一在边界处转 base64，
-- 脚本看到的仍是原始字节串（net.send 入参 / net.payload 事件载荷）。
local B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local B64_DIGITS = {}
for _i = 1, #B64_ALPHABET do B64_DIGITS[B64_ALPHABET:sub(_i, _i)] = _i - 1 end

local function b64_encode(s)
  local out = {}
  local n = #s
  local i = 1
  while i <= n do
    local a = s:byte(i)
    local b = (i + 1 <= n) and s:byte(i + 1) or nil
    local c = (i + 2 <= n) and s:byte(i + 2) or nil
    local v = a * 65536 + (b or 0) * 256 + (c or 0)
    local c1 = math.floor(v / 262144) % 64
    local c2 = math.floor(v / 4096) % 64
    local c3 = math.floor(v / 64) % 64
    local c4 = v % 64
    out[#out + 1] = B64_ALPHABET:sub(c1 + 1, c1 + 1) .. B64_ALPHABET:sub(c2 + 1, c2 + 1)
    out[#out + 1] = b and B64_ALPHABET:sub(c3 + 1, c3 + 1) or "="
    out[#out + 1] = c and B64_ALPHABET:sub(c4 + 1, c4 + 1) or "="
    i = i + 3
  end
  return table.concat(out)
end

local function b64_decode(s)
  if type(s) ~= "string" then return "" end
  s = s:gsub("[%s=]", "")
  local n = #s
  if n == 0 then return "" end
  if n % 4 == 1 then error({ kind = "net.bad_payload", detail = "非法 base64（长度 " .. n .. "）" }, 0) end
  local out = {}
  local i = 1
  while i <= n do
    local d1 = B64_DIGITS[s:sub(i, i)]
    local d2 = B64_DIGITS[s:sub(i + 1, i + 1)]
    local d3 = B64_DIGITS[s:sub(i + 2, i + 2)]
    local d4 = B64_DIGITS[s:sub(i + 3, i + 3)]
    if d1 == nil or d2 == nil then
      error({ kind = "net.bad_payload", detail = "非法 base64（偏移 " .. i .. "）" }, 0)
    end
    local v = d1 * 262144 + d2 * 4096 + (d3 or 0) * 64 + (d4 or 0)
    out[#out + 1] = string.char(math.floor(v / 65536) % 256)
    if d3 ~= nil then out[#out + 1] = string.char(math.floor(v / 256) % 256) end
    if d4 ~= nil then out[#out + 1] = string.char(v % 256) end
    i = i + 4
  end
  return table.concat(out)
end

-- ---------- await / 动作调用 ----------

local function current_id()
  local co = coroutine.running()
  for id, t in pairs(__T) do
    if t.co == co then return id end
  end
  return nil
end

-- 动作 await：始终返回 Result（{ok,value} | {ok=false,error={code,message}}），不向脚本抛错。
-- 取消/内部任务失败走独立控制通道：取消 => 展开当前任务；内部失败 => 按任务级失败处理。
local function await(token)
  __YIELD_COUNT = __YIELD_COUNT + 1
  local resultj, ctlj = coroutine.yield(token, 0)
  __EPOCH = __EPOCH + 1   -- 挂起点返回 = 新的一帧：句柄/self 快照失效
  if ctlj ~= nil and ctlj ~= "" then
    local c = decode(ctlj)
    if type(c) ~= "table" then error({ kind = "runtime.error", detail = raw_tostring(c) }, 0) end
    if c.cancel ~= nil or c.kind == "task.cancelled" then
      error({ __cancel = true, kind = "task.cancelled", source = c.cancel or c.source }, 0)
    end
    local f = c.fail
    if type(f) == "table" and f.kind then error(f, 0) end
    if c.kind ~= nil then error(c, 0) end   -- 兼容尚未迁移的宿主错误帧
    error({ kind = "runtime.error", detail = raw_tostring(f) }, 0)
  end
  local r = (resultj ~= nil and resultj ~= "") and decode(resultj) or nil
  if type(r) ~= "table" or r.ok == nil then return { ok = true, value = r } end
  return r
end

-- 兼容壳（旧测试/旧包经 _G 直接调用）：真实动作一律走 bridge.a（同一 dispatch：
-- 策略/速率/预算/审计唯一入口）。参数是 ABI op 名（act.chat_send 等）。
function _G.call_action(op, args)
  local id = current_id() or 0
  local tok = bridge.a(op, args)
  if __IN_CLEANUP or __CLEANUP_FLAG[id] then
    bridge.token.detach(tok)   -- 清理钩中的动作：fire-and-forget（钩子运行在 pump 上下文，不可挂起）
    return { ok = true, value = nil, detached = true }
  end
  return await(tok)
end

local function call_action(op, args) return _G.call_action(op, args) end

-- 同步 ABI 也返回 Result；核心内部取纯数据用该 helper 解包（失败 -> default，不抛错）
local function rv(r, default)
  if type(r) == "table" and r.ok == true then return r.value end
  return default
end
local function call_query(op, args)
  local r = bridge.q(op, args)
  if type(r) ~= "table" or r.ok == nil then return r end
  if r.ok then return r.value end
  return nil
end

-- 供可选库与用户脚本复用的挂起/脱离原语
function __await(tok) return await(tok) end
function __detach(tok) bridge.token.detach(tok) end

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
      if not okr then bridge.log("error", "on_error handler 出错: " .. errstr(r)) end
    end
    bridge.log("error", "任务 [" .. (t.decl_name or t.name) .. "] 失败: " .. errstr(e))
  end
  -- 结束的任务从台账删除：事件处理器按消息 spawn，长期不清理会让 __T 只增不减
  __T[t.id] = nil
end

local function run_cancel_hooks(t)
  __IN_CLEANUP = true
  __CLEANUP_FLAG[t.id] = true
  for _, fn in ipairs(t.cancel_hooks) do
    local okr, r = pcall(fn)
    if not okr then bridge.log("warn", "on_cancel 清理钩出错: " .. errstr(r)) end
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
          -- LuaJ：table 错误穿过 coroutine.resume 会被字符串化；真实错误经 __TASK_ERR 带出。
          local terr = __TASK_ERR[t.id]
          __TASK_ERR[t.id] = nil
          if okr and terr == nil then
            t.result = r1
            finish(t, true)
          else
            finish(t, false, terr ~= nil and terr or r1)
          end
        else
          t.status = "suspended"
          local tok = tonumber(r1)
          if not tok then
            finish(t, false, "bad yield descriptor: " .. raw_tostring(r1))
          elseif __JOINS[tok] then
            -- join 等待：纯 Lua 登记/补交（宿主不可重入）
            local j = __JOINS[tok]
            if j.out_okj then
              __READY[#__READY + 1] = { id = t.id, okj = j.out_okj, ej = j.out_ej }
              __JOINS[tok] = nil
            else
              j.waiter = t.id
            end
          else
            bridge.token.bind(t.id, tok, "a")
          end
        end
      end
      -- 其余状态：陈旧交付，丢弃
    end
  end
end

local function new_task(fn, name, decl_name, opts, parent)
  __T_NEXT = __T_NEXT + 1
  local id = __T_NEXT
  local body = fn
  if TASK_ERR_BYPASS then
    -- LuaJ 兼容：任务体整体 pcall，未捕获错误（含类型化 table）经 __TASK_ERR 旁路带出，
    -- pump 在任务死亡时读回 => finish 拿到的仍是原始 table（is_cancel / on_error 依赖它）。
    -- 注意必须转发首个返回值：race/parallel 依赖子任务的返回值（finish 的 t.result）。
    body = function(...)
      local okr, r1 = pcall(fn, ...)
      if not okr then __TASK_ERR[id] = r1 end
      return r1
    end
  end
  local t = {
    id = id,
    co = coroutine.create(body),
    name = name or ("anon#" .. __T_NEXT),
    decl_name = decl_name,
    opts = opts or {},
    parent = parent,
    status = "ready",
    cancel_hooks = {},
    progress = 0,
  }
  __T[id] = t
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
          bridge.log("warn", "任务 [" .. name_or_fn .. "] 防重入：丢弃本次触发")
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
  bridge.log("info", "任务 [" .. (t.decl_name or t.name) .. "] 取消（" .. source .. "）")
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

function __tasks_list()
  local out = {}
  for _, t in pairs(__T) do
    if t.status == "ready" or t.status == "suspended" then
      out[#out + 1] = { id = t.id, name = t.decl_name or t.name, status = t.status, progress = t.progress or 0 }
    end
  end
  return out
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

function __tasks_cancel(name)
  for _, t in pairs(__T) do
    if (t.decl_name == name or t.name == name)
        and (t.status == "ready" or t.status == "suspended") then
      return { ok = task.cancel(t.id, "control"), found = true }
    end
  end
  return { ok = false, found = false }
end

function task.progress(delta)
  local id = current_id()
  if id then __T[id].progress = (__T[id].progress or 0) + delta end
end

function on_cancel(fn)
  local id = current_id()
  if id then table.insert(__T[id].cancel_hooks, fn) end
end

-- JS => Lua：挂起点交付（pause 门控由宿主保证：pause 期间不进来）
-- wasmoon 的 JS->Lua 调用是无保护 lua_callk：顶层 Lua 错误会 wasm abort。
-- 所有入口必须内部 pcall，把错误降级为日志。
function __core_resume(id, okj, ej)
  local ok, err = pcall(__core_resume_inner, id, okj, ej)
  if not ok then bridge.log("error", "resume panic: " .. errstr(err)) end
end

function __core_resume_inner(id, okj, ej)
  __READY[#__READY + 1] = { id = id, okj = okj, ej = ej }
  pump()
end

-- JS => Lua：事件/定时器/命令/生命周期分发（同 __core_resume：内部 pcall 防 wasm abort）
function __core_event(kind, j)
  local ok, err = pcall(__core_event_inner, kind, j)
  if not ok then bridge.log("error", "event panic (" .. raw_tostring(kind) .. "): " .. errstr(err)) end
end

-- 自定义网络包入站：data_b64 -> 原始字节串，再分发给 net.on(channel) 与 on_event("net.payload")
local function __net_payload(p)
  if type(p) ~= "table" then return end
  local raw = ""
  if type(p.data_b64) == "string" and #p.data_b64 > 0 then
    raw = b64_decode(p.data_b64)
  end
  local payload = { channel = p.channel, data = raw, ts = p.ts }
  for _, h in ipairs(__NET_HANDLERS[p.channel] or {}) do
    task.spawn_detached(h.fn, payload)
  end
  for _, h in ipairs(__NET_HANDLERS["*"] or {}) do
    task.spawn_detached(h.fn, payload)
  end
  for _, h in ipairs(__EVENT_HANDLERS["net.payload"] or {}) do
    task.spawn_detached(h.fn, payload)
  end
end

function __core_event_inner(kind, j)
  __EPOCH = __EPOCH + 1   -- 事件到达 = 新的一帧
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
  elseif kind == "net.payload" then
    __net_payload(p)
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

-- 宿主查询：脚本已注册 on_event 的事件名（宿主据此门控高频世界事件：entity.appeared /
-- entity.gone / world.block_changed。没有消费者时不做 JSON/WASM 往返）。
function __core_event_kinds()
  local list = {}
  for k in pairs(__EVENT_HANDLERS) do list[#list + 1] = k end
  return json.encode(list)
end

-- 宿主查询：是否存在网络包处理器（net.on 任意频道，或 on_event("net.payload")）
function __core_net_handlers()
  for _ in pairs(__NET_HANDLERS) do return true end
  local eh = __EVENT_HANDLERS["net.payload"]
  return eh ~= nil and #eh > 0
end

function on_start(fn) __LIFE.on_start = __LIFE.on_start or {}; table.insert(__LIFE.on_start, fn) end
function on_pause(fn) __LIFE.on_pause = __LIFE.on_pause or {}; table.insert(__LIFE.on_pause, fn) end
function on_resume(fn) __LIFE.on_resume = __LIFE.on_resume or {}; table.insert(__LIFE.on_resume, fn) end
function on_error(fn) __LIFE.on_error = __LIFE.on_error or {}; table.insert(__LIFE.on_error, fn) end

function on_timer(interval, fn)
  local id = rv(bridge.timer.interval(interval), 0)
  __DECL.timers[id] = { fn = fn, interval = interval }
end

function after(d, fn)
  local id = rv(bridge.timer.after(d), 0)
  __DECL.afters[id] = fn
end

-- ---------- 结构化并发组合子（join 状态全在 Lua，规避宿主重入） ----------

__JOINS = {}
__JOIN_NEXT = 1000000000   -- 与宿主 token 数值空间隔离（pump 按整数查 join 表）

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
        j.out_okj, j.out_ej = "", '{"fail":' .. (j.err ~= "" and j.err or '{"kind":"runtime.error"}') .. '}'
      else
        j.out_okj = '{"ok":true,"value":{"index":' .. idx .. ',"val":' .. j.results[idx] .. '}}'
        j.out_ej = ""
      end
      join_wake(jt)
    end
    -- cancelled 分支：等首个真实完成（全 cancelled 由父自身的取消路径兜底）
  else
    if j.settled[idx] == "error" then
      j.done = true
      -- parallel：任一真实任务失败 => 控制通道 fail（Lua 原生错误，任务级失败；其余由父级联取消）
      j.out_okj, j.out_ej = "", '{"fail":' .. (j.err ~= "" and j.err or '{"kind":"runtime.error"}') .. '}'
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
      j.out_okj = '{"ok":true,"value":{"results":[' .. table.concat(parts, ",") .. ']}}'
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
  local r = await(jt)              -- {ok:true,value={index,val}}；真实任务失败走控制通道
  return r and r.value and r.value.val
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
  local r = await(jt)              -- {ok:true,value={results=[...]}}
  return r and r.value and r.value.results
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
  local deadline = opts.timeout and (rv(bridge.util.now(), 0) + opts.timeout) or nil
  while true do
    local ok, r = pcall(pred)
    if ok and r then return true end
    if deadline and rv(bridge.util.now(), 0) > deadline then
      error{ kind = "timeout", detail = "wait_until 超时" }
    end
    time.sleep(poll)
  end
end

-- ---------- params（schema 只来自 bot.yaml；核心不再接受 params{...} 声明） ----------

__PARAM_SCHEMA = {}
__PARAM_VALUES = {}

local function coerce_param(v, t)
  if t == "blockpos" then
    if type(v) == "table" and v[1] ~= nil then return { x = v[1], y = v[2], z = v[3] } end
    return v
  elseif t == "region" then
    if type(v) == "table" and type(v[1]) == "table" and v[1][1] ~= nil then
      return { { x = v[1][1], y = v[1][2], z = v[1][3] },
               { x = v[2][1], y = v[2][2], z = v[2][3] } }
    end
    return v
  elseif t == "list<blockpos>" then
    local out = {}
    for i, p in ipairs(v or {}) do
      if type(p) == "table" and p[1] ~= nil then out[i] = { x = p[1], y = p[2], z = p[3] }
      else out[i] = p end
    end
    return out
  end
  return v
end

params = setmetatable({}, {
  __index = function(_, k) return __PARAM_VALUES[k] end,
  __newindex = function() error{ kind = "params.readonly", detail = "params 只能经控制总线修改" } end,
})

-- params 校验钩：脚本对单个参数注册校验函数，控制总线 setParam 同步调用。
-- 约定：fn(value) -> true 通过；nil/false[, 消息] 或 error = 拒绝（消息回传调用方，旧值继续生效）。
__PARAM_VALIDATORS = {}

function params_validator(key, fn)
  if type(key) ~= "string" or key == "" or type(fn) ~= "function" then
    error{ kind = "params.validator_bad", detail = "params_validator(字符串 key, 校验函数)" }
  end
  __PARAM_VALIDATORS[key] = fn
end

-- 兼容入口（旧宿主直接调用）：返回 "" = 通过，非空 = 拒绝理由
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

local function params_bind(manifest, instance)
  __PARAM_SCHEMA = {}
  local values = {}
  for k, entry in pairs(manifest or {}) do
    if type(entry) ~= "table" or entry.type == nil then
      bridge.log("warn", "参数 " .. k .. " 声明缺少 type（bot.yaml 参数必须是 schema 对象），已忽略")
    else
      __PARAM_SCHEMA[k] = entry
      if entry.default ~= nil then values[k] = entry.default end
    end
  end
  for k, v in pairs(instance or {}) do values[k] = v end
  for k, schema in pairs(__PARAM_SCHEMA) do
    local v = values[k]
    if v == nil then v = schema.default end
    if v == nil then
      if schema.required then
        bridge.log("warn", "参数 " .. k .. " 必填：暂未设置（运行期经控制渠道设置）")
      end
    else
      values[k] = coerce_param(v, schema.type)
    end
  end
  __PARAM_VALUES = values
  return { schema = __PARAM_SCHEMA, values = __PARAM_VALUES }
end

local function params_set(k, v)
  local schema = __PARAM_SCHEMA[k]
  if schema == nil then error({ kind = "param.unknown", detail = k }, 0) end
  local coerced = coerce_param(v, schema.type)
  local fn = __PARAM_VALIDATORS[k]
  if fn ~= nil then
    local ok, r1, r2 = pcall(fn, coerced)
    if not ok then
      error({ kind = "param.rejected", detail = k .. ": " .. errstr(r1) }, 0)
    elseif r1 == false or r1 == nil then
      error({ kind = "param.rejected", detail = k .. ": " .. tostring(r2 or "参数校验失败") }, 0)
    end
  end
  __PARAM_VALUES[k] = coerced
  bridge.log("info", "param " .. k .. " = " .. encode(coerced))
  return { ok = true, value = coerced }
end

-- ---------- state（实例级 localStorage 语义；固定路径由宿主管理，包无权指定） ----------
-- key -> JSON value；无 schema/查询/多键事务。配额与落盘由宿主实现：
-- 单值 ≤16KB、总量 ≤256KB；超限以 state.quota 拒绝（不静默淘汰）。

state = {}

function state.get(key, default)
  local v = rv(bridge.state.get(tostring(key)), nil)
  if v == nil then return default end
  return v
end

function state.all()
  return rv(bridge.state.all(), {}) or {}
end

function state.set(key, value)
  return bridge.state.set(tostring(key), value)
end

function state.delete(key)
  return bridge.state.delete(tostring(key))
end

--- 原子读改写：fn(旧值) 返回新值。回调内禁止挂起点（挂起会被拒绝且不写入）。
function state.update(key, fn)
  if type(fn) ~= "function" then
    error({ kind = "state.bad_request", detail = "state.update 的第二个参数必须是函数" }, 0)
  end
  local before = __YIELD_COUNT
  local cur = state.get(key)
  local nextv = fn(cur)
  if __YIELD_COUNT ~= before then
    error({ kind = "state.update_yielded", detail = "state.update 回调内出现挂起点，未写入" }, 0)
  end
  return state.set(key, nextv)
end

function state.seen(key, window_ms)
  return rv(bridge.state.seen(tostring(key), math.floor(window_ms or 5000)), false) == true
end

-- ---------- chat / rex（命令体系已移除：没有命令声明、没有命令参数注入） ----------

rex = setmetatable({}, { __call = function(_, pat) return rv(bridge.util.regex_new(pat), nil) end })

local function say(text, kind)
  return call_action("act.chat_send", { text = text, kind = kind or "chat" })
end

chat = {}
function chat.say(text) return say(text, "chat") end
function chat.run_command(str)
  local t = tostring(str or "")
  if t:sub(1, 1) == "/" then t = t:sub(2) end   -- 契约 text 不带前导 /，kind 决定发包类型
  return say(t, "command")
end
function chat.reply(m, text)
  -- 私聊已从 ABI 移除：原版没有私聊频道，私聊是服务器命令（/msg、/tell…）。
  -- 双参形式保留失败结果，避免老脚本把“接收者”当公屏文本发出去。
  if text ~= nil then
    return { ok = false, error = { code = "chat.private_reply_removed",
                                   message = "私聊已移除：请用 chat.run_command('/msg 玩家 文本')" } }
  end
  return say(m, "chat")
end

local function rex_search(rid, msg)
  local m = rv(bridge.util.regex_match(rid, msg.text or ""), nil)
  if m ~= nil then return m end
  return rv(bridge.util.regex_match(rid, msg.raw or ""), nil)
end

function on_chat(rexid, opts, fn)
  if type(opts) == "function" then fn = opts; opts = nil end
  __CHAT_HANDLERS[#__CHAT_HANDLERS + 1] = { rexid = rexid, opts = opts or {}, fn = fn }
end

function chat.await_chat(rexid, timeout)
  local tok = bridge.waiter.new(timeout or 5000)
  local w = { rexid = rexid, token = tok }
  __AWAITERS[#__AWAITERS + 1] = w
  local r = await(tok)
  -- 超时/取消后不会被 __chat_pipeline 清走：按对象身份移除，避免等待者表只增不减
  for i = #__AWAITERS, 1, -1 do
    if __AWAITERS[i] == w then table.remove(__AWAITERS, i) end
  end
  return r
end
await_chat = chat.await_chat

function __chat_pipeline(msg)
  for _, w in ipairs(__AWAITERS) do
    local m = rex_search(w.rexid, msg)
    if m ~= nil then
      bridge.waiter.resolve(w.token, encode(m))
      w.hit = true
    end
  end
  for i = #__AWAITERS, 1, -1 do
    if __AWAITERS[i].hit then table.remove(__AWAITERS, i) end
  end
  for _, h in ipairs(__CHAT_HANDLERS) do
    local o = h.opts
    if (not o.source or o.source == msg.sender_kind)
       and (not o.from or o.from == msg.sender) then
      local m = rex_search(h.rexid, msg)
      if m ~= nil then
        local payload = decode(encode(m))
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

-- ---------- time / log ----------

time = {
  sleep = function(d) await(bridge.util.sleep(d)) end,
  now = function() return rv(bridge.util.now(), 0) end,
}

log = {
  info = function(...) bridge.log("info", string.format(...)) end,
  warn = function(...) bridge.log("warn", string.format(...)) end,
  error = function(...) bridge.log("error", string.format(...)) end,
}

-- ---------- events（平台事件入站；控制通道 /event → events.next） ----------
events = {}
function events.next(timeout)
  return await(bridge.events.next(timeout or 30000))
end

-- 上行：脚本 → 宿主（进入实时流 event 通道，宿主决定转发/丢弃/落库）。
function events.emit(type, data)
  if type == nil then error({ kind = "event.bad_request", detail = "type 必填" }, 0) end
  return rv(bridge.events.emit(tostring(type), data or {}), nil)
end

-- ---------- net（自定义网络包 / custom payload / 插件消息） ----------
-- 门控 = 实例边界 boundary.packets（权限位；缺省拒绝）。宿主同时用该位拦入站事件，
-- 因此未授权的实例既发不出去、也收不到 net.payload。
net = {}

--- 注册通道处理器：fn({ channel, data, ts })，data 为原始字节串。
--- channel = "*" 匹配所有通道（精确匹配的处理器先运行）。
function net.on(channel, fn)
  if type(fn) ~= "function" then
    error({ kind = "net.bad_request", detail = "net.on 的第二个参数必须是函数" }, 0)
  end
  local c = tostring(channel or "")
  __NET_HANDLERS[c] = __NET_HANDLERS[c] or {}
  table.insert(__NET_HANDLERS[c], { fn = fn })
end

--- 发送自定义网络包。data 可传原始字节串，或 0..255 的字节数组。
--- 返回 Result（{ok=true,value} | {ok=false,error={code,message}}）。
function net.send(channel, data)
  local ch = tostring(channel or "")
  if ch == "" then
    error({ kind = "net.bad_request", detail = "channel 必填（如 servux:metadata）" }, 0)
  end
  local raw
  if data == nil then
    raw = ""
  elseif type(data) == "string" then
    raw = data
  elseif type(data) == "table" then
    local buf = {}
    for i, b in ipairs(data) do
      if type(b) ~= "number" or b < 0 or b > 255 or b ~= math.floor(b) then
        error({ kind = "net.bad_payload", detail = "字节数组第 " .. i .. " 项不是 0..255 整数" }, 0)
      end
      buf[i] = string.char(b)
    end
    raw = table.concat(buf)
  else
    error({ kind = "net.bad_payload", detail = "data 必须是字节串或 0..255 字节数组" }, 0)
  end
  return await(bridge.act.custom_payload(ch, b64_encode(raw)))
end

-- ---------- 实体句柄（帧快照：同帧内零跨桥，跨帧至多重取一次） ----------
--
-- 语义：字段值 = 最近一次宿主交互（await/事件/resume）之后的最新快照。
-- 同一帧内重复读多个字段只读本地表；跨帧后每个句柄至多重取一次（原先每个字段一次，
-- 单次 entities.get ≈1ms）。需要强制新鲜时用 e:refresh()（PERF-REFACTOR §3.3）。

local function snap_of(id, projection)
  if id == nil then return nil end
  return rv(bridge.entities.get(tostring(id), projection), nil)
end

local function exists_of(id)
  if id == nil then return nil end
  -- 存在性只关心「有没有这条实体」，core 投影足够（不要为一次 exists 展开整份装备）
  return rv(bridge.entities.get(tostring(id), "core"), nil) ~= nil
end

local function shallow_copy(t)
  local out = {}
  for k, v in pairs(t) do out[k] = v end
  return out
end

local ent_mt = {
  __index = function(e, k)
    local id = rawget(e, "__id")
    local proj = rawget(e, "__proj")
    if k == "id" then return id end
    if k == "refresh" then
      return function()
        local s = snap_of(id, proj)
        rawset(e, "__s", s)
        rawset(e, "__epoch", __EPOCH)
        return e
      end
    end
    if k == "snapshot" then
      return function()
        local s = rawget(e, "__s")
        if rawget(e, "__epoch") ~= __EPOCH then
          s = snap_of(id, proj)
          rawset(e, "__s", s)
          rawset(e, "__epoch", __EPOCH)
        end
        return s and shallow_copy(s) or nil
      end
    end
    if k == "exists" then return function() return exists_of(id) end end
    local s = rawget(e, "__s")
    if s == nil or rawget(e, "__epoch") ~= __EPOCH then
      s = snap_of(id, proj)
      rawset(e, "__s", s)
      rawset(e, "__epoch", __EPOCH)
    end
    if not s then return nil end
    return s[k]
  end,
}

local function make_entity(s, projection)
  if type(s) ~= "table" then return nil end
  return setmetatable({ __id = s.id, __s = s, __epoch = __EPOCH, __proj = projection or "full" }, ent_mt)
end

local function entity_id(e)
  return type(e) == "table" and (rawget(e, "__id") or e.id) or e
end

entity = {
  exists = function(e) return exists_of(entity_id(e)) end,
}

-- 自身快照按帧缓存：look.at / nearest / inv.held 在同一帧共用一次 self.get
local function self_snapshot()
  if __SELF_EPOCH ~= __EPOCH then
    __SELF = rv(bridge.self.get(), nil)
    __SELF_EPOCH = __EPOCH
  end
  return __SELF
end

_G.__self_snapshot = self_snapshot

local function self_pos()
  local sp = self_snapshot()
  return sp and sp.pos or nil
end

local function within_ok(s, pred, sp)
  if type(pred) ~= "table" or not pred.within then return true end
  if not s.pos then return false end
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
  -- 装备谓词：按部件名匹配，与 s.equipment.<部件>.id 同一口径。
  -- 未指定的部件不约束；显式写 false 表示「该部件必须为空」。
  if pred.equipment then
    for slot, want in pairs(pred.equipment) do
      local got = s.equipment and s.equipment[slot]
      if want == false then
        if got ~= nil then return false end
      elseif type(want) == "string" then
        if not (got and got.id == want) then return false end
      end
    end
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

-- 可下推的声明式谓词键；含 Lua 函数/未知键时必须回退全量投影（函数无法序列化过桥）
local HOST_PRED_KEYS = {
  type = true, name = true, uuid = true, alive = true,
  region = true, within = true, holding = true, equipment = true,
}

local function entity_plan(pred, opts)
  local plan = { projection = "core", full = false }
  if type(pred) == "table" then
    local host, has = {}, false
    for k, v in pairs(pred) do
      if HOST_PRED_KEYS[k] then
        host[k] = v
        has = true
      else
        plan.full = true   -- 未知键/嵌套函数：无法保证投影字段够用
      end
    end
    if has then plan.pred = host end
    plan.type = pred.type
    plan.within = pred.within
  elseif pred ~= nil then
    plan.full = true       -- 函数谓词
  end
  if opts and opts.full then plan.full = true end
  if plan.full then plan.projection = "full" end
  return plan
end

function entity.find(pred, opts)
  local plan = entity_plan(pred, opts)
  local list = rv(bridge.entities.list(plan.type, plan.within, plan.pred, plan.projection), {}) or {}
  local sp = plan.within and self_pos() or nil
  local out = {}
  for _, s in ipairs(list) do
    -- 宿主可能未下推（Fabric）或只下推了一部分：Lua 侧仍做残余判定，保证两栈一致
    if within_ok(s, pred, sp) and pred_match(s, pred) then
      out[#out + 1] = make_entity(s, plan.projection)
    end
  end
  return out
end

function entity.nearest(pred, opts)
  local plan = entity_plan(pred, opts)
  local list = rv(bridge.entities.list(plan.type, plan.within, plan.pred, plan.projection, "distance", 1), {}) or {}
  local sp = self_pos()
  local best, bd
  for _, s in ipairs(list) do
    if within_ok(s, pred, sp) and pred_match(s, pred) and s.pos then
      local d
      if sp then
        local dx, dy, dz = s.pos.x - sp.x, s.pos.y - sp.y, s.pos.z - sp.z
        d = dx * dx + dy * dy + dz * dz
      end
      if not bd or (d and d < bd) then best, bd = s, d or 0 end
    end
  end
  return make_entity(best, plan.projection)
end

-- ---------- world ----------

world = {
  block = function(pos) return rv(bridge.world.block(pos), nil) or {} end,
  block_entity = function(pos) return rv(bridge.world.block_entity(pos), nil) end,
  scan = function(region, pred, opts)
    local r = bridge.world.scan(region, pred, (opts or {}).limit)
    -- 未知谓词不得静默变成「空结果/默认 chest」：把宿主的类型化错误交还给脚本
    if type(r) == "table" and r.ok == false and r.error then
      error({ kind = r.error.code or "runtime.error", detail = r.error.message }, 0)
    end
    return rv(r, nil) or {}
  end,
  reach = function(pos, max_distance)
    return rv(bridge.world.reach(pos, max_distance), nil) or { reachable = false, distance = nil, hit_block = nil }
  end,
  dimension = function() return (rv(bridge.world.env(), {}) or {}).dimension end,
  time_of_day = function() return rv(bridge.world.time_of_day(), nil) end,
  weather = function() return rv(bridge.world.weather(), nil) end,
}

-- ---------- 容器 / 背包（协议无关的视图；开箱编排在可选库 container_lib） ----------

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

local function win_snap(id, fields)
  return rv(bridge.window.get(tostring(id), fields), nil)
end

local win_mt = {
  __index = function(w, k)
    local id = rawget(w, "__win")
    -- 兼容冒号/点两种调用：win:click(s, o) 与 win.click(s, o)
    local function split(a, b, c)
      if type(a) == "table" and rawget(a, "__win") ~= nil then return a, b, c end
      return nil, a, b, c
    end
    local click = function(slot, button, mode)
      return call_action("act.window_click", { window = id, slot = slot, button = button, mode = mode })
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
        local s = win_snap(id, "idcount")
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
        local s = win_snap(id, "idcount")
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
  -- 裸打开：瞄准/贴身/重试/等槽属于服务器适配，放在可选库 container_lib。
  open = function(target, opts)
    local ar = call_action("act.window_open", { target = target })
    if ar.ok and type(ar.value) == "table" and ar.value.id ~= nil then
      return make_win(tostring(ar.value.id))
    end
    if not ar.ok then
      bridge.events.emit("container.failed", { target = encode(target), error = ar.error })
    else
      bridge.events.emit("container.failed", {
        target = encode(target),
        error = { code = "container.missing", message = "窗口快照缺失" },
      })
    end
    return nil
  end,
  close = function(w)
    return call_action("act.window_close", {
      window = type(w) == "table" and rawget(w, "__win") or w,
    })
  end,
  current = function()
    local id = rv(bridge.window.current(), nil)
    return id and make_win(tostring(id)) or nil
  end,
}

inv = {
  count = function(filter)
    local s = win_snap("0", "idcount")
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
    local s = win_snap("0", "idcount")
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
    local s = self_snapshot()
    return s and s.held or nil
  end,
  click = function(slot, opts)
    opts = opts or {}
    return call_action("act.window_click", {
      window = "0", slot = slot,
      button = opts.mode == 4 and (opts.button == 1 and 1 or (opts.button and 1 or 0)) or (opts.button == "right" and 1 or 0),
      mode = opts.mode or (opts.shift and 1 or 0),
    })
  end,
  cursor = function()
    local s = win_snap("0")
    return s and s.cursor or nil
  end,
  -- 核心编排：找槽 + 装备点击序列（快捷栏 swap / 主背包三连点）
  equip = function(slot_or_filter)
    local slot = slot_or_filter
    if type(slot) ~= "number" then slot = inv.find(slot_or_filter) end
    if slot == nil then return nil end
    local s = self_snapshot() or {}
    local held_slot = s.held_slot or s.heldSlot or 0
    if slot ~= held_slot then
      if slot >= 0 and slot <= 8 then
        call_action("act.window_click", { window = "0", slot = slot, button = held_slot, mode = 2 })
      else
        call_action("act.window_click", { window = "0", slot = slot, button = 0, mode = 0 })
        call_action("act.window_click", { window = "0", slot = held_slot, button = 0, mode = 0 })
        call_action("act.window_click", { window = "0", slot = slot, button = 0, mode = 0 })
      end
    end
    return inv.held()
  end,
  select_slot = function(slot) return call_action("act.select_slot", { slot = slot }) end,
  drop = function(filter, count)
    local left = count or 1
    local guard = 0
    while left > 0 and guard < 64 do
      guard = guard + 1
      local slot = type(filter) == "number" and filter or inv.find(filter)
      if slot == nil then break end
      local s = win_snap("0")
      local item
      for _, sl in ipairs((s and s.slots) or {}) do
        if sl.index == slot then item = sl.item end
      end
      if item == nil then break end
      if left >= (item.count or 0) then
        call_action("act.drop", { slot = slot, all = true })
        left = left - (item.count or 0)
      else
        call_action("act.drop", { slot = slot, all = false })
        left = left - 1
      end
    end
  end,
}

-- ---------- nav / look（核心只做 Result 归一；编排动作由脚本/可选库决定） ----------

local function round_pos(p)
  if type(p) ~= "table" or p.x == nil then return nil end
  return {
    x = math.floor(p.x + 0.5),
    y = math.floor(p.y + 0.5),
    z = math.floor(p.z + 0.5),
  }
end

-- 把驱动/NavResult 归一成跨平台 Result（OK/ERR/取消由 await 负责）
local function as_nav_result(r)
  if type(r) ~= "table" then return { ok = true, value = {} } end
  if r.ok == true then return { ok = true, value = r } end
  if r.ok == false and r.error ~= nil then return r end   -- ABI 确定性失败（policy/denied/…）
  local reason = r.reason or "unreachable"
  return { ok = false, error = { code = "nav." .. reason, message = reason } }
end

nav = {
  walk = function(target, opts)
    opts = opts or {}
    local pos = round_pos(target)
    if pos == nil then
      -- 实体目标：取活位置
      local id = entity_id(target)
      local e = rv(bridge.entities.get(tostring(id)), nil)
      if not e then
        return { ok = false, error = { code = "entity.gone", message = "nav.walk 目标实体不存在" } }
      end
      pos = round_pos(e.pos)
      if pos == nil then
        return { ok = false, error = { code = "entity.gone", message = "目标无坐标" } }
      end
    end

    -- 没有寻路器就显式失败：不再用直线输入假装寻路。
    if not rv(bridge.caps.get("nav.pathfinder"), false) then
      local err = { code = "nav.unsupported", message = "当前宿主没有寻路能力（nav.pathfinder=false）" }
      bridge.events.emit("nav.failed", { reason = err.code, target = pos })
      return { ok = false, error = err }
    end

    local arrive = opts.arrive or 1.5
    local timeout_ms = opts.timeout_ms or (opts.timeout and opts.timeout * 1000) or 30000
    local r = as_nav_result(await(bridge.act.path_to(pos, arrive, timeout_ms)))
    if not r.ok then
      bridge.events.emit("nav.failed", { reason = r.error and r.error.code or "nav.unreachable", target = pos })
    end
    return r
  end,
  goto_near = function(pos, radius, opts)
    opts = opts or {}
    opts.arrive = radius or opts.arrive
    return nav.walk(pos, opts)
  end,
  stop = function()
    call_action("act.path_cancel", {})
    return call_action("act.input", { forward = 0, right = 0, up = 0, sprint = false, sneak = false })
  end,
  flee = function(pos, opts) return nav.walk(pos, opts or { arrive = 2 }) end,
  distance_to = function(t)
    local pos = type(t) == "table" and (t.pos or t) or t
    if type(pos) ~= "table" or pos.x == nil then return nil end
    local sp = self_pos()
    if not sp then return nil end
    local dx, dy, dz = pos.x - sp.x, pos.y - sp.y, pos.z - sp.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
  end,
  can_reach = function(pos)
    return world.reach(pos).reachable == true
  end,
  hop = function()
    local r = call_action("act.input", { forward = 0, right = 0, up = 1, sprint = false, sneak = false })
    time.sleep(100)
    call_action("act.input", { forward = 0, right = 0, up = 0, sprint = false, sneak = false })
    return r
  end,
}

look = {
  yaw = function(a)
    local tok = bridge.act.look(a, nil)
    bridge.token.detach(tok)
  end,
  pitch = function(a)
    local tok = bridge.act.look(nil, a)
    bridge.token.detach(tok)
  end,
  -- 一次写完两轴：原版客户端每 tick 最多发一个 rotation 包。
  aim = function(y, p)
    local tok = bridge.act.look(y, p)
    bridge.token.detach(tok)
  end,
  current = function()
    local s = self_snapshot() or {}
    return { yaw = ((((s.yaw or 0) % 360) + 360) % 360), pitch = s.pitch or 0 }
  end,
}

-- ---------- combat / self / session / caps / data ----------

__LAST_ATTACK = 0
__LAST_ATTACK_STACK = nil

local function stack_info(item)
  if item == nil then return nil end
  return rv(bridge.item.stack(item), nil)
end

combat = {
  attack = function(e)
    local id = type(e) == "table" and (rawget(e, "__id") or e.id) or e
    __LAST_ATTACK = rv(bridge.util.now(), 0)
    local held = inv.held()
    __LAST_ATTACK_STACK = held
    call_action("act.swing", { hand = "main" })
    return call_action("act.use_entity", { id = tostring(id), kind = "attack", hand = "main" })
  end,
  interact_entity = function(e, hand)
    local id = type(e) == "table" and (rawget(e, "__id") or e.id) or e
    return call_action("act.use_entity", { id = tostring(id), kind = "interact", hand = hand or "main" })
  end,
  range = function() return 3.0 end,
  cooldown = function()
    -- 原版冷却由 attack_speed 组件决定；数据缺失返回 nil，由脚本决定如何处理，
    -- 不再用引擎发明的 500ms 固定节奏冒充物品数据。
    local st = stack_info(__LAST_ATTACK_STACK)
    local speed = st and st.attributes and st.attributes.attack_speed
    if speed == nil or speed <= 0 then return nil end
    local cd = math.ceil(600 / speed)
    local left = __LAST_ATTACK + cd - rv(bridge.util.now(), 0)
    return left > 0 and left or 0
  end,
  use_block = function(pos, opts)
    opts = opts or {}
    return call_action("act.use_block", {
      pos = pos, face = opts.face or 1, hand = opts.hand or "main",
      intent = opts.intent or "use", cursor = opts.cursor,
    })
  end,
  place = function(pos, face) return combat.use_block(pos, { intent = "place", face = face or 1 }) end,
  dig = function(pos, face) return call_action("act.dig", { pos = pos, face = face or 1, phase = "start" }) end,
  dig_stop = function() return call_action("act.dig", { pos = { x = 0, y = 0, z = 0 }, phase = "stop" }) end,
  use_item = function(duration, hand)
    local h = hand or "main"
    call_action("act.use_item", { hand = h, phase = "start" })
    if duration and duration > 0 then time.sleep(duration) end
    return call_action("act.use_item", { hand = h, phase = "release" })
  end,
}

self = {
  username = function() local s = self_snapshot(); return s and s.username or nil end,
  pos = function() local s = self_snapshot(); return s and s.pos or nil end,
  velocity = function() local s = self_snapshot(); return s and s.velocity or nil end,
  health = function() local s = self_snapshot(); return s and s.health or nil end,
  food = function() local s = self_snapshot(); return s and s.food or nil end,
  held = function() local s = self_snapshot(); return s and s.held or nil end,
  held_slot = function() local s = self_snapshot(); return s and (s.held_slot or s.heldSlot or 0) or 0 end,
  gamemode = function() local s = self_snapshot(); return s and s.gamemode or nil end,
  effects = function() local s = self_snapshot(); return s and s.effects or nil end,
  attributes = function() local s = self_snapshot(); return s and s.attributes or nil end,
  pose = function() local s = self_snapshot(); return s and s.pose or nil end,
}

session = {
  state = function() return (rv(bridge.session.get(), {}) or {}).state end,
  info = function() return (rv(bridge.session.get(), {}) or {}).info end,
  paused = function() return (rv(bridge.session.get(), {}) or {}).paused == true end,
}

caps = {
  has = function(flag) return rv(bridge.caps.get(flag), false) == true end,
  server_version = function() return ((rv(bridge.session.get(), {}) or {}).info or {}).version end,
}

data = {
  -- 组件真值：传完整/部分 stack（id 也可），宿主按 stack 组件解析
  stack = function(item) return rv(bridge.item.stack(item), nil) end,
}

-- ---------- 宿主 → 核心（__core_call，显式反向契约） ----------

local function core_call_inner(op, j)
  local p = (j ~= nil and j ~= "") and decode(j) or {}
  if op == "params.bind" then return params_bind(p.manifest, p.instance) end
  if op == "params.get" then return { schema = __PARAM_SCHEMA, values = __PARAM_VALUES } end
  if op == "params.set" then return params_set(p.key, p.value) end
  if op == "tasks.list" then return __tasks_list() end
  if op == "tasks.cancel" then return __tasks_cancel(p.name) end
  if op == "eval.once" then return __eval_once(p.name, p.code) end
  error({ kind = "abi.unknown_op", detail = op }, 0)
end

function __core_call(op, j)
  local ok, result = pcall(core_call_inner, op, j)
  if ok then
    return encode({ ok = true, result = result })
  end
  local e = result
  if type(e) == "table" and e.kind then
    return encode({ ok = false, error = { kind = e.kind, detail = e.detail } })
  end
  return encode({ ok = false, error = { kind = "runtime.error", detail = errstr(e) } })
end

-- ---------- /eval 一次性脚本（与包脚本同环境同边界） ----------
-- EVAL_GLUE 与 Fabric LuaRuntime 共用同一段源码（保持一字不差）。
__EVAL_GLUE = [[
    local src, n = __EVAL_CODE, __EVAL_NAME
    __EVAL_CODE, __EVAL_NAME = nil, nil
    local c, err = load(src, "=eval:" .. n)
    if not c then error(err) end
    __DECL.tasks[n] = { opts = {}, fn = function()
      local r = c()
      if r ~= nil then log.info("[eval:" .. n .. "] => " .. tostring(r)) end
    end }
    task.spawn(n)]]

function __eval_once(name, code)
  local c, cerr = load(code, "=eval:" .. name)
  if not c then error({ kind = "lua.compile", detail = cerr }, 0) end
  __EVAL_CODE, __EVAL_NAME = code, name
  local f, err = load(__EVAL_GLUE, "=eval")
  if not f then error({ kind = "lua.compile", detail = err }, 0) end
  f()
  return { ok = true, task = name }
end
