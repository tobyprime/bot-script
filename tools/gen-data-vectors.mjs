// tools/gen-data-vectors.mjs — 生成 data-parity 向量（minecraft-data 为真值）
//
// 产物 contracts/vectors/data/items.<version>.json：{version, items:{name:stackSize}}
// Node 与 Fabric 各自实现 item.stack（Stack 组件），但都对着同一份向量验收（ARCHITECTURE-REFACTOR §5）。
// 用法：node tools/gen-data-vectors.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mdMod = require('minecraft-data');
const mcd = mdMod.default ?? mdMod;

const VERSIONS = ['1.21.8', '1.21.4', '1.20.1'];
mkdirSync(path.join(ROOT, 'contracts', 'vectors', 'data'), { recursive: true });

for (const version of VERSIONS) {
  const d = mcd(version);
  const items = {};
  for (const it of Object.values(d.items)) {
    items[it.name] = it.stackSize;
  }
  const out = {
    _note: '生成物，勿手改：node tools/gen-data-vectors.mjs（真值 = minecraft-data 注册表）',
    version,
    items,
  };
  const file = path.join(ROOT, 'contracts', 'vectors', 'data', `items.${version}.json`);
  writeFileSync(file, JSON.stringify(out, null, 0) + '\n');
  console.log(`[vectors] ${path.relative(ROOT, file)}（${Object.keys(items).length} 项）`);
}
