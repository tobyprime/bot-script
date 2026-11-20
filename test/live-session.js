// test/live-session.js — 实连验收（TOB-489）：§17 POST /session 会话凭据更新（引擎侧）
// 前置：本地 Paper 1.21.8（127.0.0.1:25565，online-mode=false，enable-rcon，
//       rcon.port=25575，rcon.password=botscript）。服务器目录经
//       BOTSCRIPT_TEST_SERVER_DIR 指定（默认 ~/paper-475）；未运行时脚本自行拉起，
//       场景 2 会经 rcon stop 停服并以 spawn 重启它。
// 用法：node test/live-session.js
// 覆盖：playing 中 POST /session → 连接不断、任务不受影响、/state credential_updated_at
//       更新、日志与 /state 无 token 明文；断线退避中 POST /session → 不重置退避，
//       重启服务器后下一次重连使用新 accessToken（驱动侧捕获实证，不复用旧值）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { BotEngine } from '../hosts/node/engine.js';
import { MineflayerDriver } from '../hosts/node/drivers/mineflayer/index.js';
import { startHttpApi } from '../hosts/node/http17.js';

const HOST = '127.0.0.1', PORT = 25565;
const SERVER_DIR = path.resolve(process.env.BOTSCRIPT_TEST_SERVER_DIR ?? path.join(process.env.HOME, 'paper-475'));
const RUN_DIR = path.resolve('run-session');
const TOKEN_OLD = 'live-old-token-DO-NOT-LEAK';
const TOKEN_NEW = 'live-new-token-ROTATED';
const TOKEN_NEWEST = 'live-newest-token-ROTATED-AGAIN';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout, step = 250, label = '') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { if (await cond()) return; } catch (e) { last = e; }
    await sleep(step);
  }
  throw new Error(`waitFor 超时: ${label}${last ? ` (${last.message})` : ''}`);
}
const rcon = (c) => execFileSync(process.execPath, ['tools/rcon.mjs', HOST, '25575', 'botscript', c], { encoding: 'utf8', timeout: 15000 });
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.log(`PASS  ${name}`); }
  catch (e) { results.push(['FAIL', name]); console.log(`FAIL  ${name}: ${e.message}`); }
};

const LUA = `
__ticks = 0
on_start(function() end)
on_timer(1000, function() __ticks = __ticks + 1 end)
`;

let serverProc = null;
async function startServer() {
  await sleep(6000);   // 等旧进程完全退出释放端口（rcon stop 返回后仍需数秒收尾）
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
  serverProc = spawn(java, ['-Xms1G', '-Xmx2G', '-jar', 'paper.jar', 'nogui'], {
    cwd: SERVER_DIR, stdio: ['ignore', 'ignore', 'ignore'],
  });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(1500);
    try { rcon('list'); ready = true; } catch { /* not yet */ }
  }
  if (!ready) throw new Error('服务器 60s 未就绪');
}

async function makeBot(name) {
  const dir = path.join(RUN_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.lua'), LUA);
  const driver = new MineflayerDriver({ log: () => {} });
  // 驱动侧捕获每次 connect 实际收到的 accessToken（重连消费点实证）
  const seenTokens = [];
  const origConnect = driver.connect.bind(driver);
  driver.connect = async (cfg) => {
    seenTokens.push(cfg?.account?.accessToken ?? null);
    return origConnect(cfg);
  };
  const engine = new BotEngine(
    { name, scripts: ['session.lua'], persist: path.join(dir, `${name}.sqlite`) },
    driver,
    {
      scriptDir: dir,
      connect: {
        host: HOST, port: PORT, version: '1.21.8',
        // 平台注入会话形态（auth:'session'）：offline 服只认 username，token 仅 join 期消费
        account: { auth: 'session', username: name, uuid: '11111111-2222-3333-4444-555555555555', accessToken: TOKEN_OLD },
      },
      runtime: { reconnect: { base_ms: 5000, max_ms: 10000 } },   // 压短退避便于实连轮次
      log: () => {},
    },
  );
  await engine.start();
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const state = async () => (await fetch(`http://127.0.0.1:${port}/state`, { headers: hdr })).json();
  const logs = async () => (await (await fetch(`http://127.0.0.1:${port}/logs`, { headers: hdr })).json());
  const postSession = async (body) => fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
  return { engine, driver, seenTokens, state, logs, postSession };
}

const bot = { engine: null };
try {
  await check('前置：服务器就绪 + bot（session 账号）上线 playing', async () => {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
    try { rcon('list'); } catch { await startServer(); }
    Object.assign(bot, await makeBot('sess_a'));
    await waitFor(() => bot.engine.sessionState === 'playing', 40000, 300, 'playing');
    const s = await bot.state();
    if (s.credential_updated_at !== null) throw new Error(`初始 credential_updated_at 应为 null: ${s.credential_updated_at}`);
    if (bot.seenTokens[0] !== TOKEN_OLD) throw new Error(`首连应用旧 token: ${bot.seenTokens[0]}`);
  });

  await check('场景 1：playing 中 POST /session → 200 next_connect，连接不断、任务不受影响', async () => {
    const t0 = Number(bot.engine.lua.lua.global.get('__ticks'));
    const r = await (await bot.postSession({ access_token: TOKEN_NEW })).json();
    if (r.applied !== true || r.effective !== 'next_connect') {
      throw new Error(`响应异常: ${JSON.stringify(r)}`);
    }
    if (bot.engine.paused) throw new Error(`在线 bot 不得 pause（${bot.engine.pauseReason}）`);
    // 在线连接零动作：观察数秒仍 playing，timer 照常走
    const t1 = await waitFor(() => Number(bot.engine.lua.lua.global.get('__ticks')) > t0 + 2, 10000, 250, 'timer 前进')
      .then(() => Number(bot.engine.lua.lua.global.get('__ticks')));
    if (bot.engine.sessionState !== 'playing') throw new Error(`POST 后应保持 playing: ${bot.engine.sessionState}`);
    const s = await bot.state();
    if (!(s.credential_updated_at > 0 && s.credential_updated_at <= Date.now())) {
      throw new Error(`credential_updated_at 应为刚更新: ${s.credential_updated_at}`);
    }
    if (bot.engine.connectCfg.account.accessToken !== TOKEN_NEW) throw new Error('connectCfg 未写入新 token');
    console.log(`  playing 保持，ticks ${t0}->${t1}，credential_updated_at 已落 /state`);
  });

  await check('场景 1b：token 明文不出现在 /logs 与 /state', async () => {
    const dump = JSON.stringify(await bot.logs()) + JSON.stringify(await bot.state());
    for (const t of [TOKEN_OLD, TOKEN_NEW, TOKEN_NEWEST]) {
      if (dump.includes(t)) throw new Error('发现 token 明文泄露');
    }
  });

  await check('场景 2：rcon stop 断线 → 退避中 POST /session → 200 next_reconnect 且不重置退避', async () => {
    rcon('stop');
    await waitFor(() => bot.engine.paused && (bot.engine.pauseReason === 'disconnect' || bot.engine.pauseReason === 'kicked'),
      20000, 200, 'disconnect pause');
    await waitFor(() => bot.engine.reconnectDueAt != null, 5000, 100, '退避计划');
    const attemptsBefore = bot.engine.reconAttempts;
    const dueBefore = bot.engine.reconnectDueAt;
    const r = await (await bot.postSession({ access_token: TOKEN_NEWEST, username: 'sess_a' })).json();
    if (r.applied !== true || r.effective !== 'next_reconnect') {
      throw new Error(`响应异常: ${JSON.stringify(r)}`);
    }
    if (bot.engine.reconAttempts !== attemptsBefore) throw new Error('POST /session 不得重置退避计数');
    if (bot.engine.reconnectDueAt !== dueBefore) throw new Error('POST /session 不得打断在途重连计划');
  });

  await check('场景 2b：重启服务器 → 自动重连 playing，且重连消费的是新 accessToken 而非旧值', async () => {
    await startServer();
    await waitFor(() => bot.engine.sessionState === 'playing', 150000, 500, '重连 playing');
    if (bot.engine.paused !== false) throw new Error('重连成功应自动 resume');
    if (bot.engine.reconAttempts !== 0) throw new Error(`playing 后 attempts 应清零: ${bot.engine.reconAttempts}`);
    // seenTokens[0]=首连旧值；重连后最后一次 connect 必须携带 TOKEN_NEWEST
    const last = bot.seenTokens[bot.seenTokens.length - 1];
    if (last !== TOKEN_NEWEST) throw new Error(`重连应使用新 token，实际 ${last}（seen=${JSON.stringify(bot.seenTokens)}）`);
    // 旧 token 只允许出现在首连（轮换前）；其后任何一次 connect 均不得复用旧值
    if (bot.seenTokens.slice(1).includes(TOKEN_OLD)) {
      throw new Error(`重连复用了旧 token: ${JSON.stringify(bot.seenTokens)}`);
    }
    console.log(`  connect 序列 token: ${bot.seenTokens.map((t) => (t === TOKEN_OLD ? 'OLD' : t === TOKEN_NEWEST ? 'NEWEST' : t === TOKEN_NEW ? 'NEW' : '?')).join(' -> ')}`);
  });
} finally {
  if (bot.engine) await bot.engine.stop().catch(() => {});
  if (serverProc) { try { serverProc.kill(); } catch {} }
}
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(failed === 0 ? `\n全部 ${results.length} 项 /session 实连验收通过` : `\n${failed}/${results.length} 项失败`);
process.exit(failed === 0 ? 0 : 1);
