-- ============================================================
-- runtime/lua/lib/container_lib.lua — 可选容器库（不占 ABI、不全局注入）
--
-- 用法：local clib = require "container_lib"
--
-- 这里保留的是「带服务器假设的容器编排」：开箱前瞄准/贴身/重试/换方位/等窗口
-- 快照，以及 withdraw/deposit/move 的点击配方与多趟工作流。
-- 这些不属于协议原语，所以核心 container.open 只做裸打开；需要旧行为的脚本
-- 显式 require 本库，并接受这些假设（交互距离、视线命中、快照时序）。
--
-- 依赖公开 API（container/inv/data/nav/item_match/time/log）+ 引擎内部挂起原语
-- （__await/__detach，与核心同环境）；不注入全局，不占 ABI。
-- ============================================================

local bridge = require "bridge"
local json = require "json"

local M = {}

local function enc(v) return json.encode(v) end
local function awaited(tok) return __await(tok) end
local function aimed(tok) __detach(tok) end
local function now_ms() return bridge.value(bridge.util.now(), 0) end

local function round_pos(p)
  if type(p) ~= "table" or p.x == nil then return nil end
  return { x = math.floor(p.x + 0.5), y = math.floor(p.y + 0.5), z = math.floor(p.z + 0.5) }
end

local function dist3(a, b)
  local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
  return math.sqrt(dx * dx + dy * dy + dz * dz)
end

local function norm_yaw(deg)
  local y = deg % 360
  if y > 180 then y = y - 360 end
  if y < -180 then y = y + 360 end
  return y
end

local EYE_HEIGHT = 1.62
local atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

-- ---------- 等窗口快照 ----------

function M.wait_revision(win_id, prev, timeout_ms)
  local deadline = now_ms() + timeout_ms
  while now_ms() < deadline do
    local w = bridge.value(bridge.window.get(tostring(win_id)), nil)
    if w and (w.revision or 0) > prev then return w end
    time.sleep(40)
  end
  return bridge.value(bridge.window.get(tostring(win_id)), nil)
end

-- ---------- 开箱编排（瞄准 / 贴身 / 重试 / 等槽） ----------

function M.open(target, opts)
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

  if container.current() ~= nil then
    container.close(nil)
  end

  local function aim(t)
    -- 服务器校验交互视线：开箱前先看向方块中心
    local sp = self.pos()
    if not sp then return end
    local dx = t.x + 0.5 - sp.x
    local dy = (t.y + 0.5) - (sp.y + EYE_HEIGHT)
    local dz = t.z + 0.5 - sp.z
    local horiz = math.sqrt(dx * dx + dz * dz)
    if horiz < 1e-6 then horiz = 1e-6 end
    aimed(bridge.act.look(norm_yaw(math.deg(atan2(-dx, dz))), math.deg(atan2(-dy, horiz))))
    time.sleep(150)
  end

  local function try_open() return awaited(bridge.act.window_open(open_target)) end
  local function approach(t, arrive, timeout_s)
    nav.walk(t, { arrive = arrive, timeout = timeout_s })
  end

  local res
  if pos ~= nil then
    local sp = self.pos()
    if sp and dist3(sp, pos) > 2.5 then approach(pos, 1.2, 10) end
    aim(pos)
  end
  local open_r = try_open()
  local function denied(r)
    local code = r.error and r.error.code or ""
    return code == "permission.denied" or code == "policy.blocklist" or code == "policy.config"
  end
  if not open_r.ok and denied(open_r) then
    bridge.events.emit("container.failed", { target = enc(target), error = open_r.error })
    return nil
  end
  if not open_r.ok then
    -- 重试：先走近（服务器对超出交互距离的交互静默拒绝），再开
    if pos ~= nil then
      local sp = self.pos()
      if sp and dist3(sp, pos) > 4 then approach(pos, 2, 8) end
    end
    container.close(nil)
    time.sleep(600)
    if pos ~= nil then aim(pos) end
    open_r = try_open()
    if not open_r.ok then
      -- 换方位：服务器要求「视线命中的块」与交互块一致，贴邻半箱会挡视线；
      -- 从对角偏移点重新接近，让视线直接命中目标块。
      for _, off in ipairs({ { 2, 2 }, { -2, -2 } }) do
        local alt = { x = pos.x + off[1], y = pos.y, z = pos.z + off[2] }
        approach(alt, 1.2, 8)
        aim(pos)
        open_r = try_open()
        if open_r.ok then break end
      end
    end
  end
  if not open_r.ok then
    bridge.events.emit("container.failed", { target = enc(target), error = open_r.error })
    return nil
  end
  res = open_r.value
  if res == nil or res.id == nil then
    bridge.events.emit("container.failed", { target = enc(target), error = { code = "container.missing", message = "窗口快照缺失" } })
    return nil
  end
  -- 等首个窗口快照（若已先到则跳过等待）
  local w = M.wait_revision(res.id, 0, 4000)
  if not w then
    bridge.events.emit("container.failed", { target = enc(target), error = { code = "container.missing", message = "窗口快照超时" } })
    return nil
  end
  -- 等 slot 数据灌入（open 事件先到、window items 后到）
  M.wait_revision(res.id, 1, 1500)
  local last = bridge.value(bridge.window.get(tostring(res.id)), nil) or w
  return container.current()
end

-- ---------- 背包 / 窗口槽位助手 ----------

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
  local probe = type(filter) == "table" and filter or nil
  local max_count = probe and (data.stack(probe).max_count or 64) or 64
  return empty * max_count
end

local function find_in_section(win, filter, min_index, max_index)
  for _, sl in ipairs(win:slots()) do
    if sl.item and sl.index >= min_index and sl.index <= max_index and item_match(sl.item, filter) then
      return sl.index
    end
  end
  return nil
end

-- ---------- withdraw / deposit（点击协议复合） ----------
--
-- 进度判定：按「匹配总量」对比 + 落定等待，不按「首个匹配叠」的前后数量对比。
-- 两个真实故障模式（2026-11-22 生产现场：回收只放进一件就报「存放 0 件」）：
--   1) 换叠巧合：矿镐(×1) 入箱后，新的首叠恰好也是 ×1 → 旧比较 1==1 误判「没动」提前中断；
--   2) 同步竞态：点击完成 ≠ 服务器内容同步完成（windowItems 是另一个包），
--      快照滞后期间读到旧值同样误判。
-- 总量在窗口（默认 800ms）内不变且仍有匹配物 = 真·放不下/取不出。

local function inv_matching_total(filter)
  local t = 0
  for _, sl in ipairs(inv.slots()) do
    if sl.item and sl.index <= 35 and item_match(sl.item, filter) then
      t = t + (sl.item.count or 0)
    end
  end
  return t
end

local function win_matching_total(win, filter)
  local t = 0
  local size = win:size()
  for _, sl in ipairs(win:slots()) do
    if sl.item and sl.index < size and item_match(sl.item, filter) then
      t = t + (sl.item.count or 0)
    end
  end
  return t
end

-- 等总量离开 before（窗口同步落地）；到点仍相同则原样返回（= 真·没动）
local function settle_total(count_fn, before, timeout_ms)
  local deadline = now_ms() + (timeout_ms or 800)
  while now_ms() < deadline do
    local t = count_fn()
    if t ~= before then return t end
    time.sleep(40)
  end
  return count_fn()
end

function M.withdraw(win, filter, n)
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
    local before = win_matching_total(win, filter)
    if item.count <= want then
      win.click(slot, { shift = true })
      local after = settle_total(function() return win_matching_total(win, filter) end, before, 800)
      local delta = before - after
      if delta <= 0 then
        log.warn('withdraw 停滞：槽 %s（%s×%d），箱内匹配总量 %d→%d 无变化（背包满或点击被服务器无视，详见引擎通道 [win-proto] 日志）',
          tostring(slot), tostring(item.id), item.count or 0, before, after)
        break
      end
      moved = moved + delta
    else
      local dst = empty_slot_in(win, win:size(), win:size() + 35)
      if not dst then break end
      win.click(slot, { button = "left" })
      for _ = 1, want do win.click(dst, { button = "right" }) end
      win.click(slot, { button = "left" })
      local after = settle_total(function() return win_matching_total(win, filter) end, before, 1500)
      local delta = before - after
      if delta <= 0 then break end
      moved = moved + delta
    end
  end
  return moved
end

function M.deposit(win, filter, n)
  n = n or math.huge
  local moved = 0
  local guard = 0
  while guard < 64 do
    guard = guard + 1
    local slot = inv.find(filter)
    if not slot then break end
    local item = find_by_slots(inv.slots(), slot)
    if not item then break end
    local want = n - moved
    local before = inv_matching_total(filter)
    if item.count <= want then
      inv.click(slot, { shift = true })
      local after = settle_total(function() return inv_matching_total(filter) end, before, 800)
      local delta = before - after
      if delta <= 0 then
        log.warn('deposit 停滞：槽 %s（%s×%d），背包匹配总量 %d→%d 无变化（容器满或点击被服务器无视，详见引擎通道 [win-proto] 日志）',
          tostring(slot), tostring(item.id), item.count or 0, before, after)
        break
      end
      moved = moved + delta
    else
      local dst = empty_slot_in(win, 0, win:size() - 1)
      if not dst then break end
      inv.click(slot, { button = "left" })
      for _ = 1, want do win.click(dst, { button = "right" }) end
      inv.click(slot, { button = "left" })
      local after = settle_total(function() return inv_matching_total(filter) end, before, 1500)
      local delta = before - after
      if delta <= 0 then break end
      moved = moved + delta
    end
    if moved >= n then break end
  end
  return moved
end

-- ---------- 多趟跨箱转移 ----------

-- clib.move(from, to, filter, { on_open = function(pos, win, filter) end })
-- 走-开-取-关-走-开-放-关 循环；返回净转移件数；取空/放不下即停
function M.move(from, to, filter, opts)
  opts = opts or {}
  local total = 0
  local rounds = 0
  while rounds < 16 do
    rounds = rounds + 1
    local rf = nav.goto_near(from, 3)
    if not (rf and rf.ok) then
      log.warn("move: 无法到达来源箱 %s（%s）", tostring(from), rf and rf.error and rf.error.code or "?")
      return total   -- 不可达：停（错误经 nav.failed 事件）
    end
    local w = M.open(from)
    if not w then
      log.warn("move: 无法打开来源箱 %s", tostring(from))
      return total
    end
    local cap = inv_free_capacity(filter)
    if cap <= 0 then
      container.close(w)
      break
    end
    local got = M.withdraw(w, filter, cap)
    container.close(w)
    if got == 0 then break end                     -- 来源已空
    local rt = nav.goto_near(to, 3)
    if not (rt and rt.ok) then
      log.warn("move: 无法到达目标箱 %s（%s）", tostring(to), rt and rt.error and rt.error.code or "?")
      return total
    end
    local w2 = M.open(to)
    if not w2 then
      log.warn("move: 无法打开目标箱 %s", tostring(to))
      return total
    end
    if opts.on_open then opts.on_open(to, w2, filter) end
    local put = M.deposit(w2, filter, got)
    container.close(w2)
    total = total + put
    if put == 0 then break end                     -- 目标满
    if put < got then break end                    -- 本轮没送完
  end
  return total
end

return M
