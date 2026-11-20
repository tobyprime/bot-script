-- ============================================================
-- runtime/lua/lib/bslib.lua — 可选通用库（不占 ABI、不全局注入）
--
-- 用法：local bslib = require "bslib"
--
-- 这里只留「纯数学 + 背包操作配方」这类小而通用、没有服务器假设的助手：
--   look.at / ensure_holding / equip_best
--
-- 导航编排、开箱重试、容器搬运已移出核心，也不再属于本库：
--   * nav.follow / straight_goto 已删除；需要跟随时脚本自行 nav.walk 循环；
--   * 容器配方见可选库 container_lib（开箱瞄准/重试/withdraw/deposit/move）。
--
-- 本文件与用户脚本同环境，无任何特权。引擎不把它当契约 API，也不注入全局。
-- ============================================================

local bslib = {}
bslib.look = {}

local EYE_HEIGHT = 1.62

-- atan2 兼容：5.4 并入 math.atan(y,x)；LuaJ 保留 math.atan2（compat/luaj.lua 兜底）
local atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

local function held_slot()
  return self.held_slot and self.held_slot() or 0
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

-- ---------- 手持 / 换手（纯背包点击配方） ----------

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

-- ---------- 武器选择（玩法策略，脚本可复制后自行调整） ----------

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

return bslib
