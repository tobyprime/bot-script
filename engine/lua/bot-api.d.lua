-- 生成物，勿手改：源 contracts/*.yaml，重建 `node tools/codegen.mjs`
---@meta


--- 声明具名任务：task("name", [opts], fn)。opts = {single=true}。
function task(...) end
--- task.spawn(name|fn, ...) — 触发任务
function task.spawn(...) end
--- task.spawn_detached(fn, ...) — 脱离根（完成不级联）
function task.spawn_detached(...) end
--- task.cancel(name|handle|id, source?) — 协作式取消
function task.cancel(...) end
--- task.cancel_all(source?)
function task.cancel_all(...) end
--- task.all() → [{id,name,status}]
function task.all(...) end
--- task.progress(delta)
function task.progress(...) end
--- on_start(fn) — 启动序
function on_start(...) end
--- on_pause(fn)
function on_pause(...) end
--- on_resume(fn)
function on_resume(...) end
--- on_error(fn) — 未捕获任务错误（fn(errorTable)）
function on_error(...) end
--- on_timer(interval_ms, fn) — 周期回调（pause 冻结）
function on_timer(...) end
--- after(delay_ms, fn) — 一次性（pause 冻结，触发后注销）
function after(...) end
--- on_event(name, fn) — 平台/宿主事件
function on_event(...) end
--- on_cancel(fn) — 任务取消钩
function on_cancel(...) end
--- on_chat(rex, [opts], fn) — opts: source=player|system, from=name
function on_chat(...) end
--- await_chat(rex, timeout_ms) → Result（value = 命名分组 table | nil）
function await_chat(...) end
---@class chat
chat = {}
--- chat.say(text)
function chat.say(...) end
--- chat.reply(text) — 公开回复（与 chat.say 等价）；双参私聊已移除，返回 chat.private_reply_removed
function chat.reply(...) end
--- chat.run_command(text) — kind=command 包（受 boundary.chat 白名单约束）
function chat.run_command(...) end
--- 同 await_chat
function chat.await_chat(...) end
---@class params
params = {}
--- params_validator(key, fn) — 热更校验钩：fn(value) → true | nil,msg
function params.validator(...) end
---@class state
state = {}
--- state.get(key, default?) → value|nil
function state.get(...) end
--- state.all() → { key = value, ... }
function state.all(...) end
--- state.set(key, value) → Result（单值 ≤16KB、总量 ≤256KB；超限 code=state.quota）
function state.set(...) end
--- state.delete(key) → Result
function state.delete(...) end
--- state.update(key, fn) → Result（fn(旧值) 返回新值的原子读改写；fn 内禁止挂起）
function state.update(...) end
--- state.seen(key, window_ms) → true=窗口内已见过（去重）
function state.seen(...) end
--- params_validator(key, fn) — 参数热更校验钩
function params_validator(...) end
--- rex[[pattern]] → id（正则，命名分组 (?<name>...)）
function rex(...) end
---@class entity
entity = {}
--- entity.find(pred) → [handle]
function entity.find(...) end
--- entity.nearest(pred) → handle|nil
function entity.nearest(...) end
--- entity.exists(e) → boolean
function entity.exists(...) end
---@class world
world = {}
--- world.block(pos) → {id,properties,state_id,hardness,block_entity,is_container,stale}
function world.block(...) end
--- world.block_entity(pos) → {type,data,snbt}|nil
function world.block_entity(...) end
--- world.scan(region, pred, {limit}) → [{x,y,z,id}]
function world.scan(...) end
--- world.reach(pos, [max_distance]) → {reachable,distance,hit_block}
function world.reach(...) end
--- world.dimension()
function world.dimension(...) end
--- world.time_of_day() → 0..24000
function world.time_of_day(...) end
--- world.weather() → clear|rain|thunder
function world.weather(...) end
---@class nav
nav = {}
--- nav.walk(pos|[entity], {arrive, timeout}) → Result（失败 error.code = policy.* / nav.*）
function nav.walk(...) end
--- nav.goto_near(pos, radius, opts?)
function nav.goto_near(...) end
--- nav.follow(entity, {distance})
function nav.follow(...) end
--- nav.stop()
function nav.stop(...) end
--- nav.flee(pos, opts?)
function nav.flee(...) end
--- nav.distance_to(t) → number|nil
function nav.distance_to(...) end
--- nav.can_reach(pos) → boolean（宿主 raycast/reach）
function nav.can_reach(...) end
--- nav.hop() — 输入位 jump 一个短窗口（核心组合）
function nav.hop(...) end
---@class look
look = {}
--- look.yaw(deg)
function look.yaw(...) end
--- look.pitch(deg)
function look.pitch(...) end
--- look.aim(yaw, pitch) — 单包写两轴
function look.aim(...) end
--- look.current() → {yaw,pitch}
function look.current(...) end
---@class container
container = {}
--- container.open(pos|[entity]) → window handle|nil
function container.open(...) end
--- container.close(win?)
function container.close(...) end
--- container.current() → handle|nil
function container.current(...) end
---@class inv
inv = {}
--- inv.count(filter)
function inv.count(...) end
--- inv.has(filter)
function inv.has(...) end
--- inv.find(filter) → slot|nil
function inv.find(...) end
--- inv.slots() → [{index,item}]
function inv.slots(...) end
--- inv.held() → stack|nil
function inv.held(...) end
--- inv.click(slot, {button,mode})
function inv.click(...) end
--- inv.cursor()
function inv.cursor(...) end
--- inv.equip(slot|filter) → stack|nil
function inv.equip(...) end
--- inv.select_slot(slot) — 快捷栏选择包
function inv.select_slot(...) end
--- inv.drop(filter, count) — 丢弃（held 走玩家动作，槽位走 click 包）
function inv.drop(...) end
---@class combat
combat = {}
--- combat.attack(entity)
function combat.attack(...) end
--- combat.interact_entity(entity)
function combat.interact_entity(...) end
--- combat.range() → 3.0
function combat.range(...) end
--- combat.cooldown() → ms（由 held stack 的 attack_speed 推导）
function combat.cooldown(...) end
--- combat.use_block(pos, opts?)
function combat.use_block(...) end
--- combat.place(pos, face?) — intent=place（受 boundary.blocks.place 门控）
function combat.place(...) end
--- combat.use_item(duration_ms) — 核心组合 start/sleep/release
function combat.use_item(...) end
--- combat.dig(pos, face?) — 开始并等待破坏完成
function combat.dig(...) end
--- combat.dig_stop()
function combat.dig_stop(...) end
---@class self
self = {}
--- self.username()
function self.username(...) end
--- self.pos() → {x,y,z}
function self.pos(...) end
--- self.velocity() → {x,y,z}
function self.velocity(...) end
--- self.health()
function self.health(...) end
--- self.food()
function self.food(...) end
--- self.held() → stack|nil
function self.held(...) end
--- self.gamemode()
function self.gamemode(...) end
--- self.effects() → [{id,amplifier,duration}]
function self.effects(...) end
--- self.attributes() → {armor,absorption,xp_level,xp_progress}
function self.attributes(...) end
--- self.pose()
function self.pose(...) end
---@class session
session = {}
--- session.state()
function session.state(...) end
--- session.info() → {version,brand,ping,players,view_distance,dimension}
function session.info(...) end
--- session.paused() → boolean
function session.paused(...) end
---@class caps
caps = {}
--- caps.has(flag)
function caps.has(...) end
--- caps.server_version()
function caps.server_version(...) end
---@class net
net = {}
--- net.on(channel, fn) — fn({channel,data,ts})；channel='*' 匹配全部；data 为原始字节串
function net.on(...) end
--- net.send(channel, data) → Result（data = 原始字节串或 0..255 字节数组；进门控/速率/预算）
function net.send(...) end
---@class data
data = {}
--- data.stack(item|{id}) → {id,count,max_count,damage,max_damage,components,attributes,enchantments,custom_name}
function data.stack(...) end
---@class events
events = {}
--- events.next(timeout_ms) → Result（value = {type,data,ts} | nil）
function events.next(...) end
--- events.emit(type, data)
function events.emit(...) end
---@class time
time = {}
--- time.sleep(ms)
function time.sleep(...) end
--- time.now() → ms
function time.now(...) end
---@class log
log = {}
--- log.info(fmt, ...)
function log.info(...) end
--- log.warn(fmt, ...)
function log.warn(...) end
--- log.error(fmt, ...)
function log.error(...) end
--- race({fn,...}) → 首个完成结果（兄弟取消）
function race(...) end
--- parallel({fn,...}) → 结果数组
function parallel(...) end
--- with_timeout(ms, fn)
function with_timeout(...) end
--- try(fn) → ok, err
function try(...) end
--- guard(cond, fn?)
function guard(...) end
--- wait_until(pred, {poll, timeout})
function wait_until(...) end
--- item_match(item, filter|fn) → boolean
function item_match(...) end
--- contains(list, v)
function contains(...) end
--- sec(n) → ms
function sec(...) end
---@class bslib
bslib = {}
--- bslib.look.at(target, opts?)
function bslib.look(...) end
--- bslib.ensure_holding(item_id|nil)
function bslib.ensure_holding(...) end
--- bslib.equip_best(kind?) — 按 stack 属性选武器
function bslib.equip_best(...) end
--- bslib.withdraw(win, filter, n)
function bslib.withdraw(...) end
--- bslib.deposit(win, filter, n)
function bslib.deposit(...) end
--- bslib.move(from, to, filter, opts?)
function bslib.move(...) end
--- bslib.is_combat_ready()
function bslib.is_combat_ready(...) end
--- 同 try
function bslib.try(...) end
--- 同 race
function bslib.race(...) end
--- 同 parallel
function bslib.parallel(...) end
--- 同 with_timeout
function bslib.with_timeout(...) end
--- 同 wait_until
function bslib.wait_until(...) end
