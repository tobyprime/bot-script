-- tsl_relay — TSL 游戏内 ↔ 平台 绑定/充值中继
-- ⚠ DEPRECATED（TOB-522；TOB-531 起收款上报切 pay 通知通道，缺口进一步拉大）：
--   收款/转账监听已由 examples/afk_guard/relay.lua 承接（transfer_pattern 热更
--   + pay 通知通道上报：pay_token/pay_endpoint 参数，普通实例零收款上报）。
--   新部署请用 afk_guard；本包仅保留绑定/验证码链路参考，不再随引擎演进入维护。
-- 全部交互 /msg 私聊回复，永不公屏：
--   /msg bot 登录<验证码>   绑定游戏角色到平台账户，并返回一次性网页登录链接
--   转账监听：系统聊天命中 transfer_pattern（如 "X 向 MixTobyInjSave 转账 5"）
--             → 平台给绑定账户入账 TSLC 余额，/msg 回执
-- 出站仅限 api_base（bot.yaml net 申明 ∩ 实例边界授权）
local json = require "json"

local function reply(to, text)
  if not to or text == nil or text == '' then return end
  chat.msg(to, tostring(text))
end

-- 括号私聊（zenoxs 全系统消息形态：[发送者 ➥ 接收者] 内容；箭头不参与匹配）
local function parse_bracket(msg)
  local head, text = (msg.raw or ''):match('^%[([^%]]+)%]%s*(.+)$')
  if not head then return nil, nil end
  local sender, arrow, recipient = head:match('^(%S+)%s+(%S+)%s+(%S+)$')
  if sender and arrow and recipient == tostring(params.bot_player) and text ~= '' then
    return sender, text:match('^%s*(.-)%s*$')
  end
  return nil, nil
end

local function api(path, payload)
  local status, data = net.jrequest({
    url = tostring(params.api_base) .. path,
    method = 'POST',
    headers = { ['X-Service-Token'] = tostring(params.service_token),
                ['Content-Type'] = 'application/json' },
    body = json.encode(payload or {}),
  })
  if status ~= 200 then return nil, ('HTTP %d %s'):format(status, json.encode(data or {})) end
  return data
end

on_chat(rex('^'), function(msg)
  -- 1) 私聊指令：登录<验证码> → 控制面绑定 + 发一次性登录链接
  local sender, text = parse_bracket(msg)
  if sender then
    if not text:match('^登录') and not text:match('^绑定') then return end   -- 非本 bot 指令
    if tostring(params.service_token) == '' then
      return reply(sender, 'bot 未配置服务令牌（params.service_token），请联系管理员')
    end
    local ok, data_or_err = pcall(api, '/api/tsl/cmd', { player = sender, text = text })
    if not ok then
      log.error('tsl cmd 失败: %s', tostring(data_or_err))
      return reply(sender, '平台暂不可用，请稍后再试')
    end
    return reply(sender, data_or_err.reply or '已处理')
  end

  -- 2) 转账监听：全量系统消息匹配 transfer_pattern → 平台入账
  local pat = tostring(params.transfer_pattern)
  if pat == '' then return end
  local payer, amount = (msg.raw or ''):match(pat)
  if not payer or not amount then return end
  if tostring(params.service_token) == '' then return end
  local ok, data_or_err = pcall(api, '/api/tsl/transfer', { player = payer, amount = tonumber(amount) })
  if not ok then return log.error('tsl transfer 失败: %s', tostring(data_or_err)) end
  if data_or_err and data_or_err.reply then
    -- 只对收款相关回执私聊付款人（未绑定者的引导语也发给付款人）
    reply(payer, data_or_err.reply)
  end
end)

on_start(function()
  -- 参数在 bindParams 后才可读（脚本顶层读到的还是空），启动日志放这里
  log.info('tsl_relay 启动: bot=%s api=%s', tostring(params.bot_player), tostring(params.api_base))
  if tostring(params.service_token) == '' then
    log.warn('service_token 未配置：/msg 指令与转账入账将拒绝服务（实例参数里设置）')
  end
end)
