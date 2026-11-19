package com.botscript.mod.runtime;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.component.DataComponentTypes;

import net.minecraft.component.type.AttributeModifiersComponent;
import net.minecraft.entity.attribute.EntityAttributeModifier;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;

import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * ItemStack 组件真值 + 注册表数据（ABI v2）。
 *
 * v2：不再按 item id 猜堆叠/攻击；进入本类的 ItemStack 直接读组件：
 *   getMaxCount（max_stack_size）、getMaxDamage（max_damage）、getDamage、getComponents、
 *   ATTRIBUTE_MODIFIERS（attack_damage / attack_speed / armor…）。
 */
public final class DataRegistry {

    private static final JsonObject CONTAINERS = loadJson("/botscript-data/containers.json");
    private static final Set<String> CONTAINER_PATHS = parseContainers();

    private DataRegistry() {}

    public static boolean registryAvailable() { return true; }

    /** 真实 ItemStack → 契约 StackInfo（组件/属性真值） */
    public static JsonObject stackOf(ItemStack stack) {
        if (stack == null || stack.isEmpty()) return null;
        JsonObject o = new JsonObject();
        o.addProperty("id", Registries.ITEM.getId(stack.getItem()).toString());
        o.addProperty("count", stack.getCount());
        o.addProperty("max_count", stack.getMaxCount());
        o.addProperty("max_damage", stack.isDamageable() ? stack.getMaxDamage() : null);
        o.addProperty("damage", stack.isDamageable() ? stack.getDamage() : null);

        JsonObject components = new JsonObject();
        for (net.minecraft.component.ComponentType<?> type : stack.getComponents().getTypes()) {
            Identifier key = Registries.DATA_COMPONENT_TYPE.getId(type);
            Object value = ((ItemStack) stack).get((net.minecraft.component.ComponentType) type);
            if (key != null) components.addProperty(key.toString(), String.valueOf(value));
        }
        o.add("components", components.size() > 0 ? components : JsonNull.INSTANCE);

        JsonObject attrs = attributeModifiers(stack);
        o.add("attributes", attrs != null ? attrs : JsonNull.INSTANCE);

        var ench = stack.get(DataComponentTypes.ENCHANTMENTS);
        if (ench != null) o.addProperty("enchantments", String.valueOf(ench));
        else o.add("enchantments", JsonNull.INSTANCE);
        var name = stack.get(DataComponentTypes.CUSTOM_NAME);
        if (name != null) o.addProperty("custom_name", String.valueOf(name));
        else o.add("custom_name", JsonNull.INSTANCE);
        return o;
    }

    /** 读主手属性组件（1.20.5+ 的 attribute_modifiers） */
    private static JsonObject attributeModifiers(ItemStack stack) {
        try {
            AttributeModifiersComponent am = stack.get(DataComponentTypes.ATTRIBUTE_MODIFIERS);
            if (am == null) return null;
            JsonObject out = new JsonObject();
            for (AttributeModifiersComponent.Entry e : am.modifiers()) {
                Identifier id = Registries.ATTRIBUTE.getId(e.attribute().value());
                if (id == null) continue;
                String name = id.getPath();
                double amount = e.modifier().value();
                switch (name) {
                    case "attack_damage", "attack_speed", "armor", "armor_toughness",
                            "max_health", "movement_speed", "knockback_resistance" -> out.addProperty(name, amount);
                    default -> { }
                }
            }
            return out.size() > 0 ? out : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** item.stack({id,...})：没有真实 ItemStack 引用时按注册表默认组件构造 */
    public static JsonObject stack(JsonObject in) {
        JsonObject o = in == null ? new JsonObject() : in;
        String id = o.has("id") ? o.get("id").getAsString() : null;
        Identifier ident = Identifier.tryParse(id == null ? "" : id);
        if (ident == null) {
            JsonObject empty = new JsonObject();
            empty.addProperty("id", id);
            empty.addProperty("count", 0);
            return empty;
        }
        Item item = Registries.ITEM.get(ident);
        int count = o.has("count") ? o.get("count").getAsInt() : 1;
        ItemStack stack = new ItemStack(item, Math.max(1, count));
        if (o.has("damage") && stack.isDamageable()) {
            try { stack.setDamage(o.get("damage").getAsInt()); } catch (Exception ignored) { }
        }
        JsonObject out = stackOf(stack);
        if (out == null) {
            JsonObject empty = new JsonObject();
            empty.addProperty("id", id);
            empty.addProperty("count", count);
            return empty;
        }
        // 调用方显式给 components 时透传（真实组件无法从 JSON 反构造）
        if (o.has("components") && !o.get("components").isJsonNull()) out.add("components", o.get("components"));
        return out;
    }

    public static boolean isContainerName(String namespaced) {
        String n = namespaced == null ? "" : namespaced.replace("minecraft:", "");
        return CONTAINER_PATHS.contains(n);
    }

    public static Set<String> containerPaths() { return CONTAINER_PATHS; }

    private static JsonObject loadJson(String path) {
        try (var in = DataRegistry.class.getResourceAsStream(path)) {
            if (in == null) return new JsonObject();
            return JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (Exception e) {
            return new JsonObject();
        }
    }

    private static Set<String> parseContainers() {
        try {
            if (!CONTAINERS.has("paths")) return Set.of();
            Set<String> out = new java.util.HashSet<>();
            for (var e : CONTAINERS.getAsJsonArray("paths")) out.add(e.getAsString());
            return Set.copyOf(out);
        } catch (Exception e) {
            return Set.of();
        }
    }
}
