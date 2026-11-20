-- ============================================================
-- 心形绘制 bot（heart.lua）—— v1 验收脚本
-- 触发：侦测范围内出现新放置的大箱子（双箱；小箱子不管）
-- 行为：从原材料箱取"适量"粉色羊毛（= 图案槽位数 27），走到大箱处，
--       拿起一叠羊毛逐槽右键摆放出心形；全程伴随任务持续看向最近玩家。
-- 动作覆盖：move.path/rot + interact.block(开箱) + window.click —— v1 三类型
-- ============================================================

local bslib = require "bslib"              -- look.at
local clib = require "container_lib"       -- 开箱瞄准/重试 + withdraw

-- 心形图案：大箱 6 行 × 9 列，X = 放材料（27 槽）
local PATTERN = {
  ".XX.XX.",
  "XXXXXXX",
  "XXXXXXX",
  ".XXXXX.",
  "..XXX..",
  "...X...",
}
local SLOTS, NEED = {}, 0
for r = 1, #PATTERN do
  for c = 1, #PATTERN[r] do
    if PATTERN[r]:sub(c, c) == "X" then
      SLOTS[#SLOTS + 1] = (r - 1) * 9 + (c - 1)    -- 窗口槽位 = row*9 + col（0 基）
      NEED = NEED + 1
    end
  end
end

local function is_double_chest(pos)                 -- 引擎世界缓存上的纯查询
  if world.block(pos).name ~= "minecraft:chest" then return false end
  for _, d in ipairs({ {1,0}, {-1,0}, {0,1}, {0,-1} }) do
    local n = world.block({ x = pos.x + d[1], y = pos.y, z = pos.z + d[2] })
    if n.name == "minecraft:chest" then return true end
  end
  return false
end

-- 触发：L1 方块更新流。放第二个箱身补全双箱的那一刻满足条件；
-- 单例任务保证忙碌时后来的箱子被忽略（排队策略可自行扩展）。
-- state.seen 去重：Paper 会在容器交互后重发容器块更新（含内容变更），
-- 同一双箱 30s 内只认一次触发，防止摆放完成后被自身交互的回包再次拉起。
on_event("world.block_changed", function(pos)
  if nav.distance_to(pos) > params.range then return end
  if not is_double_chest(pos) then return end
  if state.seen("heart:" .. pos.x .. ":" .. pos.y .. ":" .. pos.z, 30000) then return end
  task.spawn("heart", pos)
end)

task("heart", { single = true }, function(pos)
  -- 伴随任务：全程看向最近玩家（父任务结束/取消时级联终止）
  task.spawn(function()
    while true do
      local p = entity.nearest{ type = "player", alive = true, within = params.range }
      if p then bslib.look.at(p) end                -- atan2 算角度 + look.yaw/pitch
      time.sleep(50)
    end
  end)

  -- 1) 取"适量"材料：恰好图案槽位数（不足则整单放弃并告警，绝不静默摆一半）
  nav.goto_near(params.source, 3, { keep_rotation = true })   -- 寻路不碰朝向
  local src = clib.open(params.source)
  clib.withdraw(src, { id = params.material }, NEED)
  container.close(src)
  if inv.count{ id = params.material } < NEED then
    log.warn("材料不足：需 %d 块 %s，放弃本次摆放", NEED, params.material)
    return
  end

  -- 2) 走到玩家放的大箱并打开
  nav.goto_near(pos, 3, { keep_rotation = true })
  local box = clib.open(pos)
  if box:size() ~= 54 then                          -- 双箱窗口确认
    container.close(box)
    error{ kind = "task.not_double_chest", detail = tostring(pos) }
  end

  -- 3) 摆心：拿起整叠羊毛到光标，逐目标槽右键各放 1（光标恰好清空）
  local s = inv.find{ id = params.material }
  inv.click(s, { button = "left" })                 -- 0 号窗口（背包）拿起
  for _, t in ipairs(SLOTS) do
    box:click(t, { button = "right" })              -- 右键 = 放 1 个
  end
  if inv.cursor() then                              -- 防御：有剩余则放回原槽
    inv.click(s, { button = "left" })
  end
  container.close(box)
  log.info("心形完成：%d 块 %s @ %s", NEED, params.material, tostring(pos))
end)
