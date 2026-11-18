// engine.js — bot-script 引擎核心（单实例：Lua VM + 调度 + 持久化 + 策略 + 驱动桥）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TYPE_ERR = (kind, detail) => ({ kind, detail: detail === undefined ? null : detail });

// ---------- 内置数据表（知识放引擎，按服务端版本选表；v1 覆盖常用集） ----------
const STACK16 = new Set([
  'minecraft:snowball', 'minecraft:egg', 'minecraft:honey_bottle', 'minecraft:sign',
  'minecraft:oak_sign', 'minecraft:spruce_sign', 'minecraft:birch_sign',
  'minecraft:acacia_sign', 'minecraft:dark_oak_sign', 'minecraft:mangrove_sign',
  'minecraft:cherry_sign', 'minecraft:bamboo_sign', 'minecraft:crimson_sign',
  'minecraft:warped_sign', 'minecraft:banner', 'minecraft:white_banner',
]);
const STACK1_PREFIX = [
  'minecraft:wooden_', 'minecraft:stone_', 'minecraft:iron_', 'minecraft:golden_',
  'minecraft:diamond_', 'minecraft:netherite_',
];
const STACK1 = new Set([
  'minecraft:fishing_rod', 'minecraft:bow', 'minecraft:crossbow', 'minecraft:trident',
  'minecraft:mace', 'minecraft:shield', 'minecraft:elytra', 'minecraft:saddle',
  'minecraft:bucket', 'minecraft:water_bucket', 'minecraft:lava_bucket',
  'minecraft:milk_bucket', 'minecraft:powder_snow_bucket', 'minecraft:shears',
  'minecraft:flint_and_steel', 'minecraft:compass', 'minecraft:clock', 'minecraft:totem_of_undying',
]);
function stackSizeOf(id) {
  if (!id || !id.startsWith('minecraft:')) return 64;
  if (STACK16.has(id)) return 16;
  if (STACK1.has(id)) return 1;
  if (STACK1_PREFIX.some((p) => id.startsWith(p))) {
    // 工具/武器类一律 1
    return 1;
  }
  return 64;
}
const WEAPONS = {
  'minecraft:wooden_sword': 4, 'minecraft:stone_sword': 5, 'minecraft:iron_sword': 6,
  'minecraft:diamond_sword': 7, 'minecraft:netherite_sword': 8,
  'minecraft:wooden_axe': 7, 'minecraft:stone_axe': 9, 'minecraft:iron_axe': 9,
  'minecraft:diamond_axe': 9, 'minecraft:netherite_axe': 10,
  'minecraft:trident': 9, 'minecraft:mace': 6,
};
const ATTACK_SPEED = {
  'minecraft:wooden_sword': 1.6, 'minecraft:stone_sword': 1.6, 'minecraft:iron_sword': 1.6,
  'minecraft:diamond_sword': 1.6, 'minecraft:netherite_sword': 1.6,
  'minecraft:wooden_axe': 0.8, 'minecraft:stone_axe': 0.8, 'minecraft:iron_axe': 1.0,
  'minecraft:diamond_axe': 1.0, 'minecraft:netherite_axe': 1.0,
  'minecraft:trident': 1.1, 'minecraft:mace': 0.6,
};
const WEAPON_SCORE = WEAPONS;
function weaponCooldownMs(heldId) {
  const spd = (heldId && ATTACK_SPEED[heldId]) || 4.0; // 空手 4.0（1.9+）
  return Math.ceil(600 / spd); // 攻击间隔 ms（20 tick 基准）
}
const CONTAINER_BLOCKS = new Set([
  'chest', 'trapped_chest', 'barrel', 'ender_chest',
  'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box',
  'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box',
  'gray_shulker_box', 'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box',
  'blue_shulker_box', 'brown_shulker_box', 'green_shulker_box', 'red_shulker_box',
  'black_shulker_box', 'furnace', 'blast_furnace', 'smoker', 'hopper', 'dispenser',
  'dropper', 'brewing_stand',
]);

// ---------- 工具 ----------

function posKey(p) { return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`; }
function parseKeyPos(s) {
  const [x, y, z] = String(s).split(',').map(Number);
  return { x, y, z };
}
function normalizePos(p) { return { x: +p.x, y: +p.y, z: +p.z }; }
function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function dist2d(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
function nowMs() { return Date.now(); }

// 进程内环形缓冲：固定上限，超限丢最旧。平台侧不做日志/聊天持久化——
// 连接上的实时流是唯一入口，断线重连只能从本进程内存环取回缺口（进程重启即清空）。
const RING_LOG = 500;
const RING_ACTION = 2000;
const RING_CHAT = 200;
const RING_EVENT = 200;
function pushRing(ring, evt, cap) {
  ring.push(evt);
  if (ring.length > cap) ring.shift();
}

// =====================================================================
// Persist（node:sqlite；实例内一个文件，引擎侧全局串行事务）
// =====================================================================

class Persist {
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
    this.tables = new Map(); // name -> {schema, keyField, fields, cols}
  }

  // ---- 声明 ----
  declareTable(name, schema) {
    const fields = Object.keys(schema);
    const keyField = fields.find((f) => String(schema[f]).includes(':key')) || null;
    const cols = [];
    for (const f of fields) {
      const t = String(schema[f]);
      const base = t.split(':')[0].replace(/\?$/, '');
      const type = base === 'number' ? 'REAL'
        : base === 'blockpos' ? 'TEXT'
        : 'TEXT';
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

  adjust(name, key, delta, keyField, numField) {
    this.table(name);
    const row = this.find(name, { [keyField]: key });
    let val = 0;
    if (row) val = Number(row[numField] || 0);
    else {
      // 建户：数值字段 0，其余 NULL
      const t = this.table(name);
      const blank = {};
      for (const f of t.fields) blank[f] = f === keyField ? key : null;
      blank[numField] = 0;
      this.upsert(name, blank);
      val = 0;
    }
    val += delta;
    const t = this.table(name);
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

  // ---- 事务（引擎侧全局串行；体内禁挂起点由调度器检查） ----
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

// =====================================================================
// BotEngine
// =====================================================================

export class BotEngine {
  /**
   * @param cfg  bot.yaml 解析结果
   * @param driver  驱动实例（in-process 或 WS）
   * @param opts { scriptDir, log, dryRun, paramOverrides }
   */
  constructor(cfg, driver, opts = {}) {
    this.cfg = cfg;                 // 包清单（能力自述：name/scripts/params schema/persist，DESIGN §6）
    this.driver = driver;
    this.opts = opts;
    // 实例部署层（DESIGN §6 三层分离）：boundary 未配置 => 观察模式（默认全拒）
    this.policy = opts.boundary ?? null;
    this.runtimeCfg = { ...(opts.runtime ?? {}) };
    if (opts.dryRun) this.runtimeCfg.dry_run = true;
    this.connectCfg = opts.connect ?? {};
    // 日志单一出口：进程内环形缓冲（/logs、/stream 增量源）+ 实时流（SSE）+ 宿主输出。
    // 平台侧不落库：连接上即推送，断线只从本进程的内存环续传（进程重启即清空）。
    this._logRing = [];
    this._actionRing = [];
    this._chatRing = [];
    this._eventRing = [];
    this._streamSubs = new Set();
    this._streamSeq = 0;            // 实时流单调序号（SSE id / 断线续传游标）
    this.name = cfg.name ?? 'bot';

    this.tokens = new Map();      // token -> rec
    this.settled = new Map();     // token -> [okj, ej]（先于登记结算）
    this.luaDepth = 0;            // Lua 帧深度：wasm 不可重入，帧内交付必须排队
    this.pendingResume = [];
    this.nextToken = 1;
    this.frozen = [];             // pause 期间挂起的交付
    this.paused = false;
    this.pauseReason = null;

    this.windows = new Map();     // id -> {id,type,title,size,slots:Map,cursor,revision,ts}
    this.currentWindowId = null;  // 打开的容器（null = 只有背包）
    this.self = null;             // {pos,yaw,pitch,health,food,held,heldSlot,gamemode,ts}
    this.world = new Map();       // posKey -> {name, ts}
    this.sessionState = 'connecting';
    this.sessionInfo = {};
    this.lastAttack = 0;
    this.lastAttackWeapon = null;

    this.paramsSchema = new Map();
    this.paramValues = new Map();   // 生效值（含持久化覆盖）
    this.paramPersist = new Map();  // 显式改过的值（重启保留）
    this.commands = [];             // {pattern, tokens, perm, index}
    this.pendingTimers = [];
    this.timerSpecs = new Set();    // 引擎侧 timer 登记（pause 冻结 / stop 清理的统一台账）
    this.rexList = new Map();
    this.joinRecs = new Map();      // token -> join state
    this.reconAttempts = 0;         // 断线重连退避计数（playing 清零）
    this.reconnectDueAt = null;     // 下次重连尝试时刻（/state.next_retry_in 可观测）
    this.credentialUpdatedAt = null; // 最近一次 POST /session 生效时刻（/state 可观测，TOB-489）

    this.budgetCount = 0;
    this.chatTokens = [];           // say 限速令牌桶时间戳
    this.actionLog = this._actionRing;   // 动作审计（环形，含 /logs 增量与实时流）
    // 日志单一出口：进程内环 + 实时流 + 宿主输出（三条并行，平台侧不落库）
    this._outerLog = opts.log ?? ((level, msg) => console.log(`[${level}] ${msg}`));
    this.log = (level, msg) => {
      const evt = this.publish('log', { ts: nowMs(), level, msg });
      this._outerLog(level, msg);
      return evt;
    };
    this.eventQueue = [];           // 平台事件（HTTP /event 注入 → Lua events.next 消费）
    this.eventWaiters = [];         // events.next 等待者（FIFO）
    this.stopped = false;
    this.handledSpawn = false;
    this._mounted = new Set();
  }

  // ================= 生命周期 =================

  async start() {
    // 1) persist
    this.persist = new Persist(this.cfg.persist || ':memory:');
    // 参数持久化覆盖（存 __kv bot/params）
    const saved = this.persist.kvGet('bot', 'params');
    if (saved) {
      try { for (const [k, v] of Object.entries(JSON.parse(saved))) this.paramPersist.set(k, v); } catch { /* 忽略损坏 */ }
    }

    // 2) driver
    this.driver.on('session', (p) => this.onSession(p));
    this.driver.on('chat', (p) => this.onChat(p));
    this.driver.on('self', (p) => this.onSelf(p));
    this.driver.on('entity_appeared', (p) => this.event('entity.appeared', p));
    this.driver.on('entity_gone', (p) => this.event('entity.gone', p));
    this.driver.on('window', (p) => this.onWindow(p));
    this.driver.on('window_close', (p) => this.onWindowClose(p));
    this.driver.on('block_update', (p) => {
      if (p.pos && p.name) this.world.set(posKey(p.pos), { name: p.name, ts: nowMs() });
      this.event('world.block_changed', normalizePos(p.pos));
    });
    this.driver.on('death', () => {
      this.event('self.died', {});
      // 自动重生（CAPABILITIES §8：死亡 -> 自动重生，任务决定去留）
      // 例外：会话生命周期 timer，不进 timerSpecs 冻结域——死亡重生是客户端会话态恢复
      // 而非任务执行，pause（任务挂起）期间也应照常回到出生点（TOB-475 审查问题 3 登记）
      setTimeout(() => { if (!this.stopped) this.driver.respawn?.().catch?.(() => {}); }, 1200);
    });
    this.driver.on('respawn', () => this.event('self.respawned', {}));
    this.driver.on('damaged', (p) => this.event('self.damaged', p));

    // 2.5) 连接。dry-run 跳过实连（对齐「不实连服务器」语义）：仅引导脚本 / HTTP / 动作空转
    if (this.runtimeCfg.dry_run) {
      this.sessionState = 'dry';
      this.sessionInfo = { dry: true };
      this.log('info', `[${this.name}] dry-run：跳过实连（脚本、HTTP 控制通道照常，动作空转）`);
    } else {
      await this.driver.connect(this.connectCfg);
    }

    // 3) Lua VM
    await this.createLua();

    // 4) 脚本加载（声明期）；每个入口脚本的所在目录中的模块一并挂入 VFS（require 同目录模块）
    const scripts = this.cfg.scripts || [];
    for (const s of scripts) {
      const file = path.isAbsolute(s) ? s : path.join(this.opts.scriptDir ?? process.cwd(), s);
      const dir = path.dirname(file);
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter((f2) => f2.endsWith('.lua') && f2 !== path.basename(file))) {
          if (!this._mounted?.has(f)) {
            this._mounted.add(f);
            await this.mountVfs(f, readFileSync(path.join(dir, f), 'utf8'));
          }
        }
      }
      const src = readFileSync(file, 'utf8');
      this._mounted.add(path.basename(file));
      this.driver.mountFile?.(path.basename(file), src);
      await this.lua.doString(src);
    }

    // 5) 参数绑定：声明校验 + 持久化值 > yaml 初值
    this.bindParams();

    // 6) 启动序：on_start（CAPABILITIES §8）
    this.event('lifecycle', { kind: 'on_start' });

    // 7) 定时器生效
    for (const t of this.pendingTimers) this.activateTimer(t);
    this.pendingTimers = [];

    this.started = true;
    // 已在 playing 但当时脚本未加载完 => 补发 session.ready
    if (this.readyPending) {
      this.readyPending = false;
      this.fireReady();
    }

    this.log('info', `[${this.name}] 引擎启动完成 driver=${this.driver.constructor.name} paused=${this.paused}`);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectDueAt = null;
    for (const spec of this.timerSpecs) this.clearSpec(spec);
    this.timerSpecs.clear();
    try { await this.driver.stop?.(); } catch { /* ignore */ }
    this.persist?.close();
  }

  onSession(p) {
    const prev = this.sessionState;
    this.sessionState = p.state;
    if (p.info) this.sessionInfo = p.info;
    if (p.state === 'playing' && prev !== 'playing') {
      this.reconAttempts = 0;   // 重连成功：退避计数清零
      this.reconnectDueAt = null;
      if (!this.handledSpawn) {
        this.handledSpawn = true;
        // session.ready = playing + 首圈 chunk（尽力而为：spawn 后短暂延迟）
        // 例外：会话生命周期 timer，不进 timerSpecs 冻结域——ready 是会话握手事件，
        // 只在首连发生一次，冻结它只会延迟而非取消，且 pause 场景（断线在 playing 前不可达）不会命中
        setTimeout(() => this.fireReady(), 1500);
      } else if (this.paused && (this.pauseReason === 'disconnect' || this.pauseReason === 'kicked')) {
        this.log('info', `[${this.name}] 重连成功，自动 resume`);
        this.resume();
      }
    }
    if ((p.state === 'kicked' || p.state === 'disconnected') && !this.stopped) {
      this.log('warn', `[${this.name}] 会话 ${p.state}: ${p.reason ?? ''} -> 自动 pause`);
      // 会话已终：旧会话缓存（windows/world）全部失效，重连后由新会话重建
      this.invalidateSessionCache();
      this.pause(p.state === 'kicked' ? 'kicked' : 'disconnect');
      this.scheduleReconnect();   // 基础能力：自动重连（退避 30s→120s 封顶，±20% jitter）
    }
  }

  invalidateSessionCache() {
    this.windows.clear();
    this.currentWindowId = null;
    this.world.clear();
  }

  /** 重连退避：base*attempts 封顶 max，±20% jitter（同服多 bot 错峰重试）；静态纯函数便于测试 */
  static backoffDelay(attempts, baseMs = 30000, maxMs = 120000, rnd = Math.random) {
    const base = Math.min(maxMs, baseMs * attempts);
    return Math.round(base * (1 + (2 * rnd() - 1) * 0.2));
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer || this.runtimeCfg.dry_run) return;
    const rc = this.runtimeCfg.reconnect ?? {};
    const baseMs = Number(rc.base_ms) || 30000;
    const maxMs = Number(rc.max_ms) || 120000;
    this.reconAttempts = (this.reconAttempts ?? 0) + 1;
    const delay = BotEngine.backoffDelay(this.reconAttempts, baseMs, maxMs);
    this.reconnectDueAt = nowMs() + delay;
    this.log('info', `[${this.name}] ${Math.round(delay / 1000)}s 后尝试重连（第 ${this.reconAttempts} 次）`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDueAt = null;
      if (this.stopped || this.sessionState === 'playing') return;
      try {
        if (this.driver.reconnect) await this.driver.reconnect(this.connectCfg);
        else await this.driver.connect(this.connectCfg);
        this.sessionState = 'connecting';
        this.log('info', `[${this.name}] 重连尝试已发起`);
      } catch (e) {
        this.log('error', `[${this.name}] 重连发起失败: ${e.message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** 会话凭据更新（TOB-489 §17 POST /session，mineflayer 宿主）：
   *  写入 connectCfg.account.accessToken —— 在线连接零动作（MC 协议无会话中重认证，
   *  accessToken 仅 join 期消费）；断线/重连环路中下一次重连即用新 token
   *  （不重置退避、不打断在途重连计划）。错误以 kind 分型：session.bad_request（400）、
   *  session.account_mode / session.identity_mismatch（409）。token 值不得进任何日志。 */
  updateSessionCredential({ access_token: token, username, uuid } = {}) {
    const acct = this.connectCfg.account;
    if (!acct || acct.auth !== 'session') {
      const e = new Error('account is not auth=session mode');
      e.kind = 'session.account_mode';
      throw e;
    }
    if (typeof token !== 'string' || !token.trim()) {
      const e = new Error('access_token required (non-empty string)');
      e.kind = 'session.bad_request';
      throw e;
    }
    if ((username != null && username !== acct.username) || (uuid != null && uuid !== acct.uuid)) {
      const e = new Error('credential identity mismatch');
      e.kind = 'session.identity_mismatch';
      throw e;
    }
    acct.accessToken = token;
    this.credentialUpdatedAt = nowMs();
    const effective = this.sessionState === 'playing' ? 'next_connect' : 'next_reconnect';
    this.log('info', `[${this.name}] 会话凭据已更新（生效时机=${effective}，在线连接不受影响）`);
    return { applied: true, effective };
  }

  fireReady() {
    if (this.stopped) return;
    if (!this.lua) { this.readyPending = true; return; }   // 脚本未加载完：延后
    this.event('session.ready', { dimension: this.sessionInfo.dimension ?? null });
  }

  // ================= 实时流（SSE /stream 的进程内出口） =================

  // 统一出口：为事件打单调 seq → 入对应内存环 → 广播实时流。
  // 平台侧不落库（聊天记录/日志都不持久化）：实时流是唯一入口，断线只能从进程内存环续传。
  publish(type, evt) {
    const seq = ++this._streamSeq;
    const stamped = { seq, type, ...evt };
    if (type === 'log') pushRing(this._logRing, stamped, RING_LOG);
    else if (type === 'action') pushRing(this._actionRing, stamped, RING_ACTION);
    else if (type === 'chat') pushRing(this._chatRing, stamped, RING_CHAT);
    else if (type === 'event') pushRing(this._eventRing, stamped, RING_EVENT);
    this.emitStream(stamped);
    return stamped;
  }

  // 订阅实时事件（log / action / chat）：返回取消函数。宿主断线/关机时才退订。
  subscribeStream(fn) {
    this._streamSubs.add(fn);
    return () => this._streamSubs.delete(fn);
  }

  emitStream(evt) {
    for (const fn of this._streamSubs) {
      try { fn(evt); } catch { /* 订阅方异常不影响引擎 */ }
    }
  }

  // 按 seq 之后取内存环（SSE 补历史 / 断线续传）
  ringSince(type, sinceSeq) {
    const ring = type === 'log' ? this._logRing : type === 'action' ? this._actionRing
      : type === 'event' ? this._eventRing : this._chatRing;
    return ring.filter((e) => e.seq > sinceSeq);
  }

  // 聊天入站（驱动 chat 事件）：命令总线 + Lua 事件广播不变，另入内存环与实时流。
  // sender_kind/sender 原样上抛——平台侧只做展示，不做权威判断（sender_kind 防伪造由引擎给出）。
  onChat(p) {
    this.dispatchCommand(p.text ?? '', p.sender ?? null, false);
    this.event('chat', p);
    this.publish('chat', {
      ts: p.ts ?? nowMs(),
      text: String(p.text ?? ''),
      raw: String(p.raw ?? ''),
      sender: p.sender ?? null,
      sender_kind: p.sender_kind ?? 'unknown',
    });
  }

  onSelf(p) {
    this.self = { ...p, ts: nowMs() };
    if (p.pos) {
      // 围栏策略：越界 -> 引擎自动 pause（不抛给脚本）
      const fence = this.policy?.fence;
      if (fence && !this.inFence(p.pos, fence)) {
        if (!this.paused) {
          this.log('warn', `[${this.name}] 越出活动围栏 ${JSON.stringify(p.pos)} -> 自动 pause`);
          this.pause('fence');
        }
      }
    }
  }

  inFence(pos, fence) {
    const [a, b] = fence;
    return pos.x >= Math.min(a[0], b[0]) && pos.x <= Math.max(a[0], b[0])
        && pos.z >= Math.min(a[1], b[1]) && pos.z <= Math.max(a[1], b[1]);
  }

  onWindow(p) {
    const w = {
      id: p.id, type: p.type ?? 'custom', title: p.title ?? '',
      size: p.size ?? 0,
      slots: new Map((p.slots ?? []).filter((s) => s.item).map((s) => [s.index, s.item])),
      cursor: p.cursor ?? null,
      revision: (this.windows.get(p.id)?.revision ?? 0) + 1,
      ts: nowMs(),
    };
    this.windows.set(p.id, w);
    if (w.type !== 'inventory' && this.currentWindowId == null) this.currentWindowId = p.id;
  }

  onWindowClose(p) {
    this.windows.delete(p.id);
    if (this.currentWindowId === p.id) {
      this.currentWindowId = null;
      this.event('container.closed', { id: p.id });
    }
  }

  // ================= 暂停门控 =================

  // 引擎侧 timer 统一经此登记：pause 冻结（保留剩余时相）、resume 重建、stop 清理。
  // 注意：重连退避 timer 不走此通道（pause 期间必须继续跑）。
  armTimer(fn, delay, { repeat = false } = {}) {
    const d = Math.max(0, Number(delay) || 0);
    const spec = { fn, delay: d, repeat, handle: null, startedAt: nowMs(), remain: d };
    this.timerSpecs.add(spec);
    this.startSpec(spec);
    return spec;
  }
  startSpec(spec) {
    spec.startedAt = nowMs();
    if (spec.repeat) {
      spec.handle = setInterval(spec.fn, spec.delay);
    } else {
      // 一次性 spec 到点即从台账移除：已触发的 after/sleep 不得被 freeze/unfreeze 重放
      spec.handle = setTimeout(() => {
        spec.handle = null;
        this.timerSpecs.delete(spec);
        spec.fn();
      }, spec.remain);
    }
  }
  clearSpec(spec) {
    if (spec.repeat) clearInterval(spec.handle);
    else clearTimeout(spec.handle);
    spec.handle = null;
    this.timerSpecs.delete(spec);   // 提前取消同样出账；冻结走 freezeTimers（保留台账待 resume 重挂）
  }
  freezeTimers() {
    const now = nowMs();
    for (const spec of this.timerSpecs) {
      if (spec.repeat) clearInterval(spec.handle);
      else clearTimeout(spec.handle);
      spec.handle = null;
      spec.remain = spec.repeat ? spec.delay : Math.max(0, spec.delay - (now - spec.startedAt));
    }
  }
  unfreezeTimers() {
    for (const spec of this.timerSpecs) {
      if (spec.handle) continue;
      this.startSpec(spec);
    }
  }

  pause(reason) {
    if (this.paused) return;
    this.paused = true;
    this.pauseReason = reason ?? 'manual';
    // 停走 + 取消寻路
    try { Promise.resolve(this.driver.path_cancel?.()).catch?.(() => {}); } catch { /* ignore */ }
    try { Promise.resolve(this.driver.move_input({ fwd: 0, strafe: 0, jump: 0, sneak: 0, sprint: 0 })).catch?.(() => {}); } catch { /* ignore */ }
    // 冻结 timer 队列（DESIGN §4：pause = 停 timer；断线期间不再经 on_timer spawn 新任务）
    this.freezeTimers();
    // 进行中的动作以 runtime.paused 失败；交付冻结于门，resume 时在冻结点重抛
    for (const [tok, rec] of this.tokens) {
      if (rec.kind === 'action' && rec.taskId && !rec.settled) {
        this.settle(tok, null, JSON.stringify(TYPE_ERR('runtime.paused', `pause(${this.pauseReason}) 期间动作中止`)));
      }
    }
    this.event('lifecycle', { kind: 'on_pause', payload: { reason: this.pauseReason } });
    this.log('warn', `[${this.name}] PAUSE (${this.pauseReason})`);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const wasReason = this.pauseReason;
    this.pauseReason = null;
    this.log('info', `[${this.name}] RESUME（原暂停原因 ${wasReason}）`);
    // 解冻 timer：到点的立即触发，未到点的按剩余时相续跑
    this.unfreezeTimers();
    this.event('lifecycle', { kind: 'on_resume', payload: { reason: wasReason } });
    // 解冻：冻结点重抛（含 runtime.paused 的动作错误走正常重试路径）
    const q = this.frozen;
    this.frozen = [];
    for (const [id, okj, ej] of q) this.deliver(id, okj, ej);
  }

  deliver(taskId, okj, ej) {
    if (this.paused) {
      this.frozen.push([taskId, okj, ej]);
      return;
    }
    if (this.luaDepth > 0) {
      this.pendingResume.push([taskId, okj, ej]);   // Lua 帧内：排队，帧尾统一交付
      return;
    }
    this.rawResume(taskId, okj, ej);
  }

  rawResume(taskId, okj, ej) {
    this.luaDepth++;
    try {
      this.luaFn('__core_resume')(taskId, okj ?? '', ej ?? '');
    } catch (e) {
      this.log('error', `resume 失败 task=${taskId}: ${e.message}
${e.stack ?? ''}`);
    } finally {
      this.luaDepth--;
    }
    this.flushPending();
  }

  flushPending() {
    while (this.pendingResume.length && this.luaDepth === 0 && !this.paused) {
      const [id, okj, ej] = this.pendingResume.shift();
      this.rawResume(id, okj, ej);
    }
  }

  event(kind, payload) {
    if (!this.lua) return;   // Lua 未就绪（启动竞态）：丢弃
    this.luaDepth++;
    try {
      this.luaFn('__core_event')(kind, payload === undefined ? '' : JSON.stringify(payload));
    } catch (e) {
      this.log('error', `事件 ${kind} 分发失败: ${e.message}`);
    } finally {
      this.luaDepth--;
    }
    this.flushPending();
  }

  /** 平台事件入站（控制通道 /event）：有等待者直付，否则入队（容量 64，溢出丢最旧） */
  pushEvent(type, data) {
    const ev = { type: String(type), data: (data && typeof data === 'object') ? data : {}, ts: nowMs() };
    const w = this.eventWaiters.shift();
    if (w) {
      this.clearSpec(w.timer);
      this.settle(w.token, JSON.stringify(ev), '');
      return;
    }
    if (this.eventQueue.length >= 64) this.eventQueue.shift();
    this.eventQueue.push(ev);
  }

  mountVfs(file, content) {
    return new Promise((res, rej) => this.factory.mountFile(file, content).then(res, rej));
  }

  luaFn(name) {
    if (!this['_fn_' + name]) this['_fn_' + name] = this.lua.global.get(name);
    return this['_fn_' + name];
  }

  // ================= Lua VM =================

  async createLua() {
    const { LuaFactory } = await import('wasmoon');
    // Windows 下 emscripten 对非 file:// 路径误用 fetch：初始化期间屏蔽 fetch 强制走 fs
    const realFetch = globalThis.fetch;
    globalThis.fetch = undefined;
    let lua;
    let factory;
    try {
      factory = new LuaFactory();
      lua = await factory.createEngine();
    } finally {
      globalThis.fetch = realFetch;
    }
    this.lua = lua;
    this.factory = factory;
    const mount = (file, content) => this.mountVfs(file, content);

    await mount('json.lua', readFileSync(path.join(__dirname, 'lua', 'json.lua'), 'utf8'));
    await mount('bslib.lua', readFileSync(path.join(__dirname, 'lua', 'bslib.lua'), 'utf8'));
    await mount('bootstrap.lua', readFileSync(path.join(__dirname, 'lua', 'bootstrap.lua'), 'utf8'));
    // 实例脚本目录进入 package.path（require 限实例目录 + bslib 预载，DESIGN §2.3）
    const scriptDir = (this.opts.scriptDir ?? process.cwd()).replaceAll('\\', '/');
    await lua.doString(`package.path = ${JSON.stringify(scriptDir + '/?.lua;')} .. package.path`);
    await lua.doString(`
      require "bootstrap"
      bslib = require "bslib"   -- 行为策略库以全局注入（CAPABILITIES §13）
    `);
    // 实例目录全部 .lua 挂入 VFS（require 限实例目录，DESIGN §2.3）
    const instDir = this.opts.scriptDir;
    if (instDir && existsSync(instDir)) {
      for (const f of readdirSync(instDir).filter((f2) => f2.endsWith('.lua'))) {
        await mount(f, readFileSync(path.join(instDir, f), 'utf8'));
      }
    }

    this.registerBridges();
  }

  settle(token, okj, ej) {
    const rec = this.tokens.get(token);
    if (!rec) return;
    rec.settled = true;
    this.settled.set(token, [okj, ej]);
    if (rec.waiterRegistered) this.deliverToken(token);
  }

  deliverToken(token) {
    const [okj, ej] = this.settled.get(token) ?? ['', ''];
    const rec = this.tokens.get(token);
    if (!rec) return;
    this.tokens.delete(token);
    this.settled.delete(token);
    if (rec.detached) return;        // fire-and-forget
    if (rec.taskId == null) return;
    this.deliver(rec.taskId, okj, ej);
  }

  newToken() {
    const token = this.nextToken++;
    this.tokens.set(token, { settled: false, waiterRegistered: false });
    return token;
  }

  registerBridges() {
    const G = (name, fn) => this.lua.global.set(name, (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.log('error', `[bridge:${name}] ${e.stack ?? e.message}`);
        throw e;
      }
    });

    // ---- 基础 ----
    G('__log', (level, msg) => this.log(level, `[${this.name}] ${msg}`));
    G('__now', () => nowMs());
    G('__fire_token', (token) => {
      const rec = this.tokens.get(Number(token));
      if (rec) rec.detached = true;
    });

    // ---- 调度桥 ----
    G('__core_register_waiter', (taskId, token, kind) => {
      const rec = this.tokens.get(Number(token));
      if (!rec) return;
      rec.waiterRegistered = true;
      rec.taskId = Number(taskId);
      rec.waitKind = String(kind);   // 保留 rec.kind（action 等），等待类别单独存放
      if (rec.settled) this.deliverToken(Number(token));
    });

    G('__sleep_register', (j) => {
      const { ms } = JSON.parse(j || '{}');
      const token = this.newToken();
      const rec = this.tokens.get(token);
      rec.kind = 'sleep';
      this.armTimer(() => this.settle(token, '', ''), Math.max(0, Number(ms) || 0));
      return token;
    });

    G('__new_waiter', (j) => {
      const { timeout } = JSON.parse(j || '{}');
      const token = this.newToken();
      const rec = this.tokens.get(token);
      rec.kind = 'waiter';
      this.armTimer(() => {
        // 超时：交付 ""（await_chat 返回 nil）
        const t = this.tokens.get(token);
        if (t && !t.settled) this.settle(token, '', '');
      }, Math.max(0, Number(timeout) || 5000));
      return token;
    });

    G('__resolve_waiter', (token, matchJson) => {
      const rec = this.tokens.get(Number(token));
      if (rec && !rec.settled) this.settle(Number(token), matchJson ?? '', '');
    });

    // join（race/parallel）状态全在 Lua 侧（bootstrap __JOINS）：JS 不可重入 Lua，
    // 因此 join 结算经由 finish() 在 pump 的 Lua 帧内完成，不走 JS token 通道。

    // ---- rex（引擎侧 JS 正则，命名分组） ----
    G('__rex_new', (pat) => {
      const id = this.rexList.size ? Math.max(...this.rexList.keys()) + 1 : 1;
      try {
        this.rexList.set(id, new RegExp(pat));
      } catch (e) {
        throw new Error(`rex 编译失败: ${e.message} (${pat})`);
      }
      return id;
    });
    G('__rex_match', (id, text) => {
      const re = this.rexList.get(Number(id));
      if (!re || text == null) return '';
      const m = re.exec(String(text));
      if (!m) return '';
      return JSON.stringify(m.groups ?? {});
    });

    // ---- 定时器 ----
    G('__timer_register', (j) => {
      const id = this.pendingTimers.length + 1;
      const { interval } = JSON.parse(j || '{}');
      const t = { id, interval: Math.max(50, Number(interval) || 1000) };
      if (this.started) this.activateTimer(t);   // 运行期注册的定时器立即生效
      else this.pendingTimers.push(t);
      return id;
    });
    G('__after_register', (j) => {
      const { delay } = JSON.parse(j || '{}');
      const id = this.pendingTimers.length + 1;
      const t = { id, once: true, delay: Math.max(0, Number(delay) || 0) };
      if (this.started) this.activateTimer(t);
      else this.pendingTimers.push(t);
      return id;
    });

    // ---- 脚本上报（events.emit → 实时流 event 通道；宿主决定去向） ----
    G('__evt_emit', (j) => {
      const { type, data } = JSON.parse(j || '{}');
      const evt = this.publish('event', {
        ts: nowMs(),
        name: String(type ?? '').slice(0, 64),
        data: (data && typeof data === 'object' && !Array.isArray(data)) ? data : {},
      });
      return String(evt.seq);
    });

    // ---- 平台事件（§17 /event 注入 → Lua events.next）：入队或直付首个等待者 ----
    G('__evt_next', (j) => {
      const { timeout } = JSON.parse(j || '{}');
      const token = this.newToken();
      this.tokens.get(token).kind = 'event';
      const ev = this.eventQueue.shift();
      if (ev) {
        this.settle(token, JSON.stringify(ev), '');
        return token;
      }
      const w = { token };
      w.timer = this.armTimer(() => {
        const i = this.eventWaiters.indexOf(w);
        if (i >= 0) this.eventWaiters.splice(i, 1);
        const t = this.tokens.get(token);
        if (t && !t.settled) this.settle(token, '', '');   // 超时交付 ""（events.next 返回 nil）
      }, Math.max(0, Number(timeout) || 30000));
      this.eventWaiters.push(w);
      return token;
    });

    this.registerParamsBridge();
    this.registerPersistBridge();
    this.registerCommandBridge();
    this.registerQueries();
    this.registerActions();
  }

  activateTimer(t) {
    if (t.once) {
      this.armTimer(() => this.event('after', { id: t.id }), t.delay);
    } else {
      this.armTimer(() => this.event('timer', { id: t.id }), t.interval, { repeat: true });
    }
  }

  // ---- params ----
  registerParamsBridge() {
    const G = (name, fn) => this.lua.global.set(name, (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.log('error', `[bridge:${name}] ${e.stack ?? e.message}`);
        throw e;
      }
    });
    G('__params_decl', (j) => {
      const schema = JSON.parse(j || '{}');
      for (const [k, v] of Object.entries(schema)) this.paramsSchema.set(k, v);
    });
    G('__param_get', (k) => {
      if (this.paramValues.has(k)) return JSON.stringify(this.paramValues.get(k));
      return '';
    });
  }

  bindParams() {
    // 包清单 params（DESIGN §6）：{type,...} 形态 = schema + 默认值；纯值形态 = 默认值。
    // Lua 侧 params{...} 声明的 schema 优先；实例事实住持久化值（paramPersist）。
    const declared = new Map(this.paramsSchema);
    const defaults = {};
    for (const [k, entry] of Object.entries(this.cfg.params ?? {})) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.type !== undefined) {
        if (!declared.has(k)) {
          declared.set(k, entry);
          this.paramsSchema.set(k, entry);   // 清单 schema 进入校验面（Lua 声明优先）
        }
        if (entry.default !== undefined) defaults[k] = entry.default;
      } else {
        defaults[k] = entry;
      }
    }
    const values = { ...defaults, ...(this.opts.instanceParams ?? {}) };
    // 类型转换（blockpos/region 列表形态 -> {x,y,z} / [corner, corner]）
    for (const [k, schema] of declared) {
      let v = values[k] ?? schema.default;
      if (v === undefined) {
        // v2 流程（DESIGN §5.3）：实例值运行期经控制渠道设置后持久化——
        // required 未设不阻塞启动（观察模式也要能 boot），由脚本自行处理缺值
        if (schema.required) {
          this.log('warn', `[${this.name}] 参数 ${k} 必填：暂未设置（运行期经控制渠道设置后持久化）`);
        }
        continue;
      }
      v = this.coerceParam(v, schema.type, k);
      values[k] = v;
    }
    // 持久化值优先于清单初值（DESIGN §5.3）
    for (const [k, v] of this.paramPersist) values[k] = v;
    for (const [k, v] of Object.entries(values)) this.paramValues.set(k, v);
    this.persistParams();
  }

  coerceParam(v, type, k) {
    if (type === 'blockpos') {
      if (Array.isArray(v)) return { x: v[0], y: v[1], z: v[2] };
      return v;
    }
    if (type === 'region') {
      if (Array.isArray(v)) return [{ x: v[0][0], y: v[0][1], z: v[0][2] }, { x: v[1][0], y: v[1][1], z: v[1][2] }];
      return v;
    }
    if (type === 'list<blockpos>') {
      return (v ?? []).map((p) => Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p);
    }
    return v;
  }

  persistParams() {
    const obj = Object.fromEntries(this.paramPersist);
    this.persist.kvSet('bot', 'params', JSON.stringify(obj));
  }

  setParam(k, v) {
    // 控制总线统一入口：schema 校验 + 脚本校验钩 + 持久化（params 修改渠道收敛点）
    if (!this.paramsSchema.has(k)) throw TYPE_ERR('param.unknown', k);
    const coerced = this.coerceParam(v, this.paramsSchema.get(k).type, k);
    // 脚本注册的校验钩（TOB-522，如 transfer_pattern 热更校验）：
    // 非空返回 = 拒绝，抛错前未落任何状态 -> 旧值继续生效
    if (this.lua) {
      const reject = this.luaFn('__params_validate')(k, JSON.stringify(coerced ?? null));
      if (reject) throw TYPE_ERR('param.rejected', `${k}: ${reject}`);
    }
    this.paramValues.set(k, coerced);
    this.paramPersist.set(k, coerced);
    this.persistParams();
    this.log('info', `[${this.name}] param ${k} = ${JSON.stringify(coerced)}`);
  }

  // ---- persist ----
  registerPersistBridge() {
    const G = (name, fn) => this.lua.global.set(name, (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.log('error', `[bridge:${name}] ${e.stack ?? e.message}`);
        throw e;
      }
    });
    const P = this.persist;
    G('__persist_table', (name, j) => P.declareTable(String(name), JSON.parse(j || '{}')));
    G('__persist_find', (j) => {
      const { name, where } = JSON.parse(j);
      const r = P.find(String(name), where ?? {});
      return r ? JSON.stringify(r) : '';
    });
    G('__persist_all', (j) => JSON.stringify(P.all(String(JSON.parse(j).name))));
    G('__persist_upsert', (name, j) => P.upsert(String(name), JSON.parse(j)));
    G('__persist_del', (name, j) => P.del(String(name), JSON.parse(j || '{}')));
    G('__persist_adjust', (j) => {
      const { name, key, delta, num_field, key_field } = JSON.parse(j);
      const r = P.adjust(String(name), key, Number(delta), String(key_field), String(num_field));
      return JSON.stringify(r);
    });
    G('__persist_seen', (key, win) => P.seen(String(key), Number(win)));
    G('__kv_get', (name, k) => P.kvGet(String(name), String(k)));
    G('__kv_set', (name, k, v) => P.kvSet(String(name), String(k), String(v)));
    G('__persist_log', (name) => { P.logDeclare(String(name)); return ''; });
    G('__log_append', (j) => {
      const { name, fields } = JSON.parse(j);
      return P.logAppend(String(name), fields);
    });
    G('__log_find', (j) => {
      const { name, where } = JSON.parse(j);
      return JSON.stringify(P.logFind(String(name), where ?? {}));
    });
    G('__log_mark', (name, id, state) => P.logMark(String(name), Number(id), String(state)));
    G('__txn_begin', () => P.txnBegin());
    G('__txn_commit', () => P.txnCommit());
    G('__txn_rollback', () => P.txnRollback());
  }

  // ---- 命令 ----
  registerCommandBridge() {
    const G = (name, fn) => this.lua.global.set(name, (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.log('error', `[bridge:${name}] ${e.stack ?? e.message}`);
        throw e;
      }
    });
    G('__command_register', (j) => {
      const { pattern, perm, index } = JSON.parse(j);
      const tokens = String(pattern).trim().split(/\s+/).map((t) => {
        const m = t.match(/^<(\w+):(\w+)>$/);
        return m ? { name: m[1], type: m[2] } : { lit: t };
      });
      this.commands.push({ pattern: String(pattern), tokens, perm: perm ?? 'player', index });
    });
  }

  authorityLevel(sender) {
    const auth = this.policy?.authority ?? {};
    if (sender == null) return 100; // console
    if (!sender) return 0;
    if ((auth.owner ?? []).includes(sender)) return 80;
    if ((auth.op ?? []).includes(sender)) {
      // 未显式配 owner 时 op 兼任 owner（内建命令 perm=owner）
      return (auth.owner?.length ? 60 : 80);
    }
    if ((auth.whitelist ?? []).includes(sender)) return 20;
    return 10;
  }
  levelName(perm) {
    return { console: 100, owner: 80, op: 60, whitelist: 20, player: 10, pvp: 10, bank: 10 }[perm] ?? 10;
  }

  parseCommandArgs(tokens, words) {
    const args = {};
    let wi = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.lit !== undefined) {
        if (words[wi] !== t.lit) return null;
        wi++;
      } else {
        if (t.type === 'blockpos' || t.type === 'pos') {
          const x = Number(words[wi]), y = Number(words?.[wi + 1]), z = Number(words?.[wi + 2]);
          if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return null;
          args[t.name] = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
          wi += 3;
        } else if (t.type === 'number') {
          const v = Number(words[wi]);
          if (Number.isNaN(v)) return null;
          args[t.name] = v; wi++;
        } else if (t.type === 'duration') {
          const m = String(words[wi]).match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
          if (!m) return null;
          const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60000 : 1;
          args[t.name] = Math.round(Number(m[1]) * mult); wi++;
        } else {
          // player / item / filter / string
          args[t.name] = words[wi];
          wi++;
        }
        if (args[t.name] === undefined) return null;
      }
    }
    if (wi !== words.length) return null;
    return args;
  }

  /** 聊天/CLI 命令入口（同一命令总线、同一鉴权） */
  dispatchCommand(text, sender, fromConsole = false) {
    const words = String(text).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    const senderLevel = fromConsole ? 100 : this.authorityLevel(sender);

    // 内建命令（不经脚本；v1：owner 列表缺省时 op 兼任）
    const builtins = {
      pause: { level: 80, run: () => { this.pause('command'); } },
      resume: { level: 80, run: () => { this.resume(); } },
      status: {
        level: 80,
        run: () => {
          const s = `state=${this.sessionState} paused=${this.paused}(${this.pauseReason}) pos=${this.self?.pos ? `${Math.round(this.self.pos.x)} ${Math.round(this.self.pos.y)} ${Math.round(this.self.pos.z)}` : '?'}`;
          if (fromConsole) this.log('info', `[${this.name}] ${s}`);
          else this.driver.chat_send(s).catch(() => {});
        },
      },
    };
    const b = builtins[words[0]];
    if (b && words.length === 1) {
      if (senderLevel < b.level) {
        this.log('warn', `[${this.name}] 命令 ${words[0]} 被拒（${sender} 权限不足）`);
        return true;
      }
      b.run();
      return true;
    }

    // 脚本命令：字面量前缀最长优先
    const cands = this.commands
      .filter((c) => c.tokens[0]?.lit !== undefined && words[0] === c.tokens[0].lit)
      .sort((a, b2) => b2.tokens.length - a.tokens.length);
    for (const c of cands) {
      const args = this.parseCommandArgs(c.tokens, words);
      if (!args) continue;
      const need = this.levelName(c.perm);
      if (senderLevel < need) {
        this.log('warn', `[${this.name}] 命令 "${c.pattern}" 被拒（${sender ?? 'console'} 权限不足）`);
        if (!fromConsole) {
          this.driver.chat_send(`权限不足`).catch(() => {});
        }
        return true;
      }
      this.event('command', { index: c.index, args: { ...args, sender } });
      return true;
    }
    return false;
  }

  taskList() {
    try {
      const j = this.luaFn('__task_list_json')?.();
      return j ? JSON.parse(j) : [];
    } catch { return []; }
  }

  taskListFull() {
    try {
      const j = this.luaFn('__task_list_full_json')?.();
      return j ? JSON.parse(j) : [];
    } catch { return []; }
  }

  /** 控制通道按名取消（协作式，bootstrap task.cancel 语义） */
  cancelTask(name) {
    try {
      const j = this.luaFn('__task_cancel_by_name')?.(String(name));
      return j ? JSON.parse(j) : { ok: false, found: false };
    } catch (e) {
      return { ok: false, found: false, error: String(e?.message ?? e) };
    }
  }

  /**
   * 一次性脚本（HTTP /eval，2026-09-10 用户改拍板：控制面提供 one-shot Lua）：
   * 与包脚本同环境同边界（动作仍经 Policy），作为具名任务运行——可 await 动作、
   * /tasks 可见可取消、返回值/失败走日志。编译失败抛出（HTTP 400）。
   * EVAL_GLUE 与 LuaHost.java 保持一字不差。
   */
  static EVAL_GLUE = `
    local src, n = __EVAL_CODE, __EVAL_NAME
    __EVAL_CODE, __EVAL_NAME = nil, nil
    local c, err = load(src, "=eval:" .. n)
    if not c then error(err) end
    __DECL.tasks[n] = { opts = {}, fn = function()
      local r = c()
      if r ~= nil then log.info("[eval:" .. n .. "] => " .. tostring(r)) end
    end }
    task.spawn(n)`;

  evalOnce(name, code) {
    this.lua.global.set('__EVAL_CODE', String(code));
    this.lua.global.set('__EVAL_NAME', String(name));
    // doString 同步完成编译+spawn；编译错误（glue 里 load 失败的 error）由此抛出
    return this.lua.doString(BotEngine.EVAL_GLUE);
  }

  // ---- 查询 ----
  registerQueries() {
    const G = (name, fn) => this.lua.global.set(name, (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.log('error', `[bridge:${name}] ${e.stack ?? e.message}`);
        throw e;
      }
    });

    G('__q_self', () => {
      const s = this.self;
      if (!s) return '{}';
      return JSON.stringify({
        username: s.username ?? null,   // bot 自身用户名（TOB-522 最小暴露；接收门/收款判定默认锚定用）
        pos: s.pos, yaw: s.yaw, pitch: s.pitch,
        health: s.health, food: s.food, gamemode: s.gamemode,
        held: s.held ?? null, held_slot: s.heldSlot ?? 0,
      });
    });
    G('__q_look', () => {
      const s = this.self;
      if (!s) return '{}';
      // 脚本侧 0..360 约定
      return JSON.stringify({ yaw: (((s.yaw ?? 0) % 360) + 360) % 360, pitch: s.pitch ?? 0 });
    });
    G('__q_entities', () => JSON.stringify(this.driver.query_entities?.() ?? []));
    G('__q_entity_snap', (j) => {
      const { id } = JSON.parse(j || '{}');
      const e = this.driver.query_entity?.(String(id));
      return e ? JSON.stringify(e) : '';
    });
    G('__q_block', (j) => {
      const { pos } = JSON.parse(j || '{}');
      const key = posKey(pos);
      let hit = this.world.get(key);
      if (!hit && this.driver.query_block_sync) {
        const name = this.driver.query_block_sync(pos);
        if (name) {
          hit = { name, ts: nowMs() };
          this.world.set(key, hit);
        }
      }
      if (!hit) return '{}';
      return JSON.stringify({
        name: hit.name,
        is_container: CONTAINER_BLOCKS.has(String(hit.name).replace('minecraft:', '')
          ? String(hit.name) : String(hit.name)),
        ts: hit.ts,
      });
    });
    G('__q_staleness', (j) => {
      const { pos } = JSON.parse(j || '{}');
      const hit = this.world.get(posKey(pos));
      return JSON.stringify(hit ? nowMs() - hit.ts : -1);
    });
    G('__q_distance', (j) => {
      const { pos } = JSON.parse(j || '{}');
      const s = this.self;
      if (!s?.pos) return 'null';
      return JSON.stringify(dist3(s.pos, pos));
    });
    G('__q_can_reach', (j) => {
      const { pos } = JSON.parse(j || '{}');
      const s = this.self;
      if (!s?.pos) return 'false';
      // v1：直线距离 <= 64 视作可达（L3 缺失时直线退化的一致口径）
      return JSON.stringify(dist3(s.pos, pos) <= 64);
    });
    G('__q_current_window', () => JSON.stringify(this.currentWindowId));
    G('__q_window', (j) => {
      const { window } = JSON.parse(j || '{}');
      let w;
      if (window === '0') {
        // 背包视图：容器打开时 = 打开窗口的玩家区合并视图
        const cont = this.currentWindowId != null ? this.windows.get(this.currentWindowId) : null;
        if (cont) {
          const size = cont.size;
          const slots = [];
          for (let i = 0; i < 36; i++) slots.push({ index: i, item: null });
          for (const [idx, item] of cont.slots) {
            let inv = null;
            if (idx >= size && idx < size + 27) inv = idx - size + 9;      // 主背包
            else if (idx >= size + 27 && idx < size + 36) inv = idx - size - 27; // 快捷栏
            if (inv != null) slots[inv] = { index: inv, item };
          }
          return JSON.stringify({
            id: '0', type: 'inventory', title: '背包', size: 36,
            slots, cursor: cont.cursor, revision: cont.revision,
          });
        }
        w = this.windows.get('0');
        if (!w) return '{}';
      } else {
        w = this.windows.get(String(window));
        if (!w) return '{}';
      }
      const slots = [];
      for (let i = 0; i < (w.size || 0) + 36; i++) slots.push({ index: i, item: null });
      for (const [idx, item] of w.slots) slots[idx] = { index: idx, item };
      return JSON.stringify({
        id: w.id, type: w.type, title: w.title, size: w.size,
        slots, cursor: w.cursor, revision: w.revision,
      });
    });
    G('__q_cooldown', () => {
      const cd = weaponCooldownMs(this.lastAttackWeapon);
      const left = this.lastAttack + cd - nowMs();
      return JSON.stringify(left > 0 ? left : 0);
    });
    G('__q_session_state', () => JSON.stringify(this.sessionState));
    G('__q_session_info', () => JSON.stringify(this.sessionInfo));
    G('__q_caps', (j) => {
      const { flag } = JSON.parse(j || '{}');
      const caps = this.driver.caps?.() ?? {};
      return JSON.stringify(caps[flag] === true);
    });
    G('__q_server_version', () => JSON.stringify(this.sessionInfo?.version ?? this.connectCfg.version ?? null));
    G('__q_stack_size', (j) => JSON.stringify(stackSizeOf(JSON.parse(j || '{}').id)));
    G('__q_weapon_score', (j) => {
      const { id } = JSON.parse(j || '{}');
      const s = WEAPON_SCORE[id];
      return s ? JSON.stringify(s) : '';
    });
    G('__q_dimension', () => JSON.stringify(this.sessionInfo?.dimension ?? null));
    G('__q_time_of_day', () => JSON.stringify(this.sessionInfo?.time_of_day ?? null));
    G('__q_weather', () => JSON.stringify(this.sessionInfo?.weather ?? null));
    G('__task_list', () => JSON.stringify([]));
  }

  // ---- 动作 ----
  registerActions() {
    const G = (name, fn) => this.lua.global.set(name, (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        this.log('error', `[bridge:${name}] ${e.stack ?? e.message}`);
        throw e;
      }
    });
    const A = (name, opts, run) => {
      G('__act_' + name, (j, taskId) => this.actionEntry(name, opts ?? {}, run, j, taskId));
    };

    A('chat_send', { kind: 'chat' }, async (a, h) => {
      const text = String(a.text ?? '');
      this.checkChatPolicy(text);
      await this.driver.chat_send(text);
      return {};
    });

    A('chat_reply', { kind: 'chat' }, async (a, h) => {
      const to = a.to ? String(a.to) : null;
      const text = String(a.text ?? '');
      this.checkChatPolicy(text);
      const msgCmd = this.policy?.chat?.msg_command ?? null;
      if (to && msgCmd) {
        await this.driver.chat_send(`${msgCmd} ${to} ${text}`);
      } else if (to) {
        await this.driver.chat_send(`${to} ${text}`);
      } else {
        await this.driver.chat_send(text);
      }
      return {};
    });

    A('rot', {}, async (a) => {
      if (this.rotHold) return {};   // 关键段（开箱交互等）持有视角，旁路 look 抢向
      const yaw = a.yaw != null ? normYaw(a.yaw) : undefined;
      const pitch = a.pitch != null ? Math.max(-90, Math.min(90, a.pitch)) : undefined;
      await this.driver.rot(yaw, pitch);
      if (this.self) {
        if (yaw != null) this.self.yaw = yaw;
        if (pitch != null) this.self.pitch = pitch;
      }
      return {};
    });

    A('hop', { mov: true }, async () => {
      await this.driver.hop();
      return {};
    });

    A('nav_stop', {}, async () => {
      await this.driver.path_cancel?.();
      await this.driver.move_input({ fwd: 0, strafe: 0, jump: 0, sneak: 0, sprint: 0 });
      return {};
    });

    A('nav_goto', { mov: true }, (a, h) => this.navGoto(a, h));
    A('nav_follow', { mov: true }, (a, h) => this.navFollow(a, h));

    A('world_scan', {}, async (a, h) => {
      const { region, pred, opts } = a;
      const limit = opts?.limit ?? 200;
      const kinds = pred?.type === 'container' ? [...CONTAINER_BLOCKS] : (pred?.names ?? ['chest']);
      const list = await withTimeout(
        this.driver.query_scan(region, kinds, limit), 30000, TYPE_ERR('timeout', 'world.scan'));
      return { list };
    });

    A('container_open', {}, async (a, h) => {
      this.rotHold = true;
      try {
      const aimAt = async (tt) => {
        // 服务器校验交互视线：开箱前先看向方块中心（fabric 客户端不会自动瞄准）
        if (!tt || tt.x === undefined) return;
        const p = this.self?.pos;
        if (!p) return;
        const dx = tt.x + 0.5 - p.x;
        const dy = (tt.y + 0.5) - (p.y + 1.62);
        const dz = tt.z + 0.5 - p.z;
        const horiz = Math.sqrt(dx * dx + dz * dz) || 1e-6;
        await this.driver.rot(normYaw(Math.atan2(-dx, dz) * 180 / Math.PI), Math.atan2(-dy, horiz) * 180 / Math.PI);
        await new Promise((r) => setTimeout(r, 150));
      };
      if (this.currentWindowId != null) {
        // 窗口互斥：先关再开（引擎侧保证不变量）
        await this.driver.window_close();
        this.windows.delete(this.currentWindowId);
        this.currentWindowId = null;
      }
      const t = a.target;
      const target = (t && typeof t === 'object' && t.x !== undefined)
        ? { x: Math.round(t.x), y: Math.round(t.y), z: Math.round(t.z) }
        : { entity: t };
      let res;
      try {
        // 先贴脸：survival reach 有限，走到 1.2 格内再交互最稳
        const p0 = this.self?.pos;
        if (p0 && target.x !== undefined && dist3(p0, target) > 2.5) {
          try { await this.runGotoAwait(target, 1.2, 10); } catch { /* 走不到位也试一次 */ }
        }
        await aimAt(target);
        res = await withTimeout(this.driver.window_open(target), 6000,
          TYPE_ERR('container.missing', JSON.stringify(t)));
      } catch (e) {
        // 重试：先走近（服务器对超出交互距离的交互静默拒绝），再开
        const p = this.self?.pos;
        if (p && target.x !== undefined && dist3(p, target) > 4) {
          try { await this.runGotoAwait(target, 2, 8); } catch { /* 走不过去也再试一次 */ }
        }
        await this.driver.window_close?.().catch?.(() => {});
        await sleep2(600);
        await aimAt(target);
        try {
          res = await withTimeout(this.driver.window_open(target), 6000,
            TYPE_ERR('container.missing', JSON.stringify(t)));
        } catch (e2) {
          // 换方位：服务器要求"视线命中的块"与交互块一致，贴邻半箱会挡视线；
          // 从对角偏移点重新接近，让视线直接命中目标块
          if (target.x === undefined) throw e2;
          for (const off of [{ x: 2, z: 2 }, { x: -2, z: -2 }]) {
            const alt = { x: target.x + off.x, y: target.y, z: target.z + off.z };
            try { await this.runGotoAwait(alt, 1.2, 8); } catch { /* 走不到位也试 */ }
            await aimAt(target);
            try {
              res = await withTimeout(this.driver.window_open(target), 6000,
                TYPE_ERR('container.missing', JSON.stringify(t)));
              break;
            } catch { /* 下一个方位 */ }
          }
          if (!res) throw e2;
        }
      }
      // 等首个窗口快照（若已先到则跳过等待）
      if (!this.windows.get(res.id)) {
        await this.waitWindowRevision(res.id, 0, 4000,
          TYPE_ERR('container.missing', JSON.stringify(t)));
      }
      const w = this.windows.get(res.id);
      if (!w) throw TYPE_ERR('container.missing', JSON.stringify(t));
      // 等 slot 数据灌入（open 事件先到、window items 后到）
      const deadline = nowMs() + 1500;
      while (nowMs() < deadline) {
        if (this.windows.get(res.id)?.revision > 1) break;   // 首快照后的首次更新
        await sleep2(40);
      }
      return { id: w.id, type: w.type, size: w.size };
      } finally { this.rotHold = false; }
    });

    A('container_close', {}, async (a) => {
      await this.driver.window_close();
      if (a.window) this.windows.delete(String(a.window));
      if (this.currentWindowId === String(a.window)) this.currentWindowId = null;
      return {};
    });

    A('window_click', {}, async (a) => {
      const winId = String(a.window ?? '0');
      let slot = Number(a.slot);
      let target = winId;
      if (winId === '0') {
        const cont = this.currentWindowId != null ? this.windows.get(this.currentWindowId) : null;
        if (cont) {
          // 背包槽位 -> 打开窗口玩家区
          const size = cont.size;
          target = cont.id;
          slot = a.slot >= 9 ? size + (a.slot - 9) : size + 27 + a.slot;
        } else {
          target = '0';
        }
      }
      const w = this.windows.get(target);
      const rev = w?.revision ?? 0;
      if (target === '0' && !w) {
        // 无背包窗口快照（驱动未推）：请求一次
        await this.driver.window_refresh?.('0');
      }
      await withTimeout(
        this.driver.window_click(target, slot, Number(a.button) || 0, Number(a.mode) || 0),
        5000, TYPE_ERR('container.closed', target));
      await this.waitWindowRevision(target, rev, 3000, null); // 无更新也继续（有的点击不改变内容）
      return {};
    });

    A('inv_equip', {}, async (a) => {
      const slot = typeof a.slot === 'number' ? a.slot
        : await this.findInvSlotLua(a.slot);
      if (slot == null) return { ok: false };
      const heldSlot = this.self?.heldSlot ?? 0;
      if (slot === heldSlot) return { ok: true };
      if (slot >= 0 && slot <= 8) {
        // 主背包快捷栏内：swap
        await this.doClick('0', slot, heldSlot, 2);
      } else {
        await this.doClick('0', slot, 0, 0);
        await this.doClick('0', heldSlot, 0, 0);
        await this.doClick('0', slot, 0, 0);
      }
      return { ok: true };
    });

    A('inv_drop', {}, async (a) => {
      // Q / Ctrl+Q：点击协议 mode=4 已由窗口句柄覆盖；inv 域丢弃走同一动词（P2 细化）
      this.log('warn', `[${this.name}] inv.drop 暂未实现（P2）`);
      return {};
    });

    A('use_entity', {}, async (a) => {
      if (a.kind === 'attack') {
        this.lastAttack = nowMs();
        this.lastAttackWeapon = this.self?.held?.id ?? null;
        this.actionCount('attack');
      }
      await this.driver.use_entity(a.id, a.kind ?? 'attack');
      return {};
    });

    A('use_block', {}, async (a) => {
      if (a.place) {
        // place = 同一协议动作（手持物 + 潜行态决定结果）
        await this.driver.use_block(posKey2Pos(a.pos), true);
      } else {
        await this.driver.use_block(posKey2Pos(a.pos), false);
      }
      return {};
    });

    A('use_item', {}, async (a) => {
      const dur = Math.max(0, Number(a.duration) || 0);
      await this.driver.use_item('start');
      await new Promise((r) => setTimeout(r, dur));
      if (!this.stopped) await this.driver.use_item('release');
      return {};
    });

    A('dig', {}, async (a) => {
      // 完成以 block_update 确认（v1 简化：start + 定时上限）
      this.actionCount('dig');
      await this.driver.dig(posKey2Pos(a.pos), 'start');
      return {};
    });
  }

  actionEntry(name, opts, run, j, taskId) {
    const args = j ? JSON.parse(j) : {};
    const token = this.newToken();
    const rec = this.tokens.get(token);
    rec.kind = 'action';
    rec.taskId = taskId != null ? Number(taskId) : null;
    rec.name = name;

    // 策略门控（全部在引擎；驱动不二次判断）
    const polErr = this.policyCheck(name, args, opts);
    if (polErr) {
      this.settle(token, '', JSON.stringify(polErr));
      return token;
    }
    if (this.runtimeCfg.dry_run) {
      this.log('info', `[${this.name}][dry] ${name} ${JSON.stringify(args).slice(0, 120)}`);
      this.settle(token, '{}', '');
      return token;
    }
    // 发包速率（每秒；未配置 = 不限）。超限直接拒绝该动作，脚本收到 permission.denied 可自行退避。
    const rateErr = this.actionRateCheck();
    if (rateErr) {
      this.settle(token, '', JSON.stringify(rateErr));
      return token;
    }
    this.actionCount(name);
    this.publish('action', { ts: nowMs(), task: taskId, action: name, args: safeBrief(args) });

    let h;
    const promise = new Promise((resolve) => { h = makeHandler(this, token, resolve); });
    promise.catch(() => {});
    (async () => {
      try {
        const result = await run(args, h);
        // 返回 h = 动作自管解析（nav.walk/follow 等长操作）；否则立即结算
        if (result !== h) this.settle(token, JSON.stringify(result ?? {}), '');
      } catch (e) {
        const err = e && e.kind ? e : { kind: e?.botscriptKind ?? 'driver.error', detail: String(e?.message ?? e) };
        this.settle(token, '', JSON.stringify(err));
      }
    })();
    return token;
  }

  actionCount(name) {
    this.budgetCount++;
    const limit = this.policy?.budget?.actions_per_hour;
    if (limit && this.budgetCount === limit) {
      this.log('warn', `[${this.name}] 动作预算耗尽（${limit}/h）-> 自动 pause`);
      this.pause('budget');
    }
  }

  // 每秒发包速率（boundary.rate.actions_per_sec；未配置 = 不限）。
  // 用 1 秒滑动窗口计数：超限的动作直接拒绝，脚本收到 permission.denied。
  // 与 budget.actions_per_hour（超额整实例暂停）分工不同：这个只丢当次动作，不打断任务。
  actionRateCheck() {
    const limit = Number(this.policy?.rate?.actions_per_sec);
    if (!limit || !Number.isFinite(limit) || limit <= 0) return null;
    const t = nowMs();
    this.actionStamps = (this.actionStamps ?? []).filter((ts) => t - ts < 1000);
    if (this.actionStamps.length >= limit) {
      return TYPE_ERR('permission.denied', `发包速率超限（${limit}/s）`);
    }
    this.actionStamps.push(t);
    return null;
  }

  // 操作者直接发消息/命令（HTTP POST /chat）。
  //
  // 门控口径：「操作者 = console 级」（与 POST /cmd、/eval 同权：HTTP token 持有者能跑任意 Lua，
  // 聊天命令自然不必再过脚本沙箱）。所以这里**不过 checkChatPolicy**——命令白名单 / say 限速
  // 是限制**脚本**能替 bot 发出什么的（boundary.chat），不该挡住操作者手敲的命令。
  // 脚本侧 chat.say / chat.run_command 仍走 checkChatPolicy（沙箱边界不变）。
  // 出站消息进聊天视图的实时流（sender_kind=self）：前端据此把「我发出的」与「收到的」排成一条时间线，
  // 但平台不落库——断线即丢，聊天记录不存储是产品口径。
  async outboundChat(text) {
    const s = String(text ?? '');
    if (!s.trim()) throw TYPE_ERR('chat.bad_request', 'text 必填');
    if (this.sessionState !== 'playing' && this.sessionState !== 'dry') {
      throw TYPE_ERR('chat.offline', `当前会话状态 ${this.sessionState}，无法发言`);
    }
    if (!this.runtimeCfg.dry_run) await this.driver.chat_send(s);
    return this.publish('chat', { ts: nowMs(), text: s, raw: s, sender: this.name, sender_kind: 'self' });
  }

  checkChatPolicy(text) {
    if (text.startsWith('/')) {
      const whitelist = this.policy?.chat?.commands ?? [];
      const first = text.slice(1).split(/\s+/)[0];
      const ns = first.includes(':') ? first.split(':').slice(1).join(':') : first;
      const ok = whitelist.includes(first) || whitelist.includes('/' + ns);
      if (!ok) throw TYPE_ERR('permission.denied', `命令白名单不含 /${ns}`);
      this.checkCommandRegex(text);
    } else {
      // say 限速（令牌桶：say_rate "N/min"）
      const rate = String(this.policy?.chat?.say_rate ?? '10/min');
      const m = rate.match(/^(\d+)\/(\w+)$/);
      const perMs = m ? (m[2] === 'min' ? 60000 : 1000) / Number(m[1]) : 6000;
      const now = nowMs();
      this.chatTokens = this.chatTokens.filter((t) => now - t < 60000);
      const windowTokens = this.chatTokens.filter((t) => now - t < (m && m[2] === 'min' ? 60000 : 1000));
      if (windowTokens.length >= Number(m?.[1] ?? 10)) {
        throw TYPE_ERR('permission.denied', `say 限速（${rate}）`);
      }
      this.chatTokens.push(now);
      void perMs;
    }
  }

  // 命令文本的正则黑白名单（boundary.chat.commands_deny / commands_allow）。
  // 语义：deny 先判，命中即拒；allow 非空时必须命中其一才放行。
  // 两处都在精确白名单（boundary.chat.commands）之后执行，所以只能**更严**，不可能放宽。
  // 正则来自部署配置（平台下发），写坏的正则在这里捕获并当拒绝处理，不让它抛到动作层。
  checkCommandRegex(text) {
    const deny = this.policy?.chat?.commands_deny ?? [];
    const allow = this.policy?.chat?.commands_allow ?? [];
    const matchAny = (pats) => {
      for (const p of pats) {
        let re;
        try { re = new RegExp(String(p)); } catch { return 'bad-pattern'; }
        if (re.test(text)) return true;
      }
      return false;
    };
    if (deny.length) {
      const hit = matchAny(deny);
      if (hit === 'bad-pattern') throw TYPE_ERR('permission.denied', '命令黑名单正则无效（instance boundary 配置错误）');
      if (hit) throw TYPE_ERR('permission.denied', '命令命中黑名单（boundary.chat.commands_deny）');
    }
    if (allow.length) {
      const hit = matchAny(allow);
      if (hit === 'bad-pattern') throw TYPE_ERR('permission.denied', '命令白名单正则无效（instance boundary 配置错误）');
      if (!hit) throw TYPE_ERR('permission.denied', '命令未命中正则白名单（boundary.chat.commands_allow）');
    }
  }

  policyCheck(name, args, opts) {
    const policy = this.policy;
    // 观察模式（DESIGN §5.1 默认全拒）：实例未配置 boundary -> 一切动作被拒
    if (!policy) {
      return TYPE_ERR('permission.denied', '实例未配置 boundary（观察模式）：查询与 params 可用，动作全拒');
    }
    // 授权形态：true / "allow"（或任意非 deny 值）；未配置 = 未授即禁
    const granted = (v) => v !== undefined && v !== null && v !== 'deny' && v !== false && v !== 'false';
    // 移动总开关（boundary.allow_move）：只对带 mov 标记的动作（nav_goto / nav_follow / hop）生效。
    // 显式 false 才禁；未配置 = 依各自原有授权（向后兼容）。
    if (opts?.mov && policy.allow_move === false) {
      return TYPE_ERR('policy.blocklist', '移动未授权（boundary.allow_move=false）');
    }
    switch (name) {
      case 'nav_goto':
      case 'nav_follow': {
        const fence = policy.fence;
        if (fence && args.target?.x !== undefined && !this.inFence(args.target, fence)) {
          return TYPE_ERR('permission.denied', `目标 ${JSON.stringify(args.target)} 在围栏外`);
        }
        break;
      }
      case 'dig':
        if (!granted(policy.blocks?.dig)) {
          return TYPE_ERR('policy.blocklist', 'dig 未授权（boundary.blocks.dig）');
        }
        break;
      case 'use_block':
        if (args.place && !granted(policy.blocks?.place)) {
          return TYPE_ERR('policy.blocklist', 'place 未授权（boundary.blocks.place）');
        }
        break;
      case 'use_entity': {
        if (args.kind !== 'attack') break;
        const cp = policy.combat;
        if (!cp || !cp.targets) {
          return TYPE_ERR('policy.blocklist', 'combat 未授权（boundary.combat.targets）');
        }
        const e = this.driver.query_entity?.(String(args.id));
        if (!e) return TYPE_ERR('entity.gone', String(args.id));
        if (!String(e.type).includes(String(cp.targets))) {
          return TYPE_ERR('policy.blocklist', `combat.targets=${cp.targets} 不含 ${e.type}`);
        }
        if (cp.max_engage && this.self?.pos) {
          const d = dist3(this.self.pos, e.pos ?? this.self.pos);
          if (d > cp.max_engage) return TYPE_ERR('policy.blocklist', `超过接战距离 ${d.toFixed(1)} > ${cp.max_engage}`);
        }
        break;
      }
      default:
        break;
    }
    return null;
  }

  async waitWindowRevision(winId, prevRev, timeoutMs, err) {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      const w = this.windows.get(winId);
      if (w && w.revision > prevRev) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    if (err) throw err;
    return false;
  }

  async doClick(winId, slot, button, mode) {
    const w = this.windows.get(winId);
    const rev = w?.revision ?? 0;
    await this.driver.window_click(winId, slot, button, mode);
    await this.waitWindowRevision(winId, rev, 2500, null);
  }

  async findInvSlotLua(filter) {
    // filter 形如 {id=...}
    const j = this.luaFn('__q_window')('{ "window": "0" }');
    const snap = JSON.parse(j || '{}');
    for (const sl of (snap.slots ?? [])) {
      if (sl.item && (!filter?.id || sl.item.id === filter.id)) return sl.index;
    }
    return null;
  }

  // ================= 导航 =================

  // 内部用：等待走到位（container_open 重试路径）
  async runGotoAwait(target, arrive, timeoutSec) {
    if (this.driver.caps?.()['nav.pathfinder']) {
      await this.driver.path_to(target, { arrive, timeout: timeoutSec });
      return;
    }
    await new Promise((resolve) => {
      const h = { resolve, reject: resolve, onCancel: null };
      this.straightGoto(target, { arrive, timeout: timeoutSec * 1000 }, h);
      setTimeout(resolve, timeoutSec * 1000 + 500);
    });
  }

  navGoto(a, h) {
    const target = a.target;
    if (!target || target.x === undefined) {
      // 实体目标：取活位置
      const e = this.driver.query_entity?.(String(a.target?.id ?? a.target));
      if (!e) {
        h.reject(TYPE_ERR('entity.gone', 'nav.walk 目标实体不存在'));
        return h;
      }
      return this.runGoto(e.pos, a.opts ?? {}, h);
    }
    return this.runGoto(normalizePos(target), a.opts ?? {}, h);
  }

  runGoto(target, opts, h) {
    const arrive = opts.arrive ?? 1.5;
    const timeout = opts.timeout != null ? opts.timeout * 1000 : 30000;   // nav timeout 单位 = 秒（与设计样例一致）
    if (this.driver.caps?.()['nav.pathfinder']) {
      const deadline = nowMs() + timeout;
      const timer = setTimeout(() => {
        this.driver.path_cancel();
        this.event('nav.failed', { reason: 'timeout', target });
        h.resolve({ ok: false, reason: 'timeout' });
      }, timeout);
      h.onCancel = () => { clearTimeout(timer); this.driver.path_cancel(); };
      this.driver.path_to(target, opts).then((r) => {
        clearTimeout(timer);
        if (r.ok) h.resolve({ ok: true });
        else {
          this.event('nav.failed', { reason: r.reason ?? 'unreachable', target });
          h.resolve({ ok: false, reason: r.reason ?? 'unreachable' });
        }
      }, (e) => {
        clearTimeout(timer);
        this.event('nav.failed', { reason: 'unreachable', target });
        h.resolve({ ok: false, reason: 'unreachable' });
      });
      return h;   // 动作自管解析：actionEntry 不自动结算
    }
    // L3 缺失：直线可达执行（move_input 直走 + 单格跳跃）
    this.straightGoto(target, { ...opts, arrive, timeout }, h);
    return h;
  }

  straightGoto(target, opts, h) {
    const state = { last: this.self?.pos ?? target, lastProgress: nowMs(), stopped: false };
    const arrive = opts.arrive ?? 1.5;
    const deadline = nowMs() + ((opts.timeout != null ? opts.timeout * 1000 : 30000));
    const iv = setInterval(async () => {
      if (state.stopped) return;
      if (this.paused) { stop('paused'); return; }   // 暂停：停走，交付冻结于门
      try {
        const p = this.self?.pos;
        if (!p) return;
        const d = dist2d(p, target);
        if (d <= arrive) {
          stop('ok');
          return;
        }
        if (nowMs() > deadline) { stop('timeout'); return; }
        if (dist3(p, state.last) < 0.15) {
          if (nowMs() - state.lastProgress > 6000) { stop('stuck'); return; }
          // 卡住：跳一格
          await this.driver.move_input({ fwd: 1, strafe: 0, jump: 1, sneak: 0, sprint: 0 });
          setTimeout(() => { if (!state.stopped) this.driver.move_input({ fwd: 1, strafe: 0, jump: 0, sneak: 0, sprint: 0 }); }, 250);
        } else {
          state.last = p;
          state.lastProgress = nowMs();
        }
        // 直线退化必须朝向目标才走得到（keep_rotation 只对真实寻路器有语义）
        {
          const yaw = normYaw(Math.atan2(-(target.x - p.x), target.z - p.z) * 180 / Math.PI);
          await this.driver.rot(yaw, 0);
        }
        await this.driver.move_input({ fwd: 1, strafe: 0, jump: 0, sneak: 0, sprint: 0 });
      } catch { stop('unreachable'); }
    }, 100);
    const stop = (how) => {
      if (state.stopped) return;
      state.stopped = true;
      clearInterval(iv);
      this.driver.move_input({ fwd: 0, strafe: 0, jump: 0, sneak: 0, sprint: 0 }).catch?.(() => {});
      if (how === 'ok') h.resolve({ ok: true });
      else {
        this.event('nav.failed', { reason: how === 'cancel' ? 'interrupted' : how, target });
        h.resolve({ ok: false, reason: how });
      }
    };
    h.onCancel = () => stop('cancel');
    h.onPauseAbort = () => stop('paused');
  }

  navFollow(a, h) {
    const opts = a.opts ?? {};
    const want = opts.distance ?? 2;
    const e = this.driver.query_entity?.(String(a.entity_id));
    if (!e) { h.resolve({ ok: false, reason: 'entity.gone' }); return h; }
    let alive = true;
    h.onCancel = () => { alive = false; this.driver.path_cancel?.(); };
    const loop = async () => {
      while (alive && !this.stopped) {
        const cur = this.driver.query_entity?.(String(a.entity_id));
        if (!cur || cur.alive === false) {
          alive = false;
          h.resolve({});
          return;
        }
        const d = this.self?.pos ? dist3(this.self.pos, cur.pos) : Infinity;
        if (d > want + 1) {
          try {
            await this.driver.path_to(cur.pos, { arrive: want, timeout: 5000 });
          } catch { /* 目标在动：循环重试（设计 §2.2 规则 3） */ }
        } else {
          await this.driver.path_cancel?.();
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    };
    loop();
    return h;
  }
}

// ---------- 帮手 ----------

function sleep2(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normYaw(deg) {
  let y = deg % 360;
  if (y > 180) y -= 360;
  if (y < -180) y += 360;
  return y;
}
function posKey2Pos(p) { return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }; }
function safeBrief(args) {
  const s = JSON.stringify(args);
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}
async function withTimeout(p, ms, err) {
  let to;
  const t = new Promise((_, rej) => { to = setTimeout(() => rej(err), ms); });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(to);
  }
}
function makeHandler(engine, token, resolve) {
  return {
    resolve: (v) => engine.settle(token, JSON.stringify(v ?? {}), ''),
    reject: (err) => engine.settle(token, '', JSON.stringify(err)),
    token,
  };
}
