package com.botscript.mod.runtime;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Lua 运行时契约：调度向量（与 Node/wasmoon 同一份 JSON）+ 核心入口语义。 */
class LuaRuntimeTest {

    static final class CaptureLog implements LuaRuntime.LogSink {
        final java.util.List<String> lines = new java.util.ArrayList<>();
        @Override public void log(String level, String msg) { lines.add(level + "|" + msg); }
        java.util.List<String> infos() {
            return lines.stream().filter((l) -> l.startsWith("info|")).map((l) -> l.substring(5)).toList();
        }
    }

    private static LuaRuntime makeRuntime(CaptureLog sink, long[] clock, TestHost[] hostOut) {
        LuaRuntime rt = new LuaRuntime("vec", sink, () -> clock[0]);
        TestHost host = new TestHost(rt, clock);
        rt.setHostBridge(host);
        hostOut[0] = host;
        rt.bootRuntimeLibs();
        return rt;
    }

    private static Path vectorDir(String name) {
        Path p = Path.of("../contracts/vectors", name);
        assertTrue(Files.isDirectory(p), "缺少向量目录 " + p.toAbsolutePath());
        return p;
    }

    // ---- scheduler 向量：Node(wasmoon) 与 Java(Luaj) 必须产出同一日志序列 ----
    @Test
    void schedulerVectorsMatchNode() throws Exception {
        for (Path file : Files.list(vectorDir("scheduler")).filter((f) -> f.toString().endsWith(".json")).sorted().toList()) {
            JsonObject vec = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            String name = vec.get("name").getAsString();
            long[] clock = {1000};
            CaptureLog sink = new CaptureLog();
            TestHost[] hostOut = new TestHost[1];
            LuaRuntime rt = makeRuntime(sink, clock, hostOut);
            TestHost host = hostOut[0];
            rt.exec(vec.get("script").getAsString(), "@vec");

            for (JsonElement stepEl : vec.getAsJsonArray("steps")) {
                JsonObject step = stepEl.getAsJsonObject();
                if (step.has("event")) {
                    JsonArray ev = step.getAsJsonArray("event");
                    String payload = ev.size() > 1 && !ev.get(1).isJsonNull() ? ev.get(1).toString() : "";
                    rt.event(ev.get(0).getAsString(), payload);
                } else if (step.has("call")) {
                    JsonArray call = step.getAsJsonArray("call");
                    rt.coreCall(call.get(0).getAsString(),
                            call.size() > 1 ? call.get(1).getAsJsonObject() : new JsonObject());
                } else if (step.has("advance")) {
                    host.advance(step.get("advance").getAsLong());
                } else if (step.has("pause")) {
                    rt.pause("vector");
                } else if (step.has("resume")) {
                    rt.resume();
                }
            }

            List<String> expect = vec.getAsJsonArray("expectLogs").asList().stream()
                    .map(JsonElement::getAsString).toList();
            assertEquals(expect, host.logs, "向量 " + name + "：日志序列不一致（Node 与 Luaj 必须同序列）");
        }
    }

    // ---- 生命周期 + task.spawn + time.sleep ----
    @Test
    void lifecycleTaskSleep() {
        long[] clock = {1_000_000};
        CaptureLog sink = new CaptureLog();
        TestHost[] hostOut = new TestHost[1];
        LuaRuntime rt = makeRuntime(sink, clock, hostOut);
        TestHost host = hostOut[0];
        rt.exec("""
                on_start(function()
                  log.info("hello")
                  task.spawn(function()
                    log.info("before sleep")
                    time.sleep(100)
                    log.info("after sleep")
                  end)
                end)
                """, "@hello");
        rt.start();
        assertTrue(host.infos().contains("hello"), String.valueOf(host.logs));
        assertTrue(host.infos().contains("before sleep"));
        assertFalse(host.infos().contains("after sleep"));
        host.advance(50);
        assertFalse(host.infos().contains("after sleep"));
        host.advance(50);
        assertTrue(host.infos().contains("after sleep"), String.valueOf(host.logs));
    }

    // ---- 动作 token：同步完成 + 未知动作错误交付 ----
    @Test
    void actionTokenRoundtrip() {
        long[] clock = {1_000_000};
        CaptureLog sink = new CaptureLog();
        TestHost[] hostOut = new TestHost[1];
        LuaRuntime rt = makeRuntime(sink, clock, hostOut);
        TestHost host = hostOut[0];
        rt.exec("""
                on_start(function()
                  task.spawn(function()
                    local r = nav.hop()
                    log.info("hop ok")
                  end)
                  task.spawn(function()
                    local ok, err = pcall(function() return call_action("act.nope", {}) end)
                    log.info("unknown failed=%s kind=%s", tostring(ok), type(err) == "table" and err.kind or type(err))
                  end)
                end)
                """, "@act");
        rt.start();
        host.advance(300);   // nav.hop 内含 100ms 输入窗口，推进虚拟时钟
        assertTrue(host.infos().contains("hop ok"), String.valueOf(host.logs));
        assertTrue(host.infos().stream().anyMatch((s) -> s.startsWith("unknown failed=false kind=abi.unknown_op")),
                String.valueOf(host.logs));
    }

    // ---- pause 冻结 + resume 于冻结点重抛 runtime.paused ----
    @Test
    void pauseFreezesDeliveries() {
        long[] clock = {1_000_000};
        CaptureLog sink = new CaptureLog();
        TestHost[] hostOut = new TestHost[1];
        LuaRuntime rt = makeRuntime(sink, clock, hostOut);
        TestHost host = hostOut[0];
        rt.exec("""
                on_start(function()
                  task.spawn(function()
                    local ok, err = pcall(function() return call_action("act.long", {}) end)
                    log.info("resumed err=%s", type(err) == "table" and err.kind or tostring(err))
                  end)
                end)
                """, "@pause");
        rt.start();
        rt.pause("fence");
        assertTrue(rt.isPaused());
        assertFalse(host.infos().stream().anyMatch((s) -> s.startsWith("resumed")), String.valueOf(host.logs));
        rt.resume();
        assertTrue(host.infos().stream().anyMatch((s) -> s.contains("resumed err=runtime.paused")),
                String.valueOf(host.logs));
    }

    // ---- 查询桥 + params 类型改写 ----
    @Test
    void paramsCoercion() {
        long[] clock = {1_000_000};
        CaptureLog sink = new CaptureLog();
        TestHost[] hostOut = new TestHost[1];
        LuaRuntime rt = makeRuntime(sink, clock, hostOut);
        TestHost host = hostOut[0];
        rt.exec("""
                params { source = { type = "blockpos", required = true } }
                on_start(function()
                  local p = params.source
                  log.info("src=%d %d %d", p.x, p.y, p.z)
                  local s = self.pos()
                  log.info("pos=%.0f %.0f %.0f", s.x, s.y, s.z)
                end)
                """, "@q");
        JsonObject manifest = new JsonObject();
        manifest.add("source", JsonParser.parseString("[119,151,-306]"));
        rt.bindParams(manifest, new JsonObject());
        rt.start();
        assertTrue(host.infos().contains("src=119 151 -306"), String.valueOf(host.logs));
        assertTrue(host.infos().stream().anyMatch((x) -> x.startsWith("pos=0")), String.valueOf(host.logs));
    }

    // ---- LuaJ 兼容补丁：math.type / math.atan2 必须可用（compat/luaj.lua） ----
    @Test
    void luajCompatPatches() {
        long[] clock = {1_000_000};
        CaptureLog sink = new CaptureLog();
        TestHost[] hostOut = new TestHost[1];
        LuaRuntime rt = makeRuntime(sink, clock, hostOut);
        TestHost host = hostOut[0];
        var math = rt.global("math");
        assertFalse(math.get("type").isnil(), "compat/luaj.lua 必须补齐 math.type");
        assertEquals("float", math.get("type").call(org.luaj.vm2.LuaValue.valueOf(1)).tojstring());
        assertFalse(math.get("atan2").isnil(), "compat/luaj.lua 必须补齐 math.atan2");
    }
}
