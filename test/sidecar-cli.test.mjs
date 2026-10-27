// 回归：sidecar 不得在没有编译成功时改清单。
// 这条钉的是一个真出过的事故：命令写回在编译之前，--no-build 也照写，
// 清单里的 command 指向一个没装上的模组 —— 机器人会去调不存在的命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stationConfigOf, planCommandWrites } from '../src/sidecar.mjs';

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

test('sidecar 产出通用模组读的站点配置（不是每站点一份代码）', () => {
  withManifest(({ dir, file }) => {
    const r = run(['sidecar', file, '--out', join(dir, 'sc'), '--no-build']);
    assert.equal(r.status, 0, r.stderr);
    const cfgPath = join(dir, 'sc', 'm', 'config', 'modsmith-sidecar', 'm.json');
    assert.ok(existsSync(cfgPath), '配置该在 sidecars/<pack>/config/modsmith-sidecar/<pack>.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.pack, 'm');
    assert.equal(cfg.stations.length, 1);
    assert.deepEqual(cfg.stations[0], {
      id: 'pot',
      label: 'pot',
      command: 'pot',
      block: 'tinymod:pot',
      // 新格式数组 + 老格式单值并存：老侧车读 recipeType，新侧车读 recipeTypes
      recipeTypes: ['tinymod:cooking'],
      recipeType: 'tinymod:cooking',
      cookTime: 200,
      opLevel: 2,
    });
  });
});

test('stationConfigOf：声明了 cookTime/heatTag 的站点如实进配置，没声明的落默认', () => {
  const manifest = { mod: 'tinymod', namespace: 'tinymod', names: { 'block.pot': { zh: '锅' } } };
  const cfg = stationConfigOf(manifest, [
    { id: 'pot', block: 'tinymod:pot', cookTime: 600, heatTag: 'tinymod:heat_sources' },
    { id: 'pan', block: 'tinymod:pan' },
  ], 3);
  assert.deepEqual(cfg[0], {
    id: 'pot', label: '锅', command: 'pot', block: 'tinymod:pot',
    recipeTypes: ['tinymod:cooking'], cookTime: 600, opLevel: 3, heatTag: 'tinymod:heat_sources',
  });
  assert.deepEqual(cfg[1].recipeTypes, ['tinymod:cooking'], '没声明类型也落默认类型');
  assert.equal(cfg[1].cookTime, 200);
  assert.equal(cfg[1].heatTag, undefined);
  assert.equal('heatTag' in cfg[1], false, '没声明就不该带 heatTag 键');
});

test('planCommandWrites：已有 command 默认保留（人工侧车优先），--write-command 才覆盖', () => {
  const pending = [
    // fdchef 场景：人工侧车 /pot 在跑，生成的是 /cooking_pot
    { station: { id: 'pot', command: '/pot cook {recipe}' }, command: '/cooking_pot cook {recipe}', recipeType: 'x:cooking' },
    // 没命令的站点：该写
    { station: { id: 'pan' }, command: '/pan cook {recipe}', recipeType: 'x:cooking' },
    // 命令与生成结果一致：无需保留
    { station: { id: 'mill', command: '/mill cook {recipe}' }, command: '/mill cook {recipe}', recipeType: 'x:cooking' },
    // 机器推断出来的命令是占位符（learn 的模型编的），必须能被侧车覆盖
    { station: { id: 'keg', command: '/brewinandchewin ferment {recipe}', inferred: true }, command: '/keg cook {recipe}', recipeType: 'x:fermenting' },
  ];
  const plain = planCommandWrites(pending, false);
  assert.deepEqual(plain.kept, [{ id: 'pot', existing: '/pot cook {recipe}' }]);
  assert.deepEqual(plain.writable.map((x) => x.station.id), ['pan', 'mill', 'keg'],
    '推断站点的命令是占位符，不该像人工命令那样被保留');

  const forced = planCommandWrites(pending, true);
  assert.deepEqual(forced.kept, []);
  assert.deepEqual(forced.writable.map((x) => x.station.id), ['pot', 'pan', 'mill', 'keg']);
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
