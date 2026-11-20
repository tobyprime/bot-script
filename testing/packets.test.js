// testing/packets.test.js — 自定义网络包（custom payload）：权限位 / 双向字节保真 / 宿主校验
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

const SCRIPT_DENY = `
  __R_send_code = nil
  __R_bytes = nil
  __R_wild = nil
  __R_generic = nil
  net.on("servux:metadata", function(p)
    local bytes = {}
    for i = 1, #p.data do bytes[i] = string.byte(p.data, i) end
    __R_bytes = table.concat(bytes, ",")
  end)
  net.on("*", function() __R_wild = (__R_wild or 0) + 1 end)
  on_event("net.payload", function() __R_generic = (__R_generic or 0) + 1 end)
  on_start(function()
    task.spawn(function()
      local r = net.send("servux:metadata", string.char(0, 1, 2, 255) .. "hi")
      __R_send_code = r.ok and "ok" or r.error.code
    end)
  end)
`;

const SCRIPT_ALLOW = `
  __R_send_code = nil
  __R_send2 = nil
  __R_invalid = nil
  __R_bytes = nil
  __R_wild = nil
  __R_generic = nil
  net.on("servux:metadata", function(p)
    local bytes = {}
    for i = 1, #p.data do bytes[i] = string.byte(p.data, i) end
    __R_bytes = table.concat(bytes, ",")
  end)
  net.on("*", function() __R_wild = (__R_wild or 0) + 1 end)
  on_event("net.payload", function() __R_generic = (__R_generic or 0) + 1 end)
  on_start(function()
    task.spawn(function()
      local r = net.send("servux:metadata", string.char(0, 1, 2, 255) .. "hi")
      __R_send_code = r.ok and "ok" or r.error.code
      local r2 = net.send("minecraft:brand", { 7, 0, 9 })
      __R_send2 = r2.ok and "ok" or r2.error.code
      local ok, err = pcall(function() net.send("servux:metadata", { 300 }) end)
      __R_invalid = ok and "ok" or (type(err) == "table" and err.kind or "err")
    end)
  end)
`;

test('自定义网络包：boundary 缺省 = 拒绝（发送与监听都不可用）', async () => {
  script('packets_deny.lua', SCRIPT_DENY);
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: ['packets_deny.lua'], driver, boundary: {} });
  assert.ok(await waitFor(() => g(engine, '__R_send_code') != null, 3000), '发送应返回 Result');
  assert.strictEqual(g(engine, '__R_send_code'), 'policy.blocklist', '未授予权限位必须拒绝发送');
  assert.strictEqual(driver.outgoingPayloads.length, 0, '被拒的动作不得写包');

  driver.serverPayload('servux:metadata', Buffer.from([0xde, 0xad]));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(g(engine, '__R_bytes'), null, '未授予权限位时不得到达 net.on');
  assert.strictEqual(g(engine, '__R_wild'), null, '未授予权限位时通配处理器也不得到达');
  assert.strictEqual(g(engine, '__R_generic'), null, '未授予权限位时 on_event("net.payload") 也不得到达');
  await engine.stop();
});

test('自定义网络包：packets=true => 原始字节双向保真（含 byte 数组形式）', async () => {
  script('packets_allow.lua', SCRIPT_ALLOW);
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: ['packets_allow.lua'], driver, boundary: { packets: true } });

  assert.ok(await waitFor(() => g(engine, '__R_send2') != null, 5000), '两个发送都应返回');
  assert.strictEqual(g(engine, '__R_send_code'), 'ok');
  assert.strictEqual(g(engine, '__R_send2'), 'ok');
  assert.strictEqual(g(engine, '__R_invalid'), 'net.bad_payload', '越界字节数组应在核心侧拒绝');

  assert.strictEqual(driver.outgoingPayloads.length, 2, '应写出两个自定义网络包');
  assert.strictEqual(driver.outgoingPayloads[0].channel, 'servux:metadata');
  assert.deepStrictEqual(
    [...driver.outgoingPayloads[0].data],
    [0, 1, 2, 255, 104, 105],
    '原始字节串应逐字节保真（含 0x00 / 0xFF）',
  );
  assert.deepStrictEqual([...driver.outgoingPayloads[1].data], [7, 0, 9], 'byte 数组形式应等价编码');

  driver.serverPayload('servux:metadata', Buffer.from([0xde, 0xad, 0x00]));
  assert.ok(await waitFor(() => g(engine, '__R_bytes') != null, 3000), '入站应到达 net.on');
  assert.strictEqual(g(engine, '__R_bytes'), '222,173,0', '入站原始字节应逐字节保真');
  assert.strictEqual(g(engine, '__R_wild'), 1, '通配处理器应命中同一通道');
  assert.strictEqual(g(engine, '__R_generic'), 1, 'on_event("net.payload") 应收到同一事件');
  await engine.stop();
});

test('自定义网络包：宿主侧拒绝非法 channel / 非法 base64 / 超限载荷（core 绕过时的护栏）', async () => {
  script('packets_guard.lua', '');
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: ['packets_guard.lua'], driver, boundary: { packets: true } });

  const call = async (args) => {
    const token = engine.abi.asyncOp('act.custom_payload', JSON.stringify(args));
    assert.ok(await waitFor(() => engine.hub.settled.has(token), 3000), 'token 应结算');
    const [okj] = engine.hub.settled.get(token);
    return JSON.parse(okj);
  };

  const badChannel = await call({ channel: 'Not A Channel', data: '' });
  assert.strictEqual(badChannel.ok, false);
  assert.strictEqual(badChannel.error.code, 'net.bad_request');

  const badB64 = await call({ channel: 'servux:metadata', data: '***' });
  assert.strictEqual(badB64.ok, false);
  assert.strictEqual(badB64.error.code, 'net.bad_payload');

  const huge = Buffer.alloc((1 << 20) + 1, 0x41).toString('base64');
  const tooBig = await call({ channel: 'servux:metadata', data: huge });
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.error.code, 'net.bad_payload');
  assert.strictEqual(driver.outgoingPayloads.length, 0, '被拒载荷不得写包');
  await engine.stop();
});
