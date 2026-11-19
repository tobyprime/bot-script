package com.botscript.mod.runtime;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

/**
 * 窗口槽位归一化（纯函数，无 MC 依赖）：Node 的 state/windows.js 与 Fabric 的 McState 共用同一套规则，
 * 由 contracts/vectors/windows/*.json 锁定（JUnit 直接跑向量）。
 */
public final class WindowLayout {
    private WindowLayout() {}

    /** 容器窗口槽 → 背包槽（0-8 快捷栏 / 9-35 主背包）；不在玩家区返回 -1 */
    public static int playerZoneToInventory(int size, int idx) {
        if (idx >= size && idx < size + 27) return idx - size + 9;
        if (idx >= size + 27 && idx < size + 36) return idx - size - 27;
        return -1;
    }

    /** 背包槽 → 容器窗口玩家区槽 */
    public static int inventoryToPlayerZone(int size, int invSlot) {
        return invSlot >= 9 ? size + (invSlot - 9) : size + 27 + invSlot;
    }

    /** 容器打开时的背包合并视图（36 格 dense） */
    public static JsonObject mergedInventory(int size, java.util.Map<Integer, JsonObject> contSlots,
                                             JsonObject cursor, int revision) {
        JsonObject o = new JsonObject();
        o.addProperty("id", "0");
        o.addProperty("type", "inventory");
        o.addProperty("title", "背包");
        o.addProperty("size", 36);
        JsonArray slots = new JsonArray();
        JsonObject[] inv = new JsonObject[36];
        for (var e : contSlots.entrySet()) {
            int invIdx = playerZoneToInventory(size, e.getKey());
            if (invIdx >= 0) inv[invIdx] = e.getValue();
        }
        for (int i = 0; i < 36; i++) {
            JsonObject sl = new JsonObject();
            sl.addProperty("index", i);
            sl.add("item", inv[i] != null ? inv[i] : JsonNull.INSTANCE);
            slots.add(sl);
        }
        o.add("slots", slots);
        o.add("cursor", cursor != null ? cursor : JsonNull.INSTANCE);
        o.addProperty("revision", revision);
        return o;
    }

    /** 契约 Window（dense slots，0..size+35） */
    public static JsonObject denseView(String id, String type, int size,
                                       java.util.Map<Integer, JsonObject> slots,
                                       JsonObject cursor, int revision) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("type", type);
        o.addProperty("title", "");
        o.addProperty("size", size);
        JsonArray arr = new JsonArray();
        for (int i = 0; i < size + 36; i++) {
            JsonObject sl = new JsonObject();
            sl.addProperty("index", i);
            sl.add("item", slots.get(i) != null ? slots.get(i) : JsonNull.INSTANCE);
            arr.add(sl);
        }
        o.add("slots", arr);
        o.add("cursor", cursor != null ? cursor : JsonNull.INSTANCE);
        o.addProperty("revision", revision);
        return o;
    }
}
