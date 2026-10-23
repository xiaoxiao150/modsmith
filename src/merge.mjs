/**
 * `modsmith merge` —— 把分阶段量出来的 ids 合并成一份。
 *
 * 为什么需要：方块和物品的测量代价差很多（方块 132 个状态要十几分钟，物品只要几分钟），
 * 而且校准时经常只想重测其中一半（`--blocks-only` / `--items-only`）。分两次跑完把结果
 * 拼起来，比每次都从头量一遍现实。
 *
 * 规则：按参数顺序后者覆盖前者，但**只覆盖它有数据的部分**——这样
 * "先 --blocks-only 到 A，再 --items-only 到 B，然后 merge A B" 就得到完整的一份。
 */
import { readIds, writeIds } from './manifest-io.mjs';

export default async function cmdMerge(args, io) {
  const inputs = args._.slice(1);
  if (inputs.length < 2) io.fatal('merge 至少要给两个 ids.json');
  const outPath = String(args.out ?? '');
  if (!outPath) io.fatal('merge 要给 --out <file>');

  const merged = { mod: '', version: '', measuredAt: new Date().toISOString(), blocks: {}, items: {}, failed: [] };
  for (const path of inputs) {
    const ids = readIds(path);
    if (!ids) io.fatal(`读不了 ${path}`);
    if (!merged.mod && ids.mod) merged.mod = ids.mod;
    if (!merged.version && ids.version) merged.version = ids.version;
    // 只覆盖有数据的那一半
    if (ids.blocks && Object.keys(ids.blocks).length > 0) {
      merged.blocks = { ...merged.blocks, ...ids.blocks };
    }
    if (ids.items && Object.keys(ids.items).length > 0) {
      merged.items = { ...merged.items, ...ids.items };
    }
    if (Array.isArray(ids.failed)) merged.failed.push(...ids.failed);
  }

  const blocks = Object.keys(merged.blocks).length;
  const items = Object.keys(merged.items).length;
  if (blocks === 0) io.fatal('合并结果里没有方块数据');
  if (items === 0) io.fatal('合并结果里没有物品数据');

  writeIds(outPath, merged);
  console.error(`✓ 合并 ${inputs.length} 份：方块 ${blocks}、物品 ${items}、失败 ${merged.failed.length}`);
  console.error(`  写入 ${outPath}`);
  console.log(outPath);
}
