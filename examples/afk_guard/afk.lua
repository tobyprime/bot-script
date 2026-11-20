-- ============================================================
-- afk_guard —— 挂机看家 bot
-- 所有交互走 /msg 私聊，永不公屏发言：
--   /msg bot status                任何人：查状态
--   /msg bot admin add <name>      超管：添加管理员
--   /msg bot admin del <name>      超管：删除管理员
--   /msg bot admin list            超管/管理员：列出管理员
--   /msg bot lock | unlock         超管/管理员：锁定后 tpa/tpahere 不再自动接受
-- tpa 自动接受：聊天（系统提示）命中关键词 → /tpaccept <玩家>，并 /msg 告知对方
-- 超管 = params.super_admin；管理员清单与锁定状态存实例 state（重启保留）
-- 服务端私聊/传送提示格式各异：whisper_marker 与两个关键词均为 params，可在平台可视化编辑
-- ============================================================

-- 管理员名单：state 前缀 admin:<name>；锁定状态：state["afk:locked"]。

-- ---------- 工具 ----------

local function super() return tostring(params.super_admin or '') end

-- bot 名：显式 bot_name 优先；空 = 锚定 bot 自身用户名（TOB-520 吸收：默认零手改）
local function bot_name_or_self()
  local n = tostring(params.bot_name or '')
  if n ~= '' then return n end
  return tostring(self.username() or '')
end

local ADMIN_PREFIX = 'admin:'
local function admin_get(name) return state.get(ADMIN_PREFIX .. name) end
local function admin_put(name, rec) state.set(ADMIN_PREFIX .. name, rec) end
local function admin_del(name) state.delete(ADMIN_PREFIX .. name) end
local function admins_all()
  local out = {}
  for k, v in pairs(state.all()) do
    if k:sub(1, #ADMIN_PREFIX) == ADMIN_PREFIX then out[#out + 1] = v end
  end
  return out
end

local function is_admin(name)
  if name == '' then return false end
  if name == super() then return true end
  return admin_get(name) ~= nil
end

local function locked() return state.get('afk:locked') == true end

-- 私聊是服务器命令，不是聊天频道：统一 /msg
local function reply(to, text) chat.run_command('/msg ' .. tostring(to) .. ' ' .. tostring(text)) end

local function markers()
  local list = {}
  for m in string.gmatch(tostring(params.whisper_marker or ''), '[^,]+') do
    m = m:match('^%s*(.-)%s*$')
    if m ~= '' then list[#list + 1] = m end
  end
  return list
end

-- 私聊解析一：方括号私聊格式 [发送者 <箭头> 接收者] 内容（全系统消息服，如 zenoxs）
--   箭头字形不参与匹配（该服为 ➥，截图复制易混 ➦），按括号内三个非空白 token 拆分
--   接收者必须等于 bot_name，防止把别人的私聊/频道消息当成对自己的命令
local function parse_bracket(msg)
  local head, text = (msg.raw or ''):match('^%[([^%]]+)%]%s*(.+)$')
  if not head then return nil end
  local sender, arrow, recipient = head:match('^(%S+)%s+(%S+)%s+(%S+)$')
  if sender and arrow and recipient == bot_name_or_self() and text ~= '' then
    return sender, text:match('^%s*(.-)%s*$')
  end
  return nil
end

-- 私聊解析二：raw 命中任一标记 → 标记后的文本为命令，发送者取 driver 解析结果或标记前的行首词
local function parse_whisper(msg)
  for _, marker in ipairs(markers()) do
    local i = string.find(msg.raw or '', marker, 1, true)
    if i then
      local text = string.match(string.sub(msg.raw, i + #marker), '^%s*(.-)%s*$')
      local sender = msg.sender
      if not sender or sender == '' then
        sender = string.match(string.sub(msg.raw, 1, i - 1) or '', '(%S+)%s*$')
      end
      if text ~= '' and sender and sender ~= '' then return sender, text end
      return nil
    end
  end
  return nil
end

-- ---------- 命令处理 ----------

local function handle_whisper(from, text)
  if text:match('^登录') or text:match('^绑定') or text:match('^余额') or text:match('^充值') or text:match('^索取兑换码') then return end   -- relay.lua 上报平台处理
  local words = {}
  for w in string.gmatch(text, '%S+') do words[#words + 1] = w end
  local cmd = words[1]

  if cmd == 'status' then
    local n = 0
    local n = 0
    for _ in admins_all() do n = n + 1 end
    reply(from, string.format('afk bot[%s] | 管理员 %d 人 | tpa自动接受 %s',
      locked() and '已锁定' or '未锁定', n,
      (params.auto_accept_tpa ~= false) and '开' or '关'))

  elseif cmd == 'lock' or cmd == 'unlock' then
    if not is_admin(from) then reply(from, '需要管理员权限') return end
    state.set('afk:locked', cmd == 'lock')
    reply(from, cmd == 'lock' and '已锁定：tpa/tpahere 不再自动接受' or '已解锁：tpa/tpahere 自动接受')

  elseif cmd == 'admin' then
    if from ~= super() then reply(from, '仅超级管理员可管理管理员名单') return end
    local sub, name = words[2], words[3]
    if sub == 'add' and name then
      if admin_get(name) then reply(from, name .. ' 已经是管理员') return end
      admin_put(name, { player = name, added_by = from, at = time.now() })
      reply(from, '已添加管理员: ' .. name)
      if name ~= from then reply(name, '你已被 ' .. from .. ' 设为 afk bot 管理员（/msg bot lock|unlock）') end
    elseif sub == 'del' and name then
      if not admin_get(name) then reply(from, name .. ' 不是管理员') return end
      admin_del(name)
      reply(from, '已删除管理员: ' .. name)
    elseif sub == 'list' then
      local names = {}
      for _, row in ipairs(admins_all()) do names[#names + 1] = row.player end
      reply(from, '超管: ' .. (super() ~= '' and super() or '（未配置）')
        .. ' | 管理员: ' .. (#names > 0 and table.concat(names, ', ') or '无'))
    else
      reply(from, '用法: admin add <name> | admin del <name> | admin list')
    end

  else
    reply(from, 'afk bot 命令: status | lock | unlock | admin add <name> | admin del <name> | admin list')
  end
end

-- ---------- tpa 自动接受 ----------

local function handle_tpa(msg)
  if locked() then return end                          -- 锁定：不自动接受（请求自然超时）
  if params.auto_accept_tpa == false then return end
  local raw = msg.raw or ''
  local kind
  if raw:find(tostring(params.tpa_to_keyword), 1, true) then kind = 'tpa'
  elseif raw:find(tostring(params.tpahere_keyword), 1, true) then kind = 'tpahere' end
  if not kind then return end
  -- 请求者名 = 关键词前最近的非空白 token（行首可能是 [TSL] 之类的频道标签）
  local kw = kind == 'tpa' and tostring(params.tpa_to_keyword) or tostring(params.tpahere_keyword)
  local pos = raw:find(kw, 1, true)
  local name = pos and raw:sub(1, pos - 1):match('(%S+)%s*$') or nil
  if not name or name == '' then return end
  if state.seen('tpa:' .. name .. ':' .. kind, 8000) then return end   -- 多行提示去重
  chat.run_command((tostring(params.tp_accept_cmd)):gsub('{player}', name))
  reply(name, '已自动接受你的 ' .. kind .. ' 请求')
end

-- ---------- 入口 ----------

on_chat(rex'^', function(msg)
  if params.debug_chat ~= false then
    log.info('chat kind=%s from=%s | raw=%s', tostring(msg.sender_kind), tostring(msg.sender), tostring(msg.raw):sub(1, 90))
  end
  local from, text = parse_bracket(msg)
  if not from then from, text = parse_whisper(msg) end
  if from then
    handle_whisper(from, text)
    return
  end
  handle_tpa(msg)
end)

on_start(function()
  log.info('afk_guard 启动: 超管=%s | tpa自动接受=%s | 防挂机=%s | 锁定=%s',
    super() ~= '' and super() or '未配置',
    tostring(params.auto_accept_tpa ~= false),
    tostring(params.anti_afk ~= false),
    tostring(locked()))
end)

-- 防挂机：每 45s 微调视角（0.2°），锁定与否都执行（挂机是本职）
task('anti_afk', { single = true }, function()
  local flip = false
  while true do
    time.sleep(45000)
    if params.anti_afk ~= false then
      flip = not flip
      look.yaw(flip and 0.2 or -0.2)
    end
  end
end)
