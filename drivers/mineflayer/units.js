// drivers/mineflayer/units.js — 驱动边界角度单位换算
// Lua/引擎约定角度为「度」（bslib.look.at、look.yaw(pitch) 文档与 fabric mod 驱动同口径），
// mineflayer 的 bot.look / bot.entity.yaw|pitch 原生用「弧度」。换算只发生在驱动边界，
// 引擎与脚本永远只见度。
export const degToRad = (deg) => (deg == null ? deg : (deg * Math.PI) / 180);
export const radToDeg = (rad) => (rad == null ? rad : (rad * 180) / Math.PI);
