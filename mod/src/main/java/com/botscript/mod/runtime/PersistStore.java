package com.botscript.mod.runtime;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 持久化（engine.js Persist 的 JSON 文件对应物）。
 * kv / seen 去重窗 / 声明表（含主键 upsert、blockpos 序列化）/ 追加日志 / 事务标记。
 * 单线程（游戏线程）访问 + 同步写盘：数据量小（bot 账本级别），写频率低。
 */
public final class PersistStore {

    private static final class Table {
        Map<String, String> schema = new LinkedHashMap<>();   // field -> "type[:key][?]"
        String keyField;
        List<String> fields = new ArrayList<>();
        List<Map<String, Object>> rows = new ArrayList<>();   // Object: Double | String(posKey) 
    }

    private static final class Log {
        long nextId = 1;
        List<Map<String, Object>> rows = new ArrayList<>();   // id, ts, state, __data(JSON string)
    }

    private final Path file;
    private final Map<String, String> kv = new LinkedHashMap<>();
    private final Map<String, Long> seen = new LinkedHashMap<>();
    private final Map<String, Table> tables = new LinkedHashMap<>();
    private final Map<String, Log> logs = new LinkedHashMap<>();
    private int txnDepth = 0;

    // 事务快照（txn 体回滚需要真实撤销；Node 宿主是 SQLite ROLLBACK，语义必须一致）
    private Map<String, String> txnKv;
    private Map<String, Long> txnSeen;
    private Map<String, Table> txnTables;
    private Map<String, Log> txnLogs;

    public PersistStore(Path file) {
        this.file = file;
        load();
    }

    // ---- 读写盘 ----
    private void load() {
        if (!Files.exists(file)) return;
        try {
            JsonObject o = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            o.getAsJsonObject("kv").entrySet().forEach(e -> kv.put(e.getKey(), e.getValue().getAsString()));
            o.getAsJsonObject("seen").entrySet().forEach(e -> seen.put(e.getKey(), e.getValue().getAsLong()));
            for (var e : o.getAsJsonObject("tables").entrySet()) {
                Table t = new Table();
                JsonObject spec = e.getValue().getAsJsonObject();
                for (var f : spec.getAsJsonObject("schema").entrySet()) {
                    t.schema.put(f.getKey(), f.getValue().getAsString());
                    t.fields.add(f.getKey());
                    if (f.getValue().getAsString().contains(":key")) t.keyField = f.getKey();
                }
                for (var r : spec.getAsJsonArray("rows")) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (var fe : r.getAsJsonObject().entrySet()) {
                        JsonElement v = fe.getValue();
                        row.put(fe.getKey(), v.isJsonNull() ? null
                                : v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()
                                ? (Object) v.getAsDouble() : (Object) v.getAsString());
                    }
                    t.rows.add(row);
                }
                tables.put(e.getKey(), t);
            }
            for (var e : o.getAsJsonObject("logs").entrySet()) {
                Log l = new Log();
                JsonObject spec = e.getValue().getAsJsonObject();
                l.nextId = spec.get("nextId").getAsLong();
                for (var r : spec.getAsJsonArray("rows")) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", r.getAsJsonObject().get("id").getAsDouble());
                    row.put("ts", r.getAsJsonObject().get("ts").getAsDouble());
                    row.put("state", r.getAsJsonObject().get("state").getAsString());
                    row.put("__data", r.getAsJsonObject().get("data").getAsString());
                    l.rows.add(row);
                }
                logs.put(e.getKey(), l);
            }
        } catch (Exception e) {
            // 损坏的持久化文件：按空库继续（不抛出，避免 bot 无法启动）
        }
    }

    private void save() {
        try {
            Files.createDirectories(file.getParent());
            JsonObject o = new JsonObject();
            JsonObject kvO = new JsonObject();
            kv.forEach(kvO::addProperty);
            o.add("kv", kvO);
            JsonObject seenO = new JsonObject();
            seen.forEach(seenO::addProperty);
            o.add("seen", seenO);
            JsonObject tablesO = new JsonObject();
            for (var e : tables.entrySet()) {
                JsonObject t = new JsonObject();
                JsonObject schema = new JsonObject();
                e.getValue().schema.forEach(schema::addProperty);
                t.add("schema", schema);
                JsonArray rows = new JsonArray();
                for (Map<String, Object> row : e.getValue().rows) {
                    JsonObject r = new JsonObject();
                    for (var fe : row.entrySet()) {
                        Object v = fe.getValue();
                        if (v == null) r.add(fe.getKey(), com.google.gson.JsonNull.INSTANCE);
                        else if (v instanceof Double d) r.addProperty(fe.getKey(), d);
                        else r.addProperty(fe.getKey(), String.valueOf(v));
                    }
                    rows.add(r);
                }
                t.add("rows", rows);
                tablesO.add(e.getKey(), t);
            }
            o.add("tables", tablesO);
            JsonObject logsO = new JsonObject();
            for (var e : logs.entrySet()) {
                JsonObject l = new JsonObject();
                l.addProperty("nextId", e.getValue().nextId);
                JsonArray rows = new JsonArray();
                for (Map<String, Object> row : e.getValue().rows) {
                    JsonObject r = new JsonObject();
                    r.addProperty("id", (Double) row.get("id"));
                    r.addProperty("ts", (Double) row.get("ts"));
                    r.addProperty("state", String.valueOf(row.get("state")));
                    r.addProperty("data", String.valueOf(row.get("__data")));
                    rows.add(r);
                }
                l.add("rows", rows);
                logsO.add(e.getKey(), l);
            }
            o.add("logs", logsO);
            Files.writeString(file, o.toString());
        } catch (IOException e) {
            throw new RuntimeException("persist 写盘失败: " + e.getMessage(), e);
        }
    }

    // ---- 桥语义（对齐 engine.js Persist）----

    /** persist.seen：命中 1，未命中登记并返 0 */
    public int seen(String key, long windowMs, long now) {
        seen.values().removeIf((ts) -> ts < now - Math.max(0, windowMs - 50));
        Long hit = seen.get(key);
        if (hit != null && now - hit <= windowMs) return 1;
        seen.put(key, now);
        save();
        return 0;
    }

    public void declareTable(String name, String schemaJson) {
        Table t = tables.computeIfAbsent(name, (k) -> new Table());
        t.schema.clear();
        t.fields.clear();
        t.keyField = null;
        JsonObject schema = JsonParser.parseString(schemaJson).getAsJsonObject();
        for (var e : schema.entrySet()) {
            String type = e.getValue().getAsString();
            t.schema.put(e.getKey(), type);
            t.fields.add(e.getKey());
            if (type.contains(":key")) t.keyField = e.getKey();
        }
        save();
    }

    private Table table(String name) {
        Table t = tables.get(name);
        if (t == null) throw new IllegalArgumentException("persist table 未声明: " + name);
        return t;
    }

    private static Object colVal(String type, JsonElement v) {
        if (v == null || v.isJsonNull()) return null;
        String base = type.split(":")[0].replaceAll("\\?$", "");
        if (base.equals("blockpos")) {
            JsonObject p = v.getAsJsonObject();
            return Policy.posKey(p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble());
        }
        if (base.equals("number")) return v.getAsDouble();
        return v.getAsString();
    }

    private static JsonElement rowVal(String type, Object v) {
        if (v == null) return com.google.gson.JsonNull.INSTANCE;
        String base = type.split(":")[0].replaceAll("\\?$", "");
        if (base.equals("blockpos")) {
            String[] parts = String.valueOf(v).split(",");
            JsonObject p = new JsonObject();
            p.addProperty("x", Double.parseDouble(parts[0]));
            p.addProperty("y", Double.parseDouble(parts[1]));
            p.addProperty("z", Double.parseDouble(parts[2]));
            return p;
        }
        if (v instanceof Double d) {
            // 整数值以整型字面量输出（对齐引擎 JSON 数字形态）
            return new com.google.gson.JsonPrimitive(
                    d == Math.floor(d) && !d.isInfinite() && !d.isNaN() ? (Number) d.longValue() : d);
        }
        return new com.google.gson.JsonPrimitive(String.valueOf(v));
    }

    private JsonElement rowToJson(Table t, Map<String, Object> row) {
        JsonObject out = new JsonObject();
        for (String f : t.fields) out.add(f, rowVal(t.schema.get(f), row.get(f)));
        return out;
    }

    private static boolean whereHit(Table t, Map<String, Object> row, JsonObject where) {
        for (var e : where.entrySet()) {
            Object rv = row.get(e.getKey());
            JsonElement v = e.getValue();
            boolean eq;
            String type = t.schema.get(e.getKey());
            if (type != null && type.startsWith("blockpos") && rv != null && v.isJsonObject()) {
                JsonObject p = v.getAsJsonObject();
                eq = String.valueOf(rv).equals(Policy.posKey(
                        p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble()));
            } else if (v.isJsonNull()) {
                eq = rv == null;
            } else if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()) {
                eq = rv instanceof Double d && d == v.getAsDouble();
            } else {
                eq = rv != null && String.valueOf(rv).equals(v.getAsString());
            }
            if (!eq) return false;
        }
        return true;
    }

    public String find(String name, JsonObject where) {
        Table t = table(name);
        for (Map<String, Object> row : t.rows) {
            if (whereHit(t, row, where)) return rowToJson(t, row).toString();
        }
        return "";
    }

    public String all(String name) {
        Table t = table(name);
        JsonArray arr = new JsonArray();
        for (Map<String, Object> row : t.rows) arr.add(rowToJson(t, row));
        return arr.toString();
    }

    /** 控制通道（HTTP /persist）只读枚举：已声明的表与追加日志名 */
    public synchronized JsonObject listNames() {
        JsonObject o = new JsonObject();
        com.google.gson.JsonArray ts = new com.google.gson.JsonArray();
        for (String n : tables.keySet()) ts.add(n);
        o.add("tables", ts);
        com.google.gson.JsonArray ls = new com.google.gson.JsonArray();
        for (String n : logs.keySet()) ls.add(n);
        o.add("logs", ls);
        return o;
    }

    /** 控制通道只读：某命名空间的全部 kv */
    public synchronized String kvAll(String name) {
        JsonObject o = new JsonObject();
        String prefix = name + "/";
        for (var e : kv.entrySet()) {
            if (e.getKey().startsWith(prefix)) {
                try { o.add(e.getKey().substring(prefix.length()), JsonParser.parseString(e.getValue())); }
                catch (Exception ex) { o.addProperty(e.getKey().substring(prefix.length()), e.getValue()); }
            }
        }
        return o.toString();
    }

    public void upsert(String name, JsonObject row) {
        Table t = table(name);
        if (t.keyField != null && (row.get(t.keyField) == null || row.get(t.keyField).isJsonNull())) {
            throw new IllegalArgumentException("upsert 缺主键 " + t.keyField);
        }
        Map<String, Object> mapped = new LinkedHashMap<>();
        for (String f : t.fields) mapped.put(f, colVal(t.schema.get(f), row.get(f)));
        if (t.keyField != null) {
            for (int i = 0; i < t.rows.size(); i++) {
                Object kvExisting = t.rows.get(i).get(t.keyField);
                Object kvNew = mapped.get(t.keyField);
                if (kvExisting != null && kvExisting.equals(kvNew)) {
                    t.rows.set(i, mapped);
                    save();
                    return;
                }
            }
        }
        t.rows.add(mapped);
        save();
    }

    public void del(String name, JsonObject where) {
        Table t = table(name);
        t.rows.removeIf((row) -> whereHit(t, row, where));
        save();
    }

    /** 主键/数值字段由表 schema 推导（ABI v2） */
    public String adjust(String name, String key, double delta) {
        Table t = table(name);
        String keyField = t.keyField;
        String numField = null;
        for (String f : t.fields) {
            String base = t.schema.get(f).split(":")[0].replace("?", "");
            if ("number".equals(base)) { numField = f; break; }
        }
        if (keyField == null || numField == null) throw new IllegalArgumentException("调整需要主键与数值字段: " + name);
        JsonObject where = new JsonObject();
        where.addProperty(keyField, key);
        String found = find(name, where);
        double val;
        if (!found.isEmpty()) {
            JsonObject row = JsonParser.parseString(found).getAsJsonObject();
            val = row.has(numField) && !row.get(numField).isJsonNull() ? row.get(numField).getAsDouble() : 0;
        } else {
            JsonObject blank = new JsonObject();
            for (String f : t.fields) blank.add(f, com.google.gson.JsonNull.INSTANCE);
            blank.add(numField, com.google.gson.JsonNull.INSTANCE);
            blank.addProperty(keyField, key);
            blank.addProperty(numField, 0);
            upsert(name, blank);
            val = 0;
        }
        val += delta;
        JsonObject fresh = JsonParser.parseString(find(name, where)).getAsJsonObject();
        fresh.addProperty(numField, val);
        upsert(name, fresh);
        return fresh.toString();
    }

    // ---- kv ----
    public String kvGet(String name, String k) {
        return kv.getOrDefault(name + "/" + k, "");
    }

    public void kvSet(String name, String k, String json) {
        kv.put(name + "/" + k, json);
        save();
    }

    // ---- 追加日志 ----
    public void logDeclare(String name) {
        logs.computeIfAbsent(name, (k) -> new Log());
        save();
    }

    public long logAppend(String name, JsonObject fields, long now) {
        Log l = logs.computeIfAbsent(name, (k) -> new Log());
        long id = l.nextId++;
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", (double) id);
        row.put("ts", (double) now);
        row.put("state", fields != null && fields.has("state") && !fields.get("state").isJsonNull()
                ? fields.get("state").getAsString() : "new");
        row.put("__data", fields == null ? "{}" : fields.toString());
        l.rows.add(row);
        save();
        return id;
    }

    public String logFind(String name, JsonObject where) {
        Log l = logs.get(name);
        JsonArray out = new JsonArray();
        if (l == null) return out.toString();
        for (Map<String, Object> row : l.rows) {
            JsonObject data = JsonParser.parseString(String.valueOf(row.get("__data"))).getAsJsonObject();
            boolean hit = true;
            for (var e : where.entrySet()) {
                JsonElement rv;
                if (e.getKey().equals("state")) rv = new com.google.gson.JsonPrimitive(String.valueOf(row.get("state")));
                else rv = data.get(e.getKey());
                boolean eq;
                if (rv == null) eq = e.getValue().isJsonNull();
                else if (e.getValue().isJsonPrimitive() && e.getValue().getAsJsonPrimitive().isNumber()) {
                    eq = rv.isJsonPrimitive() && rv.getAsJsonPrimitive().isNumber()
                            && rv.getAsDouble() == e.getValue().getAsDouble();
                } else if (e.getValue().isJsonPrimitive()) {
                    eq = rv.isJsonPrimitive() && rv.getAsString().equals(e.getValue().getAsString());
                } else {
                    eq = rv.toString().equals(e.getValue().toString());
                }
                if (!eq) { hit = false; break; }
            }
            if (hit) {
                JsonObject o = new JsonObject();
                for (var de : data.entrySet()) {
                    if (!de.getKey().equals("state")) o.add(de.getKey(), de.getValue());   // state 以标记后的行为准
                }
                o.addProperty("id", (Double) row.get("id"));
                o.addProperty("ts", (Double) row.get("ts"));
                o.addProperty("state", String.valueOf(row.get("state")));
                out.add(o);
            }
        }
        return out.toString();
    }

    public void logMark(String name, double id, String state) {
        Log l = logs.get(name);
        if (l == null) return;
        for (Map<String, Object> row : l.rows) {
            if ((Double) row.get("id") == id) {
                row.put("state", state);
                break;
            }
        }
        save();
    }

    // ---- 事务（调度器保证体内无挂起点；体内出现挂起点由核心回滚） ----
    public void txnBegin() {
        if (txnDepth == 0) {
            txnKv = new LinkedHashMap<>(kv);
            txnSeen = new LinkedHashMap<>(seen);
            txnTables = deepCopy(tables, PersistStore::copyTable);
            txnLogs = deepCopy(logs, PersistStore::copyLog);
        }
        txnDepth++;
    }

    public void txnCommit() {
        txnDepth = Math.max(0, txnDepth - 1);
        if (txnDepth == 0) {
            txnKv = null; txnSeen = null;
            txnTables = null; txnLogs = null;
            save();
        }
    }

    public void txnRollback() {
        if (txnDepth > 0) {
            kv.clear(); kv.putAll(txnKv);
            seen.clear(); seen.putAll(txnSeen);
            tables.clear(); tables.putAll(txnTables);
            logs.clear(); logs.putAll(txnLogs);
            txnKv = null; txnSeen = null;
            txnTables = null; txnLogs = null;
            txnDepth = 0;
            save();
        }
    }

    private static <V> Map<String, V> deepCopy(Map<String, V> src, java.util.function.Function<V, V> copier) {
        Map<String, V> out = new LinkedHashMap<>();
        for (var e : src.entrySet()) out.put(e.getKey(), copier.apply(e.getValue()));
        return out;
    }

    private static Table copyTable(Table t) {
        Table n = new Table();
        n.schema = new LinkedHashMap<>(t.schema);
        n.keyField = t.keyField;
        n.fields = new ArrayList<>(t.fields);
        for (Map<String, Object> row : t.rows) n.rows.add(new LinkedHashMap<>(row));
        return n;
    }

    private static Log copyLog(Log l) {
        Log n = new Log();
        n.nextId = l.nextId;
        for (Map<String, Object> row : l.rows) n.rows.add(new LinkedHashMap<>(row));
        return n;
    }
}
