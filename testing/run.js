// testing/run.js — 测试入口（node testing/run.js [--only=<子串>]）
//
// 按域拆分（ARCHITECTURE-REFACTOR §5 / §4）：每个文件只测一个切面，
// 夹具在 harness.js，行为契约在 contracts/vectors。
import { runAll } from './registry.js';

await import('./scheduler.test.js');
await import('./persist.test.js');
await import('./policy.test.js');
await import('./containers.test.js');
await import('./queries.test.js');
await import('./events.test.js');
await import('./logs.test.js');
await import('./http.test.js');
await import('./examples.test.js');
await import('./driver.test.js');
await import('./data.test.js');
await import('./deploy.test.js');
await import('./vectors.test.js');

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
await runAll({ only: onlyArg ? onlyArg.slice('--only='.length) : null });
