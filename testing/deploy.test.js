// testing/deploy.test.js — deploy.yaml 契约（version 顶层键 / server 形态 / 单一解析器）
import assert from 'node:assert';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { test } from './registry.js';
import { parseServer, buildConnect, validateDeploy, loadInstance, buildPackage } from '../hosts/node/deploy.js';

test('deploy：version 必须是顶层键（server 对象里的 version 会被忽略）', () => {
  assert.deepStrictEqual(buildConnect({ server: { host: 'mc.example', port: 25565 }, version: '1.21.8' }),
    { host: 'mc.example', port: 25565, version: '1.21.8', account: {}, viewDistance: 6 });
  assert.ok(validateDeploy({ server: { host: 'h', port: 25565, version: '1.21.8' } })
    .some((p) => p.level === 'error' && p.msg.includes('version 必须是顶层键')),
    'server.version 应被判错（否则会被静默丢弃 → 协议错位）');
  // 未设版本：交给宿主自动探测
  assert.strictEqual(buildConnect({ server: { host: 'h', port: 25565 } }).version, undefined);
});

test('deploy：server 支持 "host:port"、对象与 IPv6 方括号形态', () => {
  assert.deepStrictEqual(parseServer('mc.example:25565'), { host: 'mc.example', port: 25565 });
  assert.deepStrictEqual(parseServer('mc.example'), { host: 'mc.example', port: 25565 });
  assert.deepStrictEqual(parseServer({ host: 'h', port: 30000 }), { host: 'h', port: 30000 });
  assert.deepStrictEqual(parseServer('[::1]:25565'), { host: '::1', port: 25565 });
  assert.deepStrictEqual(parseServer(undefined), { host: '127.0.0.1', port: 25565 });
});

test('deploy：view_distance 夹到 2..12；账号字符串归一为 username', () => {
  const c = buildConnect({ server: 'h', account: 'BotA', view_distance: 99 });
  assert.deepStrictEqual(c.account, { username: 'BotA' });
  assert.strictEqual(c.viewDistance, 12);
  const c2 = buildConnect({ server: 'h', view_distance: 1 });
  assert.strictEqual(c2.viewDistance, 2);
});

test('deploy：validateDeploy 报告未知顶层键、非法 auth、非映射 boundary', () => {
  const problems = validateDeploy({
    package: './pkg',
    server: 'h',
    account: { auth: 'magic' },
    boundary: [],
    params: 1,
    unknown_key: true,
  });
  const msgs = problems.map((p) => `${p.level}:${p.msg}`).join('\n');
  assert.ok(msgs.includes('account.auth'), msgs);
  assert.ok(msgs.includes('boundary 必须是映射'), msgs);
  assert.ok(msgs.includes('params 必须是映射'), msgs);
  assert.ok(msgs.includes('未知顶层字段 "unknown_key"'), msgs);
});

test('deploy：loadInstance 解析包目录、清单与 persist 绝对路径', () => {
  const dir = path.resolve('testing/tmp/deploy-inst');
  mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  writeFileSync(path.join(dir, 'pkg', 'bot.yaml'), 'name: x\nscripts: [main.lua]\npersist: data.db\n');
  writeFileSync(path.join(dir, 'pkg', 'main.lua'), '-- x\n');
  writeFileSync(path.join(dir, 'deploy.yaml'), `package: ./pkg\nserver: {host: h, port: 25565}\nversion: "1.21.8"\n`);
  const inst = loadInstance(path.join(dir, 'deploy.yaml'));
  assert.strictEqual(inst.pkg.name, 'x');
  assert.strictEqual(inst.connect.version, '1.21.8');
  assert.strictEqual(inst.pkgAbs.persist, path.resolve(dir, 'data.db'), 'persist 相对实例根（deploy.yaml 所在目录）');
  assert.deepStrictEqual(buildPackage({ persist: undefined }, dir).persist, ':memory:');
});
