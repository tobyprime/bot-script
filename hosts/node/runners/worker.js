// hosts/node/runners/worker.js — 单实例 worker（cluster.js 用 worker_threads 拉起）
//
// 为什么 worker 而不是同进程多引擎：worker_threads 每个是独立 V8 isolate——
// ①可设 resourceLimits 硬限 JS 堆；②崩溃隔离；③RSS 自监控只杀超限者。
//
// 与 cli.js 同一 deploy.js/engineOptions：同一实例目录、同一 §17 HTTP 控制通道。
// 区别：不读 stdin（父 worker 经 IPC 控制），退出时把原因经 IPC 报给父进程。
import { workerData, parentPort } from 'node:worker_threads';
import path from 'node:path';
import { loadInstance, engineOptions } from '../deploy.js';
import { BotEngine } from '../engine.js';
import { startHttpApi } from '../http17.js';

const { instanceId, dir, httpPort, httpToken, dryRun } = workerData;
const inst = loadInstance(path.join(path.resolve(dir), 'deploy.yaml'));

let engine = null;
let stopped = false;
const send = (msg) => { try { parentPort?.postMessage(msg); } catch { /* 父已退 */ } };

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

parentPort?.on('message', (m) => {
  if (m === 'stop') shutdown({ code: 0, kind: 'user', detail: '实例已停止' });
  else if (m && m.t === 'pause') { try { engine.pause('operator'); } catch { /* ignore */ } }
  else if (m && m.t === 'resume') { try { engine.resume(); } catch { /* ignore */ } }
});

async function main() {
  const { MineflayerDriver } = await import('../drivers/mineflayer/index.js');
  const driver = new MineflayerDriver({ log: (m, level) => (engine ? engine.obs.log(level ?? 'console', String(m)) : console.log(m)) });
  engine = new BotEngine(inst.pkgAbs, driver, engineOptions(inst, { dryRun: !!dryRun }));
  // 每实例内存上限靠父进程 resourceLimits.maxOldGenerationSizeMb（isolate 级、可归属）。
  await engine.start();
  await startHttpApi(engine, {
    log: (level, msg) => console.log(`[${level}] ${msg}`),
    port: httpPort, token: httpToken,
  });
  send({ t: 'ready', instance: instanceId });
}

main().catch((e) => {
  // 启动失败要区分「用户的包/配置问题」与「我们自己的问题」：
  // 前者给可执行提示（用户能自己改），后者只留追踪 ID、细节进日志。
  const message = String(e?.message ?? e);
  const kind = e?.kind;   // 引擎抛出的类型化错误（lua.compile / state.* / param.* 等）
  const full = `${message}${e?.stack ? `\n${String(e.stack).split('\n').slice(0, 6).join('\n')}` : ''}`;
  console.error(`[worker:${instanceId}] 启动失败 kind=${kind ?? ''}:`, full);
  if (kind === 'lua.compile') {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'foreseeable', detail: '脚本编译失败：请检查包的 Lua 源码', full });
  } else if (String(kind ?? '').startsWith('param.')) {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'foreseeable', detail: '实例参数不合法：请检查参数配置', full });
  } else if (kind === 'deploy.invalid' || /bot\.yaml|manifest|deploy\.yaml|ENOENT/.test(message)) {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'foreseeable', detail: '程序包或部署配置不完整：请重新上传程序包', full });
  } else {
    send({ t: 'exit', instance: instanceId, code: 1, kind: 'internal', detail: null, full });
  }
  process.exit(1);
});
