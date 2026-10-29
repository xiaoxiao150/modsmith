/**
 * Manifest 校验器 —— 和宿主侧 `mod-manifest.ts` 同一套规则，去掉 TS 类型。
 *
 * 为什么随包发这份：任何 mineflayer 项目只要读 `<pack>.json` + `<pack>-ids.json`
 * 两个文件就能用，那么"这两个文件长什么样"的规范必须跟包一起走，不能只存在于
 * 某个宿主项目的源码里。
 *
 * 分两级：
 *   error —— 这份清单用不了（缺必填、类型错）
 *   warn  —— 能用，但效果会打折（没站点、没提示词）
 */

const STATION_KINDS = ['two-step-use', 'place-and-wait', 'sidecar-recipe'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @returns {Array<{level: 'error'|'warn', path: string, message: string}>}
 */
export function validateManifest(raw) {
  const issues = [];
  const err = (path, message) => issues.push({ level: 'error', path, message });
  const warn = (path, message) => issues.push({ level: 'warn', path, message });

  if (!isObject(raw)) {
    err('', 'manifest 不是一个对象');
    return issues;
  }

  for (const key of ['mod', 'version']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) err(key, `缺必填字段 ${key}（字符串）`);
  }
  for (const key of ['blocks', 'items', 'crops', 'names']) {
    if (!isObject(raw[key])) err(key, `缺必填字段 ${key}（对象）`);
  }
  if (!Array.isArray(raw.recipes)) err('recipes', '缺必填字段 recipes（数组）');

  if (raw.namespace !== undefined) {
    if (typeof raw.namespace !== 'string' || !/^[a-z0-9_]+$/.test(raw.namespace)) {
      err('namespace', 'namespace 只能是小写字母、数字、下划线');
    }
  } else {
    warn('namespace', '没写 namespace，读取方会从方块名前缀推；生成时写死更稳');
  }

  if (isObject(raw.blocks)) {
    for (const [name, spec] of Object.entries(raw.blocks)) {
      if (!name.includes(':')) err(`blocks.${name}`, '方块名要带命名空间（ns:name）');
      if (!isObject(spec)) { err(`blocks.${name}`, '方块规格不是对象'); continue; }
      if (!Array.isArray(spec.states)) err(`blocks.${name}.states`, 'states 要是数组');
      if (typeof spec.solid !== 'boolean') err(`blocks.${name}.solid`, 'solid 要是布尔值');
      if (spec.solid && spec.box != null && (!Array.isArray(spec.box) || spec.box.length !== 6)) {
        err(`blocks.${name}.box`, 'box 要是 6 个数字或 null');
      }
    }
  }

  if (isObject(raw.items)) {
    for (const name of Object.keys(raw.items)) {
      if (!name.includes(':')) err(`items.${name}`, '物品名要带命名空间（ns:name）');
    }
  }

  if (isObject(raw.crops)) {
    for (const [name, spec] of Object.entries(raw.crops)) {
      const at = `crops.${name}`;
      if (!isObject(spec)) { err(at, '作物规格不是对象'); continue; }
      if (typeof spec.seed !== 'string' || !spec.seed) err(`${at}.seed`, 'seed 必填（字符串）');
      if (typeof spec.max_age !== 'number' || spec.max_age < 0) err(`${at}.max_age`, 'max_age 要是非负数字');
      if (typeof spec.age_prop !== 'string' || !spec.age_prop) err(`${at}.age_prop`, 'age_prop 必填（字符串）');
      if (!Array.isArray(spec.soils) || spec.soils.length === 0) err(`${at}.soils`, 'soils 要是非空数组');
      if (spec.kind !== undefined && !['age-property', 'stage-blocks'].includes(spec.kind)) {
        err(`${at}.kind`, 'kind 只认 age-property / stage-blocks');
      }
      if (spec.kind === 'stage-blocks' && !isObject(spec.stages)) {
        err(`${at}.stages`, 'stage-blocks 型作物要给 stages（级号 → 方块名）');
      }
    }
  }

  if (raw.stations !== undefined) {
    if (!Array.isArray(raw.stations)) {
      err('stations', 'stations 要是数组');
    } else {
      const seen = new Set();
      raw.stations.forEach((s, i) => {
        const at = `stations[${i}]`;
        if (!isObject(s)) { err(at, '站点定义不是对象'); return; }
        if (typeof s.id !== 'string' || !/^[a-z0-9_]+$/.test(s.id)) {
          err(`${at}.id`, 'id 只能是小写字母、数字、下划线');
        } else if (seen.has(s.id)) {
          warn(`${at}.id`, `id「${s.id}」重复；按 id 点站点时会拿到第一条`);
        } else {
          seen.add(s.id);
        }
        if (!STATION_KINDS.includes(s.kind)) err(`${at}.kind`, `kind 只认 ${STATION_KINDS.join(' / ')}`);
        if (typeof s.block !== 'string' || !s.block.includes(':')) {
          err(`${at}.block`, 'block 必填且要带命名空间');
        }
        if (s.kind === 'two-step-use' && !s.toolSuffix) {
          warn(`${at}.toolSuffix`, 'two-step-use 没写 toolSuffix，工具只能靠猜');
        }
        if (s.kind === 'sidecar-recipe') {
          if (!s.command) err(`${at}.command`, 'sidecar-recipe 必填 command（如 /xxx cook {recipe}）');
          else if (!String(s.command).includes('{recipe}')) err(`${at}.command`, 'command 里要有 {recipe}');
          if (!s.recipeType) warn(`${at}.recipeType`, 'sidecar-recipe 没写 recipeType，配方类型只能靠猜');
        }
        if (s.heatTag !== undefined && (typeof s.heatTag !== 'string' || !s.heatTag.includes(':'))) {
          err(`${at}.heatTag`, 'heatTag 要是带命名空间的 tag 名（ns:tag）');
        }
      });
    }
  } else {
    warn('stations', '没有 stations：这个 mod 的方块只能靠 use 硬点');
  }

  if (raw.containers !== undefined) {
    if (!Array.isArray(raw.containers)) {
      err('containers', 'containers 要是数组');
    } else {
      for (const name of raw.containers) {
        if (typeof name !== 'string' || !name.includes(':')) {
          err('containers', `容器名要带命名空间：${String(name)}`);
        } else if (isObject(raw.blocks) && !(name in raw.blocks)) {
          warn('containers', `声明了容器 ${name}，但 blocks 里没有它`);
        }
      }
    }
  }

  if (raw.candidates !== undefined) {
    if (!isObject(raw.candidates)) {
      err('candidates', 'candidates 要是对象（tag → 物品名数组）');
    } else {
      for (const [tag, list] of Object.entries(raw.candidates)) {
        if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
          err(`candidates.${tag}`, '候选要是字符串数组');
        }
      }
    }
  }

  if (raw.prompt !== undefined) {
    if (!isObject(raw.prompt)) {
      err('prompt', 'prompt 要是对象（{zh, en}）');
    } else {
      for (const key of ['zh', 'en']) {
        if (raw.prompt[key] !== undefined && typeof raw.prompt[key] !== 'string') {
          err(`prompt.${key}`, 'prompt 的每种语言要是字符串');
        }
      }
      if (raw.prompt.zh === undefined && raw.prompt.en === undefined) {
        warn('prompt', 'prompt 里一种语言都没有');
      }
    }
  } else {
    warn('prompt', '没有 prompt：提示词里只会写「装了 X」');
  }

  if (raw.unsupported !== undefined && (!Array.isArray(raw.unsupported)
    || raw.unsupported.some((x) => typeof x !== 'string'))) {
    err('unsupported', 'unsupported 要是字符串数组');
  }

  // ---- 配方条目：两种形状（jar 的 pattern/key、服务端的 grid/候选）都放行，但结构要对 ----
  // schema 里 file 已降为可选、required 是 id+type；这里做同一套的运行时版本，
  // 因为生成端读的是 validate.mjs 而不是 schema 文件。
  if (Array.isArray(raw.recipes)) {
    raw.recipes.forEach((r, i) => {
      const at = `recipes[${i}]`;
      if (!isObject(r)) { err(at, '配方条目不是对象'); return; }
      if (typeof r.id !== 'string' || !r.id) err(`${at}.id`, '配方缺 id');
      if (typeof r.type !== 'string' || !r.type) err(`${at}.type`, '配方缺 type');
      const t = String(r.type ?? '');
      if (t === 'crafting_shaped' && !Array.isArray(r.pattern) && !Array.isArray(r.grid)) {
        err(at, 'crafting_shaped 配方要有 pattern（jar 形状）或 grid（服务端形状）');
      }
      if (t === 'crafting_shapeless' && !Array.isArray(r.ingredients)) {
        err(`${at}.ingredients`, 'crafting_shapeless 配方要有 ingredients 数组');
      }
      // 原版有明确产物形状的类型才强制 result.id；自定义序列化器（immersiveengineering:crusher
      // 之类的 basePredicate、twilightforest 的自定义 result）可以有别的形状。
      const RESULT_REQUIRED = new Set([
        'crafting_shaped', 'crafting_shapeless',
        'smelting', 'blasting', 'smoking', 'campfire_cooking',
        'stonecutting', 'smithing_transform',
      ]);
      if (r.result !== undefined && r.result !== null && !Array.isArray(r.result)) {
        if (RESULT_REQUIRED.has(t)) {
          if (!isObject(r.result) || typeof r.result.id !== 'string') {
            err(`${at}.result`, 'result 要带 id');
          } else if (r.result.count !== undefined
            && (!Number.isInteger(r.result.count) || r.result.count < 1)) {
            err(`${at}.result.count`, 'result.count 要是正整数');
          }
        }
      }
    });
  }

  return issues;
}

export const hasErrors = (issues) => issues.some((i) => i.level === 'error');

export const describeIssues = (issues) =>
  issues.map((i) => `${i.level === 'error' ? '✗' : '!'} ${i.path || '(根)'}: ${i.message}`);

/** 校验通过后当成 manifest 用；错了给 null。 */
export function parseManifest(raw) {
  return hasErrors(validateManifest(raw)) ? null : raw;
}

/** 统计口径：声明了多少、实际可用多少。 */
export function statsOf(manifest, ids = null) {
  const declaredItems = Object.keys(manifest?.items ?? {}).length;
  const usableItems = ids?.items ? Object.keys(ids.items).length : declaredItems;
  const failed = Array.isArray(ids?.failed) ? ids.failed : [];
  return {
    blocks: Object.keys(manifest?.blocks ?? {}).length,
    states: Object.values(manifest?.blocks ?? {}).reduce((n, b) => n + (b.states?.length ?? 0), 0),
    recipes: (manifest?.recipes ?? []).length,
    crops: Object.keys(manifest?.crops ?? {}).length,
    stations: (manifest?.stations ?? []).length,
    containers: (manifest?.containers ?? []).length,
    declaredItems,
    usableItems,
    blockOnlyItems: failed.filter((f) => f.kind === 'block-only').length,
    unknownItems: failed.filter((f) => f.kind === 'unknown-item').length,
  };
}
