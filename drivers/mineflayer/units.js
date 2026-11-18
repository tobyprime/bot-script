// drivers/mineflayer/units.js — 驱动边界角度单位换算
// Lua/引擎约定角度为「度」（bslib.look.at、look.yaw(pitch) 文档与 fabric mod 驱动同口径），
// mineflayer 的 bot.look / bot.entity.yaw|pitch 原生用「弧度」。换算只发生在驱动边界，
// 引擎与脚本永远只见度。
export const degToRad = (deg) => (deg == null ? deg : (deg * Math.PI) / 180);
export const radToDeg = (rad) => (rad == null ? rad : (rad * 180) / Math.PI);

const PI = Math.PI;
const PI2 = Math.PI * 2;

// 服务端度 → mineflayer bot.entity.yaw 坐标系（[0, 2π)）
export const serviceDegToBotYaw = (deg) => ((((PI - (deg * PI) / 180) % PI2) + PI2) % PI2);

// 把目标 yaw 拉到与当前朝向同一侧的一半圆内（最短路径），并归一化到 [-π, π]。
// 为什么必须做两件事：
//   1) serviceDegToBotYaw 落在 [0,2π)，而 bot.entity.yaw 落在 [-π,π]；bot.look 内部只算
//      delta = target - entity.yaw 不做归一化，跨 ±π 边界就会绕远路（179°→181° 要走 358°）。
//   2) mineflayer 的 lastSentYaw 本身是**无界累加**的（physics.js 里只管每 tick 步长、从不取模），
//      若这里再返回 curYaw + delta 这种「基于当前值累加」的结果，两个无界量会互相推着漂，
//      线上实测漂到 -215.967°（mineflayer 合法域是 [-π, π]），服务端判 containsInvalidValues
//      直接踢人（invalid_player_movement）。所以返回值必须归一化回 [-π, π]。
export function shortestYaw(targetYaw, curYaw) {
  const delta = (((targetYaw - curYaw + PI) % PI2) + PI2) % PI2 - PI;
  const next = curYaw + delta;
  return ((next + PI) % PI2 + PI2) % PI2 - PI;   // → [-π, π)
}

