// engine/cli.js — mineflayer 宿主实例运行器（v2 standalone：无引擎进程拓扑中的 Node 端）
// 用法：node engine/cli.js <deploy.yaml> [--dry-run]
//   deploy.yaml = 实例部署配置（DESIGN §6）：package/server/account/boundary/runtime
//   包清单（bot.yaml：name/scripts/params schema/persist）从 package 目录加载
// 控制台命令（console 权限）：pause / resume / status / quit
// HTTP 控制通道常开（CAPABILITIES §17）：127.0.0.1 + 自动 token，启动时打印；
// 覆盖仅经 env（BOTSCRIPT_HTTP_PORT / BOTSCRIPT_HTTP_TOKEN）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';
import { BotEngine } from './engine.js';
import { startHttpApi } from './httpapi.js';

const [, , firstArg, ...rest] = process.argv;

// validate 子命令：包静态校验（不连服务器、不执行脚本）——node engine/cli.js validate <包目录|deploy.yaml>
// 经子进程调起：大源文件编译会触发 wasmoon 退出期 libuv 断言污染退出码，
// 子进程输出末尾的 __BS_VALIDATE__ 标记行才是裁决依据
if (firstArg === 'validate') {
  const target = rest[0];
  if (!target) {
    console.error('用法：node engine/cli.js validate <包目录 | deploy.yaml>');
    process.exit(1);
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./validate.js', import.meta.url)), target], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.on('close', () => {
    const markerIdx = out.indexOf('__BS_VALIDATE__ ');
    const human = markerIdx >= 0 ? out.slice(0, markerIdx) : out;
    process.stdout.write(human);
    if (markerIdx >= 0) {
      const json = out.slice(markerIdx + '__BS_VALIDATE__ '.length).trim();
      // 标记行转发给父调用方（平台闸门以行为准，不能只依赖被库断言污染的退出码）
      process.stdout.write(`__BS_VALIDATE__ ${json}\n`, () => process.exit(JSON.parse(json).ok ? 0 : 1));
      return;
    }
    console.error('[validate] 子进程未产出结果标记');
    process.exit(1);
  });
} else {
  runBot(firstArg, rest.includes('--dry-run'));
}

function runBot(yamlPath, dryRunFlag) {
if (!yamlPath) {
  console.error('用法：node engine/cli.js <deploy.yaml> [--dry-run] | validate <包目录 | deploy.yaml>');
  process.exit(1);
}
const abs = path.resolve(yamlPath);
const deploy = parse(readFileSync(abs, 'utf8')) ?? {};

// 包清单：从 package 目录加载（能力自述，不含边界/凭据）
const pkgDir = path.resolve(path.dirname(abs), deploy.package ?? '.');
const pkg = parse(readFileSync(path.join(pkgDir, 'bot.yaml'), 'utf8')) ?? {};

// 连接（连接层随宿主部署）：server "host:port" + account（用户名或对象）
function parseServer(s) {
  if (typeof s === 'string') {
    const [host, port] = s.split(':');
    return { host: host || '127.0.0.1', port: port ? Number(port) : 25565 };
  }
  return { host: s?.host ?? '127.0.0.1', port: s?.port ?? 25565 };
}
const server = parseServer(deploy.server);
const account = typeof deploy.account === 'string' ? { username: deploy.account } : (deploy.account ?? {});
// mineflayer 驱动 connect 契约：{host, port, version, account}
//   account = {username, password}（微软 OAuth）| {auth:'session', username, uuid, accessToken}（平台注入）
//   | {username}（offline）
const connect = {
  host: server.host,
  port: server.port,
  version: deploy.version ?? deploy.server_version,
  account,
  viewDistance: Math.max(2, Math.min(12, Number(deploy.view_distance) || 6)),   // 客户端视距（chunks）
};

// persist 相对路径解析到实例数据根（= 部署文件所在目录；随实例隔离，DESIGN §5.2）
const pkgAbs = {
  ...pkg,
  persist: pkg.persist ? path.resolve(path.dirname(abs), pkg.persist) : ':memory:',
};

async function main() {
  const { MineflayerDriver } = await import('../drivers/mineflayer/index.js');
  // 驱动控制台输出不再直落 stdout：改投引擎 log 出口，才能随实时流进平台的日志/聊天视图。
  // engine 在构造后才存在，先用转发壳；此后 driver.log 全部经 engine.log（环 + 流 + stdout）。
  let engine = null;
  const driver = new MineflayerDriver({ log: (m) => (engine ? engine.log('console', String(m)) : console.log(m)) });

  engine = new BotEngine(pkgAbs, driver, {
    scriptDir: pkgDir,
    boundary: deploy.boundary ?? null,   // 无 boundary = 观察模式（§5.1 默认全拒）
    runtime: deploy.runtime ?? {},
    instanceParams: deploy.params ?? {},  // 平台实例参数（优先级：包默认 < 实例部署 < 持久化）
    dryRun: dryRunFlag,
    connect,
  });

  const shutdown = async (exitCode = 0) => {
    console.log('\n[cli] 停机 = 进程退出（无 on_stop）');
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
      engine.dispatchCommand(t, null, true);
    }
  });

  // 每实例内存自监控（BOTSCRIPT_MEM_LIMIT_MB）：容器 cgroup 是整机多实例共享的，
  // 一个实例涨满会把同容器所有实例一起被内核 OOM 杀掉（且无任何日志）。
  // 这里按 RSS 自检，快到上限就主动优雅退出并打印明确原因——只牺牲超限的这个实例，
  // 且 reason 会落 console.log（agent/grep 可读），不再"无声消失"。
  // 注意：容器 mem_limit 仍须 > N×单实例上限留出余量（agent 自身 + 引擎外开销）。
  const memCapMb = Number(process.env.BOTSCRIPT_MEM_LIMIT_MB) || 0;
  if (memCapMb > 0) {
    const capBytes = memCapMb * 1024 * 1024;
    const poll = () => {
      const rss = process.memoryUsage.rss();
      if (rss >= capBytes) {
        const used = (rss / 1048576).toFixed(0);
        console.error(`[cli] 内存超限：RSS ${used}MB ≥ 单实例上限 ${memCapMb}MB（BOTSCRIPT_MEM_LIMIT_MB），主动退出以免拖垮同容器其他实例`);
        shutdown(137);   // 137 = 128+SIGKILL 约定；agent 据此判定「内存超限」并给出可读 failed 原因
        return;
      }
    };
    const t = setInterval(poll, 2000);
    t.unref?.();   // 不阻止正常退出
  }

  await engine.start();
  await startHttpApi(engine, { log: (level, msg) => console.log(`[${level}] ${msg}`) });
  }

  main().catch((e) => {
    console.error('[cli] 启动失败:', e);
    process.exit(1);
  });
}
