// hosts/node/deploy.js — deploy.yaml 的唯一解析/归一化（cli / worker 共用）
//
// 形状以 contracts/deploy.schema.json 为准（平台按同一份 schema 生成/校验）。
// 关键契约（2026-11-15 实测事故）：version 必须是**顶层键**；server 对象只认 host/port。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const TOP_KEYS = new Set([
  'package', 'server', 'version', 'server_version', 'account', 'view_distance',
  'boundary', 'params', 'runtime',
]);

/** "host:port" | {host, port} → {host, port}（IPv6 用方括号写法时不做 split） */
export function parseServer(s) {
  if (typeof s === 'string') {
    if (s.startsWith('[')) {
      const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
      return { host: m?.[1] ?? s, port: m?.[2] ? Number(m[2]) : 25565 };
    }
    const [host, port] = s.split(':');
    return { host: host || '127.0.0.1', port: port ? Number(port) : 25565 };
  }
  return { host: s?.host ?? '127.0.0.1', port: s?.port ?? 25565 };
}

/** 连接层契约：{host, port, version, account, viewDistance}（mineflayer/Fabric 同口径） */
export function buildConnect(deploy) {
  const server = parseServer(deploy.server);
  const account = typeof deploy.account === 'string' ? { username: deploy.account } : (deploy.account ?? {});
  return {
    host: server.host,
    port: server.port,
    version: deploy.version ?? deploy.server_version,
    account,
    viewDistance: Math.max(2, Math.min(12, Number(deploy.view_distance) || 6)),
  };
}

/** 包清单 + persist 相对路径解析到实例数据根（= 部署文件所在目录，随实例隔离） */
export function buildPackage(pkg, dir) {
  return {
    ...pkg,
    persist: pkg.persist ? path.resolve(dir, pkg.persist) : ':memory:',
  };
}

export function loadInstance(absYaml) {
  const abs = path.resolve(absYaml);
  const deploy = parse(readFileSync(abs, 'utf8')) ?? {};
  const dir = path.dirname(abs);
  const pkgDir = path.resolve(dir, deploy.package ?? '.');
  const manifestPath = path.join(pkgDir, 'bot.yaml');
  const pkg = existsSync(manifestPath) ? (parse(readFileSync(manifestPath, 'utf8')) ?? {}) : {};
  return { abs, dir, deploy, pkgDir, pkg, pkgAbs: buildPackage(pkg, dir), connect: buildConnect(deploy) };
}

/** 引擎构造参数（cli/worker 同源，避免逐字复制） */
export function engineOptions(inst, { dryRun = false } = {}) {
  return {
    scriptDir: inst.pkgDir,
    boundary: inst.deploy.boundary ?? null,   // 无 boundary = 观察模式（§5.1 默认全拒）
    runtime: inst.deploy.runtime ?? {},
    instanceParams: inst.deploy.params ?? {},
    dryRun,
    connect: inst.connect,
  };
}

/**
 * 部署形状校验（对应 deploy.schema.json；不引 JSON-Schema 运行时，错误信息直接可读）
 * @returns {{level:'error'|'warn', msg:string}[]}
 */
export function validateDeploy(deploy) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  if (!deploy || typeof deploy !== 'object' || Array.isArray(deploy)) {
    err('deploy.yaml 顶层必须是映射');
    return out;
  }
  for (const k of Object.keys(deploy)) {
    if (!TOP_KEYS.has(k)) warn(`未知顶层字段 "${k}"（引擎会忽略；拼写错误？）`);
  }
  if (deploy.server !== undefined) {
    const s = deploy.server;
    if (typeof s === 'string') {
      if (!/^[^:]+(:[0-9]+)?$/.test(s) && !s.startsWith('[')) err(`server 字符串形态非法: ${s}`);
    } else if (s && typeof s === 'object') {
      if (s.version !== undefined) err('version 必须是顶层键（server 对象里的 version 会被忽略）');
      if (s.port !== undefined && !Number.isInteger(s.port)) err('server.port 必须是整数');
    } else {
      err('server 必须是 "host:port" 或 {host, port}');
    }
  }
  if (deploy.account !== undefined && typeof deploy.account === 'string') {
    // 用户名形态：合法
  } else if (deploy.account !== undefined && (!deploy.account || typeof deploy.account !== 'object')) {
    err('account 必须是用户名或对象');
  }
  if (deploy.account && typeof deploy.account === 'object') {
    const auth = deploy.account.auth;
    if (auth !== undefined && !['session', 'offline', 'microsoft'].includes(auth)) {
      err(`account.auth 必须是 session/offline/microsoft（实际 ${auth}）`);
    }
  }
  if (deploy.view_distance !== undefined) {
    const v = Number(deploy.view_distance);
    if (!Number.isInteger(v) || v < 2 || v > 12) err('view_distance 必须是 2..12 的整数');
  }
  if (deploy.boundary !== undefined && deploy.boundary !== null
      && (typeof deploy.boundary !== 'object' || Array.isArray(deploy.boundary))) {
    err('boundary 必须是映射');
  }
  if (deploy.params !== undefined && (!deploy.params || typeof deploy.params !== 'object' || Array.isArray(deploy.params))) {
    err('params 必须是映射');
  }
  if (deploy.runtime !== undefined && (!deploy.runtime || typeof deploy.runtime !== 'object' || Array.isArray(deploy.runtime))) {
    err('runtime 必须是映射');
  }
  return out;
}
