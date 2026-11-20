package com.botscript.mod.runtime;

import org.yaml.snakeyaml.Yaml;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 脚本包清单加载器（bot.yaml → BotConfig + 脚本文件列表）。
 * v2 包清单只描述自身能力：name/scripts/params(schema+默认值)/persist（DESIGN §6）——
 * 边界（policy）来自实例部署配置（游戏目录 config，BotScriptMod 经 BotConfig.applyBoundary 注入），
 * 凭据/连接与 mod 无关（客户端随玩家登录）。
 */
public final class ScriptPackageLoader {

    /** 加载结果：配置 + 入口/模块 lua 文件 */
    public static final class Loaded {
        public BotConfig config = new BotConfig();
        public List<LuaRuntime.ScriptFile> scripts = new ArrayList<>();
        public String entryName;
    }

    public static Loaded load(Path packageDir, String fallbackName) throws Exception {
        Loaded out = new Loaded();
        out.config.name = fallbackName;
        Path manifest = packageDir.resolve("bot.yaml");
        if (!Files.exists(manifest)) {
            // 无清单：过渡约定 = 字典序首个 .lua 为入口，其余为模块
            try (var stream = Files.list(packageDir)) {
                List<Path> lua = stream.filter(p -> p.toString().endsWith(".lua")).sorted().toList();
                for (int i = 0; i < lua.size(); i++) {
                    out.scripts.add(new LuaRuntime.ScriptFile(
                            packageDir.relativize(lua.get(i)).toString(), Files.readString(lua.get(i)), i == 0));
                }
            }
            if (out.scripts.isEmpty()) throw new IllegalArgumentException("包内没有 .lua 脚本");
            out.entryName = out.scripts.get(0).path();
            return out;
        }

        Map<String, Object> yaml = new Yaml().load(Files.readString(manifest));
        if (yaml == null) yaml = new LinkedHashMap<>();

        BotConfig cfg = out.config;
        if (yaml.get("name") instanceof String n) cfg.name = n;
        if (yaml.get("params") instanceof Map<?, ?> pm) {
            for (var e : pm.entrySet()) {
                cfg.params.put(String.valueOf(e.getKey()),
                        com.google.gson.JsonParser.parseString(LuaRuntime.toJson(e.getValue() == null ? null : e.getValue())));
            }
        }

        // 脚本装载（相对包目录；入口脚本的兄弟 .lua 一并预载为模块）
        Object scriptsNode = yaml.get("scripts");
        List<String> scripts = new ArrayList<>();
        if (scriptsNode instanceof List<?> l) {
            for (Object s : l) scripts.add(String.valueOf(s));
        } else if (scriptsNode instanceof String s1) {
            scripts.add(s1);
        }
        if (scripts.isEmpty()) throw new IllegalArgumentException("bot.yaml scripts 为空");
        for (String s0 : scripts) {
            Path f = packageDir.resolve(s0).normalize();
            if (!Files.exists(f)) throw new IllegalArgumentException("脚本不存在: " + s0);
            out.scripts.add(new LuaRuntime.ScriptFile(s0, Files.readString(f), true));
        }
        // 兄弟模块（入口所在目录其余 .lua，供 require）
        Path entryDir = packageDir.resolve(scripts.get(0)).normalize().getParent();
        if (entryDir != null && entryDir.startsWith(packageDir)) {
            try (var stream = Files.list(entryDir)) {
                for (Path f : stream.filter(p -> p.toString().endsWith(".lua")).sorted().toList()) {
                    String rel = packageDir.relativize(f).toString();
                    boolean isEntry = scripts.stream().anyMatch(s0 -> packageDir.resolve(s0).normalize().equals(f));
                    if (!isEntry) out.scripts.add(new LuaRuntime.ScriptFile(rel, Files.readString(f), false));
                }
            }
        }
        out.entryName = scripts.get(0);
        return out;
    }

}
