-- ============================================================
-- bslib — bot-script 内置行为策略库（Lua 源码随引擎分发，可读可覆盖）
-- 分层规则见 CAPABILITIES.md §13：HAL 只留正交控制面，行为策略进 bslib。
-- 构建在 bootstrap 注入的 HAL 全局之上，无任何特权。
-- ============================================================

local json = require "json"
local function enc(v) return json.encode(v) end
local function dec(j) return json.decode(j) end

-- atan2 兼容：5.4 改名 math.atan(y,x)，LuaJ/旧版保留 math.atan2——取存在者
local atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

local function call_query(jsname, args)
  local j = _G[jsname](enc(args or {}))
  if j == nil or j == "" then return nil end
  return dec(j)
end

local bslib = {}
bslib.look = {}

-- ---------- 瞄准（atan2 角度数学 + look 原语写入，无状态 last-writer-wins） ----------

local EYE_HEIGHT = 1.62

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

-- ---------- 背包 / 窗口槽位助手 ----------

local function held_slot()
  local s = call_query("__q_self", {})
  return (s and s.held_slot) or 0
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
  local id = type(filter) == "table" and filter.id or nil
  return empty * (id and data.stack_size(id) or 64)
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

function bslib.equip_best(kind)
  kind = kind or "weapon"
  local best, best_score
  for _, sl in ipairs(inv.slots()) do
    if sl.item then
      local sc = data.weapon_score(sl.item.id)
      if sc and (not best_score or sc > best_score) then
        best, best_score = sl.index, sc
      end
    end
  end
  local held = inv.held()
  if held then
    local hs = data.weapon_score(held.id)
    if hs and (not best_score or hs >= best_score) then
      return held   -- 已持最优
    end
  end
  if not best then return nil end
  inv.equip(best)
  return inv.held()
end

-- ---------- withdraw / deposit（点击协议复合；moved<count=箱满 为 bslib 约定） ----------

-- 区间限定查找：withdraw 只认容器区（避免把刚搬进玩家区的物品再搬回去）
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

-- ----------
bslib.try = try
bslib.race = race
bslib.parallel = parallel
bslib.with_timeout = with_timeout
bslib.wait_until = wait_until

return bslib
