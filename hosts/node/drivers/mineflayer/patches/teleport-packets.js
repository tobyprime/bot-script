// patches/teleport-packets.js — entity_teleport 数据表守卫（版本适配登记项）
//
// 线上事故（2026-11-15）：mc.zenoxs.cn 下发带 dx/dy/dz + f32 角度的 entity_teleport，
// minecraft-data 3.116.0 给出旧布局（i8 角度）→ play 阶段逐包 partial packet → EPIPE。
// 修复不在运行时改包，而是把「数据表必须含 dx」变成连接期断言：
// 表被降级就立刻在日志里说明原因，而不是等到 play 阶段才以断线形态出现。
export const id = 'teleport-packets';
export const reason = 'minecraft-data 3.119.0+ 才有 26.x entity_teleport（含 dx 字段）布局';
export function match() { return true; }

export function install(bot, ctx = {}) {
  try {
    const types = bot?.registry?.protocol?.play?.toClient?.types;
    const def = types?.packet_entity_teleport;
    const fields = def?.[1]?.filter?.((x) => x.name !== 'name').map((x) => x.name) ?? [];
    if (fields.length && !fields.includes('dx')) {
      ctx.log?.(`[patches] 警告：minecraft-data 的 entity_teleport 缺 dx（${fields.join(',')}）；升级依赖以避免 partial packet`);
      return { ok: false };
    }
    ctx.log?.(`[patches] 已应用 ${id}`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
