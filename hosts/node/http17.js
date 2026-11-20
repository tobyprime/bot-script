// hosts/node/http17.js — §17 控制通道（路由表由 contracts/http17.openapi.yaml 生成）
//
// 只绑 127.0.0.1；默认端口冲突自动顺延；token 启动时自动生成并打印。
// Fabric 宿主（HttpApi.java）实现同一组形状；http17-conformance 向量逐路由比对。
import http from 'node:http';
import crypto from 'node:crypto';
import { ROUTES } from './http17.routes.generated.js';
import { ABI_VERSION } from './abi.generated.js';

const DEFAULT_PORT = 25580;
const MAX_BODY = 1 << 20;

export function startHttpApi(engine, { log = console.log, port, token: tokenArg } = {}) {
  const portEnv = Number(port);
  const basePort = Number.isFinite(portEnv) && portEnv > 0
    ? portEnv
    : (Number(process.env.BOTSCRIPT_HTTP_PORT) > 0 ? Number(process.env.BOTSCRIPT_HTTP_PORT) : DEFAULT_PORT);
  const token = tokenArg
    || process.env.BOTSCRIPT_HTTP_TOKEN
    || crypto.randomUUID().replaceAll('-', '').slice(0, 24);

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const parseBody = async (req) => JSON.parse((await readBody(req)) || '{}');

  const handlers = {
    getState: (req, res) => {
      const s = engine.self;
      const attempts = engine.reconAttempts ?? 0;
      return json(res, 200, {
        name: engine.name,
        host: 'node',
        session: engine.sessionState,
        session_info: engine.sessionInfo,
        paused: engine.paused,
        pause_reason: engine.pauseReason ?? null,
        reconnecting: engine.sessionState !== 'playing' && attempts > 0,
        reconnect_attempts: attempts,
        next_retry_in: engine.reconnectDueAt != null ? Math.max(0, engine.reconnectDueAt - Date.now()) : null,
        credential_updated_at: engine.credentialUpdatedAt ?? null,
        self: s ? { ...s, held: s.held ?? null } : null,
        tasks: engine.taskListFull(),
        window: engine.currentWindowId,
        caps: engine.driver.caps?.() ?? {},
      });
    },
    getParams: (req, res) => {
      const snap = engine.paramsSnapshot();
      return json(res, 200, { schema: snap?.schema ?? {}, values: snap?.values ?? {} });
    },
    postParams: async (req, res) => {
      const body = await parseBody(req);
      const changed = {};
      for (const [k, v] of Object.entries(body)) {
        try {
          engine.setParam(k, v);
          changed[k] = engine.paramsSnapshot()?.values?.[k];
        } catch (e) {
          return json(res, 400, { error: 'param.rejected', key: k, detail: String(e?.detail ?? e?.message ?? e) });
        }
      }
      return json(res, 200, { ok: true, changed });
    },
    postPause: async (req, res) => {
      const body = await parseBody(req);
      engine.pause(String(body.reason ?? 'operator'));
      return json(res, 200, { ok: true, paused: engine.paused });
    },
    postResume: async (req, res) => {
      engine.resume();
      return json(res, 200, { ok: true, paused: engine.paused });
    },
    postReload: async (req, res) => {
      try {
        const body = await parseBody(req);
        const r = await engine.reloadScripts({ reason: String(body.reason ?? 'operator') });
        return json(res, 200, r);
      } catch (e) {
        if (e?.kind === 'runtime.busy') return json(res, 409, { error: e.kind, detail: e.detail ?? e.message });
        if (e?.kind === 'runtime.error') return json(res, 409, { error: e.kind, detail: e.detail ?? e.message });
        return json(res, 400, { error: e?.kind ?? 'lua.compile', detail: String(e?.detail ?? e?.message ?? e) });
      }
    },
    postEval: async (req, res) => {
      const body = await parseBody(req);
      const code = String(body.code ?? '');
      if (!code.trim()) return json(res, 400, { error: 'code required' });
      const name = String(body.name ?? '').trim() || `eval-${Date.now() % 100000}`;
      try {
        const r = engine.evalOnce(name, code);
        return json(res, 200, r ?? { ok: true, task: name });
      } catch (e) {
        return json(res, 400, { error: e?.kind ?? 'lua.compile', detail: String(e?.message ?? e) });
      }
    },
    postEvent: async (req, res) => {
      const body = await parseBody(req);
      if (!body.type) return json(res, 400, { error: 'type required' });
      engine.pushEvent(String(body.type), body.data);
      return json(res, 200, { ok: true, queued: engine.eventQueue.length });
    },
    postSession: async (req, res) => {
      const body = await parseBody(req);
      try {
        return json(res, 200, engine.updateSessionCredential(body));
      } catch (e) {
        if (e?.kind === 'session.bad_request') return json(res, 400, { error: e.kind, detail: e.message });
        if (e?.kind === 'session.account_mode' || e?.kind === 'session.identity_mismatch') {
          return json(res, 409, { error: e.kind, detail: e.message });
        }
        throw e;
      }
    },
    getTasks: (req, res) => json(res, 200, { tasks: engine.taskListFull() }),
    postTasksCancel: async (req, res) => {
      const body = await parseBody(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      return json(res, 200, engine.cancelTask(String(body.name)));
    },
    getLogs: (req, res, u) => {
      const since = Number(u.searchParams.get('since') ?? 0) || 0;
      return json(res, 200, {
        logs: engine.logRing.filter((e) => e.ts > since),
        actions: engine.actionLog.filter((e) => e.ts > since),
        chats: engine.chatRing.filter((e) => e.ts > since),
        events: engine.eventRing.filter((e) => e.ts > since),
        next_seq: engine.streamSeq,
      });
    },
    getStream: (req, res, u) => {
      const sinceSeq = Number(u.searchParams.get('since_seq') ?? 0) || 0;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const send = (evt) => res.write(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`);
      let lastSent = sinceSeq;
      for (const type of ['log', 'action', 'chat', 'event']) {
        for (const e of engine.ringSince(type, sinceSeq)) { send(e); lastSent = Math.max(lastSent, e.seq); }
      }
      res.write(': backfill done\n\n');
      const unsub = engine.subscribeStream((evt) => {
        if (evt.seq <= lastSent) return;
        lastSent = evt.seq;
        try { send(evt); } catch { /* 断开由 close 处理 */ }
      });
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
      const cleanup = () => { clearInterval(heartbeat); unsub(); };
      req.on('close', cleanup);
      res.on('error', cleanup);
      return undefined;
    },
    postChat: async (req, res) => {
      const body = await parseBody(req);
      try {
        const evt = await engine.outboundChat(String(body.text ?? ''));
        return json(res, 200, { ok: true, seq: evt.seq });
      } catch (e) {
        if (e?.kind) return json(res, 400, { error: e.kind, detail: e.detail ?? null });
        throw e;
      }
    },
    getPersist: (req, res, u) => {
      const table = u.searchParams.get('table');
      const kv = u.searchParams.get('kv');
      try {
        if (table) return json(res, 200, { table, rows: engine.persist.all(table) });
        if (kv) return json(res, 200, { kv, values: engine.persist.kvAll(kv) });
        return json(res, 200, engine.persist.listTables());
      } catch (e) {
        return json(res, 400, { error: 'persist.query', detail: String(e?.message ?? e) });
      }
    },
    getCaps: (req, res) => json(res, 200, {
      host: 'node',
      abi: ABI_VERSION,
      runtime: `node ${process.version}`,
      flags: engine.driver.caps?.() ?? {},
      patches: engine.driver.patches?.() ?? [],
      data_registry: engine.data?.registry === true,
      manifest: {
        name: engine.cfg.name ?? engine.name,
        scripts: engine.cfg.scripts ?? [],
        params: engine.cfg.params ?? {},
        persist: engine.cfg.persist ?? null,
      },
    }),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const route = u.pathname.replace(/\/+$/, '') || '/';
      const auth = req.headers.authorization ?? '';
      const qToken = u.searchParams.get('token') ?? '';
      if (auth !== `Bearer ${token}` && qToken !== token) {
        return json(res, 401, { error: 'unauthorized' });
      }
      const byPath = ROUTES.filter((r) => r.path === route);
      if (!byPath.length) return json(res, 404, { error: 'not found' });
      const hit = byPath.find((r) => r.method === req.method);
      if (!hit) return json(res, 405, { error: 'method not allowed' });
      const fn = handlers[hit.operationId];
      if (!fn) return json(res, 404, { error: 'not found' });
      return await fn(req, res, u);
    } catch (e) {
      return json(res, 400, { error: 'bad request', detail: String(e?.message ?? e) });
    }
  });

  return new Promise((resolve, reject) => {
    let port = basePort;
    let attempts = 0;
    const tryListen = () => {
      attempts++;
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempts <= 20) {
          port++;
          tryListen();
        } else {
          reject(e);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        log('info', `[http] 控制通道 http://127.0.0.1:${port} token=${token}`);
        resolve({ port, token, server });
      });
    };
    tryListen();
  });
}
