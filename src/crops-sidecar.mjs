/**
 * 作物 sidecar：人手纠正自动推断的地方。
 *
 * 推断能覆盖大部分情况，但命名不规则时会长出 `tomatoe_seeds` 这种假种子，或者把同一
 * 作物的中间形态当成独立作物。sidecar 是唯一可信的覆盖层，格式就是一小组 JSON：
 *
 *   {
 *     "tomatoes":   { "seed": "tomato_seeds", "max_age": 3, "age_prop": "age",
 *                     "soils": ["minecraft:farmland", "farmersdelight:rich_soil_farmland"],
 *                     "aliases": ["budding_tomatoes", "tomatoes_on_rope"] },
 *     "onions":     { "seed": "onion", "max_age": 7, ... },
 *     "_drop":      ["budding_tomatoes", "tomatoes_on_rope", "rice_panicles"]
 *   }
 *
 * `_drop` 里的方块从推断结果里删掉（它们只是别名，不该独立成作物）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** 给某个 mod 生成的 sidecar 模板：把推断结果和自己列出来，人改哪个都行。 */
export function sidecarTemplateFrom(manifest) {
  const crops = {};
  for (const [key, spec] of Object.entries(manifest.crops ?? {})) {
    const { _inferred, _source, ...rest } = spec;
    crops[key] = rest;
  }
  return { _drop: [], ...crops };
}

export function readSidecar(file) {
  if (!file || !existsSync(file)) return { sidecar: {}, drop: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) ?? {};
    const { _drop, ...rest } = raw;
    // 下划线开头的都是注释/元数据，不是作物
    const sidecar = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k.startsWith('_')) continue;
      sidecar[k] = v;
    }
    return { sidecar, drop: Array.isArray(_drop) ? _drop : [] };
  } catch (err) {
    throw new Error(`sidecar 读不了（${file}）：${err.message}`);
  }
}

export function writeSidecar(file, obj) {
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}
