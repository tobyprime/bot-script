# bot-script 运行指南

[![CI](https://github.com/tobyprime/bot-script/actions/workflows/ci.yml/badge.svg)](https://github.com/tobyprime/bot-script/actions/workflows/ci.yml)

设计文档见 `DESIGN.md`（语言/运行时/部署）、`CAPABILITIES.md`（能力目录/驱动协议/§16 客户端 mod）
与 `ARCHITECTURE-REFACTOR.md`（契约先行改造方案）。本文档说明如何把实现跑起来。

## 目录结构（契约先行：ARCHITECTURE-REFACTOR §3/§4）

```
contracts/                 唯一真源（全部生成物由 tools/codegen.mjs 产出）
  host-abi.yaml            宿主 ABI v2：op/参数/同步性/gate/能力；动作=原版发包，item=Stack 组件
  errors.yaml              类型化错误清单（kind → 责任分类 / HTTP 状态）
  events.yaml              宿主→核心事件
  api-surface.yaml         脚本公开 API（api-lint 与编辑器补全的同一份清单）
  package/deploy/policy.schema.json · http17.openapi.yaml
  data/                    跨宿主共享数据（武器评分 / 容器方块表）
  vectors/                 跨宿主 golden（scheduler / policy / windows / data）
runtime/lua/
  core/{bootstrap,bslib,json}.lua   唯一语义实现（Node/Fabric 共用）
  core/bridge.generated.lua         生成物：bridge.self.get / bridge.act.* 等类型化存根
  compat/luaj.lua                   LuaJ 兼容补丁（仅 Fabric 加载）
hosts/node/                Node 宿主（薄适配器）
  vm.js tokens.js abi.js state/ policy.js stateStore.js obs.js data.js deploy.js
  engine.js                        <300 行组装（vm + tokens + state + abi + obs + driver）
  http17.js                        §17 控制通道（路由表由 openapi 生成）
  runners/{cli,worker,cluster}.js  进程模型与退出分类
  drivers/mineflayer/              协议驱动 + patches/（版本适配登记表）
hosts/fabric（mod/）        Fabric 宿主：AbiDispatcher / McState / LuaRuntime / DataRegistry / HttpApi
engine/                    兼容入口：cli.js（含 validate 子命令）与 host.js 只做转发
tools/                     codegen · contract-lint · lua-sync · api-lint · validate · gen-data-vectors
testing/                   按域拆分的测试 + harness + 向量执行器（node testing/run.js）
examples/                  验收场景（bank / organizer / coal_guard / heart / tour；bot.yaml = 包能力自述）
```

## 快速开始

环境：Node >= 24（需 node:sqlite）、Java 21+、可访问互联网（首次 npm install）。

```bash
npm install
node tools/codegen.mjs           # 契约 → 生成物（改了 contracts/*.yaml 必须重建）

# 1) 全量测试（mock 驱动全栈 + 契约向量；无需 Minecraft）
node testing/run.js

# 1.5) 契约/单一源门禁（CI 同款）
node tools/contract-lint.mjs
node tools/sync-lua.mjs --check

# 2) 脚本包静态校验（不连服务器、不执行脚本：schema + Lua 编译 + API lint）
node engine/cli.js validate examples/tour

#     编辑器补全：engine/lua/bot-api.d.lua 由 contracts/api-surface.yaml 生成
#     （Lua Language Server（sumneko）或 EmmyLua 插件即获得全 API 补全与类型提示）

# 3) 跑一个 bot（v2 三层分离：包清单在 examples/bank/，部署配置给连接+边界）
node engine/cli.js run/bank-demo.yaml
#   stdin 只做宿主控制：pause / resume / status / quit（ABI v2 已移除命令体系）
#   HTTP 控制通道自动开启（§17）：127.0.0.1 + token，启动日志打印；
#     curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/state
#     （/params /pause /resume /eval /event /session /tasks /tasks/cancel /logs /stream /chat /store /caps）

# 4) fabric 宿主（standalone，无需任何外部进程）
cd mod && ./gradlew build
#   产物：mod/build/libs/botscript-mod-0.4.0.jar -> 放入客户端实例 mods/ 目录
#   构建期从 ../runtime/lua 与 ../contracts/data 拷入资源（仓内不保留第二份 Lua 拷贝）
#   脚本包：<游戏目录>/botscript/<包名>/（整包复制，含 bot.yaml 清单）
#   实例配置：<游戏目录>/config/botscript-mod.json:
#     {"package": "bank", "boundary": {}}
#   进世界自动加载；游戏内 /bsclient 打开管理界面（§16.5 五页）。
```

## 实连验收（本地 Paper 服务器）

```bash
cd G:/data/minecraft/bot-test-server
java -Xms512M -Xmx1024M -XX:+UseParallelGC -jar paper-1.21.8-60.jar nogui
#   server.properties: online-mode=false, spawn-protection=0, rcon 开启(25575/botscript)
```

```bash
node test/live.js     # 构建场景 + 启动 bank/organizer/coal_guard + 断言（含 HTTP 无头闭环）
```

验收项：bank 入账/seen 去重/转账/取款挂账+回执核销/私聊余额（5 项）；
organizer 冷启动扫描+organize once 分流（2 项）；coal_guard 举煤追击+放下即停+guard stop（2 项）；
内建 pause/resume（1 项）；HTTP 控制通道（§17）鉴权/state/params/pause/resume/tasks/cancel/logs/store/caps（3 项）。

## 收款 bot 部署与参数（TOB-522）

以 `examples/afk_guard` 为生产链路：relay.lua 在引擎侧识别收款系统聊天（transfer_pattern 机制），
命中后经 `events.emit('pay', {payer, amount})` 上抛宿主——投递地址与凭据由宿主持有
（托管部署 = agent/控制面；独立部署 = 各自宿主决定），脚本不接触任何 URL。

**部署两步**：

1. **配置参数**（运行期 `POST /params` 热更即可，无需重启）：

   ```yaml
   # bot.yaml 关键参数（默认值部署即用，零手改）
   params:
     bot_name:      { type: string, default: '', desc: bot 进服玩家名；空 = 自动锚定 bot 自身用户名 }
   ```

2. **小额验证**：用测试账号给 bot 转一笔小额（如 0.5），确认收款事件到达宿主并被计入账。

- **默认锚定自身**：`bot_name` 默认空，引擎从驱动快照取 bot 用户名（`self.username()`），
  收款判定与私聊接收门都无需再硬编码 `MixTobyInjSave`；显式设置仍优先生效（兼容存量实例）。
- **热更**：运行期 `POST /params` 修改 `transfer_pattern` 即时生效、不断线；平台侧回写 params_json，重启保留。
- **热更校验**（非法即拒绝、回传可读错误、旧值继续生效）：`transfer_pattern` 长度 ≤256 字节、
  合法 Lua pattern、恰好 2 个捕获（1=玩家名 2=金额），空值 = 关闭收款判定。
- **上报路径**：命中后经 `events.emit('pay', {payer, amount})` 上抛宿主；投递地址与凭据由宿主
  （agent / 控制面）持有，脚本不接触任何 URL。重启丢失未完成的通知为已接受风险
  （平台侧审计缺口 + admin_adjust 冲正兜底）。
- 服务器收款副本格式不同（如 "X 给 Y 转了 N 金"）时，按上述规则热改 pattern 即可，无需改代码。

## 实现要点（与设计文档的对应）

- **契约先行**：op 名/参数/gate/错误只写在 `contracts/host-abi.yaml`；四份生成物
  （Lua bridge / Node op 表 / Java op 表 / bot-api.d.lua）与 HTTP 路由表全部由 codegen 产出，
  `contract-lint` 在 CI 里比对，手改生成物或核心手写桥名都会红。
- **四个 ABI 入口**：`__host_q`（同步）/ `__host_a`（异步 token）/ `__core_call`（宿主→核心）/
  `__core_resume`·`__core_event`（宿主→核心异步）。策略/速率/预算/dry-run/审计/token 结算
  只在宿主 dispatch 一处执行（Node `hosts/node/abi.js` / Fabric `AbiDispatcher.java`）。
- **唯一 Lua 源**：`runtime/lua/core`；Fabric 只额外加载 `compat/luaj.lua`
  （`__TASK_ERR` 旁路、`math.type`/`atan2`）。`lua-sync` 禁止仓内出现第二份拷贝。
- **原语下沉、编排上移**：导航（含无寻路器时的直线退化）、开箱瞄准与重试、装备点击序列、
  战斗冷却都在 `runtime/lua/core/bslib.lua`；宿主只保留一次协议动作 + 确认。
- 调度：Lua 协程 + 就绪队列；yield 协议 `<token>, 0`；事件处理器为脱离根；
  race/parallel 的 join 状态全在 Lua 侧。
- 挂起点交付：`ej` 空串视同无错误；取消交付先跑 on_cancel 清理钩（fire 模式），再注入 `task.cancelled`。
- 暂停：交付冻结于队列；进行中的动作 settle 为 `runtime.paused`；resume 冲刷队列于冻结点重抛；
  pause 同时停走 + 取消寻路 + 冻结脚本定时器。
- **state（实例级 localStorage）**：`state.get/set/all/delete/update/seen`；key→JSON，无 schema/查询/多键事务。
  Node 内部用固定路径 `state/state.sqlite`（WAL + 100ms 合并 flush），Fabric 用固定 `botscript/state/state.json`。
  配额：单值 16KB / 总量 256KB，超限 `state.quota`；包无权指定存储路径。
- **ItemStack 组件真值**（ABI v2）：`item.stack` 直接读 stack 的 max_stack_size / max_damage /
  attribute_modifiers；Fabric 走客户端组件，Node 走 prismarine-item 网络组件。堆叠数**不再按 item id 猜**
  （旧前缀启发式 1.21.8 下 16.4% 判错，已删除；`contracts/vectors/data` 三版本全量护栏）。
- 窗口归一化：只有 `hosts/node/state/windows.js` 与 Fabric `WindowLayout/McState` 允许出现槽位常量；
  `contracts/vectors/windows` 锁死逐槽与点击映射。
- 版本适配即数据：`hosts/node/drivers/mineflayer/patches/`（tick-end-26x / teleport-packets），
  `/caps` 与启动日志列出已应用补丁 id。
- **没有命令体系**（ABI v2）：删除了 `on_command` / 命令声明 / 命令参数注入 / 权威解析 / `/cmd`；
  脚本用 `on_chat` 自己处理聊天控制（操作员名单也由脚本自行维护，平台不内置 owner/op）。
  参数仍归核心：`/params` 经 `params.get/set`，校验钩在 Lua 侧执行；暂停/恢复走 `/pause`、`/resume`。
- 动作按**原版发包**建模：`act.look`（rotation）、`act.input`（player_input 状态位，有符号轴）、
  `act.dig`/`act.dig_stop`（player_action）、`act.use_block`（interact，带 face/cursor/intent）、
  `act.use_entity`（attack/interact/interact_at）、`act.swing`、`act.use_item(start|release)`、
  `act.select_slot`、`act.drop`；没有「模拟按键」的 hop/move_input/use_item.duration。
- 补全数据面：`self.get`（药水效果/属性/速度/姿态）、`world.block`（block_state 属性/硬度/方块实体）、
  `world.block_entity`、`world.reach`（raycast）、`world.env`（真实 time_of_day/weather）、实体全状态。
- 账号三态：`account: 用户名`（offline）| `{username, password}`（微软 OAuth）
  | `{auth: session, username, uuid, accessToken}`（平台注入）。
- nav 超时单位 = 秒；walk 返回跨平台 Result（`{ok=true,value}` / `{ok=false,error={code,message}}`），
  失败不抛异常（循环重试语义），同时经 `events.emit('nav.failed')` 上抛观测面。
- **Result 协议（ABI v2.1）**：所有可能失败的 ABI/动作返回 `{ok,value}` / `{ok=false,error={code,message}}`；
  纯查询（self/world/entity/inv/state）仍返回原值。取消是独立控制通道（展开任务 + `on_cancel`），
  不进 Result、不进 `on_error`；Lua 原生 `error()` 仍按任务级失败处理；宿主意外异常只记日志，
  脚本最多看到稳定码 `internal`。
- 任务取消全路径留痕：显式取消/父完成级联/race 败者/超时统一记一条
  `任务 [名] 取消（来源）` 日志。
- **自定义网络包（`net`，servux 等插件协议）**：`net.on(channel, fn)` 订阅、`net.send(channel, data)` 发送，
  对应原版 `custom_payload`（插件消息）。载荷在 Lua 边界自动 base64，脚本只看到原始字节串/字节数组；
  受实例边界 `boundary.packets` **权限位**门控——缺省拒绝，显式 `true`/`allow` 才开放（发送与监听同时生效）。
  发送计入 `rate`/`budget` 与动作审计；单包上限 1 MiB。Node（mineflayer）已实现；Fabric 宿主暂只登记能力位为 false。

## 已知限制

- fabric 驱动无寻路器：`nav.walk` 走核心直线退化（`act.input` + `act.look`）；复杂地形显式失败。
- Fabric 宿主暂未实现自定义网络包：`caps.has("net.custom_payload")=false`，`net.send` 返回 `net.unsupported`。
- 挖掘由宿主状态机驱动 `player_action`（START + 进度 + STOP），完成以方块变空为准。
- Node 侧 ItemStack 组件来自网络组件（prismarine-item）；`attribute_modifiers` 只做通用属性提取，
  缺失时 `data.stack.attributes` 为 null（不造假）；Fabric 侧读客户端组件，字段更完整。
- 容器访问可用 `boundary.containers` 收紧；**未配置 = 允许**，显式 `false/deny` 才拒。
- 命令体系已移除：没有 `on_command`、没有命令参数注入、没有 `/cmd`；控制逻辑写在 `on_chat` 里，
  操作员名单由脚本自己维护（例如参数 `ops` 或 KV），平台/引擎不提供 owner/op 判定。
- **边界默认开放**：所有权限/限速/白名单未配置即不限制；只有显式写入的字段才收紧动作。
  **唯一例外 = `boundary.packets`**（自定义网络包权限位，缺省拒绝、显式授予才开放）。
- **运行时 `_ENV` 限制未默认开启**：包闸门用静态 API lint 判死（`__*` 内部桥、io/os/debug/load 等
  一律拒绝入库）；运行期脚本仍以全局环境执行，存量包兼容后再切受限环境。
