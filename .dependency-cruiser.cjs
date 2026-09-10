/**
 * celestea_studio-ts —— 包依赖边界的机械强制（dependency-cruiser）。
 *
 * 与 ESLint（`pnpm lint`）分工：
 *   - ESLint      = 单文件形状（规模 / 参数 / 嵌套）+ 导入字面量
 *   - 本文件       = 仓级依赖图：分层方向、同层横向依赖、循环、深层导入、不可解析
 *
 * 分层（详见 docs/ARCHITECTURE.md §1）：
 *   L0 core（零依赖）
 *   L1 session / llm / tools / agent-loop / workers   → 只许依赖 core
 *   L2 runtime（装配层）                              → 许依赖 core + L1
 *   L3 apps/studio                                    → 许依赖任意 packages
 *   scripts/ 与 tests/ 是工具链，不受分层约束
 */
const TIER1 = ["session", "llm", "tools", "agent-loop", "workers"];
const TIER2 = ["runtime"];
const PACKAGES = ["core", ...TIER1, ...TIER2];
const pkgPath = (names) => `^packages/(${names.join("|")})/`;
const ALL_PKG_RE = pkgPath(PACKAGES);

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "禁止循环依赖：环会让分层失效，也让增量构建/测试互相牵连（ARCHITECTURE.md §1）。",
      from: {},
      to: { circular: true },
    },
    {
      name: "core-is-leaf",
      severity: "error",
      comment: "packages/core 是零依赖叶子层：不得依赖任何其他 packages（ARCHITECTURE.md §1）。",
      from: { path: "^packages/core/src" },
      to: { path: ALL_PKG_RE, pathNot: "^packages/core/" },
    },
    {
      name: "no-packages-to-apps",
      severity: "error",
      comment: "反向依赖被禁止：packages/* 不得依赖 apps/*（ARCHITECTURE.md §1）。",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    // 第 1 层包只允许依赖 core；横向依赖要么走 core 的 seam，
    // 要么在评审中显式登记依赖矩阵（ARCHITECTURE.md §1）。
    ...TIER1.map((p) => ({
      name: `tier1-no-peer-deps-${p}`,
      severity: "error",
      comment: `packages/${p} 属于第 1 层：只允许依赖 @celestea/core，不得横向依赖同层或 runtime。`,
      from: { path: `^packages/${p}/` },
      to: { path: pkgPath(TIER1.concat(TIER2)), pathNot: `^packages/${p}/` },
    })),
    {
      name: "no-orphans-in-packages",
      severity: "warn",
      comment: "packages/*/src 下不应存在无人引用的模块（除包入口 index.ts），否则说明职责漂浮。",
      from: { orphan: true, path: "^packages/[^/]+/src/", pathNot: "^packages/[^/]+/src/index\\.ts$" },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "导入必须可解析：别名/相对路径写错会让边界规则静默失效。",
      from: {},
      to: { couldNotResolve: true },
    },
    // 跨包必须走 `@celestea/<pkg>` 别名，禁止用相对路径深穿到另一个包（ARCHITECTURE.md §1）。
    ...PACKAGES.map((p) => ({
      name: `no-relative-into-${p}`,
      severity: "error",
      comment: `包外只能用 @celestea/${p} 引用本包；相对路径深穿到 packages/${p}/src 会绕过公开 API 收口。`,
      from: { path: `^packages/(?!${p}/)` },
      to: { path: `^packages/${p}/`, dependencyTypesNot: ["aliased-tsconfig-paths"] },
    })),
    ...PACKAGES.map((p) => ({
      name: `entry-only-${p}`,
      severity: "error",
      comment: `@celestea/${p} 的公开 API 只在 src/index.ts：包外引用内部模块属于深层导入（ARCHITECTURE.md §2）。`,
      from: { pathNot: `^packages/${p}/src/` },
      to: { path: `^packages/${p}/src/`, pathNot: `^packages/${p}/src/index\\.ts$` },
    })),
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules($|/)" },
    exclude: { path: "(^|/)(node_modules|dist)($|/)|^reports/|^fixtures/|^contracts/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json"],
    },
    combinedDependencies: false,
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
