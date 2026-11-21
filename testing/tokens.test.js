// TokenHub：flush 重入护栏（长 pending 队列不得递归爆栈）
import assert from 'node:assert';
import { test } from './registry.js';
import { TokenHub } from '../hosts/node/tokens.js';

test('TokenHub.flushPending：2 万条排队交付不得爆栈', () => {
  let calls = 0;
  const hub = new TokenHub({ resume: () => { calls++; }, log: () => {} });
  hub.pendingResume = Array.from({ length: 20_000 }, () => [1, '{"ok":true}', '']);
  hub.flushPending();
  assert.strictEqual(calls, 20_000);
  assert.strictEqual(hub.pendingResume.length, 0);
});
