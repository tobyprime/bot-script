# bot-script 架构改造方案（草案 · 待审）

| 项 | 值 |
|---|---|
| 状态 | **草案，待评审；未改任何实现代码** |
| 日期 | 2026-11-19 |
| 范围 | `engine/`、`drivers/mineflayer/`、`mod/`、仓库构建与 CI；不含平台仓业务改动 |
| 关联 | `DESIGN.md`（v2 三层分离）、`CAPABILITIES.md`（能力目录）、`README.md`（运行方式） |
| 证据等级 | **[实测]** 本次跑脚本/命令验证；**[静态]** 读代码可得；**[待核实]** 需运行期或游戏内验证 |

---

## 0. 摘要

当前方向（**纯 Lua 核心 + 多宿主 + 宿主内嵌运行时**）是正确的，问题不在选型，而在**契约缺失导致同一语义被手写多份**：

- 游戏数据被抄成手写表，且**已经算错**：按 `engine.js` 现有规则复算，1.21.8 下 1326 个物品中 **217 个（16.4%）** 堆叠数判错；Fabric 侧 `GameTables.java` 另有 176 个判错，两宿主对 146 个物品**判错且结论互不相同**。该表被 `bslib` / `organizer` 用于背包与箱内容量计算，属于真实功能缺陷。
- Lua 运行时存在**两份手写拷贝**（`engine/lua` 与 `mod/src/main/resources/lua`），已漂移 99 行 diff。
- Lua↔宿主边界是 **53 个具名全局桥 + 1 个动作工厂** 的字符串协议，无清单、无静态校验；6 份重复的注册包装、30 处手写 `JSON.parse(j…)`。
- `engine/engine.js` 2108 行，承担 6 类职责；测试只能直接撬 `lua.global`。

**改造主张：契约先行。** 用三个唯一真源收敛系统：

1. `contracts/host-abi.yaml` —— 宿主动作的唯一清单，生成两侧代码；
2. `contracts/*.schema.json` + `openapi` —— `bot.yaml` / `deploy.yaml` / `boundary` / §17 HTTP 的唯一形状，平台与引擎共用；
3. `runtime/lua/` —— 唯一 Lua 核心 + 一个 LuaJ 兼容模块，构建期分发。

其余全部是薄适配器。核心原则是**原语下沉、编排上移**：宿主只提供协议原语与强制点，导航、容器交互、战斗节奏这类组合行为回到 Lua 核心，从而在两个宿主上行为一致。

---

## 1. 现状盘点

### 1.1 规模（[静态]）

| 文件 | 行数 | 职责数 |
|---|---:|---|
| `engine/engine.js` | **2108** | 持久化 / 会话 / 流 / 暂停 / Lua VM / 6 组桥 / 参数 / 命令 / 策略 / 查询 / 动作 / 导航 / 窗口 |
| `engine/test/run.js` | **1792** | 49 个 `test()`，单文件 |
| `engine/lua/bootstrap.lua` | **1159** | 调度 + 声明 + 能力包装 |
| `mod/.../McRuntime.java` | **1207** | Fabric 宿主主体 |
| `mod/.../runtime/LuaHost.java` | 745 | Luaj 桥 |
| `drivers/mineflayer/index.js` | 641 | 快照 + 动词 + 协议补丁 |
| `mod/src/main/resources/lua/*` | 1118 + 264 + 201 | 与 `engine/lua` 的另一份拷贝 |

### 1.2 边界事实（[静态]）

- 桥面：`engine.js` 注册 **53 个具名 `G('__…')` + 1 个 `__act_` 动作工厂**，动作另有 **17 个 `A('…')` 注册**。
- 反向调用（宿主→核心）：`lua.doString` / `luaFn(...)` 共 7 处（`__core_resume`、`__core_event`、`__params_validate`、`__task_*`、eval glue、启动时 require）。
- 用户脚本经 `lua.doString(src)` 载入**全局环境**（`engine/engine.js:461`），因此脚本可访问所有 `__*` 全局桥；动作仍会在 `actionEntry` 处被策略/速率门控，但声明层之外的直连桥不受脚本 API 约束。
- `this.driver.*`：**73 处调用、27 个不同方法**，驱动为 duck-typed，无接口定义。
- 宿主启动三套：`engine/cli.js`、`engine/worker.js`、`engine/host.js`；`parseServer` 在 `cli.js:62` 与 `worker.js:24` 各一份，deploy.yaml 解析在两处逐字重复。

---

## 2. 问题与证据

### 2.1 P0 — 手写游戏数据已经算错（[实测]）

**规则位置**：`engine/engine.js:12-36`（`STACK16` / `STACK1` / `STACK1_PREFIX` + `stackSizeOf`）；`engine.js:39-57`（`WEAPONS` / `ATTACK_SPEED` / `weaponCooldownMs`）；`engine.js:58-68`（`CONTAINER_BLOCKS`）。Fabric 侧对应 `mod/src/main/java/com/botscript/mod/runtime/GameTables.java`。

**比对方法**：逐字复制两侧判定规则，以仓库已装的 `minecraft-data` 物品表 `stackSize` 为真值（方法见附录 B）。

| 版本 | 物品数 | `engine.js` 判错 | 错率 | `GameTables.java` 判错 | 错率 | 两边同错但结论不同 |
|---|---:|---:|---:|---:|---:|---:|
| 1.21.8 | 1326 | **217** | **16.4%** | 176 | 13.3% | **146** |
| 1.21.4 | 1296 | 197 | 15.2% | 156 | 12.0% | 126 |
| 1.20.1 | 1170 | 170 | 14.5% | 130 | 11.1% | 101 |

典型误判（1.21.8）：

- `iron_ingot` / `iron_block` / `iron_ore` / `iron_bars` → 判 1，真值 64（前缀 `minecraft:iron_`）；
- `stone_slab` / `stone_bricks` / `stone_brick_stairs` → 判 1，真值 64；
- `diamond_block` → 判 1，真值 64；`golden_apple` → 判 1，真值 64；
- `shulker_box` → 判 64，真值 1（`CONTAINER_BLOCKS` 收录了它，`stackSizeOf` 未处理）。

**影响不是纸面错误**：

- `engine/lua/bslib.lua:77-84`：背包剩余容量 = 空格 × `data.stack_size(id)`；
- `examples/organizer/routing.lua:94,108`：箱子可放件数 = 空槽 × `data.stack_size`，参与选箱排序与回写；
- 铁锭类物品被按 1 件计，容量差 **64 倍**，整理 bot 会选错箱/误判满箱。

**Fabric 侧同类腐烂证据**（`GameTables.java`）：`"minecraft:honeycomb"`（真值 64，却列入 16）、`"minecraft:pearl"`（不存在）、`"minecraft:iron_bucket_placeholder"`（不存在）。没有对照测试，所以无人发现。

**其它手写协议数据**：

- `CONTAINER_BLOCKS` 仅 28 项，1.21.8 下缺 `crafter`、`chiseled_bookshelf`、`decorated_pot`、`lectern`（[实测] 这四项均在方块表中存在）。
- `__q_can_reach` 以「直线距离 ≤ 64」冒充可达性（`engine.js:1406-1411`）。
- 窗口槽位映射在 `drivers/mineflayer/index.js:410-428,549-552` 与 `engine/engine.js:1423-1442,1643` 各写一份（`size+27`、`36`、`45`）。
- `examples/tour/tour.lua:91` 的自检只抽查一个 64 堆物品，规则性错误全部逃逸。

**可证伪核验**：若现规则正确，`data.stack_size("minecraft:iron_ingot")` 应为 64；按当前实现必然为 1。用附录 B 的命令可直接复现。

### 2.2 P0 — `engine.js` 是无接缝的 god module（[静态]）

- 6 个 `register*` 方法各自重复一份 `const G = (name, fn) => this.lua.global.set(...)`（共 6 份）。
- 30 处 `JSON.parse(j || '{}')` 与 14 处 `JSON.stringify` 散落在各 handler。
- `Persist` 类、实时流环、pause 门控、导航（含 `setInterval` 实现的 `straightGoto`）、窗口语义、参数系统、策略、命令总线、Lua VM 生命周期全部同居。
- 测试耦合：`engine/test/run.js:52` 直接 `engine.lua.global.get(...)` 调 Lua 内部，49 个用例塞进 1792 行——**任何拆分都必须先建立测试接缝**，否则只是搬家。

### 2.3 P1 — Lua 运行时三份拷贝且已漂移（[实测]/[静态]）

```
diff engine/lua/bootstrap.lua mod/src/main/resources/lua/bootstrap.lua
  → 99 行 diff，含三处语义补丁：
     __TASK_ERR 旁路（LuaJ 把 table 错误字符串化）
     atan2 兼容（math.atan2 vs math.atan）
     math.type 兜底（LuaJ 无 5.3 数值类型）
diff bslib.lua → 8 行；json.lua → 4 行
```

补丁本身合理，但**分发方式是手工复制**：无生成、无校验。引擎侧修调度缺陷不会自动进入 mod。

### 2.4 P1 — 桥接是字符串协议，没有契约（[静态]）

- 53 个具名桥名在 JS 与 Lua 两侧手写；`engine/lua/bot-api.d.lua`（587 行）只是编辑器提示，`engine/validate.js` 不解析它，运行期不断言。
- 参数/返回值靠每个 handler 自觉编解码；同一份 `try/catch + log + rethrow` 在 6 处重复。
- 后果：改名/改形只能在运行期暴露；错误形状取决于各 handler；策略/审计入口不统一。

### 2.5 P1 — 宿主/部署逻辑重复（[静态]）

- `parseServer`：`engine/cli.js:62` 与 `engine/worker.js:24`。
- `deploy.yaml` 的 `package / persist / view_distance / account` 解析在两处逐字重复；`host.js` 是第三种进程管理路径。
- 退出分类（`user` / `foreseeable` / `internal`）分散在 `worker.js` 的 `shutdown`、`main().catch`、`host.js` 的 `error`/`exit`。
- `validate.js` 只校验**包**，不校验 deploy.yaml；三处宿主各自信任它。
- 跨仓重复：平台仓 `test/deploy-yaml.test.js` 自述「引擎侧读取逻辑，逐字复制」。

### 2.6 P1 — 版本适配知识散落（[静态]）

- `drivers/mineflayer/tickEnd.js`：26.x 的 `client_tick_end` + 同 tick 单移动包补丁，**无版本判定**。
- `entity_teleport` 布局依赖特定 `minecraft-data` 版本（测试见 `engine/test/run.js:1618-1636` 一带）。
- `physics.yawSpeed` 调整、`shortestYaw` 归一化、Windows emscripten 屏蔽 `fetch`（`engine.js:832-843` 与 `validate.js:17-24` 各一份）。
- 所有这些止血都正确，但没有登记为「按版本启用的适配项」，无法回答「当前版本装了哪些补丁」。

### 2.7 P2 — 测试结构（[静态]）

- CI 仅跑 mock 冒烟 + 示例包 validate + gradle build；`test/live*.js` 不进 CI。
- 没有 JS(wasmoon) ↔ Java(Luaj) 一致性测试——这正是 2.1 / 2.3 的分叉能长期存在的原因。
- Java 侧 JUnit（`LuaHostTest.java` 256 行）与 JS 侧断言不共享同一组 golden 用例。

### 2.8 P2 — 文档/实现漂移（[实测]）

- `engine/httpapi.js:4` 注释写「无 /eval」，`:113` 实现了 `case '/eval'`。
- README 的「九端点」等计数性描述与路由表无生成关系。

### 2.9 P2 — 脚本环境与沙箱（[实测]/[待核实]）

- 用户脚本以全局环境执行（`engine.js:461`），可直接调用 `__q_*` / `__act_*` 全局；动作仍有宿主门控，但**声明层包装可被绕过**。
- wasmoon 标准库实测：`os.execute` 存在但调用失败（emscripten 无实现）；`io.open` 对宿主路径返回 `nil`（VFS 仅挂实例脚本）。**这不是已证实的漏洞**，只是现状描述，完整安全评估需逐项实测（见 §8）。

---

## 3. 目标架构

### 3.1 原则

| 原则 | 治病对象 |
|---|---|
| 契约先于代码：名字/形状/错误/能力先定义，再生成 | 手写桥、手写 API 文档、两侧分叉 |
| 协议真相只在宿主；核心不存协议常量 | 槽位常量两处、协议补丁散落 |
| 语义只在 Lua 核心（唯一源码） | Lua 三拷贝、调度语义两份 |
| 强制点在 ABI 下方：策略/速率/预算在唯一 dispatch 执行 | 门控分散、包装可绕 |
| 原语下沉、编排上移 | 导航/容器/战斗节奏在宿主里各写一套 |
| 一致性靠 golden 向量，不靠人眼 | JS/Java 数据表分叉、Lua 漂移 |

### 3.2 分层

```
┌──────────────────────── 契约层（唯一真源，生成代码） ────────────────────────┐
│ contracts/host-abi.yaml    op/类型/错误/gate/caps/版本协商                    │
│ contracts/errors.yaml · events.yaml                                         │
│ contracts/package.schema.json · deploy.schema.json · policy.schema.json     │
│ contracts/http17.openapi.yaml                                               │
│ contracts/vectors/**.json   跨宿主 golden（调度/窗口/策略/持久化/数据）       │
└─────────┬───────────────────────────────────────────────┬───────────────────┘
          │ codegen                                        │ codegen
┌─────────▼──────────────────────┐             ┌──────────▼────────────────────┐
│ runtime/lua（唯一语义实现）      │  宿主 ABI   │ hosts/*（薄适配器，可替换）     │
│ core/{bootstrap,bslib,json}.lua │ ◀────────▶ │ node：vm/tokens/abi/state/     │
│ core/params · commands（语义）   │  q / a /    │       policy/persist/obs/      │
│ compat/luaj.lua（仅 Java 加载）  │  resume     │       runners/driver           │
└─────────────────────────────────┘             │ fabric：AbiDispatcher/McState/ │
                                                │         LuaRuntime/http17      │
                                                └────────────────────────────────┘
```

### 3.3 宿主 ABI v1（四个入口）

```
核心 → 宿主（同步）    __host_q(op, argsJson)               → resultJson
核心 → 宿主（异步）    __host_a(op, argsJson)               → token
宿主 → 核心（同步）    __core_call(op, argsJson)             → resultJson   （新）
宿主 → 核心（异步）    __core_resume(id, okJson, errJson) · __core_event(kind, payloadJson)
```

- 所有 `op` 在 `host-abi.yaml` 声明参数/结果 schema、同步性、`gate` 类别、所需能力。
- `__host_a` 的 dispatch 是**唯一**的策略门控、dry-run、速率、审计与 token 结算入口（现散在 `actionEntry` 与各动作里）。
- `__core_call` 让宿主的 HTTP/stdin/IPC 入口（§17 `/params`、`/cmd`、`/tasks`、`/eval`）走显式的反向契约，而非伸手摸宿主内部状态。
- 重入规则只由 `hosts/node/tokens.js`（或 `LuaHost`）维护：**宿主不得在核心→宿主调用帧内反向调核心**，否则排队。

ABI 摘录：

```yaml
abi: 1
capabilities: [nav.pathfinder, data.registry, combat.attributes, protocol.tick_end]
sync_ops:
  - self.get                 -> Self
  - entities.list            -> Entity[]
  - entities.get   {id}      -> Entity|null
  - world.block    {pos}     -> {name, ts, stale}
  - world.scan     {region,pred,limit} -> BlockPos[]
  - window.current           -> WindowRef|null
  - window.get     {id}      -> Window|null          # 槽位布局已由宿主归一化
  - session.get              -> {state, info}
  - world.env                -> {dimension,time_of_day,weather}
  - caps.get       {flag}    -> boolean
  - data.item      {id}      -> {stack_size, weapon?: WeaponProfile}
  - persist.*                -> ...                   # 12 个原语，见附录 A
async_ops:
  - {name: act.chat_send, gate: chat, args: {text}}
  - {name: act.rot,       args: {yaw?, pitch?}}
  - {name: act.hop}
  - {name: act.move_input,args: {fwd,strafe,jump,sneak,sprint}}
  - {name: act.path_to, gate: move, args: {target, opts}}
  - {name: act.path_cancel}
  - {name: act.window_open, args: {target}}
  - {name: act.window_click, args: {window, slot, button, mode}}
  - {name: act.window_close}
  - {name: act.use_block / use_entity / use_item / dig / respawn}
errors: [permission.denied, policy.blocklist, entity.gone, container.closed,
         nav.unreachable, chat.offline, abi.invalid_args, data.unknown]
```

**生成物**（YAML → 四份，杜绝手抄）：

| 产物 | 用途 |
|---|---|
| `runtime/lua/core/bridge.generated.lua` | 带类型的核心侧存根（核心不直接写桥名字符串） |
| `engine/lua/bot-api.d.lua` | 由同一 manifest 生成（编辑器补全 + API lint 依据） |
| `hosts/node/abi.generated.js` | op 表 + schema 校验 + 统一 gate/审计/token 入口 |
| `mod/**/runtime/AbiOps.java`（生成物，类名必须与文件名一致） | op 常量 + JSON 形状校验 |

### 3.4 职责不变式（评审重点）

1. **宿主拥有协议与强制**：连接、原始状态、动作原语、策略门控、持久化实现、观测环、§17 HTTP、版本补丁。
2. **核心拥有脚本语义**：任务/取消/声明/命令/参数/bslib；组合行为（导航、开箱瞄准与重试、装备、战斗节奏）在 Lua。
3. **归一化只在宿主内部**：`Window`、`Item`、`Entity`、yaw 单位、实体类型名，出口一律为契约模型；**核心与宿主业务代码里不得再出现 `size+27`、`45`、`minecraft:` 前缀判断**。

由此消除的三类重复：

| 现状 | 目标 |
|---|---|
| 槽位映射 host+engine 各一份 | `hosts/node/state/windows.js` 与 fabric `McState` 各自实现，**用 `vectors/windows/*.json` 对齐** |
| 数据表三份 | `data.item` 由宿主实现：Node 读 `minecraft-data`，Fabric 读客户端注册表 |
| 策略/命令/聊天门控分散 | `__host_a` dispatch 一处执行；规则由 `policy.schema.json` 描述，`vectors/policy/*.json` 保证同判 |

**原语下沉、编排上移**的具体清单：

| 现位于宿主（engine.js） | 目标位置 |
|---|---|
| `navGoto` / `straightGoto` / `navFollow` / `runGotoAwait`（约 140 行） | `runtime/lua/core/bslib.lua`（用 `act.path_to`/`act.path_cancel`/`act.move_input`/`act.rot`） |
| `container_open` 的瞄准、退让、重试；`inv_equip` 的点击序列 | 同上（用 `act.rot`/`act.window_open`/`act.window_click`） |
| 武器冷却计时、攻击节流 | 同上（`data.item` + 核心侧时间线） |
| 策略判定、速率、预算、dry-run、审计 | 保留在宿主 `__host_a`（安全边界） |

> 风险提示：导航与容器编排从 JS 移到 Lua 是**行为路径变化**，必须由现有 49 个冒烟用例 + 新增向量双重保底；若评审认为风险过高，可分两步：先搬容器、后搬导航。

### 3.5 Lua 单一源与 LuaJ 兼容

```
runtime/lua/core/{bootstrap,bslib,json}.lua   ← 唯一源码（入库）
runtime/lua/compat/luaj.lua                   ← LuaJ 补丁（__TASK_ERR 旁路 / atan2 / math.type）
```

- Node 宿主直接挂载 `runtime/lua/core`；Fabric 的 `processResources` 依赖 `tools/sync-lua`，从同一处复制 core，并额外挂载 `compat/luaj.lua`。
- CI 门禁：`sha256(runtime/lua/core/*) == sha256(mod/src/main/resources/lua/core/*)`，不一致即红。
- 兼容补丁从 bootstrap 正文移出——改调度的人不必再理解 LuaJ 语义。

### 3.6 Node 宿主内部

```
hosts/node/
  vm.js            wasmoon 创建 + fetch 屏蔽 + VFS 挂载（唯一接触 wasmoon）
  tokens.js        token/settled/pendingResume/frozen + 重入规则（唯一）
  abi.generated.js op 表 + 校验 + gate + dry-run + 速率 + 审计 + 结算
  state/           self / world / windows / session：归一化模型，事件进、查询出、revision
  policy.js        规则引擎（<150 行，schema + vectors 驱动）
  persist.js       node:sqlite 实现 persist ABI（事务 / seen / log 语义由 vectors 锁定）
  obs.js           日志/动作/聊天环 + 单调 seq + SSE 出口
  runners/         cli / worker / cluster（I/O 与进程模型）
  deploy.js        deploy.yaml 解析/归一化/校验（平台共用同一 schema）
  drivers/mineflayer/{index, snapshot, tickEnd, patches/*, protocolTrace}
```

`engine.js` 不再作为实现文件存在，只保留 <300 行组装（vm + tokens + state + abi + obs + driver）。

### 3.7 Fabric 宿主

```
AbiDispatcher.java   单一 dispatch：schema 校验 + 策略门控 + token
McState.java         由客户端事件归一化 self/world/entities/windows/session
LuaRuntime.java      Luaj + runtime/lua/core + compat/luaj
PersistStore.java    实现 persist ABI（current 逻辑保留，补 vectors）
HttpApi.java         按 contracts/http17.openapi.yaml 实现，路由表生成
DataRegistry.java    data.item → 客户端注册表（ItemStack.getMaxCount / 属性 / 方块实体）
```

`GameTables.java` 删除，数据职责迁到 `DataRegistry`。

### 3.8 版本适配成为数据

```
hosts/node/drivers/mineflayer/patches/
  tick-end-26x.js     { match(version), install(bot), reason, fixture }
  teleport-packets.js
```

- 每个补丁登记 `id`、适用条件、安装点、录制帧 fixture 与回归用例；
- `/caps` 与启动日志输出「已应用补丁 id」；
- 核心只读 capabilities，不做版本判断；`data.registry` 缺失时才走兜底表（有日志与告警）。

### 3.9 平台对接（bot-platform）

- 平台通过 `BOTSCRIPT_REF` 固定引擎提交；镜像 label 增加 `botscript.abi=<n>`，控制面按 ABI 版本与 `caps` 决定功能面。
- 平台不再复制引擎解析逻辑：`package.schema.json` / `deploy.schema.json` 随引擎仓发布，平台按其校验（或生成校验器）。
- `validateGate` 升级为编译式：schema + Lua 编译 + **API lint**（调用了契约外 API 的包直接拒绝入库），诊断结构化回传。

---

## 4. 目录迁移映射

| 现状 | 目标 |
|---|---|
| `engine/engine.js` 2108 | `hosts/node/{vm,tokens,abi,state,policy,persist,obs}.js`（各 <400） |
| `engine/cli.js` / `worker.js` / `host.js` | `hosts/node/runners/{cli,worker,cluster}.js` + `InstanceSupervisor` 接口 |
| `engine/httpapi.js` | `hosts/node/http17.js`（按 openapi 生成路由表） |
| `engine/validate.js` | `tools/validate`（schema + Lua 编译 + API lint） |
| `engine/lua/*` | `runtime/lua/core/*` + `runtime/lua/compat/luaj.lua` |
| `engine/test/run.js` 1792 | `testing/{scheduler,persist,policy,windows,actions,...}/*.test.js` + `testing/harness.js` |
| `drivers/mineflayer/*` | `hosts/node/drivers/mineflayer/*`（协议补丁进 `patches/`） |
| `mod/.../lua/*` | 构建期从 `runtime/lua` 复制（不再入库第二份） |
| `mod/.../GameTables.java` | 删除；`DataRegistry` 读客户端注册表 |
| `mod/.../LuaHost.java` 745 | `AbiDispatcher` + `LuaRuntime`（按同一契约拆分） |

---

## 5. 测试与 CI 门禁

| 门禁 | 判定 | 当前状态 |
|---|---|---|
| `contract-lint` | codegen 与 manifest 一致；每个 op 有类型与 gate | 无 |
| `abi-conformance` | fake host 跑遍每个 op（≥1 向量）；错误形状一致 | 无 |
| `scheduler-vectors` | race/parallel/cancel/pause/after 在 wasmoon 与 Luaj 上产出相同事件序列 | 无 |
| `window-vectors` | 同一原始槽位快照 → 两宿主归一化逐槽一致 | 无 |
| `policy-vectors` | 同一 boundary + 动作 → 同允许/拒绝与同 error kind | 无 |
| `persist-vectors` | 同操作序列 → 相同表行、事务回滚、seen/log 语义 | 无 |
| `data-parity` | Node 全量 vs `minecraft-data` 多版本；Fabric 集成测 vs 客户端注册表 | 无（**建议先做，可独立止血**） |
| `api-lint` | 示例包与用户包只调用契约内 API | 无（`validate` 仅查清单 + 编译） |
| `http17-conformance` | 两宿主对同一请求返回同形状响应 | 无 |
| `lua-sync` | 两份 Lua 资源哈希一致 | 无 |
| `live`（nightly） | 本地 Paper 实连 | 有，未进 CI |

所有向量是**语言无关 JSON**，Node 与 Java 各自执行同一份——这是防止分叉复发的唯一可行机制。

---

## 6. 分阶段落地

| 阶段 | 产物 | 验收 | 估算 | 风险 |
|---|---|---|---:|---|
| **0 契约冻结** | `contracts/host-abi.yaml`（附录 A 的映射落地）、`errors.yaml`、codegen 骨架、Node dispatcher 接线（**不改行为**） | 现有 49 个冒烟用例全绿；gate：所有注册名 ∈ manifest | 1–2 天 | 清单漏项 → 用「注册名 ⊆ manifest」测试兜底 |
| **0′ 数据止血（可并行）** | `data-parity` 向量先写红 → 引入 `data.item` 注册表 → 删前缀启发式 → 容器表补齐 | 三个版本 mismatch = 0；`iron_ingot` 返回 64 | 0.5–1 天 | 无（纯数据，行为修正） |
| **1 Lua 单一源** | `runtime/lua` + `compat/luaj`、gradle 同步、哈希门禁、首批 10 个调度向量 | diff = 0；两运行时向量全绿；mod 现有 JUnit 绿 | 1–2 天 | LuaJ 差异遗漏 → 向量覆盖 |
| **2 Node 宿主分层** | vm/tokens/state/obs/persist/policy 抽出；`engine.js` → 组装；测试 harness；`run.js` 按域拆分 | 单文件 ≤400 行（生成物除外）；行为不变；内存不劣化 | 3–5 天 | 行为回归 → 先建 harness 与特性开关 |
| **3 Fabric 对齐** | `AbiDispatcher` + `McState`；window/policy/persist 向量；删 `GameTables` | JUnit 向量全绿；游戏内冒烟清单（进服/聊天/开箱/移动/断线） | 2–4 天 | 窗口/菜单真实行为差异 → 需要游戏内验证 |
| **4 编排上移** | 导航/容器/装备/冷却从宿主移到 bslib | 冒烟 + 向量全绿；两宿主行为一致 | 2–3 天 | 时序敏感 → 可分两步（先容器后导航） |
| **5 宿主/部署统一** | `deploy.js` + runners 复用；版本补丁登记；§17 OpenAPI | cli/worker 同解析器；`/caps` 列出补丁；HTTP 一致性向量 | 2–3 天 | 低 |
| **6 加固与生成文档** | 用户脚本受限 `_ENV`；API 文档/端点表生成 | 脚本只见公开 API；docs 与 manifest 一致 | 1–2 天 | 存量包兼容性 → 先告警后强制 |

总计约 **12–20 人日**，0/0′/1 可并行，3 需要游戏内验证窗口。

---

## 7. 反模式（明确不做）

- 不把调度核心搬到 JS：Fabric 存在一天，Lua 就是唯一共享语义层。
- 不让核心知道任何协议布局/版本细节。
- 不把策略只放 Lua：脚本与宿主共享 `_G`，硬强制必须在 ABI 下方；Lua 侧检查只改善体验。
- 不为消除重复而强行统一跨语言 HTTP/JSON 实现：只共享规范与向量。
- 不按行数切分 2108 行文件：没有 ABI 与 harness，切完仍是一坨耦合。
- 不手写 API 文档/存根/错误常量：全部生成。

---

## 8. 需要评审拍板

1. **Fabric 宿主是否长期保留？** 保留 → 按 ABI + parity 全套走；不保留 → 砍掉 `compat/luaj` 与跨宿主 parity，范围约减 1/3。
2. **26.x 协议适配是否要求两宿主都覆盖？** 决定 `capabilities` 粒度与 Fabric 侧补丁量。
3. **是否接受「包闸门升级为 API lint」？** 存量包可能需要一次迁移公告。
4. **导航/容器编排上移 Lua 是否接受作为第一批？** 若担心时序回归，改为阶段 4 后半、先容器后导航。
5. **ABI 版本治理**：平台按 `botscript.abi` label 做功能门控是否纳入本次范围？

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| manifest 与实现漂移 | 契约失真 | codegen + 「注册名 ⊆ manifest」CI |
| codegen 过度复杂 | 维护成本 | 两个小模板（Lua/JS）、一个 Java 常量模板；不生成业务逻辑 |
| 行为路径变化（导航上移） | 线上回归 | 冒烟 + 向量 + 灰度（实例级开关） |
| Fabric 无法完全无头验证 | 宿主差异漏检 | fake `McState` 向量 + 游戏内冒烟清单 |
| JSON 边界开销 | 查询延迟 | 同步原语保持轻量；批量查询合并；基准测试 |
| 平台发布耦合 | 发布窗口 | `BOTSCRIPT_REF` + `abi` label；平台兼容旧 ABI 一个版本 |

---

## 10. 附录 A — 现有桥清单 → 目标 ABI

### A.1 基础设施/调度（宿主或核心内部）

| 当前（`engine.js` 行） | 目标 | 处置 |
|---|---|---|
| `__log` 905 | `obs.log` | 保留（宿主拥有环/SSE/stdout） |
| `__now` 906 | `util.now` | 保留 |
| `__fire_token` 907 | 核心内部 | 移入 Lua（detached 标记） |
| `__core_register_waiter` 913 / `__sleep_register` 922 / `__new_waiter` 931 / `__resolve_waiter` 944 | `__host_a` 通用 token + `timer`/`events` op | 合并 |
| `__rex_new` 953 / `__rex_match` 962 | `util.regex` | 保留（Lua pattern 无命名分组） |
| `__timer_register` 971 / `__after_register` 979 | `timer.interval` / `timer.after` | 保留 |
| `__evt_emit` 989 | `events.emit`（核心→宿主观测/上行） | 保留 |
| `__evt_next` 1000 | `events.next`（宿主→核心，经 resume） | 保留 |
| `__command_register` 1181 | `commands.declare` | 保留 |
| `__params_decl` 1045 / `__param_get` 1049 / `__params_validate` 1119 | 参数归核心；宿主 HTTP 经 `__core_call('params.*')` | 上移 + 反向 op |
| `__persist_*` 1139-1157 + `__kv_*` 1154-1155 + `__txn_*` 1166-1168 | `persist.*`（12 原语） | 保留（语义由 vectors 锁定） |

### A.2 查询

| 当前 | 目标 | 处置 |
|---|---|---|
| `__q_self` 1351 / `__q_look` 1361 | `self.get` | 合并（look 由核心派生） |
| `__q_entities` 1367 / `__q_entity_snap` 1368 | `entities.list` / `entities.get` | 保留 |
| `__q_block` 1373 / `__q_staleness` 1395 | `world.block`（含 stale） | 合并 |
| `__q_distance` 1400 | 无 | **删除**（核心算） |
| `__q_can_reach` 1406 | 无（capability `nav.pathfinder` 下由 `act.path_to` 反馈） | **删除** |
| `__q_current_window` 1413 / `__q_window` 1414 | `window.current` / `window.get` | 合并 |
| `__q_cooldown` 1449 | 无 | **删除**（核心算） |
| `__q_session_state` 1454 / `__q_session_info` 1455 / `__q_server_version` 1461 / `__q_dimension` 1468 / `__q_time_of_day` 1469 / `__q_weather` 1470 | `session.get` / `world.env` | 合并 |
| `__q_caps` 1456 | `caps.get` | 保留 |
| `__q_stack_size` 1462 / `__q_weapon_score` 1463 | `data.item` | 合并 |
| `__task_list` 1471 | 无（返回 `[]` 的死代码） | **删除** |

### A.3 动作（宿主只留原语）

| 当前 `A(...)` | 目标原语 | 编排去向 |
|---|---|---|
| `chat_send` 1488 / `chat_reply` 1495 | `act.chat_send` | reply 组合进核心 |
| `rot` 1510 / `hop` 1522 | `act.rot` / `act.hop` | — |
| `nav_stop` 1527 | `act.path_cancel` + `act.move_input` | 组合进 bslib |
| `nav_goto` 1533 / `nav_follow` 1534 | `act.path_to` / `act.path_cancel` / `act.move_input` / `act.rot` | **上移 bslib** |
| `world_scan` 1536 | `world.scan`（同步查询） | — |
| `container_open` 1545 / `container_close` 1626 | `act.window_open` / `act.window_close` | 瞄准/重试/退让上移 bslib |
| `window_click` 1633 | `act.window_click` | — |
| `inv_equip` 1661 / `inv_drop` 1678 | `act.window_click`（+ 待实现 `act.drop`） | 组合进 bslib |
| `use_entity` 1684 / `use_block` 1694 / `use_item` 1704 / `dig` 1712 | 同名 `act.*` | — |
| `actionEntry` | `__host_a` dispatch | 策略/速率/预算/审计/结算**唯一入口** |

### A.4 反向接口（宿主 → 核心，新增显式化）

| 用途 | 目标 |
|---|---|
| 结算 / 事件（已有） | `__core_resume` / `__core_event` |
| §17 `/params` GET/POST | `__core_call('params.get' / 'params.set')` |
| `/cmd`、stdin、IPC 命令 | `__core_call('command.dispatch')` |
| `/tasks`、`/cancel` | `__core_call('tasks.list' / 'tasks.cancel')` |
| `/eval` | `__core_call('eval.once')` |

---

## 11. 附录 B — 数据比对方法与复现

**方法**：逐字复制 `engine/engine.js:12-36` 的 `STACK16/STACK1/STACK1_PREFIX` 规则与 `stackSizeOf`，对 `minecraft-data` 各版本 `items` 的 `stackSize` 逐项比对；同样复制 `GameTables.java` 的规则做第二次比对。剔除 `air`、`*_wall_banner`、`infested*`、`*spawn_egg`。

**复现脚本**（在仓库根执行；需能解析本地 `node_modules`）：

```bash
cat > /tmp/stack-compare.cjs <<'EOF'
const mdMod = require('minecraft-data');
const mcd = mdMod.default ?? mdMod;
const STACK16 = new Set([/* 逐字复制 engine.js:12-18 */]);
const STACK1_PREFIX = ['minecraft:wooden_','minecraft:stone_','minecraft:iron_','minecraft:golden_','minecraft:diamond_','minecraft:netherite_'];
const STACK1 = new Set([/* 逐字复制 engine.js:23-28 */]);
function jsStack(id){ if(!id||!id.startsWith('minecraft:')) return 64;
  if(STACK16.has(id)) return 16; if(STACK1.has(id)) return 1;
  if(STACK1_PREFIX.some(p=>id.startsWith(p))) return 1; return 64; }
for (const ver of ['1.21.8','1.21.4','1.20.1']) {
  const d = mcd(ver), bad = [];
  for (const i of Object.values(d.items)) {
    if (i.name==='air'||i.name.endsWith('_wall_banner')||i.name.startsWith('infested')||i.name.includes('spawn_egg')) continue;
    const id = 'minecraft:'+i.name;
    if (jsStack(id) !== i.stackSize) bad.push([i.name, jsStack(id), i.stackSize]);
  }
  console.log(ver, bad.length, '/', Object.keys(d.items).length, bad.slice(0,8));
}
EOF
NODE_PATH=$PWD/node_modules node /tmp/stack-compare.cjs
```

> 说明：完整脚本（含 `GameTables.java` 规则的镜像实现）在本次评审材料中给出；本仓库未新增该脚本文件。

---

## 13. 落地记录（2026-11-19）

> 本节记录方案落地后的真实状态与验收证据，供评审逐条核对；与上文草案冲突时以本节为准。

| 阶段 | 状态 | 落点 | 验收证据 |
|---|---|---|---|
| 0 契约冻结 | ✅ | `contracts/host-abi.yaml`（sync/async/reverse op、gate、能力、required）；`errors.yaml`、`events.yaml`；`tools/codegen.mjs` 生成 Lua bridge / Node op 表 / Java op 表 / bot-api.d.lua / HTTP 路由表 | `node tools/contract-lint.mjs`（生成物一致 + 核心无旧桥名 + 槽位常量不外溢）；`testing/vectors.test.js` 的 abi-conformance（每个 op 都被 dispatch 过） |
| 0′ 数据止血 | ✅（v2 收敛为组件真值） | `hosts/node/data.js`（ItemStack 组件）；Fabric `DataRegistry`（ItemStack 组件）；`contracts/data/containers.json` | `contracts/vectors/data/items.{1.21.8,1.21.4,1.20.1}.json` 全量比对 mismatch=0；旧前缀规则护栏断言其判错 >100 项 |
| 1 Lua 单一源 | ✅ | `runtime/lua/core/*`；`runtime/lua/compat/luaj.lua`；mod 构建期 processResources 拷贝 | `node tools/sync-lua.mjs --check`；wasmoon 与 Luaj 同跑 `contracts/vectors/scheduler/*` 得到同序列（Node `testing/vectors.test.js` + Java `LuaRuntimeTest`） |
| 2 Node 宿主分层 | ✅ | `hosts/node/{vm,tokens,abi,state,policy,persist,obs,data,deploy}.js`；`engine.js` 组装 | `testing/run.js` 66 项；`engine.js` 组装层不再含业务语义 |
| 3 Fabric 对齐 | ✅（本地 JUnit + Gradle 验证） | `AbiDispatcher/McState/LuaRuntime/DataRegistry/WindowLayout`；删除 `GameTables/LuaHost/CommandBus`；`HttpApi` 按 openapi 路由 | `RuntimeContractTest`（policy/window/persist 向量 + 容器门控 + 事务回滚）；`LuaRuntimeTest`（调度向量 + token/pause/params） |
| 4 编排上移 | ✅ | 导航（含直线退化）、开箱瞄准/重试、装备点击、战斗冷却 → `runtime/lua/core/bslib.lua` | 容器搬运、organizer、coal_guard 端到端用例 |
| 5 宿主/部署统一 | ✅ | `hosts/node/deploy.js`（cli/worker 共用）；`runners/{cli,worker,cluster}.js`；`patches/` 登记表 | `deploy.test.js` 锁 version 顶层键；`/caps` 输出 patches；`engine/cli.js`/`host.js` 保留为兼容入口 |
| 6 加固与生成文档 | ⚠️ 部分 | 包闸门 = schema + Lua 编译 + **API lint**（严格模式，`__*`/io/os/debug/load 判死）；API 文档由 api-surface 生成 | `engine/cli.js validate examples/*` 全绿；运行期 `_ENV` 限制**未默认开启**（存量包兼容后再切，见 README 已知限制） |

### v2 修订（2026-11-19 评审后）

- **ItemStack 组件真值**：删除 `data.item(id)` 与 `data.stack_size` / `data.weapon_score` / `data.cooldown_ms`；
  改为 `item.stack(stack)` 直接读 `max_stack_size` / `max_damage` / `attribute_modifiers` 等组件。
  选装策略（原 weapon_score）回 bslib，按 attack_damage × attack_speed 计算；宿主读不到属性时用核心节奏下限。
- **移除命令能力**：删除 `command.declare` / `command.dispatch` / `on_command` / 权威解析 / HTTP `/cmd`；
  新增 `/pause`、`/resume`；脚本控制改 `on_chat` 自行判定操作员（平台不内置 owner/op/白名单）。
  平台侧原 `POST /cmd`（pause/resume）需改为 `POST /pause` / `POST /resume`。
- **动作按原版发包**：删除 hop / move_input / use_item.duration / chat_reply / respawn；
  改为 look / input / player_action / interact / use_item(start|release) / select_slot / drop / window_*。
- **ABI Result 化（2026-11-20）**：核心→宿主同步/异步全部返回
  `{ok:true,value}` / `{ok:false,error:{code,message}}`；确定性失败不再以异常进入 Lua。
  取消是独立控制通道（`__core_resume` 的 ctlJson + 任务取消），不进 Result/`on_error`；
  Lua 原生 `error()` 仍为任务级失败；宿主意外异常只记日志，Lua 最多看到稳定码 `internal`。
- **tick_end 不是能力**：从 capabilities 删除；版本适配只登记在 `drivers/mineflayer/patches`，`/caps.patches` 可见。
  **补丁必须常装**（26.x 必须、1.21.8 无害）：线上回归——1.21.8 配置 + Velocity/26.3 后端，
  按 `major>=26` 收窄补丁后实例加入约 15s 被静默断开；旧驱动一直是无条件安装。
- **补全数据面**：self.effects/attributes、world block_state/block_entity/reach、真实 time_of_day/weather、实体全状态。
- 能力清单收敛为 `nav.pathfinder` / `item.components` / `world.block_entity`（只有 nav.pathfinder 改变核心分支）。

偏差与说明：

- **进入路径不动**：平台按 `BOTSCRIPT_CLI=engine/cli.js`、`BOTSCRIPT_HOST=engine/host.js` 调用，
  因此这两个文件保留为转发壳；实现全部在 `hosts/node/`。
- **Fabric `/session`**：客户端会话随玩家登录器，mod 不持有凭据，该端点返回 409 `session.account_mode`（形状一致、语义不同）。
- **Fabric 无协议补丁**：`/caps` 的 patches 为空数组；Node 侧登记 tick-end-26x 与 teleport-packets。
- **LuaJ 兼容**：`__TASK_ERR` 旁路由 `compat/luaj.lua` 打开开关，bootstrap 据此包 pcall（wasmoon 路径不包，避免无谓开销）。
- **数字格式化差异**：LuaJ `string.format("%.0f")` 输出 `0.0` 而 5.4 输出 `0`；向量只比较契约事件与日志文本，不依赖该格式。

## 12. 附录 C — 本次分析未覆盖 / 待核实

| 项 | 状态 | 核验方式 |
|---|---|---|
| 生产实例的实际行为 | 未接触现场 | 需要 console/agent/host.log 现场；本方案只做代码与数据层结论 |
| Fabric 运行期的真实物品表（含模组物品） | 未运行 mod | 游戏内或 headless LuaJ + 客户端注册表集成测 |
| 两份 Lua 拷贝漂移的实际行为差异 | 差异已测（99 行），行为影响未测 | 用 `scheduler-vectors` 在 wasmoon/Luaj 各跑一遍比事件流 |
| wasmoon 沙箱完整性 | 仅初步探测（`os.execute` 失效、`io.open` 宿主路径 nil） | 需按读文件/写文件/网络/子进程逐项实测后再定性 |
| worker 内存/性能数字 | 来自源码注释的历史实测 | 本次未复测；阶段 2 结束时须重新基准 |
| 平台闸门对 API lint 的兼容成本 | 未评估 | 统计存量包 API 使用面后给出迁移公告 |
