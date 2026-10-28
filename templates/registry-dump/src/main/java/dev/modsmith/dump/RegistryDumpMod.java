package dev.modsmith.dump;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.SharedConstants;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.state.property.Property;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * Writes the server's real registry ids right after it starts.
 *
 * Why: measuring 3000+ block states over RCON takes hours. The registry is already
 * the source of truth, so dump it in one pass. This mod registers no blocks/items,
 * so it does not change the registry; remove the jar after the dump.
 */
public class RegistryDumpMod implements ModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("modsmith-dump");

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            try {
                dump();
            } catch (Throwable error) {
                LOG.error("registry dump failed", error);
            }
        });
    }

    private static void dump() throws IOException {
        JsonObject root = new JsonObject();
        root.addProperty("schema", 1);
        root.addProperty("minecraftVersion", SharedConstants.getGameVersion().getName());
        root.addProperty("dumpMod", "modsmith-dump");
        root.addProperty("dumpModVersion", "0.1.0");

        JsonObject blocks = new JsonObject();
        for (Block block : Registries.BLOCK) {
            Identifier blockId = Registries.BLOCK.getId(block);
            JsonArray states = new JsonArray();
            for (BlockState state : block.getStateManager().getStates()) {
                JsonObject entry = new JsonObject();
                JsonObject props = new JsonObject();
                for (Map.Entry<Property<?>, Comparable<?>> prop : state.getEntries().entrySet()) {
                    props.addProperty(prop.getKey().getName(), prop.getValue().toString());
                }
                entry.add("props", props);
                entry.addProperty("stateId", Block.STATE_IDS.getRawId(state));
                states.add(entry);
            }
            blocks.add(blockId.toString(), states);
        }
        root.add("blocks", blocks);

        JsonObject items = new JsonObject();
        for (Item item : Registries.ITEM) {
            Identifier itemId = Registries.ITEM.getId(item);
            items.addProperty(itemId.toString(), Registries.ITEM.getRawId(item));
        }
        root.add("items", items);

        Path out = FabricLoader.getInstance().getConfigDir().resolve("modsmith-dump.json");
        Files.writeString(out, new GsonBuilder().setPrettyPrinting().create().toJson(root));
        LOG.info("wrote registry dump to {}", out.toAbsolutePath());
    }
}
