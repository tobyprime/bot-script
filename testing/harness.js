// testing/harness.js — 测试接线（makeEngine / script / waitFor / g）
//
// 所有测试域共用；引擎只通过公开面（engine.*、engine.lua、engine.obs）被撬动。
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotEngine } from '../hosts/node/engine.js';
import { MockDriver } from './mock-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TMP = path.join(HERE, 'tmp');
export const TEST_DIR = path.join(TMP, 'scripts');

export function script(name, src) {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(path.join(TEST_DIR, name), src);
}

export async function makeEngine({ yaml = {}, scripts = [], driver, boundary, runtime, instanceParams, dryRun } = {}) {
  const d = driver ?? new MockDriver();
  const engine = new BotEngine({
    name: 'test-bot',
    ...yaml,
    scripts,
  }, d, {
    scriptDir: TEST_DIR,
    // v2：边界经 opts.boundary（实例部署层）；缺省给空 boundary（已授权实例），
    // 观察模式（默认全拒）由用例显式传 boundary: null 验证
    boundary: boundary !== undefined ? boundary : (yaml.boundary ?? yaml.policy ?? {}),
    connect: yaml.connect ?? yaml.driver ?? { version: '1.21.8' },
    runtime,
    instanceParams,
    dryRun,
    log: (l, m) => { if (process.env.BS_TEST_LOG) console.log(l, m); },
  });
  await engine.start();
  return { engine, driver: d };
}

export async function waitFor(cond, timeout = 5000, step = 25) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/** 读 Lua 全局（测试脚本一律把结果写成 __R_* 标量全局） */
export function g(engine, name) { return engine.lua.lua.global.get(name); }

export function cleanupTmp() { rmSync(TMP, { recursive: true, force: true }); }

export const EXAMPLES = path.resolve(HERE, '..', 'examples');
