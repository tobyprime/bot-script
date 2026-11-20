// testing/chat.test.js — 聊天分类：只按协议 sender，不从文本猜频道/发送者
import assert from 'node:assert';
import { test } from './registry.js';
import { classifyChat } from '../hosts/node/drivers/mineflayer/chat-classify.js';

test('聊天分类：无 sender UUID 一律 system，[TSL]/[名字]/私聊方括号都不猜成 player', () => {
  const raw = '[TSL] MixTobyInjTick 请求传送到你的位置。(60 秒内有效) [接受] [拒绝]';
  const c = classifyChat(raw, null);
  assert.strictEqual(c.sender_kind, 'system');
  assert.strictEqual(c.sender, null);
  assert.strictEqual(c.text, raw);
  assert.strictEqual(c.raw, raw);

  // 文本长得像玩家聊天也不能猜
  assert.strictEqual(classifyChat('<MixTobyInjTick> 你好', null).sender_kind, 'system');
  assert.strictEqual(classifyChat('[MixTobyInjTick ➥ MixTobyInjSave] 123', null).sender_kind, 'system');
  assert.strictEqual(classifyChat('MixTobyInjTick whispers to you: 锁定', null).sender_kind, 'system');
});

test('聊天分类：协议 sender 解析到在线玩家才标 player，正文剥 <名字> 前缀', () => {
  const c = classifyChat('<MixTobyInjTick> 你好', 'MixTobyInjTick');
  assert.strictEqual(c.sender_kind, 'player');
  assert.strictEqual(c.sender, 'MixTobyInjTick');
  assert.strictEqual(c.text, '你好');
  assert.strictEqual(c.raw, '<MixTobyInjTick> 你好');

  // 不带 <名字> 的玩家消息也原样保留正文
  const d = classifyChat('你好', 'MixTobyInjTick');
  assert.strictEqual(d.sender_kind, 'player');
  assert.strictEqual(d.text, '你好');
});
