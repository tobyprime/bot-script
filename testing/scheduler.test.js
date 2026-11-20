// testing/scheduler.test.js — 调度语义（任务/组合子/取消/pause/定时器）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';

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

test('pause/resume：动作以 Result 失败（runtime.paused），恢复后交付，钩子执行', async () => {
  script('t7.lua', `
    __R_paused = false
    __R_resumed = false
    __R_paused_err = false
    __R_wrong_err = nil
    on_pause(function() __R_paused = true end)
    on_resume(function() __R_resumed = true end)
    task("walker", function()
      local r = nav.walk({ x = 50, y = 64, z = 50 }, { timeout = 30 })
      if not r.ok and r.error and r.error.code == "runtime.paused" then
        __R_paused_err = true
      else
        __R_wrong_err = r.ok and "no_err" or tostring(r.error and r.error.code or "?")
      end
    end)
    on_start(function() task.spawn("walker") end)
  `);
  const driver = new (await import('./mock-driver.js')).MockDriver();
  driver.gotoDelay = 400;
  const { engine } = await makeEngine({ scripts: ['t7.lua'], driver });
  await new Promise((r) => setTimeout(r, 80));
  engine.pause('command');
  assert.strictEqual(engine.paused, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(g(engine, '__R_paused'), true, 'on_pause 应执行');
  assert.strictEqual(g(engine, '__R_paused_err'), false, '暂停期间错误应冻结于门');
  engine.resume();
  assert.ok(await waitFor(() => g(engine, '__R_paused_err') === true), '恢复后应交付 runtime.paused Result');
  assert.strictEqual(g(engine, '__R_resumed'), true, 'on_resume 应执行');
  assert.ok(g(engine, '__R_wrong_err') == null, `不应是其它错误（实际 ${g(engine, '__R_wrong_err')}）`);
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
  engine.pause('command');
  await new Promise((r) => setTimeout(r, 400));
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
