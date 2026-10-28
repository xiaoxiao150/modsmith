// 服务器指纹：算得稳、对得上、对不上时说得清差在哪。
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintDir, fingerprintOf, diffFileLists, checkServerMods } from '../src/server-fingerprint.mjs';

function withModsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-fp-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test('fingerprintDir：目录里只有顶层文件参与，顺序与文件名排序一致，内容变了指纹就变', () => {
  const dir = withModsDir({ 'b.jar': 'BBB', 'a.jar': 'AAA' });
  const fp1 = fingerprintDir(dir);
  assert.equal(fp1.files.map((f) => f.file).join(','), 'a.jar,b.jar');
  assert.equal(fp1.files[0].bytes, 3);
  assert.match(fp1.files[0].sha256, /^[0-9a-f]{64}$/);

  writeFileSync(join(dir, 'a.jar'), 'AAA!');
  const fp2 = fingerprintDir(dir);
  assert.notEqual(fp1.fingerprint, fp2.fingerprint);

  // 子目录不参与（Fabric mods 目录会塞资源包/子目录进去的不少见）
  mkdirSync(join(dir, 'subdir'));
  writeFileSync(join(dir, 'subdir', 'x.jar'), 'XXX');
  assert.equal(fingerprintDir(dir).fingerprint, fp2.fingerprint);
  rmSync(dir, { recursive: true, force: true });
});

test('fingerprintOf：同一份清单指纹稳定，与逐文件内容绑定', () => {
  const files = [{ file: 'a.jar', bytes: 3, sha256: 'aa' }, { file: 'b.jar', bytes: 1, sha256: 'bb' }];
  assert.equal(fingerprintOf(files), fingerprintOf([...files]));
  assert.notEqual(fingerprintOf(files), fingerprintOf([files[1], files[0]]));
});

test('diffFileLists：变了/多了/少了分开报，全同才是 same', () => {
  const stored = [
    { file: 'a.jar', bytes: 3, sha256: 'aa' },
    { file: 'b.jar', bytes: 1, sha256: 'bb' },
    { file: 'gone.jar', bytes: 5, sha256: 'gg' },
  ];
  const current = [
    { file: 'a.jar', bytes: 4, sha256: 'aa2' },
    { file: 'b.jar', bytes: 1, sha256: 'bb' },
    { file: 'new.jar', bytes: 2, sha256: 'nn' },
  ];
  const d = diffFileLists(stored, current);
  assert.deepEqual(d, {
    changed: ['a.jar'], added: ['new.jar'], removed: ['gone.jar'], same: false,
  });
  assert.equal(diffFileLists(current, current).same, true);
});

test('checkServerMods：对得上放行，对不上 fatal 且列出差异与重跑命令', () => {
  const dir = withModsDir({ 'a.jar': 'AAA', 'b.jar': 'BBB' });
  const good = fingerprintDir(dir);

  const ok = checkServerMods(good, dir);
  assert.deepEqual({ ok: ok.ok, fatal: ok.fatal }, { ok: true, fatal: false });
  assert.match(ok.lines[0], /对得上/);

  // 换了一个 jar 的内容
  writeFileSync(join(dir, 'b.jar'), 'Bigger');
  const bad = checkServerMods(good, dir);
  assert.equal(bad.fatal, true);
  assert.match(bad.lines.join('\n'), /变了：b\.jar/);
  assert.match(bad.lines.join('\n'), /--server-mods/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkServerMods：老 ids 没指纹是警告不是拒绝；两目录都没给就跳过', () => {
  const warn = checkServerMods(undefined, undefined);
  assert.equal(warn.fatal, false);
  assert.match(warn.lines[0], /没有服务器指纹/);

  const skip = checkServerMods({ fingerprint: 'x', files: [] }, undefined);
  assert.equal(skip.fatal, false);

  // 给了目录但 ids 没有 files：警告降级，给出补录命令
  const dir = withModsDir({ 'a.jar': 'AAA' });
  const stale = checkServerMods({ fingerprint: 'abc' }, dir);
  assert.equal(stale.fatal, false);
  assert.match(stale.lines[0], /没有服务器指纹/);

  // 目录读不了：拒绝，不崩
  const badDir = checkServerMods({ fingerprint: 'abc' }, join(dir, 'nope'));
  assert.equal(badDir.fatal, true);
  assert.match(badDir.lines[0], /读不了/);
  rmSync(dir, { recursive: true, force: true });
});

test('fingerprintDir：sidecar 与 dump jar 不参与指纹（它们不注册方块/物品）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-fp-'));
  try {
    writeFileSync(join(dir, 'FarmersDelight-1.21.1-3.3.6+refabricated.jar'), Buffer.from('mod-a'));
    const base = fingerprintDir(dir).fingerprint;
    writeFileSync(join(dir, 'modsmith-sidecar-0.1.0.jar'), Buffer.from('our-own-jar'));
    writeFileSync(join(dir, 'modsmith-dump-0.1.0.jar'), Buffer.from('dump-jar'));
    assert.equal(fingerprintDir(dir).fingerprint, base);
    assert.ok(!fingerprintDir(dir).files.some((f) => /^modsmith-(sidecar|dump)/.test(f.file)));
    // 换一个真的内容 mod：指纹必须变
    writeFileSync(join(dir, 'OtherMod.jar'), Buffer.from('mod-b'));
    assert.notEqual(fingerprintDir(dir).fingerprint, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
