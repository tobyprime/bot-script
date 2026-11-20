package com.botscript.mod.runtime;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 策略层（ABI v2）：没有命令体系；gate 覆盖协议动作；容器/聊天/战斗/挖掘/放置/移动。
 * 默认开放：boundary / 字段缺省 = 不限制；显式配置才收紧。
 * 与 Node 宿主（hosts/node/policy.js）同规则，由 contracts/vectors/policy/*.json 保证同判。
 */
public final class Policy {

    public interface EntityLookup { JsonObject get(String id); }
    public interface SelfPos { double[] get(); }
    public interface ContainerOpen { boolean get(); }

    private final BotConfig cfg;
    private final EntityLookup entities;
    private final SelfPos selfPos;
    private final ContainerOpen containerOpen;
    private final java.util.Deque<Long> chatTokens = new java.util.ArrayDeque<>();
    private final java.util.Deque<Long> actionStamps = new java.util.ArrayDeque<>();
    private int budgetCount = 0;

    public Policy(BotConfig cfg, EntityLookup entities, SelfPos selfPos, ContainerOpen containerOpen) {
        this.cfg = cfg;
        this.entities = entities;
        this.selfPos = selfPos;
        this.containerOpen = containerOpen;
    }

    // ---- 只读配置给脚本 ----
    public JsonObject chatConfig() {
        JsonObject o = new JsonObject();
        if (cfg.msgCommand == null) o.add("msg_command", JsonNull.INSTANCE);
        else o.addProperty("msg_command", cfg.msgCommand);
        return o;
    }

    // ---- 预算 / 速率 ----
    public boolean countAction() {
        budgetCount++;
        return cfg.budgetActionsPerHour != null && budgetCount == cfg.budgetActionsPerHour;
    }

    public String rateCheck() {
        if (cfg.rateActionsPerSec == null || cfg.rateActionsPerSec <= 0) return null;
        long now = System.currentTimeMillis();
        while (!actionStamps.isEmpty() && now - actionStamps.peekFirst() >= 1000) actionStamps.pollFirst();
        if (actionStamps.size() >= cfg.rateActionsPerSec) {
            return LuaRuntime.errJson("permission.denied", "发包速率超限（" + fmt(cfg.rateActionsPerSec) + "/s）");
        }
        actionStamps.addLast(now);
        return null;
    }

    // ---- 动作门控（缺省 = 允许） ----
    public String check(String op, JsonObject args) {
        if ("act.chat_send".equals(op)) {
            String kind = args.has("kind") && !args.get("kind").isJsonNull() ? args.get("kind").getAsString() : "chat";
            return checkChat(kind, args.has("text") ? args.get("text").getAsString() : "");
        }
        if ("act.input".equals(op)) {
            double fwd = args.has("forward") ? args.get("forward").getAsDouble() : 0;
            double right = args.has("right") ? args.get("right").getAsDouble() : 0;
            double up = args.has("up") ? args.get("up").getAsDouble() : 0;
            boolean sprint = args.has("sprint") && args.get("sprint").isJsonPrimitive() && args.get("sprint").getAsBoolean();
            boolean sneak = args.has("sneak") && args.get("sneak").isJsonPrimitive() && args.get("sneak").getAsBoolean();
            boolean zero = fwd == 0 && right == 0 && up == 0 && !sprint && !sneak;
            if (zero) return null;
            if (cfg.allowMove != null && !cfg.allowMove) {
                return LuaRuntime.errJson("policy.blocklist", "移动未授权（boundary.allow_move=false）");
            }
            return null;
        }
        if ("act.path_to".equals(op)) {
            if (cfg.allowMove != null && !cfg.allowMove) {
                return LuaRuntime.errJson("policy.blocklist", "移动未授权（boundary.allow_move=false）");
            }
            JsonObject t = args.has("target") && args.get("target").isJsonObject() ? args.getAsJsonObject("target") : null;
            if (t != null && t.has("x") && !cfg.inFence(t.get("x").getAsDouble(), t.get("z").getAsDouble())) {
                return LuaRuntime.errJson("permission.denied", "目标 " + t + " 在围栏外");
            }
            return null;
        }
        if ("act.dig".equals(op)) {
            return denied(cfg.blocksDig) ? LuaRuntime.errJson("policy.blocklist", "dig 未授权（boundary.blocks.dig）") : null;
        }
        if ("act.use_block".equals(op)) {
            String intent = args.has("intent") && !args.get("intent").isJsonNull() ? args.get("intent").getAsString() : "use";
            if ("place".equals(intent) && denied(cfg.blocksPlace)) {
                return LuaRuntime.errJson("policy.blocklist", "place 未授权（boundary.blocks.place）");
            }
            return null;
        }
        if ("act.use_entity".equals(op)) {
            String kind = args.has("kind") && !args.get("kind").isJsonNull() ? args.get("kind").getAsString() : "attack";
            if (!"attack".equals(kind)) return null;
            if (cfg.combatTargets == null) return null;   // 未配置 targets = 不限制目标
            String id = args.has("id") ? args.get("id").getAsString() : "";
            JsonObject e = entities.get(id);
            if (e == null) return LuaRuntime.errJson("entity.gone", id);
            String type = e.has("type") ? e.get("type").getAsString() : "";
            if (!type.contains(cfg.combatTargets)) {
                return LuaRuntime.errJson("policy.blocklist", "combat.targets=" + cfg.combatTargets + " 不含 " + type);
            }
            if (cfg.combatMaxEngage != null && e.has("pos")) {
                double[] sp = selfPos.get();
                if (sp != null) {
                    JsonObject p = e.getAsJsonObject("pos");
                    double d = dist(sp[0], sp[1], sp[2], p.get("x").getAsDouble(),
                            p.get("y").getAsDouble(), p.get("z").getAsDouble());
                    if (d > cfg.combatMaxEngage) {
                        return LuaRuntime.errJson("policy.blocklist",
                                String.format("超过接战距离 %.1f > %s", d, fmt(cfg.combatMaxEngage)));
                    }
                }
            }
            return null;
        }
        if ("act.window_open".equals(op) || "act.window_click".equals(op) || "act.window_close".equals(op)) {
            boolean touch = "act.window_open".equals(op)
                    || (args.has("window") && !"0".equals(args.get("window").getAsString()))
                    || containerOpen.get();
            if (touch && denied(cfg.containers)) {
                return LuaRuntime.errJson("policy.blocklist", "容器访问未授权（boundary.containers）");
            }
            return null;
        }
        return null;
    }

    // ---- chat 策略：command 走白名单/正则；chat/reply 走 say 限速（缺省不限） ----
    public String checkChat(String kind, String text) {
        if ("command".equals(kind)) {
            String full = text.startsWith("/") ? text : "/" + text;
            if (!cfg.chatCommandsWhitelist.isEmpty()) {
                String first = full.substring(1).split("\\s+")[0];
                String ns = first.contains(":") ? first.substring(first.indexOf(':') + 1) : first;
                boolean ok = cfg.chatCommandsWhitelist.contains(first) || cfg.chatCommandsWhitelist.contains("/" + ns);
                if (!ok) return LuaRuntime.errJson("permission.denied", "命令白名单不含 /" + ns);
            }
            return checkRegex(full);
        }
        String rate = cfg.chatSayRate;
        if (rate == null || rate.isBlank()) return null;   // 未配置 = 不限
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d+)/(\\w+)$").matcher(rate);
        if (!m.matches()) return LuaRuntime.errJson("policy.config", "say_rate 格式无效（" + rate + "），应为 N/min 或 N/sec");
        int limit = Integer.parseInt(m.group(1));
        long windowMs = m.group(2).equals("min") ? 60_000 : 1000;
        long now = System.currentTimeMillis();
        chatTokens.removeIf((t) -> now - t >= windowMs);
        if (chatTokens.size() >= limit) {
            return LuaRuntime.errJson("permission.denied", "say 限速（" + rate + "）");
        }
        chatTokens.add(now);
        return null;
    }

    private String checkRegex(String text) {
        if (!cfg.chatCommandsDeny.isEmpty()) {
            Object hit = matchAny(cfg.chatCommandsDeny, text);
            if (hit == BAD) return LuaRuntime.errJson("permission.denied", "命令黑名单正则无效（instance boundary 配置错误）");
            if (hit == TRUE) return LuaRuntime.errJson("permission.denied", "命令命中黑名单（boundary.chat.commands_deny）");
        }
        if (!cfg.chatCommandsAllow.isEmpty()) {
            Object hit = matchAny(cfg.chatCommandsAllow, text);
            if (hit == BAD) return LuaRuntime.errJson("permission.denied", "命令白名单正则无效（instance boundary 配置错误）");
            if (hit != TRUE) return LuaRuntime.errJson("permission.denied", "命令未命中正则白名单（boundary.chat.commands_allow）");
        }
        return null;
    }

    private static final Object TRUE = Boolean.TRUE;
    private static final Object BAD = new Object();

    private static Object matchAny(List<String> pats, String text) {
        for (String p : pats) {
            try {
                if (java.util.regex.Pattern.compile(p).matcher(text).find()) return TRUE;
            } catch (Exception e) {
                return BAD;
            }
        }
        return Boolean.FALSE;
    }

    private static boolean denied(String v) {
        return v != null && ("deny".equals(v) || "false".equalsIgnoreCase(v));
    }

    private static String fmt(double d) {
        return d == Math.floor(d) ? String.valueOf((long) d) : String.valueOf(d);
    }

    public static double dist(double ax, double ay, double az, double bx, double by, double bz) {
        double dx = ax - bx, dy = ay - by, dz = az - bz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    public static String posKey(double x, double y, double z) {
        return Math.round(x) + "," + Math.round(y) + "," + Math.round(z);
    }
}
