// testing/registry.js — 极简测试注册/执行器（按域拆分的测试共用）
export const tests = [];
export function test(name, fn) { tests.push([name, fn]); }

export async function runAll({ only = null } = {}) {
  const started = Date.now();
  let failed = 0;
  let ran = 0;
  for (const [name, fn] of tests) {
    if (only && !name.includes(only)) continue;
    ran++;
    process.stdout.write(`· ${name}\n`);
    try {
      await fn();
      console.log(`  PASS (${((Date.now() - started) / 1000).toFixed(1)}s 累计)`);
    } catch (e) {
      failed++;
      console.error(`  FAIL: ${e?.stack ?? e?.message ?? e}`);
    }
  }
  console.log(failed === 0 ? `\n全部 ${ran} 项通过` : `\n${failed}/${ran} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}
