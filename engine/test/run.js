// engine/test/run.js — 无服务器冒烟测试（mock 驱动全栈：Lua VM + 调度 + persist + 策略 + bslib）
// 用法：node engine/test/run.js
// 注：wasmoon 的 global.get 对 Lua table 返回不可靠 POJO —— 测试脚本一律把结果
// 写成 __R_* 标量全局（string/number/boolean），JS 侧直接读。
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { BotEngine } from '../engine.js';
import { MockDriver } from './mock-driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, 'tmp');
const TEST_DIR = path.join(TMP, 'scripts');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function script(name, src) {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(path.join(TEST_DIR, name), src);
}

async function makeEngine({ yaml = {}, scripts = [], driver, boundary, runtime } = {}) {
  const d = driver ?? new MockDriver();
  const engine = new BotEngine({
    name: 'test-bot',
    ...yaml,
    scripts,
  }, d, {
    scriptDir: TEST_DIR,
    // v2：边界经 opts.boundary（实例部署层，DESIGN §6）；缺省给空 boundary（已授权实例），
    // 观察模式（默认全拒）由用例显式传 boundary: null 验证
    boundary: boundary !== undefined ? boundary : (yaml.boundary ?? yaml.policy ?? {}),
    connect: yaml.connect ?? yaml.driver ?? {},
    runtime,
  });
  await engine.start();
  return { engine, driver: d };
}

async function waitFor(cond, timeout = 5000, step = 25) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

const g = (engine, name) => engine.lua.global.get(name);

// ============================================================
// 1. 调度核心
// ============================================================

test('任务与组合子：race 吞兄弟取消、parallel 全完成、with_timeout、cancel 清理钩', async () => {
  script('t1.lua', `
    __R_race_winner = nil
    __R_p1, __R_p2 = nil, nil
    __R_timeout_kind = nil
    __R_cleaned = false
    task("parent", function()
      local w = race({
        function() time.sleep(10) return "fast" end,
        function() time.sleep(10000) return "slow" end,
      })
      __R_race_winner = w
      local rs = parallel({
        function() time.sleep(10) return 1 end,
        function() time.sleep(20) return 2 end,
      })
      __R_p1, __R_p2 = rs[1], rs[2]
      local ok, err = pcall(function()
        with_timeout(50, function() time.sleep(5000) end)
      end)
      __R_timeout_kind = (ok == false) and err.kind or nil
      task.spawn(function()
        on_cancel(function() nav.stop(); __R_cleaned = true end)
        time.sleep(10000)
      end)
      time.sleep(30)
      task.cancel_all("parent-end")
    end)
    on_start(function() task.spawn("parent") end)
  `);
  const { engine } = await makeEngine({ scripts: ['t1.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_race_winner') === 'fast'), 'race 应快分支胜');
  assert.ok(await waitFor(() => g(engine, '__R_p1') === 1 && g(engine, '__R_p2') === 2), 'parallel 应全完成');
  assert.ok(await waitFor(() => g(engine, '__R_timeout_kind') === 'timeout'), 'with_timeout 应抛 timeout');
  assert.ok(await waitFor(() => g(engine, '__R_cleaned') === true), 'on_cancel 清理钩应执行');
  await engine.stop();
});

test('single 防重入：重复触发被丢弃', async () => {
  script('t2.lua', `
    __R_runs = 0
    task("solo", { single = true }, function()
      __R_runs = __R_runs + 1
      time.sleep(200)
    end)
    on_start(function()
      task.spawn("solo")
      task.spawn("solo")
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['t2.lua'] });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(g(engine, '__R_runs'), 1, 'single 任务期间重复 spawn 应丢弃');
  await engine.stop();
});

// ============================================================
// 2. persist
// ============================================================

test('persist：adjust_if 防双花、txn 回滚、log mark、kv、seen 去重', async () => {
  script('t3.lua', `
    persist.table "Account" { player = "string:key", balance = "number" }
    persist.log  "Intent"
    persist.kv   "meta"
    on_start(function()
      task.spawn(function()
        Account.upsert{ player = "alice", balance = 10 }
        local a = Account.adjust_if("alice", function(ac) return ac.balance >= 8 end, -8)
        local b = Account.adjust_if("alice", function(ac) return ac.balance >= 8 end, -8)
        __R_cond_a = a
        __R_cond_b = b
        __R_cond_balance = Account.find{ player = "alice" }.balance
        Account.adjust("bob", 5)
        __R_bob = Account.find{ player = "bob" }.balance
        txn(function() Account.upsert{ player = "carol", balance = 1 } end)
        pcall(function()
          txn(function()
            Account.upsert{ player = "dave", balance = 3 }
            error{ kind = "boom" }
          end)
        end)
        __R_carol = Account.find{ player = "carol" } ~= nil
        __R_dave = Account.find{ player = "dave" } ~= nil
        local id = Intent.append{ kind = "pay", player = "alice", amount = 8, state = "pending" }
        Intent.mark(id, "done")
        __R_log_rows = #Intent.find{ player = "alice", kind = "pay", state = "done" }
        meta.set("k", { v = 42 })
        __R_kv = meta.get("k").v
        __R_seen1 = persist.seen("dep:hello", 5000)
        __R_seen2 = persist.seen("dep:hello", 5000)
      end)
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['t3.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_seen2') !== undefined), '场景未跑完');
  assert.deepStrictEqual([g(engine, '__R_cond_a'), g(engine, '__R_cond_b')], [true, false], '第二笔扣减必须失败');
  assert.strictEqual(g(engine, '__R_cond_balance'), 2);
  assert.strictEqual(g(engine, '__R_bob'), 5, 'adjust 无则建户');
  assert.strictEqual(g(engine, '__R_carol'), true, 'txn 提交应保留');
  assert.strictEqual(g(engine, '__R_dave'), false, 'txn 回滚不应留痕');
  assert.strictEqual(g(engine, '__R_log_rows'), 1);
  assert.strictEqual(g(engine, '__R_kv'), 42);
  assert.deepStrictEqual([g(engine, '__R_seen1'), g(engine, '__R_seen2')], [false, true], 'seen 应去重同文');
  await engine.stop();
});

test('persist.txn_yielded：事务体内挂起点 => 回滚并抛类型化错误', async () => {
  script('t3b.lua', `
    persist.table "T" { k = "string:key", v = "number" }
    on_start(function()
      task.spawn(function()
        local ok, err = pcall(function()
          txn(function()
            T.upsert{ k = "x", v = 1 }
            time.sleep(10)
            T.upsert{ k = "y", v = 2 }
          end)
        end)
        __R_err_kind = (not ok) and err.kind or nil
      end)
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['t3b.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_err_kind') !== undefined));
  assert.strictEqual(g(engine, '__R_err_kind'), 'persist.txn_yielded');
  assert.strictEqual(engine.persist.find('T', { k: 'x' }), null, '事务应已回滚');
  await engine.stop();
});

// ============================================================
// 3. 聊天 / 命令 / 权限
// ============================================================

test('on_chat 命名分组 + sender_kind 过滤 + await_chat 命中/超时', async () => {
  script('t4.lua', `
    __R_hit1 = nil
    __R_await_hit = nil
    __R_await_miss_hit = false
    on_chat(rex[[^收到来自 (?<from>\\w+) (?<amount>\\d+) c$]], { source = "system" }, function(m)
      __R_hit1 = m.from .. "|" .. m.amount .. "|" .. m.sender_kind
    end)
    task("await_test", function()
      local hit = await_chat(rex[[^转账 (?<to>\\w+)$]], 1000)
      __R_await_hit = hit and hit.to or nil
      local miss = await_chat(rex[[^never_match_xyz$]], 50)
      __R_await_miss_hit = miss ~= nil
    end)
    on_start(function() task.spawn("await_test") end)
  `);
  const { engine, driver } = await makeEngine({ scripts: ['t4.lua'] });
  await new Promise((r) => setTimeout(r, 50));
  driver.serverSay('收到来自 Alice 10 c');
  driver.playerSay('Bob', '转账 Carol');
  assert.ok(await waitFor(() => g(engine, '__R_hit1') !== undefined));
  assert.strictEqual(g(engine, '__R_hit1'), 'Alice|10|system', '命名分组 + system 源过滤');
  assert.ok(await waitFor(() => g(engine, '__R_await_hit') !== undefined));
  assert.strictEqual(g(engine, '__R_await_hit'), 'Carol', 'await_chat 应命中并解出命名分组');
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(g(engine, '__R_await_miss_hit'), false, 'await_chat 超时应返回 nil');
  await engine.stop();
});

test('命令总线：权限拒绝与放行 + 内建 pause/resume', async () => {
  script('t5.lua', `
    __R_ran = false
    on_command("guard stop", { perm = "op" }, function() __R_ran = true end)
  `);
  const { engine, driver } = await makeEngine({
    scripts: ['t5.lua'],
    yaml: { boundary: { authority: { op: ['Steve'] } } },
  });
  await new Promise((r) => setTimeout(r, 30));
  driver.playerSay('Eve', 'guard stop');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(g(engine, '__R_ran'), false, '无权限命令不得执行');
  driver.playerSay('Steve', 'guard stop');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(g(engine, '__R_ran'), true, 'op 命令应执行');
  driver.playerSay('Steve', 'pause');
  assert.strictEqual(engine.paused, true, '内建 pause 应生效');
  driver.playerSay('Eve', 'resume');
  assert.strictEqual(engine.paused, true, '无权限 resume 不得生效');
  driver.playerSay('Steve', 'resume');
  assert.strictEqual(engine.paused, false, 'resume 应生效');
  await engine.stop();
});

// ============================================================
// 4. 窗口点击协议 + bslib 复合
// ============================================================

test('container + bslib：withdraw 精确取出、deposit、move 多趟', async () => {
  script('t6.lua', `
    task("haul", function()
      local A = { x = 5, y = 64, z = 5 }
      local B = { x = 10, y = 64, z = 5 }
      local w = container.open(A)
      __R_type = w:type()
      __R_size = w:size()
      local got = bslib.withdraw(w, { id = "minecraft:pink_wool" }, 30)
      __R_withdrawn = got
      container.close(w)
      __R_inv_after_w = inv.count{ id = "minecraft:pink_wool" }
      local w2 = container.open(B)
      local put = bslib.deposit(w2, { id = "minecraft:pink_wool" }, got)
      __R_deposited = put
      container.close(w2)
      __R_moved = bslib.move(A, B, { id = "minecraft:pink_wool" })
    end)
    on_start(function() task.spawn("haul") end)
  `);
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, [[0, 'minecraft:pink_wool', 64], [1, 'minecraft:pink_wool', 64]]);
  driver.setContainer({ x: 10, y: 64, z: 5 }, []);
  const { engine } = await makeEngine({ scripts: ['t6.lua'], driver });
  assert.ok(await waitFor(() => {
    const m = g(engine, '__R_moved');
    return m !== undefined && m !== null;
  }, 10000), 'move 未完成');
  assert.strictEqual(g(engine, '__R_type'), 'chest');
  assert.strictEqual(g(engine, '__R_size'), 27);
  assert.strictEqual(g(engine, '__R_withdrawn'), 30, '精确取出 30');
  assert.strictEqual(g(engine, '__R_inv_after_w'), 30);
  assert.strictEqual(g(engine, '__R_deposited'), 30);
  assert.strictEqual(g(engine, '__R_moved'), 98, 'A 剩余 98 块应全部转移');
  assert.strictEqual(driver.containerSlots.get('5,64,5').reduce((n, s) => n + (s?.count ?? 0), 0), 0, 'A 应空');
  assert.strictEqual(driver.containerSlots.get('10,64,5').reduce((n, s) => n + (s?.count ?? 0), 0), 128, 'B 应收齐 128');
  await engine.stop();
});

// ============================================================
// 5. 暂停语义
// ============================================================

test('pause/resume：动作以 runtime.paused 失败（恢复时于冻结点重抛），钩子执行', async () => {
  script('t7.lua', `
    __R_paused = false
    __R_resumed = false
    __R_paused_err = false
    __R_wrong_err = nil
    on_pause(function() __R_paused = true end)
    on_resume(function() __R_resumed = true end)
    task("walker", function()
      local ok, err = pcall(function()
        nav.walk({ x = 50, y = 64, z = 50 }, { timeout = 30000 })
      end)
      if not ok and type(err) == "table" and err.kind == "runtime.paused" then
        __R_paused_err = true
      else
        __R_wrong_err = (not ok) and tostring(err.kind or err) or "no_err"
      end
    end)
    on_start(function() task.spawn("walker") end)
  `);
  const driver = new MockDriver();
  driver.gotoDelay = 400;
  const { engine } = await makeEngine({ scripts: ['t7.lua'], driver });
  await new Promise((r) => setTimeout(r, 80));
  engine.pause('command');
  assert.strictEqual(engine.paused, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(g(engine, '__R_paused'), true, 'on_pause 应执行');
  assert.strictEqual(g(engine, '__R_paused_err'), false, '暂停期间错误应冻结于门');
  engine.resume();
  assert.ok(await waitFor(() => g(engine, '__R_paused_err') === true), '恢复后应在冻结点重抛 runtime.paused');
  assert.strictEqual(g(engine, '__R_resumed'), true, 'on_resume 应执行');
  assert.ok(g(engine, '__R_wrong_err') == null, '不应是其它错误');
  await engine.stop();
});

// ============================================================
// 6. 示例脚本
// ============================================================

const EXAMPLES = path.resolve(__dirname, '..', '..', 'examples');

test('bank：入账/去重/转账/取款挂账/回执核销/私聊余额 全链路', async () => {
  const driver = new MockDriver();
  const engine = new BotEngine({
    name: 'bank-1',
    scripts: [path.join(EXAMPLES, 'bank', 'bank.lua')],
  }, driver, {
    scriptDir: path.join(EXAMPLES, 'bank'),
    boundary: { authority: { op: ['Steve'] }, chat: { commands: ['/pay'], msg_command: '/msg' } },
  });
  await engine.start();
  await new Promise((r) => setTimeout(r, 50));

  driver.serverSay('收到来自 Alice 10 c');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(engine.persist.find('Account', { player: 'Alice' })?.balance, 10, '入账 10');

  driver.serverSay('收到来自 Alice 10 c');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(engine.persist.find('Account', { player: 'Alice' })?.balance, 10, '重复同文应被 seen 去重');

  driver.playerSay('Alice', '转账 Bob');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(engine.persist.find('Account', { player: 'Bob' })?.balance, 10, 'Bob 收到划转');
  assert.strictEqual(engine.persist.find('Account', { player: 'Alice' })?.balance, 0);

  driver.playerSay('Bob', '取款 6');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(driver.outgoingCommands.some((c) => c === '/pay Bob 6'), '应发出白名单内 /pay');
  assert.strictEqual(engine.persist.find('Account', { player: 'Bob' })?.balance, 4, '扣款即时生效');
  assert.strictEqual(engine.persist.logFind('Intent', { state: 'pending' }).length, 1, '回执未到：意图 pending');
  assert.ok(await waitFor(() => driver.outgoingChat.some((m) => m.includes('支付确认超时')), 8000), '5s 超时后挂账告示');
  assert.strictEqual(engine.persist.logFind('Intent', { state: 'pending' }).length, 1, '超时不回滚：保持挂账');

  driver.serverSay('已向 Bob 6 c');
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(engine.persist.logFind('Intent', { state: 'pending' }).length, 0, '迟到回执应收口挂账');

  driver.playerSay('Steve', 'balance Alice');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(driver.outgoingCommands.some((c) => c.startsWith('/msg Steve')), 'balance 应走私聊给操作者');

  await engine.stop();
});

test('organizer：冷启动扫描 + organize once + 输入箱分流', async () => {
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, [[0, 'minecraft:pink_wool', 30], [1, 'minecraft:cobblestone', 12]]);
  driver.setContainer({ x: 10, y: 64, z: 5 }, []);
  driver.setContainer({ x: 12, y: 64, z: 5 }, [[3, 'minecraft:pink_wool', 40]]);
  const engine = new BotEngine({
    name: 'organizer-1',
    scripts: [path.join(EXAMPLES, 'organizer', 'organizer.lua')],
    params: {
      // 离线测试：实例坐标以包默认层注入（线上等价于运行期设参后持久化）
      input: [5, 64, 5],
      stock_zone: [[9, 62, 3], [14, 66, 7]],
      partial_chests: [[10, 64, 5]],
    },
  }, driver, {
    scriptDir: path.join(EXAMPLES, 'organizer'),
    boundary: { authority: { op: ['Steve'] }, blocks: { dig: 'deny', place: 'deny' } },
  });
  await engine.start();
  await new Promise((r) => setTimeout(r, 2200));   // 等 session.ready 冷启动扫描
  driver.playerSay('Steve', 'organize once');
  const dumpSlots = (k) => k === 'inv'
    ? driver.inv.filter(Boolean).map((s) => `${s.id.split(':')[1]}x${s.count}`).join(',') || '(空)'
    : driver.containerSlots.get(k).map((s, i) => s ? `${i}:${s.id.split(':')[1]}x${s.count}` : null).filter(Boolean).join(' ') || '(空)';
  assert.ok(await waitFor(() => {
    const input = driver.containerSlots.get('5,64,5');
    return input.every((s) => !s);
  }, 20000), '输入箱应被清空');
  const countIn = (k, id) => driver.containerSlots.get(k)
    .reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);
  console.log('  [dump] chest10 =', dumpSlots('10,64,5'), '| chest12 =', dumpSlots('12,64,5'), '| inv =', dumpSlots('inv'));
  const woolTotal = countIn('10,64,5', 'minecraft:pink_wool') + countIn('12,64,5', 'minecraft:pink_wool') + driver.invCount('minecraft:pink_wool');
  assert.strictEqual(woolTotal, 70, `wool 守恒（实际 ${woolTotal}）`);
  const cobbleTotal = countIn('10,64,5', 'minecraft:cobblestone') + countIn('12,64,5', 'minecraft:cobblestone') + driver.invCount('minecraft:cobblestone');
  assert.strictEqual(cobbleTotal, 12, `圆石守恒（实际 ${cobbleTotal}）`);
  await engine.stop();
});

test('coal_guard：举煤触发追击、放下即停、guard stop 取消', async () => {
  const driver = new MockDriver();
  const engine = new BotEngine({
    name: 'coal-guard-1',
    scripts: [path.join(EXAMPLES, 'coal_guard', 'coal_guard.lua')],
  }, driver, {
    scriptDir: path.join(EXAMPLES, 'coal_guard'),
    boundary: { authority: { op: ['Steve'] }, combat: { targets: 'player', max_engage: 24 } },
  });
  await engine.start();
  await new Promise((r) => setTimeout(r, 80));

  driver.addPlayer('Griefer', { x: 10, y: 64, z: 0 }, { id: 'minecraft:coal', count: 1 });
  assert.ok(await waitFor(() => engine.actionLog.some((a) => a.action === 'use_entity'), 8000), '应发起追击攻击');
  await new Promise((r) => setTimeout(r, 300));

  driver.setPlayerHeld('Griefer', null);
  assert.ok(await waitFor(() => driver.outgoingChat.some((m) => m.includes('已放下煤炭')), 5000), '应通报放过');
  const attacksAfter = engine.actionLog.filter((a) => a.action === 'use_entity').length;
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(engine.actionLog.filter((a) => a.action === 'use_entity').length, attacksAfter, '放下煤炭后应停止攻击');

  driver.playerSay('Steve', 'guard stop');
  assert.ok(await waitFor(() => driver.outgoingChat.some((m) => m.includes('警戒已停止')), 3000), 'stop 应回复');
  driver.setPlayerHeld('Griefer', { id: 'minecraft:coal', count: 1 });
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(engine.actionLog.filter((a) => a.action === 'use_entity').length, attacksAfter, '取消后不应再攻击');
  await engine.stop();
});

// ============================================================
// 7. v2 边界与部署（DESIGN §5.1 / §6）
// ============================================================

test('观察模式：无 boundary 一切动作被拒、查询与 params 可用', async () => {
  script('t8.lua', `
    __R_nav_err = nil
    __R_dig_err = nil
    task("mover", function()
      local ok, err = pcall(function() nav.walk({ x = 30, y = 64, z = 30 }, { timeout = 5 }) end)
      if not ok and type(err) == "table" then __R_nav_err = err.kind end
      local ok2, err2 = pcall(function() combat.dig({ x = 1, y = 64, z = 1 }) end)
      if not ok2 and type(err2) == "table" then __R_dig_err = err2.kind end
    end)
    on_start(function() task.spawn("mover") end)
  `);
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: ['t8.lua'], driver, boundary: null });
  assert.ok(await waitFor(() => g(engine, '__R_nav_err') !== undefined, 5000), 'nav 应被拒');
  assert.strictEqual(g(engine, '__R_nav_err'), 'permission.denied', '无 boundary：nav 必须 permission.denied');
  assert.ok(await waitFor(() => g(engine, '__R_dig_err') !== undefined, 5000), 'dig 应被拒');
  assert.strictEqual(g(engine, '__R_dig_err'), 'permission.denied', '无 boundary：dig 必须 permission.denied');
  // 查询与 params 不受观察模式限制（self 缓存即查询数据面）
  assert.ok(engine.self?.pos, '观察模式下查询数据面仍可用');
  await engine.stop();
});

test('未授即禁：blocks.dig / combat 未授权即拒，显式授权后放行', async () => {
  script('t9.lua', `
    __R_dig_err = nil
    __R_attack_err = nil
    task("actor", function()
      local ok, err = pcall(function() combat.dig({ x = 2, y = 64, z = 2 }) end)
      if not ok and type(err) == "table" then __R_dig_err = err.kind end
      local e = entity.nearest{ type = "player", alive = true, within = 10 }
      if e then
        local ok2, err2 = pcall(function() combat.attack(e) end)
        if not ok2 and type(err2) == "table" then __R_attack_err = err2.kind end
      end
    end)
    on_start(function() task.spawn("actor") end)
  `);
  // boundary = {}（有配置但未授 dig/combat）→ 均拒
  const driver = new MockDriver();
  driver.addPlayer('Victim', { x: 3, y: 64, z: 3 }, null);
  const { engine } = await makeEngine({ scripts: ['t9.lua'], driver, boundary: {} });
  assert.ok(await waitFor(() => g(engine, '__R_dig_err') !== undefined, 5000), 'dig 应被拒');
  assert.strictEqual(g(engine, '__R_dig_err'), 'policy.blocklist', '未授权 dig 必须 policy.blocklist');
  assert.strictEqual(g(engine, '__R_attack_err'), 'policy.blocklist', '未授权 combat 必须 policy.blocklist');
  await engine.stop();

  // 显式授权后放行
  const driver2 = new MockDriver();
  driver2.addPlayer('Victim', { x: 3, y: 64, z: 3 }, null);
  const { engine: engine2 } = await makeEngine({
    scripts: ['t9.lua'], driver: driver2,
    boundary: { blocks: { dig: 'allow' }, combat: { targets: 'player', max_engage: 16 } },
  });
  assert.ok(await waitFor(
    () => engine2.actionLog.some((a) => a.action === 'dig'), 5000), '授权后 dig 应放行');
  assert.ok(await waitFor(
    () => engine2.actionLog.some((a) => a.action === 'use_entity'), 5000), '授权后 attack 应放行');
  await engine2.stop();
});

test('v2 包清单：params schema+默认值形态、required 未设不阻塞启动', async () => {
  script('t10.lua', `
    __R_p1 = nil
    __R_p2 = "unset"
    on_start(function()
      __R_p1 = params.num_opt
      if params.must_set == nil then __R_p2 = "missing" else __R_p2 = params.must_set end
    end)
  `);
  const { engine } = await makeEngine({
    scripts: ['t10.lua'],
    yaml: {
      params: {
        num_opt: { type: 'number', default: 7, help: '清单 schema 形态' },
        must_set: { type: 'number', required: true },
      },
    },
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(g(engine, '__R_p1'), 7, '清单 default 应生效');
  assert.strictEqual(g(engine, '__R_p2'), 'missing', 'required 未设应为空但不阻塞启动');
  // 运行期设置后持久化（重启即实例事实）
  engine.setParam('must_set', 42);
  assert.strictEqual(engine.paramPersist.get('must_set'), 42, '显式设置应进入持久化层');
  await engine.stop();
});

// ============================================================
// 8. HTTP 控制通道（CAPABILITIES §17）
// ============================================================

test('httpapi：鉴权/状态/params/cmd/tasks/logs/persist/caps 全链', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    boundary: { authority: { op: ['Steve'] }, chat: { commands: ['/pay'] } },
    yaml: { params: { num_opt: { type: 'number', default: 7 } } },
  });
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../httpapi.js');
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  assert.strictEqual((await fetch(base + '/state')).status, 401, '无 token 401');
  assert.strictEqual((await fetch(base + '/state', { headers: { Authorization: 'Bearer nope' } })).status, 401);

  const state = (await (await fetch(base + '/state', { headers: hdr })).json());
  assert.strictEqual(state.name, 'test-bot');
  assert.strictEqual(state.host, 'mineflayer');
  assert.ok('nav.pathfinder' in state.caps);

  // params：schema 拒绝未知键；合法键写入并持久化
  assert.strictEqual((await fetch(base + '/params', { method: 'POST', headers: hdr, body: '{"nope":1}' })).status, 400);
  const pset = await (await fetch(base + '/params', { method: 'POST', headers: hdr, body: '{"num_opt":9}' })).json();
  assert.strictEqual(pset.changed.num_opt, 9);
  assert.strictEqual(engine.paramValues.get('num_opt'), 9);

  // cmd：同一命令总线（console 级）
  const cmd = await (await fetch(base + '/cmd', { method: 'POST', headers: hdr, body: '{"cmd":"status"}' })).json();
  assert.strictEqual(cmd.matched, true, '内建 status 应命中命令总线');

  // tasks + cancel
  const tasks = (await (await fetch(base + '/tasks', { headers: hdr })).json()).tasks;
  assert.ok(Array.isArray(tasks));
  const cancel = (await (await fetch(base + '/tasks/cancel', { method: 'POST', headers: hdr, body: '{"name":"ghost"}' })).json());
  assert.strictEqual(cancel.found, false);

  // logs：增量（since 过滤）
  const l1 = (await (await fetch(base + '/logs', { headers: hdr })).json());
  assert.ok(l1.logs.length > 0, '日志环应有启动日志');
  const l2 = (await (await fetch(base + `/logs?since=${Date.now() + 1000}`, { headers: hdr })).json());
  assert.strictEqual(l2.logs.length, 0, 'since 未来时刻应无增量');

  // persist：未声明表 → 400；声明后可查
  engine.persist.declareTable('T', { k: 'string:key', v: 'number' });
  engine.persist.upsert('T', { k: 'a', v: 1 });
  const rows = (await (await fetch(base + '/persist?table=T', { headers: hdr })).json()).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual((await fetch(base + '/persist?table=Nope', { headers: hdr })).status, 400);

  // caps：包清单回显
  const capsBody = (await (await fetch(base + '/caps', { headers: hdr })).json());
  assert.strictEqual(capsBody.host, 'mineflayer');
  assert.strictEqual(capsBody.manifest.name, 'test-bot');

  // eval：一次性 Lua 作为具名任务（同环境；返回值入日志；编译错误 400；运行失败进任务日志）
  const ev = await (await fetch(base + '/eval', { method: 'POST', headers: hdr, body: '{"name":"t1","code":"return 42"}' })).json();
  assert.strictEqual(ev.ok, true);
  assert.strictEqual(ev.task, 't1');
  const msgs = async () => (await (await fetch(base + '/logs', { headers: hdr })).json()).logs.map((l) => l.msg);
  assert.ok((await msgs()).some((m) => m.includes('[eval:t1] => 42')), 'eval 返回值应入日志');
  assert.strictEqual(
    (await fetch(base + '/eval', { method: 'POST', headers: hdr, body: '{"code":"return ~"}' })).status,
    400, '编译错误应 400',
  );
  await (await fetch(base + '/eval', { method: 'POST', headers: hdr, body: '{"name":"t2","code":"error(\\"boom\\")"}' })).json();
  assert.ok((await msgs()).some((m) => m.includes('t2') && m.includes('失败')), 'eval 运行失败应进日志');

  await engine.stop();
});

test('httpapi：实时流 /stream（补历史 + 实时增量）、聊天入站/出站、/chat 门控', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    boundary: { chat: { commands: ['/say'] } },   // 只放行 /say 命令；公屏发言受 say_rate 默认限速
  });
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../httpapi.js');
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 聊天入站（驱动 chat 事件）：进内存环，sender_kind 原样保留
  driver.playerSay('Steve', 'hello world');
  await new Promise((r) => setTimeout(r, 50));
  let logs = await (await fetch(base + '/logs', { headers: hdr })).json();
  assert.ok(logs.chats.some((c) => c.text === 'hello world' && c.sender /* Steve */));
  assert.ok(logs.logs.every((l) => typeof l.seq === 'number'), '环形日志应带单调 seq');

  // 出站消息流：录制实时流增量（先订阅再动作，避免竞态）
  const seen = [];
  const unsub = engine.subscribeStream((e) => seen.push(e));
  const lastSeq = engine._streamSeq;

  // SSE /stream：补历史（since_seq 之后）+ 实时增量
  const ctrl = new AbortController();
  const res = await fetch(base + `/stream?since_seq=${lastSeq}`, { headers: hdr, signal: ctrl.signal });
  assert.strictEqual(res.headers.get('content-type')?.includes('text/event-stream'), true);
  const events = [];
  const reader = res.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
      }
    }
  })();

  // POST /chat：操作者 = console 级，命令白名单**不适用**（白名单只约束脚本）；
  // 未在白名单的 /kill 也应原样发出，出站消息入实时流（sender_kind=self）
  const ok = await fetch(base + '/chat', { method: 'POST', headers: hdr, body: JSON.stringify({ text: '/say hi' }) });
  assert.strictEqual(ok.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  const selfEvt = seen.find((e) => e.type === 'chat' && e.sender_kind === 'self');
  assert.ok(selfEvt && selfEvt.text === '/say hi', '出站消息应以 sender_kind=self 进实时流');
  assert.ok(events.some((e) => e.type === 'chat' && e.sender_kind === 'self'), 'SSE 应实时收到出站消息');

  // 操作者命令不受脚本白名单约束：/kill Steve 不在 boundary.chat.commands 里，也必须照发
  const opCmd = await fetch(base + '/chat', { method: 'POST', headers: hdr, body: JSON.stringify({ text: '/kill Steve' }) });
  assert.strictEqual(opCmd.status, 200, '操作者命令不应被脚本白名单拦截');
  assert.ok(driver.outgoingCommands.includes('/kill Steve'), '操作者命令应真的发出去（不受白名单限制）');
  // 空文本仍 400
  const empty = await fetch(base + '/chat', { method: 'POST', headers: hdr, body: JSON.stringify({ text: '   ' }) });
  assert.strictEqual(empty.status, 400);

  // 对照：脚本侧 chat.run_command 仍受 checkChatPolicy（白名单）约束（沙箱边界不变）
  assert.throws(
    () => engine.checkChatPolicy('/kill Steve'),
    (e) => e && e.kind === 'permission.denied',
    '脚本动作路径仍必须过命令白名单',
  );

  // 断线退订：订阅者数量归零（否则监听器泄漏）
  ctrl.abort();
  await pump.catch(() => {});
  unsub();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(engine._streamSubs.size, 0, '断开后实时流订阅必须释放');

  await engine.stop();
});

// ============================================================
// 9. 平台事件入站（/event → events.next）
// ============================================================

test('events：pushEvent 直付等待者、FIFO 排队、空队超时 nil', async () => {
  script('t11.lua', `
    __R_order = nil
    task("evt_loop", { single = true }, function()
      local order = {}
      local ev = events.next(2000)   -- 等待中被直付
      order[#order + 1] = ev and ev.type or "nil"
      time.sleep(50)                 -- 让后续事件入队（无等待者）
      for i = 1, 4 do
        local e = events.next(120)
        order[#order + 1] = e and e.type or "timeout"
      end
      __R_order = table.concat(order, ",")
    end)
    on_start(function() task.spawn("evt_loop") end)
  `);
  const { engine } = await makeEngine({ scripts: ['t11.lua'] });
  assert.ok(await waitFor(() => engine.eventWaiters.length === 1), '事件循环应挂起等待');
  engine.pushEvent('deploy', { k: 42 });
  engine.pushEvent('say', {});
  engine.pushEvent('cmd', {});
  engine.pushEvent('third', {});
  assert.ok(await waitFor(() => g(engine, '__R_order') === 'deploy,say,cmd,third,timeout', 5000),
    `消费序应为 直付+FIFO+超时（实际 ${g(engine, '__R_order')}）`);
  assert.strictEqual(engine.eventQueue.length, 0);
  await engine.stop();
});

// ============================================================
// 10. 断线重连健壮化（TOB-475）
// ============================================================

test('断线缓存失效：entities/windows/world 旧会话数据清空，重连 playing 后自动 resume 不残留', async () => {
  script('t12.lua', `
    __R_ready2 = false
    on_start(function() end)
  `);
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: ['t12.lua'],
    driver,
    runtime: { reconnect: { base_ms: 60, max_ms: 200 } },
  });
  await new Promise((r) => setTimeout(r, 50));
  // 旧会话数据面：实体 / 世界方块 / 容器窗口
  driver.addPlayer('Ghost', { x: 1, y: 64, z: 1 });
  driver.emit('block_update', { pos: { x: 3, y: 64, z: 3 }, name: 'minecraft:chest' });
  driver.emit('window', { id: '42', type: 'chest', title: '旧箱', size: 27, slots: [{ index: 0, item: { id: 'minecraft:dirt', count: 1 } }] });
  assert.ok(engine.entities.size > 0 && engine.world.size > 0 && engine.windows.size > 0, '前置：旧会话缓存已灌入');

  driver.emit('session', { state: 'disconnected', reason: 'server closed' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(engine.paused, true, '断线应自动 pause');
  assert.strictEqual(engine.pauseReason, 'disconnect');
  assert.strictEqual(engine.entities.size, 0, 'entities 旧会话残留应清空');
  assert.strictEqual(engine.windows.size, 0, 'windows 旧会话残留应清空');
  assert.strictEqual(engine.currentWindowId, null, 'currentWindowId 应复位');
  assert.strictEqual(engine.world.size, 0, 'world 旧会话方块观测应清空');
  assert.strictEqual(engine.reconAttempts, 1, '断线应发起第 1 次退避计数');

  // 服务器回来：驱动重连 → playing（全新会话数据；旧玩家已不在）
  driver.removePlayer('Ghost');
  driver.emit('session', { state: 'playing', info: { version: '1.21.8' } });
  driver.addPlayer('Fresh', { x: 9, y: 64, z: 9 });
  assert.strictEqual(engine.reconAttempts, 0, 'playing 后 attempts 应清零');
  assert.strictEqual(engine.paused, false, '重连成功应自动 resume');
  assert.ok(await waitFor(() => engine.entities.size === 1 && [...engine.entities.values()].some((e) => e.name === 'Fresh'), 3000),
    '新会话实体面只含新会话数据');
  await engine.stop();
});

test('重连退避：jitter ±20% 散布、attempts 递增、/state 暴露 reconnecting/attempts/nextRetryIn', async () => {
  // 纯函数分布：base*attempts 封顶 max，±20% 随机散布
  const d1 = Array.from({ length: 200 }, () => BotEngine.backoffDelay(1, 30000, 120000, Math.random));
  assert.ok(d1.every((d) => d >= 24000 && d <= 36000), `attempts=1 应在 24s~36s（见 ${Math.min(...d1)}~${Math.max(...d1)}）`);
  assert.ok(new Set(d1).size > 20, '同 attempts 应呈散布而非固定值');
  const d5 = Array.from({ length: 200 }, () => BotEngine.backoffDelay(5, 30000, 120000, Math.random));
  assert.ok(d5.every((d) => d >= 96000 && d <= 144000), 'attempts=5 应封顶 120s ±20%');

  // 实例路径：attempts 递增 + /state 可观测
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    runtime: { reconnect: { base_ms: 80, max_ms: 300 } },
  });
  await new Promise((r) => setTimeout(r, 30));
  driver.emit('session', { state: 'disconnected', reason: 'x' });
  assert.strictEqual(engine.reconAttempts, 1);
  assert.ok(engine.reconnectDueAt != null, '应记录下次重连时刻');
  // 断线仍在：再触发一次退避计数（模拟连续断线）
  clearTimeout(engine.reconnectTimer);
  engine.reconnectTimer = null;
  engine.scheduleReconnect();
  assert.strictEqual(engine.reconAttempts, 2, '连续断线 attempts 应递增');

  // /state 暴露重连可观测字段
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../httpapi.js');
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const hdr = { Authorization: `Bearer ${token}` };
  const state = await (await fetch(`http://127.0.0.1:${port}/state`, { headers: hdr })).json();
  assert.strictEqual(state.reconnecting, true, '/state.reconnecting 应为 true');
  assert.strictEqual(state.reconnect_attempts, 2);
  assert.ok(Number.isFinite(state.next_retry_in) && state.next_retry_in >= 0, 'next_retry_in 应为非负毫秒');

  // playing 后：attempts 清零、reconnecting false、next_retry_in null
  driver.emit('session', { state: 'playing', info: {} });
  assert.strictEqual(engine.reconAttempts, 0);
  const state2 = await (await fetch(`http://127.0.0.1:${port}/state`, { headers: hdr })).json();
  assert.strictEqual(state2.reconnecting, false);
  assert.strictEqual(state2.next_retry_in, null);
  await engine.stop();
});

test('pause 冻结 timer：on_timer/after/time.sleep 暂停期不触发，resume 恢复且剩余时相保留', async () => {
  script('t13.lua', `
    __R_ticks = 0
    __R_after_ran = false
    __R_sleep_ran = false
    on_timer(50, function() __R_ticks = __R_ticks + 1 end)
    on_start(function()
      after(200, function() __R_after_ran = true end)
      task.spawn(function()
        time.sleep(300)
        __R_sleep_ran = true
      end)
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['t13.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_ticks') >= 2, 3000), 'interval 应在 pause 前正常触发');
  const before = g(engine, '__R_ticks');
  const t0 = Date.now();
  engine.pause('command');
  await new Promise((r) => setTimeout(r, 400));   // 期间 interval 会到点 ~8 次、after(200) 到点、sleep(300) 到点
  assert.strictEqual(g(engine, '__R_ticks'), before, 'pause 期间 on_timer 不得触发');
  assert.strictEqual(g(engine, '__R_after_ran'), false, 'pause 期间 after 不得触发');
  assert.strictEqual(g(engine, '__R_sleep_ran'), false, 'pause 期间 time.sleep 不得完成');
  engine.resume();
  const resumeAt = Date.now();
  assert.ok(await waitFor(() => g(engine, '__R_after_ran') === true, 1000), 'resume 后 after 应触发');
  assert.ok(Date.now() - resumeAt < 200, 'after 冻结的剩余时相应保留（resume 即触发而非重走全程）');
  assert.ok(await waitFor(() => g(engine, '__R_ticks') > before, 1000), 'resume 后 on_timer 应恢复');
  assert.ok(await waitFor(() => g(engine, '__R_sleep_ran') === true, 1000), 'resume 后 sleep 于剩余时相到期完成');
  await engine.stop();
});

test('after 触发后不重放：自然触发完的 after/sleep 经任意次 pause→resume 不得重执行，timerSpecs 台账有界', async () => {
  script('t14.lua', `
    __S_after_n = 0
    __S_sleep_n = 0
    on_start(function()
      after(80, function() __S_after_n = __S_after_n + 1 end)
      task.spawn(function()
        time.sleep(100)
        __S_sleep_n = __S_sleep_n + 1
      end)
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['t14.lua'] });
  assert.ok(await waitFor(() => g(engine, '__S_after_n') === 1 && g(engine, '__S_sleep_n') === 1, 3000),
    '前置：after/sleep 自然触发各一次');
  assert.strictEqual(engine.timerSpecs.size, 0, '已完成的一次性 spec 应从台账移除');
  for (let i = 0; i < 3; i++) {
    engine.pause('command');
    await new Promise((r) => setTimeout(r, 120));
    engine.resume();
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.strictEqual(g(engine, '__S_after_n'), 1, '已触发过的 after 经 pause→resume 不得重放');
  assert.strictEqual(g(engine, '__S_sleep_n'), 1, '已完成的 sleep 不得重放');
  assert.strictEqual(engine.timerSpecs.size, 0, 'resume 不得重挂 stale spec');
  await engine.stop();
});

// ============================================================
// 11. 会话凭据更新（TOB-489 POST /session）
// ============================================================

const SESSION_ACCOUNT = { auth: 'session', username: 'BotOne', uuid: '00000000-0000-0000-0000-0000000000f1', accessToken: 'old-token-DO-NOT-LEAK' };

test('POST /session：鉴权 401、方法 405、参数 400、非 session 账号 409、身份不匹配 409', async () => {
  // 非 session 账号（offline）：account_mode 409
  const driver = new MockDriver();
  const { engine: offlineEngine } = await makeEngine({
    scripts: [],
    driver,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { username: 'OfflineBot' } } },
  });
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../httpapi.js');
  const { port, token } = await startHttpApi(offlineEngine, { log: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  assert.strictEqual((await fetch(base + '/session', { method: 'POST', body: '{"access_token":"x"}' })).status, 401, '无 token 401');
  assert.strictEqual(
    (await fetch(base + '/session', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{"access_token":"x"}' })).status,
    401, '错 token 401',
  );
  assert.strictEqual((await fetch(base + '/session', { headers: hdr })).status, 405, 'GET 应 405');
  const r409res = await fetch(base + '/session', { method: 'POST', headers: hdr, body: '{"access_token":"x"}' });
  assert.strictEqual(r409res.status, 409, 'offline 账号应 409');
  assert.strictEqual((await r409res.json()).error, 'session.account_mode');
  await offlineEngine.stop();

  // session 账号：参数与身份校验
  const driver2 = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver: driver2,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { ...SESSION_ACCOUNT } } },
  });
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const api2 = await startHttpApi(engine, { log: () => {} });
  const base2 = `http://127.0.0.1:${api2.port}`;
  const hdr2 = { Authorization: `Bearer ${api2.token}`, 'Content-Type': 'application/json' };

  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{}' })).status, 400, '缺 access_token 应 400');
  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":""}' })).status, 400, '空串应 400');
  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":42}' })).status, 400, '非字符串应 400');
  const rMis = await (await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":"x","username":"Wrong"}' })).json();
  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":"x","username":"Wrong"}' })).status, 409, 'username 不匹配应 409');
  assert.strictEqual(rMis.error, 'session.identity_mismatch');
  assert.strictEqual(
    (await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: `{"access_token":"x","uuid":"ffffffff-0000-0000-0000-000000000000"}` })).status,
    409, 'uuid 不匹配应 409',
  );
  assert.strictEqual(engine.connectCfg.account.accessToken, SESSION_ACCOUNT.accessToken, '被拒请求不得改写凭据');
  await engine.stop();
});

test('POST /session：写入 connectCfg、幂等 200、生效语义 playing=next_connect / 断线=next_reconnect、不重置退避', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { ...SESSION_ACCOUNT } } },
    runtime: { reconnect: { base_ms: 100, max_ms: 200 } },
  });
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../httpapi.js');
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = (body) => fetch(base + '/session', { method: 'POST', headers: hdr, body: JSON.stringify(body) });

  assert.strictEqual(engine.sessionState, 'playing', '前置：MockDriver 连接后 playing');
  assert.strictEqual((await (await post({ access_token: 'new-token-a' })).json()).applied, true);
  assert.strictEqual(engine.connectCfg.account.accessToken, 'new-token-a', '凭据应写入 connectCfg.account.accessToken');

  // 幂等：同值重复 POST 仍 200
  assert.strictEqual((await post({ access_token: 'new-token-a' })).status, 200, '同值重复 POST 应 200');

  // playing 态：在线连接零动作 + effective=next_connect
  const rPlay = await (await post({ access_token: 'new-token-b' })).json();
  assert.strictEqual(rPlay.effective, 'next_connect', 'playing 态应报 next_connect');
  assert.strictEqual(engine.sessionState, 'playing', '更新凭据不得打断在线连接');

  // /state：credential_updated_at 更新且不含 token 明文
  const state = await (await fetch(base + '/state', { headers: hdr })).json();
  assert.ok(Number.isFinite(state.credential_updated_at) && state.credential_updated_at > 0, 'credential_updated_at 应为时间戳');
  assert.ok(state.credential_updated_at <= Date.now());
  assert.ok(!JSON.stringify(state).includes('new-token'), '/state 不得泄露 token 明文');

  // 断线退避中：effective=next_reconnect，且不重置退避计数与在途计划
  driver.emit('session', { state: 'disconnected', reason: 'x' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(engine.reconAttempts, 1);
  const dueBefore = engine.reconnectDueAt;
  const rDisc = await (await post({ access_token: 'new-token-c' })).json();
  assert.strictEqual(rDisc.effective, 'next_reconnect', '断线态应报 next_reconnect');
  assert.strictEqual(engine.reconAttempts, 1, 'POST /session 不得重置退避计数');
  assert.strictEqual(engine.reconnectDueAt, dueBefore, 'POST /session 不得打断在途重连计划');
  assert.strictEqual(engine.connectCfg.account.accessToken, 'new-token-c');

  // 下一次重连即用新 token：记录驱动收到的 cfg
  const seen = [];
  const origConnect = driver.connect.bind(driver);
  driver.connect = async (cfg) => { seen.push(cfg?.account?.accessToken); return origConnect(cfg); };
  assert.ok(await waitFor(() => seen.length >= 1, 3000), '退避到期应发起重连');
  assert.strictEqual(seen[0], 'new-token-c', '重连必须使用新 accessToken 而非旧值');
  await engine.stop();
});

test('POST /session：日志与 /state 全程无 token 明文', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { ...SESSION_ACCOUNT } } },
  });
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../httpapi.js');
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const SECRET = 'super-secret-token-xyz';
  await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: hdr, body: JSON.stringify({ access_token: SECRET }) });
  const logs = (await (await fetch(`http://127.0.0.1:${port}/logs`, { headers: hdr })).json());
  const all = JSON.stringify(logs) + JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/state`, { headers: hdr })).json());
  assert.ok(!all.includes(SECRET), '日志与 /state 不得出现 token 明文');
  assert.ok(!all.includes(SESSION_ACCOUNT.accessToken), '旧 token 明文同样不得出现');
  await engine.stop();
});

// ============================================================
// 12. 收款判定（TOB-522：username 暴露 + params 校验钩 + transfer 结构化上报）
// ============================================================

test('self.username：driver 最小暴露，params_validator 校验钩拒绝非法值、旧值生效', async () => {
  script('t14.lua', `
    __R_username = nil
    task('getname', function()
      wait_until(function() return self.username() ~= nil end)
      __R_username = self.username()
    end)
    on_start(function() task.spawn('getname') end)
    params_validator('pat', function(v)
      if tostring(v):find('BAD', 1, true) then return nil, '拒绝：含 BAD' end
      return true
    end)
  `);
  const driver = new MockDriver({ username: 'RelayBot' });
  const { engine } = await makeEngine({
    scripts: ['t14.lua'],
    driver,
    yaml: { params: { pat: { type: 'string', default: 'safe-old' }, other: { type: 'string', default: '' } } },
  });
  assert.ok(await waitFor(() => g(engine, '__R_username') === 'RelayBot', 3000), 'self.username 应来自 driver 快照');

  // 校验钩：拒绝 + 错误可读 + 旧值继续生效
  try {
    engine.setParam('pat', 'xBADx');
    assert.fail('非法值应被拒绝');
  } catch (e) {
    assert.strictEqual(e.kind, 'param.rejected');
    assert.ok(String(e.detail).includes('BAD'), '错误信息应可读');
  }
  assert.strictEqual(engine.paramValues.get('pat'), 'safe-old', '被拒后旧值继续生效');
  engine.setParam('pat', 'good-new');
  assert.strictEqual(engine.paramValues.get('pat'), 'good-new', '合法值正常落参');

  // 未注册校验钩的参数不受影响；未知参数仍拒（TYPE_ERR 抛的是普通对象，按 kind 断言）
  engine.setParam('other', 'v');
  assert.strictEqual(engine.paramValues.get('other'), 'v');
  try {
    engine.setParam('ghost', 1);
    assert.fail('未知参数应被拒绝');
  } catch (e) {
    assert.strictEqual(e.kind, 'param.unknown');
  }
  await engine.stop();
});

test('afk_guard relay：收款/指令/原文经宿主事件通道上报 + 接收门锚定自身用户名 + pattern 热更校验', async () => {
  const events = [];
  const driver = new MockDriver({ username: 'RelayBot' });
  const engine = new BotEngine({
    name: 'afk-relay-test',
    scripts: [path.join(EXAMPLES, 'afk_guard', 'relay.lua')],
    params: {
      bot_name: '',   // 默认去锚定：空 = 锚定 bot 自身用户名
      // 清单形态（带 type）：进 schema 校验面，/params 热更与校验钩可用
      transfer_pattern: { type: 'string', default: '你收到了来自 (%S+) 的 ([%d%.]+) C' },
    },
  }, driver, { scriptDir: path.join(EXAMPLES, 'afk_guard') });
  engine.subscribeStream((evt) => { if (evt.type === 'event') events.push(evt); });
  await engine.start();
  await new Promise((r) => setTimeout(r, 80));

  const sysChat = (raw) => driver.emit('chat', { text: '', raw, sender: null, sender_kind: 'system', ts: Date.now() });
  const of = (name) => events.filter((e) => e.name === name);

  // 默认参数部署（零手改）：bot 收自身用户名款项 → emit pay 事件
  sysChat('[TSLLLLL] 你收到了来自 Steve 的 12.5 C');
  assert.ok(await waitFor(() => of('pay').length === 1, 3000), '默认参数应产生 pay 事件');
  assert.strictEqual(of('pay')[0].data.payer, 'Steve');
  assert.strictEqual(of('pay')[0].data.amount, 12.5);
  assert.ok(of('chat_line').some((e) => e.data.raw.includes('你收到了来自 Steve')), 'chat_line 原文照旧上报');

  // 接收门默认锚定自身用户名：发给 RelayBot 的私聊上报 tsl_cmd；发给别人不上报
  sysChat('[Alice x RelayBot] 余额');
  assert.ok(await waitFor(() => of('tsl_cmd').some((e) => e.data.player === 'Alice'), 3000),
    '接收门空参数应锚定自身用户名');
  const tslCount = of('tsl_cmd').length;
  sysChat('[Alice x OtherBot] 余额');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(of('tsl_cmd').length, tslCount, '非本 bot 私聊不应上报');

  // pattern 热更校验：非法拒绝、错误可读、旧值继续生效
  const badPatterns = [
    ['x'.repeat(300), '过长'],
    ['你收到了来自 (%S+ 的 ([%d%.]+) C', '语法'],
    ['(%S+) (%S+) (%S+)', '捕获'],
  ];
  for (const [p, why] of badPatterns) {
    try {
      engine.setParam('transfer_pattern', p);
      assert.fail(`非法 pattern（${why}）应被拒绝`);
    } catch (e) {
      assert.strictEqual(e.kind, 'param.rejected', `${why} 拒绝应 param.rejected`);
      assert.ok(String(e.detail).length > 0, `${why} 错误信息应可读`);
    }
  }
  assert.strictEqual(engine.paramValues.get('transfer_pattern'), '你收到了来自 (%S+) 的 ([%d%.]+) C',
    '被拒后旧 pattern 继续生效');
  sysChat('[TSLLLLL] 你收到了来自 Bob 的 3 C');
  assert.ok(await waitFor(() => of('pay').length === 2, 3000), '被拒热更后旧 pattern 仍工作');

  // 合法热更即时生效：换格式后新格式命中、旧格式不再命中
  engine.setParam('transfer_pattern', '(%S+) 给 RelayBot 转了 ([%d%.]+) 金');
  sysChat('Bob 给 RelayBot 转了 3 金');
  assert.ok(await waitFor(() => of('pay').length === 3, 3000), '热更 pattern 即时生效');
  assert.strictEqual(of('pay')[2].data.payer, 'Bob');
  assert.strictEqual(of('pay')[2].data.amount, 3);
  sysChat('[TSLLLLL] 你收到了来自 Steve 的 12.5 C');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(of('pay').length, 3, '旧格式不再命中');

  // 重启保留（paramPersist）
  assert.strictEqual(engine.paramPersist.get('transfer_pattern'), '(%S+) 给 RelayBot 转了 ([%d%.]+) 金');

  // 空 pattern = 关闭收款判定（合法值）
  engine.setParam('transfer_pattern', '');
  sysChat('Bob 给 RelayBot 转了 9 金');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(of('pay').length, 3, '空 pattern 应关闭收款判定');

  await engine.stop();
});

test('events.emit：上行事件进入实时流 event 环，可按 seq 补读', async () => {
  script('emit.lua', `
    on_start(function()
      task.spawn(function()
        events.emit("hello", { n = 1 })
        time.sleep(10)
        events.emit("hello", { n = 2 })
      end)
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['emit.lua'] });
  await waitFor(() => engine.ringSince('event', 0).filter((e) => e.name === 'hello').length >= 2, 3000);
  const rows = engine.ringSince('event', 0).filter((e) => e.name === 'hello');
  assert.equal(rows[0].data.n, 1);
  assert.equal(rows[1].data.n, 2);
  assert.ok(rows.every((r) => typeof r.seq === 'number' && r.type === 'event'), '应带单调 seq 与 type');
  await engine.stop();
});


// ============================================================
// 驱动边界单位换算（Lua/引擎约定「度」，mineflayer 原生「弧度」）

test('mineflayer 驱动：look 角度按度进、按弧度出；self 上报回度', async () => {
  const { degToRad, radToDeg } = await import('../../drivers/mineflayer/units.js');
  assert.equal(degToRad(-90), -Math.PI / 2, 'look.yaw(-90°) 应换算为 -π/2 弧度');
  assert.equal(degToRad(180), Math.PI);
  assert.equal(degToRad(null), null, '缺省轴保持 null（look 回退到当前值）');
  assert.equal(degToRad(undefined), undefined);
  assert.equal(radToDeg(Math.PI), 180);
  assert.equal(radToDeg(-Math.PI / 2), -90);
});

// 断线可读性（2026-11-15 实测）：mineflayer 的 kicked/end 理由是 chat 组件或 JSON 文本，
// 原样 String() 只会给运维一坨裸 JSON，而 EPIPE 只是「对端关闭」的传输层表现、不含业务信息。
test('断线：踢出理由解析成可读文本（字符串/chat 组件/JSON 文本三种形态）', async () => {
  const { reasonText } = await import('../../drivers/mineflayer/reason.js');
  assert.equal(reasonText('{"color":"red","text":"You are banned from this server"}'),
    'You are banned from this server', 'JSON 文本应取出 text 段');
  assert.equal(reasonText({ text: 'Kicked: ', extra: [{ text: 'flying is not enabled' }] }),
    'Kicked: flying is not enabled', '组件对象应拼接 extra');
  assert.equal(reasonText('plain reason'), 'plain reason', '纯文本原样返回');
  assert.equal(reasonText(null), '');
  assert.equal(reasonText(''), '');
  assert.equal(reasonText('{"not":"json at all"'), '{"not":"json at all"', '非法 JSON 不丢原文');
  // kick_disconnect 的 reason 是 anonymousNbt —— 不处理就会输出 [object Object]，
  // 而这恰恰是服务器明确说明踢出原因的那条信息
  assert.equal(
    reasonText({ type: 'compound', name: '', value: { text: { type: 'string', value: 'You are not white-listed on this server' } } }),
    'You are not white-listed on this server',
    'NBT compound（kick 包的真实形态）应简化成可读文本');
  assert.equal(
    reasonText({
      type: 'compound', name: '', value: {
        text: { type: 'string', value: 'Kicked: ' },
        extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'flying is not enabled' } }] } },
      },
    }),
    'Kicked: flying is not enabled',
    'NBT 里套 extra 列表也应展开');
  assert.ok(!reasonText({ type: 'compound', name: '', value: {} }).includes('[object Object]'),
    '无法解析时也不得输出 [object Object]（至少给出字段名）');
});

test('断线：连接关闭后动作动词不再写包（防 EPIPE 刷屏）', async () => {
  const { MineflayerDriver } = await import('../../drivers/mineflayer/index.js');
  const d = new MineflayerDriver({ log: () => {} });
  // 未连接（alive=false）时，动作应静默返回而不是往死 socket 写
  d.alive = false;
  d.bot = { entity: { yaw: 0, pitch: 0 }, chat: () => { throw new Error('不该写包'); },
            setControlState: () => { throw new Error('不该写包'); },
            look: async () => { throw new Error('不该写包'); },
            _client: { socket: { destroyed: true } } };
  await d.chat_send('hi');
  await d.rot(90, 0);
  await d.hop();
  await d.move_input({ fwd: true });
  const r = await d.path_to({ x: 0, y: 0, z: 0 });
  assert.deepEqual(r, { ok: false, reason: 'disconnected' }, '寻路应直接失败而不是挂起');
});

// 瞄准发包频率（2026-11-15 实测事故）：服务器踢人理由是
// multiplayer.disconnect.invalid_player_movement —— 移动/视角包发得太频繁。
// 原版客户端每 tick 最多发一个 looking 包；bslib.look.at 原先分别调用 look.yaw +
// look.pitch，等于每轮两个包，20Hz 瞄准就是 40 包/秒，必被踢。
test('bslib.look.at 单轮只发一个视角包（避免 invalid_player_movement 踢人）', async () => {
  script('aim_rate.lua', `
    on_start(function()
      task.spawn(function()
        time.sleep(50)                      -- 等实体缓存就绪
        bslib.look.at({ pos = { x = 5, y = 64, z = 0 } })
        time.sleep(50)
        bslib.look.at({ pos = { x = 0, y = 64, z = 3 } })
        time.sleep(50)
        __R_done = true
      end)
    end)
  `);
  const { engine, driver } = await makeEngine({ scripts: ['aim_rate.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_done') === true), '瞄准场景未跑完');
  // 两次 look.at → 恰好两次 rot；旧实现会是 4 次
  assert.equal(driver.rotCalls, 2, `两轮瞄准应只发 2 个视角包（实际 ${driver.rotCalls}）`);
  // 且两轴同包生效：第二次瞄准的目标在 +Z，yaw 应约为 0
  assert.ok(Math.abs(driver.botYaw) < 2, `朝 +Z 的目标 yaw 应约为 0，实际 ${driver.botYaw}`);
  assert.ok(Number.isFinite(driver.botPitch), `pitch 应被写入（实际 ${driver.botPitch}）`);
  await engine.stop();
});

// 视角限速（2026-11-15 实测事故）：服务器踢人理由始终是
// multiplayer.disconnect.invalid_player_movement。上一版把每轮 2 个包降到 1 个后仍被踢，
// 真正原因在 mineflayer 的 force 语义：
//   bot.look(yaw, pitch, true)  // force=true → 直接 lastSentYaw = yaw，绕过 maxDeltaYaw 限速
// 即允许客户端一个 tick 内把视角瞬移到任意角度，原版客户端受鼠标灵敏度约束做不到，
// 服务端反作弊据此判定非法移动。驱动必须用 force=false，让视角以 yawSpeed 逐步逼近。
//
    test('驱动 rot：不得使用 force=true（会绕过 mineflayer 视角限速，被判 invalid_player_movement）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../drivers/mineflayer/index.js', import.meta.url), 'utf8');
  const rotBody = src.slice(src.indexOf('async rot(yaw, pitch)'), src.indexOf('async hop()'));
  assert.ok(rotBody.includes('false'), 'rot 的 bot.look 第三个参数应为 false（限速插值）');
  assert.ok(!/bot\.look\([\s\S]*?true,?\s*\)/.test(rotBody),
    'rot 不得传 force=true：它会直接把 lastSentYaw 赋成目标值，绕过限速');
});

// 协议数据表（2026-11-15 实测事故）：mc.zenoxs.cn 下发的是带 dx/dy/dz + f32 角度 + u32 flags
// 的 entity_teleport。minecraft-data 3.116.0 对同一协议给出旧布局（i8 角度），导致 play 阶段
// 逐包「Chunk size is 67 but only 33 was read」，三秒后 EPIPE。3.119.0 起定义才正确。
// 这条测试用线上真实帧验证：必须整包读完，角度必须是合理值。数据表被降级就会红。
test('协议数据表：entity_teleport 真实帧必须整包读完（防止 minecraft-data 回退）', async () => {
  const mcMod = await import('minecraft-protocol');
  const mc = mcMod.default ?? mcMod;
  const FRAME = Buffer.from(
    '769df2e89f0440eb5a854031842e4051e0000000000040eb590f8a11f3df000000000000000000000000000000000000000000000000'
    + '42b1d14c4142ac200000000000', 'hex');

  // 1) 数据表门槛：26.1 的 entity_teleport 必须带 dx 字段（旧表没有）
  const mcdMod = await import('minecraft-data');
  const mcd = mcdMod.default ?? mcdMod;
  const def = mcd('26.1').protocol.play.toClient.types.packet_entity_teleport;
  const fields = def[1].filter((x) => x.name !== 'name').map((x) => x.name);
  assert.ok(fields.includes('dx'),
    '26.1 的 entity_teleport 应含 dx（实际：' + fields.join(',') + '）'
    + '；缺它说明 minecraft-data 版本过旧，play 阶段会报 partial packet');

  // 2) 端到端：真实 deserializer 吃线上帧，必须恰好读完且数值合理
  const d = mc.createDeserializer({ state: 'play', isServer: false, version: '1.21.8', noErrorLogging: true });
  let pkt = null;
  d.on('data', (p) => { pkt = p; });
  d.write(FRAME);
  assert.ok(pkt, '真实帧应能被解析出包');
  assert.equal(pkt.metadata.size, FRAME.length,
    '应整包读完（' + pkt.metadata.size + '/' + FRAME.length + '）'
    + '；读少了就是线上那句「Chunk size is 67 but only 33 was read」');
  const params = pkt.data.params;
  assert.equal(params.x, 56020.164086111225);
  assert.ok(Math.abs(params.yaw - 88.91) < 0.05, 'yaw 应约 88.91°，实际 ' + params.yaw);
  assert.ok(Math.abs(params.pitch - 12.17) < 0.05, 'pitch 应约 12.17°，实际 ' + params.pitch);
});

test('协议诊断：环形缓冲常开、只在断线时倒出（用户无需配环境变量）', async () => {
  const tr = await import('../../drivers/mineflayer/protocolTrace.js');
  // 默认非 verbose —— 不实时刷日志，只进环形缓冲
  assert.equal(tr.traceVerbose({}), false, '默认非 verbose（零噪音）');
  assert.equal(tr.traceVerbose({ BOTSCRIPT_PROTO_TRACE: '1' }), true, '可用环境变量切 verbose');

  // 无 _client 时安全：返回 flush/off 两个空函数
  const noClient = tr.installProtocolTrace({}, () => {});
  assert.equal(typeof noClient.flush, 'function');
  assert.equal(typeof noClient.off, 'function');
  assert.doesNotThrow(() => noClient.flush('x'));
  assert.doesNotThrow(() => noClient.off());

  // 有 _client 时：平时不输出，flush 时一次性倒出缓冲内容
  const lines = [];
  const writes = [];
  const handlers = {};
  const fakeBot = { _client: {
    write(name, p) { writes.push(name); },
    on(evt, fn) { handlers[evt] = fn; },
    removeListener(evt) { delete handlers[evt]; },
  } };
  const t = tr.installProtocolTrace(fakeBot, (l) => lines.push(l));
  // 模拟发包 + 服务端下发 position
  t.flush; // noop
  fakeBot._client.write('teleport_confirm', { teleportId: 7 });
  // 注：installProtocolTrace 内部已包装 write，这里用其包装后的路径
  assert.equal(lines.length, 0, '未断线时不得输出任何日志（零噪音）');
  assert.equal(writes.length, 1, '包装后仍会真正发包');
  t.flush('kicked: invalid_player_movement');
  assert.ok(lines.length > 0, '断线时应倒出缓冲');
  assert.ok(lines.some((l) => l.includes('断线诊断')), '应带明确标题');
  t.flush('again');   // 重复 flush 不应再输出
  const after = lines.length;
  t.flush('again2');
  assert.equal(lines.length, after, 'flush 幂等');
  t.off();
});

// tick_end 发送（2026-11-16 红绿测确认的 invalid_player_movement 根因）
//
// 26.3 服务端：
//   handleMovePlayer: if (hasPosition() && receivedPositionThisTick) → disconnect(invalid_player_movement)
//   receivedPositionThisTick 的唯一重置点在 handleClientTickEnd(ServerboundClientTickEndPacket)
// 即：客户端必须每 tick 发 `client_tick_end`（空载荷、minecraft-data 里名 tick_end，ID 0x0c），
// 服务端收到才清零「本 tick 已收到位置包」。原版客户端照发；mineflayer 从不发（整库 0 处引用）
// → 计数永不清零 → 第二个带坐标包被踢（线上每 1.2 秒一次）。
//
// 本地红绿测（Paper 26.3 + Via）：不发 1.2s 被踢 / 每 tick 发 → 存活 17.2s；
// 纯净 1.21.8 发与不发均存活（无回归）。
test('tick_end 守卫：同一 tick 的多个移动包被延后到下一 tick（不丢弃、取最新坐标）', async () => {
  const { installTickEndSender } = await import('../../drivers/mineflayer/tickEnd.js');
  const calls = [];
  const fakeBot = { _client: { write(name, params) { calls.push({ name, params, at: Date.now() }); } } };
  const sender = installTickEndSender(fakeBot, { tickMs: 60 });
  const w = fakeBot._client.write;

  // 模拟 physics catch-up：同一毫秒连发 4 个位置包（线上实测形态，y 递减表示下落中）
  const t0 = Date.now();
  let blocked = 0;
  for (const dy of [0, -0.005, -0.014, -0.026]) {
    if (w('position', { x: 1, y: 64 + dy, z: 3, flags: {} }) === undefined) blocked += 1;
  }
  assert.ok(blocked >= 3, `同 tick 的后续位置包应被延后，实际拦截 ${blocked}/4`);

  await new Promise((r) => setTimeout(r, 250));
  const positions = calls.filter((c) => c.name === 'position');
  assert.ok(positions.length >= 2, `延后的位置包必须补发（不丢弃），实际 ${positions.length}`);
  for (const c of positions.slice(1)) {
    assert.ok(c.at - t0 >= 55, `补发包应在下一 tick（间隔 ${c.at - t0}ms）`);
  }
  const last = positions[positions.length - 1];
  assert.equal(Math.round(last.params.y * 1000) / 1000, 63.974,
    `应补发最新坐标（后到者覆盖前一个），实际 ${last.params.y}`);
  assert.ok(sender.stats().deferred >= 3, 'deferred 统计应反映延后次数');
  sender.stop();
});

test('tick_end 守卫：非移动包立即透传（chat 等不受节拍影响）', async () => {
  const { installTickEndSender } = await import('../../drivers/mineflayer/tickEnd.js');
  const calls = [];
  const fakeBot = { _client: { write(name) { calls.push(name); } } };
  const sender = installTickEndSender(fakeBot, { tickMs: 60 });
  const w = fakeBot._client.write;

  w('chat_send', { text: 'hi' });
  w('arm_animation', {});
  // 非移动包应立即写到底层（不需要等 tick）；过滤掉周期性 tick_end
  assert.deepEqual(calls.filter((n) => n !== 'tick_end'), ['chat_send', 'arm_animation'],
    '非移动包应立即写出（不排队）');
  sender.stop();
});

test('tick_end：按固定节拍每 tick 发送（补上原版客户端固有行为）', async () => {
  const { installTickEndSender } = await import('../../drivers/mineflayer/tickEnd.js');
  const calls = [];
  const fakeBot = { _client: { write(name, params) { calls.push(name); } } };

  const sender = installTickEndSender(fakeBot, { tickMs: 200 });
  await new Promise((r) => setTimeout(r, 650));   // 约 3 拍
  sender.stop();

  assert.ok(calls.length >= 2, `应至少发送 2 次，实际 ${calls.length}`);
  assert.ok(calls.every((n) => n === 'tick_end'), `只应发 tick_end，实际 ${calls.join(',')}`);
  assert.equal(sender.stats().sent, calls.length, 'stats 应反映实际发送次数');
});

test('tick_end：stop 后不再发送；无 _client 时安全', async () => {
  const { installTickEndSender } = await import('../../drivers/mineflayer/tickEnd.js');
  const calls = [];
  const fakeBot = { _client: { write(name) { calls.push(name); } } };
  const sender = installTickEndSender(fakeBot, { tickMs: 100 });
  await new Promise((r) => setTimeout(r, 250));
  sender.stop();
  const after = calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.length, after, 'stop 之后不得再发送');

  // 无 _client（建连失败场景）不应抛错
  const empty = installTickEndSender({}, { tickMs: 100 });
  assert.equal(empty.stats().sent, 0);
  assert.doesNotThrow(() => empty.stop());
});

// ============================================================

const started = Date.now();
let failed = 0;
for (const [name, fn] of tests) {
  process.stdout.write(`· ${name}\n`);
  try {
    await fn();
    console.log(`  PASS (${((Date.now() - started) / 1000).toFixed(1)}s 累计)`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${e.message}`);
  }
}
rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? `\n全部 ${tests.length} 项通过` : `\n${failed}/${tests.length} 项失败`);
process.exit(failed === 0 ? 0 : 1);
