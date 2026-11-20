// testing/state.test.js — 实例状态（localStorage 语义）+ 配额 + 落盘
import assert from 'node:assert';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor, TMP } from './harness.js';

test('state：set/get/all/update/delete/seen 的 localStorage 语义', async () => {
  script('state1.lua', `
    on_start(function()
      local function run()
        local s1 = state.set("acc", { name = "Mix", balance = 100 })
        __R_set1 = s1.ok
        __R_get = state.get("acc").balance
        local s2 = state.update("acc", function(v) v.balance = v.balance - 30; return v end)
        __R_update = s2.ok and state.get("acc").balance or s2.error.code
        __R_missing = state.get("nope", "def")
        __R_all = state.all().acc.name
        local seen1, seen2 = state.seen("tx:1", 5000), state.seen("tx:1", 5000)
        __R_seen = (seen1 and "hit" or "new") .. "/" .. (seen2 and "hit" or "new")
        __R_del = state.delete("acc").ok
        __R_after = state.get("acc", "gone")
      end
      task.spawn(run)
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['state1.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_after') !== undefined, 5000), '场景未跑完');
  assert.strictEqual(g(engine, '__R_set1'), true);
  assert.strictEqual(g(engine, '__R_get'), 100);
  assert.strictEqual(g(engine, '__R_update'), 70);
  assert.strictEqual(g(engine, '__R_missing'), 'def', '缺失键返回默认值');
  assert.strictEqual(g(engine, '__R_all'), 'Mix');
  assert.deepStrictEqual(String(g(engine, '__R_seen')).split('/'), ['new', 'hit']);
  assert.strictEqual(g(engine, '__R_del'), true);
  assert.strictEqual(g(engine, '__R_after'), 'gone');
  await engine.stop();
});

test('state.update：回调内挂起 => state.update_yielded，且不写入', async () => {
  script('state-yield.lua', `
    on_start(function()
      task.spawn(function()
        state.set("n", 1)
        local ok, err = pcall(function()
          state.update("n", function(v) time.sleep(10) return (v or 0) + 1 end)
        end)
        __R_yield = ok and "none" or (type(err) == "table" and err.kind or "err")
        __R_n = state.get("n")
      end)
    end)
  `);
  const { engine } = await makeEngine({ scripts: ['state-yield.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_yield') != null, 5000), '场景未跑完');
  assert.strictEqual(g(engine, '__R_yield'), 'state.update_yielded');
  assert.strictEqual(g(engine, '__R_n'), 1, '挂起回调不得写入');
  await engine.stop();
});

test('state：单值/总量配额拒绝并返回 state.quota（不静默淘汰）', async () => {
  const { engine } = await makeEngine({ scripts: [] });
  const big = 'x'.repeat((16 * 1024) + 1);
  const r1 = JSON.parse(engine.abi.sync('state.set', JSON.stringify({ key: 'big', value: big })) || '{}');
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.error.code, 'state.quota');
  assert.strictEqual(engine.stateStore.get('big'), undefined, '超限不得写入');

  const chunk = 'y'.repeat((16 * 1024) - 8);
  let n = 0;
  for (; n < 40; n++) {
    const r = JSON.parse(engine.abi.sync('state.set', JSON.stringify({ key: `k${n}`, value: chunk })) || '{}');
    if (!r.ok) break;
  }
  assert.ok(n > 0 && n < 40, `应在总量上限处停下（实际写入 ${n} 个）`);
  assert.strictEqual(JSON.parse(engine.abi.sync('state.set', JSON.stringify({ key: `k${n}`, value: chunk })) || '{}').error.code,
    'state.quota');
  assert.ok(engine.stateStore.stats.bytes <= engine.stateStore.stats.quota);
  await engine.stop();
});

test('state：落盘跨实例重启保留（固定 statePath，包无权指定路径）', async () => {
  const statePath = path.join(TMP, 'state', 'state.sqlite');
  rmSync(path.dirname(statePath), { recursive: true, force: true });
  script('state-persist.lua', `
    on_start(function()
      task.spawn(function()
        state.set("cursor", { at = 42 })
        __R_written = state.get("cursor").at
      end)
    end)
  `);
  {
    const { engine } = await makeEngine({ scripts: ['state-persist.lua'], statePath });
    assert.ok(await waitFor(() => g(engine, '__R_written') != null, 3000));
    await engine.stop();
  }
  script('state-read.lua', `
    on_start(function()
      task.spawn(function() __R_cursor = state.get("cursor", {}).at end)
    end)
  `);
  {
    const { engine } = await makeEngine({ scripts: ['state-read.lua'], statePath });
    assert.ok(await waitFor(() => g(engine, '__R_cursor') != null, 3000), '重启后应读回状态');
    assert.strictEqual(g(engine, '__R_cursor'), 42);
    await engine.stop();
  }
});
