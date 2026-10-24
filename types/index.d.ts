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
