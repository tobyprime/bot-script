// engine/worker.js — 单实例 worker（host.js 用 worker_threads 拉起，每个实例一个）。
//
// 为什么 worker 而不是同进程多引擎：用户要求「每实例限内存 + 不影响别的实例」。
// worker_threads 每个是独立 V8 isolate——①可设 resourceLimits 硬限 JS 堆；
// ②崩溃隔离（实测一个 worker 爆堆 ERR_WORKER_OUT_OF_MEMORY，其他 worker 与主线程存活）；
// ③RSS 自监控只杀超限者。代价是每 worker 各加载一份 mineflayer（每实例 ~60MB）。
//
// 与 cli.js 行为一致：同一实例目录（deploy.yaml + package + data），同一 §17 HTTP 控制通道
// （每实例仍有自己的端口/token，控制面代理契约不变）。区别：不读 stdin（父 worker 经 IPC 控制），
// 退出时把原因经 IPC 报给父进程，供 agent 生成可读的 failed detail。
import { readFileSync } from 'node:fs';
import { workerData, parentPort } from 'node:worker_threads';
import path from 'node:path';
import { parse } from 'yaml';
import { BotEngine } from './engine.js';
import { startHttpApi } from './httpapi.js';

const { instanceId, dir, memCapMb, httpPort, httpToken, dryRun } = workerData;
const abs = path.resolve(dir, 'deploy.yaml');
const deploy = parse(readFileSync(abs, 'utf8')) ?? {};
const pkgDir = path.resolve(path.dirname(abs), deploy.package ?? '.');
const pkg = parse(readFileSync(path.join(pkgDir, 'bot.yaml'), 'utf8')) ?? {};

function parseServer(s) {
  if (typeof s === 'string') { const [host, port] = s.split(':'); return { host: host || '127.0.0.1', port: port ? Number(port) : 25565 }; }
  return { host: s?.host ?? '127.0.0.1', port: s?.port ?? 25565 };
}
const server = parseServer(deploy.server);
const account = typeof deploy.account === 'string' ? { username: deploy.account } : (deploy.account ?? {});
const connect = {
  host: server.host, port: server.port,
  version: deploy.version ?? deploy.server_version,
  account,
  viewDistance: Math.max(2, Math.min(12, Number(deploy.view_distance) || 6)),
};
const pkgAbs = { ...pkg, persist: pkg.persist ? path.resolve(path.dirname(abs), pkg.persist) : ':memory:' };

let engine = null;
let stopped = false;
const send = (msg) => { try { parentPort.postMessage(msg); } catch { /* 父已退 */ } };

// 退出上报：kind 是分类语义，detail 是给用户看的可读文案，full 只进内部日志。
//   user        用户主动停止（console stop / undeploy）
//   foreseeable 可预见的用户侧问题（登录失败、被踢、脚本运行时错误、内存超限…）
//   internal    未预期异常（我们的问题）：用户只看得到一个追踪 ID，细节留给日志
const shutdown = async ({ code = 0, kind = 'internal', detail = null, full = null } = {}) => {
  if (stopped) return;
  stopped = true;
  try { await engine?.stop(); } catch { /* ignore */ }
  send({ t: 'exit', instance: instanceId, code, kind, detail, full });
  process.exit(code);
};
// 父进程要求停机（agent 下发 undeploy）：优雅停。
parentPort.on('message', (m) => {
  if (m === 'stop') shutdown({ code: 0, kind: 'user', detail: '实例已停止' });
  else if (m && m.t === 'cmd') { try { engine.dispatchCommand(String(m.cmd ?? ''), null, true); } catch { /* ignore */ } }
});

async function main() {
  const { MineflayerDriver } = await import('../drivers/mineflayer/index.js');
  const driver = new MineflayerDriver({ log: (m) => (engine ? engine.log('console', String(m)) : console.log(m)) });
  engine = new BotEngine(pkgAbs, driver, {
    scriptDir: pkgDir,
    boundary: deploy.boundary ?? null,
    runtime: deploy.runtime ?? {},
    instanceParams: deploy.params ?? {},
    dryRun: !!dryRun,
    connect,
  });
  // 每实例内存上限靠父进程的 resourceLimits.maxOldGenerationSizeMb（isolate 级、V8 强制、可归属）。
  // 不用 process.memoryUsage().rss 自监控：worker 共享宿主地址空间，rss 是**整进程**总和（实测每个
  // worker 都看到 253MB），无法归属到单个实例，用它做每实例上限会一启动全误判。JS 堆超出
  // resourceLimits 时 V8 抛 ERR_WORKER_OUT_OF_MEMORY，只杀本 worker（实测隔离成立）。
  // 注：external/区块/网络缓冲不在 JS 堆内、不受 resourceLimits 约束——这部分由宿主进程的
  // 容器 cgroup 总上限兜底（AGENT_MEM_LIMIT），不能按单实例精确限。
  void memCapMb;

  // 每实例独立 §17 端口/token（父进程分配），控制面经 agent → 父进程 → 本 worker 代理。
  await engine.start();
  await startHttpApi(engine, { log: (level, msg) => console.log(`[${level}] ${msg}`), port: httpPort, token: httpToken });
  send({ t: 'ready', instance: instanceId });
}
main().catch((e) => {
  // 启动失败要区分「用户的包/配置问题」与「我们自己的问题」：
  // 前者给可执行提示（用户能自己改），后者只留追踪 ID、细节进日志。
  const message = String(e?.message ?? e);
  const kind = e?.kind;   // 引擎抛出的类型化错误（lua.compile / persist.* / param.* 等）
  const full = `${message}${e?.stack ? `\n${String(e.stack).split('\n').slice(0, 6).join('\n')}` : ''}`;
  console.error(`[worker:${instanceId}] 启动失败 kind=${kind ?? ''}:`, full);
  if (kind === 'lua.compile') {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'foreseeable', detail: '脚本编译失败：请检查包的 Lua 源码', full });
  } else if (String(kind ?? '').startsWith('param.')) {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'foreseeable', detail: '实例参数不合法：请检查参数配置', full });
  } else if (/bot\.yaml|manifest|deploy\.yaml|ENOENT/.test(message)) {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'foreseeable', detail: '程序包或部署配置不完整：请重新上传程序包', full });
  } else {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'internal', detail: null, full });
  }
  process.exit(1);
});
