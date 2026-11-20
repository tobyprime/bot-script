package com.botscript.mod.runtime;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 测试假宿主：用真实 LuaRuntime 的 token/timer API 驱动核心 Lua，不触碰 Minecraft。
 * 与 Node 的 testing/vector-host.mjs 逐条对齐（同一份 scheduler 向量在两边产出同一日志序列）。
 *
 * 只验证契约逻辑是否自洽 + 两运行时是否一致；不做任何根因定位（CLAUDE.md 纪律 2）。
 */
public final class TestHost implements LuaRuntime.HostBridge {

    public final List<String> logs = new ArrayList<>();
    private final LuaRuntime rt;
    private final long[] clockRef;
    private final Map<Integer, Long> sleepDeadlines = new HashMap<>();
    private final Map<String, JsonObject> tables = new LinkedHashMap<>();
    private final Map<String, JsonObject> kv = new LinkedHashMap<>();
    private final Map<String, Long> seen = new LinkedHashMap<>();
    private PersistStore persist;

    public TestHost(LuaRuntime rt) {
        this(rt, new long[]{1000});
    }

    public TestHost(LuaRuntime rt, long[] clockRef) {
        this.rt = rt;
        this.clockRef = clockRef;
    }

    public void usePersistStore(PersistStore store) { this.persist = store; }
    public long now() { return clockRef[0]; }

    /** info 级别日志（去掉 level 前缀），供断言直接比较 */
    public List<String> infos() {
        return logs.stream().filter((l) -> l.startsWith("info|")).map((l) -> l.substring(5)).toList();
    }

    /** 推进虚拟时钟并结算到期的 sleep/waiter token */
    public void advance(long ms) {
        clockRef[0] += ms;
        List<Integer> due = new ArrayList<>();
        for (var e : new ArrayList<>(sleepDeadlines.entrySet())) {
            if (e.getValue() <= clockRef[0]) { due.add(e.getKey()); sleepDeadlines.remove(e.getKey()); }
        }
        for (int token : due) rt.settle(token, "", "");
    }

    @Override
    public String q(String op, String argsJson) {
        // json.lua 把空表编码为 "[]"：必须容忍非对象（与真实 AbiDispatcher.validate 同口径）
        JsonObject a = LuaRuntime.parseObj(argsJson);
        String out = dispatchQ(op, a);
        return out == null ? "" : out;
    }

    @Override
    public int a(String op, String argsJson) {
        JsonObject args = LuaRuntime.parseObj(argsJson);
        if ("util.sleep".equals(op) || "waiter.new".equals(op) || "events.next".equals(op)) {
            int token = rt.newToken("timer");
            long ms = args.has("ms") ? args.get("ms").getAsLong() : args.has("timeout") ? args.get("timeout").getAsLong() : 0;
            sleepDeadlines.put(token, now() + ms);
            return token;
        }
        if ("act.long".equals(op)) {
            return rt.newToken("action");   // 永不结算（pause 测试用）
        }
        int token = rt.newToken("action");
        if ("act.nope".equals(op)) {
            rt.settle(token, "", LuaRuntime.errJson("abi.unknown_op", op));
        } else {
            rt.settle(token, "{}", "");
        }
        return token;
    }

    private String dispatchQ(String op, JsonObject a) {
        switch (op) {
            case "util.now": return String.valueOf(now());
            case "control.pause": { rt.pause(a.has("reason") ? a.get("reason").getAsString() : "test"); return ""; }
            case "control.resume": { rt.resume(); return ""; }
            case "control.status": return "{\"state\":\"playing\",\"paused\":" + rt.isPaused() + ",\"pos\":null}";
            case "control.say": return "";
            case "log": {
                String prefix = a.get("msg").getAsString();
                logs.add(a.get("level").getAsString() + "|" + prefix);
                return "";
            }
            case "token.bind": {
                rt.bind(a.get("task_id").getAsInt(), a.get("token").getAsInt(), a.get("kind").getAsString());
                return "";
            }
            case "token.detach": { rt.detach(a.get("token").getAsInt()); return ""; }
            case "waiter.resolve": { rt.settle(a.get("token").getAsInt(), a.get("match").getAsString(), ""); return ""; }
            case "timer.after": { rt.registerTimer(true, a.get("delay").getAsLong()); return "1"; }
            case "timer.interval": { rt.registerTimer(false, a.get("interval").getAsLong()); return "2"; }
            case "events.emit": { logs.add("event|" + a.get("type").getAsString()); return "1"; }
            case "caps.get": return "false";
            case "item.stack": return "{\"id\":\"minecraft:dirt\",\"count\":1,\"max_count\":64,\"damage\":null,\"max_damage\":null}";
            case "chat.config": return "{\"msg_command\":null}";
            case "self.get": return "{\"username\":\"VecBot\",\"pos\":{\"x\":0,\"y\":64,\"z\":0},\"yaw\":0,\"pitch\":0,\"held_slot\":0}";
            case "entities.list": return "[]";
            case "entities.get": return "";
            case "world.block": return "";
            case "world.block_entity": return "";
            case "world.env": return "{\"dimension\":\"overworld\",\"time_of_day\":6000,\"weather\":\"clear\"}";
            case "world.reach": return "{\"reachable\":false,\"distance\":null,\"hit_block\":null}";
            case "window.current": return "";
            case "window.get": return "";
            case "session.get": return "{\"state\":\"playing\",\"info\":{}}";
            case "kv.get": {
                String k = a.get("name").getAsString() + "/" + a.get("key").getAsString();
                return kv.containsKey(k) ? LuaRuntime.gson().toJson(kv.get(k).get("v").getAsString()) : "";
            }
            case "kv.set": {
                String k = a.get("name").getAsString() + "/" + a.get("key").getAsString();
                JsonObject v = new JsonObject();
                v.addProperty("v", a.get("value").getAsString());
                kv.put(k, v);
                return "";
            }
            case "persist.table": {
                tables.put(a.get("name").getAsString(), a.get("schema").getAsJsonObject().deepCopy());
                if (persist != null) persist.declareTable(a.get("name").getAsString(), a.get("schema").toString());
                return "";
            }
            case "persist.find": return persist != null
                    ? nz(persist.find(a.get("name").getAsString(), where(a))) : memFind(a);
            case "persist.all": return persist != null
                    ? persist.all(a.get("name").getAsString()) : "[]";
            case "persist.upsert": {
                if (persist != null) persist.upsert(a.get("name").getAsString(), a.getAsJsonObject("row"));
                return "";
            }
            case "persist.del": {
                if (persist != null) persist.del(a.get("name").getAsString(), where(a));
                return "";
            }
            case "persist.adjust": {
                if (persist != null) return persist.adjust(a.get("name").getAsString(),
                        a.get("key").getAsString(), a.get("delta").getAsDouble());
                return "{}";
            }
            case "persist.seen": {
                String key = a.get("key").getAsString();
                long win = a.get("window_ms").getAsLong();
                Long prev = seen.get(key);
                if (prev != null && now() - prev <= win) return "1";
                seen.put(key, now());
                return "0";
            }
            case "persist.log_declare": { if (persist != null) persist.logDeclare(a.get("name").getAsString()); return ""; }
            case "persist.log_append": return String.valueOf(persist != null
                    ? persist.logAppend(a.get("name").getAsString(), a.getAsJsonObject("fields"), now()) : 1);
            case "persist.log_find": return persist != null ? persist.logFind(a.get("name").getAsString(), where(a)) : "[]";
            case "persist.log_mark": { if (persist != null) persist.logMark(a.get("name").getAsString(), a.get("id").getAsDouble(), a.get("state").getAsString()); return ""; }
            case "txn.begin": { if (persist != null) persist.txnBegin(); return ""; }
            case "txn.commit": { if (persist != null) persist.txnCommit(); return ""; }
            case "txn.rollback": { if (persist != null) persist.txnRollback(); return ""; }
            default: return "";
        }
    }

    private static JsonObject where(JsonObject a) {
        return a.has("where") && a.get("where").isJsonObject() ? a.getAsJsonObject("where") : new JsonObject();
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private String memFind(JsonObject a) {
        // 无真 store 时的最小内存语义（仅测试夹具使用）
        return "";
    }

    public static JsonObject json(String s) {
        return JsonParser.parseString(s).getAsJsonObject();
    }

    public static JsonElement el(String s) { return s == null ? JsonNull.INSTANCE : JsonParser.parseString(s); }
}
