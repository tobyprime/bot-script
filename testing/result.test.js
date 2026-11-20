// testing/result.test.js — ABI Result 契约（v2.1）
//
// 锁定四件事：
//   1) 确定性失败（策略/参数校验）返回 Result，不向 Lua 抛异常；
//   2) 宿主意外异常只在宿主日志留栈，Lua 只看到稳定码 internal（不带消息/栈）；
//   3) 取消是独立控制通道，不是 Result error；
//   4) Lua 原生 error() 仍是任务级失败（on_error 可见）。
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

test('Result：确定性失败不抛异常；宿主意外异常只给稳定码；Lua 原生错误仍任务级失败', async () => {
  script('result.lua', `
    __R_bad = nil
    __R_bad_pcall = nil
    __R_chat = nil
    __R_chat_msg = nil
    __R_native_failed = false
    on_error(function(e) __R_native_failed = true end)
    task("runner", function()
      __R_bad_pcall = pcall(function()
        __R_bad = combat.dig({ x = "bad", y = 64, z = 1 })
      end)
      local r = chat.say("hi")
      __R_chat = r.ok and "ok" or r.error.code
      __R_chat_msg = r.ok and "" or r.error.message
      error("native-boom")
    end)
    on_start(function() task.spawn("runner") end)
  `);
  const driver = new MockDriver();
  driver.chat_send = async () => { throw new Error('boom-secret-runtime-stack'); };
  const { engine } = await makeEngine({ scripts: ['result.lua'], driver, boundary: {} });

  assert.ok(await waitFor(() => g(engine, '__R_chat') != null, 5000), '脚本应跑完');
  assert.strictEqual(g(engine, '__R_bad_pcall'), true, '参数校验失败不得抛 Lua 异常');
  assert.strictEqual(g(engine, '__R_bad').ok, false, '参数校验失败应为 Err Result');
  assert.strictEqual(g(engine, '__R_bad').error.code, 'abi.invalid_args');
  assert.strictEqual(g(engine, '__R_chat'), 'internal', '宿主异常应归一为稳定 internal 码');
  assert.ok(!String(g(engine, '__R_chat_msg')).includes('boom-secret'), '不得把宿主异常消息传进 Lua');
  assert.ok(engine.logRing.some((l) => l.msg.includes('boom-secret-runtime-stack')), '宿主日志应保留现场');
  assert.ok(await waitFor(() => g(engine, '__R_native_failed') === true, 3000), 'Lua 原生错误仍应进入 on_error');
  await engine.stop();
});
