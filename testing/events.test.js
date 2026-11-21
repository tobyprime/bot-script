// testing/events.test.js — 平台事件入站 / 断线重连 / 上行事件
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';
import { BotEngine } from '../hosts/node/engine.js';

test('events：pushEvent 直付等待者、FIFO 排队、空队超时 nil', async () => {
  script('t11.lua', `
    __R_order = nil
    task("evt_loop", { single = true }, function()
      local order = {}
      local r = events.next(2000)
      local ev = r and r.value
      order[#order + 1] = ev and ev.type or "nil"
      time.sleep(50)
      for i = 1, 4 do
        local rr = events.next(120)
        local e = rr and rr.value
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

test('断线缓存失效：world/windows 旧会话数据清空，重连 playing 后自动 resume 不残留', async () => {
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
  driver.addPlayer('Ghost', { x: 1, y: 64, z: 1 });
  driver.emit('block_update', { pos: { x: 3, y: 64, z: 3 }, name: 'minecraft:chest' });
  driver.emit('window', { id: '42', type: 'chest', title: '旧箱', size: 27, slots: [{ index: 0, item: { id: 'minecraft:dirt', count: 1 } }] });
  assert.ok(engine.world.cache.size > 0 && engine.windows.windows.size > 0, '前置：旧会话缓存已灌入');
  assert.ok(await waitFor(() => {
    const r = JSON.parse(engine.abi.sync('entities.list', '{}') || '{}');
    const list = (r.ok && r.value) || [];
    return list.some((e) => e.name === 'Ghost');
  }, 3000), '前置：旧会话实体可查');

  driver.emit('session', { state: 'disconnected', reason: 'server closed' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(engine.paused, true, '断线应自动 pause');
  assert.strictEqual(engine.pauseReason, 'disconnect');
  assert.strictEqual(engine.windows.windows.size, 0, 'windows 旧会话残留应清空');
  assert.strictEqual(engine.currentWindowId, null, 'currentWindowId 应复位');
  assert.strictEqual(engine.world.cache.size, 0, 'world 旧会话方块观测应清空');
  assert.strictEqual(engine.reconAttempts, 1, '断线应发起第 1 次退避计数');

  driver.removePlayer('Ghost');
  driver.emit('session', { state: 'playing', info: { version: '1.21.8' } });
  driver.addPlayer('Fresh', { x: 9, y: 64, z: 9 });
  assert.strictEqual(engine.reconAttempts, 0, 'playing 后 attempts 应清零');
  assert.strictEqual(engine.paused, false, '重连成功应自动 resume');
  assert.ok(await waitFor(() => {
    const r = JSON.parse(engine.abi.sync('entities.list', '{}') || '{}');
    const list = (r.ok && r.value) || [];
    return list.length === 1 && list[0].name === 'Fresh';
  }, 3000), '新会话实体面只含新会话数据');
  await engine.stop();
});

test('重连退避：jitter ±20% 散布、attempts 递增、/state 暴露 reconnecting/attempts/nextRetryIn', async () => {
  const d1 = Array.from({ length: 200 }, () => BotEngine.backoffDelay(1, 30000, 120000, Math.random));
  assert.ok(d1.every((d) => d >= 24000 && d <= 36000), `attempts=1 应在 24s~36s（见 ${Math.min(...d1)}~${Math.max(...d1)}）`);
  assert.ok(new Set(d1).size > 20, '同 attempts 应呈散布而非固定值');
  const d5 = Array.from({ length: 200 }, () => BotEngine.backoffDelay(5, 30000, 120000, Math.random));
  assert.ok(d5.every((d) => d >= 96000 && d <= 144000), 'attempts=5 应封顶 120s ±20%');

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
  clearTimeout(engine.reconnectTimer);
  engine.reconnectTimer = null;
  engine.scheduleReconnect();
  assert.strictEqual(engine.reconAttempts, 2, '连续断线 attempts 应递增');
  // 冻结重连计时器：否则测试机负载高时 80ms 后重连成功会把 session 回 playing，/state 断言失真
  clearTimeout(engine.reconnectTimer);
  engine.reconnectTimer = null;

  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../hosts/node/http17.js');
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const hdr = { Authorization: `Bearer ${token}` };
  const state = await (await fetch(`http://127.0.0.1:${port}/state`, { headers: hdr })).json();
  assert.strictEqual(state.reconnecting, true, '/state.reconnecting 应为 true');
  assert.strictEqual(state.reconnect_attempts, 2);
  assert.ok(Number.isFinite(state.next_retry_in) && state.next_retry_in >= 0, 'next_retry_in 应为非负毫秒');

  driver.emit('session', { state: 'playing', info: {} });
  assert.strictEqual(engine.reconAttempts, 0);
  const state2 = await (await fetch(`http://127.0.0.1:${port}/state`, { headers: hdr })).json();
  assert.strictEqual(state2.reconnecting, false);
  assert.strictEqual(state2.next_retry_in, null);
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

test('await_chat 超时后等待者必须出账（否则 __AWAITERS 只增不减）', async () => {
  script('await-timeout.lua', `
    __R_n = nil
    task("wait", function()
      chat.await_chat(rex"never-match", 80)
      __R_n = #__AWAITERS
    end)
    on_start(function() task.spawn("wait") end)
  `);
  const { engine } = await makeEngine({ scripts: ['await-timeout.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_n') != null, 3000), 'await_chat 应超时返回');
  assert.strictEqual(g(engine, '__R_n'), 0, '__AWAITERS 不应残留超时等待者');
  await engine.stop();
});

test('事件门控：高频世界事件无 on_event 时不进 Lua；注册后恢复分发', async () => {
  script('gate0.lua', 'on_start(function() end)');
  const { engine } = await makeEngine({ scripts: ['gate0.lua'] });
  assert.strictEqual(engine._eventKinds.size, 0, '无 on_event 时注册集合应为空');
  assert.strictEqual(engine.eventNeeded('entity_appeared'), false, '无消费者：实体事件不构造 payload');
  assert.strictEqual(engine.eventNeeded('block_update'), false, '无消费者：区块事件不进 Lua');
  assert.strictEqual(engine.eventNeeded('custom_payload'), false, '无 net 处理器：插件包不进 Lua');
  // 计数 __core_event 实际调用次数
  const lua = engine.lua;
  const orig = lua.fn.bind(lua);
  let calls = 0;
  lua.fn = (n) => {
    const f = orig(n);
    if (n !== '__core_event') return f;
    return (...a) => { calls += 1; return f(...a); };
  };
  engine.event('world.block_changed', { pos: { x: 0, y: 64, z: 0 }, name: 'minecraft:stone' });
  engine.event('entity.appeared', { id: 1, type: 'minecraft:zombie', name: 'zombie' });
  assert.strictEqual(calls, 0, '密集区高频事件在无消费者时不得进 Lua（JSON/WASM 往返是纯开销）');
  engine.event('self.damaged', {});
  assert.strictEqual(calls, 1, '非高频事件照常分发');
  await engine.stop();
});

test('事件门控：脚本注册 on_event 后高频事件恢复分发（含 net.payload）', async () => {
  script('gate1.lua', `
    __R_blocks = 0
    __R_net = 0
    on_event("world.block_changed", function(p) __R_blocks = __R_blocks + 1 end)
    on_event("net.payload", function(p) __R_net = __R_net + 1 end)
    on_start(function() end)
  `);
  const { engine } = await makeEngine({ scripts: ['gate1.lua'] });
  assert.strictEqual(engine.eventNeeded('block_update'), true, '注册了 on_event 就必须分发');
  assert.strictEqual(engine.eventNeeded('custom_payload'), true, '注册了 net.payload 就必须分发');
  engine.event('world.block_changed', { pos: { x: 0, y: 64, z: 0 }, name: 'minecraft:stone' });
  assert.ok(await waitFor(() => g(engine, '__R_blocks') >= 1, 2000), '区块事件应交付 Lua');
  engine.event('net.payload', { channel: 'c', data: '', ts: 1 });
  assert.ok(await waitFor(() => g(engine, '__R_net') >= 1, 2000), '插件消息应交付 Lua');
  await engine.stop();
});
