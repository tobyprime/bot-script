#!/usr/bin/env node
// engine/host.js — 兼容入口（平台按 BOTSCRIPT_HOST=engine/host.js 调用）
// 实现已迁到 hosts/node/runners/cluster.js（ARCHITECTURE-REFACTOR §4）。
import '../hosts/node/runners/cluster.js';
