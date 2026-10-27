/**
 * modsmith 的 TypeScript 面（手写，只声明宿主用到的窄面）。
 * modsmith 本体是 ESM JS；这仨类型按结构最小化，宿主自己的类型（ModManifest 等）
 * 在宿主侧定义，传进来时按需收窄。
 */

export interface RegistryCounts {
  blocks: number;
  states: number;
  items: number;
}

export interface ModPackLike {
  manifest: object;
  ids: object;
}

/** bot 只按形状使用（bot.registry / bot._client），不依赖 mineflayer 的完整类型。 */
export function installModRegistry(bot: unknown, pack: ModPackLike): RegistryCounts;
export function installMineflayerFixes(bot: unknown): void;

/** 从 modsDir（setModsDir 设置，默认 cwd/mods）读 <name>.json 与 <name>-ids.json。 */
export function loadModPack(name: string): ModPackLike | null;
export function setModsDir(dir: string): void;
export function listPacks(): string[];

export interface ManifestIssueLike {
  level: 'error' | 'warn';
  path: string;
  message: string;
}

export function validateManifest(raw: unknown): ManifestIssueLike[];
export function hasErrors(issues: ManifestIssueLike[]): boolean;
export function describeIssues(issues: ManifestIssueLike[]): string[];
export function parseManifest<T = Record<string, unknown>>(raw: unknown): T | null;
export function statsOf(manifest: Record<string, unknown>, ids?: Record<string, unknown> | null): Record<string, number>;

/** 服务器 mods 目录指纹：ids.serverMods 的写入与加载侧校验（calibrate --server-mods）。 */
export interface ServerModsFingerprint {
  fingerprint: string;
  files: Array<{ file: string; bytes: number; sha256: string }>;
}
export function fingerprintDir(dir: string): ServerModsFingerprint;
export function checkServerMods(
  stored: ServerModsFingerprint | undefined,
  dir: string | undefined,
): { ok: boolean; fatal: boolean; lines: string[] };

/** 清单 → mineflayer 可消费的合成视图（pattern/key 或候选数组，已归一）。 */
export interface CraftRecipeView {
  id?: string;
  type: 'crafting_shaped' | 'crafting_shapeless';
  pattern?: string[];
  key?: Record<string, { item?: string; id?: string; tag?: string } | Array<{ item?: string; id?: string; tag?: string }>>;
  ingredients?: Array<Array<{ item?: string; id?: string; tag?: string }>>;
  result: { id: string; count: number };
}
export function craftRecipeViews(manifest: object): CraftRecipeView[];

/** 配方依赖图 + 目标规划（宿主 make 技能的输入）。 */
export interface PlannedStep {
  skill: 'craft' | 'cut' | 'pot' | 'cook' | 'smelt';
  item?: string;
  items?: string[];
  recipe?: string;
  input?: string;
  fuel?: string;
  count: number;
}
export interface PlanResult {
  ok: boolean;
  steps: PlannedStep[];
  missing: Array<{ item: string; reason: string }>;
  notes: string[];
}
export function buildRecipeGraph(
  manifest: object,
  opts?: { stations?: Array<{ id: string; kind: string; recipeType?: string; recipeTypes?: string[] }> },
): { byResult: Map<string, unknown[]>; views: CraftRecipeView[] };
export function canMake(graph: { byResult: Map<string, unknown[]> }, item: string): boolean;
export function outputOf(recipe: object): string | null;
export function outputCountOf(recipe: object): number;
export function planTarget(
  graph: { byResult: Map<string, unknown[]> },
  opts: {
    item: string;
    count?: number;
    have?: Record<string, number>;
    stations?: Array<{ id: string; kind: string; recipeType?: string; recipeTypes?: string[] }>;
    maxSteps?: number;
  },
): PlanResult;

/** vanilla 物品数字 id → 全名（minecraft-data 表）。 */
export function vanillaItemTable(mcVersion?: string): Record<string, string>;

/** 文法发现：未知序列化器的候选（discoverSerializers 的产物，永不自动生效）。 */
export interface DiscoveredSerializer {
  typeId: number;
  fields: Array<{ name: string; kind: string; item?: Array<{ name: string; kind: string }> }>;
  shape: string | null;
  occurrences: number;
  slotIds: number[];
  packetValidated: boolean;
}
export interface DiscoveryResult {
  ok: boolean;
  count: number;
  segments: Array<{ index: number; typeId: number; start: number; end: number; known: boolean; occurrences: number }>;
  discovered: DiscoveredSerializer[];
  candidates: Record<string, DiscoveredSerializer[]>;
  notes: string[];
  budgetLeft: number;
}
export function discoverSerializers(
  buf: Buffer,
  opts?: {
    serializers?: Record<string, { name?: string; fields: Array<{ name: string; kind: string; item?: unknown }> }>;
    knownItemIds?: Set<number>;
    maxItemId?: number;
    maxTypeId?: number;
    budget?: number;
    maxCandidates?: number;
    trace?: (phase: string, info: unknown) => void;
  },
): DiscoveryResult;
export function sidesheetFromDiscovery(
  result: DiscoveryResult,
  meta?: { mod?: string },
): Record<string, unknown>;
