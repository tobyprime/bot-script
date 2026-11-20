// testing/nav.test.js — 核心导航契约（无寻路器显式失败；container.open 保持裸打开）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

test('nav.walk 无寻路器 → nav.unsupported + nav.failed（不再直线假寻路）', async () => {
  script('nav-unsupported.lua', `
    on_start(function()
      task.spawn(function()
        local r = nav.walk({ x = 5, y = 64, z = 5 })
        __R_nav_ok = r.ok
        __R_nav_code = r.error and r.error.code or nil
      end)
    end)
  `);
  const driver = new MockDriver();
  driver.caps = () => ({ 'nav.pathfinder': false });
  const { engine } = await makeEngine({ scripts: ['nav-unsupported.lua'], driver });
  assert.ok(await waitFor(() => g(engine, '__R_nav_ok') !== undefined), 'nav.walk 未返回');
  assert.strictEqual(g(engine, '__R_nav_ok'), false);
  assert.strictEqual(g(engine, '__R_nav_code'), 'nav.unsupported');
  assert.ok(engine.eventRing.some((e) => e.name === 'nav.failed' && e.data?.reason === 'nav.unsupported'),
    'nav.failed 事件应进入实时流');
  assert.deepStrictEqual(driver.botPos, { x: 0, y: 64, z: 0 }, '不得用输入假装走过去');
  await engine.stop();
});

test('container.open 是裸打开：不做贴身寻路（编排在可选库）', async () => {
  script('container-raw.lua', `
    on_start(function()
      task.spawn(function()
        local w = container.open({ x = 5, y = 64, z = 5 })
        __R_win = w ~= nil
        if w then container.close(w) end
      end)
    end)
  `);
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, []);
  const { engine } = await makeEngine({ scripts: ['container-raw.lua'], driver });
  assert.ok(await waitFor(() => g(engine, '__R_win') === true, 5000), '裸开箱未成功');
  assert.deepStrictEqual(driver.botPos, { x: 0, y: 64, z: 0 }, '核心 container.open 不应移动 bot');
  await engine.stop();
});
