// 回归：sidecar 不得在没有编译成功时改清单。
// 这条钉的是一个真出过的事故：命令写回在编译之前，--no-build 也照写，
// 清单里的 command 指向一个没装上的模组 —— 机器人会去调不存在的命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/modsmith.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/tiny-mod.jar', import.meta.url));

function withManifest(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-cli-'));
  try {
    const manifest = {
      mod: 'tinymod', version: '1.2.3', namespace: 'tinymod',
      blocks: { 'tinymod:pot': { states: [{}], solid: true, box: [0, 0, 0, 1, 1, 1] } },
      items: {}, crops: {}, names: {}, recipes: [],
      containers: [],
      stations: [
        // 已经装好的手工侧车命令：绝不能被一次 --no-build 生成改掉
        { id: 'pot', kind: 'sidecar-recipe', block: 'tinymod:pot',
          command: '/handmade cook {recipe}', recipeType: 'tinymod:cooking' },
      ],
      prompt: { zh: '测试' },
    };
    const file = join(dir, 'm.json');
    writeFileSync(file, JSON.stringify(manifest, null, 1), 'utf8');
    return fn({ dir, file, manifest });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('sidecar --no-build 不改清单里的 command', () => {
  withManifest(({ dir, file }) => {
    const r = run(['sidecar', file, '--out', join(dir, 'sc'), '--no-build']);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.stations[0].command, '/handmade cook {recipe}',
      '没编译就不该动命令');
    assert.match(r.stderr, /没有.{0,4}写回/, '应该明确说没写回');
  });
});

test('sidecar --no-build + --write-command 才写，并警告没验过', () => {
  withManifest(({ dir, file }) => {
    const r = run(['sidecar', file, '--out', join(dir, 'sc'), '--no-build', '--write-command']);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.notEqual(after.stations[0].command, '/handmade cook {recipe}', '显式要求就该写');
    assert.match(r.stderr, /没有经过编译验证/, '必须警告');
  });
});

test('inspect 给了 --pack 时不再提示"已有同名 mod"（避免指回自己刚写的）', () => {
  withManifest(({ dir, file }) => {
    // 先用 --pack 生成一份
    const a = run(['inspect', FIXTURE, '--out', dir, '--pack', 'tinymod-x']);
    assert.equal(a.status, 0, a.stderr);
    // 再跑一次同样的 --pack：不该出现"已有 ... 要接它请重跑"
    const b = run(['inspect', FIXTURE, '--out', dir, '--pack', 'tinymod-x']);
    assert.equal(b.status, 0, b.stderr);
    assert.doesNotMatch(b.stderr, /要接它请重跑/);
  });
});
