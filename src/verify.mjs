/**
 * `modsmith verify` —— 冒烟测试：清单里的东西在真实服务器上真能用吗。
 *
 * 三项检查，任何一项失败都说明 manifest/ids 有问题，别急着交给她：
 *   1. 方块认得：注入后 `blockAt` 能读出模组方块名（不是空、不是 minecraft:air）
 *   2. 物品能拿：/give 之后客户端读得到，且数字 id 与 ids.json 一致
 *   3. 配方能合：能从配方表里查到至少一条，且原料能被解析成具体物品
 *
 * 这个命令**只读**：除了临时摆方块、/give 再 /clear，不改世界也不装东西。
 */
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { readManifest, readIds } from './manifest-io.mjs';
import { installModRegistry, MEASURE_DROPS, installMineflayerFixes, loadModPack, setModsDir } from './cortico-bridge.mjs';
import { sampleOf } from './calibrate-core.mjs';
import { checkServerMods } from './server-fingerprint.mjs';
import { makeRcon } from './rcon.mjs';
import { fallbackTag } from './tag-fallback.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function cmdVerify(args, io) {
  const manifestPath = args._[1];
  if (!manifestPath) io.fatal('verify 要给一个 manifest 路径');
  const manifest = readManifest(manifestPath);
  if (!manifest) io.fatal(`读不了 manifest：${manifestPath}`);
  const idsPath = String(args.ids ?? manifestPath.replace(/\.json$/, '-ids.json'));
  const ids = readIds(idsPath);
  if (!ids) io.fatal(`读不了 ids：${idsPath}（先跑 calibrate）`);
  const idBlocks = Object.keys(ids.blocks ?? {}).length;
  const idItems = Object.keys(ids.items ?? {}).length;
  if (idBlocks === 0) {
    io.fatal(`${idsPath} 里没有方块数据（只跑过 --items-only？）——方块校验会全挂，先跑一次完整 calibrate`);
  }
  if (idItems === 0) {
    io.fatal(`${idsPath} 里没有物品数据（只跑过 --blocks-only？）——先跑一次完整 calibrate`);
  }
  const verdict = checkServerMods(
    ids.serverMods,
    typeof args['server-mods'] === 'string' ? args['server-mods'] : undefined,
  );
  for (const line of verdict.lines) console.error(`  ${line}`);
  if (verdict.fatal) io.fatal('ids 与这台服务器对不上（见上）——过期的数据不做冒烟，直接拒绝');

  const host = String(args.host ?? '127.0.0.1');
  const port = Number(args.port ?? 25565);
  const rconPort = Number(args['rcon-port'] ?? port + 10);
  const rconPassword = String(args['rcon-password'] ?? '');
  const mcVersion = String(args['mc-version'] ?? '1.21.1');
  const username = String(args.username ?? 'ModVerify');
  const bx = Number(args.x ?? 400);
  const by = Number(args.y ?? 200);
  const bz = Number(args.z ?? 400);
  const packName = String(args.pack ?? '');
  if (!packName) io.fatal('verify 要给 --pack <包名>');
  if (typeof args['mods-dir'] === 'string') setModsDir(args['mods-dir']);

  const pack = loadModPack(packName);
  if (!pack) io.fatal(`读不到包 ${packName}`);

  const results = [];
  const add = (kind, ok, detail) => results.push({ kind, ok, detail });

  const cmd = await makeRcon(host, rconPort, rconPassword);
  const bot = mineflayer.createBot({ host, port, username, version: mcVersion, auth: 'offline' });
  installModRegistry(bot, pack);
  installMineflayerFixes(bot, { extraDrop: MEASURE_DROPS });

  await cmd(`forceload add ${bx - 8} ${bz - 8} ${bx + 8} ${bz + 8}`);
  await cmd(`fill ${bx - 4} ${by - 1} ${bz - 4} ${bx + 4} ${by - 1} ${bz + 4} minecraft:stone`);
  await cmd(`fill ${bx - 4} ${by} ${bz - 4} ${bx + 4} ${by + 4} ${bz + 4} minecraft:air`);
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
  await cmd(`tp ${username} ${bx + 0.5} ${by} ${bz + 0.5}`);
  await sleep(2500);

  // ---- 1) 方块认得 ----
  const spot = new Vec3(bx + 1, by, bz);
  const sampleBlocks = sampleOf(Object.keys(manifest.blocks ?? {}), 6);
  for (const name of sampleBlocks) {
    const states = manifest.blocks[name].states ?? [{}];
    const st = states[0] ?? {};
    const arg = Object.keys(st).length > 0
      ? `[${Object.entries(st).map(([k, v]) => `${k}=${v}`).join(',')}]`
      : '';
    const resp = await cmd(`setblock ${spot.x} ${spot.y} ${spot.z} ${name}${arg}`);
    if (/failed|unknown|invalid/i.test(resp)) {
      add('block', false, `${name}：服务端拒绝放置（${resp.slice(0, 80)}）`);
      continue;
    }
    await sleep(600);
    const seen = bot.blockAt(spot);
    if (!seen) add('block', false, `${name}：blockAt 读不到`);
    else if (seen.name !== name) add('block', false, `${name}：读回来是 ${seen.name}`);
    else add('block', true, `${name} → stateId ${seen.stateId}`);
    await cmd(`setblock ${spot.x} ${spot.y} ${spot.z} minecraft:air`);
    await sleep(300);
  }

  // ---- 2) 物品能拿 ----
  let invState = [];
  const onWindowItems = (pkt) => {
    if (pkt?.windowId !== 0 || !Array.isArray(pkt.items)) return;
    invState = pkt.items.slice(0, 46)
      .filter((it) => it && typeof it === 'object' && it.name && it.name !== 'air')
      .map((it) => ({ name: it.name, type: it.type }));
  };
  bot._client.on('window_items', onWindowItems);

  const sampleItems = sampleOf(Object.keys(manifest.items ?? {}), 6);
  for (const name of sampleItems) {
    await cmd(`clear ${username}`);
    invState = [];
    await sleep(150);
    const resp = await cmd(`give ${username} ${name} 1`);
    if (/unknown/i.test(resp)) {
      add('item', false, `${name}：服务端不认这个物品`);
      continue;
    }
    let hit = null;
    const deadline = Date.now() + 2500;
    while (!hit && Date.now() < deadline) {
      hit = invState.find((it) => it.name === name || it.name === name.split(':')[1]) ?? null;
      if (!hit) {
        const list = bot.inventory?.items?.() ?? [];
        const alt = list.find((it) => it.name === name || it.name === name.split(':')[1]);
        if (alt) hit = { name: alt.name, type: alt.type };
      }
      if (!hit) await sleep(100);
    }
    if (!hit) {
      add('item', false, `${name}：give 成功了但客户端读不到`);
      continue;
    }
    const expected = ids.items?.[name];
    if (typeof expected === 'number' && hit.type !== expected) {
      add('item', false, `${name}：id 不一致（ids.json ${expected}，实测 ${hit.type}）`);
    } else {
      add('item', true, `${name} → id ${hit.type}`);
    }
  }
  bot._client.removeListener('window_items', onWindowItems);
  await cmd(`clear ${username}`);

  // ---- 3) 配方能查 ----
  const craftable = (manifest.recipes ?? []).filter((r) =>
    (r.type === 'crafting_shaped' || r.type === 'crafting_shapeless'));
  if (craftable.length === 0) {
    add('recipe', false, 'manifest 里没有可合成的配方');
  } else {
    const withCandidates = craftable.filter((r) => recipeResolvable(r, manifest));
    const ratio = withCandidates.length / craftable.length;
    add('recipe', ratio > 0.5,
      `${withCandidates.length}/${craftable.length} 条合成配方的原料能落成具体物品`);
    const missing = craftable.filter((r) => !recipeResolvable(r, manifest))
      .map((r) => r.id).slice(0, 5);
    if (missing.length > 0) add('recipe', true, `推不出来（会当"做不了"跳过）：${missing.join(', ')}`);
  }

  await cmd(`fill ${bx - 4} ${by} ${bz - 4} ${bx + 4} ${by + 4} ${bz + 4} minecraft:air`);
  await cmd(`forceload remove ${bx - 8} ${bz - 8} ${bx + 8} ${bz + 8}`);
  await sleep(300);
  bot.quit();

  const failed = results.filter((r) => !r.ok);
  console.error(`\n=== verify ${manifest.mod} ===`);
  for (const r of results) console.error(`  ${r.ok ? '✓' : '✗'} [${r.kind}] ${r.detail}`);
  console.error(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项没过`}`);

  if (typeof args.out === 'string') {
    const { writeIds } = await import('./manifest-io.mjs');
    writeIds(args.out, { mod: manifest.mod, verifiedAt: new Date().toISOString(), results });
  }
  if (failed.length > 0) process.exitCode = 1;
  console.log(JSON.stringify({ mod: manifest.mod, failed: failed.length, results }, null, 2));
}

/**
 * 这条配方的原料能不能全部落成具体物品名。
 *
 * 口径必须和 Cortico 运行时一致：先查 manifest.candidates，查不到再走启发式兜底
 * （`c:crops/x` → `minecraft:x` 之类）。只看 candidates 会把明明能合的配方报成做不了
 * ——这条一开始就写窄了，对不上运行时。
 */
function recipeResolvable(recipe, manifest) {
  const tags = manifest.candidates ?? {};
  const ns = manifest.namespace ?? String(manifest.mod ?? '').replace(/-/g, '_');
  const candidatesOf = (tag) => {
    const known = tags[tag] ?? tags[tag.replace(/^#/, '')];
    if (Array.isArray(known) && known.length > 0) return known;
    return fallbackTag(tag, ns);
  };
  const ok = (ref) => {
    if (!ref) return false;
    if (Array.isArray(ref)) return ref.some(ok);
    if (typeof ref.item === 'string') return true;
    if (typeof ref.tag === 'string') return candidatesOf(ref.tag).length > 0;
    return false;
  };
  if (recipe.type === 'crafting_shaped') {
    return Object.values(recipe.key ?? {}).every(ok);
  }
  return (recipe.ingredients ?? []).every(ok);
}
