// hosts/node/stateStore.js — 实例级小状态（localStorage 语义）+ SQLite 内部实现
//
// 对外只有 key -> JSON value：无 schema、无查询、无多键事务。
// 文件路径由宿主固定（实例目录下），脚本/包无权指定（旧 bot.yaml persist: 路径已删除）。
// 配额：单值 ≤16KB、总量 ≤256KB；超限抛 kind=state.quota，不静默淘汰。
// 落盘：内存为准，100ms 合并 flush + 停机强制 flush；WAL 保证崩溃一致性。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_QUOTA = 256 * 1024;
const DEFAULT_VALUE_MAX = 16 * 1024;
const DEFAULT_FLUSH_MS = 100;

const keyBytes = (k) => Buffer.byteLength(k, 'utf8');
const valBytes = (v) => Buffer.byteLength(v, 'utf8');

export class StateStore {
  constructor(file, {
    quota = DEFAULT_QUOTA,
    valueMax = DEFAULT_VALUE_MAX,
    flushMs = DEFAULT_FLUSH_MS,
    now = Date.now,
  } = {}) {
    this.file = file || ':memory:';
    this.quota = quota;
    this.valueMax = valueMax;
    this.flushMs = flushMs;
    this.now = now;
    if (this.file !== ':memory:') {
      try { mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true }); } catch { /* 只读盘等 */ }
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS __seen (k TEXT PRIMARY KEY, ts INTEGER);
    `);
    this.map = new Map();        // key -> JSON text
    for (const row of this.db.prepare('SELECT k, v FROM state').all()) {
      this.map.set(String(row.k), String(row.v));
    }
    this.dirty = new Set();
    this.deleted = new Set();
    this.timer = null;
    this.closed = false;
  }

  get stats() {
    let bytes = 0;
    for (const [k, v] of this.map) bytes += keyBytes(k) + valBytes(v);
    return { entries: this.map.size, bytes, quota: this.quota, value_max: this.valueMax };
  }

  get(key) {
    const j = this.map.get(String(key));
    if (j === undefined) return undefined;
    return JSON.parse(j);
  }

  all() {
    const out = {};
    for (const [k, j] of this.map) out[k] = JSON.parse(j);
    return out;
  }

  set(key, value) {
    const k = String(key ?? '');
    if (!k) throw typedError('state.bad_request', 'state key 不能为空');
    if (keyBytes(k) > 128) throw typedError('state.bad_request', `state key 过长（${keyBytes(k)} > 128 字节）`);
    if (k.includes('\u0000')) throw typedError('state.bad_request', 'state key 不得包含 NUL');
    let v;
    try {
      v = JSON.stringify(value === undefined ? null : value);
    } catch {
      throw typedError('state.bad_request', 'state value 必须是可 JSON 序列化的值');
    }
    if (typeof v !== 'string') throw typedError('state.bad_request', 'state value 必须是可 JSON 序列化的值');
    const size = valBytes(v);
    if (size > this.valueMax) {
      throw typedError('state.quota', `单值过大（${size} > ${this.valueMax} 字节）`);
    }
    const prev = this.map.get(k);
    const total = this.stats.bytes - (prev === undefined ? 0 : keyBytes(k) + valBytes(prev)) + keyBytes(k) + size;
    if (total > this.quota) {
      throw typedError('state.quota', `状态总量超限（${total} > ${this.quota} 字节）`);
    }
    this.map.set(k, v);
    this.deleted.delete(k);
    this.dirty.add(k);
    this.schedule();
  }

  delete(key) {
    const k = String(key ?? '');
    if (this.map.delete(k)) {
      this.dirty.delete(k);
      this.deleted.add(k);
      this.schedule();
    }
  }

  /** 内容寻址去重窗：true = 窗口内已见过（重复）。不占用户配额。 */
  seen(key, windowMs = 5000) {
    const now = this.now();
    this.db.prepare('DELETE FROM __seen WHERE ts < ?').run(now - Math.max(0, Number(windowMs) - 50));
    const hit = this.db.prepare('SELECT ts FROM __seen WHERE k = ?').get(String(key));
    if (hit && now - Number(hit.ts) <= Number(windowMs)) return true;
    this.db.prepare(`INSERT INTO __seen (k, ts) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET ts = excluded.ts`).run(String(key), now);
    return false;
  }

  clear() {
    this.map.clear();
    this.db.exec('DELETE FROM state; DELETE FROM __seen;');
    this.dirty.clear();
    this.deleted.clear();
  }

  schedule() {
    if (this.closed || this.timer || this.file === ':memory:') return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.file === ':memory:' || this.closed) return;
    if (!this.dirty.size && !this.deleted.size) return;
    const upsert = this.db.prepare(`INSERT INTO state (k, v) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
    const del = this.db.prepare('DELETE FROM state WHERE k = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const k of this.deleted) del.run(k);
      for (const k of this.dirty) upsert.run(k, this.map.get(k));
      this.db.exec('COMMIT');
      this.dirty.clear();
      this.deleted.clear();
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* 无活动事务 */ }
      throw e;
    }
  }

  close() {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.flush(); } finally {
      this.closed = true;
      try { this.db.close(); } catch { /* ignore */ }
    }
  }
}

function typedError(kind, detail) {
  const e = new Error(detail);
  e.kind = kind;
  e.detail = detail;
  return e;
}
