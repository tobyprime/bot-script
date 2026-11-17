// httpapi.js — HTTP 控制通道（CAPABILITIES §17：宿主常开能力，非配置项）
// 只绑 127.0.0.1；默认端口冲突自动顺延；token 启动时自动生成并打印到控制台。
// 绑定覆盖仅经宿主启动参数（env：BOTSCRIPT_HTTP_PORT / BOTSCRIPT_HTTP_TOKEN）。
// 无 /eval：只有观察、params、命令（同一命令总线、同一 authority 鉴权）。
import http from 'node:http';
import crypto from 'node:crypto';

const DEFAULT_PORT = 25580;
const MAX_BODY = 1 << 20;

export function startHttpApi(engine, { log = console.log } = {}) {
  const portEnv = Number(process.env.BOTSCRIPT_HTTP_PORT);
  const basePort = Number.isFinite(portEnv) && portEnv > 0 ? portEnv : DEFAULT_PORT;
  const token = process.env.BOTSCRIPT_HTTP_TOKEN
    || crypto.randomUUID().replaceAll('-', '').slice(0, 24);

  // 日志/动作/聊天环由 BotEngine 维护（单一出口、带单调 seq），这里只读不写。
  // 平台侧不落库：/logs 与 /stream 都只是「进程内存环 + 实时增量」的视图。

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

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const route = u.pathname.replace(/\/+$/, '') || '/';
      // 鉴权：Authorization: Bearer <token> 或 ?token=
      const auth = req.headers.authorization ?? '';
      const qToken = u.searchParams.get('token') ?? '';
      if (auth !== `Bearer ${token}` && qToken !== token) {
        return json(res, 401, { error: 'unauthorized' });
      }

      switch (route) {
        case '/state': {
          const s = engine.self;
          const attempts = engine.reconAttempts ?? 0;
          return json(res, 200, {
            name: engine.name,
            host: 'mineflayer',
            session: engine.sessionState,
            session_info: engine.sessionInfo,
            paused: engine.paused,
            pause_reason: engine.pauseReason,
            // 断线重连可观测（TOB-475）：重连进行中 / 已尝试次数 / 下次重连剩余毫秒
            reconnecting: engine.sessionState !== 'playing' && attempts > 0,
            reconnect_attempts: attempts,
            next_retry_in: engine.reconnectDueAt != null
              ? Math.max(0, engine.reconnectDueAt - Date.now())
              : null,
            // 凭据轮换可观测（TOB-489）：最近一次 POST /session 生效时刻（平台推送确认用）
            credential_updated_at: engine.credentialUpdatedAt ?? null,
            self: s ? {
              ...s,
              held: s.held ?? null,
            } : null,
            tasks: engine.taskListFull(),
            window: engine.currentWindowId,
            caps: engine.driver.caps?.() ?? {},
          });
        }

        case '/params': {
          if (req.method === 'GET') {
            return json(res, 200, {
              schema: Object.fromEntries(engine.paramsSchema),
              values: Object.fromEntries(engine.paramValues),
            });
          }
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const changed = {};
            for (const [k, v] of Object.entries(body)) {
              try {
                engine.setParam(k, v);
                changed[k] = engine.paramValues.get(k);
              } catch (e) {
                return json(res, 400, { error: 'param.rejected', key: k, detail: String(e?.detail ?? e?.message ?? e) });
              }
            }
            return json(res, 200, { ok: true, changed });
          }
          return json(res, 405, { error: 'method not allowed' });
        }

        case '/cmd': {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const body = JSON.parse((await readBody(req)) || '{}');
          const cmd = String(body.cmd ?? '');
          if (!cmd.trim()) return json(res, 400, { error: 'cmd required' });
          // token 持有者 = 实例操作者：console 级权限进同一命令总线
          const matched = engine.dispatchCommand(cmd, null, true);
          return json(res, 200, { ok: true, matched });
        }

        case '/eval': {
          // 一次性 Lua（2026-09-10 用户改拍板）：代码作为具名任务进入运行时，同环境同边界
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const body = JSON.parse((await readBody(req)) || '{}');
          const code = String(body.code ?? '');
          if (!code.trim()) return json(res, 400, { error: 'code required' });
          const name = String(body.name ?? '').trim() || `eval-${Date.now() % 100000}`;
          try {
            await engine.evalOnce(name, code);
            return json(res, 200, { ok: true, task: name });
          } catch (e) {
            return json(res, 400, { error: 'lua.compile', detail: String(e?.message ?? e) });
          }
        }

        case '/event': {
          // 平台事件入站（agent 经 §17 代理转发）：入队 → Lua events.next 消费
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const body = JSON.parse((await readBody(req)) || '{}');
          if (!body.type) return json(res, 400, { error: 'type required' });
          engine.pushEvent(String(body.type), body.data);
          return json(res, 200, { ok: true, queued: engine.eventQueue.length });
        }

        case '/session': {
          // 凭据更新（TOB-489，契约冻结见 issue）：写入 connectCfg.account.accessToken，
          // 在线连接零动作，断线/重连环路下一次重连即用新 token。token 值不进日志/响应。
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const body = JSON.parse((await readBody(req)) || '{}');
          try {
            return json(res, 200, engine.updateSessionCredential(body));
          } catch (e) {
            if (e?.kind === 'session.bad_request') {
              return json(res, 400, { error: e.kind, detail: e.message });
            }
            if (e?.kind === 'session.account_mode' || e?.kind === 'session.identity_mismatch') {
              return json(res, 409, { error: e.kind, detail: e.message });
            }
            throw e;
          }
        }

        case '/tasks':
          return json(res, 200, { tasks: engine.taskListFull() });

        case '/tasks/cancel': {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const body = JSON.parse((await readBody(req)) || '{}');
          if (!body.name) return json(res, 400, { error: 'name required' });
          return json(res, 200, engine.cancelTask(String(body.name)));
        }

        case '/logs': {
          const since = Number(u.searchParams.get('since') ?? 0) || 0;
          return json(res, 200, {
            logs: engine._logRing.filter((e) => e.ts > since),
            actions: engine.actionLog.filter((e) => e.ts > since),
            chats: engine._chatRing.filter((e) => e.ts > since),
            next_seq: engine._streamSeq,
          });
        }

        // 实时流（SSE）：先按 since_seq 补内存环里的历史，再接实时增量。
        // 不落库——断线只能续传「本进程此刻仍留在环里的」事件；进程重启即清空。
        case '/stream': {
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
          for (const e of engine.ringSince('log', sinceSeq)) { send(e); lastSent = Math.max(lastSent, e.seq); }
          for (const e of engine.ringSince('action', sinceSeq)) { send(e); lastSent = Math.max(lastSent, e.seq); }
          for (const e of engine.ringSince('chat', sinceSeq)) { send(e); lastSent = Math.max(lastSent, e.seq); }
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
        }

        // 操作者发消息/命令（console 级：不过脚本沙箱的 chat 策略——命令白名单 / say 限速只约束脚本）
        case '/chat': {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const body = JSON.parse((await readBody(req)) || '{}');
          try {
            const evt = await engine.outboundChat(String(body.text ?? ''));
            return json(res, 200, { ok: true, seq: evt.seq });
          } catch (e) {
            if (e?.kind) return json(res, 400, { error: e.kind, detail: e.detail ?? null });
            throw e;
          }
        }

        case '/persist': {
          const table = u.searchParams.get('table');
          const kv = u.searchParams.get('kv');
          try {
            if (table) return json(res, 200, { table, rows: engine.persist.all(table) });
            if (kv) return json(res, 200, { kv, values: engine.persist.kvAll(kv) });
            return json(res, 200, engine.persist.listTables());
          } catch (e) {
            return json(res, 400, { error: 'persist.query', detail: String(e?.message ?? e) });
          }
        }

        case '/caps': {
          return json(res, 200, {
            host: 'mineflayer',
            runtime: `node ${process.version}`,
            flags: engine.driver.caps?.() ?? {},
            manifest: {
              name: engine.cfg.name ?? engine.name,
              scripts: engine.cfg.scripts ?? [],
              params: engine.cfg.params ?? {},
              persist: engine.cfg.persist ?? null,
              net: engine.cfg.net ?? [],
            },
            net: { manifest: engine.cfg.net ?? [], granted: engine.policy?.net ?? [] },
          });
        }

        default:
          return json(res, 404, { error: 'not found' });
      }
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
