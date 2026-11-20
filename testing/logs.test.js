// testing/logs.test.js — 日志语义：脚本/引擎来源可分、调度 op 不算动作、断线日志不重复告警
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

test('日志：调度 op（util.sleep）不进动作审计；脚本日志带 source=script', async () => {
  script('t-log-source.lua', `
    __R_script_logged = false
    task("spam_sleep", function()
      for i = 1, 50 do time.sleep(0.01) end
      log.info("脚本自己的日志")
      __R_script_logged = true
    end)
    on_start(function() task.spawn("spam_sleep") end)
  `);
  const { engine } = await makeEngine({ scripts: ['t-log-source.lua'] });
  assert.ok(await waitFor(() => engine.lua.lua.global.get('__R_script_logged') === true, 5000),
    '睡眠循环应正常完成');

  const sleeps = engine.actionLog.filter((a) => a.action === 'util.sleep');
  assert.equal(sleeps.length, 0, `util.sleep 不是动作，不应进动作审计（实际 ${sleeps.length} 条）`);

  const scriptLine = engine.logRing.find((l) => l.msg === '脚本自己的日志');
  assert.ok(scriptLine, '脚本日志应进入日志环');
  assert.equal(scriptLine.source, 'script', '脚本日志必须标 source=script');
  assert.ok(scriptLine.msg === '脚本自己的日志', '脚本日志文本不应带引擎/包名前缀');

  const engineLine = engine.logRing.find((l) => l.msg === '引擎启动完成 driver=MockDriver paused=false');
  assert.ok(engineLine, '引擎日志应进入日志环');
  assert.equal(engineLine.source, 'engine', '引擎日志必须标 source=engine');
  await engine.stop();
});

test('日志：协议动作仍进动作审计（act.input）', async () => {
  script('t-log-action.lua', `
    __R_hopped = false
    task("hop", function()
      nav.hop()
      __R_hopped = true
    end)
    on_start(function() task.spawn("hop") end)
  `);
  const { engine } = await makeEngine({ scripts: ['t-log-action.lua'] });
  assert.ok(await waitFor(() => engine.lua.lua.global.get('__R_hopped') === true, 5000), 'hop 应完成');
  assert.ok(engine.actionLog.some((a) => a.action === 'act.input'), 'act.input 应进动作审计');
  await engine.stop();
});

test('日志：kicked 后紧接 disconnected 只告警一次，第二条降为 debug', async () => {
  script('t-log-kick.lua', `
    on_start(function() end)
  `);
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: ['t-log-kick.lua'], driver });
  driver.emit('session', { state: 'kicked', reason: 'test kick' });
  driver.emit('session', { state: 'disconnected', reason: 'socketClosed' });
  await waitFor(() => engine.paused, 2000);

  const warns = engine.logRing.filter((l) => l.level === 'warn' && /自动 pause/.test(l.msg));
  assert.equal(warns.length, 1, `只应有一条「自动 pause」告警（实际 ${warns.length}）`);
  const dup = engine.logRing.find((l) => l.msg.includes('socketClosed'));
  assert.ok(dup, '第二条会话状态仍需留痕');
  assert.equal(dup.level, 'debug', '已暂停后的重复断线应降为 debug');
  assert.match(dup.msg, /已暂停/);
  await engine.stop();
});
