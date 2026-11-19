// test/live-reconnect.js — 实连验收（TOB-475）：断线重连健壮化
// 前置：本地 Paper 1.21.8 已启动（127.0.0.1:25565，online-mode=false，
//       enable-rcon，rcon.port=25575，rcon.password=botscript，JAVA_HOME≥21）。
//       脚本会经 rcon stop 停服并以 spawn 重启它（服务器目录经
//       BOTSCRIPT_TEST_SERVER_DIR 指定，默认 ~/paper-475）。
// 用法：node test/live-reconnect.js
// 覆盖：断线自动 pause + 旧会话缓存清空、退避 jitter（双 bot 错峰 + /state 可观测）、
//       pause 期 timer 冻结、重启服务器后自动重连 playing + 自动 resume + attempts 清零。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { BotEngine } from '../hosts/node/engine.js';
import { MineflayerDriver } from '../hosts/node/drivers/mineflayer/index.js';
import { startHttpApi } from '../hosts/node/http17.js';

const HOST = '127.0.0.1', PORT = 25565;
const SERVER_DIR = path.resolve(process.env.BOTSCRIPT_TEST_SERVER_DIR ?? path.join(process.env.HOME, 'paper-475'));
const RUN_DIR = path.resolve('run-reconnect');
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

async function makeBot(name) {
  const dir = path.join(RUN_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'recon.lua'), LUA);
  const driver = new MineflayerDriver({ log: () => {} });
  const engine = new BotEngine(
    { name, scripts: ['recon.lua'], persist: path.join(dir, `${name}.sqlite`) },
    driver,
    {
      scriptDir: dir,
      connect: { host: HOST, port: PORT, version: '1.21.8', account: { username: name } },
      log: () => {},
    },
  );
  await engine.start();
  const { port, token } = await startHttpApi(engine, { log: () => {} });
  const state = async () => (await fetch(`http://127.0.0.1:${port}/state`, { headers: { Authorization: `Bearer ${token}` } })).json();
  return { engine, state };
}

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

let bots;
let delays = [];
try {
  await check('前置：双 bot 上线 playing + /state 可读', async () => {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
    bots = [await makeBot('recon_a'), await makeBot('recon_b')];
    for (const b of bots) await waitFor(() => b.engine.sessionState === 'playing', 40000, 300, 'playing');
    await sleep(3000);   // 等世界观测灌入
    for (const b of bots) {
      const s = await b.state();
      if (s.reconnecting !== false || s.reconnect_attempts !== 0 || s.next_retry_in !== null) {
        throw new Error(`playing 态 /state 异常: ${JSON.stringify({ reconnecting: s.reconnecting, reconnect_attempts: s.reconnect_attempts, next_retry_in: s.next_retry_in })}`);
      }
    }
    console.log('  recon_a 缓存面: entities=%d world=%d windows=%d',
      bots[0].engine.driver.query_entities?.().length ?? 0, bots[0].engine.world.cache.size, bots[0].engine.windows.windows.size);
  });

  for (let round = 1; round <= 2; round++) {
    await check(`第 ${round} 轮：rcon stop → 断线 pause + 缓存清空 + /state 退避可观测`, async () => {
      rcon('stop');
      // rcon stop 服务器会踢出 bot：pauseReason 为 'kicked'；链路故障（崩服/断网）才是 'disconnect'，两者都应 pause
      for (const b of bots) await waitFor(() => b.engine.paused && (b.engine.pauseReason === 'disconnect' || b.engine.pauseReason === 'kicked'), 20000, 200, 'disconnect pause');
      const ticks0 = bots.map((b) => Number(b.engine.lua.lua.global.get('__ticks')));
      for (const b of bots) {
        if ((b.engine.driver.query_entities?.().length ?? 0) || b.engine.windows.windows.size || b.engine.world.cache.size || b.engine.currentWindowId !== null) {
          throw new Error(`断线后缓存未清空: entities=${b.engine.driver.query_entities?.().length ?? 0} windows=${b.engine.windows.windows.size} world=${b.engine.world.cache.size} winId=${b.engine.currentWindowId}`);
        }
        const s = await b.state();
        if (s.reconnecting !== true) throw new Error(`reconnecting 应为 true: ${s.reconnecting}`);
        if (s.reconnect_attempts < 1) throw new Error(`attempts 应 >=1: ${s.reconnect_attempts}`);
        if (!(s.next_retry_in >= 0)) throw new Error(`next_retry_in 应为有限毫秒: ${s.next_retry_in}`);
        const due = s.reconnect_attempts === 1 ? [24000, 36000] : [48000, 72000];
        if (s.next_retry_in > due[1]) throw new Error(`next_retry_in=${s.next_retry_in} 超出退避带 ${JSON.stringify(due)}`);
        delays.push(s.next_retry_in);
      }
      // pause 冻结 timer：断线暂停期 on_timer 不再走
      await sleep(4000);
      const ticks1 = bots.map((b) => Number(b.engine.lua.lua.global.get('__ticks')));
      if (bots.some((b, i) => ticks1[i] !== ticks0[i])) throw new Error(`暂停期 timer 未冻结: ${ticks0} -> ${ticks1}`);
      console.log(`  attempts=${bots.map((b) => b.engine.reconAttempts)} next_retry_in=[${delays.slice(-2)}] 暂停期 ticks 冻结 ${ticks0}->${ticks1}`);
    });

    await check(`第 ${round} 轮：重启服务器 → 自动重连 playing + 自动 resume + attempts 清零`, async () => {
      await startServer();
      for (const b of bots) await waitFor(() => b.engine.sessionState === 'playing', 150000, 500, '重连 playing');
      for (const b of bots) {
        if (b.engine.paused !== false) throw new Error('重连成功应自动 resume');
        if (b.engine.reconAttempts !== 0) throw new Error(`playing 后 attempts 应清零: ${b.engine.reconAttempts}`);
        const s = await b.state();
        if (s.reconnecting !== false || s.reconnect_attempts !== 0 || s.next_retry_in !== null) {
          throw new Error(`playing 态 /state 未复位: ${JSON.stringify(s)}`);
        }
      }
      // resume 后 timer 恢复
      const t0 = bots.map((b) => Number(b.engine.lua.lua.global.get('__ticks')));
      await sleep(2500);
      const t1 = bots.map((b) => Number(b.engine.lua.lua.global.get('__ticks')));
      if (bots.some((b, i) => t1[i] <= t0[i])) throw new Error(`resume 后 timer 未恢复: ${t0} -> ${t1}`);
      console.log('  重连成功，attempts 清零，ticks 恢复行走', t0, '->', t1);
    });
  }

  await check('jitter 散布：多次断线退避延迟不同（非固定 30s），且均在 ±20% 带内', async () => {
    const band = delays.every((d) => d >= 24000 && d <= 36000);
    if (!band) throw new Error(`延迟超出 ±20% 带: ${delays}`);
    if (new Set(delays).size < 2) throw new Error(`延迟无散布: ${delays} —— 疑似固定退避`);
    console.log(`  退避延迟样本: [${delays.join(', ')}] ms —— 均在 24s~36s 带内且互不相同`);
  });
} finally {
  for (const b of bots ?? []) await b.engine.stop().catch(() => {});
  if (serverProc) { try { serverProc.kill(); } catch {} }
}
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(failed === 0 ? `\n全部 ${results.length} 项重连实连验收通过` : `\n${failed}/${results.length} 项失败`);
process.exit(failed === 0 ? 0 : 1);
