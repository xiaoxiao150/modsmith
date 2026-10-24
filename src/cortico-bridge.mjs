/**
 * modsmith 自带的最小注册表注入。
 *
 * 为什么要重写而不 import Cortico 的：modsmith 是能独立拿出去用的工具，不该反向依赖
 * 某个具体项目。这里只做 probe 需要的两件事：让 `bot.blockAt` 认得出模组方块、让它
 * 知道模组物品的数字 id。
 *
 * 注入时机同样必须在 `inject_allowed` 之前——prismarine-block 的工厂只在那时拷一次
 * boundingBox/shapes。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
 * 把 manifest + 实测 id 合并进 bot.registry。
 * 返回注入的方块/状态/物品数，供日志。
 */
/** 从方块 tags 推 prismarine material：挖速/工具判定用，推不出就 default。 */
function materialOf(tags) {
  for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe', 'shears']) {
    if (tags.includes(`mineable/${kind}`)) return `mineable/${kind}`;
  }
  return 'default';
}

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
   * 方块挤在 26979 上）。如果照单全收，后处理的方块会覆盖前者 —— 她看见米捆，实际是橱柜。
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
      diggable: solid,
      transparent: !solid,
      material: materialOf(spec.tags ?? []),
      harvestTools: {},
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

    reg.blocks[entry.id] = entry;
    reg.blocksByName[name] = entry;
    reg.blocksArray.push(entry);
    for (const id of kept) reg.blocksByStateId[id] = entry;

    if (shapes) {
      const shape = box ? [[box[0], box[1], box[2], box[3], box[4], box[5]]] : [];
      const shapeId = nextShapeId++;
      shapes.shapes[shapeId] = shape;
      shapes.blocks[name] = kept.map(() => shapeId);
    }
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

  return { blocks, states, items };
}

/**
 * 包流容错：模组改了静态注册表会让 `declare_recipes` 整包错位，不吞掉客户端连不上。
 *
 * 两个必须照抄的细节（踩过）：
 *   a) 要补在 **deserializer** 上，不是 proto 上
 *   b) 每次状态切换 mineflayer 会换掉 deserializer，所以得挂 `client.on('state')` 反复补
 *   c) metadata.size 必须等于本帧长度，否则流会错位
 */
export function installMineflayerFixes(bot) {
  const client = bot._client;
  if (!client) return;
  const drop = new Set(['declare_recipes']);
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
          console.warn(`丢弃无法解析的 ${name}（${buf.length} 字节）：模组改写了静态注册表${name === 'declare_recipes' ? '；原始包已留存，可用 modsmith recipes 解析' : ''}`);
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
