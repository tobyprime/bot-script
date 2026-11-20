-- ============================================================
-- 银行 bot（bank.lua）—— v1 验收脚本
-- 入账：系统消息 "收到来自 xxx 10 c"   → Account[xxx] += 10
-- 转账：玩家聊天   "转账 yyy"          → xxx 全额转给 yyy，回复"转账成功"
-- 取款：玩家聊天   "取款 [n]"          → /pay 给玩家；不得透支；超时挂账对账（不盲目回滚）
-- 一致性要点（评审修订）：
--   1) 读-判-扣收进原语：Account.adjust_if 条件原子扣减——并发"取款"消息不可能双花
--   2) Intent 按 id 标记（L.mark）——并发下 mark_last 会标错记录
--   3) 回执超时 ≠ 失败：扣款保持 pending，由回执处理器按 id 核销（迟到回执不二次退款）；
--      真·失败由运维对账回滚——宁可挂账，不可双重入账
-- 注意：入账正则/回执模板与服务器品牌相关（session.info().server_brand 选模板）
-- ============================================================

params {
  min_pay = { type = "number", default = 1, visible = true, help = "单笔取款下限" },
  ops     = { type = "string", default = "", visible = true,
              help = "运维玩家名（逗号分隔；留空 = 不校验，示例用）" },
}

-- 操作员校验属于脚本自己的业务规则（平台不提供 owner/op 名单）
local function is_op(sender)
  local list = params.ops or ""
  if list == "" then return true end
  for name in string.gmatch(list, "[^, ]+") do
    if name == sender then return true end
  end
  return false
end

persist.table "Account" { player = "string:key", balance = "number" }
persist.log  "Intent"                  -- L.append -> id；L.find{...} 查询；L.mark(id, state)

local function bal(name)
  local a = Account.find{ player = name }
  return a and a.balance or 0
end

-- 1) 入账：system 通道 + 品牌模板。玩家消息无法直接伪造 system 通道；但若服务器插件会把
--    玩家文本转播成 system 消息（/me、公告回显等），本模板不适用——部署前核对 server_brand。
--    persist.seen 为内容寻址去重：只防"同文重发"，同额两笔在窗口内会被误杀（聊天记账的
--    可靠性上限，非 bug）——窗口按服务器实际重发节奏取值。
on_chat(rex[[^收到来自 (?<from>\w+) (?<amount>\d+) ?c$]], { source = "system" }, function(m)
  if persist.seen("dep:" .. m.raw, sec(5)) then return end
  local n = tonumber(m.amount)
  txn(function()
    local id = Intent.append{ kind = "deposit", player = m.from, amount = n }
    Account.adjust(m.from, n)          -- credit-only 无条件；无则建户
    Intent.mark(id, "done")
  end)
end)

-- 2) 转账：玩家 xxx 说 "转账 yyy" → 全额内部划转（无服务器命令）
on_chat(rex[[^转账 (?<to>\w+)$]], { source = "player" }, function(m)
  local from = m.sender
  if from == m.to then chat.reply("不能转给自己") return end
  local n = bal(from)                  -- 预检仅用于提示；真校验在 adjust_if 内
  if n <= 0 then chat.reply("余额为 0") return end

  local ok = false
  txn(function()
    -- 条件原子扣减：并发转账/取款在此串行化，余额不足则整个划转不发生
    if not Account.adjust_if(from, function(a) return a.balance >= n end, -n) then return end
    local id = Intent.append{ kind = "transfer", from = from, to = m.to, amount = n }
    Account.adjust(m.to, n)            -- yyy 无账户自动建户（0 起）
    Intent.mark(id, "done")
    ok = true
  end)
  chat.reply(ok and "转账成功" or "余额不足")
end)

-- 3) 取款：玩家说 "取款"（全取）或 "取款 n" → /pay；不得透支
on_chat(rex[[^取款(?: (?<amount>\d+))?$]], { source = "player" }, function(m)
  local from = m.sender
  local n = tonumber(m.amount or "") or bal(from)
  if n < params.min_pay then chat.reply("低于单笔下限 " .. params.min_pay .. "c") return end

  local pay_id
  txn(function()
    -- 条件原子扣减：并发"取款"只有一笔能成功（原读-判-扣跨事务会双花）
    if not Account.adjust_if(from, function(a) return a.balance >= n end, -n) then return end
    pay_id = Intent.append{ kind = "pay", player = from, amount = n, state = "pending" }
  end)
  if not pay_id then chat.reply("余额不足，最多可取 " .. bal(from) .. "c") return end

  chat.reply("已受理 " .. n .. "c")
  chat.run_command("/pay " .. from .. " " .. n)     -- 白名单仅放行 /pay（首词元精确匹配）

  local rr = await_chat(rex("已向\\s+" .. from .. "\\b"), sec(5))   -- 服务器回执（模板按品牌调）
  if rr and rr.ok and rr.value then
    Intent.mark(pay_id, "done")
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
  txn(function()
    for _, it in ipairs(Intent.find{ player = m.to, kind = "pay", state = "pending" }) do
      Intent.mark(it.id, "done")
      return
    end
  end)
end)

-- 运维查询（无命令体系：聊天正则 + 脚本自管的 ops 名单；bot.yaml 配 msg_command → reply 走私聊）
on_chat(rex[[^balance (?<who>\w+)$]], { source = "player" }, function(m)
  if not is_op(m.sender) then return end
  chat.reply(m.sender, "余额: " .. bal(m.who) .. "c")
end)

-- 恢复对账：启动/暂停恢复后扫描挂账，提醒运维（不自动退款）
local function audit_pending()
  for _, it in ipairs(Intent.find{ kind = "pay", state = "pending" }) do
    log.warn("取款挂账未核销: %s %dc（id=%d）——人工核对后处理", it.player, it.amount, it.id)
  end
end
on_start(audit_pending)
on_resume(audit_pending)

on_error(function(e)
  log.error("银行 bot 未捕获错误: %s", e.kind or tostring(e))   -- 兜底告警
end)
