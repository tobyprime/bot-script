package com.botscript.mod;

import com.botscript.mod.runtime.AbiDispatcher;
import com.botscript.mod.runtime.BotConfig;
import com.botscript.mod.runtime.DataRegistry;
import com.botscript.mod.runtime.LuaRuntime;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.state.property.Property;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * MC 动作原语（宿主唯一触碰 Yarn 映射的类之一）：
 *   chat / look / input / path_to / window_open / window_click / use_* / dig / drop / select_slot
 *
 * 编排（贴身/瞄准/重试/装备点击序列/导航退化）在 runtime/lua/core/bslib.lua；
 * 这里只保证「一次协议动作」的执行与确认（点击回包、窗口出现、走到位）。
 */
public final class McRuntime implements LuaRuntime.Tickable {
    private static final org.slf4j.Logger DBG = org.slf4j.LoggerFactory.getLogger("botscript-action");

    private final MinecraftClient mc;
    private final McState state;
    private final BotConfig cfg;
    private final LuaRuntime rt;

    private int tickCounter = 0;
    private int hopReleaseTick = -1;
    private GotoState gotoMachine;
    private OpenState openMachine;
    private ClickState clickMachine;

    public McRuntime(MinecraftClient mc, McState state, BotConfig cfg, LuaRuntime rt) {
        this.mc = mc;
        this.state = state;
        this.cfg = cfg;
        this.rt = rt;
    }

    private ClientPlayerEntity player() { return mc.player; }

    // ================= tick =================

    @Override
    public void tick() {
        tickCounter++;
        if (rt.abi() != null) rt.abi().tickSleepDeadlines();
        if (hopReleaseTick > 0 && tickCounter >= hopReleaseTick) {
            if (gotoMachine == null) mc.options.jumpKey.setPressed(false);
            hopReleaseTick = -1;
        }
        if (gotoMachine != null) gotoMachine.tick();
        if (openMachine != null) openMachine.tick();
        if (clickMachine != null) clickMachine.tick();
    }

    // ================= caps / 版本补丁 =================

    public JsonObject caps() {
        JsonObject o = new JsonObject();
        o.addProperty("nav.pathfinder", false);      // 无寻路器：核心走直线退化
        o.addProperty("item.components", true);      // 客户端注册表 ItemStack 组件
        o.addProperty("world.block_entity", true);   // 客户端方块实体
        o.addProperty("net.custom_payload", false);  // 动态通道的收发/注册尚未实现（见 AbiDispatcher）
        return o;
    }

    /** Fabric 侧无协议补丁（补丁登记表目前只有 Node 驱动需要）；/caps 仍给出形状 */
    public JsonArray patches() { return new JsonArray(); }

    // ================= 动作原语 =================

    public void chatSendRaw(String text, String kind) {
        ClientPlayerEntity p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        boolean command = "command".equals(kind) || text.startsWith("/");
        String body = command && text.startsWith("/") ? text.substring(1) : text;
        if (command) p.networkHandler.sendChatCommand(body);
        else p.networkHandler.sendChatMessage(body);
    }

    public String look(JsonObject a) {
        var p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        if (a.has("yaw") && !a.get("yaw").isJsonNull()) {
            p.setYaw((float) (((a.get("yaw").getAsDouble() % 360) + 540) % 360 - 180));
        }
        if (a.has("pitch") && !a.get("pitch").isJsonNull()) {
            p.setPitch((float) Math.max(-90, Math.min(90, a.get("pitch").getAsDouble())));
        }
        return "{}";
    }

    /** 原版 player_input 状态位（有符号轴向；0 = 停） */
    public String input(JsonObject a) {
        double fwd = a.has("forward") && !a.get("forward").isJsonNull() ? a.get("forward").getAsDouble() : 0;
        double right = a.has("right") && !a.get("right").isJsonNull() ? a.get("right").getAsDouble() : 0;
        boolean up = a.has("up") && !a.get("up").isJsonNull() && a.get("up").getAsDouble() > 0;
        boolean sprint = a.has("sprint") && a.get("sprint").isJsonPrimitive() && a.get("sprint").getAsBoolean();
        boolean sneak = a.has("sneak") && a.get("sneak").isJsonPrimitive() && a.get("sneak").getAsBoolean();
        moveInput(fwd > 0 ? 1 : (fwd < 0 ? -1 : 0),
                right > 0 ? 1 : (right < 0 ? -1 : 0),
                up ? 1 : 0, sneak ? 1 : 0, sprint ? 1 : 0);
        return "{}";
    }

    private String moveInput(int fwd, int strafe, int jump, int sneak, int sprint) {
        var opt = mc.options;
        opt.forwardKey.setPressed(fwd > 0);
        opt.backKey.setPressed(fwd < 0);
        opt.leftKey.setPressed(strafe < 0);
        opt.rightKey.setPressed(strafe > 0);
        opt.jumpKey.setPressed(jump != 0);
        opt.sneakKey.setPressed(sneak != 0);
        opt.sprintKey.setPressed(sprint != 0);
        return "{}";
    }

    private void stopMove() { moveInput(0, 0, 0, 0, 0); }

    // ---- path_to：宿主原语 = 直线走位（Fabric 无寻路器；与旧 GotoState 逐条对齐） ----

    public String pathTo(int token, JsonObject a) {
        JsonObject t = a.has("target") && a.get("target").isJsonObject() ? a.getAsJsonObject("target") : null;
        if (t == null || !t.has("x")) throw new LuaRuntime.AbiError("abi.invalid_args", "path_to 缺少 target");
        double arrive = a.has("arrive") ? a.get("arrive").getAsDouble() : 1.5;
        long timeoutMs = a.has("timeout_ms") ? a.get("timeout_ms").getAsLong() : 30_000;
        double[] target = new double[]{t.get("x").getAsDouble(), t.get("y").getAsDouble(), t.get("z").getAsDouble()};
        if (gotoMachine != null) gotoMachine.stop("cancel");
        gotoMachine = new GotoState(token, target, arrive, timeoutMs, true);
        return null;   // 自管结算
    }

    public String pathCancel() {
        if (gotoMachine != null) gotoMachine.stop("cancel");
        stopMove();
        return "{}";
    }

    private final class GotoState implements LuaRuntime.Tickable {
        final int token;
        final double[] target;
        final double arrive;
        final long deadline;
        final boolean emitFail;
        double[] last;
        long lastProgress;
        boolean stopped;
        int phase = 0;
        long jumpUntil;

        GotoState(int token, double[] target, double arrive, long timeoutMs, boolean emitFail) {
            this.token = token;
            this.target = target;
            this.arrive = arrive;
            this.deadline = System.currentTimeMillis() + timeoutMs;
            this.emitFail = emitFail;
            double[] p = selfPos();
            this.last = p != null ? p : target;
            this.lastProgress = System.currentTimeMillis();
        }

        @Override public void tick() {
            if (stopped || tickCounter % 2 != 0) return;   // 100ms 步进
            if (rt.isPaused()) { stop("paused"); return; }
            double[] p = selfPos();
            if (p == null) return;
            double d = dist2d(p[0], p[2], target[0], target[2]);
            if (d <= arrive) { stop("ok"); return; }
            long now = System.currentTimeMillis();
            if (now > deadline) { stop("timeout"); return; }
            if (dist3(p[0], p[1], p[2], last[0], last[1], last[2]) < 0.15) {
                if (now - lastProgress > 6000) { stop("stuck"); return; }
                if (phase == 0) {
                    moveInput(1, 0, 1, 0, 0);
                    jumpUntil = now + 250;
                    phase = 1;
                } else if (now > jumpUntil) {
                    moveInput(1, 0, 0, 0, 0);
                    phase = 0;
                }
            } else {
                last = p;
                lastProgress = now;
                phase = 0;
            }
            rotTo(yawTo(p[0], p[2], target[0], target[2]), 0);
            moveInput(1, 0, phase, 0, 0);
        }

        void stop(String how) {
            if (stopped) return;
            stopped = true;
            stopMove();
            if (gotoMachine == this) gotoMachine = null;
            JsonObject r = new JsonObject();
            if ("ok".equals(how)) {
                r.addProperty("ok", true);
            } else {
                r.addProperty("ok", false);
                r.addProperty("reason", "cancel".equals(how) ? "interrupted" : how);
            }
            rt.settle(token, r.toString(), "");
        }
    }

    private double[] selfPos() {
        ClientPlayerEntity p = player();
        return p == null ? null : new double[]{p.getX(), p.getY(), p.getZ()};
    }

    private static double dist2d(double ax, double az, double bx, double bz) {
        double dx = ax - bx, dz = az - bz;
        return Math.sqrt(dx * dx + dz * dz);
    }

    private static double dist3(double ax, double ay, double az, double bx, double by, double bz) {
        double dx = ax - bx, dy = ay - by, dz = az - bz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private void rotTo(double yaw, double pitch) {
        var p = player();
        if (p == null) return;
        p.setYaw((float) (((yaw % 360) + 540) % 360 - 180));
        p.setPitch((float) Math.max(-90, Math.min(90, pitch)));
    }

    private static double yawTo(double fromX, double fromZ, double toX, double toZ) {
        return Math.toDegrees(Math.atan2(-(toX - fromX), toZ - fromZ));
    }

    // ---- window_open：交互一次 + 等窗口出现（瞄准/贴身/重试由核心编排） ----

    public String windowOpen(int token, JsonObject a) {
        JsonObject t = a.has("target") && a.get("target").isJsonObject() ? a.getAsJsonObject("target") : null;
        if (t == null) throw new LuaRuntime.AbiError("container.missing", "target 为空");
        if (state.currentWindowId() != null) closeCurrentWindow();
        if (openMachine != null) openMachine.fail("container.missing");
        if (t.has("entity")) {
            Entity e = findEntity(String.valueOf(t.get("entity").isJsonPrimitive()
                    ? t.get("entity").getAsString() : t.get("entity").getAsJsonObject().get("id").getAsString()));
            if (e == null) throw new LuaRuntime.AbiError("entity.gone", String.valueOf(t.get("entity")));
            mc.interactionManager.interactEntity(player(), e, Hand.MAIN_HAND);
        } else {
            BlockPos pos = BlockPos.ofFloored(t.get("x").getAsDouble(), t.get("y").getAsDouble(), t.get("z").getAsDouble());
            BlockHitResult hit = new BlockHitResult(Vec3d.ofCenter(pos), Direction.UP, pos, false);
            ClientPlayerEntity p = player();
            boolean sneak = p.isSneaking();
            p.setSneaking(false);
            mc.interactionManager.interactBlock(p, Hand.MAIN_HAND, hit);
            p.setSneaking(sneak);
        }
        openMachine = new OpenState(token, System.currentTimeMillis() + 6000);
        return null;
    }

    private final class OpenState implements LuaRuntime.Tickable {
        final int token;
        final long deadline;

        OpenState(int token, long deadline) { this.token = token; this.deadline = deadline; }

        @Override public void tick() {
            if (openMachine != this) return;
            String id = state.currentWindowId();
            if (id != null) {
                openMachine = null;
                JsonObject r = new JsonObject();
                r.addProperty("id", id);
                rt.settle(token, r.toString(), "");
                return;
            }
            if (System.currentTimeMillis() > deadline) fail("container.missing");
        }

        void fail(String kind) {
            if (openMachine != this) return;
            openMachine = null;
            rt.settle(token, "", LuaRuntime.errJson(kind, "窗口未出现"));
        }
    }

    public String windowClick(int token, JsonObject a) {
        String winId = a.has("window") && !a.get("window").isJsonNull() ? a.get("window").getAsString() : "0";
        int slot = a.get("slot").getAsInt();
        int button = a.has("button") ? a.get("button").getAsInt() : 0;
        int mode = a.has("mode") ? a.get("mode").getAsInt() : 0;
        McState.ClickTarget target = state.clickTarget(winId, slot);
        if (clickMachine != null) clickMachine.fail("container.closed");
        clickMachine = new ClickState(token, target.window(), target.slot(), button, mode);
        return null;
    }

    /**
     * 点击确认：clickSlot + 槽位内容签名确认（跨 tick 重试，替代旧实现里的 Thread.sleep）。
     * mode 对齐 vanilla ClickType：0 pickup / 1 quick_move / 2 swap / 4 throw / 6 pickup_all。
     */
    private final class ClickState implements LuaRuntime.Tickable {
        final int token;
        final String handlerId;
        final int engineSlot;
        final int button;
        final int mode;
        int attempts = 0;
        int settleTicks = 0;
        String lastSig = null;

        ClickState(int token, String handlerId, int engineSlot, int button, int mode) {
            this.token = token;
            this.handlerId = handlerId;
            this.engineSlot = engineSlot;
            this.button = button;
            this.mode = mode;
        }

        @Override public void tick() {
            ClientPlayerEntity p = player();
            if (p == null) { fail("container.closed"); return; }
            ScreenHandler handler = resolveHandler(handlerId);
            if (handler == null) { fail("container.closed"); return; }
            int rawSlot = toRawSlot(handlerId, engineSlot, handler);
            if (rawSlot < 0 || rawSlot >= handler.getStacks().size()) { fail("container.closed"); return; }

            if (settleTicks > 0) {
                settleTicks--;
                if (settleTicks == 0) {
                    String sig = slotSig(handler, rawSlot);
                    if (!sig.equals(lastSig)) { done(); return; }
                    if (++attempts > 4) { done(); return; }   // 有的点击本就不改变内容，放行
                    sendClick(handler, rawSlot);
                    settleTicks = 2;
                }
                return;
            }
            lastSig = slotSig(handler, rawSlot);
            sendClick(handler, rawSlot);
            settleTicks = 2;
        }

        private void done() {
            if (clickMachine != this) return;
            clickMachine = null;
            rt.settle(token, "{}", "");
        }

        private void fail(String kind) {
            if (clickMachine != this) return;
            clickMachine = null;
            rt.settle(token, "", LuaRuntime.errJson(kind, handlerId));
        }
    }

    private void sendClick(ScreenHandler handler, int rawSlot) {
        ClientPlayerEntity p = player();
        if (p == null) return;
        SlotActionType type = switch (modeOf(clickMachine)) {
            case 1 -> SlotActionType.QUICK_MOVE;
            case 2 -> SlotActionType.SWAP;
            case 3 -> SlotActionType.CLONE;
            case 4 -> SlotActionType.THROW;
            case 5 -> SlotActionType.QUICK_CRAFT;
            case 6 -> SlotActionType.PICKUP_ALL;
            default -> SlotActionType.PICKUP;
        };
        mc.interactionManager.clickSlot(handler.syncId, rawSlot, buttonOf(clickMachine), type, p);
    }

    private static int modeOf(ClickState c) { return c == null ? 0 : c.mode; }
    private static int buttonOf(ClickState c) { return c == null ? 0 : c.button; }

    private static String slotSig(ScreenHandler h, int slot) {
        var st = h.getStacks().get(slot);
        return st == null || st.isEmpty() ? "-" : Registries.ITEM.getId(st.getItem()) + "x" + st.getCount();
    }

    private ScreenHandler resolveHandler(String id) {
        ClientPlayerEntity p = player();
        if (p == null) return null;
        if ("0".equals(id)) return p.playerScreenHandler;
        return (state.currentWindowId() != null && p.currentScreenHandler.syncId != 0) ? p.currentScreenHandler : null;
    }

    /** 引擎布局槽 -> ScreenHandler 原始槽（玩家区映射已在 McState.clickTarget 做过） */
    private int toRawSlot(String handlerId, int engineSlot, ScreenHandler handler) {
        if ("0".equals(handlerId)) {
            return engineSlot < 9 ? engineSlot + 36 : engineSlot;
        }
        return engineSlot;
    }

    public String windowClose() {
        closeCurrentWindow();
        return "{}";
    }

    private void closeCurrentWindow() {
        ClientPlayerEntity p = player();
        if (p == null) return;
        if (p.currentScreenHandler != null && p.currentScreenHandler.syncId != 0) p.closeHandledScreen();
    }

    // ---- 交互（按原版包：interact / interact_at / player_action / use_item） ----

    private static Hand handOf(JsonObject a) {
        String h = a.has("hand") && !a.get("hand").isJsonNull() ? a.get("hand").getAsString() : "main";
        return "offhand".equals(h) ? Hand.OFF_HAND : Hand.MAIN_HAND;
    }

    private static Direction dirOf(int face) {
        // 协议 face 顺序：0=DOWN 1=UP 2=NORTH 3=SOUTH 4=WEST 5=EAST
        return switch (face) {
            case 0 -> Direction.DOWN;
            case 2 -> Direction.NORTH;
            case 3 -> Direction.SOUTH;
            case 4 -> Direction.WEST;
            case 5 -> Direction.EAST;
            default -> Direction.UP;
        };
    }

    public String useBlock(JsonObject a) {
        var p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        JsonObject pos = a.getAsJsonObject("pos");
        BlockPos bp = BlockPos.ofFloored(pos.get("x").getAsDouble(), pos.get("y").getAsDouble(), pos.get("z").getAsDouble());
        Direction dir = dirOf(a.has("face") ? a.get("face").getAsInt() : 1);
        Vec3d center = Vec3d.ofCenter(bp);
        Vec3d cursor = center;
        if (a.has("cursor") && a.get("cursor").isJsonObject()) {
            JsonObject c = a.getAsJsonObject("cursor");
            cursor = new Vec3d(c.get("x").getAsDouble(), c.get("y").getAsDouble(), c.get("z").getAsDouble());
        }
        BlockHitResult hit = new BlockHitResult(cursor, dir, bp, false);
        mc.interactionManager.interactBlock(p, handOf(a), hit);
        return "{}";
    }

    public String useEntity(JsonObject a) {
        var p = player();
        if (p == null || mc.world == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        Entity target = findEntity(a.has("id") ? a.get("id").getAsString() : "");
        if (target == null) throw new LuaRuntime.AbiError("entity.gone", String.valueOf(a.get("id")));
        String kind = a.has("kind") ? a.get("kind").getAsString() : "attack";
        Hand hand = handOf(a);
        if ("attack".equals(kind)) {
            mc.interactionManager.attackEntity(p, target);
        } else if ("interact_at".equals(kind)) {
            JsonObject t = a.has("target") && a.get("target").isJsonObject() ? a.getAsJsonObject("target") : null;
            Vec3d at = t != null
                    ? new Vec3d(t.get("x").getAsDouble(), t.get("y").getAsDouble(), t.get("z").getAsDouble())
                    : target.getPos().add(0, target.getHeight() / 2, 0);
            mc.interactionManager.interactEntityAtLocation(p, target,
                    new net.minecraft.util.hit.EntityHitResult(target, at), hand);
        } else {
            mc.interactionManager.interactEntity(p, target, hand);
        }
        return "{}";
    }

    public String swing(JsonObject a) {
        var p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        p.swingHand(handOf(a));
        return "{}";
    }

    public String useItem(JsonObject a) {
        var p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        Hand hand = handOf(a);
        String phase = a.has("phase") ? a.get("phase").getAsString() : "start";
        if ("release".equals(phase)) {
            mc.options.useKey.setPressed(false);
            return "{}";
        }
        mc.interactionManager.interactItem(p, hand);
        mc.options.useKey.setPressed(true);
        return "{}";
    }

    // ---- dig：player_action START + 每 tick 进度 + STOP ----

    private DigState digMachine;
    private int digTargetId = -1;

    public String dig(int token, JsonObject a) {
        var p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        JsonObject pos = a.getAsJsonObject("pos");
        BlockPos bp = BlockPos.ofFloored(pos.get("x").getAsDouble(), pos.get("y").getAsDouble(), pos.get("z").getAsDouble());
        Direction dir = dirOf(a.has("face") ? a.get("face").getAsInt() : 1);
        if (digMachine != null) digMachine.stop();
        digMachine = new DigState(token, bp, dir);
        digTargetId = bp.hashCode();
        return null;
    }

    public String digStop() {
        if (digMachine != null) digMachine.stop();
        mc.interactionManager.cancelBlockBreaking();
        return "{}";
    }

    private final class DigState implements LuaRuntime.Tickable {
        final int token;
        final BlockPos pos;
        final Direction dir;
        final long deadline;
        boolean started;
        boolean stopped;

        DigState(int token, BlockPos pos, Direction dir) {
            this.token = token;
            this.pos = pos;
            this.dir = dir;
            this.deadline = System.currentTimeMillis() + 60_000;
        }

        @Override public void tick() {
            if (stopped || mc.world == null) return;
            if (mc.world.getBlockState(pos).isAir()) { done(); return; }
            if (System.currentTimeMillis() > deadline) { fail("timeout"); return; }
            if (!started) {
                mc.interactionManager.attackBlock(pos, dir);
                started = true;
            } else {
                mc.interactionManager.updateBlockBreakingProgress(pos, dir);
            }
        }

        void done() {
            if (stopped) return;
            stopped = true;
            if (digMachine == this) digMachine = null;
            rt.settle(token, "{}", "");
        }

        void fail(String kind) {
            if (stopped) return;
            stopped = true;
            if (digMachine == this) digMachine = null;
            mc.interactionManager.cancelBlockBreaking();
            rt.settle(token, "", LuaRuntime.errJson(kind, "dig 未完成"));
        }

        void stop() {
            if (stopped) return;
            stopped = true;
            if (digMachine == this) digMachine = null;
            mc.interactionManager.cancelBlockBreaking();
            rt.settle(token, "{}", "");
        }
    }

    public String selectSlot(JsonObject a) {
        var p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        int slot = a.get("slot").getAsInt();
        p.getInventory().setSelectedSlot(Math.max(0, Math.min(8, slot)));
        return "{}";
    }

    public String drop(JsonObject a) {
        var p = player();
        if (p == null) throw new LuaRuntime.AbiError("session.offline", "未进世界");
        boolean all = a.has("all") && a.get("all").getAsBoolean();
        if (!a.has("slot") || a.get("slot").isJsonNull()) {
            p.dropSelectedItem(all);
            return "{}";
        }
        int engineSlot = a.get("slot").getAsInt();
        int raw = engineSlot >= 0 && engineSlot <= 8 ? 36 + engineSlot : engineSlot;
        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, raw, all ? 1 : 0,
                net.minecraft.screen.slot.SlotActionType.THROW, p);
        return "{}";
    }

    private Entity findEntity(String id) {
        if (mc.world == null) return null;
        try {
            return mc.world.getEntityById(Integer.parseInt(id));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    // ================= 查询（world） =================

    public JsonObject blockInfo(JsonObject pos) {
        if (mc.world == null) return null;
        BlockPos bp = BlockPos.ofFloored(pos.get("x").getAsDouble(), pos.get("y").getAsDouble(), pos.get("z").getAsDouble());
        var state = mc.world.getBlockState(bp);
        String id = Registries.BLOCK.getId(state.getBlock()).toString();
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        JsonObject props = new JsonObject();
        for (Property<?> prop : state.getProperties()) {
            props.addProperty(prop.getName(), String.valueOf(state.get((Property) prop)));
        }
        o.add("properties", props);
        o.add("state_id", com.google.gson.JsonNull.INSTANCE);
        o.addProperty("hardness", state.getHardness(mc.world, bp));
        o.addProperty("is_container", DataRegistry.isContainerName(id));
        o.addProperty("stale", false);
        var be = mc.world.getBlockEntity(bp);
        if (be != null) {
            JsonObject b = new JsonObject();
            Identifier beId = Registries.BLOCK_ENTITY_TYPE.getId(be.getType());
            b.addProperty("type", beId != null ? beId.toString() : "unknown");
            o.add("block_entity", b);
        } else {
            o.add("block_entity", com.google.gson.JsonNull.INSTANCE);
        }
        return o;
    }

    public JsonObject blockEntity(JsonObject pos) {
        if (mc.world == null) return null;
        BlockPos bp = BlockPos.ofFloored(pos.get("x").getAsDouble(), pos.get("y").getAsDouble(), pos.get("z").getAsDouble());
        var be = mc.world.getBlockEntity(bp);
        if (be == null) return null;
        JsonObject o = new JsonObject();
        Identifier beId = Registries.BLOCK_ENTITY_TYPE.getId(be.getType());
        o.addProperty("type", beId != null ? beId.toString() : "unknown");
        try {
            var nbt = be.createNbtWithIdentifyingData(mc.world.getRegistryManager());
            o.addProperty("snbt", nbt.toString());
        } catch (Exception ignored) { }
        return o;
    }

    public JsonObject reach(JsonObject pos, double maxDistance) {
        JsonObject o = new JsonObject();
        o.addProperty("reachable", false);
        o.add("distance", com.google.gson.JsonNull.INSTANCE);
        o.add("hit_block", com.google.gson.JsonNull.INSTANCE);
        var p = player();
        if (p == null || mc.world == null) return o;
        BlockPos bp = BlockPos.ofFloored(pos.get("x").getAsDouble(), pos.get("y").getAsDouble(), pos.get("z").getAsDouble());
        Vec3d eye = p.getEyePos();
        Vec3d center = Vec3d.ofCenter(bp);
        double distance = eye.distanceTo(center);
        o.addProperty("distance", distance);
        var hit = mc.world.raycast(new net.minecraft.world.RaycastContext(
                eye, center,
                net.minecraft.world.RaycastContext.ShapeType.OUTLINE,
                net.minecraft.world.RaycastContext.FluidHandling.NONE, p));
        boolean reachable = hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(bp)
                && distance <= maxDistance;
        o.addProperty("reachable", reachable);
        if (reachable) {
            o.addProperty("hit_block", Registries.BLOCK.getId(mc.world.getBlockState(bp).getBlock()).toString());
        }
        return o;
    }

    public JsonObject worldEnv() {
        JsonObject o = new JsonObject();
        var w = mc.world;
        o.addProperty("dimension", w != null ? w.getRegistryKey().getValue().toString() : null);
        o.addProperty("time_of_day", w != null ? w.getTimeOfDay() : null);
        String weather = w == null ? null : (w.isThundering() ? "thunder" : w.isRaining() ? "rain" : "clear");
        o.addProperty("weather", weather);
        return o;
    }

    public JsonObject sessionInfo() {
        JsonObject o = new JsonObject();
        var entry = mc.getCurrentServerEntry();
        o.addProperty("version", entry != null && entry.version != null ? entry.version.getString() : "1.21.8");
        o.addProperty("brand", mc.world != null ? "client" : null);
        o.addProperty("dimension", mc.world != null ? mc.world.getRegistryKey().getValue().toString() : null);
        o.addProperty("view_distance", mc.options.getViewDistance().getValue());
        int ping = 0;
        try {
            var p = player();
            if (p != null) {
                var info = mc.getNetworkHandler().getPlayerListEntry(p.getUuid());
                if (info != null) ping = info.getLatency();
            }
        } catch (Exception ignored) { }
        o.addProperty("ping", ping);
        o.addProperty("players", mc.getNetworkHandler() != null ? mc.getNetworkHandler().getPlayerList().size() : 0);
        return o;
    }

    public Set<String> scanKinds(JsonObject a) {
        JsonObject pred = a.has("pred") && a.get("pred").isJsonObject() ? a.getAsJsonObject("pred") : null;
        if (pred == null) return Set.of("chest");
        String type = pred.has("type") ? pred.get("type").getAsString() : "";
        if ("container".equals(type)) return DataRegistry.containerPaths();
        Set<String> out = new HashSet<>();
        if (pred.has("names")) for (JsonElement e : pred.getAsJsonArray("names")) out.add(e.getAsString());
        return out.isEmpty() ? Set.of("chest") : out;
    }

    public JsonArray scanBlocks(JsonObject region, Set<String> kinds, int limit) {
        JsonArray list = new JsonArray();
        if (mc.world == null) return list;
        Set<String> kindSet = new HashSet<>();
        for (String k : kinds) kindSet.add(k.replace("minecraft:", ""));
        JsonArray r = region.getAsJsonArray();
        int[] min = corner(r.get(0)), max = corner(r.get(1));
        int n = 0;
        for (BlockPos pos : BlockPos.iterate(
                Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2]),
                Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2]))) {
            String id = Registries.BLOCK.getId(mc.world.getBlockState(pos).getBlock()).toString();
            if (!kindSet.contains(id.replace("minecraft:", ""))) continue;
            JsonObject o = new JsonObject();
            o.addProperty("x", pos.getX());
            o.addProperty("y", pos.getY());
            o.addProperty("z", pos.getZ());
            o.addProperty("id", id);
            list.add(o);
            if (++n >= limit) break;
        }
        return list;
    }

    private static int[] corner(JsonElement e) {
        JsonObject o = e.getAsJsonObject();
        return new int[]{(int) Math.floor(o.get("x").getAsDouble()),
                (int) Math.floor(o.get("y").getAsDouble()),
                (int) Math.floor(o.get("z").getAsDouble())};
    }

    void tickSleepDeadlines() { if (rt.abi() != null) rt.abi().tickSleepDeadlines(); }
}
