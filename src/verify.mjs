/**
 * `modsmith verify` —— 冒烟测试：清单里的东西在真实服务器上真能用吗。
 *
 * 三项检查，任何一项失败都说明 manifest/ids 有问题，别急着交给调用方：
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
import { vanillaItemTable } from './recipes-join.mjs';

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
  // 清单里本来就没有方块（纯物品/食物包）时，空 blocks 是正确结果：以前一律当成
  // "--items-only 漏了"，纯物品包接不完（More Delight 实测）。
  const manifestBlocks = Object.keys(manifest.blocks ?? {}).length;
  if (idBlocks === 0 && manifestBlocks > 0) {
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

  // ---- 4) 站点能执行（--stations）----
  //
  // 这是 L3 的验收：光"知道有工作站"不算，要真的动手拿到产物。
  //   - sidecar-recipe：放材料 → 发命令 → 等产物（服务端代做）
  //   - two-step-use：放料 → 换工具 → 右键 → 等产物（真实交互，机器人会做的动作）
  if (args.stations === true) {
    const all = manifest.stations ?? [];
    // 一条站点都没有 = 这个包本来就没有"放材料加工"的方块（纯物品/食物包，More Delight
    // 实测 0 方块）。那不是缺陷；有方块/站点却一条可执行的都没有，才要报出来。
    if (all.length === 0) {
      const blocks = Object.keys(manifest.blocks ?? {}).length;
      if (blocks === 0) add('station', true, '这个包没有工作站（纯物品/食物包），不需要站点验收');
      else add('station', false, `包里有过 ${blocks} 种方块但没有站点声明（先跑 learn --infer）`);
    }
    // **不许静默跳过**：以前这个 filter 把 place-and-wait 直接丢掉，报告里看不到任何
    // 痕迹——那正是"静默失败"。现在没有 recipeType 的、以及执行器还没覆盖的类型，
    // 都要显式列出来。
    const EXECUTABLE = new Set(['sidecar-recipe', 'two-step-use', 'place-and-wait']);
    for (const st of all) {
      if (!st?.recipeType) {
        add('station', false, `${st?.id ?? '(无 id)'}：站点缺 recipeType，没法挑配方执行`);
      } else if (!EXECUTABLE.has(st.kind)) {
        add('station', false, `${st.id}：机制 ${st.kind} 还没有执行器（已知但未验）`);
      }
    }
    const stations = all.filter((st) => EXECUTABLE.has(st.kind) && st.recipeType);

    // 两步式站点：需要把物品放上去、再手持工具右键。用真实交互而不是命令，
    // 这样验的是"机器人能不能做得到"，不是"服务端能不能代做"。
    const dropAt = async (name) => {
      // 手上拿着料右键方块：先把别的清掉，只留这一件，保证 equip 拿到的是它
      await cmd(`clear ${username}`);
      await cmd(`give ${username} ${name} 1`);
      const pick = () => (bot.inventory?.items?.() ?? []).find((it) => it.name === name || it.name === name.split(':')[1]);
      let item = null;
      const dl = Date.now() + 2000;
      while (!item && Date.now() < dl) { item = pick(); if (!item) await sleep(100); }
      return item;
    };
    /**
     * 右键方块。activateBlock 会等"服务端确认"——对方块没有注册交互行为时它永远不返回
     * （实测卡死两分钟）。所以三种手段按顺序试，每个都有超时：
     *   1) 原生 block_place 包（最接近真实玩家，不依赖 mineflayer 的交互封装）
     *   2) activateBlock（给有 vanilla 容器行为的方块兜底）
     */
    const rightClickBlock = async (blockPos) => {
      const block = bot.blockAt(new Vec3(blockPos.x, blockPos.y, blockPos.z));
      if (!block) return { ok: false, why: 'blockAt 读不到' };
      try {
        bot._client.write('block_place', {
          location: blockPos, direction: 1, hand: 0,
          cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, sequence: 0,
        });
        await sleep(400);
        return { ok: true, via: 'block_place' };
      } catch { /* 落到 activateBlock */ }
      try {
        await Promise.race([
          bot.activateBlock(block),
          sleep(3000).then(() => { throw new Error('activateBlock 3s 无响应'); }),
        ]);
        return { ok: true, via: 'activateBlock' };
      } catch (err) {
        return { ok: false, why: String(err.message ?? err).slice(0, 80) };
      }
    };
    const waitItem = async (id, ms) => {
      const short = String(id).split(':').pop();
      const dl = Date.now() + ms;
      for (;;) {
        const hit = (bot.inventory?.items?.() ?? []).find((it) => it.name === id || it.name === short);
        if (hit) return hit;
        if (Date.now() > dl) return null;
        await sleep(250);
      }
    };

    // 配方形状有两代：服务端真值 `{id}` / jar 形状 `{item: {id}}`，产物的挂法也有
    // result / results / result[] 三种。verify 要在 recipes 之前也能跑（jar 清单），
    // 所以这里统一成一个读取器，而不是假设某一种形状。
    const refName = (x) => (typeof x === 'string' ? x : x?.id ?? x?.item?.id ?? x?.item ?? null);
    // join 时 vanilla 类型剥掉了 `minecraft:` 前缀（smoking、campfire_cooking），
    // 而站点的 recipeType 是完整 id。两边都归一化再比。
    const normType = (t) => String(t ?? '').replace(/^minecraft:/, '');
    const ingList = (r) => (r.ingredients ?? [])
      .map((g) => (Array.isArray(g) ? g.map(refName).filter(Boolean) : [refName(g)].filter(Boolean)))
      .filter((g) => g.length > 0);
    const outId = (r) => {
      const first = Array.isArray(r.results) ? r.results[0] : Array.isArray(r.result) ? r.result[0] : null;
      return refName(r.result) ?? refName(first) ?? refName(r.results?.[0]) ?? null;
    };
    const toolIds = (r) => (Array.isArray(r.tool) ? r.tool.map(refName).filter(Boolean) : []);

    for (const st of stations) {
      // 产物可能挂在 result（单个）或 results[]（多产物，如 cutting）。两种都要认，
      // 否则 105 条 cutting 配方会被一条都筛不出来（实测）。
      const recipes = (manifest.recipes ?? []).filter((r) => normType(r.type) === normType(st.recipeType) && outId(r));
      if (recipes.length === 0) {
        add('station', false, `${st.id}：manifest 里没有 ${st.recipeType} 的配方（或产物都没解析出来）`);
        continue;
      }
      // 挑一条**有代表性的**配方，不是最大的：
      //   - 必须有 tool（否则两步式执行不了）
      //   - 原料 2-4 种最好：单原料验不出"逐个放料"，十几种植物的配方会把执行拖成
      //    十几轮右键（FD 有 10 种原料的家具拆解），失败时也难说是哪一步的问题
      const ingCount = (r) => ingList(r).length;
      const hasTool = (r) => (toolIds(r).length > 0 ? 1 : 0);
      const scored = [...recipes].sort((a, b) => {
        const ia = ingCount(a);
        const ib = ingCount(b);
        // 先按"是不是 2-4 种"分组，再按有无工具
        const band = (n) => (n >= 2 && n <= 4 ? 0 : n === 1 ? 1 : 2);
        return band(ia) - band(ib) || hasTool(b) - hasTool(a) || ia - ib;
      });
      const rec = scored[0];
      const pos = { x: bx + 2, y: by, z: bz };
      const placed = await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} ${st.block}`);
      if (/failed|unknown|invalid/i.test(placed)) {
        add('station', false, `${st.id}：方块放不下（${placed.slice(0, 60)}）`);
        continue;
      }

      if (st.kind === 'two-step-use') {
        // 两步式：**每一种原料各右键一次**，然后换工具右键开工。
        // 只放第一种是真实缺缺陷：FD 有 12 条 cutting 配方要 2 种以上原料，
        // 那种配方会"材料不够"失败，而机器人会以为是配方本身不对。
        // ingList 已经把两种形状（[[{id}]] 与 [{id}]）统一成"每格一个候选名数组"。
        const groups = ingList(rec);
        const toolList = toolIds(rec);
        if (groups.length === 0 || toolList.length === 0) {
          add('station', false, `${st.id}：配方缺 ingredients 或 tool，没法执行`);
          await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
          continue;
        }
        await cmd(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:stone`);

        const placedMats = [];
        let putFail = null;
        for (const group of groups) {
          const name = group[0];
          if (!name) continue;
          const item = await dropAt(name);
          if (!item) { putFail = `拿不到材料 ${name}`; break; }
          try { await bot.equip(item, 'hand'); } catch { /* 装备失败也让右键试一次 */ }
          const put = await rightClickBlock(pos);
          if (!put.ok) { putFail = `放 ${name} 时右键失败（${put.why}）`; break; }
          placedMats.push(name);
          await sleep(350);   // 每个之间留一点：服务端要处理上一次交互
        }
        if (putFail) {
          add('station', false, `${st.id}：${putFail}（已放 ${placedMats.length}/${groups.length}）`);
          await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
          continue;
        }

        // 换工具：优先那个后缀对得上的（站点声明了 toolSuffix）
        let toolItem = null;
        for (const t of toolList) {
          toolItem = await dropAt(t);
          if (toolItem) break;
        }
        if (!toolItem) {
          add('station', false, `${st.id}：材料放齐了，但一件工具都拿不到（${toolList.slice(0, 3).join(', ')}…）`);
          await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
          continue;
        }
        try { await bot.equip(toolItem, 'hand'); } catch { /* */ }
        const proc = await rightClickBlock(pos);
        if (!proc.ok) add('station', false, `${st.id}：开工右键失败（${proc.why}）`);
        const expect = outId(rec);
        const got = expect ? await waitItem(expect, 8000) : null;
        const matDesc = placedMats.map((m) => m.split(':').pop()).join(' + ');
        add('station', !!got, got
          ? `${st.id}（两步，${placedMats.length} 种料）：${matDesc} + ${toolItem.name.split(':').pop()} → ${got.name}`
          : `${st.id}（两步）：${matDesc} + ${toolItem.name} 右键后没拿到 ${expect ?? '产物'}`);
        await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
        await sleep(200);
        continue;
      }

      if (st.kind === 'place-and-wait') {
        // 被动加工：放上去等，产物**弹成掉落物**（不是进背包）。
        // 所以判据是"附近出现了对应的 item 实体"或"背包里有了"，两者都算成功。
        const groups = ingList(rec);
        if (groups.length === 0) {
          add('station', false, `${st.id}：配方没有原料，没法执行`);
          await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
          continue;
        }
        await cmd(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:stone`);
        const name = groups[0][0];
        const item = await dropAt(name);
        if (!item) {
          add('station', false, `${st.id}：拿不到材料 ${name}`);
          await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
          continue;
        }
        try { await bot.equip(item, 'hand'); } catch { /* */ }
        const put = await rightClickBlock(pos);
        if (!put.ok) {
          add('station', false, `${st.id}：放料时右键失败（${put.why}）`);
          await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
          continue;
        }
        const expectId = outId(rec);
        // 掉落物只能按数字 id 认（模组物品名可能是 unknown）。模组物品在 ids.items，
        // 原版物品（营火烤出来的熟肉之类）在 vanilla 表里。
        const expectNumeric = ids.items?.[expectId]
          ?? Number(Object.entries(vanillaItemTable(String(args['mc-version'] ?? '1.21.1')))
            .find(([, name]) => name === expectId)?.[0]);
        const waitMs = Number(st.waitMs) || (Number(rec.cooking_time) || 200) * 50 + 4000;
        const deadline = Date.now() + waitMs;
        let got = null;
        let dropped = null;
        while (!got && !dropped && Date.now() < deadline) {
          got = (bot.inventory?.items?.() ?? []).find((it) =>
            it.name === expectId || it.name === String(expectId).split(':').pop()) ?? null;
          if (!got) {
            // 被动加工的产物是掉落物：item 实体的槽位在 metadata[8]，按数字 id 认
            // （模组物品在未注入注册表时名字可能是 unknown，只有 type 是真的）。
            dropped = Object.values(bot.entities ?? {}).find((e) =>
              e?.name === 'item'
              && typeof expectNumeric === 'number'
              && e?.metadata?.[8]?.itemId === expectNumeric) ?? null;
          }
          if (!got && !dropped) await sleep(300);
        }
        add('station', !!got || !!dropped,
          got ? `${st.id}（被动）：${name} 等待后 → ${got.name}`
            : dropped ? `${st.id}（被动）：${name} 等待后产物掉在附近（实体）`
            : `${st.id}（被动）：${name} 等 ${Math.round(waitMs / 1000)}s 没等到 ${expectId}`);
        await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
        await sleep(200);
        continue;
      }

      // 烹饪类站点常有"底下要热源"的机制（heatTag）：不摆热源，服务端会以
      // "没在加热"拒绝开工，而回执看起来像命令根本不存在。营火是最通用的一种热源。
      if (typeof st.heatTag === 'string' && st.heatTag) {
        await cmd(`setblock ${pos.x} ${pos.y - 1} ${pos.z} minecraft:campfire`);
      }

      await cmd(`clear ${username}`);
      const wanted = [];
      for (const cell of ingList(rec)) {
        const name = cell[0];
        if (name) { wanted.push(name); await cmd(`give ${username} ${name} 1`); }
      }
      // 配方自带的容器（锅类配方要碗/桶）也是**数据**，不是某个侧车的癖好：
      // wire 里的 container 字段就是它。不给的话服务端实现会拒绝产出（fdchef 实测），
      // 而失败信息看起来像"站点坏了"。
      const containerId = refName(rec.container);
      if (containerId) await cmd(`give ${username} ${containerId} ${Number(rec.container?.count) || 1}`);
      await sleep(400);
      // 命令模板整句代入 {recipe}：只取第一个词再拼 "cook" 会把
      // `/fdchef cook {recipe}` 之外的写法（多级命令、自定义动词）悄悄改错。
      const template = String(st.command ?? `/${st.id} cook {recipe}`);
      const line = template.includes('{recipe}')
        ? template.replaceAll('{recipe}', rec.id)
        : `${template} ${rec.id}`;
      bot.chat(line.startsWith('/') ? line : `/${line}`);
      const cookMs = (Number(rec.cooking_time) || Number(st.cookTime) || 200) * 50 + 5000;
      const deadline = Date.now() + cookMs;
      let got = null;
      const expectId = outId(rec);
      while (!got && Date.now() < deadline) {
        const list = bot.inventory?.items?.() ?? [];
        const short = String(expectId).split(':').pop();
        got = list.find((it) => it.name === expectId || it.name === short) ?? null;
        if (!got) await sleep(250);
      }
      const cost = wanted.length ? `（材料 ${wanted.length} 种${containerId ? ` + 容器 ${containerId}` : ''}）` : '';
      add('station', !!got, got
        ? `${st.id}：${rec.id}${cost} → ${got.name}`
        : `${st.id}：命令发出后 ${Math.round(cookMs / 1000)}s 内没拿到 ${expectId}${cost}`);
      await cmd(`setblock ${pos.x} ${pos.y} ${pos.z} minecraft:air`);
      await sleep(200);
    }
  }

  await cmd(`fill ${bx - 4} ${by - 1} ${bz - 4} ${bx + 4} ${by + 4} ${bz + 4} minecraft:air`);
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
 * 口径必须和宿主运行时一致：先查 manifest.candidates，查不到再走启发式兜底
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
