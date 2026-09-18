/**
 * version.d.mts — `scripts/version.mjs` 的手写类型声明（W887）。
 *
 * 为什么要有这个文件：`version.mjs` 是纯 JS（根 tsconfig 只 typecheck scripts
 * 下的 .ts），但 `apps/studio` 与 `apps/web/vite.config.ts` 都要以
 * TypeScript 引用它。声明文件让引用方拿到类型，又**不会**把 node 内建类型拖进
 * 前端 program（`apps/web/tsconfig.json` 刻意只收 vite/client）。
 */
export interface DescribeInfo {
  tag: string | null;
  commitsSinceTag: number | null;
  sha: string | null;
  dirty: boolean;
}

export interface VersionInfo {
  /** 去 v 前缀的版本（v2.7.0 -> 2.7.0）；回落时为 package.json 的 version。 */
  version: string;
  /** 原始 `git describe` 输出；无 git 时为空串。 */
  describe: string;
  /** 短 sha；解析/rev-parse 都拿不到时为空串。 */
  sha: string;
  /** 距最近 tag 的提交数；恰好落在 tag 上为 0；无 tag 为 null。 */
  commitsSinceTag: number | null;
  dirty: boolean;
  /** 构建期 ISO 时间。 */
  buildTime: string;
  source: "git" | "package";
  tag: string | null;
}

export interface ComputeVersionInput {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  packagePath?: string;
}

export declare const REPO_ROOT: string;
export declare const WEB_PACKAGE_JSON: string;
export declare function stripLeadingV(tag: string): string;
export declare function parseDescribe(describe: string): DescribeInfo | null;
export declare function readPackageVersion(packagePath?: string): string | null;
export declare function computeVersion(input?: ComputeVersionInput): VersionInfo;
export declare function writeWebPackageVersion(info: VersionInfo, packagePath?: string): string;
