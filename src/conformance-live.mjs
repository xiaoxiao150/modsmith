/**
 * 真机参考消费：连一台测试/生产服务器，用真实 mineflayer bot 消费 manifest+ids。
 *
 * 只读：不 setblock、不 summon、不聊天。它验证的是「一个普通 mineflayer bot 在
 * inject_allowed 前注入后，真的能拿到方块/形状/实体」——比离线模拟更接近宿主。
 * 需要写世界的抽样验证（setblock/召唤）留给人工测试服，不在这里做。
 */
import mineflayer from 'mineflayer';
import { installModRegistry, installMineflayerFixes } from './cortico-bridge.mjs';
import { checkRegistry } from './conformance.mjs';

function waitSpawn(bot, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (err) => {
      if (timer) clearTimeout(timer);
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      bot.removeListener('end', onEnd);
      if (err) reject(err);
      else resolve();
    };
    const onSpawn = () => done(null);
    const onError = (err) => done(err instanceof Error ? err : new Error(String(err)));
    const onEnd = (reason) => done(new Error(`连接在 spawn 前结束：${reason}`));
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('end', onEnd);
    timer = setTimeout(() => done(new Error(`等 spawn 超时（${timeoutMs}ms）`)), timeoutMs);
  });
}

/**
 * @param {{
 *   manifest: object, ids: object,
 *   host?: string, port?: number, username?: string, version?: string,
 *   timeoutMs?: number,
 * }} opts
 */
export async function liveConformance(opts) {
  const {
    manifest, ids,
    host = '127.0.0.1', port = 25565, username = 'ModConform', version = '1.21.1',
    timeoutMs = 60_000,
  } = opts;
  let bot = null;
  try {
    bot = mineflayer.createBot({
      host, port, username, version, auth: 'offline', viewDistance: 2,
    });
    // 与宿主一样：必须在 inject_allowed 之前注入静态注册表。
    const counts = installModRegistry(bot, { manifest, ids });
    // prismarine-registry 会复用 minecraft-data 缓存；同进程里先跑过离线验收时，
    // 注入器可能认为实体已经在了而返回 0。以真实 registry 里的条目为准。
    counts.entities = Object.keys(ids.entities ?? {})
      .filter((name) => Boolean(bot.registry?.entitiesByName?.[name])).length;
    // 只读验证不依赖命令树/实体元数据；大 mod（TF）这两类包会让 protodef 整包错位。
    installMineflayerFixes(bot, { extraDrop: ['entity_metadata', 'declare_commands'], dropCommands: true });
    await waitSpawn(bot, timeoutMs);
    const checks = checkRegistry(manifest, ids, bot.registry, { installed: true });
    return {
      counts,
      checks,
      bot: {
        username: bot.username,
        version: bot.version,
        dimension: String(bot.game?.dimension ?? 'unknown'),
        position: bot.entity?.position
          ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z),
          }
          : null,
      },
    };
  } finally {
    try { bot?.quit('conformance done'); } catch { /* 已经断开 */ }
  }
}