# 心形绘制 bot（heart）

侦测范围内出现新放置的双箱（大箱子）→ 从原材料箱取恰好 27 块羊毛 → 走到双箱前
逐格摆出 6 行心形图案。覆盖 v1 三类动作：nav（寻路/转向）、container（开箱/窗口
点击）、世界/实体查询。

```
.XX.XX.
XXXXXXX
XXXXXXX
.XXXXX.
..XXX..
...X...
```

## 文件

| 文件 | 说明 |
| --- | --- |
| `heart.lua` | 核心脚本（双宿主通用；参数 schema 在 bot.yaml） |
| `bot.yaml` | 脚本包清单（v2 能力自述：name/scripts/params schema） |
| `demo-mineflayer.yaml` | mineflayer 宿主实连演示（实例部署配置，触发式） |
| `heart-boot.lua` | 无方块事件流宿主（fabric）的引导：on_start 读 params.target 触发 |
| `reset-demo.sh` | RCON 重置演示环境（建原材料箱装羊毛 + 建目标双箱） |

## 运行

前提：Paper 服务器 127.0.0.1:25565（online-mode=false、RCON 25575/botscript）。

```bash
# 1) 重置演示环境（坐标在脚本顶部变量）
bash examples/heart/reset-demo.sh

# 2) mineflayer 宿主（触发式：范围内重新放置一个箱身补全双箱后自动开始）
node engine/cli.js examples/heart/demo-mineflayer.yaml
#   source 等实例坐标住实例参数：平台在启动前设置（启动时下发）
#   curl -X POST -H "Authorization: Bearer <token>" -d '{"source":[119,151,-306]}' http://127.0.0.1:<port>/params
```

### fabric 宿主（v2 standalone：mod 自持运行时，无外部进程）

1. 把本目录整包复制到 `<游戏目录>/botscript/heart/`；
2. `<游戏目录>/config/botscript-mod.json` 配置实例（包 + 边界 + 实例参数首次可经 GUI/HTTP 设置）：
   `{"package": "heart", "boundary": {}}`；
3. 进世界自动加载；游戏内 `/bsclient` 打开管理界面，在参数页设置 `source`/`target` 后重启或手动触发。
   fabric 无方块事件流：由 heart-boot 读 params.target 在 on_start 直接触发。

成功的标志是日志输出 `心形完成：27 块 minecraft:pink_wool @ <双箱坐标>`，
打开目标双箱可看到心形图案。

## 已知限制

- **Paper 1.21.x + mineflayer 宿主逐格点击接受率低**：1.17+ 服务器会静默丢弃
  携带过期 stateId 的窗口点击，连续快速摆放大量丢失。引擎层已加"槽位快照比对
  + 重试"缓解，但可靠路径是 fabric 宿主（mod 内游戏内点击，无 stateId 问题）。
- **fabric 驱动没有 L1 方块更新流**：heart.lua 的 `world.block_changed` 触发不
  生效，所以 fabric 演示经 `heart-boot.lua` 在 on_start 直接触发。
- demo 配置里的坐标 / fence / RCON 账号是演示世界专用，换世界需同步修改
  `reset-demo.sh` 与两个 demo yaml 的 `params`。
