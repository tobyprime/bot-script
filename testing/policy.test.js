// testing/policy.test.js — 授权边界 / 速率 / 聊天策略 / 参数（ABI v2：无命令体系）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

test('默认开放：无 boundary 时动作不被拒，查询与 params 可用', async () => {
  script('t8.lua', `
    __R_nav_err = nil
    __R_dig_err = nil
    task("mover", function()
      local ok, err = pcall(function() nav.hop() end)
      if not ok and type(err) == "table" then __R_nav_err = err.kind end
      local ok2, err2 = pcall(function() combat.dig({ x = 1, y = 64, z = 1 }) end)
      if not ok2 and type(err2) == "table" then __R_dig_err = err2.kind end
    end)
    on_start(function() task.spawn("mover") end)
  `);
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: ['t8.lua'], driver, boundary: null });
  await waitFor(() => engine.actionLog.some((a) => a.action === 'act.dig'), 5000);
  assert.ok(!g(engine, '__R_nav_err'), '无 boundary：移动默认允许');
  assert.ok(!g(engine, '__R_dig_err'), '无 boundary：挖掘默认允许');
  assert.ok(engine.actionLog.some((a) => a.action === 'act.dig'), '默认允许时必须真的发出挖掘动作');
  assert.ok(engine.selfState.pos(), '查询数据面可用');
  await engine.stop();
});

test('boundary 安全边界：allow_move=false 同时禁用移动与寻路；停走不受影响', async () => {
  script('t-move.lua', `
    __R_nav_err = nil
    __R_move_err = nil
    task("mover", function()
      local r = nav.walk({ x = 30, y = 64, z = 30 }, { timeout = 5 })
      if not r.ok then __R_nav_err = r.error.code end
      local r2 = nav.hop()
      if r2 and not r2.ok then __R_move_err = r2.error.code end
      -- 停走必须始终放行（pause/急停路径）
      __R_stop_ok = nav.stop().ok
    end)
    on_start(function() task.spawn("mover") end)
  `);
  const { engine } = await makeEngine({ scripts: ['t-move.lua'], boundary: { allow_move: false } });
  assert.ok(await waitFor(() => g(engine, '__R_move_err') != null, 5000), 'hop 应被拒');
  assert.strictEqual(g(engine, '__R_move_err'), 'policy.blocklist', 'allow_move=false：hop 必须 policy.blocklist');
  assert.strictEqual(g(engine, '__R_nav_err'), 'policy.blocklist', 'allow_move=false：nav 必须 policy.blocklist');
  assert.strictEqual(g(engine, '__R_stop_ok'), true, '停走不受 allow_move 门控');
  await engine.stop();

  script('t-move2.lua', `
    __R_move_err = nil
    task("mover", function()
      local r = nav.hop()
      if r and not r.ok then __R_move_err = r.error.code end
    end)
    on_start(function() task.spawn("mover") end)
  `);
  const { engine: e2 } = await makeEngine({ scripts: ['t-move2.lua'], boundary: {} });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!g(e2, '__R_move_err'), '未配置 allow_move 时 hop 不应被拒');
  await e2.stop();
});

test('boundary 发包速率：rate.actions_per_sec 超限返回 Result 拒绝，未配置不限', async () => {
  script('t-rate.lua', `
    __R_errs = 0
    __R_ok = 0
    task("spam", function()
      for i = 1, 30 do
        local r = combat.use_block({ x = 1, y = 64, z = 1 })
        if r and r.ok then __R_ok = __R_ok + 1 else __R_errs = __R_errs + 1 end
      end
    end)
    on_start(function() task.spawn("spam") end)
  `);
  const { engine } = await makeEngine({ scripts: ['t-rate.lua'], boundary: { rate: { actions_per_sec: 10 } } });
  await waitFor(() => (g(engine, '__R_ok') ?? 0) + (g(engine, '__R_errs') ?? 0) >= 30, 5000);
  const ok = g(engine, '__R_ok') ?? 0;
  const errs = g(engine, '__R_errs') ?? 0;
  assert.ok(errs > 0, `超过 10/s 应被拒，实际 ok=${ok} errs=${errs}`);
  assert.ok(ok <= 14, `1 秒内最多放行 ~10 个（含边界容忍/计时抖动），实际 ${ok}`);
  await engine.stop();

  script('t-rate2.lua', `
    __R_ok = 0
    task("spam", function()
      for i = 1, 30 do
        local r = combat.use_block({ x = 1, y = 64, z = 1 })
        if r and r.ok then __R_ok = __R_ok + 1 end
      end
    end)
    on_start(function() task.spawn("spam") end)
  `);
  const { engine: e2 } = await makeEngine({ scripts: ['t-rate2.lua'], boundary: {} });
  await waitFor(() => g(e2, '__R_ok') === 30, 10_000);
  assert.strictEqual(g(e2, '__R_ok'), 30, '未配置速率时不得限流');
  await e2.stop();
});

test('聊天策略：命令白名单/正则黑白名单/say 限速（命令体系已移除，只剩发包门控）', async () => {
  script('t-chat.lua', `
    __R_pay = nil
    __R_gm = nil
    __R_msg = nil
    __R_say = nil
    task("runner", function()
      local function label(r) return (r and r.ok) and "ok" or (r and r.error and r.error.code or "err") end
      __R_pay = label(chat.run_command("/pay Steve 100"))
      __R_gm = label(chat.run_command("/gamemode creative"))
      __R_msg = label(chat.run_command("/msg Steve hi"))
      __R_say = label(chat.say("hello"))
    end)
    on_start(function() task.spawn("runner") end)
  `);
  const boundary = {
    chat: {
      commands: ['/pay', '/gamemode', '/msg'],
      commands_deny: ['^/gamemode\\s+creative'],
      say_rate: '2/min',
    },
  };
  const { engine, driver } = await makeEngine({ scripts: ['t-chat.lua'], boundary });
  assert.ok(await waitFor(() => g(engine, '__R_say') != null, 5000), '场景应跑完');
  assert.strictEqual(g(engine, '__R_pay'), 'ok', '/pay 应放行');
  assert.strictEqual(g(engine, '__R_gm'), 'permission.denied', '/gamemode creative 应被黑名单拒绝');
  assert.strictEqual(g(engine, '__R_msg'), 'ok', '/msg 应放行');
  assert.strictEqual(g(engine, '__R_say'), 'ok', '首条 say 应在限速内');
  assert.ok(driver.outgoingCommands.includes('/pay Steve 100'), '命令应真的发包');
  await engine.stop();

  script('t-chat2.lua', `
    __R_msg = nil
    __R_pay = nil
    __R_gm = nil
    task("runner", function()
      local function label(r) return (r and r.ok) and "ok" or (r and r.error and r.error.code or "err") end
      for _, cmd in ipairs({ "/pay Steve 100", "/gamemode creative", "/msg Steve hi" }) do
        local v = label(chat.run_command(cmd))
        if cmd == "/pay Steve 100" then __R_pay = v end
        if cmd == "/gamemode creative" then __R_gm = v end
        if cmd == "/msg Steve hi" then __R_msg = v end
      end
    end)
    on_start(function() task.spawn("runner") end)
  `);
  const { engine: e2 } = await makeEngine({
    scripts: ['t-chat2.lua'],
    boundary: { chat: { commands: ['/pay', '/gamemode', '/msg'], commands_allow: ['^/msg\\s+Steve'] } },
  });
  await waitFor(() => g(e2, '__R_msg') != null, 5000);
  assert.strictEqual(g(e2, '__R_msg'), 'ok', '/msg Steve 命中 allow 应放行');
  assert.strictEqual(g(e2, '__R_pay'), 'permission.denied', '/pay 未命中 allow 应拒');
  assert.strictEqual(g(e2, '__R_gm'), 'permission.denied', '/gamemode 未命中 allow 应拒');
  await e2.stop();
});

test('默认开放：dig/attack 未配置即允许，显式 deny 才拒绝', async () => {
  script('t9.lua', `
    __R_dig_err = nil
    __R_attack_err = nil
    task("actor", function()
      local r = combat.dig({ x = 2, y = 64, z = 2 })
      if not r.ok then __R_dig_err = r.error.code end
      local e = entity.nearest{ type = "player", alive = true, within = 10 }
      if e then
        local r2 = combat.attack(e)
        if not r2.ok then __R_attack_err = r2.error.code end
      end
    end)
    on_start(function() task.spawn("actor") end)
  `);
  const driver = new MockDriver();
  driver.addPlayer('Victim', { x: 3, y: 64, z: 3 }, null);
  const { engine } = await makeEngine({ scripts: ['t9.lua'], driver, boundary: {} });
  assert.ok(await waitFor(
    () => engine.actionLog.some((a) => a.action === 'act.dig'), 5000), '默认允许时 dig 应放行');
  assert.ok(await waitFor(
    () => engine.actionLog.some((a) => a.action === 'act.use_entity'), 5000), '默认允许时 attack 应放行');
  assert.ok(!g(engine, '__R_dig_err'), '未配置 blocks.dig：不应被拒');
  assert.ok(!g(engine, '__R_attack_err'), '未配置 combat.targets：不应被拒');
  await engine.stop();

  const driver2 = new MockDriver();
  driver2.addPlayer('Victim', { x: 3, y: 64, z: 3 }, null);
  const { engine: engine2 } = await makeEngine({
    scripts: ['t9.lua'], driver: driver2,
    boundary: { blocks: { dig: 'deny' }, combat: { targets: 'zombie' } },
  });
  assert.ok(await waitFor(() => g(engine2, '__R_dig_err') != null, 5000), '显式 deny 时 dig 应被拒');
  assert.strictEqual(g(engine2, '__R_dig_err'), 'policy.blocklist', 'blocks.dig=deny 必须 policy.blocklist');
  assert.strictEqual(g(engine2, '__R_attack_err'), 'policy.blocklist', 'combat.targets=zombie 不匹配 player');
  await engine2.stop();
});

test('容器门控：containers=false 拒开箱；未配置默认允许', async () => {
  script('t-cont.lua', `
    __R_open_err = nil
    __R_open_ok = nil
    task("probe", function()
      local w = container.open({ x = 5, y = 64, z = 5 })
      if w ~= nil then __R_open_ok = true else __R_open_err = "container.denied" end
    end)
    on_start(function() task.spawn("probe") end)
  `);
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, []);
  const { engine } = await makeEngine({ scripts: ['t-cont.lua'], driver, boundary: { containers: false } });
  assert.ok(await waitFor(() => g(engine, '__R_open_err') != null, 8000));
  assert.strictEqual(g(engine, '__R_open_err'), 'container.denied', 'containers=false 应拒绝开箱');
  await engine.stop();

  const driver2 = new MockDriver();
  driver2.setContainer({ x: 5, y: 64, z: 5 }, []);
  const { engine: e2 } = await makeEngine({ scripts: ['t-cont.lua'], driver: driver2, boundary: {} });
  assert.ok(await waitFor(() => g(e2, '__R_open_ok') === true, 5000), '未配置 containers 应默认允许');
  await e2.stop();
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
  engine.setParam('must_set', 42);
  assert.strictEqual(engine.paramsSnapshot().values.must_set, 42, '显式设置应进入持久化层');
  await engine.stop();
});

test('self.username + params_validator 校验钩拒绝非法值、旧值生效', async () => {
  script('t14b.lua', `
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
    scripts: ['t14b.lua'],
    driver,
    yaml: { params: { pat: { type: 'string', default: 'safe-old' }, other: { type: 'string', default: '' } } },
  });
  assert.ok(await waitFor(() => g(engine, '__R_username') === 'RelayBot', 3000), 'self.username 应来自 driver 快照');

  try {
    engine.setParam('pat', 'xBADx');
    assert.fail('非法值应被拒绝');
  } catch (e) {
    assert.strictEqual(e.kind, 'param.rejected');
    assert.ok(String(e.detail).includes('BAD'), '错误信息应可读');
  }
  assert.strictEqual(engine.paramsSnapshot().values.pat, 'safe-old', '被拒后旧值继续生效');
  engine.setParam('pat', 'good-new');
  assert.strictEqual(engine.paramsSnapshot().values.pat, 'good-new', '合法值正常落参');

  engine.setParam('other', 'v');
  assert.strictEqual(engine.paramsSnapshot().values.other, 'v');
  try {
    engine.setParam('ghost', 1);
    assert.fail('未知参数应被拒绝');
  } catch (e) {
    assert.strictEqual(e.kind, 'param.unknown');
  }
  await engine.stop();
});
