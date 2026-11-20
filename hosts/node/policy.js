// hosts/node/policy.js — 策略规则引擎（ABI v2：没有命令体系；gate 覆盖协议动作）
//
// 默认开放：boundary 缺省 / 字段缺省 = 不限制；只有显式配置的字段才收紧动作。
// 唯一入口在 hosts/node/abi.js 的 dispatch；本文件只回答「允许/拒绝 + 错误 kind」。
// 同判由 contracts/vectors/policy/*.json 锁定（Fabric Policy.java 跑同一份）。
import { TYPE_ERR } from './tokens.js';

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class Policy {
  constructor(boundary, { now = Date.now, entityLookup, selfPos, isContainerOpen } = {}) {
    this.boundary = boundary ?? null;
    this.now = now;
    this.entityLookup = entityLookup ?? (() => null);
    this.selfPos = selfPos ?? (() => null);
    this.isContainerOpen = isContainerOpen ?? (() => false);
    this.actionStamps = [];
    this.chatTokens = [];
    this.budgetCount = 0;
  }

  /**
   * 自定义网络包权限位（boundary.packets）。
   * 与其他边界字段相反：缺省 = 拒绝，只有显式 true/"allow" 才开放。
   * 入站事件与出站 act.custom_payload 共用此判定（engine.js / abi.js）。
   */
  packetsAllowed() {
    const v = this.boundary?.packets;
    return v === true || v === 'true' || v === 'allow';
  }

  inFence(pos) {
    const fence = this.boundary?.fence;
    if (!fence || !pos) return true;
    const [a, b] = fence;
    return pos.x >= Math.min(a[0], b[0]) && pos.x <= Math.max(a[0], b[0])
        && pos.z >= Math.min(a[1], b[1]) && pos.z <= Math.max(a[1], b[1]);
  }

  /** 动作门控：允许返回 null；拒绝返回类型化错误。缺省（boundary 或字段未配置）= 允许。 */
  check(op, args = {}) {
    const b = this.boundary ?? {};

    // 权限位：唯一「缺省拒绝」的边界字段（显式授予才开放，见 packetsAllowed）
    if (op === 'act.custom_payload') {
      return this.packetsAllowed()
        ? null
        : TYPE_ERR('policy.blocklist', '自定义网络包未授权（boundary.packets=true 才开放）');
    }

    if (op === 'act.chat_send') return this.checkChat(String(args.kind ?? 'chat'), String(args.text ?? ''));

    if (op === 'act.input') {
      const zero = Number(args.forward ?? 0) === 0 && Number(args.right ?? 0) === 0
        && Number(args.up ?? 0) === 0 && !args.sprint && !args.sneak;
      if (zero) return null;   // 停走永远允许（含 pause/急停路径）
      if (b.allow_move === false) return TYPE_ERR('policy.blocklist', '移动未授权（boundary.allow_move=false）');
      return null;
    }
    if (op === 'act.path_to') {
      if (b.allow_move === false) return TYPE_ERR('policy.blocklist', '移动未授权（boundary.allow_move=false）');
      if (args.target && !this.inFence(args.target)) {
        return TYPE_ERR('permission.denied', `目标 ${JSON.stringify(args.target)} 在围栏外`);
      }
      return null;
    }
    if (op === 'act.dig') {
      return denied(b.blocks?.dig) ? TYPE_ERR('policy.blocklist', 'dig 未授权（boundary.blocks.dig）') : null;
    }
    if (op === 'act.use_block') {
      if (String(args.intent ?? 'use') === 'place' && denied(b.blocks?.place)) {
        return TYPE_ERR('policy.blocklist', 'place 未授权（boundary.blocks.place）');
      }
      return null;
    }
    if (op === 'act.use_entity' && String(args.kind ?? 'attack') === 'attack') {
      const cp = b.combat;
      // 未配置 targets = 不限制目标；配置后才按类型/接战距离收紧
      if (!cp?.targets) return null;
      const e = this.entityLookup(String(args.id ?? ''));
      if (!e) return TYPE_ERR('entity.gone', String(args.id ?? ''));
      if (!String(e.type).includes(String(cp.targets))) {
        return TYPE_ERR('policy.blocklist', `combat.targets=${cp.targets} 不含 ${e.type}`);
      }
      const sp = this.selfPos();
      if (cp.max_engage && sp) {
        const d = dist3(sp, e.pos ?? sp);
        if (d > cp.max_engage) {
          return TYPE_ERR('policy.blocklist', `超过接战距离 ${d.toFixed(1)} > ${cp.max_engage}`);
        }
      }
      return null;
    }
    if (op === 'act.window_open' || op === 'act.window_click' || op === 'act.window_close') {
      // 背包（window='0' 且没有打开的容器）不算容器访问
      const touchContainer = op === 'act.window_open'
        || String(args.window ?? '0') !== '0'
        || this.isContainerOpen();
      // 未配置 = 允许；显式 false/deny 才拒
      if (touchContainer && denied(b.containers)) {
        return TYPE_ERR('policy.blocklist', '容器访问未授权（boundary.containers）');
      }
      return null;
    }
    return null;
  }

  /** 每秒发包速率（boundary.rate.actions_per_sec；未配置 = 不限） */
  rateCheck() {
    const limit = Number(this.boundary?.rate?.actions_per_sec);
    if (!limit || !Number.isFinite(limit) || limit <= 0) return null;
    const t = this.now();
    this.actionStamps = this.actionStamps.filter((ts) => t - ts < 1000);
    if (this.actionStamps.length >= limit) {
      return TYPE_ERR('permission.denied', `发包速率超限（${limit}/s）`);
    }
    this.actionStamps.push(t);
    return null;
  }

  countAction() {
    this.budgetCount++;
    const limit = this.boundary?.budget?.actions_per_hour;
    return !!(limit && this.budgetCount === limit);
  }

  /** chat 策略：command 走白名单/正则；chat 走 say 限速。缺省 = 不限；通过返回 null。 */
  checkChat(kind, text) {
    const chatCfg = this.boundary?.chat ?? {};
    if (kind === 'command') {
      const full = text.startsWith('/') ? text : `/${text}`;
      const whitelist = chatCfg.commands ?? [];
      if (whitelist.length) {
        const first = full.slice(1).split(/\s+/)[0];
        const ns = first.includes(':') ? first.split(':').slice(1).join(':') : first;
        const ok = whitelist.includes(first) || whitelist.includes('/' + ns);
        if (!ok) return TYPE_ERR('permission.denied', `命令白名单不含 /${ns}`);
      }
      return this._checkRegex(full, chatCfg);
    }
    const rate = chatCfg.say_rate;
    if (rate === undefined || rate === null || rate === '') return null;   // 未配置 = 不限
    const m = String(rate).match(/^(\d+)\/(\w+)$/);
    if (!m) return TYPE_ERR('policy.config', `say_rate 格式无效（${rate}），应为 N/min 或 N/sec`);
    const windowMs = m[2] === 'min' ? 60000 : 1000;
    const now = this.now();
    const hits = this.chatTokens.filter((t) => now - t < windowMs);
    if (hits.length >= Number(m[1])) {
      return TYPE_ERR('permission.denied', `say 限速（${rate}）`);
    }
    this.chatTokens = hits.concat([now]);
    return null;
  }

  _checkRegex(text, chatCfg) {
    const deny = chatCfg.commands_deny ?? [];
    const allow = chatCfg.commands_allow ?? [];
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
      if (hit === 'bad-pattern') return TYPE_ERR('permission.denied', '命令黑名单正则无效（instance boundary 配置错误）');
      if (hit) return TYPE_ERR('permission.denied', '命令命中黑名单（boundary.chat.commands_deny）');
    }
    if (allow.length) {
      const hit = matchAny(allow);
      if (hit === 'bad-pattern') return TYPE_ERR('permission.denied', '命令白名单正则无效（instance boundary 配置错误）');
      if (!hit) return TYPE_ERR('permission.denied', '命令未命中正则白名单（boundary.chat.commands_allow）');
    }
    return null;
  }
}

function denied(v) {
  return v === false || v === 'false' || v === 'deny';
}
