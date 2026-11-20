# bot-script 查询性能重构方案（草案 · 待评审）

| 项 | 值 |
|---|---|
| 状态 | **P0 + P1 的 #9/#14 已实现（v0.2.1 待发）；其余 P1/P2 仍为草案** |
| 日期 | 2026-11-20 |
| 范围 | `runtime/lua/core/*`、`hosts/node/abi.js`、`hosts/node/data.js`、`hosts/node/state/*`、`hosts/node/drivers/mineflayer/*`、`contracts/host-abi.yaml`；Fabric 宿主的对应 op |
| 关联 | `DESIGN.md`（Lua 唯一核心 + 薄宿主）、`CAPABILITIES.md` §2/§3.4/§3.5、`ARCHITECTURE-REFACTOR.md`（契约先行） |
| 证据等级 | **[实测]** 本机跑微基准；**[静态]** 读代码/依赖可得；**[待核实]** 需线上实例或游戏内验证 |

> 测量环境：WSL2 / Node v22.23.4 / wasmoon 1.7.0 / 仓库自带 `runtime/lua/core/json.lua`。
> 载荷为**按 `snapshotOf` + `data.stack` 输出形状构造的代表性数据**，不是线上抓包 →
> 所有绝对数字标注为 **[实测·合成负载]**，结论中的**量级与相对关系**可用，具体毫秒数需线上复核。

---

## 0. 摘要

**当前查询的性能模型是错的。** 脚本查询的成本不取决于「世界里有多少东西」，而取决于
**每次调用搬过 WASM 边界的 payload 有多大 × 调用频率有多高**。数据侧（读 `bot.entities`、
`bot.blockAt`）只要微秒级，真正吃掉 CPU 的是：

1. 宿主把**完整快照**序列化成 JSON（`data.stack` 逐槽展开组件）；
2. 纯 Lua 的 `json.decode` 把 payload 重新建成表（**~1 MB/s**，占单次查询的 **95%+**）；
3. 脚本以轮询频率（greeter 20Hz / 10Hz）重复付这笔钱；
4. 实体句柄的「活读」被实现成**每个字段一次全量重取**（≈1ms/字段）。

实测（`tools/bench/query-cost.mjs`，min-of-3，10 名玩家、满装备的 `entities.list`）：

| 载荷 | 大小 | 跨桥 | Lua decode | 合计 |
|---|---:|---:|---:|---:|
| 空 Result | ~0 | 5~10µs | 9~19µs | ~30µs |
| `entities.list` 10 玩家（全量） | 17.8 KB | ~160µs | 11~15ms | **13~16ms** |
| `entities.list` 40 怪（全量） | 16.3 KB | ~240µs | 10~16ms | **11~16ms** |
| `window.get` 90 槽（全量 StackInfo） | 8.2 KB | ~100µs | 4.3~6.4ms | **5.5~6.4ms** |
| `entities.get` 单个玩家 | 1.8 KB | 20µs | 1.2~1.6ms | **1.2~1.6ms** |
| `entities.list` 10 玩家（紧凑投影） | 0.9 KB | ~12µs | 0.6~0.9ms | **0.66~1.3ms** |
| JS 侧构造+`JSON.stringify`（10 玩家） | — | — | — | 80µs |

> 同机重复运行有 **±30~40% 抖动**（WSL/GC 噪声），所以正文给区间；决定性的量级是：
> 全量玩家 **十几毫秒**、单玩家 **一毫秒级**、紧凑实体 **零点几毫秒**、窗口槽 **几十微秒**。
> 回归门禁应基于工具输出的相对基线，而不是绝对值。

**结论（三条）：**

1. **主杠杆是 payload 体积和调用次数，不是搜索算法。** 查询一律按「投影 + 谓词下推 +
   聚合 + 帧缓存」重做：过滤/排序/计数留在宿主，Lua 只收它真正消费的字段。
   仅这一条，greeter 的 `nearest` 可从 ~15ms/次降到 ~0.2ms/次（~70×），
   `inv.count` 从 ~5.9ms 降到 ~0.1ms（~50×）。
2. **方块扫描是唯一真正的算法问题。** `world.scan` 走 mineflayer `findBlocks`
   且传了 `useExtraInfo:true`，这会**绕过 section palette 剪枝**，退化成
   「区域体积 × 4096 次方块读取」。实测单块读取（`prismarine-chunk.getBlock`）≈ 1.0µs，
   100³ 区域 ⇒ **~2.3s** 的同步调用，期间整个宿主的 Node 事件循环（含物理 tick、收包）被堵死。
   必须换索引 + 分片。
3. **不少「止血」应当被系统性替代**：`5ms→50ms` 的轮询降频、`useExtraInfo:true`、
   `count: limit*2` 后再过滤、`window_click` 的 4×250ms 猜结果、句柄逐字段穿透、
   `within_ok` 每实体一次 `self.get` —— 它们各自绕开了一个本应在契约层解决的问题。
   第 5 节逐条列出替代方案。

---

## 1. 成本模型（先定这个，再谈实现）

### 1.1 单次查询的成本分解

```
cost(query) ≈ 35µs 固定开销
            + payload_KB × (12µs   跨桥序列化)
            + payload_KB × (700~1000µs  Lua json.decode)
            + JS 侧快照构造 + JSON.stringify（≈ payload 越大越线性，但只占 1~2%）
```

- 跨桥成本随字符串大小线性增长（8KB ≈ 100µs），相对解码可忽略；
- **`json.decode` 才是主项**，且与「表/键的数量」相关性更强：
  - 6 字段的紧凑实体 ≈ **60~130µs/条**；
  - 30 字段的普通实体 ≈ **250~400µs/条**；
  - 带 6 个装备栈（每栈 5 个组件）的玩家 ≈ **1.2~1.6ms/条**；
  - 窗口槽位（`index` + 8 字段 StackInfo）≈ **50~70µs/槽**。
- 解码成本比跨桥成本高 1~2 个数量级（8KB 载荷：4.3~6.4ms vs ~100µs ≈ 50×）。
  **省字节必须省在解码侧（减键、减嵌套），只是压缩字符串收益有限。**

### 1.2 由此得到的工程预算

| 频率 | payload 预算 | 单次耗时预算 |
|---|---|---|
| ≥ 10Hz（`nearest`/`self.get`/`inv.count`） | ≤ 512 B | ≤ 0.6ms |
| 1~10Hz（`find`/`window.get` 概览） | ≤ 4 KB | ≤ 4ms |
| 一次性（冷启动 `scan`、全量背包） | ≤ 32 KB | 分片执行，单片 ≤ 10ms，不得阻塞事件循环 |

（按实测 ≈0.7~1.0ms/KB 的解码速率反推；高频 op 一旦超过 512B 就应该改成聚合/投影。）

超过预算即视为回归：`abi` 侧记 `perf` 计数，`/state` 暴露 top-N，不靠人肉发现。

### 1.3 已评估并否决：wasmoon 的原生对象代理

wasmoon 允许 JS 函数直接返回对象（Lua 侧得到 `userdata`，按下标/键访问可用）。
实测同样的 10 玩家列表：**30~160µs/次**（同组载荷 JSON 路径为十几毫秒），看似数量级收益，但：

- `type(x)` 变成 `userdata`（不是 `table`），`pairs()` **不可用**（实测报错
  `for iterator is not callable`），`snapshot()` 的深拷贝、`json.encode`、
  现有全部 `type(x) == "table"` 判断都失效；
- **逐字段访问 ≈ 8~13µs/次**（两次字段读实测 16~27µs），实体循环里按字段读的脚本会更慢；
- 破坏「ABI ResultJson 字符串」这条跨宿主统一协议（Fabric/LuaJ 没有等价物）。

**结论：保持 JSON 字符串协议，不引入 userdata 代理。** 收益从「投影/聚合/缓存」拿，
不从编码格式拿（编码层优化见 §3.8，属于 P3 且需先有基准）。

---

## 2. 现状热点

### 2.1 实体

**链路**（`entity.nearest{type='player', alive=true, within=10}`）：

```
Lua bootstrap.lua:1030  entity.nearest
  → bridge.entities.list(type, within)                     [同步 op]
  → abi.js:197  driver.query_entities({type, within})
  → drivers/mineflayer/index.js:327  遍历 bot.entities → snapshotOf() 每条一次
  → abi.js:125  entityOf()  每个装备槽 data.stack() 展开组件
  → JSON.stringify → WASM → json.decode → Lua 表
  → Lua 逐条 within_ok() + pred_match()
```

问题（按影响排序）：

1. **返回全量，脚本只消费极小一部分。** `nearest` 只需要 `id/pos`；greeter 的 `find` 只需要
   `name/id`。但宿主为每条实体构造 30+ 字段、为每个装备槽展开完整 StackInfo。
   `entity.nearest` 的 10 玩家载荷有 **17.8KB**，其中绝大部分是脚本从不读的字段。
2. **`within_ok` 每个实体调用一次 `self_pos()` → `bridge.self.get()`**
   （`bootstrap.lua:973-980`）。即 N 条候选 = N 次额外跨桥；而 `within` 明明已经在宿主侧
   （`index.js:342-345`）过滤过一遍。**同一次查询里同一个距离被算了两次、跨了两次桥。**
3. **句柄「活读」= 每字段一次全量重取。** `ent_mt.__index`（`bootstrap.lua:942-960`）在每次
   字段访问时 `snap_of(id)` → `entities.get` → **1.8KB / 1.2~1.6ms**。`coal_guard.lua:70-84`
   的循环里 `entity.exists(t)`、`t.alive`、`t.equipment`、`t.pos`（多处）各触发一次：
   **每轮 5~7 次全量实体重取 ≈ 6~10ms**（不含 `self.get`）。`entity.find` 更浪费：它已经拿到完整快照
   （`bootstrap.lua:1022-1025`），却只保留 `s.id`，把快照扔掉等下次重取。
4. **函数谓词无法下推**：`type(pred)=="function"` 时只能在 Lua 侧对全量快照做 `pcall` 判定
   （`bootstrap.lua:982-987`）。这类谓词是脚本常规写法，必须有明确的降级策略。
5. **Fabric 宿主 `entities.list` 完全忽略 `type`/`within`**
   （`mod/.../AbiDispatcher.java:277` → `McState.entitiesJson()`）：所有实体全量返回。
   同一个脚本在两个宿主上成本差一个数量级，且契约测试没覆盖。

### 2.2 方块 / 世界

1. **`world.scan` 是同步 op，且退化为全域扫描。**
   `abi.js:215` → `index.js:691-712` → mineflayer `findBlocks({ useExtraInfo: true, count: limit*2 })`。
   mineflayer `lib/plugins/blocks.js:178` 的剪枝条件是
   `if (useExtraInfo === true || isBlockInSection(section, matcher))` —— **传 `true` 正好短路掉
   palette 预筛**，于是区域内**每个 section 的 4096 块都要构造一次 `Block` 并跑谓词**。
   实测 `chunk.getBlock` ≈ 1.0µs/块，100³ 区域（半径 7 section 的八面体 = 575 sections
   → 2.36M 次）≈ **2.3s**。这是**同步调用**，整个宿主事件循环被阻塞；tick 追赶又会触发
   `tick-end-26x` 注释里记录的「6ms 内连发 4 个 position 包」风险。
2. **二次读取**：`found.map(p => bot.blockAt(p).name)`（`index.js:709`）为每个结果再读一遍方块；
   **事后过滤**：区域裁剪在 `.filter` 里做（`index.js:710`），域外结果也占 `count` 名额，
   所以还要 `count: limit*2` 兜底。
3. **没有索引**：每次 scan 都从零遍历；容器这类稀疏目标完全可以用增量索引做到
   「命中数级」成本。
4. **`world.block` 有两份实现**：`abi.js:201-213` 与 `state/world.js:31-51` 各写一遍
   「实时优先、缓存兜底、标 stale」。`WorldState.block()` 没被 ABI 使用。
5. **`scanKinds` 静默吞掉未知谓词**（`data.js:168-172`）：`pred.name` 之类会被当成
   `['chest']` 处理，脚本以为过滤生效，实际返回的是默认集合 —— 静默错误比慢更糟。

### 2.3 物品 / 窗口

1. **`window.get` 每次全量展开 StackInfo。** `abi.js:229-236` 对每个槽 `stackOf()`
   → `data.stack()`：对 `components` 做 **5 次线性 `findComp`**（`data.js:118-149`），
   再拼 9 个字段。`inv.count` / `inv.find` / `win:slots()` 只需要 `id`/`count`，
   却为每个槽付 **50~70µs 解码 + 展开成本**。90 槽 = **~5.9ms/次**。
2. **一次操作多次全量拉取。** `bslib.withdraw/deposit/equip_best`
   （`bslib.lua:316,334,377,400,449-457`）在一次点击序列里反复 `inv.slots()`、`inv.find()`、
   `win:slots()`，每次都重拉整个窗口并重建表；`win_mt.__index` 每次访问还会新建 3 个闭包
   （`bootstrap.lua:1082-1087`）。
3. **无版本缓存**：`WindowState.view()` 每次重建 36~90 个槽对象
   （`state/windows.js:60-77`），即使 `revision` 没变。
4. **`data.stack` 无缓存**：同一个物品在 self.get、window.get、entityOf 里被重复展开；
   注册表默认值（`max_count`/`max_damage`）是静态的，完全可以按 id 缓存。
5. **Fabric 侧同构问题**：`item.stack` 每次重新解析、`window.get` 全量（`AbiDispatcher.java:305-309`）。

### 2.4 采样 / 事件

1. `selfTimer` 每 200ms 执行 `pushSelf()`，里面**遍历整个背包**生成 `inv` 数组
   （`index.js:205,278-288`），而 `abi.js:161` 的 `self.get` 本来就实时直读。
   `inv` 只在平台 UI/诊断里用，却按最高频率采样。
2. `windowTimer` 每 50ms 只要 dirty 就**全量重建**窗口快照并推送
   （`index.js:390-397`）。
3. **事件没有订阅过滤**：`engine.event()` 对每个驱动事件 `JSON.stringify` 后调
   `__core_event`（`engine.js:459-472`），Lua 侧 `__core_event_inner` 无条件 `json.decode`
   （`bootstrap.lua:444-467`），即使脚本没注册该 kind。繁忙服务器上
   `entity.appeared`/`gone`/`block_changed` 是高频的，每条都要付 35µs+解码，
   还会为每个事件 spawn 一次 detached task 检查。
4. 长查询（`world.scan`）在事件循环里同步执行，与采样、收包互斥（见 2.2）。

### 2.5 调度与轮询

`time.sleep(50)` 每轮固定 35µs 跨桥；本身不贵，但它决定了查询频率。
greeter 用 **20Hz 轮询 `nearest` + 10Hz 轮询 `find`**（`examples/greeter/main.lua:22-23`），
在当前实现下分别约 **300ms/s + 150ms/s ≈ 450ms CPU/秒（近半核）**，
只为了「看向最近的玩家」和「检测玩家进出」。
`ae7863e` 把 5ms 调到 50ms 是正确止血，但根因不是「轮询太快」，而是「单次查询太贵」。

---

## 3. 目标设计

### 3.1 四条原则

1. **过滤/排序/聚合在数据侧完成，Lua 只收消费字段**（predicate pushdown + projection）。
2. **查询成本与结果集大小挂钩，不与世界规模挂钩**（索引/预筛）。
3. **同一帧内复用**：一次 tick 里重复的 `self.get`、窗口快照、实体快照只取一次。
4. **长操作不得阻塞宿主事件循环**：超过预算的查询必须分片/异步，可取消。

并且沿用既有架构约束：**新能力必须先进 `contracts/host-abi.yaml`，由 codegen 生成两侧；
不得在 Lua 里手写旁路桥**。宿主缺能力时，Lua 核心回退到当前全量路径（正确性优先）。

### 3.2 契约扩展（草案）

```yaml
capabilities:
  query.plan:        { description: entities.list 支持声明式谓词/投影/排序/限量 }
  query.aggregate:   { description: window.count/window.find 由宿主聚合，只回标量 }
  world.scan_index:  { description: 宿主维护按方块名的增量索引，scan 成本与命中数同阶 }
  host.rev:          { description: Result 信封携带宿主 tick 版本号（帧快照失效用） }

sync_ops:
  - name: entities.list
    args:
      type:       { type: string }
      within:     { type: number }
      pred:       { type: object }    # 声明式谓词（见下表），函数谓词不下推
      projection: { type: string, default: "core" }   # core | full
      order:      { type: string }    # "distance" | 缺省
      limit:      { type: number }
    result: Entity[]                  # core 只保证 id/type/name/uuid/pos/alive/vehicle_id
  - name: window.get
    args:
      window: { type: string, required: true }
      fields: { type: string, default: "full" }   # full | idcount（只回 id/count/damage/max_damage）
    result: Window|null
  - name: window.count
    args: { window: { type: string, required: true }, filter: { type: object } }
    result: number
  - name: window.find
    args: { window: { type: string, required: true }, filter: { type: object } }
    result: number|null               # 首个匹配槽位
  - name: world.scan
    args:
      region:      { type: region, required: true }
      pred:        { type: object }
      limit:       { type: number, default: 200 }
      budget_ms:   { type: number, default: 8 }
      cursor:      { type: string }    # 分片续扫（宿主不透明串）
    result: ScanPage                  # {items:[{x,y,z,id}], complete, cursor?, scanned_sections}
```

**声明式谓词（`pred`）字段**（全部可在宿主用「轻快照」判定，不需要展开 StackInfo）：

| 键 | 语义 | 备注 |
|---|---|---|
| `type` / `name` / `uuid` | 精确匹配 | 已有 |
| `alive` | `isValid` | — |
| `region` | 两角点包含 | 宿主直接算，替代 Lua 侧 `pred_match` |
| `within` | 与自身 3D 距离 | 与 `region` 可同时出现 |
| `holding` | 主手 id | 读原始 `equippedItem`，不展开组件 |
| `equipment` | 部件 id 映射（`false`=必须为空） | 同上 |

**下推规则（必须写进 `CAPABILITIES.md`）：**

- `pred` 里出现 **Lua 函数**（或未知键）→ 整次查询降级为 `projection:"full"`，谓词在 Lua 侧执行；
  宿主只应用 `type/within` 这两个老字段（保持现状成本）。
- `pred` 全部是声明式键 → 宿主先过滤，再对**命中者**做投影；`order+limit` 允许宿主在
  不构造快照的情况下选出 top-K（`nearest` 变成「host 算距离、只快照最优 1 条」）。
- `projection:"core"` 时实体不展开装备栈；`equipment` 谓词用原始 id 判定，不受投影影响。

**兼容策略：** 新参数全部可选、结果形状不变（`Entity[]` / `Window`）。Fabric 宿主可以暂时
忽略新参数（行为正确、只是慢），`/caps` 里 `query.plan:false` 让 Lua 走降级路径；
补齐后再打开。这样 P1 不必等 Fabric 同步完成。

### 3.3 实体：帧快照 + rev（解决逐字段穿透）

**信封加版本号**：所有同步 Result 与异步结算帧追加 `rev`（宿主 tick 单调计数，可选能力
`host.rev`；宿主不提供时 Lua 退回「每次访问都重取」的旧语义）。
`bridge.q` 与 `await` 都把它写进 Lua 全局 `__REV`。这几乎是零成本（一个整数）。

**句柄内嵌快照**：

```lua
local ent_mt = {
  __index = function(e, k)
    if k == "id" then return rawget(e, "__id") end
    if k == "refresh" then
      return function() local s = snap_of(e.__id); if s then e.__s, e.__rev = s, __REV end; return e end
    end
    if k == "snapshot" then return function() return shallow_copy(rawget(e, "__s")) end end
    local s = rawget(e, "__s")
    if __REV ~= rawget(e, "__rev") then          -- 有过任何一次宿主交互 → 至多一次重取
      s = snap_of(rawget(e, "__id"))
      e.__s, e.__rev = s, __REV
    end
    return s and s[k] or nil
  end,
}

-- entity.find / nearest / get 返回的句柄直接携带产它的快照
local function make_entity(s)
  return setmetatable({ __id = s.id, __s = s, __rev = __REV }, ent_mt)
end
```

效果：

- `entity.find` 不再丢掉刚拿到的快照；`p.name` 是纯 Lua 读；
- 在同一帧（同一 tick）里反复读多个字段**只跨 0 次桥**；
- 跨帧后每个句柄最多重取 1 次（而不是每字段 1 次）——coal_guard 追击循环
  从「每轮 5~7 次 × 1.2~1.6ms」降到「每轮 ≤2 次 × 快照大小」，再叠加 `core` 投影后
  单条 ≈ 100µs 量级；
- 语义保持「动态字段活读」：**上界为一次宿主交互/tick**，写进 `CAPABILITIES.md §2`
  的 `world.staleness` 条款。需要强制新鲜时用 `e:refresh()`（脚本可读）。

> 备选方案（不推荐）：句柄只存 id、每次访问都穿透（现状）。它在 `nearest` 这类
> 「拿到就立刻用」的场景下纯属重复劳动。

### 3.4 窗口与物品：聚合 + 投影 + 缓存

1. **`inv.count{filter}` / `inv.find{filter}` / `win:count` / `win:find` 改为宿主聚合**
   （`window.count` / `window.find`）：宿主在 `WindowState` 的 `slots` Map 上直接数，
   回一个数字或槽位号。载荷从 8.2KB 降到 <100B，`inv.count` 从 ~5.9ms 降到 ~0.1ms。
   过滤器只支持声明式形态（`{id?, count_min?}`），函数过滤器降级为 Lua 侧遍历。
2. **`window.get` 增加 `fields`**：`idcount` 模式只回 `{id,count,damage,max_damage}`；
   `win:slots()` 默认 `idcount`，需要属性时才显式 `win:stacks()`（等价现状的 full）。
   `bslib.equip_best` 只对候选的 ≤9 把武器调 `item.stack` 取 `attribute_modifiers`。
3. **按 revision 缓存**：`win_snap(id, fields)` 在 Lua 侧缓存 `(id, revision, fields)`；
   `WindowState.view()` 在宿主侧按 revision 缓存已物化的 view，`apply()` 只换 revision。
   一次点击序列里同窗口多次读取 → 0 次跨桥。
4. **`data.stack` 的两级缓存**：
   - 静态：`Map<id, {max_count, max_damage}>`（注册表只读）；
   - 实例：对 `components` 数组做一次解析，把 `max_stack_size/max_damage/custom_name/
     enchantments/attribute_modifiers` 放进解析结果；用 `WeakMap<rawItem, StackInfo>`
     避免同一物品在 self/window/entity 三处重复展开；
   - `findComp` 从「5 次线性扫描」改成「一次收集 + 按键索引」。
5. **紧凑槽位表示（可选，P2）**：`window.get(fields:"idcount")` 内部可用
   `slots:[[index,id,count,damage],...]` 只列非空槽；Lua 侧物化成契约形状。
   解码量再降 ~40%（省一层对象键）。

### 3.5 方块：索引 + 分片

**两级预筛：**

1. **Section palette 级**：`world.scan` 不再传 `useExtraInfo:true`；用
   `findBlocks({ matching, useExtraInfo:false })` 即可让 mineflayer 先按 palette
   （每 section ~20 个状态）跳过无关 section。这是**一行改动**，典型容器扫描
   从「全部 section ×4096」降到「命中的少数 section ×4096」。
2. **名字索引（`world.scan_index`）**：宿主在 `chunkColumnLoad` 时，对**被监视的方块集合**
   （默认 = `contracts/data/containers.json`，可由 `world.watch(kinds)` 扩展）维护
   `Map<name, Set<packedPos>>`；`blockUpdate` 增量维护。scan 变成
   「按名字取集合 → 区域/距离过滤 → 排序取 limit」，成本 O(命中数)。
   内存上界：只索引监视集合，典型容器每个 chunk 个位数。

   ```
   WorldIndex {
     watch: Set<name>
     byName: Map<name, Set<posKey>>
     onChunkLoad(column)  // 只扫 palette 含 watch 的 section；命中再定位 4096 内位置
     onBlockUpdate(pos, name)
     query(region, names, limit) -> [{x,y,z,id}]
   }
   ```

3. **分片/预算**：`world.scan(budget_ms)` 在 index 命中路径上通常一次完成；
   冷启动（索引未建）或无索引能力时，按 `cursor` 分片，每片 ≤8ms 返回，
   Lua 侧 `world.scan` 内部循环续扫（对外仍是同步 API，但每片之间让出事件循环）。
   `ScanPage.complete=false` 时脚本可观察到「未扫完」，不再把「扫空」误判成「没有箱子」。
4. **一次扫描拿到名字**：索引/分片路径在定位位置时已知 `name`，不再
   `blockAt` 二次读取；区域过滤前移到候选生成阶段。
5. **`world.block` 收敛单一实现**：ABI 调 `WorldState.block()`，去掉 `abi.js` 里的重复逻辑。
   「未加载返回 `nil` 还是 `{}`」是语义决定（现有示例 `world.block(pos).name` 直接链式取值），
   不在 P0 顺手改；P1 加 `exists` 字段并同步更新示例后，再让 `nil` 表达「未加载」。
6. **谓词校验**：`scanKinds` 对未知键抛 `abi.invalid_args`（或返回 `unsupported_pred`），
   不再静默退化成 `chest`。

### 3.6 事件与采样

1. **订阅门控**：脚本声明期把 `on_event` 注册的 kind 收集为 `__EVENT_KINDS`；
   `engine.event(kind, …)` 在 `kind` 无订阅者时**直接返回，不序列化、不进 Lua**
   （`lifecycle/chat/timer` 例外，核心内部消费）。宿主侧可再缓存一次订阅集合，
   热重载后重建。
2. **批量合并**：驱动把同一 tick 内的 `entitySpawn/entityGone` 合并为
   `entities.appeared[]` / `entities.gone[]` 单条事件；`block_change` 同理批量化。
   繁忙服务器上事件解码从「每条一次」降到「每 tick 一次」。
3. **采样拆分**：
   - `self` 事件只推位置/血量/手持等**轻字段**（≤200B），保持 200ms 或改 100ms；
   - 背包列表改由 `inventory.dirty` 驱动（`bot.inventory` 的 `update` 已有），
     不再每 200ms 全量遍历；
   - `window` 推送改为 `{id, revision, changes:[slot…]}` 差量，宿主 `WindowState.applyDelta`；
     全量视图仍可按需 `window.get`。
4. **`self.get` 帧缓存**：核心在 `__REV` 内缓存自身快照；`bslib.look.at` 与
   `entity.nearest` 同帧只取一次（顺带修掉 §2.1-2 的重复 `self_pos()`）。

### 3.7 可观测性（让回归可见）

- `abi.sync/asyncOp` 记录每个 op 的 `calls / bytes_out / us / max`（环形 + 累计）；
- Lua `bridge.q` 用 `os.clock()` 记录解码耗时（wasmoon 下可用，实测存在），
  按 op 汇总，经 `__core_call("perf")` 暴露；
- `GET /state` 增加 `perf.top`（按 `bytes×Hz` 排序）与 `perf.budget_violations`；
- 超预算时**一条 warn 日志**（带 op、bytes、Hz），首次出现才打，避免刷屏。

### 3.8 编码层（P3，先测量再决定）

保持 JSON 协议不变。如果投影/聚合后仍有 >2KB 的高频载荷，再评估：

- 针对「同构记录数组」的紧凑文本编码（分隔符/行式）在 Lua 侧用 C 实现的
  `string.find/gmatch` + 批量建表，预计比通用 JSON 解码快 2~4×；
- 或把 payload 以「列」组织（相同键只出现一次），减少键解析次数；
- 不引入第二套跨宿主协议；Fabric/LuaJ 必须能解码同一种格式。

---

## 4. 路线图与验收

> 每一阶段都可独立合入、独立回滚。验收标准必须是**可证伪的**（数值 + 行为等价）。

### P0 — 低风险修复（不新增 op；个别项新增**可选参数**，缺省行为不变）（预计 1~2 天）

**落地情况（2026-11-20，v0.2.0）：#1–#8 全部实现；全量 83 项测试 + 契约门禁通过。与草案的差异：**

- 句柄快照用 **Lua 侧 `__EPOCH`**（每次 `await` 返回 / 事件 / resume 自增）实现，未引入 Result 信封
  `rev`——信封版本号仍留给 P1（可选能力 `host.rev`，Fabric 可缺席）。
- `idcount` 只用于 `inv.count/find` 与 `window.count/find`；`slots()/peek` 保持全量
  （`bslib.equip_best` 需要组件推导攻击属性）。
- P0 #5 仍对最终 ≤limit 条结果各做一次 `blockAt` 取名（≤200 次，≈0.2ms），区域前置已去掉；
  真正的「按名索引」在 P2。
- P0 #6 只收敛实现，`nil`/`{}` 语义未动。
- 新增守卫测试：句柄同帧 0 重取/跨帧 1 次、self 同帧 1 次、`idcount` 字段集合、
  `scanKinds` 未知谓词抛 `abi.invalid_args`（Lua `world.scan` 同步抛错，不再静默空结果）、
  驱动 `useExtraInfo:false` + 区域谓词、pushSelf 脏驱动。

| # | 改动 | 位置 | 验收 |
|---|---|---|---|
| 1 | `within_ok`/`nearest` 提升 `self_pos()` 到调用前一次；`self.get` 帧缓存 | `bootstrap.lua:968-1045` | 10 玩家 `nearest` 的 `self.get` 调用数 N+1→1（测试计数） |
| 2 | 句柄内嵌快照（同一帧 0 跨桥） | `bootstrap.lua:937-1045` | coal_guard 追击循环实体重取次数/轮 ≤2（日志计数） |
| 3 | `inv.count/find`、`win:count/find` 改走 `fields:"idcount"` | `bootstrap.lua:1198-1238,1078-1168`、`abi.js:229` | `inv.count` 载荷 8.2KB→~2KB、耗时 ~5.9ms→~1.3ms；样例包行为不变 |
| 4 | `data.stack` 两级缓存 + 一次组件解析 | `data.js:102-162` | 同一 stack 二次展开 0 次 `findComp`（计数） |
| 5 | `world.scan` 去掉 `useExtraInfo:true`（启用 palette 剪枝），去掉 `count: limit*2` 与事后 region 过滤（边界并入匹配谓词） | `drivers/.../index.js:691-712` | 100³ 扫描 ~2.3s→按「命中 palette 的 section 数」线性下降；结果集与现状一致（对比测试） |
| 6 | `world.block` 收敛到 `WorldState.block()`（仅去重，不改 `nil`/`{}` 语义） | `abi.js:201-213`、`world.js:31-51` | 行为逐项一致（tour / 示例包）；无第二份「实时优先/缓存兜底」 |
| 7 | `pushSelf` 背包列表改为脏驱动 | `drivers/.../index.js:205,278-288` | 空闲时 200ms 采样不再遍历背包（计数） |
| 8 | `scanKinds` 未知谓词显式失败 | `data.js:168-172` | 契约测试：未知 pred → `abi.invalid_args` |

### P1 — 契约扩展（预计 3~5 天）

**落地情况（2026-11-20，v0.2.1 待发）：#9（实体下推/投影/限量）与 #14（perf 计数）已实现；#10–#13 未开始。**

- `entities.list` 新增 `pred/projection/order/limit`；`entities.get` 新增 `projection`。
  `entity.find/nearest` 自动构造可下推的声明式谓词；含 Lua 函数/未知键时回退全量投影并在 Lua 侧判定；
  `nearest` 由宿主按距离排序、只返回最近 1 条（Fabric 未实现时 Lua 本地兜底，结果一致）。
- 引擎内复现（10 名满装备玩家，真实 VM/JSON，Mock 驱动）：
  改造前 `entities.list` **19.7KB/次 ×26Hz**，greeter ≈36% 单核；改造后 **1.6KB/次**、nearest 0.6KB/次，
  greeter ≈12–14%。剩余地板：`time.sleep(50)` 每次往返 ≈2ms（20Hz ≈4.5%）、nearest+self ≈5%。
  真实实例仍需要用 `/state.perf` 复核（见 #14）。
- `/state` 新增 `perf`：每 op 的 calls/hz/出站字节/kb_s/us_avg/us_max（按 kb_s 排序 top-N），
  作为「哪条查询在吃 CPU」的第一手证据。

| # | 改动 | 验收 |
|---|---|---|
| 9 | `entities.list` 的 `pred/projection/order/limit`（Node 完整实现；Fabric 先忽略） | 10 玩家 `nearest` p95 ≤300µs、payload ≤400B；`entity.find` 与旧实现结果集逐项相等（golden 向量） |
| 10 | Result 信封 `rev` + 句柄按 rev 失效 | 跨帧首次字段读 1 次重取；同帧 N 字段 0 次 |
| 11 | `window.count/find` 聚合 op | `inv.count` p95 ≤150µs；9 种过滤器与 Lua 侧旧实现结果一致 |
| 12 | `window.get` 紧凑槽位 | `win:slots()` 载荷 ≥40% 下降；`bslib.withdraw/deposit` 回归通过 |
| 13 | 事件订阅门控 + tick 批量合并 | 空闲服务器上 `entity.appeared` 事件 0 次进 Lua；高频服务器解码次数 = 每 tick 1 次 |
| 14 | `perf` 计数 + `/state perf.top` | 任一 op 超预算可在 `/state` 看到；无回归时 top 稳定 |

### P2 — 索引与阻塞消除（预计 1~2 周）

| # | 改动 | 验收 |
|---|---|---|
| 15 | 容器/监视集合名字索引 + `world.watch` | 已建索引的 100³ `scan` ≤20ms；冷启动 ≤200ms 且分片 |
| 16 | `world.scan` 分片/cursor（`ScanPage.complete`） | 单次同步调用 ≤8ms；期间物理 tick 不丢（trace 中 position 包间隔 ≥45ms） |
| 17 | `window_click` 结果确认事件化；`_waitRevision` 改 token 结算 | 点击序列固定 250ms 等待 → 事件到达即返回；无 revision 变化时不重试 |
| 18 | 驱动出站管道合并（trace / tick-end / 未来补丁） | 单一 `client.write` 链，补丁顺序显式登记；`/caps` 可回放链路 |

### P3 — 编码层（需要 P0/P1 数据支撑再决定）

- 用 §3.7 的 `perf` 数据确认仍有 >2KB 的高频 op，再评估紧凑编码；
- 不以「换成 userdata 代理」「Lua 侧自建缓存索引」作为方案（见 §1.3、§6）。

---

## 5. 脏实现清单（短期止血 → 系统性替代）

> 判定标准：**它是不是在绕开一个本应在契约/架构层解决的问题？** 如果是，就是止血。
> 「正确但临时」也列出来，因为它们会固化进脚本习惯，之后更难改。

| # | 位置 | 现状（止血） | 为什么是止血 | 系统性替代 | 阶段 |
|---|---|---|---|---|---|
| 1 | `examples/greeter/main.lua:22` | 视角刷新 5ms→50ms | 用降频掩盖「单次查询 11ms」，脚本被迫自己懂性能 | 查询降到 ~0.2ms；`look` 由事件/tick 驱动 | P1 |
| 2 | `bootstrap.lua:973-980` | `within_ok` 每条实体调一次 `self.get` | 距离已在宿主算过，Lua 又用一次跨桥复核 | 宿主下推 `within/region`；Lua 只做残余谓词 | P0/P1 |
| 3 | `bootstrap.lua:942-960` | 句柄逐字段全量重取（~1ms/字段） | 用「每次穿透」实现「活读」语义 | 帧快照 + `rev` + `refresh()` | P0/P1 |
| 4 | `bootstrap.lua:1022-1025` | `entity.find` 丢弃已拿到的快照 | 只为复用 `make_entity(id)` 的旧形态 | 句柄内嵌快照 | P0 |
| 5 | `drivers/mineflayer/index.js:704` | `findBlocks({useExtraInfo:true})` | 为了拿到 `block.name` 付全 section 扫描 | `useExtraInfo:false`（palette 剪枝）+ 索引 | P0/P2 |
| 6 | `drivers/.../index.js:704,710` | `count: limit*2` 再事后 region 过滤 | 绕开 findBlocks 不能按区域收窄 | 索引查询 + 区域前置 | P0/P2 |
| 7 | `contracts/host-abi.yaml`（sync op） | `world.scan`/`world.block` 同步执行 | 同步接口无法分片，长扫描堵死事件循环 | `budget_ms/cursor` 分片；必要时 async op | P2 |
| 8 | `drivers/.../index.js:541-554` | `window_click` 4 次 ×250ms 猜结果 | 没有确认机制，用「等一会儿看快照变没变」判断成功 | 窗口更新/revision 事件结算 token | P2 |
| 9 | `abi.js:356-363` | `_waitRevision` 40ms 轮询 | 同上 | `window.update` 事件 resolve | P2 |
| 10 | `drivers/.../index.js:485-493` | 单槽 `pathWait` | 假设同时只有一条路径；并发 `walk/follow` 互相覆盖 | 按任务/目标 token 管理 goal | P2 |
| 11 | `drivers/.../index.js:158,461-468` | `yawSpeed=20` + `look` fire-and-forget 吞异常 | 用魔法常数换转向手感；错误不可见 | rotation 原语状态机 + 显式速率/错误通道 | P2 |
| 12 | `drivers/.../index.js:205,278-288` | 200ms 全背包采样 | 周期性全量代替变更驱动 | `inventory.dirty` 驱动 / 按需 `self.get` | P0 |
| 13 | `drivers/.../index.js:390-397` | 50ms 全窗口重建推送 | 用周期推送代替差量 | revision + `changes[]` 差量 | P1 |
| 14 | `mod/.../AbiDispatcher.java:277` | Fabric `entities.list` 忽略 `type/within` | 契约有参数但实现不认，脚本性能两栈不一致 | 两栈统一契约测试（golden query vectors） | P1 |
| 15 | `hosts/node/data.js:18-35` | `resolveVersion` 最近版本兜底 | 宿主不知道真实协议版本，猜一个可用数据表 | 连接期上报协议版本 + 数据表断言（teleport patch 已有先例） | P2 |
| 16 | `patches/tick-end-26x.js` | 「常装、无害」 | 曾按 config 版本收窄导致 1.21.8 实例被踢，于是改成无条件装 | 版本/能力协商：以服务端握手与 `/caps` 为准；补丁登记已做，缺选择依据 | P2 |
| 17 | `protocolTrace.js` + `tick-end-26x.js` | 两个补丁先后改写 `client.write` | 补丁各自拦写出站包，顺序隐式、不可组合 | 单一 outbound middleware 链，登记顺序与开关 | P2 |
| 18 | `abi.js:201-213` vs `state/world.js:31-51` | `world.block` 两份实现 | 宿主层与状态层各写一遍「实时优先/缓存兜底」 | 收敛到 `WorldState` 单一入口 | P0 |
| 19 | `data.js:168-172` | 未知 `pred` 静默变 `chest` | findBlocks 只能吃名字集合，索性吞掉其余谓词 | 显式 `abi.invalid_args` / 能力位 | P0 |
| 20 | `data.js:118-149` | 每栈 5 次线性组件查找 | 网络组件形状不确定，用「都找一遍」兼容 | 一次解析 + 缓存 + 形状断言 | P0 |
| 21 | `bslib.lua:316,334,377,400,449-457` | 一次点击序列反复全量 `window.get` | 没有 revision 缓存/聚合原语可用 | 窗口缓存 + 聚合 op | P1 |
| 22 | `engine.js:459-472` / `bootstrap.lua:444-467` | 每个驱动事件都序列化+解码+spawn 检查 | 没有订阅表，只能「全量广播」 | 声明期订阅集合 + tick 批量 | P1 |
| 23 | `bootstrap.lua:176` | `pump()` 用 `table.remove(__READY,1)` | 就绪队列小，先不管 | 索引队列/双端队列（仅在压测显示热点时） | P3 |
| 24 | `bootstrap.lua:69-77` | `current_id()` 每次动作线性扫全部任务 | 任务数少，先不管 | 当前协程 → 任务 id 的反向映射表 | P3 |

> 说明：第 23/24 条是「未验证的低优先级脏点」，列出是为了避免以后误以为是设计；
> 不要在 P0 里顺手改，除非 §3.7 的计数显示它们确有占比。

---

## 6. 风险、兼容与「不做」

**语义变化（需要拍板）：**

- 句柄从「每次字段访问都穿透」变为「同一帧内快照 + 跨帧至多一次刷新」。
  `CAPABILITIES.md §2` 必须同步改为：**动态字段的新鲜度上界 = 一次宿主交互（≤1 tick）**，
  并提供 `snapshot()`/`refresh()` 的明确语义。这是本次唯一会影响脚本可观察行为的地方，
  P0/P1 合入前需要有意的文档修订，而不是悄悄改。

**兼容策略：**

- 新参数可选、结果形状不变；Fabric 未实现时按 `caps` 降级，正确性不受影响；
- 新旧路径共存一个版本周期，用 golden 向量保证结果集等价（顺序/字段集合允许不同，
  但 `find` 的成员、`count` 的数值必须逐项相等）。

**不做：**

1. 不引入 wasmoon 的 JS 对象代理（`userdata`）作为数据面（§1.3）。
2. 不在 Lua 侧自建「实体/方块缓存索引」——脚本语言层没有内存与失效控制，
   缓存必须有唯一所有者（宿主）。
3. 不把 Lua 闭包谓词「序列化下推」到宿主（会引入第二套表达式语言与执行器）。
4. 不为压测而改生产阈值（例如把 greeter 的 50ms 再调小）；先降单次成本。
5. 不在没有 `/state perf` 数据的情况下替换 JSON 编码器。

---

## 附录 A · 测量脚本与原始数据

脚本：**`tools/bench/query-cost.mjs`**（已入库，可复现；`--quick` 冒烟，`--decode` / `--block` / `--native` 单项）。

- 全链路：Lua `json.encode(args)` → `__host_q` 跨 WASM → JS → 回传字符串 → `json.decode`；
- 隔离解码：同一 payload 只跨桥一次，之后在 Lua 内重复 `decode`；
- 方块：`prismarine-chunk.getBlock` 单块成本 × section 数，估算 `findBlocks` 内层循环；
- 原生代理：JS 函数直接返回对象 → Lua `userdata` 的语义与逐字段成本（§1.3 的否决依据）；
- 每个载荷 3 轮取最小值，抑制 GC 噪声。

某次运行输出（min-of-3；不同 run 有 ±30~40% 抖动，回归门禁应看相对基线）：

```
[全链路]
  no-op:                            26µs/次
  entities.list 10 玩家(全量):    15701µs/次 (17.8KB)
  entities.list 40 怪(全量):      11510µs/次 (16.3KB)
  entities.list 10 玩家(紧凑投影):  664µs/次 (0.9KB)
  window.get 90 槽(全量 StackInfo): 5896µs/次 (8.2KB)
  entities.get 单个玩家:           1190µs/次 (1.8KB)
  仅跨桥(小载荷):                    4.8µs/次

[隔离解码]
  10 玩家(全量): 11291µs | 40 怪: 11052µs | 10 玩家(紧凑): 607µs
  window 90 槽: 4336µs | 单个玩家: 1591µs | no-op: 9µs

[方块]
  prismarine-chunk.getBlock: 1.06µs/块
  575 sections ×4096 ≈ 2.36M 次 ≈ 2.5s（useExtraInfo=true 全扫）
```

**需线上复核（[待核实]）：**

1. 真实 `bot.entities` 规模与装备组件形状（影响玩家快照的实际 KB 数）；
2. 真实服务器上 `entity.appeared/block_changed` 的每秒条数；
3. 生产容器里 /proc CPU 占用与 greeter `nearest` 的实际占比（预期与合成负载同量级）；
4. `os.clock()` 在 wasmoon 沙箱中的精度（用于 §3.7 的 Lua 侧解码计时）。

**建议 CI 化：** 把 `tools/bench/query-cost.mjs` 接入「与基线比不劣化」检查；
线上用 §3.7 的 `perf` 计数采样同一指标。两者共用 §1.2 的预算，
避免「测试环境很快、线上很慢」的偏差。

## 附录 B · 需要同步修订的文档条款

| 文档 | 条款 | 修订 |
|---|---|---|
| `CAPABILITIES.md` | §2 实体「动态字段每次读取穿透到最新缓存」 | 改为「帧快照 + 失效上界」，新增 `refresh()` |
| `CAPABILITIES.md` | §3.4 `entity.find/nearest` | 增加 `pred` 声明式字段表、`projection/order/limit`、函数谓词降级规则 |
| `CAPABILITIES.md` | §3.5 `world.scan` | `ScanPage` 形状（`items/complete/cursor/scanned_sections`）、预算语义、未知谓词报错 |
| `contracts/host-abi.yaml` | `entities.list` / `window.get` / `world.scan` | §3.2 草案；新增 `window.count/find` |
| `ARCHITECTURE-REFACTOR.md` | 「原语下沉、编排上移」 | 补一条：**查询也下沉**（过滤/聚合是原语，不是编排） |
