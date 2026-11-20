-- ============================================================
-- routing.lua —— 整理 bot 的去向决策与缓存策略（普通 Lua 模块，禁声明层）
-- fork 自 bslib/organize.lua 范例，按需改造。
--
-- 策略：
--   1) 优先放"同物品、剩余空间最大"的不满盒（free>0）；
--   2) 无可用不满盒 → 该物品的库存箱（stock add 登记或认领未绑定 stock）；
--   3) 不满盒首次转移即绑定物品；free<0 表示未验证（冷启动/暂停后）。
-- 一致性规则（评审修订）：
--   * 自由度以开箱实测为准（validate 数空槽），估算仅作未开箱时的排序初值；
--   * moved==0 是硬证据：目标已满 → free=0 降级排名，杜绝满箱活锁。
-- 依赖：入口 organizer.lua 声明的 ChestNote 表（全局可见）；能力全局照常注入本模块。
-- ============================================================

local UNKNOWN = -1

local M = {}

local function rank(n)                      -- 排序权重：已验证的可用量排前
  return (n.free and n.free > 0) and n.free or 0
end

local function partials_for(id)
  local out = {}
  for n in ChestNote.all() do
    if n.role == "partial" and (n.item == nil or n.item == id) and n.free ~= 0 then
      out[#out + 1] = n
    end
  end
  table.sort(out, function(a, b) return rank(a) > rank(b) end)
  return out
end

function M.count()
  local n = 0
  for _ in ChestNote.all() do n = n + 1 end
  return n
end

-- 冷启动：扫到的容器先记为未绑定 partial，身份在首次转移时确认
function M.register_unknown(pos)
  if ChestNote.find{ pos = pos } then return end
  ChestNote.upsert{ pos = pos, role = "partial", item = nil, free = UNKNOWN }
end

function M.add_partial(pos)
  ChestNote.upsert{ pos = pos, role = "partial", item = nil, free = UNKNOWN }
end

function M.add_stock(pos, item)             -- 库存箱须显式登记（绑定物品）或由 plan_for 认领未绑定 stock
  ChestNote.upsert{ pos = pos, role = "stock", item = item, free = UNKNOWN }
end

function M.del(pos)                         -- 不区分角色，按位置移除
  ChestNote.del{ pos = pos }
end

-- 决策入口：{ role = "partial"|"stock", pos = blockpos } | nil
function M.plan_for(id)
  local p = partials_for(id)[1]
  if p then return { role = "partial", pos = p.pos } end

  for n in ChestNote.all() do                       -- 该物品的库存箱
    if n.role == "stock" and n.item == id and n.free ~= 0 then
      return { role = "stock", pos = n.pos }
    end
  end

  for n in ChestNote.all() do                       -- 认领一个未绑定的 stock 箱
    if n.role == "stock" and n.item == nil then
      ChestNote.upsert{ pos = n.pos, role = "stock", item = id, free = UNKNOWN }
      return { role = "stock", pos = n.pos }
    end
  end
  return nil
end

-- 开箱校验（bslib.move 的 on_open 回调）：缓存失效、插件 GUI 防护、自由度实测回写。
-- free 以"该物品可放件数"计：空格数 × 该 stack 的 max_count（组件真值）。
function M.validate(pos, win, filter)
  local n = ChestNote.find{ pos = pos }
  if not n then
    error{ kind = "cache.missing", detail = tostring(pos) }
  end
  if win:type() == "custom" then                    -- 插件菜单：禁止复合传送，移出缓存
    ChestNote.del{ pos = pos }
    error{ kind = "policy.gui_window", detail = tostring(pos) }
  end
  local empty = 0
  for _, s in ipairs(win:slots()) do
    if not s.item then empty = empty + 1 end
  end
  local id = (filter and filter.id) or n.item
  local free = empty * (id and (data.stack({ id = id }).max_count or 64) or 1)
  ChestNote.upsert{ pos = pos, role = n.role, item = n.item or id, free = free }
end

-- 转移后回写缓存（moved = 实际放入数）。
-- moved<=0 是硬证据：目标已满/不可放 → free=0 降级排名（评审修订：原实现在 free 未验证时
-- 按"整箱空"估算，满箱会永远排第一，靠看门狗反复杀任务——活锁）。
function M.after_transfer(plan, id, moved)
  local n = ChestNote.find{ pos = plan.pos }
  if not n then return end
  if moved <= 0 then
    ChestNote.upsert{ pos = plan.pos, role = n.role, item = n.item or id, free = 0 }
    return
  end
  local cur = (n.free and n.free >= 0) and n.free or (27 * (data.stack({ id = id }).max_count or 64))
  local free = math.max(0, cur - moved)
  ChestNote.upsert{
    pos  = plan.pos,
    role = n.role,
    item = (n.role == "stock") and id or (n.item or id),   -- 不满盒首转即绑定物品
    free = free,
  }
  if plan.role == "partial" and free == 0 then
    log.info("不满盒 %s 已满，同类物品后续轮转库存箱", tostring(plan.pos))
  end
end

function M.reset_pending()                          -- 暂停/掉线恢复：缓存可信度清零
  for n in ChestNote.all() do
    ChestNote.upsert{ pos = n.pos, role = n.role, item = n.item, free = UNKNOWN }
  end
end

return M
