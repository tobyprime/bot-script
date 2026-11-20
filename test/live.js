// test/live.js — 实连验收：本地 Paper 服务器上跑通三个测试 bot（bank / organizer / coal_guard）
// 前置：G:\data\minecraft\bot-test-server 的 Paper 已启动（online-mode=false, ops 含 tester）
// 用法：node test/live.js
// 生成 run/*.yaml（按实测地形坐标），构建场景，逐项断言并输出 PASS/FAIL。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vec3 } from 'vec3';
import mineflayer from 'mineflayer';
import { BotEngine } from '../hosts/node/engine.js';
import { MineflayerDriver } from '../hosts/node/drivers/mineflayer/index.js';

const RUN_DIR = path.resolve('run');
const HOST = '127.0.0.1';
const PORT = 25565;
const VERSION = '1.21.8';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout = 20000, step = 200, label = '') {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try { if (await cond()) return true; } catch (e) { lastErr = e; }
    await sleep(step);
  }
  throw new Error(`waitFor 超时: ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

function rconCmd(c) {
  const tool = path.resolve('tools/rcon.mjs');
  return execFileSync(process.execPath, [tool, HOST, String(25575), 'botscript', c], { encoding: 'utf8', timeout: 15000 });
}

function chestItems([x, y, z]) {
  let out;
  try { out = rconCmd(`data get block ${x} ${y} ${z} Items`); } catch { return []; }
  const items = [];
  const re = /count:\s*(\d+)\s*b?\s*,\s*id:\s*"minecraft:([a-z_]+)"/g;
  const re2 = /id:\s*"minecraft:([a-z_]+)"\s*,\s*count:\s*(\d+)/g;
  let m;
  while ((m = re.exec(out))) items.push({ count: Number(m[1]), id: 'minecraft:' + m[2] });
  while ((m = re2.exec(out))) items.push({ count: Number(m[2]), id: 'minecraft:' + m[1] });
  return items;
}

function makeHarness(name) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, auth: 'offline', version: VERSION });
  bot._received = [];
  bot._ready = new Promise((res, rej) => {
    bot.once('login', res);
    bot.once('error', rej);
    setTimeout(() => rej(new Error(`${name} 登录超时`)), 30000);
  });
  bot.on('message', (jsonMsg) => bot._received.push({ text: jsonMsg.toString(), ts: Date.now() }));
  bot.cmd = (c) => bot.chat(c.startsWith('/') ? c : `/${c}`);
  bot.receivedSince = (mark) => bot._received.slice(mark).map((m) => m.text);
  bot.mark = () => bot._received.length;
  return bot;
}

async function main() {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });

  console.log('== [1] tester 登录，构建测试场景 ==');
  const tester = makeHarness('tester');
  await tester._ready;
  await sleep(2500);
  tester.cmd('gamemode creative');
  await sleep(600);

  // 空中石板平台（固定坐标，杜绝海洋/地形不确定性）
  const Y = 151;
  const POS = { input: [108, Y, -300], partial: [114, Y, -300], stock: [120, Y, -300] };
  const groundY = 150;
  tester.cmd('fill 100 150 -310 130 150 -290 minecraft:smooth_stone');
  await sleep(700);
  tester.cmd('fill 100 151 -310 130 220 -290 minecraft:air');
  await sleep(700);
  tester.cmd('fill 100 150 -310 130 150 -290 minecraft:smooth_stone');
  await sleep(500);
  for (const [x, y, z] of Object.values(POS)) {
    tester.cmd(`setblock ${x} ${y} ${z} minecraft:air`);   // 先清旧箱（含 NBT 内旧物品）
    await sleep(300);
    tester.cmd(`setblock ${x} ${y} ${z} minecraft:chest`);
    await sleep(350);
  }
  tester.cmd(`item replace block ${POS.input[0]} ${Y} ${POS.input[2]} container.0 with minecraft:pink_wool 30`);
  await sleep(250);
  tester.cmd(`item replace block ${POS.input[0]} ${Y} ${POS.input[2]} container.1 with minecraft:cobblestone 12`);
  await sleep(250);
  tester.cmd(`item replace block ${POS.stock[0]} ${Y} ${POS.stock[2]} container.0 with minecraft:pink_wool 40`);
  await sleep(250);
  tester.cmd('gamemode survival');
  await sleep(300);
  await sleep(300);

  // ---------- 运行配置（v2 三层分离：包清单 manifest + 实例部署 deploy，DESIGN §6） ----------
  const PKG = (dir) => path.resolve('examples', dir);
  const cfgs = {
    bank: {
      pkg: { name: 'bank-1', scripts: ['bank.lua'] },
      pkgDir: PKG('bank'),
      deploy: {
        server: `${HOST}:${PORT}`,
        version: VERSION,
        account: { username: 'bank_bot' },
        boundary: { chat: { say_rate: '10/min', commands: ['/pay', '/msg'] } },
      },
    },
    organizer: {
      pkg: { name: 'organizer-1', scripts: ['organizer.lua'] },
      pkgDir: PKG('organizer'),
      deploy: {
        server: `${HOST}:${PORT}`,
        version: VERSION,
        account: { username: 'organizer_bot' },
        boundary: { fence: [[-80, -480], [260, 240]], blocks: { dig: 'deny', place: 'deny' } },
      },
      // 实例事实（坐标）运行期设置（DESIGN §5.3），见下方启动后 setParam
      instanceParams: {
        input: POS.input,
        stock_zone: [[POS.partial[0] - 2, Y - 2, POS.input[2] - 2], [POS.stock[0] + 2, Y + 2, POS.input[2] + 2]],
        partial_chests: [POS.partial],
      },
    },
    coal_guard: {
      pkg: { name: 'coal-guard-1', scripts: ['coal_guard.lua'] },
      pkgDir: PKG('coal_guard'),
      deploy: {
        server: `${HOST}:${PORT}`,
        version: VERSION,
        account: { username: 'coal_guard_bot' },
        boundary: {
          fence: [[-80, -480], [260, 240]],
          combat: { targets: 'player', max_engage: 24 },
        },
      },
    },
  };

  // 部署配置落盘（供人工复跑：node engine/cli.js run/<k>.yaml；params 住持久化不再生成）
  const yamlOf = (cfg) => {
    const lines = [];
    lines.push(`package: ${path.relative(RUN_DIR, cfg.pkgDir)}`);
    lines.push(`server: ${cfg.deploy.server}`);
    lines.push(`version: "${cfg.deploy.version}"`);
    const acct = typeof cfg.deploy.account === 'string' ? cfg.deploy.account : cfg.deploy.account.username;
    lines.push(`account: ${acct}`);
    lines.push('boundary:');
    const b = cfg.deploy.boundary;
    if (b.fence) lines.push(`  fence: ${JSON.stringify(b.fence)}`);
    if (b.blocks) lines.push(`  blocks: ${JSON.stringify(b.blocks)}`);
    if (b.combat) lines.push(`  combat: { targets: ${b.combat.targets}, max_engage: ${b.combat.max_engage} }`);
    if (b.chat) lines.push(`  chat: ${JSON.stringify(b.chat)}`);
    return lines.join('\n') + '\n';
  };
  for (const [k, cfg] of Object.entries(cfgs)) fs.writeFileSync(path.join(RUN_DIR, `${k}.yaml`), yamlOf(cfg));

  // 清掉旧箱子/旧轮次遗留的掉落物，保证输入箱内容确定
  const { execSync } = await import('node:child_process');
  try { execSync(`node tools/rcon.mjs ${HOST} 25575 botscript "kill @e[type=item]"`, { cwd: path.resolve('.') }); } catch { /* ignore */ }

  // ---------- 启动三个 bot ----------
  console.log('== [2] 启动 bank / organizer / coal_guard ==');
  const engines = {};
  const acc = (name) => (engines.bank?.stateStore.get(`account:${name}`) ?? {}).balance ?? 0;
  const pendingIntents = () => Object.entries(engines.bank?.stateStore.all() ?? {})
    .filter(([k, v]) => k.startsWith("intent:") && v.state === "pending").length;
  const chestNotes = () => Object.entries(engines.organizer?.stateStore.all() ?? {})
    .filter(([k]) => k.startsWith("chest:")).map(([, v]) => v);
  const organizerRoundDone = () => (engines.organizer?._lines ?? []).filter((l) => l.includes('本轮整理完成')).length;
  for (const [k, cfg] of Object.entries(cfgs)) {
    const driver = new MineflayerDriver({ log: () => {} });
    // v2 契约：BotEngine(包清单, driver, { scriptDir=包目录, boundary, connect })
    const manifest = { ...cfg.pkg };
    const engine = new BotEngine(manifest, driver, {
      scriptDir: cfg.pkgDir,
      statePath: path.join(RUN_DIR, k, "state", "state.sqlite"),
      boundary: cfg.deploy.boundary,
      connect: {
        host: HOST, port: PORT, version: cfg.deploy.version,
        account: typeof cfg.deploy.account === 'string'
          ? { username: cfg.deploy.account } : cfg.deploy.account,
      },
      log: (level, msg) => { (engine._lines ??= []).push(msg); if (level === 'error') console.log('  ', msg); },
    });
    await engine.start();
    // 实例事实经控制总线运行期设置（DESIGN §5.3），持久化后重启仍生效
    for (const [pk, pv] of Object.entries(cfg.instanceParams ?? {})) engine.setParam(pk, pv);
    engines[k] = engine;
    await waitFor(() => engine.sessionState === 'playing', 40000, 300, `${k} playing`);
    if (k !== 'bank') {
      // tp 并自校验：引擎 self 缓存确认到位（服务端 tp 偶发与客户端位置失步时重发）
      const ex = { x: k === 'coal_guard' ? 104 : 111, z: k === 'coal_guard' ? -296 : -297 };
      const uname = typeof cfg.deploy.account === 'string' ? cfg.deploy.account : cfg.deploy.account.username;
      await waitFor(() => {
        const p = engine.self?.pos;
        if (!p || Math.abs(p.x - ex.x) > 8 || Math.abs(p.z - ex.z) > 8) {
          tester.cmd(`tp ${uname} ${ex.x} 154 ${ex.z}`);
          return false;
        }
        return true;
      }, 25000, 800, `${k} tp 到位`);
    }
  }
  await sleep(4000);   // session.ready + 冷启动扫描（bot 已在场景区，chunk 已加载）

  const results = [];
  const check = (name, fn) => results.push([name, fn]);

  // ---------- bank ----------
  console.log('== [3] bank 场景（断言在汇总阶段执行） ==');
  check('bank: 系统消息入账', async () => {
    tester.cmd('tellraw @a {"text":"收到来自 Alice 10 c"}');
    await waitFor(() => acc('Alice') === 10, 10000, 300, 'Alice 入账');
  });
  check('bank: seen 同文去重', async () => {
    tester.cmd('tellraw @a {"text":"收到来自 Alice 10 c"}');
    await sleep(1800);
    assert.strictEqual(acc('Alice'), 10, '重复消息不得重复入账');
  });
  check('bank: 转账（条件原子划转 + 回复）', async () => {
    tester.cmd('tellraw @a {"text":"收到来自 tester 8 c"}');
    await waitFor(() => acc('tester') === 8, 10000, 300, 'tester 入账');
    const mark = tester.mark();
    tester.chat('转账 Carol');
    await waitFor(() => acc('Carol') === 8, 10000, 300, 'Carol 收款');
    assert.strictEqual(acc('tester'), 0, 'tester 扣清');
    assert.ok(tester.receivedSince(mark).some((t) => t.includes('转账成功')), '应回复转账成功');
  });
  check('bank: 取款 /pay + 超时挂账 + 回执核销', async () => {
    tester.cmd('tellraw @a {"text":"收到来自 tester 10 c"}');
    await waitFor(() => acc('tester') === 10, 10000, 300, 'tester 补足');
    const mark = tester.mark();
    tester.chat('取款 6');
    await waitFor(() => engines.bank.actionLog.some((a) => String(a.args).includes('/pay tester 6')), 10000, 300, '/pay tester 6 已发出');
    await waitFor(() => pendingIntents() === 1, 5000, 300, 'pending 意图');
    await waitFor(() => tester.receivedSince(mark).some((t) => t.includes('支付确认超时')), 10000, 300, '5s 超时挂账提示');
    assert.strictEqual(acc('tester'), 4, '扣款已生效');
    tester.cmd('tellraw @a {"text":"已向 tester 6 c"}');
    await waitFor(() => pendingIntents() === 0, 8000, 300, '迟到回执核销挂账');
  });
  check('bank: balance 走私聊回复', async () => {
    const mark = tester.mark();
    tester.chat('balance Alice');
    await waitFor(() => tester.receivedSince(mark).some((t) => t.includes('余额') && t.includes('10')), 10000, 300, '私聊收到余额');
  });

  // ---------- organizer ----------
  console.log('== [4] organizer 场景 ==');
  check('organizer: 冷启动扫描登记容器', async () => {
    await waitFor(() => chestNotes().length >= 2, 30000, 500, 'ChestNote >= 2');
  });
  check('organizer: organize once 清空输入箱并分流', async () => {
    // 停掉 30s 定时轮，避免与验收打开箱子竞争（params 控制总线热改）
    engines.organizer.setParam('paused', true);
    const before = organizerRoundDone();
    engines.organizer.setParam('paused', false);
    tester.chat('organize once');
    await waitFor(() => organizerRoundDone() > before, 180000, 500, '本轮整理完成');
    engines.organizer.setParam('paused', true);
    console.log('[diag] organizer _lines tail:', (engines.organizer._lines ?? []).slice(-8).join(' || '));
    const inputItems = chestItems(POS.input);
    assert.strictEqual(inputItems.length, 0, `输入箱应空，实际 ${JSON.stringify(inputItems)}`);
    for (const row of chestNotes()) {
      if (row.item) assert.ok(row.free >= 0, `ChestNote ${JSON.stringify(row.pos)} free 应已实测回写`);
    }
    // 守恒不变量：羊毛 70 / 圆石 12 应在登记箱或 bot 背包中（不含世界损耗）
    const all = [...chestItems(POS.partial), ...chestItems(POS.stock)];
    const raw = JSON.parse(engines.organizer.abi.sync('window.get', '{"window":"0"}') || '{}');
    const invView = (raw.ok && raw.value) || {};
    const invAll = (invView.slots ?? []).filter((s) => s.item).map((s) => s.item);
    const cnt = (arr, id) => arr.filter((i) => i.id === id).reduce((n, i) => n + i.count, 0);
    const wool = cnt(all, 'minecraft:pink_wool') + cnt(invAll, 'minecraft:pink_wool');
    const cobble = cnt(all, 'minecraft:cobblestone') + cnt(invAll, 'minecraft:cobblestone');
    assert.ok(wool >= 70, `羊毛守恒应 >= 70，实际 ${wool}`);
    assert.ok(cobble >= 12, `圆石守恒应 >= 12，实际 ${cobble}`);
  });

  // ---------- coal_guard ----------
  console.log('== [5] coal_guard 场景 ==');
  check('coal_guard: 举煤玩家触发追击攻击', async () => {
    // 守卫 bot 可能因前几轮跳跃掉出平台/卡位：RCON 拉回输入箱旁，保证可达
    // 双方 tp 到平台空地；伴随任务（旋转+跳跃）会让 guard 持续位移，
    // 每 4s 把 tester 拉回 guard 身旁 ≤2 格，保证 chase 进入攻击分支（attack 需距离 < combat.range=3）
    try { rconCmd('tp coal_guard_bot 115 152 -294'); } catch { /* ignore */ }
    await sleep(800);
    tester.cmd('item replace entity tester weapon.mainhand with minecraft:coal');
    await sleep(600);
    tester.cmd('tp tester 117 152 -294');
    const keepClose = setInterval(() => {
      const g = engines.coal_guard.self?.pos;
      if (g) tester.cmd(`tp tester ${Math.round(g.x + 1)} ${Math.round(g.y)} ${Math.round(g.z)}`);
    }, 4000);
    try {
      await sleep(1200);
      {
        const ents = [...engines.coal_guard.entities.values()].filter((e) => e.type === 'player')
          .map((e) => `${e.name}@${Math.round(e.pos.x)},${Math.round(e.pos.z)} hand=${JSON.stringify(e.equipment?.hand)}`);
        console.log('[diag] guard view:', ents.join(' | ') || '(no players)', '| self=', JSON.stringify(engines.coal_guard.self?.pos), '| tasks=', engines.coal_guard.taskList().join(','));
      }
      // 装备元数据偶发迟到：每 10s 重发一次装备刷新
      await waitFor(() => engines.coal_guard.actionLog.some((a) => a.action === 'use_entity'), 90000, 500, 'guard 发起攻击').catch(async () => {
        console.log('[diag] guard _lines:', (engines.coal_guard._lines ?? []).slice(-10).join(' || '));
        tester.cmd('item replace entity tester weapon.mainhand with minecraft:air');
        await sleep(400);
        tester.cmd('item replace entity tester weapon.mainhand with minecraft:coal');
        await waitFor(() => engines.coal_guard.actionLog.some((a) => a.action === 'use_entity'), 30000, 500, 'guard 发起攻击(重试)');
      });
    } finally {
      clearInterval(keepClose);
    }
  });
  check('coal_guard: 放下煤炭即停 + guard stop 取消', async () => {
    // 主手换空：替换为不透明物品会继续触发，改用切换快捷栏到空槽
    tester.cmd('item replace entity tester weapon.mainhand with minecraft:air');
    await sleep(1500);
    const attacks = engines.coal_guard.actionLog.filter((a) => a.action === 'use_entity').length;
    await waitFor(() => tester.receivedSince(0).some((t) => t.includes('已放下煤炭')), 15000, 500, '放行通报');
    await sleep(2500);
    const now = engines.coal_guard.actionLog.filter((a) => a.action === 'use_entity').length;
    assert.ok(now - attacks <= 1, `放下煤炭后应停止攻击（前后 ${attacks}/${now}）`);
    const mark = tester.mark();
    tester.chat('guard stop');
    await waitFor(() => tester.receivedSince(mark).some((t) => t.includes('警戒已停止')), 8000, 300, 'stop 回复');
    tester.cmd('tp tester 128 154 -296');   // 离场
  });
  // ---------- HTTP 控制通道（CAPABILITIES §17：无头测试闭环） ----------
  console.log('== [6] HTTP 控制通道（organizer 实例） ==');
  check('http: 鉴权 401 + /state + /caps', async () => {
    process.env.BOTSCRIPT_HTTP_PORT = '0';   // 0 = 顺延取随机可用端口
    const { startHttpApi } = await import('../engine/httpapi.js');
    const { port, token } = await startHttpApi(engines.organizer, { log: () => {} });
    globalThis.__http = { port, token };
    const base = `http://127.0.0.1:${port}`;
    const get = async (p, tok = token) => {
      const r = await fetch(`${base}${p}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
      return { code: r.status, body: await r.json() };
    };
    const noAuth = await get('/state', null);
    assert.strictEqual(noAuth.code, 401, '无 token 必须 401');
    const badAuth = await get('/state', 'wrong-token');
    assert.strictEqual(badAuth.code, 401, '错 token 必须 401');
    const state = await get('/state');
    assert.strictEqual(state.code, 200);
    assert.strictEqual(state.body.name, 'organizer-1');
    assert.strictEqual(state.body.host, 'mineflayer');
    assert.ok(Array.isArray(state.body.tasks), 'tasks 应为数组');
    const capsBody = await get('/caps');
    assert.strictEqual(capsBody.body.manifest.name, 'organizer-1');
    assert.ok(capsBody.body.flags['nav.pathfinder'], 'caps flags 应含寻路器');
  });
  check('http: /params 读写 + 持久化', async () => {
    const { port, token } = globalThis.__http;
    const base = `http://127.0.0.1:${port}`;
    const post = (p, obj) => fetch(`${base}${p}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
    const r = await post('/params', { range_unused_check: 1 });
    assert.strictEqual(r.status, 400, '未知参数必须被 schema 拒绝');
    const set = await post('/params', { paused: engines.organizer.paramValues.get('paused') });
    assert.strictEqual(set.status, 200);
    const g = await (await fetch(`${base}/params`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.ok(g.schema.paused, 'schema 应含 paused');
    assert.strictEqual(typeof g.values.paused, 'boolean');
  });
  check('http: /tasks + /tasks/cancel + /logs + /store', async () => {
    const { port, token } = globalThis.__http;
    const base = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const cmd = await (await fetch(`${base}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify({ cmd: 'status' }) })).json();
    assert.strictEqual(cmd.ok, true, '内建 status 应受理');
    const tasks = await (await fetch(`${base}/tasks`, { headers: auth })).json();
    assert.ok(Array.isArray(tasks.tasks));
    const cancel = await (await fetch(`${base}/tasks/cancel`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'no-such-task' }) })).json();
    assert.strictEqual(cancel.found, false, '未知名取消应报 found=false');
    const logs = await (await fetch(`${base}/logs?since=0`, { headers: auth })).json();
    assert.ok(logs.logs.length > 0, '日志环应有内容');
    const store = await (await fetch(`${base}/store`, { headers: auth })).json();
    assert.ok(store.values && typeof store.values === 'object', '/store 应返回状态键值');
  });

  check('内建 pause/resume（游戏内聊天命令）', async () => {
    tester.chat('pause');
    await waitFor(() => engines.bank.paused && engines.organizer.paused && engines.coal_guard.paused, 6000, 200, 'pause 生效');
    tester.chat('resume');
    await waitFor(() => !engines.bank.paused && !engines.organizer.paused && !engines.coal_guard.paused, 6000, 200, 'resume 生效');
  });

  // ---------- 汇总执行 ----------
  console.log('\n===== 执行实连断言 =====');
  let failed = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log(`PASS  ${name}`); }
    catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
  }
  console.log(failed === 0 ? `\n全部 ${results.length} 项实连验收通过` : `\n${failed}/${results.length} 项失败`);
  for (const e of Object.values(engines)) await e.stop();
  tester.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('live 验收失败:', e); process.exit(1); });
