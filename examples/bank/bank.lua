-- ============================================================
-- 银行 bot（bank.lua）—— v1 验收脚本
-- 入账：系统消息 "收到来自 xxx 10 c"   → state.account:xxx 余额 += 10
-- 转账：玩家聊天   "转账 yyy"          → xxx 全额转给 yyy，回复"转账成功"
-- 取款：玩家聊天   "取款 [n]"          → /pay 给玩家；不得透支；超时挂账对账（不盲目回滚）
-- 一致性要点（评审修订）：
--   1) 读-判-扣收进 state.update 原子读改写——并发"取款"消息不可能双花
--   2) 意图按 id 存于 state.intent:<id>——并发下不会标错记录
--   3) 回执超时 ≠ 失败：扣款保持 pending，由回执处理器按 id 核销（迟到回执不二次退款）；
--      真·失败由运维对账回滚——宁可挂账，不可双重入账
-- 注意：入账正则/回执模板与服务器品牌相关（session.info().server_brand 选模板）
-- ============================================================

-- ============================================================

-- 操作员校验属于脚本自己的业务规则（平台不提供 owner/op 名单）
local function is_op(sender)
  local list = params.ops or ""
  if list == "" then return true end
  for name in string.gmatch(list, "[^, ]+") do
    if name == sender then return true end
  end
  return false
end

-- 状态（localStorage 语义）：账户 account:<name>；意图 intent:<id>；意图序号 intent_seq。
local ACCOUNT_PREFIX, INTENT_PREFIX = "account:", "intent:"

local function bal(name)
  local a = state.get(ACCOUNT_PREFIX .. name)
  return a and a.balance or 0
end

local function credit(name, n)
  state.update(ACCOUNT_PREFIX .. name, function(a)
    a = a or { player = name, balance = 0 }
    a.player = name
    a.balance = (a.balance or 0) + n
    return a
  end)
end

local function debit_if(name, n)
  local ok = false
  local r = state.update(ACCOUNT_PREFIX .. name, function(a)
    if not a or (a.balance or 0) < n then return a end
    a.balance = a.balance - n
    ok = true
    return a
  end)
  return ok and r.ok == true
end

local function intents_all()
  local out = {}
  for k, v in pairs(state.all()) do
    if k:sub(1, #INTENT_PREFIX) == INTENT_PREFIX then out[#out + 1] = v end
  end
  table.sort(out, function(a, b) return a.id < b.id end)
  return out
end

local function intent_add(fields)
  local id = state.get("intent_seq", 0) + 1
  state.set("intent_seq", id)
  fields.id = id
  fields.state = fields.state or "done"
  state.set(INTENT_PREFIX .. id, fields)
  return id
end

local function intent_mark(id, st)
  state.update(INTENT_PREFIX .. id, function(it)
    if it then it.state = st end
    return it
  end)
end

local function intent_find(where)
  local out = {}
  for _, it in ipairs(intents_all()) do
    local hit = true
    for k, v in pairs(where or {}) do
      if it[k] ~= v then hit = false; break end
    end
    if hit then out[#out + 1] = it end
  end
  return out
end

-- 1) 入账：system 通道 + 品牌模板。玩家消息无法直接伪造 system 通道；但若服务器插件会把
--    玩家文本转播成 system 消息（/me、公告回显等），本模板不适用——部署前核对 server_brand。
--    state.seen 为内容寻址去重：只防"同文重发"，同额两笔在窗口内会被误杀（聊天记账的
--    可靠性上限，非 bug）——窗口按服务器实际重发节奏取值。
on_chat(rex[[^收到来自 (?<from>\w+) (?<amount>\d+) ?c$]], { source = "system" }, function(m)
  if state.seen("dep:" .. m.raw, sec(5)) then return end
  local n = tonumber(m.amount)
  credit(m.from, n)                    -- credit-only 无条件；无则建户
  intent_add{ kind = "deposit", player = m.from, amount = n }
end)

-- 2) 转账：玩家 xxx 说 "转账 yyy" → 全额内部划转（无服务器命令）
on_chat(rex[[^转账 (?<to>\w+)$]], { source = "player" }, function(m)
  local from = m.sender
  if from == m.to then chat.reply("不能转给自己") return end
  local n = bal(from)                  -- 预检仅用于提示；真校验在 debit_if 内
  if n <= 0 then chat.reply("余额为 0") return end

  local ok = debit_if(from, n)
  if ok then
    intent_add{ kind = "transfer", from = from, to = m.to, amount = n }
    credit(m.to, n)                    -- yyy 无账户自动建户（0 起）
  end
  chat.reply(ok and "转账成功" or "余额不足")
end)

-- 3) 取款：玩家说 "取款"（全取）或 "取款 n" → /pay；不得透支
on_chat(rex[[^取款(?: (?<amount>\d+))?$]], { source = "player" }, function(m)
  local from = m.sender
  local n = tonumber(m.amount or "") or bal(from)
  if n < params.min_pay then chat.reply("低于单笔下限 " .. params.min_pay .. "c") return end

  local ok = debit_if(from, n)
  local pay_id
  if ok then pay_id = intent_add{ kind = "pay", player = from, amount = n, state = "pending" } end
  if not pay_id then chat.reply("余额不足，最多可取 " .. bal(from) .. "c") return end

  chat.reply("已受理 " .. n .. "c")
  chat.run_command("/pay " .. from .. " " .. n)     -- 白名单仅放行 /pay（首词元精确匹配）

  local rr = await_chat(rex("已向\\s+" .. from .. "\\b"), sec(5))   -- 服务器回执（模板按品牌调）
  if rr and rr.ok and rr.value then
    intent_mark(pay_id, "done")
    chat.reply("取款成功 " .. n .. "c")
  else
    -- 超时不回滚：超时 ≠ 失败。意图保持 pending，迟到回执由下方处理器核销；
    -- 服务器确实没扣款的情形由运维对账回滚（audit_pending 会持续告警挂账）
    chat.reply("支付确认超时，已挂账待对账")
  end
end)

-- 4) 回执收口：服务器 "已向 xxx …" → 核销该玩家最早的 pending 取款。
--    覆盖迟到回执：即便 5s 超时已提示过，钱实际已付出，唯一正确动作是核销（非退款）。
on_chat(rex[[^已向 (?<to>\w+)]], { source = "system" }, function(m)
  for _, it in ipairs(intent_find{ player = m.to, kind = "pay", state = "pending" }) do
    intent_mark(it.id, "done")
    return
  end
end)

-- 运维查询（无命令体系：聊天正则 + 脚本自管的 ops 名单；私聊走 /msg 命令）
on_chat(rex[[^balance (?<who>\w+)$]], { source = "player" }, function(m)
  if not is_op(m.sender) then return end
  chat.run_command('/msg ' .. m.sender .. ' 余额: ' .. bal(m.who) .. 'c')
end)

-- 恢复对账：启动/暂停恢复后扫描挂账，提醒运维（不自动退款）
local function audit_pending()
  for _, it in ipairs(intent_find{ kind = "pay", state = "pending" }) do
    log.warn("取款挂账未核销: %s %dc（id=%d）——人工核对后处理", it.player, it.amount, it.id)
  end
end
on_start(audit_pending)
on_resume(audit_pending)

on_error(function(e)
  log.error("银行 bot 未捕获错误: %s", e.kind or tostring(e))   -- 兜底告警
end)
