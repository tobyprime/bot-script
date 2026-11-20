package com.botscript.mod.runtime;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 实例级小状态（localStorage 语义；engine.js StateStore 的 JSON 文件对应物）。
 *
 * key -> JSON value：无 schema/查询/多键事务。单值 ≤16KB、总量 ≤256KB。
 * 文件路径由宿主固定（botscript/state/state.json），脚本/包无权指定。
 */
public final class StateStore {

    public static final int QUOTA = 256 * 1024;
    public static final int VALUE_MAX = 16 * 1024;

    private final Path file;
    private final Map<String, String> state = new LinkedHashMap<>();   // key -> JSON text
    private final Map<String, Long> seen = new LinkedHashMap<>();
    private boolean seenDirty = false;

    public StateStore(Path file) {
        this.file = file;
        load();
    }

    private void load() {
        if (!Files.exists(file)) return;
        try {
            JsonObject o = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            if (o.has("state") && o.get("state").isJsonObject()) {
                for (var e : o.getAsJsonObject("state").entrySet()) {
                    state.put(e.getKey(), e.getValue().toString());
                }
            }
            if (o.has("seen") && o.get("seen").isJsonObject()) {
                for (var e : o.getAsJsonObject("seen").entrySet()) {
                    seen.put(e.getKey(), e.getValue().getAsLong());
                }
            }
        } catch (Exception e) {
            // 损坏的状态文件按空状态继续（不阻断启动）；下次写入即重建
        }
    }

    private void save() {
        try {
            Files.createDirectories(file.getParent());
            JsonObject o = new JsonObject();
            o.addProperty("version", 1);
            JsonObject s = new JsonObject();
            for (var e : state.entrySet()) s.add(e.getKey(), JsonParser.parseString(e.getValue()));
            o.add("state", s);
            JsonObject sn = new JsonObject();
            for (var e : seen.entrySet()) sn.addProperty(e.getKey(), e.getValue());
            o.add("seen", sn);
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.writeString(tmp, o.toString(), StandardCharsets.UTF_8);
            try {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFail) {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
            }
            seenDirty = false;
        } catch (IOException e) {
            throw new RuntimeException("state 写盘失败: " + e.getMessage(), e);
        }
    }

    private int bytes() {
        int total = 0;
        for (var e : state.entrySet()) {
            total += byteLen(e.getKey()) + byteLen(e.getValue());
        }
        return total;
    }

    private static int byteLen(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    // ---- 桥语义（对齐 engine.js StateStore）----

    public JsonElement get(String key) {
        String j = state.get(key);
        return j == null ? null : JsonParser.parseString(j);
    }

    public JsonObject all() {
        JsonObject o = new JsonObject();
        for (var e : state.entrySet()) o.add(e.getKey(), JsonParser.parseString(e.getValue()));
        return o;
    }

    public void set(String key, JsonElement value) {
        if (key == null || key.isEmpty()) throw new LuaRuntime.AbiError("state.bad_request", "state key 不能为空");
        if (byteLen(key) > 128) throw new LuaRuntime.AbiError("state.bad_request", "state key 过长（>128 字节）");
        if (key.indexOf('\u0000') >= 0) throw new LuaRuntime.AbiError("state.bad_request", "state key 不得包含 NUL");
        String json = value == null || value.isJsonNull() ? "null" : value.toString();
        int size = byteLen(json);
        if (size > VALUE_MAX) {
            throw new LuaRuntime.AbiError("state.quota",
                    "单值过大（" + size + " > " + VALUE_MAX + " 字节）");
        }
        String prev = state.get(key);
        int total = bytes() - (prev == null ? 0 : byteLen(key) + byteLen(prev)) + byteLen(key) + size;
        if (total > QUOTA) {
            throw new LuaRuntime.AbiError("state.quota",
                    "状态总量超限（" + total + " > " + QUOTA + " 字节）");
        }
        state.put(key, json);
        save();
    }

    public void delete(String key) {
        if (state.remove(key) != null) save();
    }

    /** 内容寻址去重窗：true = 窗口内已见过（重复）。不占用户配额。 */
    public boolean seen(String key, long windowMs, long now) {
        seen.values().removeIf((ts) -> ts < now - Math.max(0, windowMs - 50));
        Long hit = seen.get(key);
        if (hit != null && now - hit <= windowMs) return true;
        seen.put(key, now);
        seenDirty = true;
        return false;
    }

    public void clear() {
        state.clear();
        seen.clear();
        seenDirty = true;
        save();
    }

    public void flush() {
        if (seenDirty) save();
    }

    public void close() {
        flush();
    }

    public JsonObject stats() {
        JsonObject o = new JsonObject();
        o.addProperty("entries", state.size());
        o.addProperty("bytes", bytes());
        o.addProperty("quota", QUOTA);
        o.addProperty("value_max", VALUE_MAX);
        return o;
    }
}
