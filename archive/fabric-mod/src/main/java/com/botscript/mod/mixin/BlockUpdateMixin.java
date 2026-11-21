package com.botscript.mod.mixin;

import com.botscript.mod.BlockEventsHook;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.BlockUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.ChunkDeltaUpdateS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** 客户端方块更新拦截：BlockUpdate + ChunkDelta → world.block_changed 事件流 */
@Mixin(ClientPlayNetworkHandler.class)
public abstract class BlockUpdateMixin {

    @Inject(method = "onBlockUpdate", at = @At("TAIL"))
    private void botscript$onBlockUpdate(BlockUpdateS2CPacket pkt, CallbackInfo ci) {
        BlockEventsHook.onBlock(pkt.getPos(), pkt.getState());
    }

    @Inject(method = "onChunkDeltaUpdate", at = @At("TAIL"))
    private void botscript$onChunkDelta(ChunkDeltaUpdateS2CPacket pkt, CallbackInfo ci) {
        pkt.visitUpdates(BlockEventsHook::onBlock);
    }
}
