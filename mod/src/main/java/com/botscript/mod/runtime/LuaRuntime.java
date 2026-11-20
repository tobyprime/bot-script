package com.botscript.mod.runtime;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.luaj.vm2.Globals;
import org.luaj.vm2.LuaError;
import org.luaj.vm2.LuaValue;
import org.luaj.vm2.Varargs;
import org.luaj.vm2.lib.OneArgFunction;
import org.luaj.vm2.lib.TwoArgFunction;
import org.luaj.vm2.lib.VarArgFunction;
import org.luaj.vm2.lib.jse.JsePlatform;

import java.io.Reader;
import java.io.StringReader;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.function.LongSupplier;

/**
 * Lua 运行时（Fabric 宿主）：Luaj + runtime/lua/core 唯一源码 + runtime/lua/compat/luaj.lua。
 *
 * 本类只负责：
 *   - Lua 状态装载（compat → json/bridge → bootstrap/bslib → 用户脚本）
 *   - token 结算 / 定时器 / 交付门控（pause 冻结、Lua 帧内排队）
 *   - 四个 ABI 入口的宿主侧接线：__host_q / __host_a / __core_call / __core_event
 *
 * 语义实现在 runtime/lua（与 Node 宿主同一份源码）；动作原语在 AbiDispatcher/McRuntime。
 * 线程模型：所有入口必须在游戏线程上调用（客户端 tick / 事件回调均已在主线程）。
 */
public final class LuaRuntime {

    public interface LogSink {
        void log(String level, String msg);
    }

    /** ABI 调用失败（kind 来自 contracts/errors.yaml） */
    public static final class AbiError extends RuntimeException {
        public final String kind;
        public final String detail;

        public AbiError(String kind, String detail) {
            super(kind + (detail == null || detail.isEmpty() ? "" : ": " + detail));
            this.kind = kind;
            this.detail = detail;
        }
    }

    private static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

    private final String name;
    private final LogSink log;
    private final LongSupplier clock;
    private final Globals globals;
    private AbiDispatcher abi;

    // ---- token 结算 ----
    static final class TokenRec {
        boolean settled;
        boolean waiterRegistered;
        boolean detached;
        int taskId;            // 0 = 无归属（fire-and-forget）
        String kind = "";
        String waitKind = "";
        String okj = "";
        String ej = "";
    }

    private final Map<Integer, TokenRec> tokens = new HashMap<>();
    private int nextToken = 1;

    // ---- 定时器 ----
    record Timer(long at, long interval, boolean once, int timerId, Integer token) implements Comparable<Timer> {
        @Override public int compareTo(Timer o) { return Long.compare(at, o.at); }
    }

    private final PriorityQueue<Timer> timers = new PriorityQueue<>();
    private final List<Timer> pendingTimers = new ArrayList<>();   // start() 前注册的 interval/after
    private int nextTimerId = 1;

    // ---- 交付门控 ----
    record Delivery(int taskId, String okj, String ej) {}

    private final Deque<Delivery> pendingDeliveries = new ArrayDeque<>();   // Lua 帧内到达：帧尾再交付
    private final List<Delivery> frozenDeliveries = new ArrayList<>();      // pause 期间到达：恢复后重交付
    private int luaDepth = 0;
    private boolean paused = false;
    private boolean started = false;

    // ---- 每 tick 驱动的状态机（导航/点击等长动作） ----
    public interface Tickable { void tick(); }

    private final List<Tickable> machines = new ArrayList<>();

    private AbiDispatcher dispatcher;
    private com.botscript.mod.runtime.StateStore stateStore;

    public LuaRuntime(String name, LogSink log, LongSupplier clock) {
        this.name = name;
        this.log = log;
        this.clock = clock;
        this.globals = JsePlatform.standardGlobals();
    }

    // ================= 装载 =================

    /** 预载 Lua 模块（require "json"/"bridge"/"bootstrap" 可用）。 */
    public LuaValue preloadModule(String moduleName, String src) {
        LuaValue chunk = loadChunk(src, moduleName + ".lua");
        LuaValue result = chunk.call();
        LuaValue fixed = result.isnil() ? LuaValue.TRUE : result;
        LuaValue pkg = globals.get("package");
        if (!pkg.isnil()) {
            LuaValue preload = pkg.get("preload");
            if (preload.istable()) preload.set(moduleName, new OneArgFunction() {
                @Override public LuaValue call(LuaValue arg) { return fixed; }
            });
            LuaValue loaded = pkg.get("loaded");
            if (loaded.istable()) loaded.set(moduleName, fixed);
        }
        return result;
    }

    /** 装载 runtime/lua（唯一源码）：compat → json/bridge → bootstrap/bslib。 */
    public void bootRuntimeLibs() {
        // 1) LuaJ 兼容补丁必须先于 json（json 的 encode_number 依赖 math.type）
        exec(resource("/lua/compat/luaj.lua"), "=compat/luaj");
        // 2) 模块
        preloadModule("json", resource("/lua/core/json.lua"));
        preloadModule("bridge", resource("/lua/core/bridge.generated.lua"));
        preloadModule("bslib", resource("/lua/core/bslib.lua"));
        preloadModule("bootstrap", resource("/lua/core/bootstrap.lua"));
        exec("require \"bootstrap\"\nbslib = require \"bslib\"", "=runtime");
        registerAbi();
    }

    private static String resource(String path) {
        try (var in = LuaRuntime.class.getResourceAsStream(path)) {
            if (in == null) throw new IllegalStateException("缺少运行时资源 " + path);
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** ABI 入口接线：__host_q（同步）/ __host_a（异步 token）。反向入口由核心定义。 */
    private void registerAbi() {
        globals.set("__host_q", new TwoArgFunction() {
            @Override public LuaValue call(LuaValue op, LuaValue args) {
                return LuaValue.valueOf(dispatchSync(op.tojstring(), args.tojstring()));
            }
        });
        globals.set("__host_a", new TwoArgFunction() {
            @Override public LuaValue call(LuaValue op, LuaValue args) {
                return LuaValue.valueOf(dispatchAsync(op.tojstring(), args.tojstring()));
            }
        });
    }

    private String dispatchSync(String op, String argsJson) {
        if (hostBridge != null) return hostBridge.q(op, argsJson);
        if (dispatcher == null) throw new AbiError("runtime.error", "AbiDispatcher 未接线");
        try {
            return dispatcher.sync(op, argsJson);
        } catch (AbiError e) {
            log("error", "[bridge:" + op + "] " + e.getMessage());
            throw new LuaError(e.getMessage());
        }
    }

    private int dispatchAsync(String op, String argsJson) {
        if (hostBridge != null) return hostBridge.a(op, argsJson);
        if (dispatcher == null) throw new AbiError("runtime.error", "AbiDispatcher 未接线");
        return dispatcher.asyncOp(op, argsJson);
    }

    /** 测试接缝：用假宿主跑调度向量（与 Node 的 testing/vector-host.mjs 对应） */
    public interface HostBridge {
        String q(String op, String argsJson);
        int a(String op, String argsJson);
    }

    private HostBridge hostBridge;

    public void setHostBridge(HostBridge b) { this.hostBridge = b; }

    public void setAbi(AbiDispatcher d) { this.dispatcher = d; }
    public AbiDispatcher abi() { return dispatcher; }

    /** 用户脚本装载：同目录其余 .lua 先行预载（require 同目录模块），再执行入口（声明期）。 */
    public void loadScripts(List<ScriptFile> scripts) {
        for (ScriptFile s : scripts) {
            if (!s.entry()) preloadModule(moduleName(s.path()), s.src());
        }
        for (ScriptFile s : scripts) {
            if (s.entry()) exec(s.src(), "@" + s.path());
        }
    }

    public record ScriptFile(String path, String src, boolean entry) {}

    private static String moduleName(String path) {
        String p = path.replace('\\', '/');
        p = p.substring(p.lastIndexOf('/') + 1);
        return p.endsWith(".lua") ? p.substring(0, p.length() - 4) : p;
    }

    // ================= 生命周期 =================

    /** 参数绑定（核心执行合并：脚本声明优先，持久化值最后覆盖）。 */
    public JsonObject bindParams(JsonObject manifest, JsonObject instance) {
        JsonObject args = new JsonObject();
        args.add("manifest", manifest == null ? new JsonObject() : manifest);
        args.add("instance", instance == null ? new JsonObject() : instance);
        return requireOk(coreCall("params.bind", args));
    }

    /** 启动序：on_start 生命周期 + 定时器生效。 */
    public void start() {
        started = true;
        event("lifecycle", "{\"kind\":\"on_start\"}");
        long now = clock.getAsLong();
        for (Timer t : pendingTimers) {
            scheduleTimer(new Timer(now + t.interval(), t.interval(), t.once(), t.timerId(), t.token()));
        }
        pendingTimers.clear();
        log("info", "[" + name + "] 引擎启动完成 driver=internal paused=" + paused);
    }

    // ================= 每 tick 驱动 =================

    public void tick() {
        for (Tickable m : new ArrayList<>(machines)) {
            try { m.tick(); } catch (Exception e) { log("error", "[" + name + "] machine 失败: " + e); }
        }
        long now = clock.getAsLong();
        List<Timer> due = new ArrayList<>();
        while (!timers.isEmpty() && timers.peek().at() <= now) due.add(timers.poll());
        for (Timer t : due) {
            if (t.token() != null) {
                settle(t.token(), "", "");       // time.sleep 到期
            } else {
                String kind = t.once() ? "after" : "timer";
                event(kind, "{\"id\":" + t.timerId() + "}");
                if (!t.once()) scheduleTimer(new Timer(now + t.interval(), t.interval(), false, t.timerId(), null));
            }
        }
    }

    public void addMachine(Tickable t) { machines.add(t); }
    public void removeMachine(Tickable t) { machines.remove(t); }

    private void scheduleTimer(Timer t) { timers.add(t); }

    /** 宿主侧 timer 登记（核心的 timer.after / timer.interval） */
    public int registerTimer(boolean once, long delayOrInterval) {
        int id = nextTimerId++;
        if (started) scheduleTimer(new Timer(clock.getAsLong() + delayOrInterval, delayOrInterval, once, id, null));
        else pendingTimers.add(new Timer(0, delayOrInterval, once, id, null));
        return id;
    }

    // ================= token 结算 =================

    public int newToken(String kind) {
        int token = nextToken++;
        TokenRec rec = new TokenRec();
        rec.kind = kind;
        tokens.put(token, rec);
        return token;
    }

    public void bind(int taskId, int token, String kind) {
        TokenRec rec = tokens.get(token);
        if (rec == null) return;
        rec.waiterRegistered = true;
        rec.taskId = taskId;
        rec.waitKind = kind;   // 等待类别单独存放（action/sleep 的 kind 不覆盖）
        if (rec.settled) deliverToken(token);
    }

    public void detach(int token) {
        TokenRec rec = tokens.get(token);
        if (rec != null) rec.detached = true;
    }

    /** 设置 token 类别（sleep/event/waiter 不进 pause 的动作结算域；与 Node TokenHub 同口径） */
    public void setTokenKind(int token, String kind) {
        TokenRec rec = tokens.get(token);
        if (rec != null) rec.kind = kind;
    }

    public void settle(int token, String okj, String ej) {
        TokenRec rec = tokens.get(token);
        if (rec == null || rec.settled) return;
        rec.settled = true;
        rec.okj = okj == null ? "" : okj;
        rec.ej = ej == null ? "" : ej;
        if (rec.waiterRegistered) deliverToken(token);
    }

    private void deliverToken(int token) {
        TokenRec rec = tokens.remove(token);
        if (rec == null) return;
        if (rec.detached) return;
        if (rec.taskId == 0) return;
        deliver(rec.taskId, rec.okj, rec.ej);
    }

    private void deliver(int taskId, String okj, String ej) {
        Delivery d = new Delivery(taskId, okj == null ? "" : okj, ej == null ? "" : ej);
        if (paused) { frozenDeliveries.add(d); return; }
        if (luaDepth > 0) { pendingDeliveries.add(d); return; }
        callLua("__core_resume", LuaValue.valueOf(taskId), LuaValue.valueOf(d.okj()), LuaValue.valueOf(d.ej()));
        flushPending();   // 帧内新产生的交付（动作链）在本帧结束后立即冲刷
    }

    /** 暂停：进行中的动作以 runtime.paused 结算（脚本在冻结点重抛） */
    public void pause(String reason) {
        if (paused) return;
        if (dispatcher != null) dispatcher.onPause(reason);
        paused = true;
        frozenDeliveries.clear();
        for (var e : new ArrayList<>(tokens.entrySet())) {
            TokenRec rec = e.getValue();
            if ("action".equals(rec.kind) && rec.taskId != 0 && !rec.settled) {
                settle(e.getKey(), "", errJson("runtime.paused", "pause(" + reason + ") 期间动作中止"));
            }
        }
        log("warn", "[" + name + "] 暂停: " + reason);
        event("lifecycle", "{\"kind\":\"on_pause\"}");
    }

    public void resume() {
        if (!paused) return;
        if (dispatcher != null) dispatcher.onResume();
        paused = false;
        event("lifecycle", "{\"kind\":\"on_resume\"}");
        var list = new ArrayList<>(frozenDeliveries);
        frozenDeliveries.clear();
        for (Delivery d : list) deliver(d.taskId(), d.okj(), d.ej());
        flushPending();
    }

    public boolean isPaused() { return paused; }

    private void flushPending() {
        while (luaDepth == 0 && !pendingDeliveries.isEmpty()) {
            Delivery d = pendingDeliveries.poll();
            callLua("__core_resume", LuaValue.valueOf(d.taskId()), LuaValue.valueOf(d.okj()), LuaValue.valueOf(d.ej()));
        }
    }

    // ================= 事件 / 反向调用 =================

    public void event(String kind, String payloadJson) {
        callLua("__core_event", LuaValue.valueOf(kind), LuaValue.valueOf(payloadJson));
        flushPending();
    }

    /** 宿主 → 核心同步调用，返回信封 {ok,result}|{ok=false,error}。 */
    public JsonObject coreCall(String op, JsonObject args) {
        LuaValue f = globals.get("__core_call");
        if (f.isnil()) throw new AbiError("runtime.error", "Lua 未就绪（__core_call 缺失）");
        LuaValue r = f.call(LuaValue.valueOf(op), LuaValue.valueOf(GSON.toJson(args == null ? new JsonObject() : args)));
        return parseObj(r.isnil() ? "{}" : r.tojstring());
    }

    /** 解包信封；失败抛 AbiError（kind 来自核心）。 */
    public static JsonObject requireOk(JsonObject envelope) {
        if (envelope.has("ok") && envelope.get("ok").getAsBoolean()) {
            JsonElement r = envelope.get("result");
            return r != null && r.isJsonObject() ? r.getAsJsonObject() : new JsonObject();
        }
        JsonObject e = envelope.has("error") && envelope.get("error").isJsonObject()
                ? envelope.getAsJsonObject("error") : new JsonObject();
        String kind = e.has("kind") ? e.get("kind").getAsString() : "runtime.error";
        String detail = e.has("detail") && !e.get("detail").isJsonNull() ? e.get("detail").getAsString() : null;
        throw new AbiError(kind, detail);
    }

    // ================= Lua 调用 =================

    private void callLua(String fn, LuaValue... args) {
        luaDepth++;
        try {
            LuaValue f = globals.get(fn);
            if (f.isnil()) throw new IllegalStateException("Lua 全局缺失: " + fn);
            f.invoke(LuaValue.varargsOf(args));
        } catch (LuaError e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            log("error", "[" + name + "] Lua 调用 " + fn + " 失败: " + c.getMessage());
        } finally {
            luaDepth--;
        }
    }

    private LuaValue loadChunk(String src, String chunkName) {
        Reader r = new StringReader(src);
        try {
            return globals.load(r, chunkName);
        } catch (LuaError e) {
            throw new IllegalArgumentException("Lua 编译失败 " + chunkName + ": " + e.getMessage());
        }
    }

    /** 顶层执行（编译错误抛出；运行错误降级为日志）。 */
    public void exec(String src, String chunkName) {
        luaDepth++;
        try {
            loadChunk(src, chunkName).call();
        } catch (LuaError e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            log("error", "[" + name + "] 脚本执行失败 " + chunkName + ": " + c.getMessage());
        } finally {
            luaDepth--;
        }
    }

    public void attachState(StateStore store) {
        // state 由 AbiDispatcher 的 state.* handler 直接调用；这里保留引用供 /store 与测试观察。
        this.stateStore = store;
    }

    public StateStore state() { return stateStore; }

    // ================= 小工具 =================

    public static JsonObject parseObj(String j) {
        // json.lua 把空表编码为 "[]"（数组形态）；这里等价容忍：非对象一律按空对象处理
        if (j == null || j.isBlank()) return new JsonObject();
        JsonElement e = JsonParser.parseString(j);
        return e.isJsonObject() ? e.getAsJsonObject() : new JsonObject();
    }

    public static String errJson(String kind, String detail) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", kind);
        o.addProperty("detail", detail == null ? "" : detail);
        return GSON.toJson(o);
    }

    public static String toJson(Object o) { return GSON.toJson(o); }
    public static Gson gson() { return GSON; }

    private void log(String level, String msg) { log.log(level, msg); }

    /** bridge.log 的宿主面（[name] 前缀与 Node 宿主一致） */
    public void emitLog(String level, String msg) {
        log.log(level, "[" + name + "] " + msg);
    }

    /** 供 mod 侧记录引擎自产日志（不带 [name] 前缀） */
    public void rawLog(String level, String msg) { log.log(level, msg); }

    /** 供测试/调试：取 Lua 全局 */
    public LuaValue global(String name) { return globals.get(name); }

    public long now() { return clock.getAsLong(); }
}
