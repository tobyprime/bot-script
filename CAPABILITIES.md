# bot-script 能力/控制项/抽象目录

> 推导方法：把四个需求逐步骤拆成"动作、查询、判断、故障、外部控制"，合并去重后得到统一目录。
> 每一项都标注：服务于哪些场景（①搬运 ②追杀 ③整理 ④银行）、优先级（P0=M1 搬运+银行可跑 / P1=M2 追杀+整理可跑 / P2=增强）。

---

## 1. 场景推导：每个需求逼出了什么

### ① 搬运 bot
- 步骤：走到源箱 → 开箱 → 取物（可能多趟，背包会满）→ 关箱 → 走到目标箱 → 放物（可能放不下）→ 关箱。
- **逼出**：寻路意图 API（`goto_near` + 到达/失败事件）；容器会话模型；**MC 约束——同一时刻只能开一个容器**，所以跨箱搬运只能经 bot 背包中转，API 形态必须是 `withdraw/deposit` 而非双箱互传；多趟复合操作 `move`；目标箱满时的溢出语义（`deposit` 返回实际放入数）；区域围栏策略；中途 abort。

### ② 追杀 bot
- 步骤：收到命令（鉴权）→ 查实体 → 循环{检查目标存活 → 选最强武器 → 距离远则追（目标在动！）、近则瞄准+攻击（受攻击冷却约束）} → 目标死亡报告 → 随时可中止。
- **逼出**：实体查询与**活体句柄**语义（`e.pos` 按帧快照活读：同一帧内复用，跨帧自动刷新；`e:refresh()` 强制取最新）；`nav.follow` 与重发路径；物品属性从 **ItemStack 组件**读（`attribute_modifiers` 的 attack_damage/attack_speed 排序 → `equip_best`；冷却按 attack_speed 计算）；聊天触发与脚本自管的操作员名单（`on_chat`）；战斗黑名单策略；任务取消与 `on cancel` 清理；自身死亡/重生时的任务处置。

### ③ 整理 bot
- 步骤：定时触发 → 开输入箱 → 逐物品决策（不满盒缓存 → 开箱校验缓存 → 尽量放入；溢出 → 该物品库存箱；无缓存 → 告警/跳过）→ 回写缓存 → 关箱。
- **逼出**：实例状态键值（每箱一个键、按免费空间排序）；**堆叠上限知识**（`item.stack` 读 ItemStack 组件的 `max_count`，不按 id 猜）才能算 `free_space` 和 `min(剩余, 空间)`；世界区域扫描 `world.scan`（发现库存区箱子，做缓存冷启动；不可用时降级为 params 手工播种）；**缓存开箱校验/闭箱回写**的一致性规则；params 外部增删不满盒列表；进度看门狗（连续无净进度即中止）。

### ④ 银行 bot
- 步骤：聊天正则匹配入账（区分真实玩家/系统消息）→ 去重 → 事务入账；取款命令 → 余额校验 → 发服务器命令 → 等回执（超时回滚）→ 回复。
- **逼出**：引擎侧正则（命名分组、跨脚本语义一致）；`sender_kind` 防伪造；去重助手 state.seen（重启不丢）；意图集合 + 外部事件流对账；`await_chat`（等回执，超时返回）；命令白名单策略（只许 `/pay`）；命令发送者权限分级；聊天/命令限速；审计日志。

---

## 2. 数据抽象（脚本可见的类型）

| 抽象 | 定义 | 关键语义 | 场景 |
|---|---|---|---|
| `vec3` | `{x,y,z}` double，**脚底中心** | 统一约定，杜绝各后端 eye/feet 混用 | 全部 |
| `blockpos` | 整数三元组 | 世界查询/容器身份 | ①③ |
| `region` | 两个角点 | 围栏、扫描、实体过滤 | ①③ |
| `duration` | 毫秒整数 + `sec(5)` 等助手 | — | 全部 |
| `itemstack` | `{id, count, meta?}` | id 为规范名 `minecraft:x`，引擎按服务端版本做映射 | 全部 |
| `window` | 会话对象（container.open 返回） | **互斥**：同时最多一个；异步打开（服务器确认）；失效抛 `container.closed` | ①③ |
| `entity` | 活体句柄 `{id, type, name?, ...}` | **帧快照**：动态字段（pos/equipment/alive）在同一帧（一次宿主交互）内读本地快照（零跨桥），跨帧后至多重取一次；`e:refresh()` 强制最新；`e:snapshot()` 返回冻结副本。新鲜度上界 = 一次宿主交互，受 `world.staleness` 约束 | ② |
| `chatmsg` | `{text, sender?, sender_kind: player\|system, raw, ts}` | sender 只按协议事实解析（playerChat 的 sender UUID）；系统消息 sender_kind=system，不按文本猜；结构化判断依赖 `sender_kind` 而非文本 | ④ |
| `task` | 句柄 `{id, name, status}` | 可 `cancel`；操作边界响应取消 | 全部 |

物品过滤无专门类型：普通 table（按字段匹配，如 `{ id = "minecraft:x" }`）或谓词函数，与 entity.find 的谓词同构。

物品知识（**真值来自 ItemStack 组件，不按 item id 查表**）：
- 物品属性：`item.stack` 读 ItemStack 组件（max_stack_size / max_damage / damage / attribute_modifiers 的攻击伤害与攻速）—— 服务于 ②③
- 方块属性：`world.block` 返回 block_state（属性 map）、硬度、方块实体；容器类方块清单（`contracts/data/containers.json`）—— 服务于 ③
- 规范名 ↔ 各版本 id 映射 —— 全部

---

## 3. 能力域 API

### 3.1 `nav` — 寻路（唯一留在驱动侧的能力，意图+事件）
```lua
nav.walk(target, opts)        -- target: pos|entity；opts {arrive=半径, timeout, max_cost, sprint}（不叫 goto：goto 是 Lua 保留字）
nav.goto_near(pos, radius)    -- 语法糖
nav.follow(entity, opts)      -- opts {distance, lose_radius}；目标移动自动重发（②）
nav.stop()
nav.distance_to(pos|entity) -> number
nav.can_reach(pos) -> bool
-- 事件：nav.arrived{target} / nav.failed{reason: unreachable|timeout|stuck|interrupted}
-- 资源：move 通道互斥；取消安全（stop 已发路径）
look.yaw(a)  look.pitch(a)  look.current() -> {yaw, pitch}   -- 最基础朝向 API：立即生效、无状态写入
nav.hop()                       -- 单次跳跃（按下~100ms）；脚本循环调用 = "边跑边跳"
nav.walk(pos, {keep_rotation=true})     -- 寻路期间不碰朝向（默认 false = 寻路自行控制朝向）
```
P0: goto/goto_near/stop/distance_to/can_reach；P1: follow。

**朝向无仲裁（评审定稿）**：yaw/pitch 是**无状态写入**（last-writer-wins），写入即生效、无许可、无清理——多任务同时操控身体不需要任何机制："spin 写 yaw、track 写 pitch"天然并行；同通道双写属脚本错误，直接可见而非被仲裁掩盖。寻路 vs 手动朝向的冲突用 `keep_rotation` 标志显式划分。`look_at(entity)` 只是 atan2 角度数学，**不进 HAL**：bslib 提供 `bslib.look.at(pos|e, {only="pitch"})`（角度计算 + 原语写入）。

**持续型伴随行为 = 脚本侧循环任务**（父任务结束/取消时子任务级联终止，`{detach=true}` 可脱离）：

```lua
-- 移动时持续看向最近的玩家（脚本自主实现）
task("walk_and_watch", function()
  task.spawn(function()                    -- 子任务：父任务结束/取消时自动终止
    while true do
      local t = entity.nearest{ type = "player", alive = true }
      if t then bslib.look.at(t) end       -- 角度计算 + look.yaw/pitch
      time.sleep(50)                       -- 20Hz 足够平滑；频率由脚本自定
    end
  end)
  nav.goto_near(params.exit, 3, { keep_rotation = true })   -- 寻路不碰朝向，朝向归子任务
end)                                       -- 到达 → 子任务级联取消；无状态写入，无需清理

-- yaw 匀速旋转，同时 pitch 持续锁定玩家：两个任务各写各的字段
task("spin_and_track", function()
  task.spawn(function()                    -- 写 yaw
    while true do
      look.yaw((look.current().yaw + 90) % 360)
      time.sleep(sec(0.5))
    end
  end)
  while true do                            -- 写 pitch
    local t = entity.find{ type = "player", within = 16 }[1]
    if t then bslib.look.at(t, { only = "pitch" }) end
    time.sleep(50)
  end
end)

-- 任意选择谓词：名单 + 盔甲匹配（选择逻辑就是 Lua，无任何框架约束）
local t = entity.find(function(e)
  return e.type == "player" and contains(watchlist, e.name)
     and e.equipment.armor.chest
     and e.equipment.armor.chest.id == "minecraft:diamond_chestplate"
end)[1]
```

- 参考实现（walk_and_watch / spin_and_track / 看向名单等）收入 **bslib/companion.lua**，用户 fork 改谓词即得自己的伴随行为；引擎与驱动**不内置**任何特定伴随行为。

### 3.2 `container` — 窗口会话与精确槽位操作
> 定位（评审定稿）：HAL 是**精确的窗口/槽位操作模型**，不设 withdraw/deposit 这类泛用语义——
> 它们预设了"存储容器"，覆盖不了服务器的自定义 GUI（以箱子为界面的菜单/传送/银行插件，槽位即按钮）。
> vanilla 或插件 GUI 的每一次交互都可归约为点击协议，因此原语集 = **点击协议全集**；
> withdraw/deposit/transfer/move 全部下沉 bslib，由点击原语复合（§13）。

```lua
container.open(pos|entity_id) -> Window  -- 互斥；异步等服务器确认；失败: container.missing|blocked|denied
container.current() -> Window?           -- 接住任何来源打开的窗口：NPC 右键、命令弹出的插件 GUI
on_event("window.opened", fn)            -- 事件目录名 window.opened（§4）；插件可从任意交互弹出 GUI，脚本必须能接管

win:type()     -- 原生窗口类型；识别不出 → "custom"
win:title()    -- 插件 GUI 的主要识别依据
win:size()  win:slots() -> [{index, item?}]  win:peek(i)  win:count(filter)  win:find(filter)
win:cursor() -> itemstack?

-- 点击协议全集（HAL 精确原语，经策略门控 + 限速）：
win.click(slot, {button="left"|"right", shift=bool})
win.click_hotbar(slot, n)          -- 数字键 1-9 与该槽交换
win.drop_slot(slot, {all=bool})    -- Q / Ctrl+Q
win.drop_cursor()                  -- 点击窗口外（slot=-999）
win.drag(slots, {button})          -- 拖拽分摊；start/slot/end 三步由驱动展开
win.swap_offhand(slot)             -- F 交换副手
-- 中键克隆（创造）、双击收集 → P2
container.close(win)
-- 不变量：同时至多一个窗口；bot 死亡/走远/服务器关闭 → 自动失效抛 container.closed

-- bslib 复合（构建在点击之上，脚本层名称不变，§13）：
--   withdraw/deposit/transfer(...) -> moved（moved<count=箱满 成为 bslib 约定而非引擎契约）
--   container.move 多趟、free_space（用 data.stack.max_count）
-- ⚠ 安全规则：未知窗口（win:type()=="custom"）上禁跑 bslib 传送复合——点击可能触发任意命令；
--   脚本应先 title()/已知布局识别，再决定精确点击还是复合传送
```
P0：open/close/slots/peek/click/click_hotbar/drop_slot/drop_cursor；P1：current/window_opened/drag/swap_offhand。
> 驱动映射（§14）：上述 win.* 具名糖在引擎侧展开为**单一动词** `window.click(slot, button, mode, n?)`，驱动不逐个实现糖。

### 3.3 `inv` — bot 背包（特殊容器 `"inv"` + 助手）
```lua
inv.count(filter) inv.has(filter)
inv.find(filter) -> slot?           -- 首个匹配槽位
inv.equip(filter|slot) -> bool      -- 换到主手（②）
inv.equip_best(kind) -> itemstack   -- kind:"weapon"，按 ItemStack 组件 attack_score 排序（②）
inv.held() inv.drop(filter, count)
inv.click(slot, opts) inv.cursor()  -- 背包窗口点击 / 光标查询：背包 = 0 号窗口，与 win.click 同一动词，引擎侧展开
```
P0: count/has/held/slots；P1: equip/equip_best/drop/find/click/cursor。

### 3.4 `entity` — 实体查询（声明式谓词宿主侧下推 + 帧快照句柄）
```lua
entity.find(pred, opts) -> [entity]  -- pred {type=, name=, uuid=, alive=, within=, region=, holding=item_id,
                                     --       equipment={helmet/chestplate/leggings/boots/offhand/hand = item_id|false}}
                                     --   holding：主手物品 id（= equipment.hand）
                                     --   equipment：按部件名匹配；写 false = 该部件必须为空
                                     --   pred 含 Lua 函数/未知键时自动回退全量投影，在 Lua 侧判定
                                     -- opts {full = true}：强制返回完整 StackInfo 装备（默认 core：装备只含 id/count）
entity.nearest(pred, opts) -> entity? -- ②；宿主按距离排序并只返回最近一条（Fabric 未下推时 Lua 本地兜底）
e.pos e.health e.alive            -- 帧快照活读：同帧复用，跨帧自动刷新（上界 1 次宿主交互）
e:refresh()                      -- 强制重取最新快照（需要逐字段实时值时用）
e.equipment.hand/.offhand/.boots/.leggings/.chestplate/.helmet   -- 每件 item 或 nil（槽位索引不外露）
                                  -- 默认 core 投影只含 {id,count}；需要 max_count/attributes 时用
                                  -- entity.find(pred, {full=true})，或对背包物品调用 data.stack
e:snapshot() e:id() e:exists()
-- 事件（可选订阅）：entity.appeared / entity.gone

-- 找头上戴钻石头盔的僵尸：
entity.find{ type = "minecraft:zombie", equipment = { helmet = "minecraft:diamond_helmet" } }
```
P1。

### 3.5 `world` — 世界查询（实时优先，协议流观测作兜底）
```lua
world.block(pos) -> {name, is_container, stale}  -- 实时读驱动当前方块；区块未加载时回落到观测值并置 stale=true
world.scan(region, pred, opts) -> [blockpos]  -- pred {type="container"|name 列表}
                                              -- opts {limit, on_progress}；预算受限、异步（③）
world.raycast(from, dir, max_dist)            -- P2
world.staleness(pos) -> duration              -- 新鲜度显式暴露
-- 事件（可选）：world.block_changed(pos)
```
P0: block/staleness；P1: scan；P2: raycast。
降级：`world.block` 走驱动实时定点查询 + `world.block_changed` 事件（无 chunk 流；ABI v2 已移除 `world_stream` 能力位）。

### 3.6 `combat` / 交互
```lua
combat.attack(entity)            -- 策略门控（②）
combat.range() -> number         -- 3.0（引擎约定）
combat.cooldown() -> duration    -- 1.9+ 按手持武器计算；旧版本 0（②）
-- attack 原语不校验朝向（原版服务器语义，由服务器距离判定命中）；是否瞄准属行为策略 → bslib.look.at + bslib.is_combat_ready
-- look_at → bslib（角度计算 + look.yaw/pitch，§3.1）
combat.use_block(pos)            -- 开箱/按钮（受 use 策略）
combat.dig(pos) combat.place(pos, item)   -- P2，默认策略禁止（①③默认不开挖）
```
P1: attack/range/cooldown/look_at/use_block。

### 3.7 `chat` — 聊天与命令
```lua
chat.say(text)                        -- 限速策略
chat.reply(text)                      -- 公开回复（与 say 等价）；双参私聊已移除
chat.run_command(str)                 -- 命令白名单策略（④：仅 /pay，首词元精确匹配）
chat.await_chat(pattern|pred, timeout) -> Result   -- value = 命名分组匹配表 | nil（④）
-- 语义：一条消息可同时命中 on_chat 与多个 pending await_chat（独立广播，互不吞并）
-- 私聊没有独立接口：原版只有公屏聊天，私聊是服务器命令，用 chat.run_command("/msg 玩家 文本")
-- 事件：
on_chat(rex"...", {source="player", from=名字?}, handler)  -- handler(m)：m.命名分组
-- 去重助手：state.seen（§3.10）
```
P0: say/reply/run_command/await_chat。

### 3.8 `self`
```lua
self.pos() self.health() self.food() self.held() self.effects()
-- 事件：self.damaged / self.died（之后自动重生，任务决定去留）/ self.respawned
```
P0: pos/health/held；P1: 其余。

### 3.9 `time` / `task` / `log`
```lua
time.sleep(d) time.now()
on_timer(interval, fn)  after(d, fn)
on_event(name, fn)                   -- 通用事件订阅（§4 表中无专用 on_* 的事件：nav.arrived / world.block_changed / session.ready…）
task.spawn(name, args...) -> task   task.cancel(t|name)  task.all()
task.progress(delta)                 -- 任务自报净进度（看门狗输入）；防重入 {single=true} 只在 task 声明处，spawn 不接受选项
on_cancel(fn)                        -- 清理钩：关容器、停走（①②）
log.info/warn/error(结构化字段)
```
P0 全部。

### 3.10 `state` — 实例级小状态（localStorage 语义）```lua
state.get(key, default?) -> value|nil
state.all() -> { [key] = value }
state.set(key, value) -> Result       -- 单值 ≤16KB、总量 ≤256KB；超限 code=state.quota
state.delete(key) -> Result
state.update(key, fn) -> Result       -- fn(旧值) 返回新值的原子读改写；fn 内禁止挂起（违反 state.update_yielded）
state.seen(key, window_ms) -> bool    -- 去重窗（④ 防同文重发；内容寻址，可靠性上限见 examples/bank 注释）
```
- 无 schema、无查询、无多键事务；复杂数据经 `events.emit` 交给外部系统。
- 存储路径由宿主固定（Node `state/state.sqlite`、Fabric `state/state.json`），包无权指定。
P0 全部。

### 3.11 `params` / `caps`（config 已并入 params，评审定稿）
```yaml
# bot.yaml —— 参数唯一声明源
params:
  input: { type: blockpos, required: true, visible: true }
  tune:  { type: number, default: 5, visible: false }
```
```lua
params.x        -- 只读视图（脚本每次读取取当前值，热生效）
-- 写入：控制总线（schema 校验 + 实例 params_json 持久化；脚本可挂 params_validator）
caps.has("container.transfer_bulk")  caps.server_version()   -- 脚本可探测降级（②③）
```
P0（caps P1）。

### 3.12 控制通道命令（声明层）
```text
on command "kill <target:player>" { perm = "pvp" } handler(args)
on command "pay <to:player> <amount:number>" ...
-- 参数类型：player(名字校验) number duration pos item filter
-- 来源统一：引擎 CLI / WebSocket 控制端 / 游戏内授权玩家聊天 —— 同一命令总线、同一鉴权
-- 内建命令（引擎实现，不经脚本；perm 默认 owner）：pause / resume / status
--   急停即 pause（冻结全部任务、停走、告警，resume 可恢复）；无 panic 关键词、无 on_stop
```
P0。

---

### 3.13 `events` — 与宿主的事件往返

> 定位：脚本与外部世界交互的唯一通道。**下发**（宿主 → 脚本）与**上报**（脚本 → 宿主）都只走事件，
> 投递地址与凭据完全由宿主持有，脚本不接触任何网络细节。

```lua
local r = events.next(30000)          -- Result；超时 value = nil，r.value 为 {type,data,ts}
-- ev = { type, data, ts }

events.emit("pay", { payer = "Steve", amount = 12.5 })   -- 上抛一条事件（非阻塞）
```

- 下发：托管部署由 agent 进程内写入；独立部署（`engine/cli.js`）可直接经控制通道 `POST /event {type, data}` 注入。
- 上报：进入引擎实时流 `event` 通道，与 log / chat / action 同一条出口；托管部署由 agent 转发到控制面，
  独立部署可经 `GET /stream` 消费，或由宿主自行决定去向。
- `events.emit` 的 `data` 必须是 table；`type` 截断到 64 字符。

### 3.14 `net` — 自定义网络包（custom payload / 插件消息）

> 定位：给服务器扩展插件（servux 等）用自定义载荷通道。脚本只处理原始字节，
> 载荷在 Lua 边界自动 base64（脚本 API 不暴露 base64），**受实例边界 `boundary.packets` 权限位门控**。

```lua
-- 订阅：channel 精确匹配；"*" 匹配全部（精确处理器先运行）
net.on("servux:metadata", function(p)
  -- p = { channel = "servux:metadata", data = <原始字节串>, ts = <ms> }
  for i = 1, #p.data do ... end
end)
net.on("*", function(p) log.info("payload %s (%d bytes)", p.channel, #p.data) end)
on_event("net.payload", function(p) ... end)   -- 等价通用订阅（payload 同上）

-- 发送：Result；data = 原始字节串或 0..255 字节数组
local r = net.send("servux:metadata", string.char(0x01, 0x00) .. nbt_bytes)
if not r.ok then log.warn("send failed: %s", r.error.code) end
```

- **权限位（唯一缺省拒绝的边界字段）**：`boundary.packets = true`（或 `"allow"`）才开放；
  未授予时出站返回 `policy.blocklist`，入站事件根本不会进入脚本（连监听也不可见）。
- 通道名须为小写资源位置（`namespace:path`），单包载荷上限 1 MiB；发送计入 `rate` / `budget` 与动作审计。
- Native host：Node（mineflayer）全量支持（`capability net.custom_payload=true`）；
  Fabric 宿主暂未实现动态通道收发（`caps.has("net.custom_payload")=false`，`net.send` 返回 `net.unsupported`）。

---

## 4. 事件目录（统一 `域.事件` 点分命名）

> 命名规范：`域.事件`，全小写下划线，域 = 能力域名；目录**参考 mineflayer 事件系选取核心集**。
> 订阅统一 `on_event("域.事件", fn)`，handler 即任务（可挂起/可取消）；`on_chat / on_timer / on_start` 等专用 on_* 是高频糖，事件名不变（`on_chat` 即订阅 `chat` 加正则过滤 + `source` 过滤）。**没有命令事件/命令声明**。
> **纪律：目录只收"状态跃迁"，高频连续量不进事件**——20Hz 位置流、逐包窗口刷新进缓存（§15 合帧），脚本用查询/wait_until 消化。这是 mineflayer 生态的直接教训：直接订阅 entityMove 会淹死调度器。唯一例外是 `engine.tick`：它不是状态流而是**调度原语**（每逻辑帧一次），帧体必须同步微操作。

### 生命周期钩子（不进总线）

`on_start`（停机 = 进程退出，state/外部事件流保证一致性，无 on_stop）· `on_pause` / `on_resume`（内建 pause/围栏越界/budget 耗尽/断线自动暂停，冻结点语义 §6）· `on_cancel`（任务级清理钩）· `on_error`（`engine.error` 的钩子形式，未捕获错误兜底 → 告警）

### 总线目录

| 事件 | 载荷 | 说明（mineflayer 对应） | 优先级 |
|---|---|---|---|
| **self 域** | | | |
| `self.died` / `self.respawned` | — | 死亡/重生（death / spawn） | P0 |
| `self.damaged` | {amount?} | 受伤（health 下降；来源尽力） | P1 |
| `self.health_changed` / `self.food_changed` | {value} | （health / food） | P1 |
| `self.teleported` | {pos, cause?} | 服务器强制位移（forcedMove） | P1 |
| `self.held_changed` | {slot, item} | 主手变更（heldItemChanged） | P1 |
| `self.gamemode_changed` | {mode} | （game） | P1 |
| `self.effect_added` / `self.effect_removed` | {type} | 药水效果增删 | P2 |
| **world 域** | | | |
| `world.joined` | {dimension} | 进入世界：登录落地/重生完成/重连回归——脚本行动的起点（login/spawn） | P0 |
| `world.switched` | {dimension} | 维度切换（主世界/下界/末地）；引擎清空世界缓存（§15.2） | P0 |
| `world.block_changed` | {pos} | 方块更新（blockUpdate）；同时是 dig/place 的完成确认源（§14.2） | P0 |
| `world.chunk_loaded` / `world.chunk_unloaded` | {cx, cz} | （chunkColumnLoad / Unload） | P1 |
| `world.weather_changed` | {weather} | （rain / thunder） | P2 |
| `world.sound_heard` / `world.particle` | {name, pos} | 环境感知（soundEffectHeard 等）：危险感知、活动侦测 | P2 |
| **entity 域** | | | |
| `entity.appeared` | {entity} | 出现（entitySpawn） | P1 |
| `entity.gone` | {id} | 消失（entityGone；含死亡与区块卸载） | P1 |
| `entity.died` | {id, pos} | 死亡（entityDead；掉落物追踪锚点） | P1 |
| `entity.equipment_changed` | {id} | 装备变更（entityEquip；holding 谓词的数据源） | P1 |
| `entity.hurt` | {id} | 受击（entityHurt；量与来源尽力） | P2 |

（`entity.moved` **不设事件**：合帧进缓存，字段活读即可——防淹没。）

| 事件 | 载荷 | 说明 | 优先级 |
|---|---|---|---|
| **window 域** | | | |
| `window.opened` | {win} | 窗口打开（windowOpen；插件 GUI 接管入口，§3.2） | P0 |
| `window.closed` | {reason: far\|broken\|server\|death} | 关闭/失效（windowClose；原 container.invalidated 并入） | P0 |
| `window.updated` | {revision} | 内容变更（revision 单调递增，§14.3） | P1 |
| **chat / msg 域** | | | |
| `chat.message` | {m} | 全部聊天（message；`on_chat` = 正则 + source 糖） | P0 |
| `msg.title` / `msg.actionbar` | {…} | （title / actionbar；④的回执可能走 actionbar） | P1 |
| `msg.bossbar_changed` | {id, …} | （bossBarCreated/Updated/Deleted） | P1 |
| `msg.teams_changed` | {…} | （teamCreated/Updated；敌我识别） | P1 |
| `msg.scoreboard_changed` | {…} | （scoreboard*） | P2 |
| **nav 域** | | | |
| `nav.arrived` / `nav.failed` | {target} / {reason} | 寻路结果（goto 的返回值即其同步形式；follow 场景订阅） | P0 |
| `nav.progress` | {fraction, eta} | 进度 | P1 |
| **task 域** | | | |
| `task.started` / `task.finished` / `task.failed` | {name, status?, error?} | 任务生命周期（编排/看板；HTTP /tasks 的数据源） | P1 |
| **engine 域** | | | |
| `engine.tick` | — | 逻辑帧回调（20Hz 对齐服务器 tick；mod=客户端 tick 即"每帧调用"，协议端=物理帧近似）。专用糖 `on_tick(fn)`；**帧体必须同步完成**（禁止挂起调用，lint 强制）——瞄准修正、底盘微调等连续控制的正规入口 | P0 |

- **通用通配**：`on_event("entity.*", fn)` 支持域级通配（调试/审计用，P2）。
- **目录封闭**：事件只增不改、三宿主同目录；要新事件先进本表评审，禁止各宿主自发长事件名。
- **与 mineflayer 的取舍**：kicked/end **不设事件——登录与连接管理是宿主平台的责任**（fabric 走原版流程，mineflayer/mcc 走包装层自动重连），宿主内部经 L1 `session.*` 通道驱动任务冻结/恢复，脚本目录只看得到 `world.joined`；playerJoined/playerLeft 不设事件（join/leave 是系统消息走 `chat.message`，列表走 `msg` 查询）；time 不设事件（`world.time_of_day()` 查询）；entityMove/windowSetSlot 不设事件（进缓存，理由见纪律）。

---

## 5. 控制项（五类，归属清楚）

| 类别 | 归属 | 内容 | 场景例 |
|---|---|---|---|
| **params**（统一参数） | `bot.yaml` 声明 schema（type/default/required/help/**visible**）；包默认 < 实例 params_json（平台唯一真源，部署时下发）；控制总线热改并回写 | 坐标、过滤器、区域、不满盒列表、追杀半径、开关 | ①from/to ③input/partial_chests ②range |
| **policy**（策略/边界） | **实例部署配置所有**（每服务器/每世界一份，全部可选；缺省不限制），宿主强制，脚本不可绕过 | 见下 | — |
| **runtime knobs** | 引擎调优 | dry_run、看门狗阈值、重试默认、日志级别 | — |
| **driver flags** | 驱动协商上报 | feature flags + 降级矩阵 | 跨后端 |

**policy 细项**（全部可选；未配置 = 不限制）：
- movement：活动围栏（越界 → 引擎自动 pause + 告警，可恢复）、`allow_move=false` 禁止移动 —— ①③
- blocks：dig/place 门控（缺省允许；显式 false/deny 才禁） —— ①③
- combat：配置 targets 后才做类型过滤；max_engage 可选 —— ②
- chat：say 限速（缺省不限）、**命令白名单**（非空时按首词元精确匹配：`/pay` 不放行 `/payday`；命名空间别名如 `/minecraft:pay` 需显式列出） —— ④
- budget：每小时动作数、任务墙钟上限、world.scan 预算；耗尽 → 自动 pause + 告警 —— 全部
- 操作员判定不在平台：聊天控制的权限模型由脚本自行实现（参数/KV/代码常量）

---

## 6. 资源仲裁与调度语义

- 互斥资源：**移动**（同时至多一条活动路径；朝向控制权由 `keep_rotation` 划分，yaw/pitch 本身无仲裁、last-writer-wins，§3.1）、**容器会话**（≤1）、聊天令牌桶、scan 预算。
- 优先级：控制命令 > 用户任务 > 维护定时器；抢占只发生在操作边界（协作式）。
- 资源被占时新请求默认按优先级排队（FIFO）；调用方可 `{steal=true}` 抢占（对当前持有者注入取消）。**pause 是引擎级门控**：冻结一切任务、停走、停 timer，不经资源仲裁。
- 取消契约：每个长操作都是取消点；`on_cancel` 保证清理。取消错误带**来源标记**：race/parallel 只吞自己子分支的取消，父任务/外部取消穿透一切组合子（DESIGN §2.2 规则 6）。
- 看门狗：`task.progress(delta)` 自报净进度为准；未上报时用默认信号（净移动距离、容器净转移件数）；连续 N 个检测窗（默认 30s）无净进度 → 取消该任务 + 告警（③）；全局指令预算 + 墙钟超时，耗尽 → 自动 pause + 告警。

## 7. 故障模型（类型化错误）

```
nav.unreachable | nav.timeout | nav.stuck
container.missing | container.closed | container.full(由 moved<count 表达)
entity.gone | entity.unknown_field
permission.denied | policy.blocklist
runtime.paused(暂停注入：任务冻结不销毁，resume 时于冻结点重抛) | state.quota | state.update_yielded
timeout | budget.exceeded(→ 自动 pause)
driver.disconnected(→ 自动 pause) | server.kicked(→ 自动 pause)
```
脚本可捕获处理；未捕获 → `on_error` → 告警（reply 给 owner / 日志）。围栏越界不抛给脚本——引擎直接 pause + 告警（可恢复）。

## 8. 生命周期（引擎启动序）

params schema 校验（YAML 契约 + 实例值）→ state 打开（固定路径）→ 连接 + 能力协商 → 脚本静态检查（白名单/领域 lint/能力需求提取比对 driver flags）→ 注册声明 → `on_start`。
运行中：掉线/被踢 → 自动 pause（`on_pause`：任务在挂起点冻结、停走、告警）→ 重连 → 自动 resume（`on_resume`；冻结点重抛 `runtime.paused` 走正常重试）；死亡 → 自动重生 → `on_respawned`（任务决定续跑或退出）。停机 = 进程退出（无 on_stop；state 与外部事件流保证一致性）。

## 9. 场景 → 能力追溯矩阵

| | nav | container | inv | entity | world | combat | chat | state | 控制/策略 |
|---|---|---|---|---|---|---|---|---|---|
| ①搬运 | goto_near | open/close/withdraw/deposit/move | count | — | block | — | log | — | 围栏、禁挖、abort |
| ②追杀 | follow/goto | — | equip_best | nearest/alive/pos | — | attack/cooldown | reply | — | 命令鉴权、黑名单、内建 pause |
| ③整理 | goto_near | free_space/deposit/count | — | — | scan/block | — | log | 表+校验回写 | params、看门狗 |
| ④银行 | — | — | — | — | — | — | on_chat/await/run_command/seen | 键值账户 + 意图集合 | 命令白名单、脚本自管 ops、限速 |

结论：四列并集无缺口；②③共同逼出的"ItemStack 组件读取"、①③共同逼出的"容器复合语义"、④独有的"事务+回执"均为公共能力，无场景需要目录之外的机制。
（§13/§3.2 定稿后注：矩阵中的 withdraw/deposit/free_space/move/equip_best 由 bslib 提供，脚本层名称不变；HAL 对应面为点击协议全集。）

## 10. 优先级汇总

- **P0（M1，mineflayer，验收=①④）**：nav 基础、container 全部、inv 基础、chat 全部、宿主控制（HTTP `/pause` `/resume`）、self 基础、time/task/log、state 全部、params、策略（围栏/禁挖/命令白名单/容器门控；缺省不限制）、HTTP 控制通道（§17）、dry_run、动作日志。
- **P1（M2，验收=②③）**：entity、follow、combat 四件套、equip_best（按 ItemStack 组件排序）、world.scan、caps、seen 之外的生命周期事件（death/suspend/resume）、看门狗、`item.stack` 组件全量。
- **P2**：raycast、webhook 告警、metrics 导出。

---

## 11. 补充能力域（v0 评审补充）

> 上文追溯矩阵对四个场景的**最小版本**成立。把场景按真实服务器环境加重（追杀要打真玩家、银行要适配具体服务器、全部要长期无人值守），并纳入协议层现成可得的只读信息后，补充以下内容。

### 11.1 `msg` — 消息/HUD 读取（新增域，协议层三后端均直接可得）

> 用户点名的玩家列表、boss bar、底部提示、title、subtitle、侧边计分板全部收录。
> 可行性结论：fabric 客户端天然持有全部 HUD 状态；mineflayer/mcc 在协议层同样收这些包（bossbar/title/actionbar/scoreboard/team/玩家列表），全部可抽象为**只读观察项**。事件驱动 + 当前值查询两种形态。

```lua
bossbars() -> [{id, title, progress, color?}]   on_bossbar(fn)   -- P1；服务器常用于播报状态
on_title(fn)                                    -- {title, subtitle}             P1
on_actionbar(fn)                                -- 底部提示；不少经济插件把入账回执发在 action bar（④要用）  P1
tablist() -> [{name, uuid, ping, gamemode, display_name?}]       -- P1；在线判定、ping 卡顿感知
scoreboard.sidebar() -> {objective, scores}     scoreboard.below_name(name)      -- P2，只读
teams() -> [{name, color, members, friendly_fire}]                               -- P1 ★
```

★ **teams 是 ② 的安全项，不是增强项**：多数服务器敌我识别的事实标准就是队伍颜色，不做 teams，追杀 bot 可能攻击队友。scoreboard P2 的原因：阅读它只是观察，没有决策依赖。

### 11.2 `session` — 会话与服务器信息（查询域，P0）

```lua
session.state()   -- connecting|logged_in|playing|disconnected（查询保留）
session.info()    -- {server_brand, protocol_version, view_distance}  ★brand 决定 ④ 的聊天模板选型
-- 事件：world.joined（= 进入 playing 且首圈 chunk 灌入完成，驱动上报尽力而为）
--   → 冷启动类任务以它为启动门；world.switched = 维度切换（§4）
-- 连接事件（kicked/disconnected）不进脚本目录：登录与连接管理是宿主平台的责任；
--   断线/被踢 → 引擎自动 pause（on_pause）→ 宿主重连回归（world.joined 重发）→ 自动 resume（on_resume）
```

### 11.3 entity / inv / combat 补充项

```lua
-- entity（P1）：
e.equipment                        -- {hand, offhand, armor[4]}：对手拿盾还是拿剑；老版本/部分实体 → unknown
entity.drops_of(e)              -- 死亡掉落物追踪（②战利品、③回收）；pickup 动作属行为策略 → bslib（§13）
-- inv（槽位模型 P0，equip 依赖它）：
inv.slots   -- hotbar 0-8 / main 9-35 / armor 36-39 / offhand 40；换持槽位操作归 inv.equip
            --（ensure_holding 属行为策略 → bslib，§13）
-- combat / 交互（P1）：
combat.use_item(duration)    -- 吃/喝/拉弓（蓄力时长语义）—— HAL 只保留这一个原语
combat.interact_entity(e)    -- 右键实体（骑乘/村民）  P2
-- eat_until_full / ensure_holding / equip_best 等行为策略不入 HAL → bslib 内置 Lua 库（§13）
```

### 11.4 world 环境只读（P1，成本低）

```lua
world.dimension()  world.time_of_day()  world.weather()  world.biome(pos)  world.light(pos)?  -- light 可 unknown
```

用途：夜间行为降险（②可选夜间取消追杀）、下界坐标换算（引擎侧）、长期任务日志归因。

### 11.5 声音/粒子（P2 可选）与骑乘（远期）

`sound(pos, name)` / `particle(pos, name)`：危险感知（苦力怕引信、TNT 引爆）。载具 enter/exit：船/矿车长距离运输，远期再议。

## 12. 修订后的优先级结论

- **P0 增补**：session 域；inv 槽位模型（含盔甲/副手）；self.gamemode（能力门控依据：spectator 不可攻击/开箱）；pause 语义全套（on_pause/on_resume + 内建 pause/resume/status + runtime.paused）；state.update / state.seen / on_event。
- **P1 增补**：msg 域（bossbar/title/actionbar/tablist/teams）；entity.equipment；drops；use_item（eat_until_full 移入 bslib，见 §13）；world 环境只读。
- **P2 增补**：scoreboard；sound/particle；interact_entity。
- 一句话理由：四场景在真实服务器上分别依赖 teams（②安全）、进食（②续航）、server_brand（④解析模板）、断线恢复（全部长期运行）——不补这几项，M2 实机验收会失败，而非功能不全。

## 13. 分层规则（定稿）：HAL 只留正交控制面，行为策略进 bslib 内置 Lua 库

> 决策：`eat_until_full` 这类复合行为不进能力面。能力面（HAL）只提供最小、相互正交的控制面与查询；
> "行为策略"一律实现为**引擎自带的内置 Lua 库（bslib，bot-script stdlib）**，随引擎分发、构建在 HAL 之上。

三层分工与判据：

| 层 | 实现者 | 内容 | 判据 |
|---|---|---|---|
| 宿主动作 [H] | 各栈原生桥（engine.js+abi.js · AbiDispatcher+McRuntime · mcc 桥） | look / input / dig / use_block / use_entity / swing / use_item / select_slot / drop / 窗口点击协议全集 / chat_send / path_to / 包流 | 一次网络往返或一次客户端动作 |
| 引擎核心 | 引擎原生代码 | 调度、资源仲裁（移动权/**窗口互斥**）、窗口内容同步与失效语义、state、params、引擎侧正则；**不做物品数据表**（属性读 ItemStack 组件） | 必须成立的跨后端不变量；需要引擎内部状态或原子读改写 |
| bslib 内置 Lua 库 | 引擎随附（Lua 源码，可读、可覆盖） | withdraw / deposit / transfer（moved<count 约定）/ container.move 多趟、eat_until_full、equip_best、ensure_holding、entity.pickup、is_combat_ready、find_ground / is_dangerous 等谓词 | **行为策略**——用户可能想调整的决策逻辑 |

场景落点：②的"会吃饭、换最强武器"是 bslib 的职责（如 `bslib/combat.lua`），HAL 只保证 `combat.use_item`、`inv.equip`、`item.stack`（组件属性）这些底层件存在。

收益：

1. HAL 面进一步收缩，驱动实现成本随之收敛（驱动照 §12 的 P0/P1 原语清单实现即可）；
2. 策略可读、可覆盖、可复制改造——用户的整理 bot 可以直接 fork `equip_best` 改成自己的选装逻辑；
3. 策略迭代不绑引擎版本，bslib 可独立热更；
4. 静态分析白名单不变：bslib 只调用 HAL，无任何特权，脚本引用 bslib 与引用自己的模块走同一套检查。

迁移注记：§3 中 equip_best / ensure_holding / move / pickup 等条目一并归类为 bslib；脚本层函数名不变（作为 `bslib` 全局注入），仅实现层从引擎原生代码改为引擎随附的 Lua 源码。~~判据上拿不准的条目（如 withdraw/deposit 是否下沉 bslib）~~ **已定稿：withdraw/deposit/transfer 下沉 bslib**（评审指出泛用传送语义覆盖不了服务器插件 GUI；HAL 收敛为精确点击协议，moved<count 转为 bslib 约定）。多趟跨箱转移统一命名 **`bslib.move(from, to, filter, opts)`**（原 transfer_via_bot，organizer 示例已更名）。

---

## 14. 宿主动作面（定稿；v2 起宿主内嵌 Lua，无独立引擎进程）

> 定位：**宿主原生层 = 翻译器 + 可选智能**。Lua API 的丰富度全部由共享 Lua 核心（bootstrap/bslib）提供，
> 原生面收敛到最小，降低三栈桥的代码压力与新 MC 版本的跟进成本。
> （v2 拓扑：mineflayer 宿主=wasmoon 桥、fabric=Luaj 内嵌 standalone、mcc=MoonSharp 桥——见 DESIGN §1。）

### 14.1 分层

| 层 | 内容 | 成本 |
|---|---|---|
| L0 连接 | 登录 / keepalive / 重连 / 版本与能力协商 | 小（mineflayer/mcc 协议库代劳大半） |
| L1 数据面（入） | 包流 → **规范化事件通道**（通道目录与合并语义见 §15）：chunk/方块更新、实体流、自身状态、窗口内容、聊天/HUD、sound/particle、kick/teleport | 纯翻译无业务逻辑；版本适配由底层协议库消化大半 |
| L2 动作面（出） | 下表 **15 个动作 op** | 每 op = 一两个原版包的发送（无按键模拟） |
| L3 可选智能 | 寻路器（Baritone / mineflayer-pathfinder / mcc 内建） | 仅 `caps.nav.pathfinder` 驱动提供；缺失时 goto 退化为直线可达执行（§14.3） |

### 14.2 L2 动作 op（全表）

| op | 覆盖的脚本层 API | 说明 |
|---|---|---|
| `act.chat_send(text, kind)` | chat.say / run_command / reply | kind = chat / command；command 层由核心补 `/`，宿主按 kind 走策略 |
| `act.window_open(target)` / `act.window_close()` | container.open/close | target: blockpos\|entity；同时至多一个窗口 |
| `act.window_click(slot, button, mode, state_id?, n?)` | win.click / click_hotbar / drop_slot / drop_cursor / drag 全部 | mode = vanilla ClickType；**state_id 由客户端维护**并随包回传 |
| `act.use_entity(target, kind, hand?)` | combat.attack、interact_entity | kind = attack / interact / interact_at |
| `act.use_block(pos, face, hand, intent, cursor?)` | use_block（开箱/按钮/门）**与 place** | face 0..5 + cursor 精确命中；intent=place 走 place 门控 |
| `act.use_item(phase, hand?)` | combat.use_item（吃/喝/拉弓） | phase = start/release；蓄力时长由 bslib 掐表 |
| `act.dig(pos, face?)` / `act.dig_stop()` | combat.dig / combat.dig_stop | player_action START / STOP；**完成以方块变空为准**（真实状态，不按硬度猜） |
| `act.look(yaw, pitch)` | look.yaw / look.pitch / look.aim | 一次 rotation 包 |
| `act.input(forward, right, up, sprint, sneak)` | 底盘控制（nav 直线退化 / nav.hop） | player_input 状态位，前后左右为**有符号轴**（forward=1 前进、=0.5 潜行速度等由协议层处理）；不注入按键、不模拟玩家操作 |
| `act.swing(hand?)` | 攻击/挥手的显式包 | 与 attack 分开，便于无伤害交互 |
| `act.select_slot(slot)` | inv.equip | 选主手槽（服务器确认） |
| `act.drop(all?)` | inv.drop | 丢弃手持物 |
| `act.path_to(target, arrive, timeout_ms)` / `act.path_cancel()` 〔L3〕 | nav.walk / follow | 唯一的驱动侧智能，进度事件回传 |

共 15 个动作 op。**策略门控与限速全部在宿主 dispatch 一处**，驱动不做二次判断。

### 14.3 边界决定

- `say` 与 `run_command` 合并为 `act.chat_send`，由 `kind` 区分（策略按 kind 分别门控）；`place` 与 `use_block` 合并（同一协议动作，`intent` 区分）；
- **窗口点击的 revision/stateId 记账**：mineflayer/mcc 复用其库内窗口模型（驱动内既有状态，非新增逻辑）；fabric 走原版客户端 screen handler（§16.3）。"纯翻译"指**无业务逻辑**，不排斥协议层既有的会话状态；
- 挖掘/蓄力的**完成判定以真实状态为准**（方块变空 / 物品消耗），不按硬度或时长猜服务器判定；
- 脚本层具名糖（win.click_hotbar 等）由引擎展开为 op 参数——脚本 API 人体工学不缩水，驱动面不膨胀；
- **L3 缺失时 nav.walk 退化为直线可达执行**（核心用 `act.input` 直走 + `act.look` 转向，开阔地形），复杂地形显式 `nav.unreachable`——不在引擎里重造寻路器，P2 亦不评估完整降级寻路；
- 版本差异被压缩到 L1 通道翻译（§15.3）+ 物品/方块 id 映射；**物品属性不查表**（直接读 Stack 组件）——L2 op 跨版本稳定（点击/交互动词语义自 1.8 起未变）。

### 14.4 三宿主的预期实现量（粗估）

| 宿主 | 复用底座 | 预估自研代码 |
|---|---|---|
| mineflayer | 协议库+世界模型现成，API 与动词几乎一一对应 | 薄翻译层 ✅ 已实装（wasmoon 桥） |
| mcc | 协议+移动控制现成（注意：其世界模型较薄，L1 chunk 通道需评估补齐） | 薄翻译层（规划） |
| fabric mod | 输入/渲染/Baritone 现成；v2 standalone（Luaj 内嵌，无 Node 依赖） | 中等（LuaRuntime + AbiDispatcher + McRuntime/McState + L1 采样挂点，随版本需重验，见 §16.6）✅ 已实装 |

> 收益视角：驱动从"半个 bot 框架"缩到"通道翻译 + 14 个动词"；新增后端或跟进新版本的边际成本随之最小化。
> 现实注记：真服务器高对抗场景（②）会因反作弊把部署重心推向 fabric——三驱动中唯一"中等"成本的那个，
> 抽象层的省钱效应在该场景打折，这是接受的成本而非遗漏（§16.6 写明了跟进面）。

---

## 15. L1 数据面规范（骨架）

> L1 是三宿主可移植的承重契约：动作面只有 14 个动词，数据面才是版本适配与工程量的主体。
> 本节定契约形状；字节级 ICD 与编码细则放 `/spec`（M0 交付物）。

### 15.1 传输与编码

- **控制面与数据面分帧**：同一连接上，控制面（动词调用/命令/params）走 JSON-RPC 文本帧；数据面（世界/实体/窗口流）走二进制帧，默认 MessagePack，驱动协商可升级（`data.encoding` flag）。chunk 走 JSON 是被禁止的放大路径。
- **合帧**：驱动按 tick 攒批（默认 50ms/批，可协商至 100ms）再发；同一批内**同键事件按"最后值胜"合并**——实体移动只保留批末位置，方块更新按坐标合并。引擎只消费最新值，不回放包序。

### 15.2 通道目录与合并语义

| 通道 | 载荷（骨架） | 合并语义 | 备注 |
|---|---|---|---|
| `world.chunk` | {cx, cz, blocks(压缩列)} | 整块替换 | 登录/跨维度为突发流（二进制） |
| `world.block_update` | {pos, name, state} | 按坐标合并（最后值胜） | 同时是 dig/place 的完成确认源 |
| `world.chunk_unload` | {cx, cz} | 引擎删除缓存 | — |
| `entity.spawn` / `entity.despawn` | 全量实体快照 / {id} | 一次全量 | — |
| `entity.move` | {id, pos, look} | 20Hz 合帧、最后值胜 | 引擎活读字段的来源 |
| `entity.meta` / `entity.equipment` | {id, 字段} | 字段级覆盖 | equipment 变更即事件 |
| `self.*` | pos/health/food/effects/gamemode | 字段级覆盖 | — |
| `window.*` | {windowId, slots[], cursor, revision} | 整窗替换；revision 单调递增 | revision 供点击记账（§14.3） |
| `chat` / `hud.*` | text/bossbar/title/actionbar/tablist/scoreboard/teams | 事件直传（不合并） | — |
| `session.*` | state / 维度切换 / kick | 事件直传 | **维度切换 → 引擎清空世界缓存** |

- **缓存所有权**：引擎缓存是由 L1 流构建的**查询投影**；L3 寻路器在后端内部仍用其自有世界模型——世界状态双份是结构性的（DESIGN §1 注），引擎缓存不追求替代后端内部模型。
- **staleness**：引擎按通道记录最后更新时间；`world.staleness(pos)` 与实体活读字段受其约束；驱动不替引擎遮掩滞后。
- **降级**：无 chunk 流时 `world.block` 走驱动定点查询（慢速路径，显式暴露）；ABI v2 已移除 `world_stream` 能力位。

### 15.3 版本适配责任边界

驱动把任意版本的包翻译为上述通道事件（翻译表随底层协议库消化大半）；引擎对通道语义零版本判断。通道自身跨版本稳定，**新增字段只加不改**；通道增删走 driver flags 协商。

---

## 16. 客户端 mod 驱动（fabric）能力定义

> **v2 现状**：mod 已 standalone——内嵌 Luaj（LuaRuntime）经 AbiDispatcher 直接服务 `<游戏目录>/botscript/<包名>/` 脚本包，
> 无 Node 进程依赖。v1 的 WS 连接层实现已随 v2 清理删除（原 `mod/legacy-ws-client/` 归档）；
> 其余（§16.2 采样挂点、§16.3 动词映射、§16.4 flags、§16.6 跟进面）仍然有效。
> 定位：mod 寄生在**真实客户端进程**内，天然持有全部客户端状态与原版交互路径——三宿主中唯一
> "点击/移动经客户端本体"的形态：窗口 revision 由原版 screen handler 记账、移动物理由客户端模拟，
> 包面与真人客户端不可区分（**不承诺反检测，只承诺包面真实**）。

### 16.1 L0 连接与会话（v2：无连接层，mod 即宿主）

- **mod standalone**：内嵌 Luaj 运行时直接执行脚本包，无外部进程、无连接层。脚本装载：
  `<游戏目录>/botscript/<包名>/`（含 bot.yaml 能力自述）；实例配置 =
  `<游戏目录>/config/botscript-mod.json`（`package` + `boundary`——实例限制，缺省不限制 §5.1）。
- **游戏会话由客户端自身管理**（登录、断线重连、被踢界面都是玩家可见的原版流程），进世界自动
  boot、退世界自动停止，mod 不代做登录重连。
- 部署形态约束：一个客户端实例 = 一个 bot（JVM 1–2GB）；无头部署走 Linux + 虚拟显示或专用小服客户端。
- 控制面：HTTP 控制通道（§17，Java 侧 HttpApi，与 engine 宿主同 schema）+ 游戏内 `/bsclient`
  管理 GUI（§16.5）+ 聊天命令总线。

### 16.2 L1 采样挂点（全部 = 读取客户端已有状态，零解析成本）

| 通道 | 挂点 |
|---|---|
| `world.chunk` / `block_update` / `chunk_unload` | ClientLevel + LevelChunk diff hook（客户端收包后回调） |
| `entity.*` | 客户端实体追踪器：spawn/remove 事件 + 20Hz 位置采样 + meta/equipment 变更回调 |
| `self.*` | 客户端本地玩家状态（本地即权威，含 effects/gamemode） |
| `window.*` | 客户端窗口包监听 → 整窗 slots + cursor + revision |
| `chat` / `hud.*` | 聊天栏、BossBar、Title、ActionBar、TabList、Scoreboard、Teams——全量只读 |
| `sound` / `particle` | 客户端声音/粒子管理器 hook |

### 16.3 L2 动作 op → 客户端机制

| op | 客户端机制 |
|---|---|
| `act.chat_send` | 客户端聊天发送（kind=command 时 `/` 前缀） |
| `act.window_open/close/click` | 原版 handledScreen 点击路径（ClickType 全集）；**stateId/revision 由客户端维护** |
| `act.use_entity` / `act.use_block` / `act.use_item` | 客户端 GameMode 交互入口（attack/interact/use；startUseItem/release），带 face/cursor 精确命中 |
| `act.dig` / `act.dig_stop` | startDestroyBlock / stopDestroyBlock + 持续 player_action——**客户端自身计挖掘进度**，完成以方块变空为准 |
| `act.look` | 客户端 rotation 直写（本地即权威） |
| `act.input` | **player_input 状态位**（forward/right 有符号轴 + jump/sprint/sneak），不注入 KeyMapping、不模拟玩家操作；物理由客户端维持 |
| `act.swing` / `act.select_slot` / `act.drop` | 独立的原版包（挥手 / 选槽 / 丢弃） |
| `act.path_to` / `act.path_cancel` 〔L3〕 | **Baritone 桥**：`arrive`→GoalNear、`timeout`→引擎侧墙钟、进度 = PathEvent 映射 nav 进度事件；settings 白名单受 blocks 策略二次门控 |

死亡重生由宿主自动处理（ABI v2 无 `respawn` 动作 op）。

### 16.4 能力 flags（协商上报）

`abi=2 · nav.pathfinder=true（挂 Baritone 时）· item.components=true · world.block_entity=true`

`/caps` 另列 `patches`（已应用的版本适配补丁 id）。能力位只增不删；缺省 = false。

### 16.5 GUI 管理 / 配置界面（人类可读，mod 内建）

> 原则：GUI 是**控制总线的又一张脸**——页面数据与 HTTP API（/state /params /tasks /logs）同源，
> 写入走同一总线、以 **owner 权限身份**（DESIGN §5.3），不存在绕过策略直达运行时的路径。
> 全人类可读：本地化标签、schema 驱动的表单，不展示裸 JSON。

| 页面 | 内容 | 数据源 |
|---|---|---|
| 状态 | session 状态、pos、health/food、当前窗口、server brand、caps flags | /state |
| 任务 | 任务列表（名称/状态/时长/进度）、pause/resume（内建急停）、取消单个任务 | /tasks + 内建命令 |
| 参数 | `visible=true` 的 params 表单：bool 勾选 / number 滑条 / blockpos 选择器 / list 编辑器，带 help 文案；`visible=false` 不出现 | /params + 包 schema |
| 边界（只读） | 当前实例限制视图：fence、dig/place、combat、命令白名单——"我被限制做什么" | 部署配置只读呈现 |
| 日志 | 动作/事件尾部（任务、动作、错误码），可按任务过滤 | /logs |
| 脚本 | 当前包、botscript/ 包列表（★当前）、[切换]（写回 config + 热重载）、[热重载当前包]、拖拽导入提示 | /packages + /reload |

**运行时控制（fabric 宿主，2026-09-10）**：
- **一键启停快捷键**（默认 K，`key.botscript.toggle` 可改键）：pause/resume 与 GUI 急停同一路径，日志留痕 `[hotkey]`；
- **拖拽导入**：把 `.lua` 拖进游戏窗口 = 拷入当前包；拖入含 `bot.yaml` 的文件夹 = 导入为独立包；导入后自动热重载；
- **热重载/切包**：GUI 脚本页或 `POST /reload`——客户端线程 stop+boot 原地重载，**游戏连接不断**；
  不在世界内时只写 config，下次进世界生效。切包校验目录存在且拒绝路径穿越（`..`/分隔符）。

实现约束（为多版本成本收敛）：
- mod 自带轻量 Screen 抽象（自绘列表/表单控件），**不引入第三方 UI 库**（Cloth Config 等的跨版本维护是坑）；Mod Menu 集成为可选（检测到则加入入口，未装则 `/bsclient gui` 打开）；
- GUI 只消费命令总线与 HTTP API 的进程内接口（§17 同源），页面层零业务逻辑；
- 能力 flags 增加 `ui.gui=true`（§16.4）。

### 16.6 版本支持：1.21.8 ~ 26.2（多版本策略）

版本敏感面切分：

- **版本无关（一份，跨版本共享）**：LuaRuntime、runtime/lua/core（bootstrap/bslib）、AbiDispatcher、Policy、PersistStore、McState/WindowLayout、DataRegistry（ItemStack 组件读取）、HTTP API、GUI 抽象层；
- **版本自适应（每版本薄一层）**：McRuntime 的 MC 接线 + mixins（§16.2 挂点）+ Screen 实现 + 映射名——全部集中在**版本适配层**（DriverHooks 模式）。

工程方案：

- **Stonecutter 多版本构建**：单代码库、按版本预处理面；1.21.x 线与 26.x 线跨版本方案边界（两套 mapping 家族），CI 矩阵**每版本出一个 jar**；
- 挂点收敛单一 DriverHooks 类，优先用 Fabric API 事件入口（tick/chat 等跨版本稳定），mixin 数量压到最少；
- 数据类差异（物品组件字段、方块属性名）随协议/注册表自动到位；较老版本缺组件时字段为 null（不造假），新版本字段只加不改；
- 新版本纳入流程：loader/API 升级 → 适配层重编译 → 挂点重验 → 组件字段 diff → 并入 CI 矩阵。
- 成本现实：0.5–2 人日/版本（同线内补丁版本 ≤1 人日）；1.x→26.x 方案切换的适配高峰由适配层一次吸收。

---

## 17. HTTP 控制通道（每宿主标配，测试 / MCP 主入口）

> 目标：外部（面板、MCP、agent）**无需进游戏、无需任何额外进程**，即可观察与操控任一 bot。
> 归属：HTTP API 是**宿主常开能力**，不是可配置项，更不是脚本包的一部分——只绑 127.0.0.1，
> 默认端口（冲突自动顺延）、token 启动时自动生成并打印到控制台/日志；绑定覆盖属宿主启动参数（env），
> 不存在于任何通用配置。包清单（bot.yaml）只描述自身能力，不含凭据、边界或控制面声明。
> 所有写操作受实例 `policy` 门控（fence / blocks / combat / chat / budget；缺省不限制）。
> 与平台原生控制方案（游戏内命令 / 宿主 CLI / mcc 控制台）同一边界。
> **`/eval`（2026-09-10 改拍板，原为"无 /eval"沙箱纪律）**：控制面提供 one-shot Lua——提交的代码
> 编译为具名任务进入运行时，与包脚本**同环境、同边界**（每个动作仍过 Policy，脚本不可借 eval 绕过
> 授权）；Bearer token 即 console 级操作者身份。适合探索、临时驱动与无命令面覆盖的场景；
> 固定操作面仍优先走 `/params` 与脚本自己的 `on_chat` 处理。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/state` | GET | 快照：session、pos、health/food、当前任务列表与状态、窗口、caps；含断线重连可观测（reconnecting/attempts/next_retry_in，TOB-475）与 `credential_updated_at`（最近一次 POST /session 生效时刻，无则 null） |
| `/session` | POST | **mineflayer 宿主**：会话凭据更新（TOB-489，MC 凭据轮换引擎侧）。`{"access_token":"<新 token>","username"?:"…","uuid"?:"…"}` → `200 {"applied":true,"effective":"next_connect"\|"next_reconnect"}`。写入 `connectCfg.account.accessToken`：在线连接零动作（MC 协议无会话中重认证，accessToken 仅 join 期消费）；断线/重连环路中下一次重连即用新 token（不重置退避、不打断在途计划）。可选拖带 username/uuid 对账，与当前 account 不匹配 409；账号非 `auth:'session'` 模式（offline/密码式）409；access_token 缺失/空 400；同值重复 POST 幂等 200。token 值不进任何日志或 /state。fabric mod 宿主不在托管链路、暂不实现 |
| `/params` | GET / POST | 读 / 改 params（schema 校验；平台侧回写 params_json） |
| `/pause` | POST | 暂停：`{"reason":"manual"}`（可选，默认 manual）；冻结任务、停走、取消寻路 |
| `/resume` | POST | 恢复被 pause 冻结的任务（于冻结点重抛，走正常重试） |
| `/eval` | POST | 一次性 Lua：`{"name":"relocate","code":"nav.walk{...}"}` 作为具名任务运行；编译错误 400，返回值/失败走 `/logs`，任务可在 `/tasks` 取消 |
| `/tasks` | GET | 任务列表：id、name、status、运行时长、最近进度（`task.progress` 输入） |
| `/tasks/cancel` | POST | `{"name":"organize"}` 协作式取消 |
| `/logs?since=<ts>` | GET | 结构化动作/事件日志尾部（任务、动作、错误码），支持增量拉取 |
| `/store` | GET / DELETE | 只读实例状态（键值 + 用量）/ 清空状态 |
| `/caps` | GET | 宿主类型/版本、feature flags、脚本包清单 |
| `/reload` | POST | 原地热重载脚本：Node 宿主重读实例 package 目录（`{"reason":"..."}`），Fabric 宿主可选 `{"package":"<名>"}` 切换并写回 config；新脚本编译失败时保持旧脚本运行，连接不断 |
| `/packages` | GET | **fabric 宿主**：`{"current":"tour","packages":["hello","smoke2","tour"]}`（botscript/ 下可选包） |

约定：全部 JSON；异步动作返回受理 id；三宿主的端点与载荷 schema 完全一致（MCP 工具不感知宿主差异）。

**无头测试闭环**：`POST /params` 或 `POST /eval` 触发任务 → 轮询 `/tasks` 看完成 → `/logs` 核对动作序列 → `/store` 对账断言。
配合 RCON 注入服务器事件（tellraw 模拟系统消息等），验收全程无需真人客户端；computer-use 仅留给"必须真人操作"的场景。
