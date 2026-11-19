// engine/cli.js — 兼容入口（平台按 BOTSCRIPT_CLI=engine/cli.js 调用）
//
// 实现已迁到 hosts/node/runners/cli.js（ARCHITECTURE-REFACTOR §4）；本文件只保留两件事：
//   1) `validate` 子命令的进程隔离与 __BS_VALIDATE__ 标记转发（平台闸门契约不变）
//   2) 其余参数转发给 runners/cli.js
//
// validate 走子进程：大源文件编译会触发 wasmoon 退出期 libuv 断言污染退出码，
// 子进程输出末尾的 __BS_VALIDATE__ 标记行才是裁决依据。
import { fileURLToPath } from 'node:url';

const [, , firstArg, ...rest] = process.argv;

if (firstArg === 'validate') {
  const target = rest[0];
  if (!target) {
    console.error('用法：node engine/cli.js validate <包目录 | deploy.yaml>');
    process.exit(1);
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/validate.mjs', import.meta.url)), target], {
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
      process.stdout.write(`__BS_VALIDATE__ ${json}\n`, () => process.exit(JSON.parse(json).ok ? 0 : 1));
      return;
    }
    console.error('[validate] 子进程未产出结果标记');
    process.exit(1);
  });
} else {
  const { runBot } = await import('../hosts/node/runners/cli.js');
  runBot(firstArg, { dryRun: rest.includes('--dry-run') })
    .catch((e) => { console.error('[cli] 启动失败:', e); process.exit(1); });
}
