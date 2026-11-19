package com.botscript.mod;

import com.botscript.mod.runtime.AbiDispatcher;
import com.botscript.mod.runtime.BotConfig;
import com.botscript.mod.runtime.HttpRoutes;
import com.botscript.mod.runtime.LuaRuntime;
import com.botscript.mod.runtime.PersistStore;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.MinecraftClient;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * §17 控制通道（Fabric 宿主）：形状与 hosts/node/http17.js 一致，路由表来自 contracts/http17.openapi.yaml。
 *
 * 只绑 127.0.0.1；端口冲突不自动顺延（mod 单实例），token 启动时生成并打印。
 * 线程模型：HTTP 线程只做解析/鉴权，所有游戏/Lua 访问经 MinecraftClient.submit 编组到客户端线程。
 */
public final class HttpApi {

    private static final int DEFAULT_PORT = 25580;
    private static final int MAX_BODY = 1 << 20;

    /** 观测条目（/logs 与 SSE） */
    public record Entry(long seq, long ts, String type, String level, String msg) {}

    private final java.util.function.Supplier<LuaRuntime> rtRef;
    private final java.util.function.Supplier<AbiDispatcher> abiRef;
    private final java.util.function.Supplier<McState> stateRef;
    private final java.util.function.Supplier<PersistStore> persistRef;
    private final java.util.function.Supplier<BotConfig> cfgRef;
    private final java.util.function.Supplier<String> pkgNameRef;
    private final java.util.function.Supplier<McRuntime> runtimeRef;

    private volatile java.util.function.Function<String, JsonObject> reloadFn;
    private volatile java.util.function.Supplier<JsonObject> packagesFn;

    private final List<Entry> logs = new ArrayList<>();
    private final List<Entry> actions = new ArrayList<>();
    private final List<Entry> events = new ArrayList<>();
    private final List<Consumer<JsonObject>> streamSubs = new ArrayList<>();
    private long seq = 0;

    private HttpServer server;
    private String token;
    private int port;

    public HttpApi(java.util.function.Supplier<LuaRuntime> rtRef,
                   java.util.function.Supplier<AbiDispatcher> abiRef,
                   java.util.function.Supplier<McState> stateRef,
                   java.util.function.Supplier<PersistStore> persistRef,
                   java.util.function.Supplier<BotConfig> cfgRef,
                   java.util.function.Supplier<String> pkgNameRef,
                   java.util.function.Supplier<McRuntime> runtimeRef) {
        this.rtRef = rtRef;
        this.abiRef = abiRef;
        this.stateRef = stateRef;
        this.persistRef = persistRef;
        this.cfgRef = cfgRef;
        this.pkgNameRef = pkgNameRef;
        this.runtimeRef = runtimeRef;
    }

    // ================= 观测 =================

    public synchronized void recordLog(String level, String msg) {
        push(logs, "log", level, msg);
    }

    public synchronized void recordAction(String op, String argsJson) {
        push(actions, "action", "info", op + " " + argsJson);
    }

    public synchronized void recordEvent(String type, JsonElement data) {
        push(events, "event", "info", type + " " + data);
    }

    private void push(List<Entry> ring, String type, String level, String msg) {
        Entry e = new Entry(++seq, System.currentTimeMillis(), type, level, msg);
        ring.add(e);
        if (ring.size() > 2000) ring.remove(0);
        JsonObject evt = new JsonObject();
        evt.addProperty("seq", e.seq());
        evt.addProperty("type", type);
        evt.addProperty("ts", e.ts());
        if ("log".equals(type)) {
            evt.addProperty("level", level);
            evt.addProperty("msg", msg);
        } else {
            evt.addProperty("text", msg);
        }
        for (Consumer<JsonObject> sub : new ArrayList<>(streamSubs)) {
            try { sub.accept(evt); } catch (Exception ignored) { }
        }
    }

    public void setRuntimeControl(java.util.function.Function<String, JsonObject> reloadFn,
                                  java.util.function.Supplier<JsonObject> packagesFn) {
        this.reloadFn = reloadFn;
        this.packagesFn = packagesFn;
    }

    public void start(org.slf4j.Logger log) throws IOException {
        String portEnv = System.getenv("BOTSCRIPT_HTTP_PORT");
        int base = 0;
        try { base = Integer.parseInt(portEnv); } catch (Exception ignored) { }
        if (base <= 0) base = DEFAULT_PORT;
        token = System.getenv("BOTSCRIPT_HTTP_TOKEN");
        if (token == null || token.isEmpty()) {
            token = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        }
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", base), 0);
        port = server.getAddress().getPort();
        server.createContext("/", this::route);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();
        log.info("botscript HTTP 控制通道 http://127.0.0.1:{} token={}（env BOTSCRIPT_HTTP_PORT/TOKEN 可覆盖）",
                port, token);
    }

    public int port() { return port; }
    public String token() { return token; }

    // ================= 路由 =================

    private void route(HttpExchange ex) throws IOException {
        boolean streaming = false;
        try {
            Map<String, String> query = new HashMap<>();
            String rawQ = ex.getRequestURI().getRawQuery();
            if (rawQ != null) {
                for (String kv : rawQ.split("&")) {
                    int eq = kv.indexOf('=');
                    if (eq > 0) query.put(urlDecode(kv.substring(0, eq)), urlDecode(kv.substring(eq + 1)));
                }
            }
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            boolean authorized = (auth != null && auth.equals("Bearer " + token)) || token.equals(query.get("token"));
            if (!authorized) {
                send(ex, 401, obj("error", "unauthorized").toString());
                return;
            }
            String path = ex.getRequestURI().getPath();
            if (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);
            String method = ex.getRequestMethod();

            if (path.equals("/stream")) {
                streaming = true;
                serveStream(ex, query);
                return;
            }

            JsonObject body = new JsonObject();
            if (method.equals("POST")) {
                byte[] bytes = ex.getRequestBody().readNBytes(MAX_BODY);
                String rawTxt = new String(bytes, StandardCharsets.UTF_8);
                if (!rawTxt.isBlank()) body = JsonParser.parseString(rawTxt).getAsJsonObject();
            }
            JsonObject out = dispatch(path, method, body, query);
            send(ex, out.has("__status") ? out.remove("__status").getAsInt() : 200, out.toString());
        } catch (Exception e) {
            JsonObject err = obj("error", "bad request");
            err.addProperty("detail", String.valueOf(e.getMessage()));
            try { if (!streaming) send(ex, 400, err.toString()); } catch (Exception ignored) { }
        } finally {
            ex.close();
        }
    }

    private JsonObject dispatch(String path, String method, JsonObject body, Map<String, String> query) {
        // 路由表是生成物：path 存在而 method 不匹配 => 405；两者都不存在 => 404
        boolean known = false;
        boolean methodOk = false;
        for (HttpRoutes.Route r : HttpRoutes.ROUTES) {
            if (!r.path().equals(path)) continue;
            known = true;
            if (r.method().equals(method)) methodOk = true;
        }
        if (!known) {
            // mod 扩展端点（GUI 管理用，不在 §17 契约里）
            return switch (path) {
                case "/reload" -> reload(method, body);
                case "/packages" -> packages();
                default -> status(404, obj("error", "not found"));
            };
        }
        if (!methodOk) return status(405, obj("error", "method not allowed"));
        return switch (path) {
            case "/state" -> state();
            case "/params" -> params(method, body);
            case "/pause" -> pause(method, body);
            case "/resume" -> resume(method, body);
            case "/eval" -> eval(method, body);
            case "/event" -> event(method, body);
            case "/session" -> session(method, body);
            case "/tasks" -> obj("tasks", tasksArray());
            case "/tasks/cancel" -> cancel(method, body);
            case "/logs" -> logs(Long.parseLong(query.getOrDefault("since", "0")));
            case "/chat" -> chat(method, body);
            case "/persist" -> persist(query);
            case "/caps" -> caps();
            default -> status(404, obj("error", "not found"));
        };
    }

    /** GUI 进程内入口（§16.5：GUI 只消费与 HTTP 同源的接口，页面层零业务逻辑）。 */
    public synchronized JsonObject localCall(String path, String method, JsonObject body) {
        try {
            JsonObject out = dispatch(path, method, body == null ? new JsonObject() : body, Map.of());
            out.remove("__status");
            return out;
        } catch (Exception e) {
            JsonObject err = obj("error", "local call failed");
            err.addProperty("detail", String.valueOf(e.getMessage()));
            return err;
        }
    }

    // ================= 端点（客户端线程编组） =================

    private <T> T onClient(java.util.function.Supplier<T> fn) {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.isOnThread()) return fn.get();
        try {
            return mc.submit(fn).get(6, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            // 业务异常（AbiError 等 RuntimeException）原样上抛，HTTP 层才能映射正确状态码
            if (c instanceof RuntimeException re) throw re;
            throw new RuntimeException("client thread 编组失败: " + c.getMessage(), c);
        }
    }

    private JsonObject state() {
        return onClient(() -> {
            JsonObject o = new JsonObject();
            o.addProperty("name", pkgNameRef.get());
            o.addProperty("host", "fabric");
            LuaRuntime rt = rtRef.get();
            AbiDispatcher abi = abiRef.get();
            if (rt == null || abi == null) {
                o.addProperty("session", "idle");
                o.add("session_info", new JsonObject());
                o.addProperty("paused", false);
                o.add("self", JsonNull.INSTANCE);
                o.add("tasks", new JsonArray());
                o.addProperty("window", (String) null);
                o.add("caps", capsFlags());
                return o;
            }
            JsonObject session = JsonParser.parseString(abi.sync("session.get", "{}")).getAsJsonObject();
            o.addProperty("session", session.get("state").getAsString());
            o.add("session_info", session.has("info") ? session.get("info") : new JsonObject());
            o.addProperty("paused", session.has("paused") && session.get("paused").getAsBoolean());
            o.addProperty("pause_reason", session.has("pause_reason") && !session.get("pause_reason").isJsonNull()
                    ? session.get("pause_reason").getAsString() : null);
            o.addProperty("reconnecting", false);
            o.addProperty("reconnect_attempts", 0);
            o.add("next_retry_in", JsonNull.INSTANCE);
            o.add("credential_updated_at", JsonNull.INSTANCE);
            String self = abi.sync("self.get", "{}");
            o.add("self", self.isEmpty() ? JsonNull.INSTANCE
                    : JsonParser.parseString(self).getAsJsonObject());
            o.add("tasks", tasksArray());
            McState st = stateRef.get();
            if (st.currentWindowId() == null) o.add("window", JsonNull.INSTANCE);
            else o.addProperty("window", st.currentWindowId());
            o.add("caps", capsFlags());
            return o;
        });
    }

    private JsonObject params(String method, JsonObject body) {
        if (method.equals("GET")) {
            LuaRuntime rt = rtRef.get();
            BotConfig cfg = cfgRef.get();
            if (rt == null || abiRef.get() == null) {
                // 未进世界：至少回包清单 schema（无法给生效值）
                JsonObject values = new JsonObject();
                if (cfg != null) for (var e : cfg.params.entrySet()) values.add(e.getKey(), e.getValue());
                JsonObject snap = obj("schema", manifestSchema());
                snap.add("values", values);
                return snap;
            }
            JsonObject snap = onClient(() -> {
                try {
                    return LuaRuntime.requireOk(rt.coreCall("params.get", new JsonObject()));
                } catch (LuaRuntime.AbiError e) {
                    return new JsonObject();
                }
            });
            return snap;
        }
        if (method.equals("POST")) {
            LuaRuntime rt = rtRef.get();
            if (rt == null || abiRef.get() == null) return status(400, obj("error", "not booted"));
            for (var e : body.entrySet()) {
                try {
                    onClient(() -> {
                        JsonObject a = new JsonObject();
                        a.addProperty("key", e.getKey());
                        a.add("value", e.getValue());
                        return LuaRuntime.requireOk(rt.coreCall("params.set", a));
                    });
                } catch (LuaRuntime.AbiError ex) {
                    JsonObject rejection = obj("error", ex.kind);
                    rejection.addProperty("detail", ex.detail);
                    rejection.addProperty("key", e.getKey());
                    return status(400, rejection);
                }
            }
            JsonObject changed = new JsonObject();
            for (var e : body.entrySet()) changed.addProperty(e.getKey(), true);
            JsonObject ok = obj("ok", true);
            ok.add("changed", changed);
            return ok;
        }
        return status(405, obj("error", "method not allowed"));
    }

    private JsonObject pause(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        LuaRuntime rt = rtRef.get();
        if (rt == null) return status(400, obj("error", "not booted"));
        String reason = body != null && body.has("reason") ? body.get("reason").getAsString() : "operator";
        onClient(() -> { rt.pause(reason); return true; });
        JsonObject ok = obj("ok", true);
        ok.addProperty("paused", rt.isPaused());
        return ok;
    }

    private JsonObject resume(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        LuaRuntime rt = rtRef.get();
        if (rt == null) return status(400, obj("error", "not booted"));
        onClient(() -> { rt.resume(); return true; });
        JsonObject ok = obj("ok", true);
        ok.addProperty("paused", rt.isPaused());
        return ok;
    }

    private JsonObject eval(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        String code = body.has("code") ? body.get("code").getAsString() : "";
        if (code.isBlank()) return status(400, obj("error", "code required"));
        LuaRuntime rt = rtRef.get();
        if (rt == null) return status(400, obj("error", "not booted"));
        String name = body.has("name") && !body.get("name").getAsString().isBlank()
                ? body.get("name").getAsString() : "eval-" + System.currentTimeMillis() % 100000;
        try {
            onClient(() -> LuaRuntime.requireOk(rt.coreCall("eval.once", args("name", name, "code", code))));
        } catch (LuaRuntime.AbiError e) {
            JsonObject err = obj("error", e.kind == null ? "lua.compile" : e.kind);
            err.addProperty("detail", String.valueOf(e.detail));
            return status(400, err);
        }
        JsonObject ok = obj("ok", true);
        ok.addProperty("task", name);
        return ok;
    }

    private JsonObject event(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        if (!body.has("type")) return status(400, obj("error", "type required"));
        AbiDispatcher abi = abiRef.get();
        if (abi == null) return status(400, obj("error", "not booted"));
        abi.pushEvent(body.get("type").getAsString(),
                body.has("data") ? body.get("data") : new JsonObject());
        JsonObject ok = obj("ok", true);
        ok.addProperty("queued", 1);
        return ok;
    }

    private JsonObject session(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        // Fabric 会话随玩家登录器，mod 不持有凭据（Node 宿主才有 /session 语义）
        JsonObject err = obj("error", "session.account_mode");
        err.addProperty("detail", "fabric 宿主不使用平台注入的会话凭据");
        return status(409, err);
    }

    private JsonObject chat(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        String text = body.has("text") ? body.get("text").getAsString() : "";
        if (text.isBlank()) return status(400, obj("error", "chat.bad_request"));
        McRuntime rt = runtimeRef.get();
        if (rt == null) return status(400, obj("error", "chat.offline"));
        onClient(() -> { rt.chatSendRaw(text, text.startsWith("/") ? "command" : "chat"); return true; });
        recordEvent("chat", args("text", text, "sender_kind", "self"));
        JsonObject ok = obj("ok", true);
        ok.addProperty("seq", seq);
        return ok;
    }

    private JsonArray tasksArray() {
        LuaRuntime rt = rtRef.get();
        if (rt == null) return new JsonArray();
        JsonObject env = onClient(() -> {
            try { return rt.coreCall("tasks.list", new JsonObject()); } catch (Exception e) { return new JsonObject(); }
        });
        JsonElement r = env.has("result") ? env.get("result") : null;
        return r != null && r.isJsonArray() ? r.getAsJsonArray() : new JsonArray();
    }

    private JsonObject cancel(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        if (!body.has("name")) return status(400, obj("error", "name required"));
        LuaRuntime rt = rtRef.get();
        if (rt == null) return status(400, obj("error", "not booted"));
        JsonObject r = onClient(() -> LuaRuntime.requireOk(rt.coreCall("tasks.cancel", args("name", body.get("name").getAsString()))));
        return r;
    }

    private JsonObject logs(long since) {
        JsonObject o = new JsonObject();
        o.add("logs", ringSince(logs, since));
        o.add("actions", ringSince(actions, since));
        o.add("chats", new JsonArray());
        o.add("events", ringSince(events, since));
        o.addProperty("next_seq", seq);
        return o;
    }

    private synchronized JsonArray ringSince(List<Entry> ring, long since) {
        JsonArray arr = new JsonArray();
        for (Entry e : ring) {
            if (e.seq() <= since) continue;
            JsonObject l = new JsonObject();
            l.addProperty("seq", e.seq());
            l.addProperty("ts", e.ts());
            l.addProperty("type", e.type());
            if ("log".equals(e.type())) {
                l.addProperty("level", e.level());
                l.addProperty("msg", e.msg());
            } else {
                l.addProperty("text", e.msg());
            }
            arr.add(l);
        }
        return arr;
    }

    /** SSE：先补环内历史，再接实时增量（与 Node /stream 同形状） */
    private void serveStream(HttpExchange ex, Map<String, String> query) throws IOException {
        long sinceSeq = 0;
        try { sinceSeq = Long.parseLong(query.getOrDefault("since_seq", "0")); } catch (Exception ignored) { }
        ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-cache, no-transform");
        ex.sendResponseHeaders(200, 0);
        OutputStream os = ex.getResponseBody();
        final long[] lastSent = {sinceSeq};
        Consumer<JsonObject> send = evt -> {
            long id = evt.get("seq").getAsLong();
            if (id <= lastSent[0]) return;
            lastSent[0] = id;
            try {
                os.write(("id: " + id + "\ndata: " + evt + "\n\n").getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        };
        synchronized (this) {
            for (Entry e : logs) { if (e.seq() > sinceSeq) send.accept(entryJson(e)); }
            for (Entry e : actions) { if (e.seq() > sinceSeq) send.accept(entryJson(e)); }
            for (Entry e : events) { if (e.seq() > sinceSeq) send.accept(entryJson(e)); }
            os.write(": backfill done\n\n".getBytes(StandardCharsets.UTF_8));
            streamSubs.add(send);
        }
        try {
            while (true) {
                Thread.sleep(15000);
                os.write(": ping\n\n".getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            // 客户端断开/写失败：退订
        } finally {
            synchronized (this) { streamSubs.remove(send); }
            try { os.close(); } catch (Exception ignored) { }
        }
    }

    private static JsonObject entryJson(Entry e) {
        JsonObject l = new JsonObject();
        l.addProperty("seq", e.seq());
        l.addProperty("type", e.type());
        l.addProperty("ts", e.ts());
        if ("log".equals(e.type())) {
            l.addProperty("level", e.level());
            l.addProperty("msg", e.msg());
        } else {
            l.addProperty("text", e.msg());
        }
        return l;
    }

    private JsonObject persist(Map<String, String> query) {
        PersistStore store = persistRef.get();
        if (store == null) return status(400, obj("error", "not booted"));
        String table = query.get("table");
        String kv = query.get("kv");
        if (table != null) {
            try {
                String rows = onClient(() -> store.all(table));
                JsonObject o = obj("table", table);
                o.add("rows", rows.isEmpty() ? new JsonArray() : JsonParser.parseString(rows).getAsJsonArray());
                return o;
            } catch (Exception e) {
                JsonObject err = obj("error", "persist.query");
                err.addProperty("detail", String.valueOf(e.getMessage()));
                return status(400, err);
            }
        }
        if (kv != null) {
            String values = onClient(() -> store.kvAll(kv));
            JsonObject o = obj("kv", kv);
            o.add("values", values.isEmpty() ? new JsonObject() : JsonParser.parseString(values).getAsJsonObject());
            return o;
        }
        return onClient(store::listNames);
    }

    private JsonObject caps() {
        JsonObject manifest = new JsonObject();
        manifest.addProperty("name", pkgNameRef.get());
        BotConfig cfg = cfgRef.get();
        JsonObject params = new JsonObject();
        if (cfg != null) for (var e : cfg.params.entrySet()) params.add(e.getKey(), e.getValue());
        manifest.add("params", params);
        McRuntime rt = runtimeRef.get();
        JsonObject o = obj("host", "fabric");
        o.addProperty("abi", com.botscript.mod.runtime.AbiOps.ABI_VERSION);
        o.addProperty("runtime", "luaj (embedded)");
        o.add("flags", capsFlags());
        o.add("patches", rt != null ? rt.patches() : new JsonArray());
        o.add("manifest", manifest);
        o.add("boundary", boundaryView());
        return o;
    }

    private JsonObject boundaryView() {
        BotConfig cfg = cfgRef.get();
        JsonObject b = new JsonObject();
        b.addProperty("configured", cfg != null && cfg.boundaryConfigured);
        if (cfg == null) return b;
        if (cfg.fenceMin != null) {
            JsonArray fence = new JsonArray();
            JsonArray a = new JsonArray(); a.add(cfg.fenceMin[0]); a.add(cfg.fenceMin[1]);
            JsonArray c = new JsonArray(); c.add(cfg.fenceMax[0]); c.add(cfg.fenceMax[1]);
            fence.add(a); fence.add(c);
            b.add("fence", fence);
        }
        b.addProperty("blocks_dig", cfg.blocksDig != null ? cfg.blocksDig : "未授权");
        b.addProperty("blocks_place", cfg.blocksPlace != null ? cfg.blocksPlace : "未授权");
        b.addProperty("combat_targets", cfg.combatTargets != null ? cfg.combatTargets : "未授权");
        if (cfg.combatMaxEngage != null) b.addProperty("combat_max_engage", cfg.combatMaxEngage);
        b.addProperty("say_rate", cfg.chatSayRate);
        b.addProperty("chat_commands", String.join(" ", cfg.chatCommandsWhitelist));
        b.addProperty("authority_owner", String.join(" ", cfg.authorityOwner));
        b.addProperty("authority_op", String.join(" ", cfg.authorityOp));
        return b;
    }

    private JsonObject capsFlags() {
        McRuntime rt = runtimeRef.get();
        if (rt != null) return rt.caps();
        JsonObject f = new JsonObject();
        f.addProperty("nav.pathfinder", false);
        f.addProperty("item.components", true);
        f.addProperty("world.block_entity", true);
        return f;
    }

    private JsonObject manifestSchema() {
        JsonObject schema = new JsonObject();
        BotConfig cfg = cfgRef.get();
        if (cfg != null) {
            for (var e : cfg.params.entrySet()) {
                if (e.getValue() != null && e.getValue().isJsonObject()
                        && e.getValue().getAsJsonObject().has("type")) {
                    schema.add(e.getKey(), e.getValue());
                }
            }
        }
        return schema;
    }

    /** POST /reload {"package": "..."}：热重载脚本包（可选切换） */
    private JsonObject reload(String method, JsonObject body) {
        if (!method.equals("POST")) return status(405, obj("error", "method not allowed"));
        var fn = reloadFn;
        if (fn == null) return status(409, obj("error", "reload handler 未注册"));
        String pkg = body != null && body.has("package") && !body.get("package").isJsonNull()
                ? body.get("package").getAsString() : null;
        return onClient(() -> fn.apply(pkg));
    }

    /** GET /packages：botscript/ 下可切换的脚本包列表 + 当前包 */
    private JsonObject packages() {
        var fn = packagesFn;
        if (fn == null) return status(409, obj("error", "packages handler 未注册"));
        return onClient(fn);
    }

    // ================= JSON 小工具 =================

    private static JsonObject args(Object... kv) {
        JsonObject o = new JsonObject();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            Object v = kv[i + 1];
            String k = String.valueOf(kv[i]);
            if (v == null) o.add(k, JsonNull.INSTANCE);
            else if (v instanceof String s) o.addProperty(k, s);
            else if (v instanceof Boolean b) o.addProperty(k, b);
            else if (v instanceof Number n) o.addProperty(k, n);
            else o.add(k, (JsonElement) v);
        }
        return o;
    }

    private static JsonObject obj(String k, Object v) {
        JsonObject o = new JsonObject();
        if (v instanceof String s) o.addProperty(k, s);
        else if (v instanceof Boolean b) o.addProperty(k, b);
        else if (v instanceof Number n) o.addProperty(k, n);
        else o.add(k, (JsonElement) v);
        return o;
    }

    private static JsonObject status(int code, JsonObject o) {
        o.addProperty("__status", code);
        return o;
    }

    private static String urlDecode(String s) {
        return java.net.URLDecoder.decode(s, StandardCharsets.UTF_8);
    }

    private static void send(HttpExchange ex, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }
}
