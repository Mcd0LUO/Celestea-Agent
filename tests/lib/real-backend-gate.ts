/**
 * W862 · 真实后端套件的显式选入门禁（唯一真源）。
 *
 * 真人事故：根 \`pnpm check\` 会真打正在运行的生产 3777 —— 自动化测试的降级用例把
 * 「模型 … 拒绝了图像输入」提示广播进了用户界面，三个套件还会改写服务端全局
 * active_session。因此默认门禁必须 hermetic：
 *
 *   · 未设 CELESTEA_E2E=1：一个 HTTP 都不发（连可达性探测都不发），整文件以可见的
 *     skip 结束，并用 requireOptIn 打印选入口令。
 *   · 设了 CELESTEA_E2E=1：照常完整运行，断言一条不删；服务不可达也不静默跳过 ——
 *     失败即真实失败（本模块返回 false，调用方靠 describe.skipIf(!E2E_OPT_IN) 放行）。
 *   · LIVE_REQUIRED（LIVE=required / CELESTEA_E2E_REQUIRED=1）：探测失败时在收集期
 *     直接抛错（与原行为一致，绝不绿色掩盖）。
 */

/** 是否显式选入真实后端套件：只有 "1" 算选入，缺省绝不放行。 */
export const E2E_OPT_IN = process.env["CELESTEA_E2E"] === "1";
const LIVE_REQUIRED = process.env["LIVE"] === "required" || process.env["CELESTEA_E2E_REQUIRED"] === "1";

/** 未选入时打印选入口令（收集期可见；配合 describe.skipIf 得到**可见的 skip**）。 */
export function requireOptIn(tag: string): void {
  if (!E2E_OPT_IN) {
    console.warn(
      "[" + tag + "] 真实后端套件默认跳过：设 CELESTEA_E2E=1 后 \`npx vitest run --project real-backend\`",
    );
  }
}

/**
 * 显式选入时探测真实服务一次；未选入时**零 HTTP**。选了但不可达：LIVE_REQUIRED
 * 直接抛错，否则打印横幅并返回 false —— 调用方仍照常运行（失败即真实失败）。
 */
export async function reachable(probe: () => Promise<boolean>, tag: string, base: string): Promise<boolean> {
  if (!E2E_OPT_IN) return false;
  const ok = await probe().catch(() => false);
  if (ok) return true;
  const banner = "[" + tag + "] 真实服务不可达（已显式选入，仍照常运行，失败即真实失败）：" + base;
  if (LIVE_REQUIRED) throw new Error(banner);
  console.warn(banner);
  return false;
}
