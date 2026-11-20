// hosts/node/drivers/mineflayer/patches/index.js — 版本适配登记表（补丁即数据）
//
// 每个补丁：{ id, reason, match(version) → boolean, install(bot, ctx) → {uninstall?} }
// /caps 与启动日志输出「已应用补丁 id」，回答「当前版本装了哪些补丁」（ARCHITECTURE-REFACTOR §3.8）。
import * as tickEnd26x from './tick-end-26x.js';
import * as teleportPackets from './teleport-packets.js';

export const PATCHES = [tickEnd26x, teleportPackets];

export function installPatches(bot, ctx) {
  const applied = [];
  const undo = [];
  for (const p of PATCHES) {
    if (!p.match(ctx.version)) continue;
    try {
      const r = p.install(bot, ctx);
      applied.push({ id: p.id, reason: p.reason });
      if (r?.uninstall) undo.push(r.uninstall);
    } catch (e) {
      ctx.log?.(`[patches] ${p.id} 安装失败: ${e.message}`);
    }
  }
  return {
    applied,
    uninstall: () => { for (const fn of undo) { try { fn(); } catch { /* ignore */ } } },
  };
}
