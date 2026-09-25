#!/usr/bin/env node
/**
 * 门禁 · 测试不得往 /tmp 泄漏临时目录 —— W1529。
 *
 * 为什么需要它：99 个测试文件共 231 次 `mkdtempSync(join(tmpdir(), "<prefix>-"))`，
 * 绝大多数从不删除自己建的东西。每跑一次全量 `pnpm check` 就在宿主机 `/tmp` 留几千个
 * 目录 —— 本机实测累积 11032 条（celestea-reg- 2871 / celestea-wd- 2912 /
 * celestea-results- 1820 / w1470- 1387 / w6-bwrap- 412 …），占 18G tmpfs 的 4.4G。
 *
 * 根治不在逐文件补 `rmSync`（99 处、99 次漏的机会，且新测试会再犯），而在
 * `vitest.setup.ts` 把 `os.tmpdir()` 整体重定向到一个 per-file 目录并在 `afterAll` 回收。
 * 本门禁守的就是那条重定向**仍然存在**（有人删掉它 ⇒ 立刻红）。
 *
 * 判据（两条，都是机械的）：
 *   ① `vitest.setup.ts` 必须设置 TMPDIR/TMP/TEMP 并引用 CELESTEA_TEST_TMPDIR；
 *   ② 必须存在对应的 rmSync 回收（不能只重定向不清理）。
 * 只读源码、零产物、确定性 —— 与 check:fast 同族，任何时刻可跑。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = join(ROOT, "vitest.setup.ts");

const failures = [];

let source;
try {
  source = readFileSync(SETUP, "utf8");
} catch (error) {
  console.error(`✗ 读不到 ${SETUP}：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// ① 三个变量都必须被赋值成**重定向目录本身**（testTmp），不是任意值。
// 只要求「有赋值」会假绿：还原块 `process.env["TMPDIR"] = OUTER_TMP` 也满足该形状，
// 于是「删掉设置、保留还原」这种真损坏检测不到（实测踩到，故收紧成必须指向 testTmp）。
for (const key of ["TMPDIR", "TMP", "TEMP"]) {
  const redirected = new RegExp(`process\\.env\\[?"${key}"?\\]\\s*=\\s*testTmp\\b`).test(source);
  if (!redirected) {
    failures.push(`vitest.setup.ts 未把 process.env["${key}"] 设为 testTmp（os.tmpdir() 在该平台不会重定向到我们回收的目录）`);
  }
}

// 重定向的根必须是我们自己 mkdtemp 出来的那个（否则会指到宿主机真实 /tmp）。
if (!source.includes("CELESTEA_TEST_TMPDIR")) {
  failures.push("vitest.setup.ts 未使用 CELESTEA_TEST_TMPDIR 哨兵（重入保护与回收都会失效）");
}
if (!/mkdtempSync\(/.test(source)) {
  failures.push("vitest.setup.ts 未见 mkdtempSync（重定向目录必须是新建的，不能复用宿主机 /tmp）");
}

// ② 只重定向不回收 = 把泄漏从「几千个小目录」变成「几个大目录」，同样不合格。
if (!/rmSync\(\s*testTmp|rmSync\(\s*[a-zA-Z]*[Tt]mp/.test(source)) {
  failures.push("vitest.setup.ts 未见对重定向目录的 rmSync 回收（只重定向不清理仍会泄漏）");
}
if (!/afterAll\(/.test(source)) {
  failures.push("vitest.setup.ts 未在 afterAll 回收（beforeEach/afterEach 会漏掉模块作用域的 mkdtemp）");
}
// ③ 自愈：worker 被 SIGKILL 时 afterAll 不会跑（沙箱测试故意杀父进程），
// 故必须有「启动时清扫上轮孤儿」的路径，否则残留会随运行次数累积。
// 必须匹配**调用**（独立成行的 `sweepOrphaned();`），不能只匹配标识符 ——
// 函数定义里也有 `function sweepOrphaned()`，只查名字会在「删掉调用、保留定义」时假绿（实测踩到）。
if (!/^\s*sweepOrphaned\(\);\s*$/m.test(source) || !/readdirSync\(/.test(source)) {
  failures.push("vitest.setup.ts 未调用 sweepOrphaned() 自愈清扫（SIGKILL 掉的 worker 会累积残留）");
}

if (failures.length > 0) {
  console.error("\n✗ 测试临时目录门禁未通过（/tmp 泄漏防护被削弱）\n");
  for (const f of failures) console.error(`  · ${f}`);
  console.error("\n  背景：W1529 把 os.tmpdir() 重定向到 per-file 目录并回收，");
  console.error("  本门禁防止该防护被无声删除（删掉后每跑一次全量就泄漏数千目录）。\n");
  process.exit(1);
}

console.log("✓ 测试临时目录门禁通过（os.tmpdir() 已重定向到 per-file 目录并在 afterAll 回收）");
