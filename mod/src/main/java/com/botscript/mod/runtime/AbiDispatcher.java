package com.botscript.mod.runtime;

import com.botscript.mod.McRuntime;
import com.botscript.mod.McState;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * ABI v2 唯一 dispatch（Fabric 宿主）：策略 / 速率 / 预算 / 审计 / token 结算。
 *
 * v2：没有命令体系；动作按原版包建模；ItemStack 数据读组件；tick_end 只登记 patches。
 */
public final class AbiDispatcher {

    /** 动作处理器：返回 resultJson；返回 null = 异步自管结算 */
    public interface Handler {
        String run(int token, JsonObject args) throws Exception;
    }

    private final LuaRuntime rt;
    private final McState state;
    private final McRuntime mc;
    private final Policy policy;
    private final BotConfig cfg;
    private final PersistStore persist;
    private final java.util.function.BiConsumer<String, String> audit;
    private final java.util.function.BiConsumer<String, JsonElement> emitEvent;

    private final Map<String, Handler> sync = new HashMap<>();
    private final Map<String, Handler> async = new HashMap<>();

    private final Map<Integer, Pattern> rex = new LinkedHashMap<>();
    private int rexSeq = 0;
    private String pauseReason = null;

    private final List<JsonObject> eventQueue = new ArrayList<>();
    private final List<int[]> eventWaiters = new ArrayList<>();
    private final Map<Integer, Long> waiterDeadlines = new LinkedHashMap<>();
    private final Map<Integer, Long> sleepDeadlines = new LinkedHashMap<>();
    private final List<FrozenDeadline> frozenDeadlines = new ArrayList<>();

    public AbiDispatcher(LuaRuntime rt, McState state, McRuntime mc, Policy policy, BotConfig cfg,
                         PersistStore persist,
                         java.util.function.BiConsumer<String, String> audit,
                         java.util.function.BiConsumer<String, JsonElement> emitEvent) {
        this.rt = rt;
        this.state = state;
        this.mc = mc;
        this.policy = policy;
        this.cfg = cfg;
        this.persist = persist;
        this.audit = audit;
        this.emitEvent = emitEvent;
        buildHandlers();
    }

    public String pauseReason() { return pauseReason; }

    // ---------------------------------------------------------------- 入口

    public String sync(String op, String argsJson) {
        if (!AbiOps.SYNC_OPS.contains(op)) throw new LuaRuntime.AbiError("abi.unknown_op", op);
        JsonObject args = validate(op, argsJson);
        Handler h = sync.get(op);
        if (h == null) throw new LuaRuntime.AbiError("abi.unknown_op", op);
        try {
            String out = h.run(0, args);
            return out == null ? "" : out;
        } catch (LuaRuntime.AbiError e) {
            throw e;
        } catch (Exception e) {
            throw new LuaRuntime.AbiError("driver.error", String.valueOf(e.getMessage()));
        }
    }

    public int asyncOp(String op, String argsJson) {
        int token = rt.newToken("action");
        JsonObject args;
        try {
            args = validate(op, argsJson);
        } catch (LuaRuntime.AbiError e) {
            rt.settle(token, "", LuaRuntime.errJson(e.kind, e.detail));
            return token;
        }
        Handler h = async.get(op);
        if (!AbiOps.ASYNC_OPS.contains(op) || h == null) {
            rt.settle(token, "", LuaRuntime.errJson("abi.unknown_op", op));
            return token;
        }
        String polErr = policy.check(op, args);
        if (polErr != null) { rt.settle(token, "", polErr); return token; }
        if (cfg.dryRun) {
            rt.emitLog("info", op + " " + args + " [dry]");
            rt.settle(token, "{}", "");
            return token;
        }
        // 只有协议动作（act.*）计入速率/预算并写动作审计；调度/查询类 op 不占预算、不刷动作日志。
        if (op.startsWith("act.")) {
            String rateErr = policy.rateCheck();
            if (rateErr != null) { rt.settle(token, "", rateErr); return token; }
            if (policy.countAction()) rt.pause("budget");
            if (audit != null) audit.accept(op, args.toString());
        }
        try {
            String result = h.run(token, args);
            if (result != null) rt.settle(token, result, "");
        } catch (Exception e) {
            String kind = e instanceof LuaRuntime.AbiError ae ? ae.kind : "driver.error";
            String detail = e instanceof LuaRuntime.AbiError ae ? ae.detail : String.valueOf(e.getMessage());
            rt.settle(token, "", LuaRuntime.errJson(kind, detail));
        }
        return token;
    }

    private JsonObject validate(String op, String argsJson) {
        JsonObject args = argsJson == null || argsJson.isBlank() ? new JsonObject() : LuaRuntime.parseObj(argsJson);
        Set<String> required = AbiOps.REQUIRED.get(op);
        if (required != null) {
            for (String k : required) {
                if (!args.has(k) || args.get(k).isJsonNull()) {
                    throw new LuaRuntime.AbiError("abi.invalid_args", op + ": 缺少参数 " + k);
                }
            }
        }
        return args;
    }

    // ---------------------------------------------------------------- 事件队列 / 定时器

    public void pushEvent(String type, JsonElement data) {
        JsonObject ev = new JsonObject();
        ev.addProperty("type", type);
        ev.add("data", data != null && data.isJsonObject() ? data : new JsonObject());
        ev.addProperty("ts", System.currentTimeMillis());
        if (!eventWaiters.isEmpty()) {
            int token = eventWaiters.remove(0)[0];
            rt.settle(token, ev.toString(), "");
            return;
        }
        if (eventQueue.size() >= 64) eventQueue.remove(0);
        eventQueue.add(ev);
    }

    private void nextEvent(int token, long timeoutMs) {
        if (!eventQueue.isEmpty()) {
            rt.settle(token, eventQueue.remove(0).toString(), "");
            return;
        }
        eventWaiters.add(new int[]{token});
        waiterDeadlines.putIfAbsent(token, System.currentTimeMillis() + (timeoutMs == 0 ? 1 : timeoutMs));
    }

    private static final class FrozenDeadline {
        final int token;
        final long remain;
        final boolean waiter;
        FrozenDeadline(int token, long remain, boolean waiter) {
            this.token = token; this.remain = remain; this.waiter = waiter;
        }
    }

    public void onPause(String reason) {
        long now = System.currentTimeMillis();
        for (var e : new ArrayList<>(sleepDeadlines.entrySet())) {
            frozenDeadlines.add(new FrozenDeadline(e.getKey(), Math.max(0, e.getValue() - now), false));
        }
        sleepDeadlines.clear();
        for (var e : new ArrayList<>(waiterDeadlines.entrySet())) {
            frozenDeadlines.add(new FrozenDeadline(e.getKey(), Math.max(0, e.getValue() - now), true));
        }
        waiterDeadlines.clear();
    }

    public void onResume() {
        long now = System.currentTimeMillis();
        for (FrozenDeadline d : frozenDeadlines) {
            if (d.waiter) waiterDeadlines.put(d.token, now + d.remain);
            else sleepDeadlines.put(d.token, now + d.remain);
        }
        frozenDeadlines.clear();
    }

    public void tickSleepDeadlines() {
        long now = System.currentTimeMillis();
        var it = sleepDeadlines.entrySet().iterator();
        while (it.hasNext()) {
            var e = it.next();
            if (now >= e.getValue()) {
                it.remove();
                rt.settle(e.getKey(), "", "");
            }
        }
        var wt = waiterDeadlines.entrySet().iterator();
        while (wt.hasNext()) {
            var e = wt.next();
            if (now >= e.getValue()) {
                wt.remove();
                eventWaiters.removeIf(w -> w[0] == e.getKey());
                rt.settle(e.getKey(), "", "");
            }
        }
    }

    // ---------------------------------------------------------------- handlers

    private void buildHandlers() {
        // ---- 基础设施 ----
        sync.put("log", (t, a) -> { rt.emitLog(a.get("level").getAsString(), a.get("msg").getAsString()); return ""; });
        sync.put("util.now", (t, a) -> String.valueOf(rt.now()));
        sync.put("util.regex_new", (t, a) -> {
            int id = ++rexSeq;
            try { rex.put(id, Pattern.compile(a.get("pattern").getAsString())); }
            catch (Exception e) { throw new LuaRuntime.AbiError("abi.invalid_args", "rex 编译失败: " + e.getMessage()); }
            return String.valueOf(id);
        });
        sync.put("util.regex_match", (t, a) -> {
            Pattern p = rex.get(a.get("id").getAsInt());
            String text = a.get("text").getAsString();
            if (p == null || text == null) return "";
            Matcher m = p.matcher(text);
            if (!m.find()) return "";
            JsonObject groups = new JsonObject();
            for (String g : namedGroups(p)) groups.addProperty(g, m.group(g));
            return groups.toString();
        });
        sync.put("token.bind", (t, a) -> {
            rt.bind(a.get("task_id").getAsInt(), a.get("token").getAsInt(), a.get("kind").getAsString());
            return "";
        });
        sync.put("token.detach", (t, a) -> { rt.detach(a.get("token").getAsInt()); return ""; });
        sync.put("timer.after", (t, a) -> String.valueOf(rt.registerTimer(true, Math.max(0, a.get("delay").getAsLong()))));
        sync.put("timer.interval", (t, a) -> String.valueOf(rt.registerTimer(false, Math.max(50, a.get("interval").getAsLong()))));
        sync.put("events.emit", (t, a) -> {
            JsonObject ev = a.has("data") && a.get("data").isJsonObject() ? a.getAsJsonObject("data") : new JsonObject();
            if (emitEvent != null) emitEvent.accept(a.get("type").getAsString(), ev);
            return "1";
        });
        sync.put("waiter.resolve", (t, a) -> {
            rt.settle(a.get("token").getAsInt(), a.get("match").getAsString(), "");
            return "";
        });

        // ---- 自身 / 会话 / 能力 ----
        sync.put("self.get", (t, a) -> {
            JsonObject self = state.selfJson();
            return self == null ? "" : self.toString();
        });
        sync.put("session.get", (t, a) -> {
            JsonObject o = new JsonObject();
            o.addProperty("state", state.sessionJson().get("state").getAsString());
            o.addProperty("paused", rt.isPaused());
            o.addProperty("pause_reason", pauseReason);
            o.add("info", mc.sessionInfo());
            return o.toString();
        });
        sync.put("caps.get", (t, a) -> String.valueOf(mc.caps().has(a.get("flag").getAsString())
                && mc.caps().get(a.get("flag").getAsString()).getAsBoolean()));
        sync.put("caps.list", (t, a) -> {
            JsonObject o = new JsonObject();
            o.add("flags", mc.caps());
            o.add("patches", mc.patches());
            o.addProperty("abi", AbiOps.ABI_VERSION);
            return o.toString();
        });

        // ---- 实体 ----
        sync.put("entities.list", (t, a) -> state.entitiesJson().toString());
        sync.put("entities.get", (t, a) -> {
            JsonObject e = state.entityJson(a.get("id").getAsString());
            return e == null ? "" : e.toString();
        });

        // ---- 世界 ----
        sync.put("world.block", (t, a) -> {
            JsonObject b = mc.blockInfo(a.getAsJsonObject("pos"));
            return b == null ? "" : b.toString();
        });
        sync.put("world.block_entity", (t, a) -> {
            JsonObject b = mc.blockEntity(a.getAsJsonObject("pos"));
            return b == null ? "" : b.toString();
        });
        sync.put("world.scan", (t, a) -> {
            Set<String> kinds = mc.scanKinds(a);
            JsonArray list = mc.scanBlocks(a.getAsJsonObject("region"), kinds,
                    a.has("limit") ? a.get("limit").getAsInt() : 200);
            return list.toString();
        });
        sync.put("world.env", (t, a) -> mc.worldEnv().toString());
        sync.put("world.reach", (t, a) -> mc.reach(a.getAsJsonObject("pos"),
                a.has("max_distance") ? a.get("max_distance").getAsDouble() : 4.5).toString());

        // ---- 窗口 ----
        sync.put("window.current", (t, a) -> state.currentWindowId() == null ? ""
                : new com.google.gson.JsonPrimitive(state.currentWindowId()).toString());
        sync.put("window.get", (t, a) -> {
            JsonObject w = state.windowView(a.get("window").getAsString());
            return w == null ? "" : w.toString();
        });

        // ---- 物品栈 ----
        sync.put("item.stack", (t, a) -> DataRegistry.stack(
                a.has("stack") && a.get("stack").isJsonObject() ? a.getAsJsonObject("stack") : new JsonObject()).toString());

        // ---- 聊天策略（只读） ----
        sync.put("chat.config", (t, a) -> policy.chatConfig().toString());

        // ---- persist ----
        sync.put("persist.table", (t, a) -> { persist.declareTable(a.get("name").getAsString(), a.get("schema").toString()); return ""; });
        sync.put("persist.find", (t, a) -> { String r = persist.find(a.get("name").getAsString(), whereOf(a)); return r == null ? "" : r; });
        sync.put("persist.all", (t, a) -> persist.all(a.get("name").getAsString()));
        sync.put("persist.upsert", (t, a) -> { persist.upsert(a.get("name").getAsString(), a.getAsJsonObject("row")); return ""; });
        sync.put("persist.del", (t, a) -> { persist.del(a.get("name").getAsString(), whereOf(a)); return ""; });
        sync.put("persist.adjust", (t, a) -> persist.adjust(
                a.get("name").getAsString(), a.get("key").getAsString(), a.get("delta").getAsDouble()));
        sync.put("persist.seen", (t, a) -> String.valueOf(persist.seen(
                a.get("key").getAsString(), a.get("window_ms").getAsLong(), System.currentTimeMillis())));
        sync.put("kv.get", (t, a) -> LuaRuntime.gson().toJson(persist.kvGet(a.get("name").getAsString(), a.get("key").getAsString())));
        sync.put("kv.set", (t, a) -> { persist.kvSet(a.get("name").getAsString(), a.get("key").getAsString(), a.get("value").getAsString()); return ""; });
        sync.put("persist.log_declare", (t, a) -> { persist.logDeclare(a.get("name").getAsString()); return ""; });
        sync.put("persist.log_append", (t, a) -> String.valueOf(persist.logAppend(
                a.get("name").getAsString(), a.has("fields") ? a.getAsJsonObject("fields") : new JsonObject(),
                System.currentTimeMillis())));
        sync.put("persist.log_find", (t, a) -> persist.logFind(a.get("name").getAsString(), whereOf(a)));
        sync.put("persist.log_mark", (t, a) -> { persist.logMark(a.get("name").getAsString(), a.get("id").getAsDouble(), a.get("state").getAsString()); return ""; });
        sync.put("txn.begin", (t, a) -> { persist.txnBegin(); return ""; });
        sync.put("txn.commit", (t, a) -> { persist.txnCommit(); return ""; });
        sync.put("txn.rollback", (t, a) -> { persist.txnRollback(); return ""; });

        // ---- 调度原语 ----
        async.put("util.sleep", (t, a) -> {
            long ms = Math.max(0, a.has("ms") ? a.get("ms").getAsLong() : 0);
            rt.setTokenKind(t, "sleep");
            sleepDeadlines.put(t, System.currentTimeMillis() + ms);
            return null;
        });
        async.put("events.next", (t, a) -> {
            long timeout = a.has("timeout") ? a.get("timeout").getAsLong() : 30000;
            rt.setTokenKind(t, "event");
            nextEvent(t, timeout);
            return null;
        });
        async.put("waiter.new", (t, a) -> {
            long timeout = a.has("timeout") ? a.get("timeout").getAsLong() : 5000;
            rt.setTokenKind(t, "waiter");
            waiterDeadlines.put(t, System.currentTimeMillis() + timeout);
            return null;
        });

        // ---- 协议动作 ----
        async.put("act.chat_send", (t, a) -> {
            mc.chatSendRaw(a.get("text").getAsString(),
                    a.has("kind") ? a.get("kind").getAsString() : "chat");
            return "{}";
        });
        async.put("act.look", (t, a) -> mc.look(a));
        async.put("act.input", (t, a) -> mc.input(a));
        async.put("act.path_to", (t, a) -> mc.pathTo(t, a));
        async.put("act.path_cancel", (t, a) -> mc.pathCancel());
        async.put("act.dig", (t, a) -> mc.dig(t, a));
        async.put("act.dig_stop", (t, a) -> mc.digStop());
        async.put("act.use_block", (t, a) -> mc.useBlock(a));
        async.put("act.use_entity", (t, a) -> mc.useEntity(a));
        async.put("act.swing", (t, a) -> mc.swing(a));
        async.put("act.use_item", (t, a) -> mc.useItem(a));
        async.put("act.select_slot", (t, a) -> mc.selectSlot(a));
        async.put("act.drop", (t, a) -> mc.drop(a));
        async.put("act.window_open", (t, a) -> mc.windowOpen(t, a));
        async.put("act.window_click", (t, a) -> mc.windowClick(t, a));
        async.put("act.window_close", (t, a) -> mc.windowClose());
    }

    private static JsonObject whereOf(JsonObject a) {
        return a.has("where") && a.get("where").isJsonObject() ? a.getAsJsonObject("where") : new JsonObject();
    }

    private static final Pattern NAMED_GROUP = Pattern.compile("\\(\\?<([a-zA-Z][a-zA-Z0-9]*)>");

    private static List<String> namedGroups(Pattern p) {
        List<String> out = new ArrayList<>();
        Matcher m = NAMED_GROUP.matcher(p.pattern());
        while (m.find()) if (!out.contains(m.group(1))) out.add(m.group(1));
        return out;
    }
}
