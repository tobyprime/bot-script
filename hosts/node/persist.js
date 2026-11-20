// hosts/node/persist.js — persist ABI 的 Node 实现（node:sqlite）
//
// 语义由 contracts/vectors/persist/*.json 锁定（Node 与 Fabric 跑同一份向量）：
//   * 表声明 + 主键 upsert + find/all/del/adjust
//   * seen 内容寻址去重窗
//   * 追加日志（__log_<name>）+ mark
//   * 引擎侧全局串行事务（体内挂起点由调度器回滚：persist.txn_yielded）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function posKey(p) { return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`; }
function parseKeyPos(s) {
  const [x, y, z] = String(s).split(',').map(Number);
  return { x, y, z };
}
const nowMs = () => Date.now();

export class Persist {
  constructor(file) {
    // sqlite 不建父目录：实例数据根缺失时补建（避免 unable to open database file）
    if (file && file !== ':memory:') {
      try { mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); } catch { /* 只读盘等 */ }
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS __kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS __seen (k TEXT PRIMARY KEY, ts INTEGER);
      CREATE TABLE IF NOT EXISTS __tables (name TEXT PRIMARY KEY, schema TEXT);
    `);
    this.txnDepth = 0;
    this.tables = new Map(); // name -> {schema, keyField, fields}
  }

  // ---- 声明 ----
  declareTable(name, schema) {
    const fields = Object.keys(schema);
    const keyField = fields.find((f) => String(schema[f]).includes(':key')) || null;
    const cols = [];
    for (const f of fields) {
      const t = String(schema[f]);
      const base = t.split(':')[0].replace(/\?$/, '');
      const type = base === 'number' ? 'REAL' : 'TEXT';
      const pk = t.includes(':key') ? ' PRIMARY KEY' : '';
      cols.push(`"${f}" ${type}${pk}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(', ')})`);
    this.tables.set(name, { schema, keyField, fields });
  }

  colVal(field, tstr, v) {
    const base = String(tstr).split(':')[0].replace(/\?$/, '');
    if (v === null || v === undefined) return null;
    if (base === 'blockpos') return posKey(v);
    if (base === 'number') return Number(v);
    return String(v);
  }

  rowVal(field, tstr, v) {
    const base = String(tstr).split(':')[0].replace(/\?$/, '');
    if (v === null || v === undefined) return undefined;
    if (base === 'blockpos') return parseKeyPos(v);
    return v;
  }

  table(name) {
    const t = this.tables.get(name);
    if (!t) throw new Error(`persist table 未声明: ${name}`);
    return t;
  }

  find(name, where) {
    const t = this.table(name);
    const rows = this.all(name);
    outer:
    for (const r of rows) {
      for (const [k, v] of Object.entries(where)) {
        if (k === 'state') { if (r.__state !== v) continue outer; continue; }
        const rv = r[k];
        const a = t.schema[k] && String(t.schema[k]).startsWith('blockpos') && rv && v && typeof v === 'object'
          ? posKey(rv) === posKey(v)
          : rv === v;
        if (!a) continue outer;
      }
      const out = {};
      for (const f of t.fields) out[f] = r[f];
      return out;
    }
    return null;
  }

  all(name) {
    const t = this.table(name);
    const rs = this.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    return rs.map((row) => {
      const out = {};
      for (const f of t.fields) out[f] = this.rowVal(f, t.schema[f], row[f]);
      return out;
    });
  }

  upsert(name, row) {
    const t = this.table(name);
    if (t.keyField && (row[t.keyField] === undefined || row[t.keyField] === null)) {
      throw new Error(`upsert 缺主键 ${t.keyField}`);
    }
    const cols = t.fields.map((f) => `"${f}"`);
    const qs = t.fields.map(() => '?').join(',');
    const vals = t.fields.map((f) => this.colVal(f, t.schema[f], row[f]));
    const updates = t.fields.filter((f) => f !== t.keyField)
      .map((f) => `"${f}" = excluded."${f}"`).join(', ');
    const sql = t.keyField
      ? `INSERT INTO "${name}" (${cols.join(',')}) VALUES (${qs})
         ON CONFLICT("${t.keyField}") DO UPDATE SET ${updates}`
      : `INSERT INTO "${name}" (${cols.join(',')}) VALUES (${qs})`;
    this.db.prepare(sql).run(...vals);
  }

  del(name, where) {
    const t = this.table(name);
    for (const r of this.all(name)) {
      let hit = true;
      for (const [k, v] of Object.entries(where)) {
        const rv = r[k];
        const eq = t.schema[k] && String(t.schema[k]).startsWith('blockpos') && rv && v && typeof v === 'object'
          ? posKey(rv) === posKey(v)
          : rv === v;
        if (!eq) { hit = false; break; }
      }
      if (hit) {
        const kv = this.colVal(t.keyField, t.schema[t.keyField], r[t.keyField]);
        this.db.prepare(`DELETE FROM "${name}" WHERE "${t.keyField}" = ?`).run(kv);
      }
    }
  }

  /** 主键/数值字段由表 schema 推导（ABI v2 不再让调用方重复传） */
  adjust(name, key, delta) {
    const t = this.table(name);
    const keyField = t.keyField;
    const numField = t.fields.find((f) => String(t.schema[f]).split(':')[0].replace(/\?$/, '') === 'number');
    if (!keyField || !numField) throw new Error(`调整需要主键与数值字段: ${name}`);
    const row = this.find(name, { [keyField]: key });
    let val = 0;
    if (row) val = Number(row[numField] || 0);
    else {
      const blank = {};
      for (const f of t.fields) blank[f] = f === keyField ? key : null;
      blank[numField] = 0;
      this.upsert(name, blank);
      val = 0;
    }
    val += delta;
    const fresh = this.find(name, { [keyField]: key });
    fresh[numField] = val;
    this.upsert(name, fresh);
    return fresh;
  }

  // ---- kv ----
  kvGet(name, k) {
    const r = this.db.prepare('SELECT v FROM __kv WHERE k = ?').get(`${name}/${k}`);
    return r ? r.v : '';
  }

  kvSet(name, k, v) {
    this.db.prepare(`INSERT INTO __kv (k, v) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(`${name}/${k}`, v);
  }

  kvAll(name) {
    const rows = this.db.prepare('SELECT k, v FROM __kv WHERE k LIKE ?').all(`${name}/%`);
    return Object.fromEntries(rows.map((r) => [r.k.slice(name.length + 1), r.v]));
  }

  listTables() {
    const names = [];
    for (const [name] of this.tables) names.push(name);
    const logs = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__log_%'").all();
    return { tables: names, logs: logs.map((r) => r.name.replace('__log_', '')) };
  }

  // ---- seen（内容寻址去重窗） ----
  seen(key, windowMs) {
    const now = nowMs();
    this.db.prepare('DELETE FROM __seen WHERE ts < ?').run(now - Math.max(0, windowMs - 50));
    const hit = this.db.prepare('SELECT ts FROM __seen WHERE k = ?').get(key);
    if (hit && now - hit.ts <= windowMs) return 1;
    this.db.prepare(`INSERT INTO __seen (k, ts) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET ts = excluded.ts`).run(key, now);
    return 0;
  }

  // ---- 追加日志 ----
  logDeclare(name) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS "__log_${name}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, state TEXT, data TEXT)`);
  }

  logAppend(name, fields) {
    const state = fields && fields.state != null ? String(fields.state) : 'new';
    const info = this.db.prepare(`INSERT INTO "__log_${name}" (ts, state, data) VALUES (?, ?, ?)`)
      .run(nowMs(), state, JSON.stringify(fields ?? {}));
    return Number(info.lastInsertRowid);
  }

  logFind(name, where) {
    const rows = this.db.prepare(`SELECT * FROM "__log_${name}" ORDER BY id`).all();
    const out = [];
    for (const r of rows) {
      const data = JSON.parse(r.data || '{}');
      let hit = true;
      for (const [k, v] of Object.entries(where)) {
        const rv = k === 'state' ? r.state : data[k];
        if (rv !== v) { hit = false; break; }
      }
      if (hit) out.push({ id: Number(r.id), ts: r.ts, state: r.state, ...data });
    }
    return out;
  }

  logMark(name, id, state) {
    this.db.prepare(`UPDATE "__log_${name}" SET state = ? WHERE id = ?`).run(String(state), Number(id));
  }

  // ---- 事务（引擎侧全局串行；体内挂起点由调度器回滚） ----
  txnBegin() {
    if (this.txnDepth === 0) this.db.exec('BEGIN IMMEDIATE');
    this.txnDepth++;
  }

  txnCommit() {
    this.txnDepth = Math.max(0, this.txnDepth - 1);
    if (this.txnDepth === 0) this.db.exec('COMMIT');
  }

  txnRollback() {
    if (this.txnDepth > 0) {
      this.txnDepth = 0;
      try { this.db.exec('ROLLBACK'); } catch { /* 无活动事务 */ }
    }
  }

  close() { this.db.close(); }
}
