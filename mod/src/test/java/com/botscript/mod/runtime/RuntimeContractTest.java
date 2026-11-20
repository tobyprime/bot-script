package com.botscript.mod.runtime;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** 跨宿主契约：persist / command / policy / window / persist 向量（与 Node 跑同一份 JSON）。 */
class RuntimeContractTest {

    static final class CaptureLog implements LuaRuntime.LogSink {
        final List<String> lines = new ArrayList<>();
        @Override public void log(String level, String msg) { lines.add(level + "|" + msg); }
        List<String> infos() {
            return lines.stream().filter((l) -> l.startsWith("info|")).map((l) -> l.substring(5)).toList();
        }
    }

    private static Path vectorDir(String name) {
        Path p = Path.of("../contracts/vectors", name);
        assertTrue(Files.isDirectory(p), "缺少向量目录 " + p.toAbsolutePath());
        return p;
    }

    // ---- 1) persist 桥（经 Lua 全链路 + 真 PersistStore） ----
    @Test
    void persistBridgeThroughLua() throws Exception {
        Path file = Files.createTempFile("bspersist", ".json");
        Files.deleteIfExists(file);
        long[] clock = {1000};
        CaptureLog sink = new CaptureLog();
        LuaRuntime rt = new LuaRuntime("test-bot", sink, () -> clock[0]);
        TestHost host = new TestHost(rt, clock);
        PersistStore store = new PersistStore(file);
        host.usePersistStore(store);
        rt.setHostBridge(host);
        rt.bootRuntimeLibs();
        rt.loadScripts(List.of(new LuaRuntime.ScriptFile("persist.lua", """
                on_start(function()
                  persist.table "Account" { name = "string:key", balance = "number" }
                  Account.upsert { name = "MixTobyInjTick", balance = 100 }
                  Account.upsert { name = "Carol", balance = 4 }
                  local a = Account.find { name = "MixTobyInjTick" }
                  log.info("find=%s %s", a.name, tostring(a.balance))
                  local na = Account.adjust("MixTobyInjTick", -30, "name", "balance")
                  log.info("adjust=%s", tostring(na.balance))
                  log.info("seen1=%s seen2=%s", persist.seen("tx:1", 5000) and "hit" or "new",
                           persist.seen("tx:1", 5000) and "hit" or "new")
                  persist.kv "meta"
                  meta.set("opened", true)
                  log.info("kv=%s", tostring(meta.get("opened")))
                end)
                """, true)));
        rt.bindParams(new JsonObject(), new JsonObject());
        rt.start();
        assertTrue(host.infos().contains("find=MixTobyInjTick 100"), String.valueOf(host.logs));
        assertTrue(host.infos().contains("adjust=70"), String.valueOf(host.logs));
        assertTrue(host.infos().contains("seen1=new seen2=hit"), String.valueOf(host.logs));
        assertTrue(host.infos().contains("kv=true"), String.valueOf(host.logs));
    }

    // ---- 2) 事务回滚（JSON 存储必须真的撤销；Node 是 SQLite ROLLBACK） ----
    @Test
    void txnRollbackRestoresState() throws Exception {
        Path file = Files.createTempFile("bstxn", ".json");
        Files.deleteIfExists(file);
        PersistStore store = new PersistStore(file);
        store.declareTable("T", "{\"k\":\"string:key\",\"v\":\"number\"}");
        JsonObject row = new JsonObject();
        row.addProperty("k", "x");
        row.addProperty("v", 1);
        store.txnBegin();
        store.upsert("T", row);
        store.txnRollback();
        assertEquals("[]", store.all("T"), "回滚后不得留痕");
    }

    // ---- 4) 策略向量（Node 与 Fabric 同判） ----
    @Test
    void policyVectors() throws Exception {
        for (Path file : Files.list(vectorDir("policy")).filter((f) -> f.toString().endsWith(".json")).sorted().toList()) {
            JsonObject vec = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            BotConfig cfg = new BotConfig();
            if (vec.has("boundary") && vec.get("boundary").isJsonObject()) {
                cfg.applyBoundary(vec.getAsJsonObject("boundary"));
            }
            JsonObject entity = vec.has("entity") && vec.get("entity").isJsonObject()
                    ? vec.getAsJsonObject("entity") : null;
            JsonObject selfPos = vec.has("self_pos") && vec.get("self_pos").isJsonObject()
                    ? vec.getAsJsonObject("self_pos") : null;
            Policy policy = new Policy(cfg,
                    id -> entity != null && entity.get("id").getAsString().equals(id) ? entity : null,
                    () -> selfPos == null ? null : new double[]{selfPos.get("x").getAsDouble(),
                            selfPos.get("y").getAsDouble(), selfPos.get("z").getAsDouble()},
                    () -> false);
            String err = policy.check(vec.get("op").getAsString(), vec.getAsJsonObject("args"));
            String name = vec.get("name").getAsString();
            JsonObject expect = vec.getAsJsonObject("expect");
            if (expect.get("allow").getAsBoolean()) {
                assertNull(err, name + "：应允许（实际 " + err + "）");
            } else {
                assertNotNull(err, name + "：应拒绝");
                assertEquals(expect.get("error").getAsString(),
                        LuaRuntime.parseObj(err).get("kind").getAsString(), name + "：error kind 不一致");
            }
        }
    }

    // ---- 5) 窗口向量（归一化逐槽一致 + 点击映射） ----
    @Test
    void windowVectors() throws Exception {
        for (Path file : Files.list(vectorDir("windows")).filter((f) -> f.toString().endsWith(".json")).sorted().toList()) {
            JsonObject vec = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            String name = vec.get("name").getAsString();
            JsonObject raw = vec.getAsJsonObject("raw");
            int size = raw.get("size").getAsInt();
            Map<Integer, JsonObject> slots = new HashMap<>();
            for (JsonElement s : raw.getAsJsonArray("slots")) {
                JsonObject sl = s.getAsJsonObject();
                slots.put(sl.get("index").getAsInt(), sl.getAsJsonObject("item"));
            }
            JsonObject expectWin = vec.getAsJsonObject("expect").getAsJsonObject("window");
            JsonObject dense = WindowLayout.denseView(raw.get("id").getAsString(), raw.get("type").getAsString(),
                    size, slots, null, 1);
            assertEquals(expectWin.get("size").getAsInt(), dense.get("size").getAsInt(), name + ": size");
            assertEquals(occupied(expectWin.getAsJsonObject("occupied")), occupiedDense(dense), name + ": 槽位不一致");

            JsonObject expectInv = vec.getAsJsonObject("expect").getAsJsonObject("inventory");
            boolean noContainer = raw.get("id").getAsString().equals("0") || raw.get("type").getAsString().equals("inventory");
            JsonObject merged = noContainer ? dense : WindowLayout.mergedInventory(size, slots, null, 1);
            assertEquals(expectInv.get("size").getAsInt(), merged.get("size").getAsInt());
            assertEquals(occupied(expectInv.getAsJsonObject("occupied")), occupiedDense(merged), name + ": 背包视图不一致");

            for (JsonElement c : vec.getAsJsonObject("expect").getAsJsonArray("clicks")) {
                JsonObject click = c.getAsJsonObject();
                int slot = click.get("slot").getAsInt();
                String target = raw.get("type").getAsString().equals("inventory") || raw.get("id").getAsString().equals("0")
                        ? "0" : raw.get("id").getAsString();
                int targetSlot = target.equals("0") ? slot : WindowLayout.inventoryToPlayerZone(size, slot);
                assertEquals(click.get("target").getAsString(), target, name + ": 点击目标窗口");
                assertEquals(click.get("target_slot").getAsInt(), targetSlot, name + ": 点击槽映射");
            }
        }
    }

    private static Map<String, String> occupied(JsonObject expectSparse) {
        Map<String, String> out = new java.util.TreeMap<>();
        for (var e : expectSparse.entrySet()) out.put(e.getKey(), e.getValue().getAsString());
        return out;
    }

    private static Map<String, String> occupiedDense(JsonObject dense) {
        Map<String, String> out = new java.util.TreeMap<>();
        for (JsonElement s : dense.getAsJsonArray("slots")) {
            JsonObject sl = s.getAsJsonObject();
            if (!sl.get("item").isJsonNull()) {
                out.put(String.valueOf(sl.get("index").getAsInt()), sl.getAsJsonObject("item").get("id").getAsString());
            }
        }
        return out;
    }

    // ---- 6) persist 向量（同一操作序列 => 相同表行/seen/kv/日志语义） ----
    @Test
    void persistVectors() throws Exception {
        for (Path file : Files.list(vectorDir("persist")).filter((f) -> f.toString().endsWith(".json")).sorted().toList()) {
            JsonObject vec = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            String name = vec.get("name").getAsString();
            Path tmp = Files.createTempFile("bsvec", ".json");
            Files.deleteIfExists(tmp);
            PersistStore store = new PersistStore(tmp);
            List<Integer> seen = new ArrayList<>();
            for (JsonElement opEl : vec.getAsJsonArray("ops")) {
                JsonObject op = opEl.getAsJsonObject();
                JsonArray a = op.getAsJsonArray("args");
                switch (op.get("op").getAsString()) {
                    case "declareTable" -> store.declareTable(a.get(0).getAsString(), a.get(1).toString());
                    case "upsert" -> store.upsert(a.get(0).getAsString(), a.get(1).getAsJsonObject());
                    case "del" -> store.del(a.get(0).getAsString(), a.size() > 1 ? a.get(1).getAsJsonObject() : new JsonObject());
                    case "adjust" -> store.adjust(a.get(0).getAsString(),
                            a.get(1).getAsString(), a.get(2).getAsDouble());
                    case "seen" -> seen.add(store.seen(a.get(0).getAsString(), a.get(1).getAsLong(), 5_000_000L));
                    case "kvSet" -> store.kvSet(a.get(0).getAsString(), a.get(1).getAsString(), a.get(2).getAsString());
                    case "logDeclare" -> store.logDeclare(a.get(0).getAsString());
                    case "logAppend" -> store.logAppend(a.get(0).getAsString(), a.get(1).getAsJsonObject(), 5_000_000L);
                    default -> fail("未实现向量 op " + op.get("op").getAsString());
                }
            }
            JsonObject expect = vec.getAsJsonObject("expect");
            for (var e : expect.getAsJsonObject("rows").entrySet()) {
                JsonArray got = JsonParser.parseString(store.all(e.getKey())).getAsJsonArray();
                assertEquals(e.getValue().getAsJsonArray().size(), got.size(), name + ": 行数");
                for (int i = 0; i < got.size(); i++) {
                    assertEquals(e.getValue().getAsJsonArray().get(i), got.get(i), name + ": 行 " + i);
                }
            }
            for (var e : expect.getAsJsonObject("kv").entrySet()) {
                String[] ns = e.getKey().split("/");
                assertEquals(e.getValue().getAsString(), store.kvGet(ns[0], ns[1]), name + ": kv");
            }
            if (expect.has("seen")) {
                List<Integer> exp = expect.getAsJsonArray("seen").asList().stream()
                        .map(JsonElement::getAsInt).toList();
                assertEquals(exp, seen, name + ": seen 判定");
            }
            if (expect.has("logCounts")) {
                for (var e : expect.getAsJsonObject("logCounts").entrySet()) {
                    for (var st : e.getValue().getAsJsonObject().entrySet()) {
                        JsonObject where = new JsonObject();
                        where.addProperty("state", st.getKey());
                        JsonArray got = JsonParser.parseString(store.logFind(e.getKey(), where)).getAsJsonArray();
                        assertEquals(st.getValue().getAsInt(), got.size(), name + ": " + e.getKey() + "/" + st.getKey());
                    }
                }
            }
        }
    }
}
