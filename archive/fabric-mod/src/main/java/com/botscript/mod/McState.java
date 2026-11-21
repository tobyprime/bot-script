package com.botscript.mod;

import com.botscript.mod.runtime.DataRegistry;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;
import net.minecraft.screen.ScreenHandler;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 客户端事件 → 契约模型（self / entities / windows / session），唯一归一化实现。
 *
 * 槽位布局常量（36/45/玩家区）只允许出现在本类与驱动适配层；
 * 出口一律是 contracts/host-abi.yaml 的 Window/Entity/Self 形状。
 */
public final class McState implements com.botscript.mod.runtime.LuaRuntime.Tickable {

    public interface EventSink { void event(String kind, String payloadJson); }

    private static final class WindowSnapshot {
        String id;
        String type;
        int size;
        int revision = 0;
        int stateId = -1;
        Map<Integer, JsonObject> slots = new HashMap<>();   // 引擎空间 index -> item
        JsonObject cursor;
        String sig = "";
    }

    private final MinecraftClient mc;
    private final EventSink events;

    private final Map<String, WindowSnapshot> windows = new HashMap<>();
    private String currentWindowId;   // null = 未开容器（背包 '0' 永远可用）

    private final Map<String, JsonObject> entities = new LinkedHashMap<>();
    private final Set<String> knownEntities = new HashSet<>();

    private int tickCounter = 0;
    private float lastHealth = -1;
    private boolean wasDead = false;

    public McState(MinecraftClient mc, EventSink events) {
        this.mc = mc;
        this.events = events;
    }

    // ================= 每 tick 驱动 =================

    public void tick() {
        tickCounter++;
        trackWindow();
        if (tickCounter % 2 == 0) trackEntities();   // 10Hz
        checkDamage();
        checkDeath();
    }

    /** 死亡/重生事件（自动重生是会话生命周期行为，不进 pause 冻结域） */
    private long respawnAt = 0;

    private void checkDeath() {
        ClientPlayerEntity p = player();
        if (p == null) return;
        long now = System.currentTimeMillis();
        if (!p.isAlive() && !wasDead) {
            wasDead = true;
            respawnAt = now + 1200;   // 与 Node 宿主一致的延迟重生语义
            events.event("self.died", "{}");
        } else if (p.isAlive() && wasDead) {
            wasDead = false;
            respawnAt = 0;
            events.event("self.respawned", "{}");
        }
        if (respawnAt > 0 && now >= respawnAt) {
            respawnAt = 0;
            if (!p.isAlive() && mc.getNetworkHandler() != null) {
                mc.getNetworkHandler().sendPacket(new net.minecraft.network.packet.c2s.play.ClientStatusC2SPacket(
                        net.minecraft.network.packet.c2s.play.ClientStatusC2SPacket.Mode.PERFORM_RESPAWN));
            }
        }
    }

    private ClientPlayerEntity player() { return mc.player; }

    // ================= 窗口 =================

    private void trackWindow() {
        ClientPlayerEntity p = player();
        if (p == null) return;
        ScreenHandler handler = p.currentScreenHandler;
        if (handler == null) return;

        // 容器窗口：Paper 在点击后会重发 OpenScreen 递增 syncId（3→4...），
        // 故以"首个打开时的 syncId"为逻辑窗口 id（保持稳定），syncId==0 视为关闭。
        int syncId = handler.syncId;
        if (syncId == 0) {
            if (currentWindowId != null) {
                windows.remove(currentWindowId);
                events.event("container.closed", "{\"id\":\"" + currentWindowId + "\"}");
                currentWindowId = null;
            }
        } else {
            if (currentWindowId == null) currentWindowId = String.valueOf(syncId);
            refreshContainer(currentWindowId, handler);
        }
        refreshInventory(p);
    }

    private void refreshContainer(String id, ScreenHandler handler) {
        WindowSnapshot w = windows.computeIfAbsent(id, k -> {
            WindowSnapshot nw = new WindowSnapshot();
            nw.id = id;
            nw.type = "chest";
            nw.size = Math.max(0, handler.getStacks().size() - 36);
            return nw;
        });
        Map<Integer, JsonObject> slots = new HashMap<>();
        var stacks = handler.getStacks();
        for (int i = 0; i < stacks.size(); i++) {
            JsonObject item = itemJson(stacks.get(i));
            if (item != null) slots.put(i, item);
        }
        JsonObject cursorJson = itemJson(handler.getCursorStack());
        String sig = slots + "|" + cursorJson;
        w.slots = slots;
        w.cursor = cursorJson;
        try { w.stateId = handler.getRevision(); } catch (Exception ignored) { }
        if (!sig.equals(w.sig)) {
            w.sig = sig;
            w.revision++;
        }
    }

    private void refreshInventory(ClientPlayerEntity p) {
        WindowSnapshot w = windows.computeIfAbsent("0", k -> {
            WindowSnapshot nw = new WindowSnapshot();
            nw.id = "0";
            nw.type = "inventory";
            nw.size = 36;
            return nw;
        });
        Map<Integer, JsonObject> slots = new HashMap<>();
        var inv = p.getInventory();
        // 引擎布局 0-8 = hotbar；9-35 = 主背包。玩家 Inventory：0-8 hotbar，9-35 main
        for (int e = 0; e < 36; e++) {
            JsonObject item = itemJson(inv.getStack(e));
            if (item != null) slots.put(e, item);
        }
        String sig = slots.toString();
        w.slots = slots;
        w.cursor = null;
        if (!sig.equals(w.sig)) {
            w.sig = sig;
            w.revision++;
        }
    }

    public String currentWindowId() { return currentWindowId; }

    public int revision(String winId) {
        WindowSnapshot w = windows.get(winId);
        return w == null ? 0 : w.revision;
    }

    /** 契约 Window（dense slots）：容器打开时 '0' = 玩家区合并视图 */
    public JsonObject windowView(String id) {
        String sid = String.valueOf(id == null ? "0" : id);
        if ("0".equals(sid)) {
            WindowSnapshot cont = currentWindowId != null ? windows.get(currentWindowId) : null;
            if (cont != null) return mergedInventory(cont);
            WindowSnapshot w = windows.get("0");
            return w == null ? null : denseView(w);
        }
        WindowSnapshot w = windows.get(sid);
        return w == null ? null : denseView(w);
    }

    private JsonObject denseView(WindowSnapshot w) {
        JsonObject o = com.botscript.mod.runtime.WindowLayout.denseView(w.id, w.type, w.size, w.slots, w.cursor, w.revision);
        if (w.stateId >= 0) o.addProperty("state_id", w.stateId);
        else o.add("state_id", com.google.gson.JsonNull.INSTANCE);
        return o;
    }

    private JsonObject mergedInventory(WindowSnapshot cont) {
        JsonObject o = com.botscript.mod.runtime.WindowLayout.mergedInventory(cont.size, cont.slots, cont.cursor, cont.revision);
        if (cont.stateId >= 0) o.addProperty("state_id", cont.stateId);
        else o.add("state_id", com.google.gson.JsonNull.INSTANCE);
        return o;
    }

    private int playerZoneToInventory(int size, int idx) {
        return com.botscript.mod.runtime.WindowLayout.playerZoneToInventory(size, idx);
    }

    public int inventoryToPlayerZone(int size, int invSlot) {
        return com.botscript.mod.runtime.WindowLayout.inventoryToPlayerZone(size, invSlot);
    }

    /** act.window_click 的槽位归一：window='0' 且容器打开时，落到容器窗口的玩家区 */
    public record ClickTarget(String window, int slot) {}

    public ClickTarget clickTarget(String windowId, int slot) {
        String wid = windowId == null ? "0" : windowId;
        if (!"0".equals(wid) || currentWindowId == null) return new ClickTarget(wid, slot);
        WindowSnapshot cont = windows.get(currentWindowId);
        if (cont == null) return new ClickTarget(wid, slot);
        return new ClickTarget(cont.id, inventoryToPlayerZone(cont.size, slot));
    }

    // ================= 实体 =================

    private void trackEntities() {
        ClientPlayerEntity p = player();
        if (p == null || mc.world == null) return;
        Map<String, JsonObject> fresh = new LinkedHashMap<>();
        for (Entity e : mc.world.getEntities()) {
            if (e == p || e.isRemoved()) continue;
            fresh.put(String.valueOf(e.getId()), entityJsonOf(e));
        }
        entities.clear();
        entities.putAll(fresh);
        for (String id : fresh.keySet()) {
            if (!knownEntities.contains(id)) {
                knownEntities.add(id);
                events.event("entity.appeared", "{\"id\":\"" + id + "\"}");
            }
        }
        for (String id : new HashSet<>(knownEntities)) {
            if (!fresh.containsKey(id)) {
                knownEntities.remove(id);
                events.event("entity.gone", "{\"id\":\"" + id + "\"}");
            }
        }
    }

    private static JsonObject entityJsonOf(Entity e) {
        JsonObject o = new JsonObject();
        o.addProperty("id", String.valueOf(e.getId()));
        o.addProperty("uuid", e.getUuidAsString());
        String typeId = Registries.ENTITY_TYPE.getId(e.getType()).toString();
        boolean isPlayer = typeId.equals("minecraft:player");
        o.addProperty("type", typeId);
        o.addProperty("name", isPlayer && e instanceof net.minecraft.client.network.AbstractClientPlayerEntity ap
                ? ap.getGameProfile().getName() : null);
        JsonObject pos = new JsonObject();
        pos.addProperty("x", e.getX());
        pos.addProperty("y", e.getY());
        pos.addProperty("z", e.getZ());
        o.add("pos", pos);
        JsonObject vel = new JsonObject();
        vel.addProperty("x", e.getVelocity().x);
        vel.addProperty("y", e.getVelocity().y);
        vel.addProperty("z", e.getVelocity().z);
        o.add("velocity", vel);
        o.addProperty("yaw", e.getYaw());
        o.addProperty("pitch", e.getPitch());
        o.addProperty("alive", e.isAlive());
        o.addProperty("pose", e.getPose().name().toLowerCase(java.util.Locale.ROOT));
        o.addProperty("vehicle_id", e.getVehicle() != null ? String.valueOf(e.getVehicle().getId()) : null);
        o.addProperty("health", e instanceof LivingEntity le && !isPlayer ? le.getHealth() : null);
        o.add("effects", e instanceof LivingEntity le ? effectsJson(le.getStatusEffects()) : new JsonArray());
        JsonObject flags = new JsonObject();
        flags.addProperty("on_fire", e.isOnFire());
        flags.addProperty("sneaking", e.isSneaking());
        flags.addProperty("sprinting", e.isSprinting());
        flags.addProperty("invisible", e.isInvisible());
        flags.addProperty("glowing", e.isGlowing());
        o.add("flags", flags);
        JsonObject eq = new JsonObject();
        if (e instanceof LivingEntity le) {
            eq.add("hand", orNull(itemJson(le.getMainHandStack())));
            eq.add("offhand", orNull(itemJson(le.getEquippedStack(EquipmentSlot.OFFHAND))));
            eq.add("boots", orNull(itemJson(le.getEquippedStack(EquipmentSlot.FEET))));
            eq.add("leggings", orNull(itemJson(le.getEquippedStack(EquipmentSlot.LEGS))));
            eq.add("chestplate", orNull(itemJson(le.getEquippedStack(EquipmentSlot.CHEST))));
            eq.add("helmet", orNull(itemJson(le.getEquippedStack(EquipmentSlot.HEAD))));
        }
        o.add("equipment", eq);
        return o;
    }

    public JsonObject entityJson(String id) { return entities.get(id); }

    public JsonArray entitiesJson() {
        JsonArray list = new JsonArray();
        entities.values().forEach(list::add);
        return list;
    }

    // ================= self / env / damage =================

    public JsonObject selfJson() {
        ClientPlayerEntity p = player();
        if (p == null) return null;
        JsonObject o = new JsonObject();
        o.addProperty("username", p.getGameProfile().getName());
        JsonObject pos = new JsonObject();
        pos.addProperty("x", p.getX());
        pos.addProperty("y", p.getY());
        pos.addProperty("z", p.getZ());
        o.add("pos", pos);
        JsonObject vel = new JsonObject();
        vel.addProperty("x", p.getVelocity().x);
        vel.addProperty("y", p.getVelocity().y);
        vel.addProperty("z", p.getVelocity().z);
        o.add("velocity", vel);
        o.addProperty("yaw", p.getYaw());
        o.addProperty("pitch", p.getPitch());
        o.addProperty("health", p.getHealth());
        o.addProperty("food", p.getHungerManager().getFoodLevel());
        o.addProperty("gamemode", mc.interactionManager.getCurrentGameMode().asString());
        o.add("held", orNull(itemJson(p.getMainHandStack())));
        o.addProperty("held_slot", p.getInventory().getSelectedSlot());
        o.addProperty("pose", p.getPose().name().toLowerCase(java.util.Locale.ROOT));
        o.addProperty("on_fire", p.isOnFire());
        o.addProperty("sneaking", p.isSneaking());
        o.addProperty("sprinting", p.isSprinting());
        o.add("effects", effectsJson(p.getStatusEffects()));
        JsonObject attrs = new JsonObject();
        attrs.addProperty("armor", p.getArmor());
        attrs.addProperty("absorption", p.getAbsorptionAmount());
        attrs.addProperty("xp_level", p.experienceLevel);
        attrs.addProperty("xp_progress", p.experienceProgress);
        o.add("attributes", attrs);
        return o;
    }

    private static JsonArray effectsJson(java.util.Collection<net.minecraft.entity.effect.StatusEffectInstance> effects) {
        JsonArray arr = new JsonArray();
        for (var e : effects) {
            JsonObject o = new JsonObject();
            Identifier id = Registries.STATUS_EFFECT.getId(e.getEffectType().value());
            if (id != null) o.addProperty("id", id.toString());
            else o.add("id", com.google.gson.JsonNull.INSTANCE);
            o.addProperty("amplifier", e.getAmplifier());
            o.addProperty("duration", e.getDuration());
            arr.add(o);
        }
        return arr;
    }

    private void checkDamage() {
        ClientPlayerEntity p = player();
        if (p == null) return;
        float h = p.getHealth();
        if (lastHealth >= 0 && h < lastHealth) {
            JsonObject d = new JsonObject();
            d.addProperty("amount", lastHealth - h);
            d.addProperty("health", h);
            events.event("self.damaged", d.toString());
        }
        lastHealth = h;
    }

    public JsonObject worldEnv() {
        JsonObject o = new JsonObject();
        var w = mc.world;
        o.addProperty("dimension", w != null ? w.getRegistryKey().getValue().toString() : null);
        o.addProperty("version", mc.getCurrentServerEntry() != null && mc.getCurrentServerEntry().version != null
                ? mc.getCurrentServerEntry().version.getString() : "1.21.8");
        return o;
    }

    public JsonObject sessionJson() {
        JsonObject info = worldEnv();
        JsonObject o = new JsonObject();
        o.addProperty("state", player() != null ? "playing" : "idle");
        o.add("info", info);
        return o;
    }

    // ================= 小工具 =================

    public static JsonObject itemJson(ItemStack stack) {
        if (stack == null || stack.isEmpty()) return null;
        return DataRegistry.stackOf(stack);   // 组件/属性真值
    }

    private static com.google.gson.JsonElement orNull(JsonObject o) {
        return o != null ? o : JsonNull.INSTANCE;
    }

    public static boolean isContainer(String namespaced) { return DataRegistry.isContainerName(namespaced); }
}
