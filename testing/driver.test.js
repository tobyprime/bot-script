// testing/driver.test.js — 驱动边界：单位换算 / 断线 / 协议补丁 / 真实实体
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, g, waitFor } from './harness.js';

const DRIVER = new URL('../hosts/node/drivers/mineflayer/index.js', import.meta.url);

test('mineflayer 驱动：look 角度按度进、按弧度出；self 上报回度', async () => {
  const { degToRad, radToDeg } = await import('../hosts/node/drivers/mineflayer/units.js');
  assert.equal(degToRad(-90), -Math.PI / 2, 'look.yaw(-90°) 应换算为 -π/2 弧度');
  assert.equal(degToRad(180), Math.PI);
  assert.equal(degToRad(null), null, '缺省轴保持 null（look 回退到当前值）');
  assert.equal(degToRad(undefined), undefined);
  assert.equal(radToDeg(Math.PI), 180);
  assert.equal(radToDeg(-Math.PI / 2), -90);
});

test('mineflayer 驱动：目标朝向取最短路径（跨 ±π 边界不得绕远路）', async () => {
  const { serviceDegToBotYaw, shortestYaw } = await import('../hosts/node/drivers/mineflayer/units.js');
  const deg = (rad) => (rad * 180) / Math.PI;
  const cur = shortestYaw(serviceDegToBotYaw(179), 0);
  const shortestDelta = (target) => {
    const a = deg(cur), b = deg(shortestYaw(serviceDegToBotYaw(target), cur));
    let d = b - a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return Math.abs(d);
  };
  for (const [target, expectMaxAbs] of [[181, 5], [270, 95], [1, 180], [90, 95]]) {
    const delta = shortestDelta(target);
    assert.ok(delta <= expectMaxAbs + 1, `179°→${target}° 应走最短一边（≤${expectMaxAbs}°），实际 ${delta.toFixed(0)}°`);
  }
  assert.ok(shortestDelta(181) < 5, '179°→181° 必须是 2° 而不是 358°');
});

test('mineflayer 驱动：shortestYaw 输出必须归一化到 [-π, π]（不得无界漂移）', async () => {
  const { serviceDegToBotYaw, shortestYaw } = await import('../hosts/node/drivers/mineflayer/units.js');
  const deg = (rad) => (rad * 180) / Math.PI;
  const inRange = (r) => r >= -Math.PI && r <= Math.PI;
  for (const curDeg of [0, 90, 179, -179, -215.967, 5109, -30759]) {
    const cur = curDeg * Math.PI / 180;
    for (const target of [0, 45, 90, 180, 270, 359]) {
      const out = shortestYaw(serviceDegToBotYaw(target), cur);
      assert.ok(inRange(out), `cur=${curDeg}° target=${target}° 输出 ${deg(out).toFixed(1)}° 越界`);
    }
  }
  let yaw = 0;
  for (let i = 0; i < 200; i++) {
    yaw = shortestYaw(serviceDegToBotYaw(i * 7 % 360), yaw);
    assert.ok(inRange(yaw), `第 ${i} 步输出 ${deg(yaw).toFixed(1)}° 越界`);
  }
});

test('断线：踢出理由解析成可读文本（字符串/chat 组件/JSON 文本三种形态）', async () => {
  const { reasonText } = await import('../hosts/node/drivers/mineflayer/reason.js');
  assert.equal(reasonText('{"color":"red","text":"You are banned from this server"}'),
    'You are banned from this server', 'JSON 文本应取出 text 段');
  assert.equal(reasonText({ text: 'Kicked: ', extra: [{ text: 'flying is not enabled' }] }),
    'Kicked: flying is not enabled', '组件对象应拼接 extra');
  assert.equal(reasonText('plain reason'), 'plain reason', '纯文本原样返回');
  assert.equal(reasonText(null), '');
  assert.equal(reasonText(''), '');
  assert.equal(reasonText('{"not":"json at all"'), '{"not":"json at all"', '非法 JSON 不丢原文');
  assert.equal(
    reasonText({ type: 'compound', name: '', value: { text: { type: 'string', value: 'You are not white-listed on this server' } } }),
    'You are not white-listed on this server',
    'NBT compound（kick 包的真实形态）应简化成可读文本');
  assert.equal(
    reasonText({
      type: 'compound', name: '', value: {
        text: { type: 'string', value: 'Kicked: ' },
        extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'flying is not enabled' } }] } },
      },
    }),
    'Kicked: flying is not enabled',
    'NBT 里套 extra 列表也应展开');
  assert.ok(!reasonText({ type: 'compound', name: '', value: {} }).includes('[object Object]'),
    '无法解析时也不得输出 [object Object]（至少给出字段名）');
});

test('断线：连接关闭后动作动词不再写包（防 EPIPE 刷屏）', async () => {
  const { MineflayerDriver } = await import('../hosts/node/drivers/mineflayer/index.js');
  const d = new MineflayerDriver({ log: () => {} });
  d.alive = false;
  d.bot = { entity: { yaw: 0, pitch: 0 }, chat: () => { throw new Error('不该写包'); },
            setControlState: () => { throw new Error('不该写包'); },
            look: async () => { throw new Error('不该写包'); },
            _client: { socket: { destroyed: true } } };
  await d.chat_send('hi');
  await d.look(90, 0);
  await d.input({ up: 1 });
  await d.input({ forward: 1 });
  const r = await d.path_to({ x: 0, y: 0, z: 0 });
  assert.deepEqual(r, { ok: false, reason: 'disconnected' }, '寻路应直接失败而不是挂起');
});

test('mineflayer 驱动：custom payload 走 custom_payload 包，入站二进制经 base64 过事件', async () => {
  const { MineflayerDriver } = await import('../hosts/node/drivers/mineflayer/index.js');
  const writes = [];
  let inbound = null;
  const client = {
    socket: { destroyed: false },
    write(name, params) { writes.push({ name, params }); },
    on(evt, fn) { if (evt === 'custom_payload') inbound = fn; },
  };
  const d = new MineflayerDriver({ log: () => {} });
  d.alive = true;
  d.bot = { entity: {}, _client: client };
  const events = [];
  d.on('custom_payload', (p) => events.push(p));

  await d.custom_payload('servux:metadata', Buffer.from([0x00, 0xff, 0x10]));
  assert.equal(writes.length, 1, '应写一个包');
  assert.equal(writes[0].name, 'custom_payload');
  assert.equal(writes[0].params.channel, 'servux:metadata');
  assert.deepEqual([...writes[0].params.data], [0x00, 0xff, 0x10], '发送字节保真');

  d.bindCustomPayload(d.bot);
  inbound({ channel: 'servux:metadata', data: Buffer.from([0xde, 0xad]) });
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'servux:metadata');
  assert.ok(events[0].data_b64, '入站载荷应以 base64 进事件（JSON 安全）');
  assert.strictEqual(Buffer.from(events[0].data_b64, 'base64').toString('hex'), 'dead', '入站字节保真');
});

test('bslib.look.at 单轮只发一个视角包（避免 invalid_player_movement 踢人）', async () => {
  script('aim_rate.lua', `
    local bslib = require "bslib"
    on_start(function()
      task.spawn(function()
        time.sleep(50)
        bslib.look.at({ pos = { x = 5, y = 64, z = 0 } })
        time.sleep(50)
        bslib.look.at({ pos = { x = 0, y = 64, z = 3 } })
        time.sleep(50)
        __R_done = true
      end)
    end)
  `);
  const { engine, driver } = await makeEngine({ scripts: ['aim_rate.lua'] });
  assert.ok(await waitFor(() => g(engine, '__R_done') === true), '瞄准场景未跑完');
  assert.equal(driver.rotCalls, 2, `两轮瞄准应只发 2 个视角包（实际 ${driver.rotCalls}）`);
  assert.ok(Math.abs(driver.botYaw) < 2, `朝 +Z 的目标 yaw 应约为 0，实际 ${driver.botYaw}`);
  assert.ok(Number.isFinite(driver.botPitch), `pitch 应被写入（实际 ${driver.botPitch}）`);
  await engine.stop();
});

test('驱动 rot：不得使用 force=true，且不得 await（等转到位会把脚本循环压到 ~7Hz）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(DRIVER, 'utf8');
  const start = Math.max(src.indexOf('look(yaw, pitch) {'), src.indexOf('async look(yaw, pitch)'));
  assert.ok(start >= 0, '应能找到 look 函数体');
  const rotBody = src.slice(start, src.indexOf('input(state'));
  assert.ok(rotBody.includes('false'), 'rot 的 bot.look 第三个参数应为 false（限速插值）');
  assert.ok(!/bot\.look\([\s\S]*?true,?\s*\)/.test(rotBody),
    'rot 不得传 force=true：它会直接把 lastSentYaw 赋成目标值，绕过限速');
  assert.ok(!/await\s+this\.bot\.look/.test(rotBody),
    'look 不得 await bot.look：等转到位会把脚本循环压到 ~7Hz，观感「转一下停住再转」');
});

test('驱动：必须提高 physics.yawSpeed（默认 3.0 rad/s 会让大角度转向耗时 >1 秒）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(DRIVER, 'utf8');
  const m = src.match(/bot\.physics\.yawSpeed\s*=\s*(\d+(?:\.\d+)?)/);
  assert.ok(m, 'spawn 后必须显式设置 bot.physics.yawSpeed');
  const speed = Number(m[1]);
  assert.ok(speed >= 10, `yawSpeed=${speed} 太小：默认 3.0 时 90° 转向要 0.55s、180° 要 1.05s`);
  const perTick = (speed * 0.05 * 180) / Math.PI;
  assert.ok(90 / perTick <= 5, `yawSpeed=${speed} → 每 tick ${perTick.toFixed(1)}°，90° 转向要 ${Math.ceil(90 / perTick)} tick`);
});

test('协议数据表：entity_teleport 真实帧必须整包读完（防止 minecraft-data 回退）', async () => {
  const mcMod = await import('minecraft-protocol');
  const mc = mcMod.default ?? mcMod;
  const FRAME = Buffer.from(
    '769df2e89f0440eb5a854031842e4051e0000000000040eb590f8a11f3df000000000000000000000000000000000000000000000000'
    + '42b1d14c4142ac200000000000', 'hex');
  const mcdMod = await import('minecraft-data');
  const mcd = mcdMod.default ?? mcdMod;
  const def = mcd('26.1').protocol.play.toClient.types.packet_entity_teleport;
  const fields = def[1].filter((x) => x.name !== 'name').map((x) => x.name);
  assert.ok(fields.includes('dx'),
    '26.1 的 entity_teleport 应含 dx（实际：' + fields.join(',') + '）'
    + '；缺它说明 minecraft-data 版本过旧，play 阶段会报 partial packet');
  const d = mc.createDeserializer({ state: 'play', isServer: false, version: '1.21.8', noErrorLogging: true });
  let pkt = null;
  d.on('data', (p) => { pkt = p; });
  d.write(FRAME);
  assert.ok(pkt, '真实帧应能被解析出包');
  assert.equal(pkt.metadata.size, FRAME.length,
    '应整包读完（' + pkt.metadata.size + '/' + FRAME.length + '）'
    + '；读少了就是线上那句「Chunk size is 67 but only 33 was read」');
  const params = pkt.data.params;
  assert.equal(params.x, 56020.164086111225);
  assert.ok(Math.abs(params.yaw - 88.91) < 0.05, 'yaw 应约 88.91°，实际 ' + params.yaw);
  assert.ok(Math.abs(params.pitch - 12.17) < 0.05, 'pitch 应约 12.17°，实际 ' + params.pitch);
});

test('协议诊断：环形缓冲常开、只在断线时倒出（用户无需配环境变量）', async () => {
  const tr = await import('../hosts/node/drivers/mineflayer/protocolTrace.js');
  assert.equal(tr.traceVerbose({}), false, '默认非 verbose（零噪音）');
  assert.equal(tr.traceVerbose({ BOTSCRIPT_PROTO_TRACE: '1' }), true, '可用环境变量切 verbose');
  const noClient = tr.installProtocolTrace({}, () => {});
  assert.equal(typeof noClient.flush, 'function');
  assert.equal(typeof noClient.off, 'function');
  assert.doesNotThrow(() => noClient.flush('x'));
  assert.doesNotThrow(() => noClient.off());

  const lines = [];
  const writes = [];
  const handlers = {};
  const fakeBot = { _client: {
    write(name, p) { writes.push(name); },
    on(evt, fn) { handlers[evt] = fn; },
    removeListener(evt) { delete handlers[evt]; },
  } };
  const t = tr.installProtocolTrace(fakeBot, (l) => lines.push(l));
  fakeBot._client.write('teleport_confirm', { teleportId: 7 });
  assert.equal(lines.length, 0, '未断线时不得输出任何日志（零噪音）');
  assert.equal(writes.length, 1, '包装后仍会真正发包');
  t.flush('kicked: invalid_player_movement');
  assert.ok(lines.length > 0, '断线时应倒出缓冲');
  assert.ok(lines.some((l) => l.includes('断线诊断')), '应带明确标题');
  t.flush('again');
  const after = lines.length;
  t.flush('again2');
  assert.equal(lines.length, after, 'flush 幂等');
  t.off();
});

test('tick_end 守卫：同一 tick 的多个移动包被延后到下一 tick（不丢弃、取最新坐标）', async () => {
  const { installTickEndSender } = await import('../hosts/node/drivers/mineflayer/patches/tick-end-26x.js');
  const calls = [];
  const fakeBot = { _client: { write(name, params) { calls.push({ name, params, at: Date.now() }); } } };
  const sender = installTickEndSender(fakeBot, { tickMs: 60 });
  const w = fakeBot._client.write;
  const t0 = Date.now();
  let blocked = 0;
  for (const dy of [0, -0.005, -0.014, -0.026]) {
    if (w('position', { x: 1, y: 64 + dy, z: 3, flags: {} }) === undefined) blocked += 1;
  }
  assert.ok(blocked >= 3, `同 tick 的后续位置包应被延后，实际拦截 ${blocked}/4`);
  await new Promise((r) => setTimeout(r, 250));
  const positions = calls.filter((c) => c.name === 'position');
  assert.ok(positions.length >= 2, `延后的位置包必须补发（不丢弃），实际 ${positions.length}`);
  for (const c of positions.slice(1)) {
    assert.ok(c.at - t0 >= 55, `补发包应在下一 tick（间隔 ${c.at - t0}ms）`);
  }
  const last = positions[positions.length - 1];
  assert.equal(Math.round(last.params.y * 1000) / 1000, 63.974,
    `应补发最新坐标（后到者覆盖前一个），实际 ${last.params.y}`);
  assert.ok(sender.stats().deferred >= 3, 'deferred 统计应反映延后次数');
  sender.stop();
});

test('tick_end 守卫：非移动包立即透传（chat 等不受节拍影响）', async () => {
  const { installTickEndSender } = await import('../hosts/node/drivers/mineflayer/patches/tick-end-26x.js');
  const calls = [];
  const fakeBot = { _client: { write(name) { calls.push(name); } } };
  const sender = installTickEndSender(fakeBot, { tickMs: 60 });
  const w = fakeBot._client.write;
  w('chat_send', { text: 'hi' });
  w('arm_animation', {});
  assert.deepEqual(calls.filter((n) => n !== 'tick_end'), ['chat_send', 'arm_animation'],
    '非移动包应立即写出（不排队）');
  sender.stop();
});

test('tick_end：按固定节拍每 tick 发送（补上原版客户端固有行为）', async () => {
  const { installTickEndSender } = await import('../hosts/node/drivers/mineflayer/patches/tick-end-26x.js');
  const calls = [];
  const fakeBot = { _client: { write(name) { calls.push(name); } } };
  const sender = installTickEndSender(fakeBot, { tickMs: 200 });
  await new Promise((r) => setTimeout(r, 650));
  sender.stop();
  assert.ok(calls.length >= 2, `应至少发送 2 次，实际 ${calls.length}`);
  assert.ok(calls.every((n) => n === 'tick_end'), `只应发 tick_end，实际 ${calls.join(',')}`);
  assert.equal(sender.stats().sent, calls.length, 'stats 应反映实际发送次数');
});

test('tick_end：stop 后不再发送；无 _client 时安全', async () => {
  const { installTickEndSender } = await import('../hosts/node/drivers/mineflayer/patches/tick-end-26x.js');
  const calls = [];
  const fakeBot = { _client: { write(name) { calls.push(name); } } };
  const sender = installTickEndSender(fakeBot, { tickMs: 100 });
  await new Promise((r) => setTimeout(r, 250));
  sender.stop();
  const after = calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.length, after, 'stop 之后不得再发送');
  const empty = installTickEndSender({}, { tickMs: 100 });
  assert.equal(empty.stats().sent, 0);
  assert.doesNotThrow(() => empty.stop());
});

test('snapshotOf 接受真实 prismarine-entity：isValid 是布尔属性，不得当函数调用', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const md = require('minecraft-data');
  const registry = md.default ? md.default('1.21.8') : md('1.21.8');
  const Entity = require('prismarine-entity')(registry);
  const e = new Entity(42);
  e.position = { x: 1, y: 64, z: 2 };
  e.username = 'RealBot';
  e.type = 'player';
  assert.equal(typeof e.isValid, 'boolean', 'isValid 应是布尔属性');
  const { MineflayerDriver } = await import('../hosts/node/drivers/mineflayer/index.js');
  const d = new MineflayerDriver({ log: () => {} });
  let snap;
  assert.doesNotThrow(() => { snap = d.snapshotOf(e); },
    'snapshotOf 处理真实实体时不得抛错（线上 "isValid is not a function" 即此）');
  assert.equal(snap.id, 42);
  assert.equal(snap.name, 'RealBot');
  assert.equal(snap.type, 'player');
  assert.equal(snap.alive, true, 'isValid=true 应映射为 alive=true');
  assert.deepEqual(snap.pos, { x: 1, y: 64, z: 2 });
  assert.ok(snap.equipment && 'helmet' in snap.equipment, '装备六件套应按名字暴露');

  const e2 = new Entity(7);
  e2.position = { x: 1, y: 64, z: 2 };
  e2.isValid = false;
  assert.equal(d.snapshotOf(e2).alive, false);
});

test('world.scan：关闭 useExtraInfo（启用 palette 剪枝）+ 区域并入谓词', async () => {
  const { MineflayerDriver } = await import('../hosts/node/drivers/mineflayer/index.js');
  const driver = new MineflayerDriver();
  let opts = null;
  driver.bot = { findBlocks(o) { opts = o; return []; }, blockAt() { return { name: 'minecraft:chest' }; } };
  driver.scan_blocks([{ x: 0, y: 60, z: 0 }, { x: 15, y: 60, z: 15 }], ['minecraft:chest'], 5);
  assert.ok(opts, '应调用 findBlocks');
  assert.strictEqual(opts.useExtraInfo, false, '不得传 useExtraInfo=true（会短路 palette 预筛）');
  assert.strictEqual(opts.count, 5, '区域已并入谓词，count 不再翻倍');
  assert.strictEqual(opts.matching({ name: 'chest', position: null }), true,
    'palette 预筛的合成 Block 没有坐标，应按名字放行');
  assert.strictEqual(opts.matching({ name: 'chest', position: { x: 99, y: 64, z: 99 } }), false,
    '域外命中应在谓词阶段被排除');
  assert.strictEqual(opts.matching({ name: 'stone', position: { x: 1, y: 61, z: 1 } }), false);
});

test('pushSelf：背包列表按脏标记重建（空闲采样不再遍历背包）', async () => {
  const { MineflayerDriver } = await import('../hosts/node/drivers/mineflayer/index.js');
  const driver = new MineflayerDriver();
  let itemsCalls = 0;
  let emitted = null;
  driver.on('self', (p) => { emitted = p; });
  driver.bot = {
    username: 'Bot',
    entity: {
      position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, effects: {}, pose: 'standing',
      onFire: false, sneaking: false, sprinting: false,
    },
    health: 20, food: 20, game: { gameMode: 'survival' }, heldItem: null, quickBarSlot: 0,
    experience: { level: 0, progress: 0 }, players: {},
    inventory: { items() { itemsCalls += 1; return [{ slot: 9, name: 'stone', count: 3, displayName: 'Stone' }]; } },
  };
  driver.pushSelf();
  driver.pushSelf();
  assert.strictEqual(itemsCalls, 1, `未变更时不应重复遍历背包（实际 ${itemsCalls} 次）`);
  assert.ok(emitted && Array.isArray(emitted.inv) && emitted.inv.length === 1, 'self 事件仍应带背包列表');
  driver.invDirty = true;
  driver.pushSelf();
  assert.strictEqual(itemsCalls, 2, '背包变更后应重建一次');
});
