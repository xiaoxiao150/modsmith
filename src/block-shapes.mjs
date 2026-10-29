/**
 * 方块碰撞/工具的唯一一份推导规则。
 *
 * 三个消费者必须共用：
 *   - `inspect`：从模组 jar 的模型 parent 推 manifest 的 box/solid；
 *   - `cortico-bridge`：把 manifest + 实测 id 注入 prismarine registry；
 *   - `conformance`：接包验收，检查「声明的每个 state 真的有形状/能挖」。
 *
 * 以前 inspect 和 host 各写一份，于是 TF 的 `canopy_planks` 在清单里是实心、
 * 注入后却是空气。规则只留这一份，测试也只钉这一份。
 */

/** 这些方块不是"挖"的对象；其余模组方块默认都能挖（作物/花没有碰撞箱，但能挖）。 */
export const NOT_DIGGABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'bedrock', 'barrier', 'light',
  'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block',
  'structure_void', 'jigsaw', 'end_portal', 'end_portal_frame', 'nether_portal',
  'moving_piston', 'reinforced_deepslate',
]);

export function isDiggable(name) {
  return !NOT_DIGGABLE.has(String(name).split(':')[1] ?? name);
}

/** 从 elements 里算整体包围盒（0..1 归一化，跟 prismarine 的 box 一致）。 */
export function boxFromElements(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const el of elements) {
    const [a, b] = el.from ?? [0, 0, 0];
    const [c, d, e] = el.to ?? [16, 16, 16];
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); z0 = Math.min(z0, c);
    x1 = Math.max(x1, c); y1 = Math.max(y1, d); z1 = Math.max(z1, e);
  }
  if (!Number.isFinite(x0)) return null;
  return [x0 / 16, y0 / 16, z0 / 16, x1 / 16, y1 / 16, z1 / 16];
}

/**
 * 原版 parent 在服务器 jar 里，模组只写 `parent: minecraft:block/cube_all`。
 * 这些 parent 的名字就够定碰撞盒；没有它，整块木板会被当成空气（TF 实测：
 * canopy_planks 变成 solid:false，机器人直接穿地板）。
 */
const VANILLA_PARENT_BOX = {
  'block/block': [0, 0, 0, 1, 1, 1],
  'builtin/entity': [0, 0, 0, 1, 1, 1],
  'block/chest': [0, 0, 0, 1, 1, 1],
  'block/bookshelf': [0, 0, 0, 1, 1, 1],
  'block/chiseled_bookshelf': [0, 0, 0, 1, 1, 1],
  'block/cube': [0, 0, 0, 1, 1, 1],
  'block/cube_all': [0, 0, 0, 1, 1, 1],
  'block/cube_bottom_top': [0, 0, 0, 1, 1, 1],
  'block/cube_column': [0, 0, 0, 1, 1, 1],
  'block/cube_column_horizontal': [0, 0, 0, 1, 1, 1],
  'block/cube_directional': [0, 0, 0, 1, 1, 1],
  'block/cube_mirrored': [0, 0, 0, 1, 1, 1],
  'block/cube_mirrored_all': [0, 0, 0, 1, 1, 1],
  'block/orientable': [0, 0, 0, 1, 1, 1],
  'block/orientable_with_bottom': [0, 0, 0, 1, 1, 1],
  'block/orientable_vertical': [0, 0, 0, 1, 1, 1],
  'block/leaves': [0, 0, 0, 1, 1, 1],
  'block/stairs': [0, 0, 0, 1, 0.5, 1],
  'block/slab': [0, 0, 0, 1, 0.5, 1],
  'block/slab_top': [0, 0.5, 0, 1, 1, 1],
  'block/fence_post': [0.375, 0, 0.375, 0.625, 1, 0.625],
  'block/fence_side': [0.375, 0, 0.375, 0.625, 1, 0.625],
  'block/wall_post': [0.25, 0, 0.25, 0.75, 1, 0.75],
  'block/wall_side': [0.25, 0, 0.25, 0.75, 1, 0.75],
  'block/trapdoor_bottom': [0, 0, 0, 1, 0.1875, 1],
  'block/trapdoor_top': [0, 0, 0, 1, 0.1875, 1],
  'block/template_orientable_trapdoor_bottom': [0, 0, 0, 1, 0.1875, 1],
  'block/template_orientable_trapdoor_top': [0, 0, 0, 1, 0.1875, 1],
  'block/template_orientable_trapdoor_open': [0, 0, 0, 1, 1, 0.1875],
  'block/template_fence_gate': [0, 0, 0, 1, 1, 0.375],
  'block/template_fence_gate_open': [0, 0, 0, 1, 1, 0.375],
  'block/template_fence_gate_wall': [0, 0, 0, 1, 1, 0.375],
  'block/template_fence_gate_wall_open': [0, 0, 0, 1, 1, 0.375],
  'block/door_bottom_left': [0, 0, 0, 1, 1, 0.1875],
  'block/door_bottom_right': [0, 0, 0, 1, 1, 0.1875],
  'block/pane_post': [0.4375, 0, 0.4375, 0.5625, 1, 0.5625],
  'block/pane_side': [0.4375, 0, 0.4375, 0.5625, 1, 0.5625],
  'block/template_glass_pane_post': [0.4375, 0, 0.4375, 0.5625, 1, 0.5625],
  'block/template_glass_pane_side': [0.4375, 0, 0.4375, 0.5625, 1, 0.5625],
  'block/template_glass_pane_side_alt': [0.4375, 0, 0.4375, 0.5625, 1, 0.5625],
  'block/template_glass_pane_noside': [0.4375, 0, 0.4375, 0.5625, 1, 0.5625],
  'block/template_glass_pane_noside_alt': [0.4375, 0, 0.4375, 0.5625, 1, 0.5625],
  'block/carpet': [0, 0, 0, 1, 0.0625, 1],
  'block/pressure_plate_up': [0, 0, 0, 1, 0.0625, 1],
  'block/pressure_plate_down': [0, 0, 0, 1, 0.0625, 1],
};

export function vanillaParentBox(ref) {
  const name = String(ref ?? '').replace(/^minecraft:/, '');
  return VANILLA_PARENT_BOX[name] ?? null;
}

/** 模型链走到底：先找 elements；没有就看原版 parent 名推一个保守碰撞盒。 */
export function boxForRef(materials, ref, depth = 0) {
  if (!ref || depth > 8) return null;
  const name = ref.includes(':') ? ref.split(':')[1] : ref;
  const ns = ref.includes(':') ? ref.split(':')[0] : null;
  const candidates = ns ? [`assets/${ns}/models/${name}.json`] : [`assets/__NS__/models/${name}.json`];
  let json = null;
  for (const c of candidates) {
    json = materials.readJson(c);
    if (json) break;
  }
  if (!json) return vanillaParentBox(ref);
  const own = boxFromElements(json.elements);
  if (own) return own;
  if (json.parent) {
    const inherited = boxForRef(materials, json.parent, depth + 1);
    if (inherited) return inherited;
  }
  return vanillaParentBox(ref);
}

/**
 * 非整块方块的碰撞形状不能统一用一个 box：楼梯的上/下半、台阶的朝向都不同。
 * 原版 registry 已经带每种 state 的 shape id；按名字给模组方块找同族模板，
 * 再用 state 属性映射到模板的具体 state。找不到模板就退回清单里的 box。
 */
export function shapeTemplateOf(name) {
  const short = name.split(':')[1] ?? name;
  if (/_trapdoor/.test(short)) return 'oak_trapdoor';
  if (/_fence_gate/.test(short)) return 'oak_fence_gate';
  if (/_fence/.test(short)) return 'oak_fence';
  if (/_stairs/.test(short)) return 'oak_stairs';
  if (/_slab/.test(short)) return 'oak_slab';
  if (/_wall$/.test(short)) return 'cobblestone_wall';
  if (/_door/.test(short)) return 'oak_door';
  if (/_pane/.test(short)) return 'glass_pane';
  if (/_carpet/.test(short)) return 'white_carpet';
  if (/_button/.test(short)) return 'oak_button';
  if (/_pressure_plate/.test(short)) return 'oak_pressure_plate';
  return null;
}

/** 把模组 state 的属性映射到模板 state 的 shape id；映射不了返回 null。 */
export function templateShapeId(reg, templateName, props) {
  const tpl = reg.blocksByName?.[templateName];
  const ids = reg.blockCollisionShapes?.blocks?.[templateName];
  if (!Array.isArray(tpl?.states) || !Array.isArray(ids)) return null;
  // 状态索引是**最后一个属性最快变化**（与 registry 的 stateId 顺序一致）：
  // index = ((type * 2) + waterlogged)，不是 waterlogged * 3 + type。
  // 之前按第一个属性最快算，oak_slab 的 top 拿到了下半砖形状、bottom 拿到上半砖形状
  // （楼梯同理）——形状非空，所以只查"非空"的检查全放过了它。
  let index = 0;
  for (const desc of tpl.states) {
    const raw = props?.[desc.name];
    let value;
    if (Array.isArray(desc.values)) {
      value = desc.values.indexOf(String(raw));
      if (value < 0) return null;
    } else if (desc.type === 'bool') {
      value = String(raw) === 'true' ? 1 : 0;
    } else {
      if (raw === undefined) return null;
      value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value >= desc.num_values) return null;
    }
    index = index * desc.num_values + value;
  }
  return ids[index] ?? null;
}

/** 从方块 tags 推 harvestTools：矿石/木头这类要工具，作物/植物用手就行。 */
export function harvestToolsFor(reg, tags) {
  const template = tags.includes('mineable/pickaxe') ? 'stone'
    : tags.includes('mineable/axe') ? 'oak_log'
      : tags.includes('mineable/shovel') ? 'dirt'
        : tags.includes('mineable/hoe') ? 'oak_leaves'
          : null;
  return template ? (reg.blocksByName?.[template]?.harvestTools ?? null) : null;
}