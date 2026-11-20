-- 无 L1 方块更新流宿主（如 fabric mod）的引导：on_start 直接对 params.target
-- （目标双箱坐标）触发摆放。有方块事件流的宿主（mineflayer）不需要它：
-- heart.lua 的 world.block_changed 监听负责触发，这里直接让位。
on_start(function()
  -- 宿主无 world_stream 能力位（ABI v2 已移除该声明）：始终走引导触发
  local _ = 0
  local t = params.target
  if not t then
    log.warn("本宿主无方块事件流：请经控制渠道设置 params.target（目标双箱 [x,y,z]）后重启")
    return
  end
  local p = t.x and t or { x = t[1], y = t[2], z = t[3] }
  task.spawn("heart", p)
end)
