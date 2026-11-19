// testing/http.test.js — §17 控制通道（鉴权/状态/params/pause/resume/tasks/logs/persist/caps/eval/SSE/chat/session）
import assert from 'node:assert';
import { test } from './registry.js';
import { makeEngine, script, waitFor } from './harness.js';
import { MockDriver } from './mock-driver.js';

async function startApi(engine) {
  process.env.BOTSCRIPT_HTTP_PORT = '0';
  const { startHttpApi } = await import('../hosts/node/http17.js');
  return startHttpApi(engine, { log: () => {} });
}

test('http17：鉴权/状态/params/pause/resume/tasks/logs/persist/caps/eval 全链', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    boundary: { authority: { op: ['Steve'] }, chat: { commands: ['/pay'] } },
    yaml: { params: { num_opt: { type: 'number', default: 7 } } },
  });
  const { port, token } = await startApi(engine);
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  assert.strictEqual((await fetch(base + '/state')).status, 401, '无 token 401');
  assert.strictEqual((await fetch(base + '/state', { headers: { Authorization: 'Bearer nope' } })).status, 401);

  const state = (await (await fetch(base + '/state', { headers: hdr })).json());
  assert.strictEqual(state.name, 'test-bot');
  assert.strictEqual(state.host, 'node');
  assert.ok('nav.pathfinder' in state.caps);

  assert.strictEqual((await fetch(base + '/params', { method: 'POST', headers: hdr, body: '{"nope":1}' })).status, 400);
  const pset = await (await fetch(base + '/params', { method: 'POST', headers: hdr, body: '{"num_opt":9}' })).json();
  assert.strictEqual(pset.changed.num_opt, 9);
  assert.strictEqual(engine.paramsSnapshot().values.num_opt, 9);

  const pause = await (await fetch(base + '/pause', { method: 'POST', headers: hdr, body: '{"reason":"test"}' })).json();
  assert.strictEqual(pause.paused, true, '/pause 应暂停实例');
  const resume = await (await fetch(base + '/resume', { method: 'POST', headers: hdr, body: '{}' })).json();
  assert.strictEqual(resume.paused, false, '/resume 应恢复实例');

  const tasks = (await (await fetch(base + '/tasks', { headers: hdr })).json()).tasks;
  assert.ok(Array.isArray(tasks));
  const cancel = (await (await fetch(base + '/tasks/cancel', { method: 'POST', headers: hdr, body: '{"name":"ghost"}' })).json());
  assert.strictEqual(cancel.found, false);

  const l1 = (await (await fetch(base + '/logs', { headers: hdr })).json());
  assert.ok(l1.logs.length > 0, '日志环应有启动日志');
  const l2 = (await (await fetch(base + `/logs?since=${Date.now() + 1000}`, { headers: hdr })).json());
  assert.strictEqual(l2.logs.length, 0, 'since 未来时刻应无增量');

  engine.persist.declareTable('T', { k: 'string:key', v: 'number' });
  engine.persist.upsert('T', { k: 'a', v: 1 });
  const rows = (await (await fetch(base + '/persist?table=T', { headers: hdr })).json()).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual((await fetch(base + '/persist?table=Nope', { headers: hdr })).status, 400);

  const capsBody = (await (await fetch(base + '/caps', { headers: hdr })).json());
  assert.strictEqual(capsBody.host, 'node');
  assert.strictEqual(capsBody.manifest.name, 'test-bot');
  assert.ok(Array.isArray(capsBody.patches), '/caps 应列出已应用补丁');

  // eval：一次性 Lua 作为具名任务（同环境；返回值入日志；编译错误 400；运行失败进任务日志）
  const ev = await (await fetch(base + '/eval', { method: 'POST', headers: hdr, body: '{"name":"t1","code":"return 42"}' })).json();
  assert.strictEqual(ev.ok, true);
  assert.strictEqual(ev.task, 't1');
  const msgs = async () => (await (await fetch(base + '/logs', { headers: hdr })).json()).logs.map((l) => l.msg);
  assert.ok((await msgs()).some((m) => m.includes('[eval:t1] => 42')), 'eval 返回值应入日志');
  assert.strictEqual(
    (await fetch(base + '/eval', { method: 'POST', headers: hdr, body: '{"code":"return ~"}' })).status,
    400, '编译错误应 400',
  );
  await (await fetch(base + '/eval', { method: 'POST', headers: hdr, body: '{"name":"t2","code":"error(\\"boom\\")"}' })).json();
  assert.ok(await waitFor(async () => (await msgs()).some((m) => m.includes('t2') && m.includes('失败')), 3000),
    'eval 运行失败应进日志');

  await engine.stop();
});

test('http17：实时流 /stream（补历史 + 实时增量）、聊天入站/出站、/chat 门控', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    boundary: { chat: { commands: ['/say'] } },
  });
  const { port, token } = await startApi(engine);
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  driver.playerSay('Steve', 'hello world');
  await new Promise((r) => setTimeout(r, 50));
  let logs = await (await fetch(base + '/logs', { headers: hdr })).json();
  assert.ok(logs.chats.some((c) => c.text === 'hello world' && c.sender));
  assert.ok(logs.logs.every((l) => typeof l.seq === 'number'), '环形日志应带单调 seq');

  const seen = [];
  const unsub = engine.subscribeStream((e) => seen.push(e));
  const lastSeq = engine.streamSeq;

  const ctrl = new AbortController();
  const res = await fetch(base + `/stream?since_seq=${lastSeq}`, { headers: hdr, signal: ctrl.signal });
  assert.strictEqual(res.headers.get('content-type')?.includes('text/event-stream'), true);
  const events = [];
  const reader = res.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
      }
    }
  })();

  const ok = await fetch(base + '/chat', { method: 'POST', headers: hdr, body: JSON.stringify({ text: '/say hi' }) });
  assert.strictEqual(ok.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  const selfEvt = seen.find((e) => e.type === 'chat' && e.sender_kind === 'self');
  assert.ok(selfEvt && selfEvt.text === '/say hi', '出站消息应以 sender_kind=self 进实时流');
  assert.ok(events.some((e) => e.type === 'chat' && e.sender_kind === 'self'), 'SSE 应实时收到出站消息');

  const opCmd = await fetch(base + '/chat', { method: 'POST', headers: hdr, body: JSON.stringify({ text: '/kill Steve' }) });
  assert.strictEqual(opCmd.status, 200, '操作者命令不应被脚本白名单拦截');
  assert.ok(driver.outgoingCommands.includes('/kill Steve'), '操作者命令应真的发出去（不受白名单限制）');
  const empty = await fetch(base + '/chat', { method: 'POST', headers: hdr, body: JSON.stringify({ text: '   ' }) });
  assert.strictEqual(empty.status, 400);

  assert.throws(
    () => engine.checkChatPolicy('/kill Steve'),
    (e) => e && e.kind === 'permission.denied',
    '脚本动作路径仍必须过命令白名单',
  );

  ctrl.abort();
  await pump.catch(() => {});
  unsub();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(engine.obs._streamSubs.size, 0, '断开后实时流订阅必须释放');

  await engine.stop();
});

const SESSION_ACCOUNT = { auth: 'session', username: 'BotOne', uuid: '00000000-0000-0000-0000-0000000000f1', accessToken: 'old-token-DO-NOT-LEAK' };

test('http17-conformance：OpenAPI 路由表全部实现（不得 404/405）', async () => {
  const { ROUTES } = await import('../hosts/node/http17.routes.generated.js');
  const driver = new MockDriver();
  const { engine } = await makeEngine({ scripts: [], driver, boundary: {} });
  const { port, token } = await startApi(engine);
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const bodies = {
    postParams: '{"num_opt":1}',
    postPause: '{"reason":"x"}',
    postResume: '{}',
    postEval: '{"code":"return 1"}',
    postEvent: '{"type":"x","data":{}}',
    postSession: '{"access_token":"x"}',
    postTasksCancel: '{"name":"ghost"}',
    postChat: '{"text":"hi"}',
  };
  for (const r of ROUTES) {
    if (r.path === '/stream') continue;   // SSE 由上一用例覆盖（长连接）
    const res = await fetch(base + r.path, {
      method: r.method,
      headers: hdr,
      body: r.method === 'POST' ? (bodies[r.operationId] ?? '{}') : undefined,
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(![404, 405].includes(res.status),
      `${r.method} ${r.path}（${r.operationId}）未实现（状态 ${res.status}）`);
    await res.text();
  }
  await engine.stop();
});

test('POST /session：鉴权 401、方法 405、参数 400、非 session 账号 409、身份不匹配 409', async () => {
  const driver = new MockDriver();
  const { engine: offlineEngine } = await makeEngine({
    scripts: [],
    driver,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { username: 'OfflineBot' } } },
  });
  const { port, token } = await startApi(offlineEngine);
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  assert.strictEqual((await fetch(base + '/session', { method: 'POST', body: '{"access_token":"x"}' })).status, 401, '无 token 401');
  assert.strictEqual(
    (await fetch(base + '/session', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{"access_token":"x"}' })).status,
    401, '错 token 401',
  );
  assert.strictEqual((await fetch(base + '/session', { headers: hdr })).status, 405, 'GET 应 405');
  const r409res = await fetch(base + '/session', { method: 'POST', headers: hdr, body: '{"access_token":"x"}' });
  assert.strictEqual(r409res.status, 409, 'offline 账号应 409');
  assert.strictEqual((await r409res.json()).error, 'session.account_mode');
  await offlineEngine.stop();

  const driver2 = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver: driver2,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { ...SESSION_ACCOUNT } } },
  });
  const api2 = await startApi(engine);
  const base2 = `http://127.0.0.1:${api2.port}`;
  const hdr2 = { Authorization: `Bearer ${api2.token}`, 'Content-Type': 'application/json' };

  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{}' })).status, 400, '缺 access_token 应 400');
  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":""}' })).status, 400, '空串应 400');
  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":42}' })).status, 400, '非字符串应 400');
  const rMis = await (await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":"x","username":"Wrong"}' })).json();
  assert.strictEqual((await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":"x","username":"Wrong"}' })).status, 409, 'username 不匹配应 409');
  assert.strictEqual(rMis.error, 'session.identity_mismatch');
  assert.strictEqual(
    (await fetch(base2 + '/session', { method: 'POST', headers: hdr2, body: '{"access_token":"x","uuid":"ffffffff-0000-0000-0000-000000000000"}' })).status,
    409, 'uuid 不匹配应 409',
  );
  assert.strictEqual(engine.connectCfg.account.accessToken, SESSION_ACCOUNT.accessToken, '被拒请求不得改写凭据');
  await engine.stop();
});

test('POST /session：写入 connectCfg、幂等 200、生效语义 playing=next_connect / 断线=next_reconnect、不重置退避', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { ...SESSION_ACCOUNT } } },
    runtime: { reconnect: { base_ms: 100, max_ms: 200 } },
  });
  const { port, token } = await startApi(engine);
  const base = `http://127.0.0.1:${port}`;
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = (body) => fetch(base + '/session', { method: 'POST', headers: hdr, body: JSON.stringify(body) });

  assert.strictEqual(engine.sessionState, 'playing', '前置：MockDriver 连接后 playing');
  assert.strictEqual((await (await post({ access_token: 'new-token-a' })).json()).applied, true);
  assert.strictEqual(engine.connectCfg.account.accessToken, 'new-token-a', '凭据应写入 connectCfg.account.accessToken');

  assert.strictEqual((await post({ access_token: 'new-token-a' })).status, 200, '同值重复 POST 应 200');

  const rPlay = await (await post({ access_token: 'new-token-b' })).json();
  assert.strictEqual(rPlay.effective, 'next_connect', 'playing 态应报 next_connect');
  assert.strictEqual(engine.sessionState, 'playing', '更新凭据不得打断在线连接');

  const state = await (await fetch(base + '/state', { headers: hdr })).json();
  assert.ok(Number.isFinite(state.credential_updated_at) && state.credential_updated_at > 0, 'credential_updated_at 应为时间戳');
  assert.ok(!JSON.stringify(state).includes('new-token'), '/state 不得泄露 token 明文');

  driver.emit('session', { state: 'disconnected', reason: 'x' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(engine.reconAttempts, 1);
  const dueBefore = engine.reconnectDueAt;
  const rDisc = await (await post({ access_token: 'new-token-c' })).json();
  assert.strictEqual(rDisc.effective, 'next_reconnect', '断线态应报 next_reconnect');
  assert.strictEqual(engine.reconAttempts, 1, 'POST /session 不得重置退避计数');
  assert.strictEqual(engine.reconnectDueAt, dueBefore, 'POST /session 不得打断在途重连计划');
  assert.strictEqual(engine.connectCfg.account.accessToken, 'new-token-c');

  const seen = [];
  const origConnect = driver.connect.bind(driver);
  driver.connect = async (cfg) => { seen.push(cfg?.account?.accessToken); return origConnect(cfg); };
  assert.ok(await waitFor(() => seen.length >= 1, 3000), '退避到期应发起重连');
  assert.strictEqual(seen[0], 'new-token-c', '重连必须使用新 accessToken 而非旧值');
  await engine.stop();
});

test('POST /session：日志与 /state 全程无 token 明文', async () => {
  const driver = new MockDriver();
  const { engine } = await makeEngine({
    scripts: [],
    driver,
    yaml: { connect: { host: '127.0.0.1', port: 25565, account: { ...SESSION_ACCOUNT } } },
  });
  const { port, token } = await startApi(engine);
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const SECRET = 'super-secret-token-xyz';
  await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: hdr, body: JSON.stringify({ access_token: SECRET }) });
  const logs = (await (await fetch(`http://127.0.0.1:${port}/logs`, { headers: hdr })).json());
  const all = JSON.stringify(logs) + JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/state`, { headers: hdr })).json());
  assert.ok(!all.includes(SECRET), '日志与 /state 不得出现 token 明文');
  assert.ok(!all.includes(SESSION_ACCOUNT.accessToken), '旧 token 明文同样不得出现');
  await engine.stop();
});
