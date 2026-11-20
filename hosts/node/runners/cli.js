// hosts/node/runners/cli.js — 单实例运行器（standalone：无进程拓扑中的 Node 端）
//
// 用法：node hosts/node/runners/cli.js <deploy.yaml> [--dry-run]
// 控制台命令（console 权限）：pause / resume / status / quit —— 全部进核心命令总线。
import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadInstance, engineOptions, validateDeploy } from '../deploy.js';
import { BotEngine } from '../engine.js';
import { startHttpApi } from '../http17.js';

// standalone 部署没有控制面：运行期 params 热更落侧车文件（平台部署由控制面写 instances.params_json）。
const paramsFile = (dir) => path.join(dir, 'params.json');
function readParamsSidecar(dir) {
  const f = paramsFile(dir);
  if (!existsSync(f)) return {};
  try {
    const v = JSON.parse(readFileSync(f, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeParamsSidecar(dir, values) {
  const f = paramsFile(dir);
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(values ?? {}, null, 2));
  renameSync(tmp, f);
}

export async function runBot(yamlPath, { dryRun = false, log = console.log } = {}) {
  const inst = loadInstance(yamlPath);
  const problems = validateDeploy(inst.deploy).filter((p) => p.level === 'error');
  if (problems.length) {
    for (const p of problems) console.error(`[deploy] ${p.msg}`);
    process.exitCode = 1;
    throw Object.assign(new Error(`deploy.yaml 不合法: ${problems[0].msg}`), { kind: 'deploy.invalid' });
  }

  const { MineflayerDriver } = await import('../drivers/mineflayer/index.js');
  // 驱动输出投引擎日志出口（环 + 实时流 + stdout）；engine 构造前先转发到 console
  let engine = null;
  const driver = new MineflayerDriver({ log: (m, level) => (engine ? engine.obs.log(level ?? 'console', String(m)) : log(String(m))) });

  const opts = engineOptions(inst, {
    dryRun,
    onParamsChanged: (values) => writeParamsSidecar(inst.dir, values),
  });
  const savedParams = readParamsSidecar(inst.dir);
  if (Object.keys(savedParams).length) opts.instanceParams = { ...opts.instanceParams, ...savedParams };
  engine = new BotEngine(inst.pkgAbs, driver, opts);

  const shutdown = async (exitCode = 0) => {
    log('\n[cli] 停机 = 进程退出（无 on_stop）');
    await engine.stop();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => shutdown(0));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (t === 'quit' || t === 'exit') { shutdown(0); return; }
      // ABI v2：没有命令总线；stdin 只做宿主控制
      if (t === 'pause') { engine.pause('console'); continue; }
      if (t === 'resume') { engine.resume(); continue; }
      if (t === 'status') {
        const s = engine.status();
        const pos = s.pos ? `${Math.round(s.pos.x)} ${Math.round(s.pos.y)} ${Math.round(s.pos.z)}` : '?';
        console.log(`[cli] state=${s.state} paused=${s.paused}(${s.pause_reason ?? ''}) pos=${pos}`);
        continue;
      }
      console.warn(`[cli] 未知输入 "${t}"（可用：pause / resume / status / quit）`);
    }
  });

  // 每实例内存自监控（BOTSCRIPT_MEM_LIMIT_MB）：容器 cgroup 是整机多实例共享的，
  // 一个实例涨满会把同容器所有实例一起被内核 OOM 杀掉（且无任何日志）。
  const memCapMb = Number(process.env.BOTSCRIPT_MEM_LIMIT_MB) || 0;
  if (memCapMb > 0) {
    const capBytes = memCapMb * 1024 * 1024;
    const poll = () => {
      const rss = process.memoryUsage.rss();
      if (rss >= capBytes) {
        const used = (rss / 1048576).toFixed(0);
        console.error(`[cli] 内存超限：RSS ${used}MB ≥ 单实例上限 ${memCapMb}MB（BOTSCRIPT_MEM_LIMIT_MB），主动退出以免拖垮同容器其他实例`);
        shutdown(137);   // 137 = 128+SIGKILL 约定；agent 据此判定「内存超限」
        return;
      }
    };
    const t = setInterval(poll, 2000);
    t.unref?.();   // 不阻止正常退出
  }

  await engine.start();
  await startHttpApi(engine, { log: (level, msg) => console.log(`[${level}] ${msg}`) });
  return engine;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBot(process.argv[2], { dryRun: process.argv.includes('--dry-run') })
    .catch((e) => { console.error('[cli] 启动失败:', e); process.exit(1); });
}
