/**
 * learn（LLM 路径）的循环契约：不调真模型，注入 ask/probe 只测编排。
 *
 * 这条路径以前没有测试——它决定"模型答错一次还能不能救回来"。真实事故背景：
 * 站点推断一旦把机制写错，下游会白试（服务端不认的命令、永远等不到的产物），
 * 所以要求：结构不合格要回喂错误再要一轮；实测不符要把原因原样回给模型；
 * 轮数用完还没好就不许写盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learn } from '../src/learn.mjs';

const MANIFEST = {
  mod: 'm', namespace: 'm', containers: [],
  blocks: { 'm:cooking_pot': {}, 'm:cutting_board': {} },
  items: { 'm:knife': {}, 'minecraft:beef': {} },
  recipes: [{ id: 'm:cooking/a', type: 'm:cooking', ingredients: [[{ id: 'minecraft:beef' }]] }],
  stations: [],
  candidates: {},
};

function withManifest(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'modsmith-learn-llm-'));
  const file = join(dir, 'm.json');
  writeFileSync(file, JSON.stringify(MANIFEST));
  const io = { fatal: (m) => { throw new Error(m); } };
  return Promise.resolve(fn({ dir, file, io })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const goodStation = (kind, block, extra = {}) => ({
  id: block.split(':')[1], kind, block, ...extra,
});

test('第一轮结构不合格 → 把错误回喂，第二轮合格才写盘', () => withManifest(async ({ file, io }) => {
  const prompts = [];
  const ask = async (p) => {
    prompts.push(p);
    if (prompts.length === 1) return '我觉得这个锅可以煮东西';   // 没 JSON
    return JSON.stringify({
      stations: [goodStation('sidecar-recipe', 'm:cooking_pot', { recipeType: 'm:cooking', command: '/m cook {recipe}' })],
      prompt: '用锅煮。',
      unsupported: [],
    });
  };
  const r = await learn(file, { ask, rounds: 3 }, io);
  assert.equal(r.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /上一轮的问题/, '第二轮 prompt 要带上上一轮的错误');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.stations[0].block, 'm:cooking_pot');
}));

test('实测不符 → 原因回给模型，模型改成实测支持的机制', () => withManifest(async ({ file, io }) => {
  const seen = [];
  let round = 0;
  const ask = async (prompt) => {
    round += 1;
    seen.push(prompt);
    // 第一轮把锅声明成两步式（错误的机制）
    const kind = round === 1 ? 'two-step-use' : 'sidecar-recipe';
    return JSON.stringify({
      stations: [goodStation(kind, 'm:cooking_pot', { recipeType: 'm:cooking', command: '/m cook {recipe}', toolSuffix: '_knife' })],
      prompt: '', unsupported: [],
    });
  };
  const probe = async (stations) => stations.map((st) => ({
    id: st.id, block: st.block, kind: st.kind,
    matches: st.kind === 'sidecar-recipe',
    why: st.kind === 'sidecar-recipe' ? '右键不开窗，符合需要侧车' : '声明两步式但实测不开窗',
    opensWindow: false,
  }));
  const r = await learn(file, { ask, probe, rounds: 3 }, io);
  assert.equal(r.ok, true);
  assert.equal(r.learned.stations[0].kind, 'sidecar-recipe');
  assert.match(seen[1], /实测不符|声明两步式/, '第二轮要看到第一轮的实测结论');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.stations[0].verified, true, '实测确认过的站点要标 verified');
  assert.equal(after.probe.stations, 1);
}));

test('轮数用完仍不合格 → 不写盘（宁原样保留）', () => withManifest(async ({ file, io }) => {
  const before = readFileSync(file, 'utf8');
  const ask = async () => JSON.stringify({ stations: [{ id: 'x', kind: '没这种机制', block: 'm:cooking_pot' }] });
  const r = await learn(file, { ask, rounds: 2 }, io);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(file, 'utf8'), before, '失败时清单必须一字不动');
}));
