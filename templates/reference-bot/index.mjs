/**
 * 最小参考消费者：不依赖 Cortico，只证明「manifest + ids → 普通 mineflayer bot 能用」。
 *
 * 用法（先 npm i modsmith mineflayer）：
 *   node index.mjs --host 127.0.0.1 --port 25565 \
 *     --manifest ../../mods/<pack>.json --ids ../../mods/<pack>-ids.json
 *
 * 只读：连上、在 inject_allowed 前注入注册表、打印方块形状/实体/boss 检查，然后退出。
 */
import { readFileSync } from 'node:fs';
import mineflayer from 'mineflayer';
import { installModRegistry, installMineflayerFixes } from 'modsmith';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = arg('manifest');
const idsPath = arg('ids');
if (!manifestPath || !idsPath) {
  console.error('要 --manifest <manifest.json> --ids <ids.json>');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const ids = JSON.parse(readFileSync(idsPath, 'utf8'));
const bot = mineflayer.createBot({
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', '25565')),
  username: arg('username', 'ModReference'),
  version: arg('version', '1.21.1'),
  auth: 'offline',
  viewDistance: 2,
});

// 必须在 inject_allowed 之前；大 mod 的配方/命令/实体元数据包先丢掉，只读验证不需要。
const counts = installModRegistry(bot, { manifest, ids });
installMineflayerFixes(bot, { extraDrop: ['entity_metadata', 'declare_commands'], dropCommands: true });

bot.once('spawn', () => {
  const blockName = Object.keys(manifest.blocks ?? {})[0];
  const block = blockName ? bot.registry.blocksByName[blockName] : null;
  const entityName = Object.keys(ids.entities ?? {})[0];
  const entity = entityName ? bot.registry.entitiesByName[entityName] : null;
  console.log(`bot ${bot.username} @ ${bot.version} ${bot.game?.dimension ?? ''}`);
  console.log(`注入:方块 ${counts.blocks} / 状态 ${counts.states} / 物品 ${counts.items} / 实体 ${counts.entities}`);
  if (block) {
    const shapes = bot.registry.blockCollisionShapes?.blocks?.[blockName];
    console.log(`方块 ${blockName}: states ${block.stateShapes?.length ?? shapes?.length ?? 0}`);
  }
  if (entity) console.log(`实体 ${entityName}: ${entity.displayName ?? entity.name}${entity.boss ? ' BOSS' : ''}`);
  bot.quit('reference done');
});

bot.on('error', (err) => {
  console.error(`连接/消费失败：${err.message}`);
  process.exitCode = 1;
  try { bot.quit('reference error'); } catch { /* noop */ }
});