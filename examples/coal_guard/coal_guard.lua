-- ============================================================
-- 煤炭警戒 bot（coal_guard.lua）—— v1 验收脚本
-- 触发：指定范围内有玩家主手拿着煤炭
-- 行为：空手、一边旋转跳跃一边跑向该玩家并攻击；
--       该玩家主手不再是煤炭（或死亡/离开）即停止，回到警戒。
-- 停止：guard stop 聊天指令（op 名单）或内建 pause；无 Stop 时任务持续警戒。
-- 动作覆盖：move.path/hop/rot + interact.entity(attack) + window.click(收起主手)
-- 关键能力：entity 谓词 holding / equipment.hand 活读、伴随任务、keep_rotation、
--           on_cancel 清理钩
-- ============================================================

params {
  range = { type = "number", default = 24, visible = true, help = "警戒半径（格）" },
  spin  = { type = "number", default = 120, visible = true, help = "旋转速度（度/秒）" },
  ops   = { type = "string", default = "", visible = true,
            help = "可停止警戒的玩家名（逗号分隔；留空 = 不校验，示例用）" },
}

-- 操作员校验属于脚本自己的业务规则（平台不提供 owner/op 名单）
local function is_op(sender)
  local list = params.ops or ""
  if list == "" then return true end
  for name in string.gmatch(list, "[^, ]+") do
    if name == sender then return true end
  end
  return false
end

local function is_coal_holder(e)
  local h = e.equipment.hand                 -- 活读：每次循环取最新主手
  return h ~= nil and h.id == "minecraft:coal"
end

local function find_target()
  return entity.nearest{
    type = "player", alive = true,
    within = params.range, holding = "minecraft:coal",
  }
end

on_start(function()
  task.spawn("guard")
end)

on_chat(rex[[^guard stop$]], { source = "player" }, function(m)
  if not is_op(m.sender) then return end
  task.cancel("guard")
  chat.reply("警戒已停止")
end)

task("guard", { single = true }, function()
  on_cancel(nav.stop)                    -- 取消/pause 清理：停走（路径取消安全）
  while true do
    local t = find_target()
    if not t then
      time.sleep(sec(1))                     -- 平静期
    else
      bslib.ensure_holding(nil)              -- 空手攻击：把主手物品收进背包（背包点击复合）

      -- 伴随任务：旋转 + 跳跃（父任务结束后级联取消）
      task.spawn(function()
        while true do
          look.yaw((look.current().yaw + params.spin * 0.3) % 360)
          nav.hop()
          time.sleep(300)
        end
      end)

      -- 追击循环：目标存在、活着、且主手仍是煤炭
      while entity.exists(t) and t.alive and is_coal_holder(t) do
        if nav.distance_to(t) > combat.range() then
          nav.walk(t.pos, { arrive = 1.5, timeout = 3, keep_rotation = true })
          -- 目标在动，walk 常常超时/被甩开——循环自然重发；朝向留给旋转任务
        else
          bslib.look.at(t)                   -- 攻击前瞄准（attack 原语不校验朝向，瞄准防反作弊误判）
          wait_until(bslib.is_combat_ready)  -- 1.8 恒就绪；1.9+ 等攻击冷却
          combat.attack(t)
        end
      end

      nav.stop()
      if entity.exists(t) and t.alive then
        chat.reply(t.name .. " 已放下煤炭，放你一马")
      end
      -- 回到外层 while 重新扫描（可能同时有多人举煤）
    end
  end
end)
