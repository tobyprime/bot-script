// testing/reload.test.js — 脚本热重载（原地换脚本，不重启连接）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

const V1 = `
  __V1 = 0
  task("tick", { single = true }, function()
    while true do
      __V1 = __V1 + 1
      time.sleep(100)
    end
  end)
  on_start(function() task.spawn("tick") end)
  on_chat(rex"^ping$", { source = "player" }, function(m)
    chat.reply("v1")
  end)
`;

const V2 = `
  __V2 = 0
  on_event("session.ready", function() __V2_READY = true end)
  task("tick2", { single = true }, function()
    while true do
      __V2 = __V2 + 1
      time.sleep(100)
    end
  end)
  on_start(function() task.spawn("tick2") end)
  on_chat(rex"^ping$", { source = "player" }, function(m)
    chat.reply("v2")
  end)
`;

test('热重载：新脚本接管、旧任务停止、会话不中断；编译失败保持旧脚本', async () => {
  const driver = new MockDriver();
  script('reload.lua', V1);
  const { engine } = await makeEngine({ scripts: ['reload.lua'], driver, boundary: {} });
  assert.ok(await waitFor(() => (g(engine, '__V1') ?? 0) >= 2, 5000), 'v1 任务应运行');

  // v2：同一路径换文件，热重载
  script('reload.lua', V2);
  const r = await engine.reloadScripts({ reason: 'test' });
  assert.strictEqual(r.ok, true);
  assert.ok(await waitFor(() => (g(engine, '__V2') ?? 0) >= 2, 5000), 'v2 任务应运行');
  assert.strictEqual(g(engine, '__V2_READY'), true, '热重载应向前补发当前 session.ready');
  assert.ok(!g(engine, '__V1'), '旧 VM 的全局应不存在（旧任务已停）');

  driver.playerSay('Steve', 'ping');
  assert.ok(await waitFor(() => driver.outgoingChat.some((m) => m === 'v2'), 3000), '新 on_chat 应生效');
  assert.ok(!driver.outgoingChat.includes('v1'), '旧 on_chat 不应再响应');

  // 编译失败：保持旧脚本继续运行
  script('reload.lua', 'on_start(function() this is not lua end)');
  await assert.rejects(() => engine.reloadScripts({ reason: 'bad' }), (e) => e?.kind === 'lua.compile');
  driver.playerSay('Steve', 'ping');
  assert.ok(await waitFor(() => driver.outgoingChat.filter((m) => m === 'v2').length >= 2, 3000),
    '编译失败后旧脚本应继续响应');
  const before = g(engine, '__V2');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((g(engine, '__V2') ?? 0) > before, '编译失败后旧任务应继续运行');

  assert.notStrictEqual(engine.sessionState, 'disconnected', '热重载不得断开会话');
  assert.strictEqual(driver.stopCalls, undefined, '驱动不应被重启');
  await engine.stop();
});

test('热重载不累积 process 监听：反复 reload 后 uncaughtException 数量不增长', async () => {
  const before = process.listenerCount('uncaughtException');
  script('reload2.lua', 'on_start(function() end)');
  const { engine } = await makeEngine({ scripts: ['reload2.lua'], driver: new MockDriver(), boundary: {} });
  for (let i = 0; i < 5; i++) await engine.reloadScripts({ reason: 'listener' });
  assert.ok(process.listenerCount('uncaughtException') <= before + 1,
    `process 监听应随旧 VM 释放（before=${before} now=${process.listenerCount('uncaughtException')}）`);
  await engine.stop();
});
