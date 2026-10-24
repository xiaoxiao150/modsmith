/**
 * 服务端真配方：declare_recipes 原始包的解析与翻转（数字 id → 物品名）。
 *
 * 为什么要有这个：mineflayer 没有配方插件（prismarine-recipe 用的是静态 registry 数据），
 * 服务端的真配方表只存在于 declare_recipes 包里——而 1.20.5+ 的 type 字段是**序列化器
 * 注册表的 varint 编号**，minecraft-data 的 mapper 只认 vanilla 的 0–22，模组自定义类型
 * （农夫乐事的 cooking）编号取决于注册顺序，protodef 在第一个未知编号上抛错、整包报废。
 * 容错层把这个包原样存下来（calibrate 落 `<pack>-recipes.raw.bin`），这里按字节解析。
 *
 * 规则（与「错名比未知更糟」一致）：
 *   - vanilla 的 22 种序列化器文法内置（与 minecraft-data 1.21.1 的 protocol.json 逐字段一致）
 *   - 模组自定义类型靠**文法即数据**（sidesheets/<pack>.serializers.json，由 learn 产出或人写）
 *   - 未知编号没有文法、Slot 带组件、任何对不齐 → 中止抛错，绝不出半份解析结果
 *
 * 帧结构（1.21.1）：varint 包号前缀 → varint 条数 → 每条 [string name, varint typeId, payload]。
 * ingredient = varint n × n 个 Slot；Slot = varint itemCount（0=空），
 * 非空再读 varint itemId、added/removed 组件数（非零即中止）。
 */

/** 读取越界/残包的统一错误。 */
export class RecipeParseError extends Error {
  constructor(message, offset) {
    super(`${message}（@${offset}）`);
    this.name = 'RecipeParseError';
    this.offset = offset;
  }
}

/** varint（LEB128，5 字节上限）。 */
function readVarint(buf, off) {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    if (i >= buf.length) throw new RecipeParseError('varint 越界', off);
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift >= 35) throw new RecipeParseError('varint 超过 5 字节', off);
  }
  return { value: value >>> 0, next: i };
}

/** string = varint 长度 + UTF-8。 */
function readString(buf, off) {
  const { value: len, next } = readVarint(buf, off);
  if (next + len > buf.length) throw new RecipeParseError(`string 长度 ${len} 越界`, off);
  return { value: buf.toString('utf8', next, next + len), next: next + len };
}

/** Slot（1.21.1）：itemCount=0 即空；非空读 itemId + 组件数（非零即中止——组件载荷按类型各异，无法盲跳）。 */
function readSlot(buf, off) {
  const itemCount = readVarint(buf, off);
  if (itemCount.value === 0) return { id: 0, count: 0, next: itemCount.next };
  const itemId = readVarint(buf, itemCount.next);
  const added = readVarint(buf, itemId.next);
  const removed = readVarint(buf, added.next);
  if (added.value !== 0 || removed.value !== 0) {
    throw new RecipeParseError(`Slot 带组件（added ${added.value} / removed ${removed.value}）：组件载荷按类型各异，无法盲读`, off);
  }
  // count 是产物数量（一根木头出 4 根木棍就靠它），join 必须保留
  return { id: itemId.value, count: itemCount.value, next: removed.next };
}

/** ingredient = varint n × n 个 Slot，取非空槽的 itemId 列表。 */
function readIngredient(buf, off) {
  const n = readVarint(buf, off);
  const items = [];
  let next = n.next;
  for (let i = 0; i < n.value; i++) {
    const s = readSlot(buf, next);
    if (s.id > 0) items.push(s.id);
    next = s.next;
  }
  return { items, next };
}

/** optional = bool present + 值（1.20.5+ 流式 codec 的可选字段编码）。 */
function readOptionalIngredient(buf, off) {
  if (off >= buf.length) throw new RecipeParseError('optional 标志越界', off);
  const present = buf[off] !== 0;
  if (!present) return { items: [], next: off + 1 };
  return readIngredient(buf, off + 1);
}

/** 字段的快捷构造（都带语义名，join 按 name 取值）。 */
const field = (name, kind) => ({ name, kind });
const S = (name) => field(name, 'string');
const V = (name) => field(name, 'varint');
const SL = (name) => field(name, 'slot');
const ING = (name) => field(name, 'ingredient');

/** vanilla 序列化器文法（编号与 1.21.1 注册顺序一致，来源 minecraft-data protocol.json）。 */
export const VANILLA_SERIALIZERS = {
  0: { name: 'minecraft:crafting_shaped', fields: [S('group'), V('category'), V('gridWidth'), V('gridHeight'), field('grid', 'grid'), SL('result'), field('showNotification', 'bool')] },
  1: { name: 'minecraft:crafting_shapeless', fields: [S('group'), V('category'), field('ingredients', 'ingredients'), SL('result')] },
  2: { name: 'minecraft:crafting_special_armordye', fields: [V('category')] },
  3: { name: 'minecraft:crafting_special_bookcloning', fields: [V('category')] },
  4: { name: 'minecraft:crafting_special_mapcloning', fields: [V('category')] },
  5: { name: 'minecraft:crafting_special_mapextending', fields: [V('category')] },
  6: { name: 'minecraft:crafting_special_firework_rocket', fields: [V('category')] },
  7: { name: 'minecraft:crafting_special_firework_star', fields: [V('category')] },
  8: { name: 'minecraft:crafting_special_firework_star_fade', fields: [V('category')] },
  9: { name: 'minecraft:crafting_special_tippedarrow', fields: [V('category')] },
  10: { name: 'minecraft:crafting_special_bannerduplicate', fields: [V('category')] },
  11: { name: 'minecraft:crafting_special_banneraddpattern', fields: [V('category')] },
  12: { name: 'minecraft:crafting_special_shielddecoration', fields: [V('category')] },
  13: { name: 'minecraft:crafting_special_shulkerboxcoloring', fields: [V('category')] },
  14: { name: 'minecraft:crafting_special_suspiciousstew', fields: [V('category')] },
  15: { name: 'minecraft:smelting', fields: [S('group'), V('category'), ING('ingredient'), SL('result'), field('experience', 'f32'), V('cookTime')] },
  16: { name: 'minecraft:blasting', fields: [S('group'), V('category'), ING('ingredient'), SL('result'), field('experience', 'f32'), V('cookTime')] },
  17: { name: 'minecraft:smoking', fields: [S('group'), V('category'), ING('ingredient'), SL('result'), field('experience', 'f32'), V('cookTime')] },
  18: { name: 'minecraft:campfire_cooking', fields: [S('group'), V('category'), ING('ingredient'), SL('result'), field('experience', 'f32'), V('cookTime')] },
  19: { name: 'minecraft:stonecutting', fields: [S('group'), ING('ingredient'), SL('result')] },
  20: { name: 'minecraft:smithing_transform', fields: [ING('template'), ING('base'), ING('addition'), SL('result')] },
  21: { name: 'minecraft:smithing_trim', fields: [ING('template'), ING('base'), ING('addition')] },
  22: { name: 'minecraft:crafting_decorated_pot', fields: [V('category')] },
};

/** 按 vanilla 编号取名字；未知编号返回 undefined（调用方查文法数据）。 */
export function vanillaNameOf(typeId) {
  return VANILLA_SERIALIZERS[typeId]?.name;
}

/** 读一个文法字段到 data，返回新的偏移。所有 kind 的唯一分发点。 */
function readOne(buf, cur, f, data) {
  const key = f.name ?? `f${Object.keys(data).length}`;
  if (f.kind === 'varint') {
    const r = readVarint(buf, cur); data[key] = r.value; return r.next;
  }
  if (f.kind === 'string') {
    const r = readString(buf, cur); data[key] = r.value; return r.next;
  }
  if (f.kind === 'bool') {
    if (cur >= buf.length) throw new RecipeParseError('bool 越界', cur);
    data[key] = buf[cur] !== 0; return cur + 1;
  }
  if (f.kind === 'f32') {
    if (cur + 4 > buf.length) throw new RecipeParseError('f32 越界', cur);
    data[key] = buf.readFloatBE(cur); return cur + 4;  // Minecraft 网络数值字段是大端
  }
  if (f.kind === 'slot') {
    const r = readSlot(buf, cur); data[key] = { id: r.id, count: r.count }; return r.next;
  }
  if (f.kind === 'ingredient') {
    const r = readIngredient(buf, cur); data[key] = r.items; return r.next;
  }
  if (f.kind === 'optional-ingredient') {
    const r = readOptionalIngredient(buf, cur); data[key] = r.items; return r.next;
  }
  if (f.kind === 'optional-identifier') {
    if (cur >= buf.length) throw new RecipeParseError('optional 标志越界', cur);
    if (buf[cur] === 0) { data[key] = null; return cur + 1; }
    const r = readString(buf, cur + 1); data[key] = r.value; return r.next;
  }
  if (f.kind === 'list') {
    // varint n + n × 子字段组（如 ChanceResult = [slot, f32]）
    const n = readVarint(buf, cur);
    const list = [];
    let p = n.next;
    for (let k = 0; k < n.value; k++) {
      const item = {};
      for (const sub of f.item) p = readOne(buf, p, sub, item);
      list.push(item);
    }
    data[key] = list; return p;
  }
  if (f.kind === 'ingredients') {
    // shapeless：varint n × n 个 ingredient
    const n = readVarint(buf, cur);
    const list = [];
    let p = n.next;
    for (let k = 0; k < n.value; k++) {
      const r = readIngredient(buf, p);
      list.push(r.items); p = r.next;
    }
    data[key] = list; return p;
  }
  if (f.kind === 'grid') {
    // shaped：gridWidth × gridHeight 个 ingredient（先宽后高）
    const w = data.gridWidth ?? 0;
    const h = data.gridHeight ?? 0;
    const grid = [];
    let p = cur;
    for (let x = 0; x < w; x++) {
      const col = [];
      for (let y = 0; y < h; y++) {
        const r = readIngredient(buf, p);
        col.push(r.items); p = r.next;
      }
      grid.push(col);
    }
    data[key] = grid; return p;
  }
  throw new RecipeParseError(`不认识的文法类型 ${f.kind}`, cur);
}

/**
 * 解析 declare_recipes 帧（parsePacketBuffer 的输入，含 varint 包号前缀）。
 *
 * @param {Buffer} buf 原始帧
 * @param {{serializers?: Record<string, Array<{name: string, type: string}>>}} opts
 *   serializers：模组自定义类型的文法，键是数字编号（字符串键）。没有文法的编号 → 中止。
 * @returns {{recipes: Array<{name: string, type: string, typeId: number, data: object}>, customTypes: number[]}}
 */
export function parseDeclareRecipes(buf, opts = {}) {
  const serializers = opts.serializers ?? {};
  const head = readVarint(buf, 0);          // 包号前缀（packetNameOf 读的就是它）
  const count = readVarint(buf, head.next);
  const recipes = [];
  const customTypes = [];
  let off = count.next;

  for (let i = 0; i < count.value; i++) {
    const name = readString(buf, off);
    const typeId = readVarint(buf, name.next);
    const grammar = VANILLA_SERIALIZERS[typeId.value]
      ?? (serializers[String(typeId.value)]
        ? { name: serializers[String(typeId.value)].name ?? `#${typeId.value}`, fields: serializers[String(typeId.value)].fields ?? serializers[String(typeId.value)] }
        : undefined);
    if (!grammar) {
      throw new RecipeParseError(`未知序列化器编号 ${typeId.value}（配方 ${name.value}）：没有文法无法对齐，需要 sidesheets 的 serializers 文法`, off);
    }
    if (!VANILLA_SERIALIZERS[typeId.value]) customTypes.push(typeId.value);

    const data = {};
    let cur = typeId.next;
    try {
      for (const f of grammar.fields) cur = readOne(buf, cur, f, data);
    } catch (err) {
      if (err instanceof RecipeParseError) {
        const prev = recipes.at(-1);
        err.message = `${err.message}；当前配方 ${name.value}（#${typeId.value} ${grammar.name}）`
          + `；此前已解析 ${recipes.length} 条，上一条 ${prev ? prev.name : '(无)'}`;
      }
      throw err;
    }
    recipes.push({ name: name.value, type: grammar.name, typeId: typeId.value, data });
    off = cur;
  }
  if (off !== buf.length) {
    throw new RecipeParseError(`解析结束但还剩 ${buf.length - off} 字节（条数或文法不对）`, off);
  }
  return { recipes, customTypes: [...new Set(customTypes)] };
}
