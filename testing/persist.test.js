// testing/persist.test.js — persist ABI 语义（事务/去重/日志/kv）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';

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
