/**
 * conformance 离线引擎：三层正例 + 三个真实事故的反例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import prismarineRegistry from 'prismarine-registry';
import { inspectJar } from '../src/inspect.mjs';
import { checkManifest, checkIds, checkRegistry, runConformance } from '../src/conformance.mjs';

const JAR = fileURLToPath(new URL('./fixtures/tiny-mod.jar', import.meta.url));

function pack() {
  return inspectJar(JAR).manifest;
}

function idsFor(manifest) {
  return {
    mod: manifest.mod,
    version: manifest.version,
    measuredAt: new Date().toISOString(),
    method: 'test',
    blocks: {
      'tinymod:tiny_block': [{ props: {}, stateId: 30000 }],
      'tinymod:tiny_crop': [
        { props: { age: '0' }, stateId: 30010 },
        { props: { age: '1' }, stateId: 30011 },
        { props: { age: '2' }, stateId: 30012 },
        { props: { age: '3' }, stateId: 30013 },
      ],
    },
    items: { 'tinymod:tiny_item': 1400, 'tinymod:tiny_block': 1401 },
    entities: { 'tinymod:tiny_boss': { id: 130, boss: true } },
    failed: [],
  };
}

test('合成包：manifest/ids/registry 三层无 fail', () => {
  const manifest = pack();
  const ids = idsFor(manifest);
  const registry = prismarineRegistry('1.21.1');
  const report = runConformance({ manifest, ids, registry });
  assert.equal(report.summary.fail, 0, JSON.stringify(report.checks.filter((c) => c.level === 'fail')));
  assert.ok(report.summary.pass > 0);
  assert.ok(report.checks.some((c) => c.id === 'R6' && c.level === 'pass'));
});

test('反例：solid:true 但没有 box/模板 = 假空气', () => {
  const manifest = pack();
  manifest.blocks['tinymod:ghost'] = { states: [{}], solid: true, box: null, drops: [] };
  const checks = checkManifest(manifest);
  assert.ok(checks.some((c) => c.id === 'M3' && c.level === 'fail' && c.subject === 'tinymod:ghost'));
});

test('反例：长苗块 alias 到成熟作物 = M5 fail', () => {
  const manifest = pack();
  manifest.crops.tomatoes = {
    seed: 'tinymod:tiny_crop', max_age: 3, age_prop: 'age',
    aliases: ['budding_tomatoes'],
  };
  manifest.blocks['tinymod:budding_tomatoes'] = {
    states: [{ age: '0' }, { age: '1' }, { age: '2' }, { age: '3' }, { age: '4' }],
    solid: false, box: null, drops: ['tinymod:tomato_seeds'], tags: ['crops'],
  };
  const checks = checkManifest(manifest);
  assert.ok(checks.some((c) => c.id === 'M5' && c.level === 'fail' && c.subject === 'tinymod:budding_tomatoes'));
});

test('作物注入后 diggable:true（R4 的正例）', () => {
  const manifest = pack();
  manifest.blocks['tinymod:onions'] = {
    states: [{ age: '0' }, { age: '7' }], solid: false, box: null, drops: ['tinymod:tiny_item'], tags: ['crops'],
  };
  const ids = idsFor(manifest);
  ids.blocks['tinymod:onions'] = [{ props: { age: '0' }, stateId: 30020 }, { props: { age: '7' }, stateId: 30027 }];
  const registry = prismarineRegistry('1.21.1');
  const checks = checkRegistry(manifest, ids, registry);
  assert.equal(registry.blocksByName['tinymod:onions'].diggable, true);
  assert.ok(checks.some((c) => c.id === 'R4' && c.subject === 'tinymod:onions' && c.level === 'pass'));
});

test('真实作物 sidecar：budding_tomatoes 不再被当成番茄成熟块', () => {
  const sidecar = JSON.parse(readFileSync(new URL('../sidesheets/farmers-delight-3.3.6.crops.json', import.meta.url), 'utf8'));
  assert.ok(!(sidecar.tomatoes?.aliases ?? []).includes('budding_tomatoes'));
});

test('楼梯：注入后 top/bottom state 的形状不同（R5）', () => {
  const manifest = pack();
  manifest.blocks['tinymod:canopy_stairs'] = {
    states: [
      { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' },
      { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' },
    ],
    solid: false, box: null, drops: [], tags: [],
  };
  const ids = idsFor(manifest);
  ids.blocks['tinymod:canopy_stairs'] = [
    { props: { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' }, stateId: 30030 },
    { props: { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' }, stateId: 30031 },
  ];
  const registry = prismarineRegistry('1.21.1');
  const checks = checkRegistry(manifest, ids, registry);
  assert.ok(checks.some((c) => c.id === 'R5' && c.subject === 'tinymod:canopy_stairs' && c.level === 'pass'),
    JSON.stringify(checks.filter((c) => c.id === 'R5')));
  const shapes = registry.blockCollisionShapes.blocks['tinymod:canopy_stairs'];
  assert.notEqual(JSON.stringify(shapes[0]), JSON.stringify(shapes[1]));
});

test('ids 交叉：stateId 落在 vanilla 区间必须 fail', () => {
  const manifest = pack();
  const ids = idsFor(manifest);
  ids.blocks['tinymod:tiny_block'] = [{ props: {}, stateId: 1234 }];
  const checks = checkIds(manifest, ids);
  assert.ok(checks.some((c) => c.id === 'I2' && c.level === 'fail'));
});

test('CLI：conformance 生成 JSON 报告并以 0 退出', () => {
  const manifest = pack();
  const ids = idsFor(manifest);
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-conf-'));
  try {
    const manifestPath = join(dir, 'pack.json');
    const idsPath = join(dir, 'pack-ids.json');
    const reportPath = join(dir, 'report.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(idsPath, JSON.stringify(ids));
    const bin = fileURLToPath(new URL('../bin/modsmith.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [bin, 'conformance', manifestPath, '--ids', idsPath, '--json', reportPath], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.summary.fail, 0);
    assert.ok(report.checks.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI：清单失败退出 1（onboard 据此早停）', () => {
  const manifest = pack();
  manifest.blocks['tinymod:ghost'] = { states: [{}], solid: true, box: null, drops: [] };
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-conf-bad-'));
  try {
    const manifestPath = join(dir, 'bad.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const bin = fileURLToPath(new URL('../bin/modsmith.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [bin, 'conformance', manifestPath, '--manifest-only'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /M3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
