/**
 * modsmith 自带的最小注册表注入。
 *
 * 为什么要自带一份而不 import 宿主的：modsmith 是能独立拿出去用的工具，不该反向依赖
 * 某个具体项目。这里只做 probe 需要的两件事：让 `bot.blockAt` 认得出模组方块、让它
 * 知道模组物品的数字 id。
 *
 * 注入时机同样必须在 `inject_allowed` 之前——prismarine-block 的工厂只在那时拷一次
 * boundingBox/shapes。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { harvestToolsFor, isDiggable, shapeTemplateOf, templateShapeId } from './block-shapes.mjs';

let modsDir = null;

/** 指定 manifest/ids 所在目录（默认 ./mods）。 */
export function setModsDir(dir) {
  modsDir = dir;
}

function dirOf() {
  return modsDir ?? join(process.cwd(), 'mods');
}

export function loadModPack(name) {
  const dir = dirOf();
  if (!name) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
    const ids = JSON.parse(readFileSync(join(dir, `${name}-ids.json`), 'utf8'));
    return { manifest, ids };
  } catch {
    // 没有 ids 时才来看一眼有没有 manifest：给个明白的说法
    try {
      JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
      throw new Error(`${name}-ids.json 不存在：先跑 modsmith calibrate`);
    } catch (err) {
      if (String(err.message).includes('先跑')) throw err;
      return null;
    }
  }
}

/** 已加载的包名（供 probe 逐个注入）。 */
export function listPacks() {
  try {
    return readdirSync(dirOf())
      .filter((f) => f.endsWith('.json') && !f.endsWith('-ids.json') && f !== 'manifest.schema.json')
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * 把 manifest + 实测 id 合并进 bot.registry.
 * 返回注入的方块/状态/物品数，供日志。
 */
/** 从方块 tags 推 prismarine material：挖速/工具判定用，推不出就 default。 */
function materialOf(tags) {
  for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe', 'shears']) {
    if (tags.includes(`mineable/${kind}`)) return `mineable/${kind}`;
  }
  return 'default';
}

/**
 * 服务端 SpawnGroup → prismarine 的实体 type。
 *
 * minecraft-data 里 `type` 决定 mineflayer 的 `entity.type`，也是宿主判"会不会打我"
 * 的依据（hostile）。模组实体的原始生成组由 dump 给出，这里只做词表翻译。
 */
const SPAWN_GROUP_TYPE = {
  monster: 'hostile',
  creature: 'animal',
  axolotls: 'animal',
  ambient: 'ambient',
  underground_water_creature: 'water_creature',
  water_creature: 'water_creature',
  water_ambient: 'water_creature',
  misc: 'mob',
};

export function installModRegistry(bot, pack) {
  const reg = bot.registry;
  if (!reg?.blocksByStateId || !reg.itemsByName) throw new Error('registry 形状不对，注入中止');
  const { manifest, ids } = pack;

  let nextBlockId = Math.max(0, ...Object.keys(reg.blocks ?? {}).map(Number)) + 1;
  const shapes = reg.blockCollisionShapes;
  let nextShapeId = shapes ? Math.max(0, ...Object.keys(shapes.shapes ?? {}).map(Number)) + 1 : 0;

  let blocks = 0;
  let states = 0;
  const observed = [];
  /**
   * 一个 stateId 只能属于一个方块。
   *
   * 老校准会遇到这个：`/setblock` 改不动某些属性时，客户端读回的是上一格的残留值，
   * 于是几十个方块的"第二、三个状态"全都指向同一个 stateId（实测农夫乐事有 100 多个
   * 方块挤在 26979 上）。如果照单全收，后处理的方块会覆盖前者 —— 机器人看见米捆，实际是橱柜。
   *
   * 处理：先到先得，后来的同号条目丢掉。宁可这个状态"未知"（退回空气/不影响），
   * 也别标成错的方块 —— 错名比未知更糟。
   */
  const claimedBy = new Map();

  for (const [name, spec] of Object.entries(manifest.blocks ?? {})) {
    const measured = ids.blocks?.[name] ?? [];
    if (measured.length === 0) continue;
    const stateIds = measured.map((m) => m.stateId).filter((v) => v > 0);
    if (stateIds.length === 0) continue;

    const solid = spec.solid !== false;
    const box = solid ? (spec.box ?? [0, 0, 0, 1, 1, 1]) : null;
    const seq = [...measured].sort((a, b) => a.stateId - b.stateId);
    const propNames = [...new Set(seq.flatMap((m) => Object.keys(m.props ?? {})))];
    const transitions = propNames.map((p) => {
      let n = 0;
      for (let i = 1; i < seq.length; i++) if (seq[i].props?.[p] !== seq[i - 1].props?.[p]) n++;
      const values = new Set(seq.map((m) => m.props?.[p]));
      return { name: p, n, values };
    }).sort((a, b) => a.n - b.n);
    const stateDesc = transitions.map((t) => ({
      name: t.name,
      type: t.values.size === 2 && (t.values.has('true') || t.values.has('false')) ? 'bool' : 'integer',
      num_values: t.values.size,
    }));
    const span = Math.max(...stateIds) - Math.min(...stateIds) + 1;
    const decoded = stateDesc.reduce((n, d) => n * d.num_values, 1);
    if (span > decoded) {
      const known = new Set(stateDesc.map((d) => d.name));
      for (const p of [...new Set((spec.states ?? []).flatMap((s) => Object.keys(s)))]) {
        if (known.has(p)) continue;
        const values = new Set((spec.states ?? []).map((s) => s[p]).filter((v) => v !== undefined));
        if (values.size > 1) {
          stateDesc.push({ name: p, type: 'bool', num_values: values.size });
          known.add(p);
        }
      }
    }

    const entry = {
      id: nextBlockId++,
      name,
      displayName: manifest.names?.[`block.${name.split(':')[1]}`]?.zh ?? name.split(':')[1],
      hardness: solid ? 1.5 : 0,
      boundingBox: solid ? 'block' : 'empty',
      // 没有碰撞箱 ≠ 挖不动：作物、花、火把都要能挖。canDigBlock 读的就是这个字段。
      diggable: isDiggable(name),
      transparent: !solid,
      material: materialOf(spec.tags ?? []),
      harvestTools: harvestToolsFor(reg, spec.tags ?? []),
      drops: spec.drops ?? [],
      minStateId: Math.min(...stateIds),
      maxStateId: Math.max(...stateIds),
      defaultState: Math.min(...stateIds),
      stackSize: 64,
      states: stateDesc,
    };

    const kept = [];
    for (const id of stateIds) {
      const owner = claimedBy.get(id);
      if (owner !== undefined && owner !== name) continue;  // 别的方块已经占了
      if (owner === undefined) claimedBy.set(id, name);
      kept.push(id);
    }
    if (kept.length === 0) continue;   // 全部被别人占了：这个方块宁可不注入

    entry.minStateId = Math.min(...kept);
    entry.maxStateId = Math.max(...kept);
    entry.defaultState = Math.min(...kept);

    if (shapes) {
      const propsById = new Map(measured.map((m) => [m.stateId, m.props ?? {}]));
      const template = shapeTemplateOf(name);
      const emptyId = nextShapeId++;
      shapes.shapes[emptyId] = [];
      const fallbackId = box ? nextShapeId++ : emptyId;
      if (box) shapes.shapes[fallbackId] = [[box[0], box[1], box[2], box[3], box[4], box[5]]];
      const span = entry.maxStateId - entry.minStateId + 1;
      const stateShapeIds = new Array(span).fill(fallbackId);
      for (const id of kept) {
        const fromTemplate = template ? templateShapeId(reg, template, propsById.get(id)) : null;
        stateShapeIds[id - entry.minStateId] = fromTemplate ?? fallbackId;
      }
      shapes.blocks[name] = stateShapeIds;
      // 模板给出的形状可能让原本 solid:false 的楼梯/台阶有碰撞；以真实形状为准。
      const collides = stateShapeIds.some((id) => (shapes.shapes[id]?.length ?? 0) > 0);
      entry.boundingBox = collides ? 'block' : 'empty';
      entry.transparent = !collides;
    }

    reg.blocks[entry.id] = entry;
    reg.blocksByName[name] = entry;
    reg.blocksArray.push(entry);
    for (const id of kept) reg.blocksByStateId[id] = entry;

    observed.push({ entry, min: entry.minStateId, span: Math.max(kept.length, spec.states?.length ?? 0) });
    blocks++;
    states += kept.length;
  }

  // 实测没覆盖到的状态按区间补齐，别留成"未知方块=空气"。
  //
  // span 用 max(实测条数, 声明状态数)：Fabric 给每个方块的 stateId 是**按声明状态数
  // 连号**的，没量全时它的区间尾巴伸进隔壁方块的地盘——按实测宽度补会把隔壁标成它
  // （实测：三个挂墙告示牌被填成了 gleaming_salad_block）。
  // 但也**不能抢别的方块实测过的 stateId**："错名比未知更糟"，只填没被任何人量到的号。
  const claimed = new Set();
  for (const list of Object.values(ids.blocks ?? {})) {
    for (const m of list) if (m.stateId > 0) claimed.add(m.stateId);
  }
  for (const { entry, min, span } of observed) {
    for (let id = min; id < min + span; id++) {
      if (reg.blocksByStateId[id]) continue;
      if (claimed.has(id)) continue;   // 这一格是别人量到的，别抢
      reg.blocksByStateId[id] = entry;
    }
  }

  let items = 0;
  let nextItemId = Math.max(0, ...Object.keys(reg.items ?? {}).map(Number)) + 1;
  for (const name of Object.keys(manifest.items ?? {})) {
    const id = ids.items?.[name];
    if (typeof id !== 'number' || id <= 0) continue;
    const entry = {
      id,
      name,
      displayName: manifest.names?.[`item.${name.split(':')[1]}`]?.zh
        ?? manifest.names?.[`block.${name.split(':')[1]}`]?.zh
        ?? name.split(':')[1],
      stackSize: manifest.items[name]?.stack ?? 64,
    };
    reg.items[id] = entry;
    reg.itemsByName[name] = entry;
    reg.itemsArray.push(entry);
    items++;
  }
  void nextItemId;

  // 模组食物：不注入的话 skillEat 会一律拒
  if (reg.foodsByName) {
    for (const name of manifest.foods ?? []) {
      if (reg.foodsByName[name]) continue;
      const id = ids.items?.[name];
      if (typeof id !== 'number') continue;
      reg.foodsByName[name] = { id, name, foodPoints: 4, saturation: 0.6, eatingTime: 32 };
    }
  }

  // 模组实体：不注入的话，服务端发来的数字 id 在 mineflayer 里找不到名字，
  // boss 在她眼里就是 "unknown"（实测：Naga 打死她，她连对方叫什么都不知道）。
  // 数字 id 来自 registry-dump（0.1.2 起带 spawnGroup/碰撞箱）；老 dump 只有 id，
  // 那就退回 mob 体型，名字仍然能认出来。
  let entities = 0;
  const seenEntityId = new Map();
  for (const [name, spec] of Object.entries(ids.entities ?? {})) {
    const id = Number(spec?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (reg.entitiesByName?.[name] || reg.entities?.[id] || seenEntityId.has(id)) continue;
    seenEntityId.set(id, name);
    const short = name.split(':')[1] ?? name;
    const group = typeof spec.spawnGroup === 'string' ? spec.spawnGroup : 'misc';
    // 老 dump 没有 spawnGroup：boss 按 hostile 处理（宁可当她该拔刀，也别当成无害动物）
    const type = spec.spawnGroup ? (SPAWN_GROUP_TYPE[group] ?? 'mob')
      : (spec.boss ? 'hostile' : 'mob');
    const entry = {
      id,
      internalId: id,
      name,
      displayName: manifest.names?.[`entity.${short}`]?.zh
        ?? manifest.names?.[`entity.${short}`]?.en
        ?? short,
      width: Number.isFinite(spec.width) ? spec.width : 0.6,
      height: Number.isFinite(spec.height) ? spec.height : 1.8,
      type,
      category: group,
      metadataKeys: [],
      ...(spec.boss ? { boss: true } : {}),
    };
    reg.entities[id] = entry;
    reg.entitiesByName[name] = entry;
    reg.entitiesArray?.push(entry);
    entities++;
  }

  return { blocks, states, items, entities };
}

/**
 * 包流容错：模组改了静态注册表会让 `declare_recipes` 整包错位，不吞掉客户端连不上。
 *
 * 两个必须照抄的细节（踩过）：
 *   a) 要补在 **deserializer** 上，不是 proto 上
 *   b) 每次状态切换 mineflayer 会换掉 deserializer，所以得挂 `client.on('state')` 反复补
 *   c) metadata.size 必须等于本帧长度，否则流会错位
 */
/** 测量机器人额外丢弃的包：protodef 在大 mod 上必炸、而测量流程又不依赖它们。 */
export const MEASURE_DROPS = ['declare_commands', 'entity_metadata'];

export function installMineflayerFixes(bot, opts = {}) {
  const client = bot._client;
  if (!client) return;
  // extraDrop：测量类机器人（calibrate/probe/verify）不依赖命令树与实体元数据，
  // 大 mod（暮色森林实测）在这两类包上会把 protodef 打出 PartialReadError，
  // 不丢掉的话 error 事件会把 spawn 等待挂死。宿主不传这个选项，行为不变。
  const drop = new Set(['declare_recipes', ...(opts.extraDrop ?? [])]);
  const seen = new Set();

  const patch = () => {
    const d = client.deserializer;
    if (!d || d.__modsmithTolerant) return;
    const orig = d.parsePacketBuffer.bind(d);
    d.parsePacketBuffer = (buf) => {
      // 先认包名：服务端真配方只活在这个包里（mineflayer 没有配方插件，prismarine-recipe
      // 用的是静态 registry 数据）。**解析成功也要存** —— mineflayer 哪天修好 1.21.1，
      // 捕获不能跟着静默消失。只存第一份（登录时只有一个 declare_recipes）。
      const name = packetNameOf(bot, buf);
      if (name === 'declare_recipes' && !bot._modsmithDeclareRecipes) {
        bot._modsmithDeclareRecipes = Buffer.from(buf);
      }
      try {
        return orig(buf);
      } catch (err) {
        if (!drop.has(name)) throw err;
        if (!seen.has(name)) {
          seen.add(name);
          console.warn(name === 'declare_recipes'
            ? `丢弃无法解析的 ${name}（${buf.length} 字节）：模组改写了静态注册表；原始包已留存，可用 modsmith recipes 解析`
            : `丢弃无法解析的 ${name}（${buf.length} 字节）：测量机器人不依赖它，丢掉保住读包循环`);
        }
        return {
          data: { name: '_modsmith_dropped', params: {} },
          metadata: { state: client.state, name: '_modsmith_dropped', size: buf.length },
        };
      }
    };
    d.__modsmithTolerant = true;
  };

  patch();

  // 模组自定义窗口：prismarine-windows 不认识就会让 createWindow 返回 null，
  // mineflayer 的 open_window 监听器立刻 `window.id` 崩掉整个进程（Fromage 实测，
  // 探到第 40 个方块时）。窗口类型本身是重要证据——"开了一个未知窗外"要记成
  // 开窗（机制=侧车），不能因为播不出来就当成"不开窗"。
  const emitter = client;
  if (!emitter.__modsmithEmitGuard) {
    const origEmit = emitter.emit.bind(emitter);
    emitter.emit = function guardedEmit(event, ...args) {
      // 只读验收/测量不需要命令树；大 mod 的树会让 minecraft-protocol 直接拒收
      // （"impossible command tree"），在事件层吞掉比让整个 bot 崩掉好。
      if (opts.dropCommands === true && event === 'declare_commands') return false;
      try {
        return origEmit(event, ...args);
      } catch (err) {
        if (event === 'open_window') {
          const type = String(args?.[0]?.inventoryType ?? 'unknown');
          bot._modsmithUnknownWindow = type;
          if (!seen.has(`window:${type}`)) {
            seen.add(`window:${type}`);
            console.warn(`模组自定义窗口类型 ${type}：prismarine-windows 不认识，记为"开窗但界面未知"`);
          }
          return false;
        }
        throw err;
      }
    };
    emitter.__modsmithEmitGuard = true;
  }

  client.on('state', patch);
}

/** 包号 → 名字。协议表用十六进制字符串（"0x77"）做键。 */
function packetNameOf(bot, buf) {
  try {
    // varint 解包号
    let i = 0;
    let id = 0;
    let shift = 0;
    while (i < buf.length) {
      const byte = buf[i++];
      id |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const packet = bot.registry?.protocol?.play?.toClient?.types?.packet;
    const mappings = packet?.[1]?.[0]?.type?.[1]?.mappings ?? {};
    return mappings[`0x${id.toString(16)}`] ?? mappings[String(id)] ?? `packet#${id}`;
  } catch {
    return 'packet#?';
  }
}
