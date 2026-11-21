package com.botscript.mod;

import com.botscript.mod.gui.BotGuiScreen;
import com.botscript.mod.runtime.AbiDispatcher;
import com.botscript.mod.runtime.BotConfig;
import com.botscript.mod.runtime.LuaRuntime;
import com.botscript.mod.runtime.StateStore;
import com.botscript.mod.runtime.Policy;
import com.botscript.mod.runtime.ScriptPackageLoader;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * bot-script 客户端 mod（v2 standalone）：内嵌 Lua 运行时直接执行
 * <游戏目录>/botscript/<包名>/ 下的脚本包，不需要外部 Node 引擎进程。
 *
 * 接线（ARCHITECTURE-REFACTOR §3.7）：
 *   LuaRuntime      Luaj + runtime/lua（唯一源码）+ compat/luaj
 *   AbiDispatcher   单一 dispatch（策略/速率/预算/审计/结算）
 *   McState         客户端事件 → 契约模型（self/entities/windows/session）
 *   McRuntime       动作原语（一次协议动作 + 确认）
 *   HttpApi         §17 控制通道（形状与 Node 宿主一致）
 */
@Environment(EnvType.CLIENT)
public class BotScriptMod implements ClientModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("botscript");
    private static MinecraftClient mc;

    private String activePackage = "hello";
    private JsonObject instanceBoundary = null;
    private boolean wasInWorld;
    private LuaRuntime runtime;
    private AbiDispatcher dispatcher;
    private McState state;
    private McRuntime mcRuntime;
    private StateStore stateStore;
    private HttpApi httpApi;
    private BotConfig cfg = new BotConfig();
    private net.minecraft.client.option.KeyBinding keyToggle;

    @Override
    public void onInitializeClient() {
        mc = MinecraftClient.getInstance();
        loadConfig();
        ClientTickEvents.END_CLIENT_TICK.register(this::onTick);
        ClientReceiveMessageEvents.GAME.register(this::onGameMessage);
        httpApi = new HttpApi(() -> runtime, () -> dispatcher, () -> state, () -> stateStore,
                () -> cfg, () -> activePackage, () -> mcRuntime);
        httpApi.setRuntimeControl(this::reloadRuntime, this::packagesJson);
        try {
            httpApi.start(LOG);
        } catch (Exception e) {
            LOG.error("HTTP 控制通道启动失败: {}", e.getMessage());
        }
        keyToggle = net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper.registerKeyBinding(
                new net.minecraft.client.option.KeyBinding("key.botscript.toggle",
                        net.minecraft.client.util.InputUtil.Type.KEYSYM,
                        org.lwjgl.glfw.GLFW.GLFW_KEY_K, "category.botscript"));
        net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents.CLIENT_STARTED.register(client -> {
            try {
                org.lwjgl.glfw.GLFW.glfwSetDropCallback(client.getWindow().getHandle(), (handle, count, ptr) -> {
                    List<Path> dropped = new ArrayList<>();
                    for (int i = 0; i < count; i++) {
                        String p = org.lwjgl.glfw.GLFWDropCallback.getName(ptr, i);
                        if (p != null) dropped.add(java.nio.file.Path.of(p));
                    }
                    client.execute(() -> importDropped(dropped));
                });
            } catch (Exception e) {
                LOG.warn("拖拽导入初始化失败: {}", e.getMessage());
            }
        });
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) ->
                dispatcher.register(ClientCommandManager.literal("bsclient").executes(ctx -> {
                    mc.send(() -> mc.setScreen(new BotGuiScreen(httpApi)));
                    return com.mojang.brigadier.Command.SINGLE_SUCCESS;
                })));
        LOG.info("botscript mod 初始化完成（standalone 运行时），脚本包 = {}", activePackage);
    }

    // ================= 配置 =================

    private void loadConfig() {
        try {
            Path cfgFile = FabricLoader.getInstance().getConfigDir().resolve("botscript-mod.json");
            if (Files.exists(cfgFile)) {
                JsonObject o = JsonParser.parseString(Files.readString(cfgFile)).getAsJsonObject();
                if (o.has("package")) activePackage = o.get("package").getAsString();
                if (o.has("boundary") && o.get("boundary").isJsonObject()) {
                    instanceBoundary = o.getAsJsonObject("boundary");
                }
            } else {
                Files.createDirectories(cfgFile.getParent());
                Files.writeString(cfgFile, "{\n  \"package\": \"" + activePackage
                        + "\",\n  \"boundary\": {}\n}\n");
            }
        } catch (Exception e) {
            LOG.error("配置读取失败: {}", e.getMessage());
        }
    }

    private Path packageDir() {
        return FabricLoader.getInstance().getGameDir().resolve("botscript").resolve(activePackage);
    }

    // ================= 会话 / tick =================

    private void onTick(MinecraftClient client) {
        boolean inWorld = client.player != null && client.world != null;
        if (inWorld && !wasInWorld) bootRuntime();
        if (!inWorld && wasInWorld) stopRuntime();
        wasInWorld = inWorld;
        while (keyToggle.wasPressed()) {
            if (runtime != null) {
                if (runtime.isPaused()) {
                    runtime.resume();
                    LOG.info("[hotkey] 脚本已恢复（resume）");
                } else {
                    runtime.pause("hotkey");
                    LOG.info("[hotkey] 脚本已急停（pause，按 {} 恢复）", keyToggle.getBoundKeyLocalizedText().getString());
                }
            }
        }
        if (runtime != null) runtime.tick();
    }

    private void bootRuntime() {
        try {
            Path dir = packageDir();
            if (!Files.isDirectory(dir)) {
                LOG.error("脚本包目录不存在: {}（config/botscript-mod.json 的 package 配置有误？）", dir);
                return;
            }
            ScriptPackageLoader.Loaded loaded = ScriptPackageLoader.load(dir, activePackage);
            cfg = loaded.config;
            List<LuaRuntime.ScriptFile> files = loaded.scripts;

            if (instanceBoundary != null) cfg.applyBoundary(instanceBoundary);
            if (!cfg.boundaryConfigured) {
                LOG.warn("实例未配置 boundary（config/botscript-mod.json）：观察模式，动作全拒（DESIGN §5.1）");
            }

            runtime = new LuaRuntime(activePackage, new McLogSink(), System::currentTimeMillis);
            runtime.bootRuntimeLibs();

            state = new McState(mc, runtime::event);
            mcRuntime = new McRuntime(mc, state, cfg, runtime);

            Policy policy = new Policy(cfg,
                    id -> state.entityJson(id),
                    () -> {
                        var p = mc.player;
                        return p == null ? null : new double[]{p.getX(), p.getY(), p.getZ()};
                    },
                    () -> state.currentWindowId() != null);

            stateStore = new StateStore(FabricLoader.getInstance().getGameDir()
                    .resolve("botscript").resolve("state").resolve("state.json"));
            runtime.attachState(stateStore);

            dispatcher = new AbiDispatcher(runtime, state, mcRuntime, policy, cfg, stateStore,
                    (op, argsJson) -> httpApi.recordAction(op, argsJson),
                    (type, data) -> httpApi.recordEvent(type, data));
            runtime.setAbi(dispatcher);

            runtime.loadScripts(files);
            JsonObject manifestParams = new JsonObject();
            for (var e : cfg.params.entrySet()) manifestParams.add(e.getKey(), e.getValue());
            runtime.bindParams(manifestParams, new JsonObject());

            // L1 方块更新流（P3 Mixin）：world.block_changed 事件
            BlockEventsHook.setListener((x, y, z, blockId) -> {
                JsonObject o = new JsonObject();
                o.addProperty("x", x);
                o.addProperty("y", y);
                o.addProperty("z", z);
                o.addProperty("name", blockId);
                runtime.event("world.block_changed", o.toString());
            });

            runtime.addMachine(state);
            runtime.addMachine(mcRuntime);
            runtime.start();
            LOG.info("脚本包 [{}] 已加载：入口 {}，共 {} 个脚本", activePackage, loaded.entryName, files.size());
        } catch (Exception e) {
            LOG.error("脚本包 [{}] 加载失败", activePackage, e);
            runtime = null;
            dispatcher = null;
            state = null;
            mcRuntime = null;
        }
    }

    private String statusLine() {
        var p = mc.player;
        String pos = p != null ? Math.round(p.getX()) + " " + Math.round(p.getY()) + " " + Math.round(p.getZ()) : "?";
        return "state=" + (p != null ? "playing" : "idle") + " paused=" + (runtime != null && runtime.isPaused())
                + " pos=" + pos;
    }

    private void stopRuntime() {
        BlockEventsHook.setListener(null);
        if (runtime != null) LOG.info("离开世界，脚本包 [{}] 停止", activePackage);
        runtime = null;
        dispatcher = null;
        state = null;
        mcRuntime = null;
    }

    // ================= 运行时控制：热重载 / 包切换 / 拖拽导入（CAPABILITIES §16.6） =================

    private JsonObject reloadRuntime(String pkg) {
        JsonObject out = new JsonObject();
        try {
            if (pkg != null && !pkg.isBlank() && !pkg.equals(activePackage)) {
                Path dir = FabricLoader.getInstance().getGameDir().resolve("botscript").resolve(pkg);
                if (!Files.isDirectory(dir) || pkg.contains("..") || pkg.contains("/") || pkg.contains("\\")) {
                    out.addProperty("error", "package.missing");
                    out.addProperty("detail", "botscript/" + pkg + " 不存在");
                    return out;
                }
                activePackage = pkg;
                saveConfigPackage(pkg);
                out.addProperty("switched", pkg);
            }
            boolean inWorld = mc.player != null && mc.world != null;
            if (inWorld) {
                stopRuntime();
                bootRuntime();
                out.addProperty("reloaded", runtime != null);
            } else {
                out.addProperty("reloaded", false);
                out.addProperty("detail", "不在世界内：配置已写入，下次进世界加载 " + activePackage);
            }
            out.addProperty("package", activePackage);
        } catch (Exception e) {
            out.addProperty("error", String.valueOf(e.getMessage()));
        }
        return out;
    }

    private JsonObject packagesJson() {
        JsonObject out = new JsonObject();
        out.addProperty("current", activePackage);
        JsonArray list = new JsonArray();
        Path root = FabricLoader.getInstance().getGameDir().resolve("botscript");
        try (var stream = Files.list(root)) {
            stream.filter(Files::isDirectory).filter(d -> {
                if (Files.exists(d.resolve("bot.yaml"))) return true;
                try (var s = Files.list(d)) {
                    return s.anyMatch(f -> f.getFileName().toString().endsWith(".lua"));
                } catch (Exception e) { return false; }
            }).sorted().forEach(d -> list.add(d.getFileName().toString()));
        } catch (Exception e) {
            out.addProperty("error", String.valueOf(e.getMessage()));
        }
        out.add("packages", list);
        return out;
    }

    private void saveConfigPackage(String pkg) {
        try {
            Path cfgFile = FabricLoader.getInstance().getConfigDir().resolve("botscript-mod.json");
            JsonObject o = Files.exists(cfgFile)
                    ? JsonParser.parseString(Files.readString(cfgFile)).getAsJsonObject() : new JsonObject();
            o.addProperty("package", pkg);
            Files.writeString(cfgFile, o.toString());
            LOG.info("config package -> {} 已写回", pkg);
        } catch (Exception e) {
            LOG.error("config 写回失败: {}", e.getMessage());
        }
    }

    private void importDropped(List<Path> dropped) {
        Path root = FabricLoader.getInstance().getGameDir().resolve("botscript");
        boolean changed = false;
        try {
            for (Path src : dropped) {
                String name = src.getFileName().toString();
                if (Files.isDirectory(src)) {
                    if (!Files.exists(src.resolve("bot.yaml"))) {
                        LOG.warn("拖入的文件夹 [{}] 没有 bot.yaml，忽略（可作为 .lua 文件逐个拖入）", name);
                        continue;
                    }
                    copyRecursive(src, root.resolve(name));
                    LOG.info("已导入脚本包 [{}]（bot.yaml 定义入口；用 GUI「脚本」页或 /reload 切换）", name);
                    changed = true;
                } else if (name.endsWith(".lua")) {
                    Files.createDirectories(root.resolve(activePackage));
                    Files.copy(src, root.resolve(activePackage).resolve(name),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    LOG.info("已导入脚本 {} -> botscript/{}/（热重载生效）", name, activePackage);
                    changed = true;
                } else {
                    LOG.warn("忽略拖入文件 [{}]（仅支持 .lua 或含 bot.yaml 的文件夹）", name);
                }
            }
        } catch (Exception e) {
            LOG.error("拖拽导入失败: {}", e.getMessage());
            return;
        }
        if (changed && mc.player != null && mc.world != null) {
            stopRuntime();
            bootRuntime();
            LOG.info("拖拽导入完成，脚本包 [{}] 已热重载", activePackage);
        }
    }

    private void copyRecursive(Path src, Path dst) throws Exception {
        if (Files.isDirectory(src)) {
            Files.createDirectories(dst);
            try (var s = Files.list(src)) {
                for (Path f : s.toList()) copyRecursive(f, dst.resolve(f.getFileName().toString()));
            }
        } else {
            Files.createDirectories(dst.getParent());
            Files.copy(src, dst, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    // ================= 聊天捕获（命令总线归核心；chat 事件始终广播） =================

    private void onGameMessage(net.minecraft.text.Text message, Boolean overlay) {
        if (runtime == null || dispatcher == null || Boolean.TRUE.equals(overlay)) return;
        String raw = message.getString();
        if (raw.isEmpty()) return;
        // Fabric 的 GAME 事件不提供发送者 UUID：不猜文本格式，统一按 system 传原样文本。
        // 玩家聊天/system 的分类只依赖协议事实（Node 宿主能从 playerChat 的 sender UUID 判定）。
        JsonObject o = new JsonObject();
        String sender = null;
        o.addProperty("text", raw);
        o.addProperty("raw", raw);
        o.addProperty("sender", sender);
        o.addProperty("sender_kind", "system");
        o.addProperty("ts", System.currentTimeMillis());

        // ABI v2：没有命令体系；聊天只作为 chat 事件进入核心
        runtime.event("chat", o.toString());
    }

    private final class McLogSink implements LuaRuntime.LogSink {
        @Override public void log(String level, String msg) {
            if (httpApi != null) httpApi.recordLog(level, msg);
            switch (level) {
                case "error" -> LOG.error("{}", msg);
                case "warn" -> LOG.warn("{}", msg);
                default -> LOG.info("{}", msg);
            }
        }
    }
}
