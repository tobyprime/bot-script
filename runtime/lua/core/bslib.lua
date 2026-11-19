-- ============================================================
-- runtime/lua/core/bslib.lua — 内置行为策略库（唯一源码，Node/Fabric 共用）
--
-- 分层规则（ARCHITECTURE-REFACTOR §3.4）：**原语下沉、编排上移**。
-- 宿主只提供协议原语（act.look / act.input / act.path_to / act.window_open / act.window_click …），
-- 导航、开箱瞄准与重试、装备点击序列这类组合行为都在本文件里，两个宿主行为一致。
--
-- 构建在 bootstrap 注入的公开 API 之上，无任何特权（与用户脚本同环境）。
-- ============================================================

local json = require "json"
local bridge = require "bridge"

local function enc(v) return json.encode(v) end
local function dec(j) return json.decode(j) end

-- atan2 兼容：5.4 并入 math.atan(y,x)；LuaJ 保留 math.atan2（compat/luaj.lua 兜底）
local atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

local bslib = {}
bslib.look = {}

local EYE_HEIGHT = 1.62

local function round_pos(p)
  if type(p) ~= "table" or p.x == nil then return nil end
  return { x = math.floor(p.x + 0.5), y = math.floor(p.y + 0.5), z = math.floor(p.z + 0.5) }
end

local function dist3(a, b)
  local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
  return math.sqrt(dx * dx + dy * dy + dz * dz)
end

local function dist2d(a, b)
  local dx, dz = a.x - b.x, a.z - b.z
  return math.sqrt(dx * dx + dz * dz)
end

local function norm_yaw(deg)
  local y = deg % 360
  if y > 180 then y = y - 360 end
  if y < -180 then y = y + 360 end
  return y
end

local function awaited(tok) return __await(tok) end
local function aimed(tok) __detach(tok) end

-- 等窗口快照的 revision 前进（宿主负责协议，核心负责节奏）
function bslib.wait_revision(win_id, prev, timeout_ms)
  local deadline = bridge.util.now() + timeout_ms
  while bridge.util.now() < deadline do
    local w = bridge.window.get(tostring(win_id))
    if w and (w.revision or 0) > prev then return w end
    time.sleep(40)
  end
  return bridge.window.get(tostring(win_id))
end

-- ---------- 瞄准（atan2 角度数学 + look 原语写入，无状态 last-writer-wins） ----------

function bslib.look.at(t, opts)
  local sp = self.pos()
  if not sp then return end
  local pos, is_entity
  if type(t) == "table" and t.pos then
    is_entity = t.type ~= nil
    pos = t.pos
  else
    pos = t
  end
  local ty = is_entity and (pos.y + 1.6) or (pos.y + 0.5)
  local dx, dy, dz = pos.x - sp.x, ty - (sp.y + EYE_HEIGHT), pos.z - sp.z
  local horiz = math.sqrt(dx * dx + dz * dz)
  local yaw = math.deg(atan2(-dx, dz)) % 360
  local pitch = -math.deg(math.atan(dy, horiz))
  if opts and opts.only == "pitch" then
    look.pitch(pitch)
  elseif opts and opts.only == "yaw" then
    look.yaw(yaw)
  else
    look.aim(yaw, pitch)   -- 单包同时写两轴：分两次调用 = 发包频率翻倍，高频瞄准会被踢
  end
end

function bslib.is_combat_ready()
  return combat.cooldown() <= 0
end

-- ---------- 导航（原语：act.path_to / act.path_cancel / act.input / act.look） ----------

-- 直线退化：无寻路器时的宿主能力之一。与旧 engine straightGoto 逐条对齐：
-- 100ms 步进、0.15 格判定「没动」、6 秒无进展判 stuck、卡住跳一格（250ms）。
function bslib.straight_goto(pos, opts)
  opts = opts or {}
  local arrive = opts.arrive or 1.5
  local timeout_ms = (opts.timeout ~= nil and opts.timeout * 1000 or 30000)
  local deadline = bridge.util.now() + timeout_ms
  local last = self.pos() or pos
  local last_progress = bridge.util.now()
  local jumping = false

  local function stop_move()
    awaited(bridge.act.input(0, 0, 0, false, false))
  end

  while true do
    local p = self.pos()
    if not p then time.sleep(100) end
    local d = dist2d(p, pos)
    if d <= arrive then
      stop_move()
      return { ok = true }
    end
    if bridge.util.now() > deadline then
      stop_move()
      return { ok = false, reason = "timeout" }
    end
    if dist3(p, last) < 0.15 then
      if bridge.util.now() - last_progress > 6000 then
        stop_move()
        return { ok = false, reason = "stuck" }
      end
      awaited(bridge.act.input(1, 0, 1, false, false))   -- 前进 + 跳
      time.sleep(250)
    else
      last = p
      last_progress = bridge.util.now()
    end
    -- 直线退化必须朝向目标才走得到
    local yaw = norm_yaw(math.deg(atan2(-(pos.x - p.x), pos.z - p.z)))
    aimed(bridge.act.look(yaw, 0))
    awaited(bridge.act.input(1, 0, 0, false, false))
    time.sleep(100)
  end
end

function bslib.nav_walk(target, opts)
  opts = opts or {}
  local pos = round_pos(target)
  if pos == nil then
    -- 实体目标：取活位置
    local id = type(target) == "table" and (rawget(target, "__id") or target.id) or target
    local e = bridge.entities.get(tostring(id))
    if not e then error({ kind = "entity.gone", detail = "nav.walk 目标实体不存在" }, 0) end
    pos = round_pos(e.pos)
    if pos == nil then return { ok = false, reason = "entity.gone" } end
  end
  local r
  if bridge.caps.get("nav.pathfinder") then
    local arrive = opts.arrive or 1.5
    local timeout_ms = opts.timeout_ms or (opts.timeout and opts.timeout * 1000) or 30000
    r = awaited(bridge.act.path_to(pos, arrive, timeout_ms)) or { ok = true }
  else
    r = bslib.straight_goto(pos, opts)
  end
  if not r.ok then
    bridge.events.emit("nav.failed", { reason = r.reason or "unreachable", target = pos })
  end
  return r
end

function bslib.nav_follow(entity_id, opts)
  opts = opts or {}
  local want = opts.distance or 2
  local e = bridge.entities.get(tostring(entity_id))
  if not e then return { ok = false, reason = "entity.gone" } end
  while true do
    local cur = bridge.entities.get(tostring(entity_id))
    if not cur or cur.alive == false then return {} end
    local sp = bridge.self.get()
    local d = (sp and sp.pos and cur.pos) and dist3(sp.pos, cur.pos) or math.huge
    if d > want + 1 then
      if bridge.caps.get("nav.pathfinder") then
        pcall(function() awaited(bridge.act.path_to(round_pos(cur.pos), want, 5000)) end)
      else
        -- 无寻路器：朝向目标做短步进，由循环持续修正
        local yaw = norm_yaw(math.deg(atan2(-(cur.pos.x - sp.pos.x), cur.pos.z - sp.pos.z)))
        aimed(bridge.act.look(yaw, 0))
        awaited(bridge.act.input(1, 0, 0, d > want + 4, false))
        time.sleep(100)
      end
    else
      awaited(bridge.act.path_cancel())
      awaited(bridge.act.input(0, 0, 0, false, false))
      time.sleep(200)
    end
  end
end

-- ---------- 开箱编排（瞄准 / 贴身 / 重试 / 等槽） ----------

local function window_click_sequence_possible() return true end

function bslib.container_open(target, opts)
  opts = opts or {}
  local pos = round_pos(target)
  local open_target
  if pos ~= nil then
    open_target = pos
  else
    local id = type(target) == "table" and (rawget(target, "__id") or target.id) or target
    if id == nil then error({ kind = "container.missing", detail = "target 为空" }, 0) end
    open_target = { entity = tostring(id) }
  end

  -- 窗口互斥：先关再开（宿主保证不变量，核心负责流程）
  if bridge.window.current() ~= nil then
    pcall(function() awaited(bridge.act.window_close(nil)) end)
  end

  local function aim(t)
    -- 服务器校验交互视线：开箱前先看向方块中心（fabric 客户端不会自动瞄准）
    local sp = bridge.self.get()
    if not sp or not sp.pos then return end
    local p = sp.pos
    local dx = t.x + 0.5 - p.x
    local dy = (t.y + 0.5) - (p.y + EYE_HEIGHT)
    local dz = t.z + 0.5 - p.z
    local horiz = math.sqrt(dx * dx + dz * dz)
    if horiz < 1e-6 then horiz = 1e-6 end
    aimed(bridge.act.look(norm_yaw(math.deg(atan2(-dx, dz))), math.deg(atan2(-dy, horiz))))
    time.sleep(150)
  end

  local function try_open() return awaited(bridge.act.window_open(open_target)) end
  local function approach(t, arrive, timeout_s)
    pcall(function()
      if bridge.caps.get("nav.pathfinder") then
        awaited(bridge.act.path_to(t, arrive, timeout_s * 1000))
      else
        bslib.straight_goto(t, { arrive = arrive, timeout = timeout_s })
      end
    end)
  end

  local first_err, res
  -- 先贴脸：survival reach 有限，走到 1.2 格内再交互最稳
  if pos ~= nil then
    local sp = bridge.self.get()
    if sp and sp.pos and dist3(sp.pos, pos) > 2.5 then approach(pos, 1.2, 10) end
    aim(pos)
  end
  if not pcall(function() res = try_open() end) or res == nil then
    -- 重试：先走近（服务器对超出交互距离的交互静默拒绝），再开
    if pos ~= nil then
      local sp = bridge.self.get()
      if sp and sp.pos and dist3(sp.pos, pos) > 4 then approach(pos, 2, 8) end
    end
    pcall(function() awaited(bridge.act.window_close(nil)) end)
    time.sleep(600)
    if pos ~= nil then aim(pos) end
    local ok2, err2 = pcall(function() res = try_open() end)
    if not ok2 then
      first_err = err2
      -- 换方位：服务器要求「视线命中的块」与交互块一致，贴邻半箱会挡视线；
      -- 从对角偏移点重新接近，让视线直接命中目标块。
      if pos == nil then error(first_err, 0) end
      for _, off in ipairs({ { 2, 2 }, { -2, -2 } }) do
        local alt = { x = pos.x + off[1], y = pos.y, z = pos.z + off[2] }
        approach(alt, 1.2, 8)
        aim(pos)
        if pcall(function() res = try_open() end) and res ~= nil then break end
      end
      if res == nil then error(first_err, 0) end
    end
  end

  if res == nil or res.id == nil then error({ kind = "container.missing", detail = enc(target) }, 0) end
  -- 等首个窗口快照（若已先到则跳过等待）
  local w = bslib.wait_revision(res.id, 0, 4000)
  if not w then error({ kind = "container.missing", detail = enc(target) }, 0) end
  -- 等 slot 数据灌入（open 事件先到、window items 后到）
  bslib.wait_revision(res.id, 1, 1500)
  local last = bridge.window.get(tostring(res.id)) or w
  return { id = tostring(last.id or res.id), type = last.type, size = last.size }
end

-- ---------- 背包 / 窗口槽位助手 ----------

local function held_slot()
  local s = bridge.self.get()
  return (s and (s.held_slot or s.heldSlot)) or 0
end

-- [min, max] 索引区间内找空槽（窗口内不存在的索引跳过）
local function empty_slot_in(win_or_slots, min_index, max_index)
  local slots = win_or_slots.slots and win_or_slots:slots() or win_or_slots
  for _, sl in ipairs(slots) do
    if not sl.item and sl.index >= min_index and sl.index <= max_index then
      return sl.index
    end
  end
  return nil
end

local function find_by_slots(slots, index)
  for _, sl in ipairs(slots) do
    if sl.index == index then return sl.item end
  end
  return nil
end

local function inv_free_capacity(filter)
  local empty = 0
  for _, sl in ipairs(inv.slots()) do
    if not sl.item and sl.index <= 35 then empty = empty + 1 end
  end
  -- 容量按该 stack 的组件 max_count（无组件时宿主给默认组件值）
  local probe = type(filter) == "table" and filter or nil
  local max_count = probe and (data.stack(probe).max_count or 64) or 64
  return empty * max_count
end

-- ---------- ensure_holding / equip_best ----------

function bslib.ensure_holding(item_id)
  local held = inv.held()
  if item_id == nil then
    if not held then return nil end
    local hs = held_slot()
    local dst = empty_slot_in(inv, 0, 35)
    if dst then
      inv.click(hs, { button = "left" })   -- 拿起主手
      inv.click(dst, { button = "left" })  -- 放入空槽
    else
      -- 背包满：丢弃主手整叠（警戒类哨兵行为优先恢复空手）
      inv.click(hs, { mode = 4, button = 1 })
    end
    return nil
  end
  if held and held.id == item_id then return held end
  local slot = inv.find{ id = item_id }
  if not slot then return nil end
  inv.equip(slot)
  return inv.held()
end

local function attack_score(stack)
  local st = stack and data.stack(stack) or nil
  local attrs = st and st.attributes or nil
  if not attrs or not attrs.attack_damage then return nil end
  return (attrs.attack_damage or 0) * (attrs.attack_speed or 1.0)
end

function bslib.equip_best(kind)
  kind = kind or "weapon"
  local best, best_score
  for _, sl in ipairs(inv.slots()) do
    if sl.item then
      local sc = attack_score(sl.item)
      if sc and (not best_score or sc > best_score) then
        best, best_score = sl.index, sc
      end
    end
  end
  local held = inv.held()
  if held then
    local hs = attack_score(held)
    if hs and (not best_score or hs >= best_score) then
      return held
    end
  end
  if not best then return nil end
  inv.equip(best)
  return inv.held()
end

-- ---------- withdraw / deposit（点击协议复合；moved<count=箱满 为 bslib 约定） ----------

local function find_in_section(win, filter, min_index, max_index)
  for _, sl in ipairs(win:slots()) do
    if sl.item and sl.index >= min_index and sl.index <= max_index and item_match(sl.item, filter) then
      return sl.index
    end
  end
  return nil
end

-- 从容器窗口取出 n 个匹配物品进背包，返回实际取出数（以窗口快照复核为准）
function bslib.withdraw(win, filter, n)
  n = n or math.huge
  local moved = 0
  local guard = 0
  while moved < n and guard < 64 do
    guard = guard + 1
    local slot = find_in_section(win, filter, 0, win:size() - 1)
    if not slot then break end
    local item = win:peek(slot)
    if not item then break end
    local want = n - moved
    if item.count <= want then
      win.click(slot, { shift = true })            -- 整叠 quick_move 进背包
      local left = win:peek(slot)
      if left and left.count == item.count then
        break                                      -- 背包满，没动 => 停
      end
      moved = moved + item.count
    else
      -- 精确取 want 个：拿起整叠 => 玩家区空槽右键滴灌 => 剩余放回原槽
      local dst = empty_slot_in(win, win:size(), win:size() + 35)
      if not dst then break end                    -- 背包满
      win.click(slot, { button = "left" })
      for _ = 1, want do
        win.click(dst, { button = "right" })       -- 右键 = 放 1
      end
      win.click(slot, { button = "left" })         -- 剩余放回
      moved = moved + want
    end
  end
  return moved
end

-- 把背包中匹配物品放入容器窗口 n 个，返回实际放入数
function bslib.deposit(win, filter, n)
  n = n or math.huge
  local moved = 0
  local guard = 0
  while moved < n and guard < 64 do
    guard = guard + 1
    local slot = inv.find(filter)
    if not slot then break end
    local item = find_by_slots(inv.slots(), slot)
    if not item then break end
    local want = n - moved
    if item.count <= want then
      inv.click(slot, { shift = true })            -- 整叠 quick_move 进容器
      local left = inv.find(filter)
      local left_item = left and find_by_slots(inv.slots(), left)
      if left_item and left_item.count == item.count then
        break                                      -- 背包满，没动 => 停
      end
      moved = moved + item.count
    else
      -- 精确放 want 个：拿起整叠 => 容器区空槽右键滴灌 => 剩余放回背包原槽
      local dst = empty_slot_in(win, 0, win:size() - 1)
      if not dst then break end                    -- 容器满
      inv.click(slot, { button = "left" })
      for _ = 1, want do
        win.click(dst, { button = "right" })
      end
      inv.click(slot, { button = "left" })
      moved = moved + want
    end
  end
  return moved
end

-- ---------- 多趟跨箱转移 ----------

-- bslib.move(from, to, filter, { on_open = function(pos, win, filter) end })
-- 走-开-取-关-走-开-放-关 循环；返回净转移件数；取空/放不下即停
function bslib.move(from, to, filter, opts)
  opts = opts or {}
  local total = 0
  local rounds = 0
  while rounds < 16 do
    rounds = rounds + 1
    local rf = nav.goto_near(from, 3)
    if not (rf and rf.ok) then
      log.warn("move: 无法到达来源箱 %s（%s）", tostring(from), rf and rf.reason or "?")
      return total   -- 不可达：停（错误经 nav.failed 事件）
    end
    local w = container.open(from)
    local cap = inv_free_capacity(filter)
    if cap <= 0 then
      container.close(w)
      break
    end
    local got = bslib.withdraw(w, filter, cap)
    container.close(w)
    if got == 0 then break end                     -- 来源已空
    local rt = nav.goto_near(to, 3)
    if not (rt and rt.ok) then
      log.warn("move: 无法到达目标箱 %s（%s）", tostring(to), rt and rt.reason or "?")
      return total
    end
    local w2 = container.open(to)
    if opts.on_open then opts.on_open(to, w2, filter) end
    local put = bslib.deposit(w2, filter, got)
    container.close(w2)
    total = total + put
    if put == 0 then break end                     -- 目标满：moved<=0 硬证据（活锁防线）
    if put < got then break end                    -- 本轮没送完（目标已满）
  end
  return total
end

-- ---------- 授权名单（只读；命令体系已移除，脚本自行判定操作员） ----------

function bslib.authority_level(name)
  if name == nil or name == '' then return 0 end
  local a = bridge.policy.authority() or {}
  local owner, op, whitelist = a.owner or {}, a.op or {}, a.whitelist or {}
  if contains(owner, name) then return 80 end
  if contains(op, name) then return (#owner > 0) and 60 or 80 end
  if contains(whitelist, name) then return 20 end
  return 10
end

function bslib.authorized(name, perm)
  local need = ({ console = 100, owner = 80, op = 60, whitelist = 20, player = 10 })[perm or 'player'] or 10
  return bslib.authority_level(name) >= need
end

-- ----------
bslib.try = try
bslib.race = race
bslib.parallel = parallel
bslib.with_timeout = with_timeout
bslib.wait_until = wait_until

return bslib
