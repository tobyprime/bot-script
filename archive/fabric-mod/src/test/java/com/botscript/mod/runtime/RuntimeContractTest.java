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

    // ---- 1) state 桥（经 Lua 全链路；localStorage 语义） ----
    @Test
    void stateBridgeThroughLua() throws Exception {
        long[] clock = {1000};
        CaptureLog sink = new CaptureLog();
        LuaRuntime rt = new LuaRuntime("test-bot", sink, () -> clock[0]);
        TestHost host = new TestHost(rt, clock);
        rt.setHostBridge(host);
        rt.bootRuntimeLibs();
        rt.loadScripts(List.of(new LuaRuntime.ScriptFile("state.lua", """
                on_start(function()
                  state.set("acc", { name = "Mix", balance = 100 })
                  local a = state.get("acc")
                  log.info("get=%s %s", a.name, tostring(a.balance))
                  state.update("acc", function(v) v.balance = v.balance - 30; return v end)
                  log.info("update=%s", tostring(state.get("acc").balance))
                  log.info("seen1=%s seen2=%s", state.seen("tx:1", 5000) and "hit" or "new",
                           state.seen("tx:1", 5000) and "hit" or "new")
                  state.delete("acc")
                  log.info("after-delete=%s", tostring(state.get("acc")))
                end)
                """, true)));
        rt.bindParams(new JsonObject(), new JsonObject());
        rt.start();
        assertTrue(host.infos().contains("get=Mix 100"), String.valueOf(host.logs));
        assertTrue(host.infos().contains("update=70"), String.valueOf(host.logs));
        assertTrue(host.infos().contains("seen1=new seen2=hit"), String.valueOf(host.logs));
        assertTrue(host.infos().contains("after-delete=nil"), String.valueOf(host.logs));
    }

    @Test
    void stateStoreQuotaAndPersistence() throws Exception {
        Path file = Files.createTempFile("bsstate", ".json");
        Files.deleteIfExists(file);
        StateStore store = new StateStore(file);
        store.set("k", JsonParser.parseString("{\"v\":1}"));
        assertEquals(1, store.get("k").getAsJsonObject().get("v").getAsInt());
        store.close();

        StateStore reopened = new StateStore(file);
        assertEquals(1, reopened.get("k").getAsJsonObject().get("v").getAsInt(), "值应跨重启保留");
        reopened.delete("k");
        assertNull(reopened.get("k"));

        String big = "x".repeat(StateStore.VALUE_MAX + 1);
        assertThrows(LuaRuntime.AbiError.class,
                () -> reopened.set("big", new com.google.gson.JsonPrimitive(big)), "单值超限应拒绝");
        String chunk = "y".repeat(StateStore.VALUE_MAX - 8);
        int i = 0;
        try {
            for (; i < 40; i++) reopened.set("k" + i, new com.google.gson.JsonPrimitive(chunk));
            fail("总量超限应拒绝写入");
        } catch (LuaRuntime.AbiError e) {
            assertEquals("state.quota", e.kind);
        }
        assertTrue(i > 0 && i < 40);
        assertTrue(reopened.stats().get("bytes").getAsInt() <= StateStore.QUOTA);
        reopened.clear();
        assertEquals(0, reopened.stats().get("entries").getAsInt(), "clear 应清空全部键");
        reopened.close();
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
}
