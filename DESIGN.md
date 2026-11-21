# bot-script 设计文档

> 一套描述 Minecraft bot 行为的脚本语言与运行时，使**同一份脚本**可以安全可控地跑在不同 MC 版本、不同宿主上：
> 基于 mod 的 Fabric/Java 客户端、基于协议的 mineflayer / mcc。

> **实现状态（v0.2，2026-11）**：本文的「共享纯 Lua 核心 + 多宿主」决策未变，但边界契约已按
> `ARCHITECTURE-REFACTOR.md` 落地为**契约先行**：`contracts/host-abi.yaml` 是 op/参数/gate 的唯一真源，
> 四份生成物（Lua bridge / Node op 表 / Java op 表 / bot-api.d.lua）由 `tools/codegen.mjs` 产出；
> Lua 唯一源码在 `runtime/lua/core`（LuaJ 补丁在 `runtime/lua/compat/luaj.lua`）；
> Node 宿主实现在 `hosts/node/`（engine.js 仅为 <300 行组装），Fabric 宿主为
> `AbiDispatcher / McState / LuaRuntime / DataRegistry / HttpApi`。
> 下文出现的 `engine.js`/`LuaHost`/`CommandBus` 等名称属于历史描述，对应的新实现见 README 的目录结构。

---

## 0. 目标与非目标

### 目标

1. **一次编写，多后端运行**：脚本不感知后端差异（fabric mod / mineflayer / mcc）、不感知 MC 版本差异。
2. **安全**：脚本在沙箱内运行，无系统访问；所有对外动作（移动/挖掘/攻击/发言/命令）经过策略层白名单与限速。
3. **可控**：任何任务可被外部随时中断；长操作可取消且有清理钩子；实例级 **pause/resume** 一键冻结与恢复（覆盖急停、预算耗尽、断线），停机 = 进程退出。
4. **从真实需求出发**：搬运、追杀、整理、银行四个场景逐一验证抽象的完备性。

### 非目标（v1）

- 不追求跨后端像素级一致的行为表现（如寻路路线完全相同），只保证语义等价。
- 不做合成/附魔/交易等复杂 GUI 的完整抽象（预留能力位，后置）。
- 不做分布式多 bot 协同（预留地址空间，后置）。

---

## 1. 总体架构：共享纯 Lua 核心 + 三栈独立宿主（v2 定稿）

**核心决策：没有中心引擎进程。三个宿主各自内嵌 Lua 解释器，直接加载执行同一套脚本包；
每个宿主标配 HTTP 控制通道，供外部面板 / MCP / agent 直接测试与调整。**

```
共享纯 Lua 核心（同一份文件，三栈复用，逻辑只写一遍）
  bootstrap.lua   调度器 · 任务 · 事件总线 · 容器句柄（纯 Lua，无 IO）
  lib/bslib.lua   可选通用库（look.at · equip_best · ensure_holding）
  lib/container_lib.lua 可选容器库（open 编排 · withdraw/deposit/move）

宿主 = 原生桥 + 内嵌 Lua（各自独立进程，即 bot 本体）
  mineflayer 宿主   Node 程序：wasmoon + engine.js `__` 桥（契约 op 表生成）
  fabric mod（已归档，archive/fabric-mod）  JVM：Luaj（LuaRuntime `__` 桥）+ McRuntime + GUI 管理界面
  mcc 宿主（规划）   C#：MoonSharp/NLua 桥 + 动作实现

每宿主内置协议通用 HTTP API（常开、只绑 127.0.0.1、token 启动时生成并打印，规格见 CAPABILITIES.md §17）
  /state /params /pause /resume /tasks /logs /store /caps —— 测试、面板、MCP 同一入口
```

### 为什么放弃"单引擎 + 驱动协议"（v1 → v2 演进）

- **Lua 是唯一三栈都有成熟嵌入器的语言**（wasmoon/Node · Luaj/JVM · MoonSharp/C#）：把逻辑放进共享 Lua 文件，原生面收窄到"桥 + 契约 op 表"，可移植性不靠协议靠**共享文件**；
- **无进程拓扑**：部署 = mods 文件夹（或一个可执行文件）+ 脚本包目录；无 WS 层、无跨进程延迟、无"引擎进程挂了 bot 呆滞"的故障面；
- v1 驱动协议实现已清除（`mod/legacy-ws-client/`、`drivers/fabric` WS 服务端、`test/fabric-live.js` 均已删除）；语义对齐经验沉淀为共享测试锁（`LuaRuntimeTest` / `RuntimeContractTest` 模式）。

### 宿主分层（原"驱动协议"职责，进程内化为桥）

| 层 | 内容 |
|---|---|
| 连接 | 登录 / keepalive / 重连 / 版本与能力（feature flags）上报 |
| 数据面（入） | 包流 → 规范化事件 schema：世界更新、实体流、自身状态、窗口内容、聊天/HUD、kick/teleport（纯翻译，无逻辑） |
| 动作面（出） | **按原版发包建模**：`act.look`（rotation）/ `act.input`（player_input 状态位）/ `act.dig`·`act.dig_stop`（player_action）/ `act.use_block`（interact + face/cursor/intent）/ `act.use_entity`（attack/interact/interact_at）/ `act.swing` / `act.use_item`（start·release）/ `act.select_slot` / `act.drop` / 窗口 click（state_id）/ `act.chat_send`（chat·command）；策略门控与限速在宿主 dispatch 一处执行 |
| 可选智能 | 寻路器（Baritone / mineflayer-pathfinder / mcc 内建）；缺失时核心做 `act.input` + `act.look` 直线退化（P2） |

> 完整动词表与宿主实现量评估见 `CAPABILITIES.md` §14；HTTP 控制通道规格见 §17。

## 2. 脚本语言设计

### 2.1 形态（定稿）：Lua 5.4 + 声明式注册层

脚本语言采用标准 Lua 5.4（引擎经 wasmoon 嵌入），外加一层薄的声明式注册层（`params` 只读视图 / `state` 小状态 / `task` / `on_*`；参数 schema 只在 bot.yaml，加载期解析）。取舍结论：

- 引擎只实现一次（Node）后，"三宿主可移植"由 Driver Protocol 承担，自研解释器失去主要理由；
- Lua 协程恰好是"可取消协作任务"的正确原语（§2.2）；沙箱只暴露能力 API，剥离 `os/io/require/debug`，WASM 内存上限 + 指令预算兜底；
- 静态分析三层：LuaLS（能力 API stub → 补全/类型检查/无头 CI）、luacheck/selene（自定义 std = 能力白名单）、引擎 luaparse 领域 pass（领域 lint、能力需求提取比对 driver flags）；
- 将来若需更强类型，Teal（类型化 Lua 方言，编译回标准 Lua）是无痛升级路径。

**语言候选复核（并发/异步视角）**：JS/TS 是唯一"更方便"的真实候选（引擎原生、async/await、AbortController 级联取消），但只在**脚本全部来自可信作者**时成立——Node 沙箱不设防（`vm` 非安全边界、vm2 停止维护、isolated-vm 过重）；Kotlin 协程 / C# async / Go goroutine 的结构化并发最优雅，但会把引擎绑死在对应运行时、破坏三驱动架构；Luau/Roblox 的 `task.spawn/delay/cancel` 模型即本设计任务 API 的形态——证明这套模型是**库级**可实现的，Lua 协程就是底层机制。结论维持 Lua；若将来定位变为"仅可信作者"，换 JS 前端是逃生门（能力面与驱动协议均与语言无关）。

### 2.2 编程模型（定稿）：事件驱动分发 + 协程顺序体

**一句话：事件定义"何时做"，顺序语句定义"做什么"。** 事件处理器是脚本唯一入口（分发）；处理器体是平铺直叙的顺序代码，动作型调用**隐式挂起**直到完成或失败——写起来同步，跑起来异步。

候选风格对比：

| 候选风格 | 结论 |
|---|---|
| 纯事件驱动（回调/手写状态机，mineflayer 原生风） | ✗ 搬运 bot 的 8 步顺序流要拆成一串事件接力，错误处理碎片化 |
| 显式 async/await | ✗ Lua 协程下是纯语法噪音 |
| 行为树/目标系统 | 不进语言层；确有需要时作为 bslib 模式提供 |
| **事件触发 + 协程顺序体** | ✓ happy path 一眼到底；取消点=挂起点；try/catch 集中；协程栈即逻辑栈 |

规则细则：

1. **动作 vs 查询**：动作型调用（`goto/open/attack/say/use_item…`）挂起协程直到完成，返回**跨平台 Result**（`{ok=true,value}` / `{ok=false,error={code,message}}`），确定性失败不再抛异常；查询型调用（`pos/health/slots/block…`）立即返回原值（读引擎缓存）。两类在 stub 注解与文档中显式区分。
2. **并发 = 任务**：事件处理器被引擎 spawn 成任务（处理器内可挂起而不阻塞其他事件）；单线程协作式，脚本间无数据竞争、不需要锁。互斥仅限少数天然排他资源（移动路径、容器窗口）；朝向 yaw/pitch 是无状态写入（last-writer-wins），多任务并行操控身体无需许可（CAPABILITIES.md §3.1）。周期任务防重入：在任务声明处 `task("organize", { single = true }, fn)`，重复触发被丢弃。
3. **循环即状态机**：反应式行为（追杀）用任务内 `while` 循环表达，不用事件接力；目标移动导致 goto 失败 → 循环自然重试。反之，顺序流程禁止手写状态机（风格指引）。
4. **等待原语**：`wait_until(pred, {timeout, poll})`、`await_chat(rex"…", timeout)`、`time.sleep(d)`；事件订阅（`entity.gone` 等）留给"不属于任何任务的全局反应"。
5. **结构化并发组合子**（bslib）：`parallel{f, g}` 全完成；`race{f, g}` 先完成者胜、另一个被取消；`with_timeout(d, f)`。
6. **取消是独立的控制事件**：在下一个挂起点展开当前任务；取消带**来源标记**——`race`/`parallel` 只吞自己子分支的取消，父任务/外部取消穿透一切组合子；取消不是 Result 错误、不进 `on_error`。`parallel` 任一分支 Lua 原生错误 → 取消其余、重抛首错。原生 `pcall` 会误捕取消（lint 对"包裹挂起点的裸 pcall"告警），脚本用 `try{ … }` 糖（自动重抛 `task.cancelled`）；`on_cancel(fn)` 做清理（关窗口、停走）。
7. **纪律与后盾**：循环体内必须有挂起点——静态 lint 警告 + 引擎指令预算硬保底（`debug.sethook`）；有 `wait_until` 不写 sleep 轮询（lint 保守警告）；确定性原则不变（脚本侧纯逻辑确定，世界输入异步到达；dry-run 只记日志不执行）。

### 2.3 语法要点与能力面

- **数据**：Lua 原生值 + 引擎记录类型（`vec3 / blockpos / region / duration / itemstack / window / entity / task`；活体句柄语义见 CAPABILITIES.md §2）。物品过滤就是普通 table 或谓词函数，无专门类型。
- **声明式注册层**：参数 schema 只在 `bot.yaml`（`type/default/required/help/visible`，脚本内不再有 `params{…}` 声明）；`state.get/set/all/delete/update/seen` 为实例级小状态；`task "名" function() … end`、`on_start / on_pause / on_resume / on_chat / on_timer / on_cancel`——加载期完成 schema 校验、静态检查挂钩。**没有命令声明层**（无 `on_command` / 命令参数注入）。
- **模块系统**：标准 `require`（模块 = 返回 table 的 Lua 文件，`package.loaded` 缓存），但 `package.searchers` 由引擎替换——仅允许引擎可选库（`bslib` / `container_lib`，`package.preload` 预载）与本实例脚本目录，其余拒绝；每个脚本实例持有独立 `package.loaded`（脚本间状态隔离；热重载=引擎清缓存后重 require）。**文件一律 `.lua`**；"入口 vs 模块"按角色区分——入口 = `bot.yaml` `scripts:` 列出的文件，模块 = require 图可达的其余文件；声明层（on_*/state 初始化）只允许出现在入口（参数 schema 在 bot.yaml），静态检查按角色套规则，与扩展名无关。
- **错误模型**：动作/ABI 失败 = Result（`error.code` 稳定跨宿主：`nav.unreachable / container.missing / permission.denied / policy.blocklist / runtime.paused / internal …`）；Lua 原生 `error()` 与守卫 `guard(cond, fn)` 仍按任务级失败处理；`try{…}` 糖自动重抛取消。
- **能力面**：`nav / world / entity / container / inv / combat / chat / self / session / msg / time / task / log / state / params / caps` 命名空间注入环境；行为策略复合在**可选 Lua 库** `bslib` / `container_lib`（不占 ABI、不注入全局，脚本 `require`；见 CAPABILITIES.md §13）。**能力 API 权威版本见 `CAPABILITIES.md`。**
- **物品知识来自 ItemStack 组件**：堆叠上限 `max_stack_size`、耐久 `max_damage/damage`、攻击属性
  `attribute_modifiers`（attack_damage/attack_speed）都从 `item.stack` 读，**不按 item id 查表、不做版本判断**；
  跨宿主只共享非物品数据（容器方块表）。

### 2.4 四场景样例（Lua 定稿语法）

**① 搬运 bot** —— 验证：寻路、容器、配置绑定、区域围栏。

```lua
params {
  from = { type = "blockpos", required = true, visible = true },   -- 源箱子
  to   = { type = "blockpos", required = true, visible = true },   -- 目标箱子
  item = { type = "table" },             -- 结构过滤 {id=...}；谓词函数只能作脚本内默认值（无法经 yaml/CLI 表达）；nil = 不过滤
}

task("haul", { single = true }, function()
  -- container_lib.move：多趟复合（走-开-取-关-走-开-放-关 循环）——背包满自动多趟，返回净转移件数
  local moved = clib.move(params.from, params.to, params.item)
  log.info("搬运完成：%d 件", moved)
end)

on_start(function() task.spawn("haul") end)   -- 防重入 single 声明在 task 处，spawn 不带选项
```

**② 追杀 bot** —— 验证：循环即状态机、race 守护、取消与急停。

```lua
params {
  range     = { type = "number", default = 64, visible = true },
  blacklist = { type = "list<string>", default = {} },
  home      = { type = "blockpos", visible = true },   -- 残血撤退点
}

on_chat(rex"^!kill (?<target>\w+)$", { source = "player" }, function(m)
  if not is_op(m.sender) then chat.reply("拒绝执行") return end   -- is_op：脚本自管的名单
  if contains(params.blacklist, m.target) then chat.reply("拒绝执行") return end
  local t = entity.nearest{ type = "player", name = m.target, alive = true, within = params.range }
  if not t then chat.reply("找不到 " .. m.target) return end
  task.spawn("hunt", t)
end)

on_chat(rex"^!stop$", { source = "player" }, function(m)
  if not is_op(m.sender) then return end
  task.cancel_all()                                  -- 全局急停（急停本身仍是宿主 pause）
end)

task("hunt", function(t)
  while entity.exists(t) and t.alive do
    bslib.equip_best("weapon")                    -- 可选库（local bslib = require "bslib"），换持走 inv.equip
    local retreated = false
    race{                                         -- 主行为 + 残血守护
      function()
        if nav.distance_to(t) > combat.range() then
          nav.walk(t.pos, { arrive = 2.5, timeout = 5 })   -- 目标在动，失败由循环重试
        else
          bslib.look.at(t)                        -- 攻击前瞄准（attack 原语不校验朝向，瞄准属行为策略）
          combat.attack(t)
          wait_until(function()                       -- 冷却由脚本决定；数据缺失时自行给节奏下限
            local cd = combat.cooldown()
            return cd == nil or cd <= 0
          end)
        end
      end,
      function()
        wait_until(function() return self.health() < 10 end)
        retreated = true                          -- 守护胜出，主行为被取消
      end,
    }
    if retreated then nav.flee(params.home); chat.reply("残血撤退") return end
  end
  chat.reply("目标已倒下")
end)
```

**③ 整理 bot** —— 验证：定时任务防重入、缓存校验、看门狗。

```lua
-- 参数 schema 在 bot.yaml（input / stock_zone / partial_chests）；脚本只读 params.*
-- 箱子缓存是实例级小状态：每箱一个键 chest:<x,y,z>，值 { role, item, free }

on_timer(sec(30), function() task.spawn("organize") end)

task("organize", { single = true }, function()
  local w = container.open(params.input)
  for _, s in ipairs(w:slots()) do
    if s.item then
      local target = bslib.best_partial_for(s.item.id, params.partial_chests)
                  or bslib.stock_chest_for(s.item.id)
      if not target then log.warn("无去向: " .. s.item.id) break end
      bslib.move(params.input, target, { id = s.item.id })  -- 多趟复合；on_open 校验缓存并实测空槽回写
    end
  end
  container.close(w)
end)
-- 进度看门狗：task.progress 自报或默认信号，连续无净进度 → 取消任务 + 告警（防不满盒间无限倒腾）
```

**④ 银行 bot** —— 验证：聊天解析、小状态原子读改写、回执超时挂账、去重。

```lua
-- 小状态：account:<name> 余额 / intent:<id> 意图；大账本由外部事件流/业务系统承担
on_chat(rex"^(?<from>\w+) 存入了? ?(?<amount>\d+)$", { source = "system" }, function(m)
  if state.seen(m.raw, sec(5)) then return end       -- 内容寻址去重：防同文重发（可靠性上限见 examples/bank）
  state.update("account:" .. m.from, function(a)
    a = a or { player = m.from, balance = 0 }
    a.balance = (a.balance or 0) + tonumber(m.amount)
    return a
  end)
end)

on_chat(rex"^pay (?<to>\w+) (?<amount>\d+)$", { source = "player" }, function(m)
  if not contains(params.bank_ops, m.sender) then chat.reply("权限不足") return end
  local to, amount = m.to, tonumber(m.amount)
  local ok = false
  state.update("account:" .. to, function(acc)           -- 原子读改写：并发请求不双花
    if not acc or acc.balance < amount then return acc end
    acc.balance = acc.balance - amount
    ok = true
    return acc
  end)
  if not ok then chat.reply("余额不足") return end
  chat.run_command("/pay " .. to .. " " .. amount)
  local rr = await_chat(rex("已向\\s+" .. to), sec(5))  -- Result；超时 value = nil
  local got = rr.ok and rr.value ~= nil
  Intent.mark(pay_id, got and "done" or "pending")
  if not got then chat.reply("支付确认超时，已挂账待对账") end
  -- 超时**不回滚**（超时 ≠ 失败）：迟到回执由 "已向 <player>" 回执处理器按 id 核销，
  -- 杜绝"已回滚 + 迟到回执"双重入账；真失败由运维对账处理（宁可挂账，不可双花）
end)
-- 意图日志(write-ahead)：pending 由回执/对账收口；入账走 system 通道 + 品牌模板校验，
-- 转账/取款只认 player 通道（伪造面分析见 examples/bank/bank.lua 头注释）
```

---

## 3. 能力抽象（HAL）细则

> 本章为早期综述；**权威细版以 `CAPABILITIES.md` 为准**（含 msg/HUD 域、session 域、点击协议全集、bslib 三层分工与 P0–P2 优先级）。

### 3.1 统一数据模型

| 概念 | 定义 | 版本策略 |
|---|---|---|
| 物品 id | 规范名 `minecraft:iron_sword` | 引擎内置 规范名↔各版本数字id/名称 映射表，随驱动版本上报自动选取 |
| ItemStack | `{id, count, meta_fingerprint?}` | NBT/组件差异折叠为 fingerprint，脚本默认按 id 比较，需要精确匹配时显式用 fingerprint |
| 位置 | `vec3`（脚底中心，double）/ `blockpos`（整数） | 明确"脚底"约定，避免各后端 eye/feet 混用 |
| 实体 | `{id, type, name?, uuid?, pos, look, health?, equipment?}` | 不可观测字段为 `unknown`（health 在协议端对玩家不可见等），HAL 提供降级策略 |
| 容器 | 以 blockpos/entity 为身份；**同一时刻至多打开一个**（MC 语义） | open 是异步往返（服务器确认）；掉线/破坏自动失效并抛 `container.closed` |
| 聊天消息 | `{text, sender?, sender_kind: player|system, raw}` | sender 只按协议事实解析（playerChat 的 sender UUID）；system 消息不猜文本；raw 始终保留完整原文 |

### 3.2 能力域 API 与特性矩阵

每个能力域在驱动协商时上报 feature flags，脚本可查询 `caps.container.transfer_bulk` 等；不支持的复合操作由引擎基于原语**降级实现**（可能更慢、更多步），并打日志标注。

| 能力域 | 原语（驱动实现） | 复合（可选库实现，语义跨后端一致） |
|---|---|---|
| nav | path_to/cancel/进度事件 | goto_near、超时/代价上限、can_reach（follow 已移除） |
| world | 方块/实体变更流、定点读、raycast | scan、缓存新鲜度管理 |
| container | open/close、窗口读取、**点击协议全集** | （container_lib）transfer/withdraw/deposit/move、free_space |
| entity | 实体流、（部分后端）读写 | find/nearest 过滤、威胁评估 |
| chat/msg | 发送、聊天与 HUD 包流 | pattern 解析、await_chat、限速、去重、模板库 |
| interact | attack/use_item/dig/place/look | （bslib）equip_best；cooldown 由脚本读属性 |

### 3.3 版本差异的三条处理原则

1. **能内置就内置**：物品属性、攻击冷却（1.9+）、容器槽位数等静态知识进引擎数据表，按服务端版本选表。
2. **能降级就降级**：缺 bulk-transfer 就循环单槽点击；缺寻路就只支持 `can_reach=true` 的目标并明确报错。
3. **绝不静默**：能力缺失、字段 unknown、缓存过期，都显式暴露给脚本与日志。

---

## 4. 运行时

- **调度**：事件循环 + 协程任务；任务有优先级；**资源仲裁**——"移动权"与"容器会话"是互斥资源，被占默认排队，`{steal=true}` 可抢占；实例级 **pause 门控**冻结一切任务（不经仲裁）。
- **暂停**：pause = 冻结全部任务于挂起点 + 停走 + 停 timer + 告警；进行中的移动调用以 `runtime.paused` 失败（任务不销毁，恢复时于冻结点重抛走正常重试）。触发：宿主 `/pause`、围栏越界、budget 耗尽、断线自动暂停；`/resume` 反向恢复。脚本挂 `on_pause`/`on_resume` 做清理与重检。
- **看门狗**：任务级进度检测（`task.progress` 自报为准，默认信号兜底；连续无净进度 → 取消该任务 + 告警）；全局指令预算与墙钟超时（耗尽 → 自动 pause + 告警）。
- **可观测**：每个能力调用记结构化日志（任务、参数、结果、耗时）；任务状态可导出；JSONL 动作日志支持回放；dry-run。
- **热重载**：脚本变更后新任务用新代码，运行中任务可选迁移（到达操作边界后切新版本）或保持旧版本至结束。

---

## 5. 安全、策略与持久化

### 5.1 策略层（实例部署配置，宿主强制，默认开放）

边界由**实例部署配置**授予（每服务器/每世界一份，§6），不由脚本包携带——包跨服务器通用，边界随环境走。宿主强制执行，脚本不可绕过：

```
movement:  region fence（活动围栏；越界 → 引擎自动 pause + 告警，可恢复）
blocks:    dig/place 门控（缺省允许；显式 false/deny 才禁）
combat:    配置 targets 后才限制攻击对象类型；max_engage 可选
chat:      act.chat_send 按 kind 限速：chat = say_rate（缺省不限）；command = 命令白名单（非空才限制）
container: 容器访问门控（缺省允许；显式 false/deny 才拒）
packets:   自定义网络包（custom payload / 插件消息）权限位：缺省拒绝，显式 true/allow 才开放
budget:    每任务/每小时动作次数与时长上限；耗尽 → 自动 pause + 告警
```

**默认开放**：boundary 或字段未配置 = 不限制；只有显式写入的字段才收紧动作。
**唯一例外 = `packets`**：第三方插件通道（servux 等）不在常规动作语义内，按权限位显式授予；
未授予时出站 `net.send` 返回 `policy.blocklist`，入站 `net.payload` 事件不下发。
平台不内置 owner/op/白名单判定——聊天控制的权限模型由脚本自己实现（参数、KV 或代码常量）。
（查询与 params 可用，一切动作被拒）。把边界从包里拿走不是把安全拿走，而是把授权责任交给部署者。
策略违规对脚本表现为可捕获的 `permission.denied`（脚本可优雅处理）；越界/预算耗尽为引擎自动 pause（任务冻结不销毁，可恢复）。

### 5.2 实例状态（localStorage 语义）

- 脚本视图只有 `state.get / all / set / delete / update / seen`：key→JSON，无 schema、无查询、无多键事务。
- **配额**：单值 ≤16KB、总量 ≤256KB；超限写入返回 `state.quota`，不静默淘汰。
- **原子读改写**：`state.update(key, fn)` 在引擎单线程内串行执行；fn 内禁止挂起点（违反 → `state.update_yielded`，不写入）。
- **存储位置由宿主固定**：Node 为实例目录 `state/state.sqlite`（WAL，100ms 合并 flush + 停机 flush），Fabric 为 `botscript/state/state.json`。**包无权指定路径**（旧 `bot.yaml persist:` 已删除）。
- **复杂数据不留在实例里**：通过 `events.emit` 交给外部系统（外部负责持久化与回执）；平台只提供实时通道。

### 5.3 参数（YAML 契约，评审定稿）

- **唯一声明源**：`bot.yaml params`（`type/default/required/help/visible`）；Lua 内不再有 `params{…}` 声明，`params` 只是只读视图。
- **初值与优先级**：包 schema 默认值 < 实例参数值（平台 `instances.params_json` 是显式设置值的唯一真源）。部署配置不携带业务参数——由平台装配 deploy 时下发。
- **修改渠道按 `visible` 划分**：`visible=true` → 驱动人机界面可直接改（fabric mod 的 GUI 设置页、mcc 的 `param get/set`）；`visible=false` → 仅引擎控制 API（CLI / HTTP `/params`）。所有渠道进入同一 `params.set` 管线：schema 校验 + 平台 params_json 回写（脚本侧可挂校验钩）。
- fabric GUI 的写入以驱动通道的权限身份进入控制总线（默认 owner 级，可配置）。
- **函数型参数**（过滤器谓词）无法经 yaml/CLI 表达，只能作为脚本内默认值；schema 校验对 table 型做结构校验。
- **热生效契约**：脚本每次读取取当前值（`params.input`），不做快照；需要稳定的旧值时由脚本自行局部保存。

### 5.4 控制：平台原生方案 + 协议通用 HTTP API

控制面分两层，最终进入同一套 HTTP/控制通道、同一 Bearer token 鉴权：
- **平台原生控制方案**（人的日常入口）：fabric/游戏内 = 游戏聊天通道 + Mod Menu 设置页；mineflayer = 宿主 CLI；mcc = 自身控制台。
- **协议通用 HTTP API**（程序化入口，三宿主同 schema，规格见 CAPABILITIES.md §17）：MCP/agent/面板用它读状态、改 params、暂停/恢复、拉日志、查实例状态——验收全程无头。HTTP API 宿主**常开**（只绑 127.0.0.1），端口/token 自动管理，不在任何配置里声明。
引擎内建控制：**pause / resume / status**（不经脚本，owner 级）——急停即 pause，无 panic 关键词。

---

## 6. 部署形态：包 / 实例边界 / 连接，三层分离

一个脚本包在多服务器、多种世界、各个地方使用——**凡是随环境变化的东西都不在包里**。

| 层 | 内容 | 分发 |
|---|---|---|
| **脚本包**（能力自述） | name、scripts、params schema（含默认值） | 随包分发，跨服务器通用 |
| **实例边界**（限制） | fence、dig/place、combat 规则、chat 限速与命令白名单（全部可选；缺省不限制） | 每服务器/每世界一份 |
| **连接**（宿主部署） | 服务器地址、账号凭据 | 宿主各平台原生形态 |

```yaml
# bot.yaml —— 脚本包清单（随包分发；不含任何边界与凭据）
name: hauler-1
scripts: [haul.lua]
params:
  from: { type: blockpos, required: true }    # schema + 默认值；实例值由平台管理
  to:   { type: blockpos, required: true }
```

```yaml
# 实例部署配置（每服务器一份；形态随宿主：mineflayer=启动参数/yaml，fabric=游戏目录配置，mcc=控制台）
package: ./hauler-1                # 指向脚本包
server: 127.0.0.1:25565
account: bot1                      # 凭据：用户名（offline）| {username, password}（微软 OAuth）
                                   # | {auth: session, username, uuid, accessToken}（托管平台注入，引擎不做 OAuth）
boundary:                          # 限制边界：全部可选，缺省不限制（§5.1）
  fence: [[80,-30],[140,20]]
  allow_move: true                 # 移动总开关：false 同时禁用 nav.walk/nav.hop
  blocks: { dig: deny, place: deny }
  packets: true                    # 权限位：允许自定义网络包收发（缺省拒绝；servux 等插件通道）
  rate: { actions_per_sec: 20 }    # 每秒发包上限；省略 = 不限（与 budget.actions_per_hour 分工不同）
  chat:
    say_rate: "6/min"
    commands: ["/msg", "/pay"]                # 精确白名单（先判）
    commands_deny: ["^/gamemode\\s+creative"] # 正则黑名单（命中即拒，先于 allow）
    commands_allow: ["^/msg\\s+.*"]           # 正则白名单（非空时必须命中其一）
  budget: { actions_per_hour: 20000 }         # 每小时总量；超额整实例 pause
```

**边界分层**：`chat.commands`（精确）→ `commands_deny`（正则）→ `commands_allow`（正则），逐层只能更严，
配置写宽也无法绕过前一层。速率限制只丢弃当次动作（脚本收到 `permission.denied` 可退避），
`budget.actions_per_hour` 则超额暂停整个实例。

**不多配的**：业务参数不在部署配置里——包给默认，实例值由平台 params_json 管理并在部署时下发；
HTTP API 是宿主常开能力（只绑 127.0.0.1、默认端口冲突自动顺延、token 启动时生成并打印到控制台/日志），
绑定覆盖属宿主启动参数（env），不存在于任何通用配置。
**默认开放**：包不含任何边界；未配置 boundary 的实例不限制动作，显式字段才收紧。宿主强制执行边界（脚本不可绕过，§5.1）。
（实现现状（已落地）：mineflayer 宿主以**部署配置 yaml** 启动（`node engine/cli.js run/bank-demo.yaml`），
包清单从 `package:` 目录加载；状态路径由宿主固定为实例目录下的 `state/`（包无权指定）。
Fabric 宿主已归档到 `archive/fabric-mod/`，不再构建/发布；历史实例配置为
`<游戏目录>/config/botscript-mod.json`（package + boundary）。）

---

## 7. 仓库结构与里程碑

```
/engine/lua  共享纯 Lua 核心：bootstrap.lua（调度/任务/句柄）+ bslib.lua（行为策略），三栈复用
/engine      mineflayer 宿主（Node）：wasmoon + engine.js `__` 桥 + cli + HTTP 控制
/mod         fabric 宿主源码已归档到 `/archive/fabric-mod`（不构建、不发布；日后重启前需对齐 ABI）
/hosts/mcc   mcc 宿主（C#，规划）：MoonSharp/NLua 桥 + 动作实现 + HTTP 控制
/examples    bank / organizer / coal_guard / heart（验收集，各含 bot.yaml + .lua 入口与模块；
             haul/hunt 作为①②推导样例内嵌于本文档 §2.4）
/test        实连验收：live.js（含 HTTP 控制通道断言，无头闭环）
/tools       LSP、格式化、动作日志回放器
```

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 语言规范 + HAL 定稿 + 共享 Lua 核心抽取 | 示例脚本全部通过静态检查 |
| M1 | mineflayer 宿主（wasmoon 桥 + HTTP 控制） | 银行实跑 ✅；HTTP 九端点无头闭环实连 ✅（2026-09-09；2026-09-10 增 /eval） |
| M2 | ~~fabric 宿主 standalone~~ **已归档**（archive/fabric-mod；源码保留，不构建） | — |
| M3 | mcc 宿主（MoonSharp 桥 + HTTP 控制） | 同一脚本包三宿主通过；能力缺失显式降级 |
| M4 | 工具链（LSP/dry-run/回放）、多实例部署 | — |

---

## 8. 开放问题（下一步讨论）

1. 寻路约束的表达粒度：是否需要脚本声明"允许搭路/挖路"（Baritone setting 映射），以及协议端后端的等价物。
2. 聊天正则的多语言服务器（中/英消息）是否值得抽象"模板库"（社区共享 pattern 集）。
3. 整理 bot 的缓存一致性级别：开箱校验是否够，是否需要容器变更事件订阅（多数后端拿不到他人开箱事件）。
4. 多 bot 协同的预留：实例间是通过控制通道互通还是共享持久化库。
5. L1 通道的字节级 ICD 与二进制编码选型（MessagePack 起步）；客户端 mod 挂点的版本跟进排班（CAPABILITIES.md §16.6）。
