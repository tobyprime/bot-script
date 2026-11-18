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

// 把目标 yaw 拉到与当前朝向同一侧的一半圆内（最短路径）。
// 为什么必须做：serviceDegToBotYaw 落在 [0,2π)，而 bot.entity.yaw 落在 [-π,π]；
// bot.look 内部只算 delta = target - entity.yaw 不做归一化，跨 ±π 边界就会绕远路
// （179°→181° 实际要走 358°），表现为「转头又慢又飘」。返回值 = curYaw + 最短 delta。
export function shortestYaw(targetYaw, curYaw) {
  const delta = (((targetYaw - curYaw + PI) % PI2) + PI2) % PI2 - PI;
  return curYaw + delta;
}

