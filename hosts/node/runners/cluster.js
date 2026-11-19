// engine/host.js — 多实例宿主进程：worker_threads 每个实例一个 worker，共享本进程基线。
//
// 设计取舍（实测支撑，2026-11-17）：
//   - 单 isolate 共享多引擎内存最省（10 个 ~195MB 真连），但**零隔离**（一崩全崩）——不符合
//     「不影响别的用户」。
//   - worker_threads 每实例独立 isolate：每实例 ~60MB（各加载一份 mineflayer/minecraft-data），
//     但 ① 崩溃隔离（实测 W1 爆堆 ERR_WORKER_OUT_OF_MEMORY，W2/主线程存活）；
//     ② resourceLimits 硬限 JS 堆；③ RSS 自监控限 external/区块缓冲。10 个 ~650MB，达标 1GB/10。
//   - host 进程 detached 独立存活（TOB-488）：agent 死 host 不死，新 agent 按 host.json 接管。
//
// 控制面契约不变：每个 worker 有自己的 §17 HTTP 端口/token，agent 经 host 的 /deploy /undeploy
// 管理实例，经 /instances/:id/… 代理到对应 worker 端口（在 host 内做反代，worker 端口只绑回环）。
import { Worker } from 'node:worker_threads';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const HOST_PORT = Number(process.env.BOTSCRIPT_HOST_PORT) || 25800;
const HOST_TOKEN = process.env.BOTSCRIPT_HOST_TOKEN || crypto.randomBytes(12).toString('hex');
const HOME = process.env.BOTSCRIPT_HOME || process.cwd();

const workers = new Map();   // instanceId → { worker, port, token, epoch }
const exitReport = new Map(); // instanceId → { code, reason }（worker 退出原因，代理结算用）

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = (req, cap = 8 << 20) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > cap) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function writeHostMeta() {
  const list = [...workers.entries()].map(([id, w]) => ({ id, port: w.port, token: w.token, epoch: w.epoch }));
  try {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(path.join(HOME, 'host.json'),
      JSON.stringify({ host_port: HOST_PORT, host_token: HOST_TOKEN, pid: process.pid, instances: list, at: new Date().toISOString() }, null, 2),
      { mode: 0o600 });
  } catch { /* ignore */ }
}

// 启动一个实例 worker（**异步**：立即返回，ready 后台完成、经 /list 或经 /instances/:id/status 探测）。
// 为什么不阻塞等 ready：真实引擎连服要 ~7s + worker 加载 mineflayer ~5s，阻塞式 /deploy 会让
// agent 的部署调用挂很久；agent 本来就用 deploy_ack（异步）确认健康。
async function deployInstance(body) {
  const { instanceId, epoch = 0, dir, memCapMb = 0, dryRun = false } = body;
  if (!instanceId || !dir) throw Object.assign(new Error('instanceId/dir 必填'), { code: 400 });
  if (workers.has(instanceId)) await stopInstance(instanceId);   // 幂等：先停旧的
  // 新代次开始：清掉上一轮的退出记录。否则旧记录会一直留在 exitReport 里，
  // 新 worker 尚在启动（present 瞬时为 false）时 agent 的探活会把「上一轮正常停止」
  // 误读成「本次启动失败」——线上表现就是「实例 worker 退出 code=0（worker 已退出）」。
  exitReport.delete(instanceId);
  const port = await freePort();
  const token = crypto.randomBytes(12).toString('hex');
  // 每实例 JS 堆硬限（isolate 级、V8 强制、可归属）：实测大服引擎 heapUsed ~70MB，默认上限 192MB
  // 覆盖 + 余量；超出即 ERR_WORKER_OUT_OF_MEMORY 只杀本 worker。memCapMb 传 0 用默认。
  // （external/区块缓冲不在 JS 堆内，靠宿主容器 cgroup 总量兜底，非单实例可精确限。）
  const heapCapMb = Math.max(96, memCapMb || 192);
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: { instanceId, dir, memCapMb, httpPort: port, httpToken: token, dryRun: !!dryRun },
    resourceLimits: { maxOldGenerationSizeMb: heapCapMb, maxYoungGenerationSizeMb: 48 },
    stdout: true, stderr: true,
  });
  const w = { worker, port, token, epoch, stopping: false, ready: false, exited: null };
  workers.set(instanceId, w);
  writeHostMeta();
  // worker 的 stdout/stderr 写回宿主 stdout（agent 的 console.log 日志抓取仍有效）
  worker.stdout?.pipe(process.stdout);
  worker.stderr?.pipe(process.stderr);
  worker.on('message', (m) => {
    if (m.t === 'ready') { w.ready = true; }
    if (m.t === 'exit') { w.exitMsg = m; }   // { code, kind, detail, full }
  });
  worker.on('error', (e) => {
    console.error(`[host] worker ${instanceId} 错误:`, e?.code ?? e?.message);
    const oom = e?.code === 'ERR_WORKER_OUT_OF_MEMORY';
    // worker 自身抛出的错误携带分类（用户可自解 / 我们的问题）；OOM 属于可预见（实例内存配额可调）
    const kind = e?.exitKind ?? (oom ? 'foreseeable' : 'internal');
    w.exitMsg = w.exitMsg ?? {
      code: oom ? 137 : 1,
      kind,
      detail: oom ? '实例内存超限：可在实例设置里调高内存上限后重试' : null,
      full: e?.stack ?? (e?.message ?? 'worker error'),
    };
    exitReport.set(instanceId, w.exitMsg);
  });
  worker.on('exit', (code) => {
    const cur = workers.get(instanceId);
    if (cur && cur.worker === worker) {
      if (!cur.stopping) {
        // 没有 exit 消息 = worker 未经 shutdown 就没了（被 terminate / 超限 / 进程内崩溃），
        // 这类属于未预期异常，细节只留在日志里，对用户只给追踪 ID
        const rep = cur.exitMsg ?? {
          code,
          kind: code === 137 ? 'foreseeable' : 'internal',
          detail: code === 137 ? '实例内存超限：可在实例设置里调高内存上限后重试' : null,
          full: `worker exited without exit message (code=${code})`,
        };
        exitReport.set(instanceId, rep);
      }
      workers.delete(instanceId);
      writeHostMeta();
    }
  });
  return { ok: true, port, token, ready: 'pending' };
}

async function stopInstance(instanceId) {
  const w = workers.get(instanceId);
  if (!w) return { ok: true };
  w.stopping = true;   // 标记主动停：worker exit 时不误报 failed
  return await new Promise((resolve) => {
    const to = setTimeout(() => { try { w.worker.terminate(); } catch { /* ignore */ } resolve({ ok: true }); }, 12000);
    w.worker.once('exit', () => { clearTimeout(to); workers.delete(instanceId); writeHostMeta(); resolve({ ok: true }); });
    try { w.worker.postMessage('stop'); } catch { try { w.worker.terminate(); } catch { /* ignore */ } clearTimeout(to); resolve({ ok: true }); }
  });
}

// 代理到某实例 worker 的 §17 端口（控制面 → agent → host → worker）。
// SSE 路径（/stream）必须**流式透传**（8s fetch 超时会掐断长连接）：用 res 直写、逐块转发。
async function proxyToWorker(instanceId, method, enginePath, body, resIn, resOut) {
  const w = workers.get(instanceId);
  if (!w) throw Object.assign(new Error(`实例 ${instanceId} 未在本 host 运行`), { status: 409 });
  const isStream = enginePath.split('?')[0].endsWith('/stream');
  const r = await fetch(`http://127.0.0.1:${w.port}${enginePath}`, {
    method, headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? body : undefined,
    signal: isStream ? undefined : AbortSignal.timeout(8000),   // SSE 不设总超时
  }).catch((e) => { throw Object.assign(new Error(`worker 不可达: ${e.message}`), { status: 502 }); });
  if (isStream && resOut) {
    // 逐块转发到调用方的 res（保持 SSE 头）
    resOut.writeHead(r.status, {
      'Content-Type': r.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    if (r.body) {
      const reader = r.body.getReader();
      const onClose = () => { try { reader.cancel(); } catch { /* ignore */ } };
      resIn?.on('close', onClose);
      resOut.on('error', onClose);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resOut.write(Buffer.from(value));
        }
      } finally { try { resOut.end(); } catch { /* ignore */ } }
    } else resOut.end();
    return null;
  }
  return { status: r.status, body: await r.text() };
}

// host 控制 API：/deploy /undeploy /instances/:id/<enginePath> /list /exit
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const route = u.pathname.replace(/\/+$/, '') || '/';
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${HOST_TOKEN}`) return json(res, 401, { error: 'unauthorized' });

    if (route === '/list') {
      return json(res, 200, {
        instances: [...workers.entries()].map(([id, w]) => ({ id, port: w.port, epoch: w.epoch, ready: !!w.ready })),
      });
    }
    // 单实例状态：ready / 退出原因（agent 部署后轮询就绪与失败原因）
    const sm = route.match(/^\/instances\/([^/]+)\/status$/);
    if (sm) {
      const w = workers.get(sm[1]);
      if (!w) return json(res, 200, { id: sm[1], present: false, exit: exitReport.get(sm[1]) ?? null });
      return json(res, 200, { id: sm[1], present: true, ready: !!w.ready, epoch: w.epoch });
    }
    if (route === '/deploy' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await deployInstance(body);
      return json(res, r.ok ? 200 : 502, r);
    }
    if (route === '/undeploy' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await stopInstance(body.instanceId);
      return json(res, 200, r);
    }
    if (route === '/exit') {
      // agent 关机/迁移前：优雅停所有 worker 并退出 host（保留 host.json 供排查，正常停机删）
      for (const id of [...workers.keys()]) await stopInstance(id);
      return json(res, 200, { ok: true });
    }
    // 代理：/instances/<id>/<enginePath...>
    const m = route.match(/^\/instances\/([^/]+)\/(.+)$/);
    if (m) {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      // SSE（/stream）走流式透传（proxyToWorker 直接写 res）；其余走一次性 JSON
      const r = await proxyToWorker(m[1], req.method, '/' + m[2] + u.search, body, req, res);
      if (r === null) return;   // 流式已自行写 res
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(r.body ?? '');
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = e.status ?? 500;
    if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

server.listen(HOST_PORT, '127.0.0.1', () => {
  writeHostMeta();
  console.log(`[host] listening http://127.0.0.1:${HOST_PORT} pid=${process.pid}`);
});
process.on('SIGINT', async () => {
  for (const id of [...workers.keys()]) await stopInstance(id);
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
