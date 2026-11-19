package com.botscript.mod.runtime;

import java.util.Map;
import java.util.Set;

/** 生成物，勿手改：源 contracts/*.yaml，重建 `node tools/codegen.mjs` */
public final class AbiOps {
    private AbiOps() {}

    public static final int ABI_VERSION = 2;

    public static final Set<String> CAPABILITIES = Set.of("nav.pathfinder", "item.components", "world.block_entity");

    public static final Set<String> SYNC_OPS = Set.of("log", "util.now", "util.regex_new", "util.regex_match", "token.bind", "token.detach", "timer.after", "timer.interval", "events.emit", "waiter.resolve", "self.get", "session.get", "caps.get", "caps.list", "entities.list", "entities.get", "world.block", "world.block_entity", "world.scan", "world.env", "world.reach", "window.current", "window.get", "item.stack", "chat.config", "policy.authority", "persist.table", "persist.find", "persist.all", "persist.upsert", "persist.del", "persist.adjust", "persist.seen", "kv.get", "kv.set", "persist.log_declare", "persist.log_append", "persist.log_find", "persist.log_mark", "txn.begin", "txn.commit", "txn.rollback");

    public static final Set<String> ASYNC_OPS = Set.of("util.sleep", "events.next", "waiter.new", "act.chat_send", "act.look", "act.input", "act.path_to", "act.path_cancel", "act.dig", "act.dig_stop", "act.use_block", "act.use_entity", "act.swing", "act.use_item", "act.select_slot", "act.drop", "act.window_open", "act.window_click", "act.window_close");

    public static final Set<String> REVERSE_OPS = Set.of("params.bind", "params.get", "params.set", "tasks.list", "tasks.cancel", "eval.once");

    public static final Map<String, String> GATE = Map.ofEntries(            Map.entry("act.chat_send", "chat"),
            Map.entry("act.input", "move"),
            Map.entry("act.path_to", "move"),
            Map.entry("act.dig", "dig"),
            Map.entry("act.use_block", "place"),
            Map.entry("act.use_entity", "combat"),
            Map.entry("act.window_open", "container"),
            Map.entry("act.window_click", "container"),
            Map.entry("act.window_close", "container"));

    public static final Map<String, Set<String>> REQUIRED =
Map.ofEntries(            Map.entry("log", Set.of("level", "msg")),
            Map.entry("util.regex_new", Set.of("pattern")),
            Map.entry("util.regex_match", Set.of("id", "text")),
            Map.entry("token.bind", Set.of("task_id", "token", "kind")),
            Map.entry("token.detach", Set.of("token")),
            Map.entry("timer.after", Set.of("delay")),
            Map.entry("timer.interval", Set.of("interval")),
            Map.entry("events.emit", Set.of("type")),
            Map.entry("waiter.resolve", Set.of("token", "match")),
            Map.entry("caps.get", Set.of("flag")),
            Map.entry("entities.get", Set.of("id")),
            Map.entry("world.block", Set.of("pos")),
            Map.entry("world.block_entity", Set.of("pos")),
            Map.entry("world.scan", Set.of("region")),
            Map.entry("world.reach", Set.of("pos")),
            Map.entry("window.get", Set.of("window")),
            Map.entry("item.stack", Set.of("stack")),
            Map.entry("persist.table", Set.of("name", "schema")),
            Map.entry("persist.find", Set.of("name")),
            Map.entry("persist.all", Set.of("name")),
            Map.entry("persist.upsert", Set.of("name", "row")),
            Map.entry("persist.del", Set.of("name")),
            Map.entry("persist.adjust", Set.of("name", "key", "delta")),
            Map.entry("persist.seen", Set.of("key", "window_ms")),
            Map.entry("kv.get", Set.of("name", "key")),
            Map.entry("kv.set", Set.of("name", "key", "value")),
            Map.entry("persist.log_declare", Set.of("name")),
            Map.entry("persist.log_append", Set.of("name")),
            Map.entry("persist.log_find", Set.of("name")),
            Map.entry("persist.log_mark", Set.of("name", "id", "state")),
            Map.entry("util.sleep", Set.of("ms")),
            Map.entry("act.chat_send", Set.of("text")),
            Map.entry("act.path_to", Set.of("target")),
            Map.entry("act.dig", Set.of("pos")),
            Map.entry("act.use_block", Set.of("pos")),
            Map.entry("act.use_entity", Set.of("id")),
            Map.entry("act.select_slot", Set.of("slot")),
            Map.entry("act.window_open", Set.of("target")),
            Map.entry("act.window_click", Set.of("slot")),
            Map.entry("params.set", Set.of("key")),
            Map.entry("tasks.cancel", Set.of("name")),
            Map.entry("eval.once", Set.of("name", "code")));
}
