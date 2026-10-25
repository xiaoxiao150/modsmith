/**
 * 带组件的 Slot 读取：把 minecraft-data 1.21.1 协议里的 SlotComponent 编解码定义
 * 解释成字节读取器（container/array/option/mapper/switch/NBT 的一个小解释器）。
 *
 * 为什么要有这个：1.20.5+ 的物品槽可以带数据组件（附魔、药水内容、custom_data…），
 * 组件载荷按类型各异——FD 时代"无法盲读"就中止，暮色森林的装备配方全带组件，
 * 这一格不打通整包配方就死了。手写 56 种组件编解码太重，借 minecraft-data 的
 * 协议定义（mineflayer 自带，无新依赖）现场解释。
 *
 * 只解析到"能跳过/能读出"的程度，组件的语义值不深究（测量流程用不到）。
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { readVarint, readString } from './recipes.mjs';

class ProtoReadError extends Error {}

const req = createRequire(import.meta.url);

/** 网络 NBT（1.20.5+）：字符串是 varint 长度（不是 u16），根标签无名字。只跳不解析。 */
function skipNbt(buf, off) {
  let p = off;
  if (p >= buf.length) throw new ProtoReadError('NBT 越界');
  const type = buf[p++];
  return skipNbtPayload(buf, p, type);
}

function skipNbtPayload(buf, p, type) {
  const rdStr = () => {
    const { value: len, next } = readVarint(buf, p);
    p = next + len;
    if (p > buf.length) throw new ProtoReadError('NBT 字符串越界');
    return p;
  };
  switch (type) {
    case 0: return p;                        // TAG_End（复合体结尾）
    case 1: case 2: case 3: case 4: case 5: case 6: return p + [1, 2, 4, 8, 4, 8][type - 1];
    case 7: {                                 // byte array: i32 长度
      if (p + 4 > buf.length) throw new ProtoReadError('NBT 字节数组越界');
      const n = buf.readInt32BE(p); return p + 4 + n;
    }
    case 8: return rdStr();                   // string（varint 长度）
    case 9: {                                 // list: 类型 + i32 数量 + 载荷
      if (p + 5 > buf.length) throw new ProtoReadError('NBT 列表越界');
      const el = buf[p]; const n = buf.readInt32BE(p + 1); p += 5;
      for (let i = 0; i < n; i++) p = skipNbtPayload(buf, p, el);
      return p;
    }
    case 10: {                                // compound: 命名标签 + TAG_End
      for (;;) {
        if (p >= buf.length) throw new ProtoReadError('NBT 复合体越界');
        const el = buf[p++];
        if (el === 0) return p;
        p = rdStr();
        p = skipNbtPayload(buf, p, el);
      }
    }
    case 11: {                                // int array
      if (p + 4 > buf.length) throw new ProtoReadError('NBT int 数组越界');
      const n = buf.readInt32BE(p); return p + 4 + n * 4;
    }
    case 12: {                                // long array
      if (p + 4 > buf.length) throw new ProtoReadError('NBT long 数组越界');
      const n = buf.readInt32BE(p); return p + 4 + n * 8;
    }
    default: throw new ProtoReadError(`未知 NBT 标签类型 ${type}`);
  }
}

/** protodef 原生标量的读取。 */
function readNative(kind, buf, p) {
  switch (kind) {
    case 'varint': { const r = readVarint(buf, p); return { value: r.value, next: r.next }; }
    case 'bool': return { value: buf[p] !== 0, next: p + 1 };
    case 'i8': return { value: buf.readInt8(p), next: p + 1 };
    case 'u8': return { value: buf.readUInt8(p), next: p + 1 };
    case 'i16': return { value: buf.readInt16BE(p), next: p + 2 };
    case 'u16': return { value: buf.readUInt16BE(p), next: p + 2 };
    case 'i32': return { value: buf.readInt32BE(p), next: p + 4 };
    case 'u32': return { value: buf.readUInt32BE(p), next: p + 4 };
    case 'i64': return { value: Number(buf.readBigInt64BE(p)), next: p + 8 };
    case 'f32': return { value: buf.readFloatBE(p), next: p + 4 };
    case 'f64': return { value: buf.readDoubleBE(p), next: p + 8 };
    case 'string': { const r = readString(buf, p); return { value: r.value, next: r.next }; }
    case 'void': return { value: undefined, next: p };
    default: throw new ProtoReadError(`解释器不认识的原生类型 ${kind}`);
  }
}

/** 1.21.1 里以 "native" 占位、由 minecraft-protocol 注册的固定宽度类型。 */
function readRegisteredNative(kind, buf, p) {
  if (kind === 'UUID') return { value: null, next: p + 16 };
  throw new ProtoReadError(`解释器不认识的 native 类型 ${kind}`);
}

/**
 * 把 protodef 类型定义解释成读取器。registry 提供具名类型（ItemPotionEffect 之类），
 * ctx 是 container 内已读字段（switch 按 compareTo 取）。
 * @returns {{ value: any, next: number }}
 */
function readProtoType(def, buf, p, ctx, registry, depth) {
  if (depth > 24) throw new ProtoReadError('组件解析递归过深');
  if (typeof def === 'string') {
    if (def === 'anonymousNbt') return { value: null, next: skipNbt(buf, p) };
    if (def === 'anonOptionalNbt') {
      // 可选 NBT：先读标签类型，0 = TAG_End 表示没有
      if (p >= buf.length) throw new ProtoReadError('anonOptionalNbt 越界');
      return { value: null, next: buf[p] === 0 ? p + 1 : skipNbt(buf, p) };
    }
    if (['varint', 'bool', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'f32', 'f64', 'string', 'void'].includes(def)) {
      return readNative(def, buf, p);
    }
    if (def === 'native') throw new ProtoReadError('native 占位没经过 registry');
    // 具名类型（SlotComponentType、ItemPotionEffect…）在 registry 里
    if (registry[def] !== undefined) {
      if (registry[def] === 'native') return readRegisteredNative(def, buf, p);
      return readProtoType(registry[def], buf, p, ctx, registry, depth + 1);
    }
    throw new ProtoReadError(`解释器不认识的原生类型 ${def}`);
  }
  const [kind, param] = def;
  switch (kind) {
    case 'container': {
      // switch 的 compareTo 引用同容器字段（先读 mapper 再 switch），用原型链透传外层
      const local = Object.create(ctx ?? Object.prototype);
      let cur = p;
      for (const f of param) {
        const r = readProtoType(f.type, buf, cur, local, registry, depth + 1);
        if (f.name) local[f.name] = r.value; else Object.assign(local, r.value ?? {});
        cur = r.next;
      }
      return { value: local, next: cur };
    }
    case 'array': {
      let count;
      let cur = p;
      if (typeof param.count === 'string') {
        // protodef 允许 count 引用同容器字段（Slot 的 components 用 addedComponentCount）
        count = Number(ctx?.[param.count] ?? 0);
      } else if (param.count !== undefined) count = param.count;
      else if (param.countType) {
        const r = readNative(param.countType, buf, cur); count = r.value; cur = r.next;
      } else throw new ProtoReadError('array 缺少 count/countType');
      const out = [];
      for (let i = 0; i < count; i++) {
        const r = readProtoType(param.type, buf, cur, ctx, registry, depth + 1);
        out.push(r.value); cur = r.next;
      }
      return { value: out, next: cur };
    }
    case 'option': {
      const inner = Array.isArray(param) || typeof param === 'string' ? param : param.type;
      if (buf[p] === 0) return { value: null, next: p + 1 };
      return readProtoType(inner, buf, p + 1, ctx, registry, depth + 1);
    }
    case 'bitfield': {
      const bits = param.reduce((n, f) => n + f.size, 0);
      return { value: null, next: p + Math.ceil(bits / 8) };
    }
    case 'registryEntryHolderSet': {
      // 协议里唯一的用法是 IDSet（can_place_on / tool.rules.blocks）：varint n，
      // n=0 时读一个注册名，否则读 n-1 个 id
      const n = readVarint(buf, p);
      if (n.value === 0) {
        const name = readProtoType(param.base.type, buf, n.next, ctx, registry, depth + 1);
        return { value: { [param.base.name]: name.value }, next: name.next };
      }
      let cur = n.next;
      const ids = [];
      for (let i = 0; i < n.value - 1; i++) {
        const r = readProtoType(param.otherwise.type, buf, cur, ctx, registry, depth + 1);
        ids.push(r.value); cur = r.next;
      }
      return { value: { [param.otherwise.name]: ids }, next: cur };
    }
    case 'mapper': {
      const r = readVarint(buf, p);
      const name = param.mappings[String(r.value)];
      if (name === undefined) throw new ProtoReadError(`mapper 不认识的枚举值 ${r.value}`);
      return { value: name, next: r.next };
    }
    case 'switch': {
      const target = ctx[param.compareTo];
      const picked = param.fields?.[target] ?? param.default;
      if (picked === undefined) throw new ProtoReadError(`switch 没有 ${param.compareTo}=${target} 的分支`);
      return readProtoType(picked, buf, p, ctx, registry, depth + 1);
    }
    default:
      if (registry[kind]) return readProtoType(registry[kind], buf, p, ctx, registry, depth + 1);
      throw new ProtoReadError(`解释器不认识的类型定义 ${kind}`);
  }
}

let cached = null;

/** 从 minecraft-data 拿组件编解码定义；拿不到返回 null（调用方保持旧的严格报错）。 */
function componentRegistry() {
  if (cached !== null) return cached;
  try {
    let data;
    try {
      data = req('minecraft-data');
    } catch {
      // modsmith 不直接依赖 minecraft-data；mineflayer 自带的那份也能用，
      // 从 mineflayer 的安装位置建 require（不能拿文件路径当 paths 起点）。
      const viaMineflayer = createRequire(`${dirname(req.resolve('mineflayer'))}/`);
      data = viaMineflayer('minecraft-data');
    }
    const types = data('1.21.1').protocol.types;
    const swDef = types.SlotComponent[1].find((f) => f.name === 'data');
    const codecByName = swDef.type[1].fields;
    // minecraft-data 3.112.0 的 1.21.1 定义把 1.21.2+ 才有的 customName 也挂进了
    // potion_contents；真实 1.21.1 服务端写到 customEffects 就结束（暮色森林的
    // tannin 配方首格是水瓶，逐字节核实过）。按服务端裁掉——错名比未知更糟。
    if (codecByName.potion_contents?.[1]) {
      codecByName.potion_contents[1] = codecByName.potion_contents[1].filter((f) => f.name !== 'customName');
    }
    const mapper = types.SlotComponentType[1].mappings;
    const idToName = Object.fromEntries(Object.entries(mapper).map(([k, v]) => [Number(k), v]));
    // 具名类型注册表：组件里引用的 ItemPotionEffect/Slot 等都从这里解
    const registry = { ...types };
    cached = { codecByName, idToName, registry };
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * 组件类型名 → 线上编号（测试与诊断用；编号来自 minecraft-data 的 mapper）。
 * @returns {number|undefined}
 */
export function componentTypeId(name) {
  const table = componentRegistry();
  if (!table) return undefined;
  return Object.entries(table.idToName).find(([, n]) => n === name)?.[0] | 0;
}

/**
 * 读一个带组件的 Slot（从 itemCount 起整段吃掉，含组件载荷）。
 * 返回 { id, count, next }，与 readSlot 同形；解析不了抛 Error（调用方决定致命与否）。
 */
export function readSlotWithComponents(buf, off) {
  const table = componentRegistry();
  if (!table) throw new Error('minecraft-data 不可用：组件槽位无法解析');
  let p = off;
  const count = readVarint(buf, p); p = count.next;
  if (count.value === 0) return { id: 0, count: 0, next: p };
  const item = readVarint(buf, p); p = item.next;
  const added = readVarint(buf, p); p = added.next;
  const removed = readVarint(buf, p); p = removed.next;
  for (let i = 0; i < added.value; i++) {
    const r = readProtoType(
      ['container', [{ name: 'type', type: 'SlotComponentType' }, { name: 'data', type: ['switch', { compareTo: 'type', fields: table.codecByName }] }]],
      buf, p, {}, table.registry, 0,
    );
    if (process.env.MODSMITH_COMPONENT_TRACE) console.error(`[comp] ${r.value.type} ${p}..${r.next}`);    p = r.next;
  }
  for (let i = 0; i < removed.value; i++) {
    const r = readVarint(buf, p); p = r.next;
  }
  return { id: item.value, count: count.value, next: p };
}
