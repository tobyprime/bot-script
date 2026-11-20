// hosts/node/vm.js — Lua VM 生命周期（唯一接触 wasmoon 的地方）
//
// 挂载 runtime/lua/core 的唯一源码（不再维护 engine/lua 的拷贝）；LuaJ 兼容补丁只在
// Fabric 宿主加载，Node 侧是字面意义的 Lua 5.4。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LUA_DIR = path.resolve(HERE, '..', '..', 'runtime', 'lua');

// 核心模块 + 可选库都挂进 VFS；可选库不执行、不注入全局，脚本自己 require。
export const CORE_FILES = {
  'json.lua': 'core/json.lua',
  'bridge.lua': 'core/bridge.generated.lua',   // 模块名 bridge，文件名 bridge.generated.lua
  'bootstrap.lua': 'core/bootstrap.lua',
  'bslib.lua': 'lib/bslib.lua',
  'container_lib.lua': 'lib/container_lib.lua',
};

export class LuaVm {
  constructor({ scriptDir, log = () => {} } = {}) {
    this.scriptDir = scriptDir ? scriptDir.replaceAll('\\', '/') : process.cwd().replaceAll('\\', '/');
    this.log = log;
    this.lua = null;
    this.factory = null;
    this._fnCache = new Map();
  }

  async start() {
    const { LuaFactory } = await import('wasmoon');
    // Windows 下 emscripten 对非 file:// 路径误用 fetch：初始化期间屏蔽 fetch 强制走 fs
    const realFetch = globalThis.fetch;
    globalThis.fetch = undefined;
    // Emscripten 每个引擎都向 process 注册 uncaughtException/unhandledRejection；
    // 热重载会不断新建引擎，必须在 close 时只移除「本引擎新增的」监听，否则监听器与闭包泄漏
    const procEvents = ['uncaughtException', 'unhandledRejection', 'beforeExit', 'exit'];
    const before = Object.fromEntries(procEvents.map((e) => [e, process.listeners(e)]));
    try {
      this.factory = new LuaFactory();
      this.lua = await this.factory.createEngine();
    } finally {
      globalThis.fetch = realFetch;
    }
    this._procListeners = [];
    for (const e of procEvents) {
      const added = process.listeners(e).filter((fn) => !before[e].includes(fn));
      for (const fn of added) this._procListeners.push([e, fn]);
    }

    for (const [mountName, file] of Object.entries(CORE_FILES)) {
      await this.mount(mountName, readFileSync(path.join(LUA_DIR, file), 'utf8'));
    }
    // 实例脚本目录进入 package.path（require 限实例目录 + 运行时模块，DESIGN §2.3）
    this.lua.doString(`package.path = ${JSON.stringify(this.scriptDir + '/?.lua;')} .. package.path`);
    this.lua.doString('require "bootstrap"');
    // 实例目录全部 .lua 挂入 VFS（require 限实例目录）
    if (existsSync(this.scriptDir)) {
      for (const f of readdirSync(this.scriptDir).filter((x) => x.endsWith('.lua'))) {
        if (f in CORE_FILES) continue;
        await this.mount(f, readFileSync(path.join(this.scriptDir, f), 'utf8'));
      }
    }
    return this;
  }

  mount(file, content) {
    return new Promise((res, rej) => this.factory.mountFile(file, content).then(res, rej));
  }

  doString(src) {
    return this.lua.doString(src);
  }

  setGlobal(name, fn) {
    this._fnCache.delete(name);
    this.lua.global.set(name, (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.log('error', `[bridge:${name}] ${e.stack ?? e.message}`);
        throw e;
      }
    });
  }

  /** 取 Lua 全局函数（缓存；名字带 __ 的均为宿主实现或核心入口） */
  fn(name) {
    if (!this._fnCache.has(name)) this._fnCache.set(name, this.lua.global.get(name));
    return this._fnCache.get(name);
  }

  mountSibling(file, content) {
    return this.mount(file, content);
  }

  close() {
    try { this.lua?.global.close(); } catch { /* 已关闭 */ }
    // 只摘掉本引擎新增的 process 监听（wasmoon/Emscripten 的每引擎注册）
    for (const [ev, fn] of this._procListeners ?? []) {
      try { process.removeListener(ev, fn); } catch { /* ignore */ }
    }
    this._procListeners = [];
    this.factory = null;
    this.lua = null;
  }
}

export function coreDir() { return CORE_DIR; }
