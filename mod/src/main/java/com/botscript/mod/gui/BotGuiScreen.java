package com.botscript.mod.gui;

import com.botscript.mod.HttpApi;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 管理/配置界面（CAPABILITIES §16.5）：GUI 是控制总线的又一张脸——
 * 页面数据与 HTTP API（/state /params /tasks /logs /caps）同源（HttpApi.localCall），
 * 写入走同一命令总线、以 owner 权限身份；页面层零业务逻辑。全人类可读，不展示裸 JSON。
 *
 * 自带轻量控件（自绘列表 + Button/TextField），不引入第三方 UI 库（跨版本维护是坑，§16.5）。
 * 打开方式：/bsclient 命令（BotScriptMod 注册）。
 */
public final class BotGuiScreen extends Screen {

    private static final int[] COL = {
            0xFFFFFFFF, 0xFFAAAAAA, 0xFF7FE07F, 0xFFFF7F7F, 0xFF7FBFFF, 0xFFFFD97F,
    };
    private static final String[] TABS = {"状态", "任务", "参数", "边界", "日志", "脚本"};

    private final HttpApi api;
    private int tab = 0;
    private int scroll = 0;

    // 数据缓存（约 0.5s 刷新一次）
    private JsonObject state = new JsonObject();
    private JsonObject params = new JsonObject();
    private JsonArray tasks = new JsonArray();
    private JsonObject caps = new JsonObject();
    private final List<String[]> logLines = new ArrayList<>();   // [level, msg]

    // 参数页表单（进入参数页时按 schema 生成；visible=true 才出现）
    private final Map<String, TextFieldWidget> paramFields = new HashMap<>();
    private final List<String> visibleParamOrder = new ArrayList<>();
    // 任务页取消按钮签名（列表变化时重建）
    private String taskSig = "";
    // 状态页急停/继续按钮、参数页表单：数据晚于首次布局到达，按签名补一次重建
    private String stateSig = "";
    private String paramsSchemaSig = "";
    // 脚本页包列表（变化时重建切换按钮）
    private String pkgSig = "";
    private JsonObject packages = new JsonObject();
    // 日志过滤
    private TextFieldWidget logFilter;

    public BotGuiScreen(HttpApi api) {
        super(Text.literal("bot-script 管理"));
        this.api = api;
    }

    @Override
    public boolean shouldPause() {
        return false;
    }

    // ================= 布局（init 与 rebuild 唯二入口；render 只画不建） =================

    @Override
    protected void init() {
        layoutTop();
        layoutPage();
    }

    private void layoutTop() {
        // tab 宽度自适应窄屏（竖屏高 scale 下固定 62px 会把"脚本"挤到屏幕外）
        int n = TABS.length;
        int bw = Math.min(62, Math.max(30, (width - 64 - 4 * n) / n));
        int x = 8;
        for (int i = 0; i < n; i++) {
            final int idx = i;
            addDrawableChild(ButtonWidget.builder(Text.literal(TABS[i]), b -> {
                tab = idx;
                scroll = 0;
                paramFields.clear();
                visibleParamOrder.clear();
                logFilter = null;
                taskSig = "";
                rebuild();
            }).dimensions(x, 4, bw, 16).build());
            x += bw + 4;
        }
        addDrawableChild(ButtonWidget.builder(Text.literal("关闭"), b -> close())
                .dimensions(width - 48, 4, 42, 16).build());
    }

    /** 重建动态控件（切页 / 任务列表变化 / resize） */
    private void rebuild() {
        clearChildren();
        layoutTop();
        layoutPage();
    }

    private void layoutPage() {
        switch (tab) {
            case 0 -> layoutState();
            case 1 -> layoutTasks();
            case 2 -> layoutParams();
            case 4 -> layoutLogs();
            case 5 -> layoutScripts();
            default -> { }
        }
    }

    /** 脚本页：当前包 + 热重载按钮 + 各包切换按钮（拖拽导入提示见渲染行） */
    private void layoutScripts() {
        addDrawableChild(ButtonWidget.builder(Text.literal("热重载当前包"), b -> {
                    api.localCall("/reload", "POST", new JsonObject());
                    packages = api.localCall("/packages", "GET", null);
                    rebuild();
                }).dimensions(8, height - 24, 110, 18).build());
        JsonArray list = packages.has("packages") ? packages.getAsJsonArray("packages") : new JsonArray();
        String current = str(packages, "current", "");
        int row = 0;
        for (var e : list) {
            String name = e.getAsString();
            int y = 32 + (4 + row) * 12;   // 与 scriptLines 的文字行对齐（前 4 行是标题/提示）
            if (y > height - 46) break;
            if (!name.equals(current)) {
                addDrawableChild(ButtonWidget.builder(Text.literal("切换"), b -> {
                            JsonObject body = new JsonObject();
                            body.addProperty("package", name);
                            api.localCall("/reload", "POST", body);
                            packages = api.localCall("/packages", "GET", null);
                            rebuild();
                        }).dimensions(width - 130, y, 44, 12).build());
            }
            row++;
        }
    }

    private void layoutState() {
        boolean paused = state.has("paused") && state.get("paused").getAsBoolean();
        addDrawableChild(ButtonWidget.builder(Text.literal(paused ? "继续（resume）" : "急停（pause）"),
                b -> api.localCall(paused ? "/resume" : "/pause", "POST",
                        paused ? new JsonObject() : reasonBody()))
                .dimensions(8, height - 24, 150, 18).build());
    }

    private void layoutTasks() {
        int bx = width - 128;
        for (var e : tasks) {
            JsonObject t = e.getAsJsonObject();
            int row = tasks.asList().indexOf(e);
            int y = 32 + row * 14;
            if (y > height - 40) break;
            addDrawableChild(ButtonWidget.builder(Text.literal("取消"), b ->
                            api.localCall("/tasks/cancel", "POST", nameBody(str(t, "name", ""))))
                    .dimensions(bx, y - 1, 44, 12).build());
        }
    }

    private void layoutParams() {
        visibleParamOrder.clear();
        paramFields.clear();
        JsonObject schema = params.has("schema") ? params.getAsJsonObject("schema") : new JsonObject();
        JsonObject values = params.has("values") ? params.getAsJsonObject("values") : new JsonObject();
        int y = 32;
        for (var e : schema.entrySet()) {
            JsonObject s = e.getValue().getAsJsonObject();
            if (!s.has("visible") || !s.get("visible").getAsBoolean()) continue;   // visible=false 不出现
            visibleParamOrder.add(e.getKey());
            TextFieldWidget f = new TextFieldWidget(textRenderer, width - 180, y, 130, 13,
                    Text.literal(e.getKey()));
            f.setMaxLength(200);
            f.setText(displayValue(values, e.getKey()));
            paramFields.put(e.getKey(), f);
            addDrawableChild(f);
            y += 17;
            if (y > height - 42) break;   // 一屏以内；更多参数经 HTTP /params 或 param 命令
        }
        addDrawableChild(ButtonWidget.builder(Text.literal("保存全部"), b -> saveParams())
                .dimensions(8, height - 24, 100, 18).build());
    }

    private void layoutLogs() {
        logFilter = new TextFieldWidget(textRenderer, 8, 28, 180, 13, Text.literal("过滤"));
        logFilter.setMaxLength(100);
        addDrawableChild(logFilter);
    }

    // ================= 渲染 =================

    private int refreshCounter = 0;

    @Override
    public void render(DrawContext ctx, int mouseX, int mouseY, float delta) {
        refreshData();
        ctx.fill(0, 0, width, height, 0xC8101018);
        ctx.drawCenteredTextWithShadow(textRenderer, title, width / 2, 8, 0xFFFFFFFF);

        List<String[]> lines = switch (tab) {
            case 0 -> stateLines();
            case 1 -> taskLines();
            case 2 -> paramLines();
            case 3 -> boundaryLines();
            case 4 -> logLines();
            case 5 -> scriptLines();
            default -> new ArrayList<>();
        };
        drawLines(ctx, lines, tab == 4 ? 46 : 32);
        super.render(ctx, mouseX, mouseY, delta);
    }

    private void refreshData() {
        if (++refreshCounter % 10 != 0) return;   // ~0.5s（20tps）
        state = api.localCall("/state", "GET", null);
        caps = api.localCall("/caps", "GET", null);
        if (tab == 0) {
            // 急停/继续按钮随 paused 翻转（layoutState 仅在 rebuild 时执行）
            String sig = String.valueOf(state.has("paused") && state.get("paused").getAsBoolean());
            if (!sig.equals(stateSig)) {
                stateSig = sig;
                rebuild();
            }
        }
        if (tab == 1) {
            JsonObject t = api.localCall("/tasks", "GET", null);
            tasks = t.has("tasks") ? t.getAsJsonArray("tasks") : new JsonArray();
            String sig = tasks.toString();
            if (!sig.equals(taskSig)) {
                taskSig = sig;
                rebuild();
            }
        }
        if (tab == 2) {
            params = api.localCall("/params", "GET", null);
            String sig = params.has("schema") ? params.getAsJsonObject("schema").toString() : "";
            if (!sig.equals(paramsSchemaSig)) {
                // schema 首次到达或变化：重建表单（控件不能凭空出现，只能 rebuild）
                paramsSchemaSig = sig;
                rebuild();
            } else {
                refreshParamFieldValues();
            }
        }
        if (tab == 4) refreshLogs();
        if (tab == 5) {
            JsonObject p = api.localCall("/packages", "GET", null);
            String sig = p.toString();
            if (!sig.equals(pkgSig)) {
                pkgSig = sig;
                packages = p;
                rebuild();
            } else {
                packages = p;
            }
        }
    }

    private void refreshLogs() {
        JsonObject l = api.localCall("/logs", "GET", null);
        JsonArray arr = l.has("logs") ? l.getAsJsonArray("logs") : new JsonArray();
        logLines.clear();
        String filter = logFilter != null ? logFilter.getText().trim() : "";
        for (var e : arr) {
            JsonObject row = e.getAsJsonObject();
            String msg = row.get("msg").getAsString();
            if (!filter.isEmpty() && !msg.contains(filter)) continue;
            logLines.add(new String[]{row.get("level").getAsString(), msg});
        }
        while (logLines.size() > 400) logLines.remove(0);
    }

    // ================= 页面数据（纯文本行：[颜色索引, 内容]） =================

    private List<String[]> stateLines() {
        List<String[]> lines = new ArrayList<>();
        lines.add(new String[]{"0", "实例: " + str(state, "name", "-") + "（fabric standalone 宿主）"});
        boolean playing = str(state, "session", "idle").equals("playing");
        boolean paused = state.has("paused") && state.get("paused").getAsBoolean();
        lines.add(new String[]{!playing || paused ? "3" : "2",
                "会话: " + str(state, "session", "idle")
                        + (paused ? "（已暂停" + (str(state, "pause_reason", "").isEmpty() ? "" : "·" + str(state, "pause_reason", "")) + "）" : "")});
        if (state.has("self") && state.get("self").isJsonObject()) {
            JsonObject s = state.getAsJsonObject("self");
            if (s.has("pos") && s.get("pos").isJsonObject()) {
                JsonObject p = s.getAsJsonObject("pos");
                lines.add(new String[]{"0", String.format("位置: %d %d %d    朝向: %.0f / %.0f",
                        (int) p.get("x").getAsDouble(), (int) p.get("y").getAsDouble(), (int) p.get("z").getAsDouble(),
                        s.get("yaw").getAsDouble(), s.get("pitch").getAsDouble())});
            }
            lines.add(new String[]{"0", String.format("生命: %s    饱食: %s    模式: %s",
                    s.has("health") ? String.valueOf((int) s.get("health").getAsDouble()) : "-",
                    s.has("food") ? s.get("food").getAsString() : "-",
                    str(s, "gamemode", "-"))});
            lines.add(new String[]{"0", "主手: " + (str(s, "held", "").isEmpty() ? "（空）" : str(s, "held", ""))});
        }
        lines.add(new String[]{"1", "当前窗口: " + (state.has("window") && !state.get("window").isJsonNull()
                ? state.get("window").getAsString() : "（无）")});
        if (caps.has("flags")) {
            StringBuilder sb = new StringBuilder("能力: ");
            for (var e : caps.getAsJsonObject("flags").entrySet()) {
                sb.append(e.getKey()).append(e.getValue().getAsBoolean() ? "✓  " : "✗  ");
            }
            lines.add(new String[]{"1", sb.toString().trim()});
        }
        return lines;
    }

    private List<String[]> taskLines() {
        List<String[]> lines = new ArrayList<>();
        if (tasks.isEmpty()) {
            lines.add(new String[]{"1", "（没有运行中的任务）"});
            return lines;
        }
        for (var e : tasks) {
            JsonObject t = e.getAsJsonObject();
            String st = str(t, "status", "?");
            lines.add(new String[]{st.equals("suspended") ? "2" : "5",
                    String.format("%s（%s）   进度 %s", str(t, "name", "?"),
                            st.equals("suspended") ? "运行中" : st,
                            t.has("progress") ? t.get("progress").getAsString() : "0")});
        }
        return lines;
    }

    private List<String[]> paramLines() {
        List<String[]> lines = new ArrayList<>();
        JsonObject schema = params.has("schema") ? params.getAsJsonObject("schema") : new JsonObject();
        JsonObject values = params.has("values") ? params.getAsJsonObject("values") : new JsonObject();
        for (String k : visibleParamOrder) {
            String help = schema.has(k) && schema.getAsJsonObject(k).has("help")
                    ? schema.getAsJsonObject(k).get("help").getAsString() : "";
            lines.add(new String[]{"0", k + (help.isEmpty() ? "" : "  # " + help)});
        }
        if (visibleParamOrder.isEmpty()) {
            lines.add(new String[]{"1", "（本包没有 visible=true 的参数；修改走 HTTP /params 或 param 命令）"});
        }
        return lines;
    }

    private List<String[]> boundaryLines() {
        JsonObject b = caps.has("boundary") ? caps.getAsJsonObject("boundary") : new JsonObject();
        List<String[]> lines = new ArrayList<>();
        boolean configured = b.has("configured") && b.get("configured").getAsBoolean();
        lines.add(new String[]{configured ? "2" : "3", configured
                ? "本实例已配置边界（只读视图；未授的动作脚本不可绕过）"
                : "本实例未配置边界 = 观察模式（一切动作被拒，DESIGN §5.1）"});
        lines.add(new String[]{"0", "移动围栏: " + (b.has("fence") ? b.get("fence").toString() : "（无围栏）")});
        lines.add(new String[]{"0", "挖掘授权: " + str(b, "blocks_dig", "未授权")
                + "    放置授权: " + str(b, "blocks_place", "未授权")});
        lines.add(new String[]{"0", "战斗对象: " + str(b, "combat_targets", "未授权")
                + (b.has("combat_max_engage") ? "    接战上限: " + b.get("combat_max_engage").getAsString() : "")});
        lines.add(new String[]{"0", "聊天限速: " + str(b, "say_rate", "-")
                + "    命令白名单: " + orDash(b, "chat_commands")});
        lines.add(new String[]{"0", "authority  owner: " + orDash(b, "authority_owner")
                + "    op: " + orDash(b, "authority_op")});
        lines.add(new String[]{"1", "边界由实例部署配置（config/botscript-mod.json 的 boundary）授予，随环境走、不在脚本包里。"});
        return lines;
    }

    private List<String[]> scriptLines() {
        List<String[]> lines = new ArrayList<>();
        String current = str(packages, "current", "-");
        lines.add(new String[]{"0", "当前脚本包: " + current});
        lines.add(new String[]{"1", "把 .lua 文件拖进游戏窗口 = 拷入当前包；含 bot.yaml 的文件夹 = 导入为独立包。"});
        lines.add(new String[]{"1", "导入/修改后自动热重载；切换包立即生效（botscript/ 目录，按名称排序）。"});
        lines.add(new String[]{"5", "包列表（当前包标 ★）："});
        JsonArray list = packages.has("packages") ? packages.getAsJsonArray("packages") : new JsonArray();
        int row = 0;
        for (var e : list) {
            String name = e.getAsString();
            boolean cur = name.equals(current);
            lines.add(new String[]{cur ? "2" : "0", String.format("%d. %s%s", row + 1, name, cur ? "  ★ 当前" : ""),});
            row++;
        }
        if (list.isEmpty()) lines.add(new String[]{"3", "（botscript/ 下没有可用脚本包）"});
        return lines;
    }

    private List<String[]> logLines() {
        List<String[]> lines = new ArrayList<>();
        for (int i = logLines.size() - visibleRows(46, 11) - scroll; i < logLines.size(); i++) {
            if (i < 0) continue;
            String[] l = logLines.get(i);
            String col = switch (l[0]) {
                case "error" -> "3";
                case "warn" -> "5";
                default -> "1";
            };
            lines.add(new String[]{col, l[1]});
        }
        return lines;
    }

    // ================= 交互 =================

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double horizontal, double vertical) {
        if (tab == 4) {
            scroll = Math.max(0, scroll - (int) Math.signum(vertical));
            return true;
        }
        return super.mouseScrolled(mouseX, mouseY, horizontal, vertical);
    }

    private void saveParams() {
        JsonObject schema = params.has("schema") ? params.getAsJsonObject("schema") : new JsonObject();
        JsonObject body = new JsonObject();
        for (var e : paramFields.entrySet()) {
            String type = schema.has(e.getKey()) && schema.getAsJsonObject(e.getKey()).has("type")
                    ? schema.getAsJsonObject(e.getKey()).get("type").getAsString() : "string";
            String text = e.getValue().getText().trim();
            com.google.gson.JsonElement v = parseTyped(type, text);
            if (v != null) body.add(e.getKey(), v);
        }
        api.localCall("/params", "POST", body);
        params = api.localCall("/params", "GET", null);   // 回读：展示拒绝原因/新值
    }

    private void refreshParamFieldValues() {
        JsonObject values = params.has("values") ? params.getAsJsonObject("values") : new JsonObject();
        for (var e : paramFields.entrySet()) {
            if (!e.getValue().isFocused()) e.getValue().setText(displayValue(values, e.getKey()));
        }
    }

    // ================= 工具 =================

    private void drawLines(DrawContext ctx, List<String[]> lines, int startY) {
        int y = startY;
        for (String[] l : lines) {
            if (y > height - 26) break;
            int color = COL[Integer.parseInt(l[0]) % COL.length];
            ctx.drawTextWithShadow(textRenderer, clip(l[1]), 8, y, color);
            y += 12;
        }
    }

    private String clip(String s) {
        int max = (width - 130) / 6;
        return s.length() > max ? s.substring(0, Math.max(0, max - 3)) + "..." : s;
    }

    private int visibleRows(int startY, int rowH) {
        return Math.max(1, (height - startY - 30) / rowH);
    }

    private static String str(JsonObject o, String k, String dflt) {
        return o != null && o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : dflt;
    }

    private static String orDash(JsonObject o, String k) {
        String v = str(o, k, "");
        return v.isEmpty() ? "（无）" : v;
    }

    private static String displayValue(JsonObject values, String key) {
        if (!values.has(key)) return "";
        var v = values.get(key);
        if (v.isJsonObject() || v.isJsonArray()) return v.toString();   // 结构类型以 JSON 表达
        return v.getAsString();
    }

    /** 按参数类型解析输入（bool/number 原生，blockpos/region/list 收 JSON；解析失败交总线报可读错误） */
    private static com.google.gson.JsonElement parseTyped(String type, String text) {
        try {
            return switch (type) {
                case "bool" -> new com.google.gson.JsonPrimitive(
                        text.equalsIgnoreCase("true") || text.equals("1") || text.equals("是"));
                case "number" -> new com.google.gson.JsonPrimitive(Double.parseDouble(text));
                case "blockpos", "region", "list<blockpos>" -> com.google.gson.JsonParser.parseString(text);
                default -> new com.google.gson.JsonPrimitive(text);
            };
        } catch (Exception e) {
            return new com.google.gson.JsonPrimitive(text);
        }
    }

    private static JsonObject nameBody(String name) {
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        return o;
    }

    private static JsonObject reasonBody() {
        JsonObject o = new JsonObject();
        o.addProperty("reason", "operator");
        return o;
    }
}
