-- ============================================================
-- runtime/lua/compat/luaj.lua — LuaJ（Lua 5.2 语义）兼容补丁（唯一副本）
--
-- 只有 Fabric 宿主（mod/LuaRuntime）加载本模块；Node 宿主（wasmoon = Lua 5.4）不加载。
-- 兼容补丁从 bootstrap 正文移出：改调度的人不必再理解 LuaJ 语义。
--
-- 加载顺序要求：json.lua 之前（json 的 encode_number 依赖 math.type）。
-- ============================================================

-- 1) math.type：LuaJ 无 5.3 数值类型。一律按 float 编码路径（与 json.lua 原补丁一致）。
math.type = math.type or function() return "float" end

-- 2) atan2：5.4 把 math.atan2 并入 math.atan(y,x)（两参）。LuaJ 保留 math.atan2。
--    核心代码统一写 math.atan2 or math.atan —— 见 bslib 的 atan2 局部别名。
math.atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

-- 3) math.tointeger：LuaJ 无。供未来使用（当前核心不调用）。
math.tointeger = math.tointeger or function(n)
  if type(n) == "number" and n == math.floor(n) then return n end
  return nil
end

-- 4) 任务错误旁路开关：LuaJ 的 coroutine.resume 会把 table 错误字符串化，
--    丢失 kind/detail（is_cancel / on_error 依赖 table 形态）。
--    bootstrap 读到本开关后，把任务体包一层 pcall，真实错误经 __TASK_ERR 带出。
__COMPAT_TASK_ERR = true

-- 5) utf8 库：LuaJ 无 utf8。核心当前不使用；给出空壳避免脚本探测时报 nil 崩。
if utf8 == nil then utf8 = {} end
