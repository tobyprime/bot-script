// testing/examples.test.js — 示例包端到端（bank / organizer / coal_guard / afk relay）
import assert from 'node:assert';
import path from 'node:path';
import { test } from './registry.js';
import { TEST_DIR, EXAMPLES, g, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';
import { BotEngine } from '../hosts/node/engine.js';

test('bank：入账/去重/转账/取款挂账/回执核销/私聊余额 全链路', async () => {
  const driver = new MockDriver();
  const engine = new BotEngine({
    name: 'bank-1',
    scripts: [path.join(EXAMPLES, 'bank', 'bank.lua')],
  }, driver, {
    scriptDir: path.join(EXAMPLES, 'bank'),
    boundary: { chat: { commands: ['/pay'], msg_command: '/msg' } },
    connect: { version: '1.21.8' },
    log: () => {},
  });
  await engine.start();
  await new Promise((r) => setTimeout(r, 50));

  driver.serverSay('收到来自 Alice 10 c');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(engine.persist.find('Account', { player: 'Alice' })?.balance, 10, '入账 10');

  driver.serverSay('收到来自 Alice 10 c');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(engine.persist.find('Account', { player: 'Alice' })?.balance, 10, '重复同文应被 seen 去重');

  driver.playerSay('Alice', '转账 Bob');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(engine.persist.find('Account', { player: 'Bob' })?.balance, 10, 'Bob 收到划转');
  assert.strictEqual(engine.persist.find('Account', { player: 'Alice' })?.balance, 0);

  driver.playerSay('Bob', '取款 6');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(driver.outgoingCommands.some((c) => c === '/pay Bob 6'), '应发出白名单内 /pay');
  assert.strictEqual(engine.persist.find('Account', { player: 'Bob' })?.balance, 4, '扣款即时生效');
  assert.strictEqual(engine.persist.logFind('Intent', { state: 'pending' }).length, 1, '回执未到：意图 pending');
  assert.ok(await waitFor(() => driver.outgoingChat.some((m) => m.includes('支付确认超时')), 8000), '5s 超时后挂账告示');
  assert.strictEqual(engine.persist.logFind('Intent', { state: 'pending' }).length, 1, '超时不回滚：保持挂账');

  driver.serverSay('已向 Bob 6 c');
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(engine.persist.logFind('Intent', { state: 'pending' }).length, 0, '迟到回执应收口挂账');

  driver.playerSay('Steve', 'balance Alice');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(driver.outgoingCommands.some((c) => c.startsWith('/msg Steve')), 'balance 应走私聊给操作者');

  await engine.stop();
});

test('organizer：冷启动扫描 + organize once + 输入箱分流', async () => {
  const driver = new MockDriver();
  driver.setContainer({ x: 5, y: 64, z: 5 }, [[0, 'minecraft:pink_wool', 30], [1, 'minecraft:cobblestone', 12]]);
  driver.setContainer({ x: 10, y: 64, z: 5 }, []);
  driver.setContainer({ x: 12, y: 64, z: 5 }, [[3, 'minecraft:pink_wool', 40]]);
  const engine = new BotEngine({
    name: 'organizer-1',
    scripts: [path.join(EXAMPLES, 'organizer', 'organizer.lua')],
    params: {
      input: [5, 64, 5],
      stock_zone: [[9, 62, 3], [14, 66, 7]],
      partial_chests: [[10, 64, 5]],
    },
  }, driver, {
    scriptDir: path.join(EXAMPLES, 'organizer'),
    boundary: { blocks: { dig: 'deny', place: 'deny' } },
    connect: { version: '1.21.8' },
    log: () => {},
  });
  await engine.start();
  await new Promise((r) => setTimeout(r, 2200));   // 等 session.ready 冷启动扫描
  driver.playerSay('Steve', 'organize once');
  const countIn = (k, id) => driver.containerSlots.get(k)
    .reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);
  assert.ok(await waitFor(() => driver.containerSlots.get('5,64,5').every((s) => !s), 20000), '输入箱应被清空');
  const woolTotal = countIn('10,64,5', 'minecraft:pink_wool') + countIn('12,64,5', 'minecraft:pink_wool') + driver.invCount('minecraft:pink_wool');
  assert.strictEqual(woolTotal, 70, `wool 守恒（实际 ${woolTotal}）`);
  const cobbleTotal = countIn('10,64,5', 'minecraft:cobblestone') + countIn('12,64,5', 'minecraft:cobblestone') + driver.invCount('minecraft:cobblestone');
  assert.strictEqual(cobbleTotal, 12, `圆石守恒（实际 ${cobbleTotal}）`);
  await engine.stop();
});

test('coal_guard：举煤触发追击、放下即停、guard stop 取消', async () => {
  const driver = new MockDriver();
  const engine = new BotEngine({
    name: 'coal-guard-1',
    scripts: [path.join(EXAMPLES, 'coal_guard', 'coal_guard.lua')],
  }, driver, {
    scriptDir: path.join(EXAMPLES, 'coal_guard'),
    boundary: { combat: { targets: 'player', max_engage: 24 } },
    connect: { version: '1.21.8' },
    log: () => {},
  });
  await engine.start();
  await new Promise((r) => setTimeout(r, 80));

  driver.addPlayer('Griefer', { x: 10, y: 64, z: 0 }, { id: 'minecraft:coal', count: 1 });
  assert.ok(await waitFor(() => engine.actionLog.some((a) => a.action === 'act.use_entity'), 8000), '应发起追击攻击');
  await new Promise((r) => setTimeout(r, 300));

  driver.setPlayerHeld('Griefer', null);
  assert.ok(await waitFor(() => driver.outgoingChat.some((m) => m.includes('已放下煤炭')), 5000), '应通报放过');
  const attacksAfter = engine.actionLog.filter((a) => a.action === 'act.use_entity').length;
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(engine.actionLog.filter((a) => a.action === 'act.use_entity').length, attacksAfter, '放下煤炭后应停止攻击');

  driver.playerSay('Steve', 'guard stop');
  assert.ok(await waitFor(() => driver.outgoingChat.some((m) => m.includes('警戒已停止')), 3000), 'stop 应回复');
  driver.setPlayerHeld('Griefer', { id: 'minecraft:coal', count: 1 });
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(engine.actionLog.filter((a) => a.action === 'act.use_entity').length, attacksAfter, '取消后不应再攻击');
  await engine.stop();
});

test('afk_guard relay：收款/指令/原文经宿主事件通道上报 + 接收门锚定自身用户名 + pattern 热更校验', async () => {
  const events = [];
  const driver = new MockDriver({ username: 'RelayBot' });
  const engine = new BotEngine({
    name: 'afk-relay-test',
    scripts: [path.join(EXAMPLES, 'afk_guard', 'relay.lua')],
    params: {
      bot_name: '',
      transfer_pattern: { type: 'string', default: '你收到了来自 (%S+) 的 ([%d%.]+) C' },
    },
  }, driver, {
    scriptDir: path.join(EXAMPLES, 'afk_guard'),
    boundary: {},
    connect: { version: '1.21.8' },
    log: () => {},
  });
  engine.subscribeStream((evt) => { if (evt.type === 'event') events.push(evt); });
  await engine.start();
  await new Promise((r) => setTimeout(r, 80));

  const sysChat = (raw) => driver.emit('chat', { text: '', raw, sender: null, sender_kind: 'system', ts: Date.now() });
  const of = (name) => events.filter((e) => e.name === name);

  sysChat('[TSLLLLL] 你收到了来自 Steve 的 12.5 C');
  assert.ok(await waitFor(() => of('pay').length === 1, 3000), '默认参数应产生 pay 事件');
  assert.strictEqual(of('pay')[0].data.payer, 'Steve');
  assert.strictEqual(of('pay')[0].data.amount, 12.5);
  assert.ok(of('chat_line').some((e) => e.data.raw.includes('你收到了来自 Steve')), 'chat_line 原文照旧上报');

  sysChat('[Alice x RelayBot] 余额');
  assert.ok(await waitFor(() => of('tsl_cmd').some((e) => e.data.player === 'Alice'), 3000),
    '接收门空参数应锚定自身用户名');
  const tslCount = of('tsl_cmd').length;
  sysChat('[Alice x OtherBot] 余额');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(of('tsl_cmd').length, tslCount, '非本 bot 私聊不应上报');

  const badPatterns = [
    ['x'.repeat(300), '过长'],
    ['你收到了来自 (%S+ 的 ([%d%.]+) C', '语法'],
    ['(%S+) (%S+) (%S+)', '捕获'],
  ];
  for (const [p, why] of badPatterns) {
    try {
      engine.setParam('transfer_pattern', p);
      assert.fail(`非法 pattern（${why}）应被拒绝`);
    } catch (e) {
      assert.strictEqual(e.kind, 'param.rejected', `${why} 拒绝应 param.rejected`);
      assert.ok(String(e.detail).length > 0, `${why} 错误信息应可读`);
    }
  }
  assert.strictEqual(engine.paramsSnapshot().values.transfer_pattern, '你收到了来自 (%S+) 的 ([%d%.]+) C',
    '被拒后旧 pattern 继续生效');
  sysChat('[TSLLLLL] 你收到了来自 Bob 的 3 C');
  assert.ok(await waitFor(() => of('pay').length === 2, 3000), '被拒热更后旧 pattern 仍工作');

  engine.setParam('transfer_pattern', '(%S+) 给 RelayBot 转了 ([%d%.]+) 金');
  sysChat('Bob 给 RelayBot 转了 3 金');
  assert.ok(await waitFor(() => of('pay').length === 3, 3000), '热更 pattern 即时生效');
  assert.strictEqual(of('pay')[2].data.payer, 'Bob');
  assert.strictEqual(of('pay')[2].data.amount, 3);
  sysChat('[TSLLLLL] 你收到了来自 Steve 的 12.5 C');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(of('pay').length, 3, '旧格式不再命中');

  assert.strictEqual(engine.paramsSnapshot().values.transfer_pattern, '(%S+) 给 RelayBot 转了 ([%d%.]+) 金',
    '重启保留（paramPersist 语义）');

  engine.setParam('transfer_pattern', '');
  sysChat('Bob 给 RelayBot 转了 9 金');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(of('pay').length, 3, '空 pattern 应关闭收款判定');

  await engine.stop();
});
