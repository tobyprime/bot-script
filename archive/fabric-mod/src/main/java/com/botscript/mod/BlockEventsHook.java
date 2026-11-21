package com.botscript.mod;

import net.minecraft.block.BlockState;
import net.minecraft.util.math.BlockPos;
import net.minecraft.registry.Registries;

/**
 * 方块更新事件钩子：Mixin 静态入口 → mod 实例监听器（世界方块流，heart 触发式依赖）。
 * Mixin 在客户端线程（包处理线程）触发，监听器内不可做重活。
 */
public final class BlockEventsHook {

    public interface Listener {
        void accept(double x, double y, double z, String blockId);
    }

    private static volatile Listener listener;

    public static void setListener(Listener l) {
        listener = l;
    }

    public static void onBlock(BlockPos pos, BlockState state) {
        Listener l = listener;
        if (l != null) {
            l.accept(pos.getX(), pos.getY(), pos.getZ(),
                    Registries.BLOCK.getId(state.getBlock()).toString());
        }
    }

    private BlockEventsHook() {}
}
