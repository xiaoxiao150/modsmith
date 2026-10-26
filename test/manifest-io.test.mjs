import test from 'node:test';
import assert from 'node:assert/strict';


test('mergeIdsTables：合并多包 ids，指纹不一致与同名冲突都要报出来', async () => {
  const { mergeIdsTables } = await import('../src/ids-merge.mjs');
  const fp = (n) => ({ fingerprint: n, files: [] });
  const primary = { items: { 'a:one': 100 }, blocks: {}, serverMods: fp('same') };
  const other = { file: 'b-ids.json', ids: { items: { 'a:one': 100, 'b:two': 200 }, blocks: { 'b:block': 7 }, serverMods: fp('same') } };
  const ok = mergeIdsTables(primary, [other]);
  assert.deepEqual(ok.items, { 'a:one': 100, 'b:two': 200 });
  assert.deepEqual(ok.blocks, { 'b:block': 7 });
  assert.deepEqual(ok.conflicts, []);
  assert.deepEqual(ok.fingerprints, ['same']);

  const conflict = mergeIdsTables(primary, [{ file: 'c-ids.json', ids: { items: { 'a:one': 999 } } }]);
  assert.equal(conflict.conflicts.length, 1, '同名字不同 id 必须报冲突');
  assert.equal(conflict.items['a:one'], 100, '冲突时保留主表的值');

  const stale = mergeIdsTables(primary, [{ file: 'd-ids.json', ids: { items: { 'd:x': 5 }, serverMods: fp('other') } }]);
  assert.deepEqual(stale.fingerprints.sort(), ['other', 'same'], '两套指纹要交出来让调用方拒绝');

  const old = mergeIdsTables(primary, [{ file: 'e-ids.json', ids: { items: { 'e:y': 6 } } }]);
  assert.deepEqual(old.missingFingerprint, ['e-ids.json'], '没指纹的老文件要单独提示');
});
