// @ts-check
/**
 * celestea_studio-ts —— 架构规则的机械强制（ESLint flat config）。
 *
 * 这里只放「结构类」规则：文件/函数规模、嵌套深度、参数个数、跨包导入边界。
 * 与 dependency-cruiser（`pnpm lint:arch`）分工：
 *   - ESLint      = 单文件粒度的静态形状（规模 + 导入字面量）
 *   - dep-cruiser = 仓级依赖图（分层方向、循环、深层导入、不可解析）
 *
 * 规则正文见 docs/ARCHITECTURE.md §3/§4，例外清单见 §5。
 * 例外只能登记在下方 ARCH_EXCEPTIONS（唯一真源），每条必须有 原因 / 拆分方案 / 移除阶段。
 */
import tseslint from "typescript-eslint";

/** 单文件规模上限（跳过空行与注释）。 */
const MAX_LINES = 400;
/** 单函数规模上限（跳过空行与注释）。 */
const MAX_LINES_PER_FUNCTION = 80;
/** 控制流嵌套上限。 */
const MAX_DEPTH = 4;
/** 形参个数上限。 */
const MAX_PARAMS = 5;
/** 回调嵌套上限。 */
const MAX_NESTED_CALLBACKS = 4;

const SOURCE_GLOBS = ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"];
/** 测试文件的规模规则照旧，但允许 import 自己被测的包。 */
const TEST_GLOBS = ["**/*.test.ts", "**/*.test-util.ts", "**/*.spec.ts"];

/** 第 1 层：只允许依赖 core。 */
const TIER1 = ["session", "llm", "tools", "agent-loop", "workers"];
/** 第 2 层：装配层，允许依赖 core + 第 1 层。 */
const TIER2 = ["runtime"];

const lines = (max) => ["error", { max, skipBlankLines: true, skipComments: true }];
const linesPerFunction = (max) => ["error", { max, skipBlankLines: true, skipComments: true, IIFEs: true }];

/**
 * 已知规模例外（唯一真源；docs/ARCHITECTURE.md §5 逐条对应）。
 * 只放宽被点名文件被点名的那一条规则，不用通配符、不放宽整目录。
 * 复核：`ARCH_STRICT=1 pnpm lint` 会忽略全部例外，输出即为「例外清单清零后的真实违规」。
 */
const ARCH_EXCEPTIONS = [
  {
    id: "EX-01",
    files: ["packages/core/src/redact.ts"],
    rules: { "max-lines-per-function": linesPerFunction(90), "max-depth": ["error", 5] },
    reason: "P0 遗留：createRedactor 81 行；discover() 与 collectKnownSecrets() 控制流嵌套 5 层（规则表内联在函数里）",
    plan: "把 DEFAULT_RULES / CREDENTIAL_CONTEXTS / 环境变量名单提到模块级常量表，并抽出 collectProviderKeys()，两个函数即可回到 ≤80 行 / ≤4 层",
    removeIn: "P1（core 收口时，W271 领地）",
  },
  {
    id: "EX-02",
    files: ["scripts/export-golden.ts"],
    rules: { "max-lines-per-function": linesPerFunction(260), "max-depth": ["error", 5] },
    reason: "P0 一次性导出脚本：main() 249 行线性编排（探针清单 → 拉取 → 脱敏 → 写盘）",
    plan: "拆 scripts/golden/{probe,fetch,redact,write}.ts，main() 只保留步骤编排",
    removeIn: "P1 工具链整理",
  },
  {
    id: "EX-03",
    files: ["scripts/verify-contracts.ts"],
    rules: { "max-lines-per-function": linesPerFunction(170) },
    reason: "P0 校验脚本：main() 162 行线性探针清单（20 端点 × 断言）",
    plan: "探针清单抽成数据表（数组字面量）+ runProbe() 循环",
    removeIn: "P1 工具链整理",
  },
  {
    id: "EX-04",
    files: ["scripts/compare-replay.ts"],
    rules: { "max-lines-per-function": linesPerFunction(125) },
    reason: "P0 对拍脚本：main() 115 行依次跑 A–E 五组对比并汇总写报告",
    plan: "每组对比抽成独立 compareX()，main() 只做调度与汇总",
    removeIn: "P1 工具链整理",
  },
];

/**
 * 生成「只放宽被点名文件被点名规则」的 override 条目。
 * `ARCH_STRICT=1 pnpm lint` 会忽略全部例外，用于定期复核例外是否还有必要（ARCHITECTURE.md §5）。
 */
const exceptionOverrides = (process.env.ARCH_STRICT === "1" ? [] : ARCH_EXCEPTIONS).map((ex) => ({
  name: `arch-exception/${ex.id}`,
  files: ex.files,
  rules: ex.rules,
}));

const DEEP_IMPORT = {
  group: ["@celestea/*/*"],
  message: "跨包深层导入被禁止：只允许 `@celestea/<pkg>`，公开 API 收口在该包 src/index.ts。",
};
const DEEP_RELATIVE = {
  group: ["../../*", "../../../*"],
  message: "禁止跨目录深层相对导入：包内用 `./x.js`，跨包用 `@celestea/<pkg>`。",
};

const ALL_TIER_PACKAGES = TIER1.concat(TIER2);

/** 跨包边界说明文案。 */
const MSG_CORE_LEAF = "packages/core 是零依赖叶子层：不得依赖任何其他 @celestea 包（ARCHITECTURE.md §1）。";
const MSG_NO_APPS = "反向依赖被禁止：packages/* 不得依赖 apps/studio（ARCHITECTURE.md §1）。";
const MSG_TIER1 = "第 1 层包只允许依赖 @celestea/core；横向能力走 core 的 seam，或在评审中显式登记依赖矩阵（ARCHITECTURE.md §1）。";

/**
 * 组装某类文件的完整 no-restricted-imports 模式表。
 * 注意：ESLint 的规则配置是「整体覆盖」而非「按模式合并」，
 * 因此每个 files 块都必须自带完整的模式清单，不能依赖前一个块。
 */
function boundaryPatterns({ coreLeaf = false, noApps = false, tier1 = false } = {}) {
  const patterns = [];
  if (coreLeaf) {
    patterns.push({ group: ALL_TIER_PACKAGES.concat("studio").map((p) => `@celestea/${p}`), message: MSG_CORE_LEAF });
  }
  if (noApps) {
    patterns.push({ group: ["@celestea/studio"], message: MSG_NO_APPS });
  }
  if (tier1) {
    patterns.push({ group: ALL_TIER_PACKAGES.map((p) => `@celestea/${p}`), message: MSG_TIER1 });
  }
  patterns.push(DEEP_IMPORT, DEEP_RELATIVE);
  return patterns;
}

export default tseslint.config(
  {
    name: "arch/ignores",
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "reports/**",
      "fixtures/**",
      "contracts/**",
      "**/*.json",
      "**/*.md",
    ],
  },
  {
    name: "arch/parser",
    files: SOURCE_GLOBS,
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
  },
  {
    name: "arch/size",
    files: SOURCE_GLOBS,
    rules: {
      "max-lines": lines(MAX_LINES),
      "max-lines-per-function": linesPerFunction(MAX_LINES_PER_FUNCTION),
      "max-depth": ["error", MAX_DEPTH],
      "max-params": ["error", MAX_PARAMS],
      "max-nested-callbacks": ["error", MAX_NESTED_CALLBACKS],
    },
  },
  {
    // 测试文件：单条用例是线性 arrange-act-assert，块上限放宽到 150 行；
    // 文件级 400 行、嵌套深度、参数个数仍然照旧（ARCHITECTURE.md §4.1）。
    name: "arch/size-tests",
    files: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.ts", "**/*.test-util.ts"],
    rules: {
      "max-lines-per-function": linesPerFunction(150),
    },
  },
  {
    name: "arch/import-boundary",
    files: SOURCE_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: [DEEP_IMPORT, DEEP_RELATIVE] }],
    },
  },
  {
    // packages 不得依赖 apps（反向依赖）。
    name: "arch/no-packages-to-apps",
    files: ["packages/*/src/**/*.ts"],
    ignores: TEST_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: boundaryPatterns({ noApps: true }) }],
    },
  },
  {
    // 第 1 层包之间不得互相依赖（同层横向依赖会制造隐式耦合）。
    name: "arch/tier1-no-peer-deps",
    files: TIER1.map((p) => `packages/${p}/src/**/*.ts`),
    ignores: TEST_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: boundaryPatterns({ noApps: true, tier1: true }) }],
    },
  },
  {
    // core 是零依赖叶子：不得 import 任何其他 @celestea 包。
    // 注意：ESLint 的规则配置是「整块覆盖」，本块必须在通用/包级块之后，
    // 且自带 noApps 模式，否则会被前面的块覆盖掉。
    name: "arch/core-is-leaf",
    files: ["packages/core/src/**/*.ts"],
    ignores: TEST_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: boundaryPatterns({ noApps: true, coreLeaf: true }) }],
    },
  },
  ...exceptionOverrides,
);
