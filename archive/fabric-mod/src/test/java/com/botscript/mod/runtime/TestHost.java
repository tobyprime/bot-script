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
    private final Map<String, JsonElement> state = new LinkedHashMap<>();
    private final Map<String, Long> seen = new LinkedHashMap<>();

    public TestHost(LuaRuntime rt) {
        this(rt, new long[]{1000});
    }

    public TestHost(LuaRuntime rt, long[] clockRef) {
        this.rt = rt;
        this.clockRef = clockRef;
    }

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
            case "state.get": {
                String k = a.get("key").getAsString();
                return state.containsKey(k) ? state.get(k).toString() : "";
            }
            case "state.all": {
                JsonObject o = new JsonObject();
                for (var e : state.entrySet()) o.add(e.getKey(), e.getValue());
                return o.toString();
            }
            case "state.set": {
                JsonElement v = a.has("value") ? a.get("value") : JsonNull.INSTANCE;
                state.put(a.get("key").getAsString(), v.deepCopy());
                return "";
            }
            case "state.delete": {
                state.remove(a.get("key").getAsString());
                return "";
            }
            case "state.seen": {
                String key = a.get("key").getAsString();
                long win = a.has("window_ms") ? a.get("window_ms").getAsLong() : 5000;
                Long prev = seen.get(key);
                if (prev != null && now() - prev <= win) return "true";
                seen.put(key, now());
                return "false";
            }
            default: return "";
        }
    }

    private static String nz(String s) { return s == null ? "" : s; }

    public static JsonObject json(String s) {
        return JsonParser.parseString(s).getAsJsonObject();
    }

    public static JsonElement el(String s) { return s == null ? JsonNull.INSTANCE : JsonParser.parseString(s); }
}
