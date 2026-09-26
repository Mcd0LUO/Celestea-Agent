// ============================================================================
// ui/enhance/registry.ts — 渲染后「容器增强遍」的注册缝（W895 · P0）
// ----------------------------------------------------------------------------
// 形状照抄 ui/hint/registry.ts 的既有取舍（见其头部注释）：具名提供者 +
// register(...) -> dispose + 单一挂载点。本仓是单 Vite 产物、无 cordis、无 React，
// 装不下 DSH 那条「每插件一 bundle + 等全部激活」的管线（W895 实测：51 个 client.js、
// 3.9M、激活屏障拖住首屏），所以只抄形状。
//
// 为什么需要这条缝：渲染后本来就有两个**写死**的增强遍（hljs 高亮、数学占位升级），
// 它们是容器级、幂等、可重复调用的。把这两处调用换成注册表，显示类能力才能做成
// 「可注册 + 可开关」的组件，而不必改渲染管线本身。
//
// ★ 幂等由**实现方**负责：流式渲染每个节拍都会重跑整条链，实现方必须自己打标记
//   （现有 dataset.hlDone 就是范例）。缝不替实现方去重 —— 去重需要理解 DOM 语义。
// ============================================================================

/** 一个容器增强遍。
 *
 * `enhance` 会被反复传入**同一个**容器（流式每个节拍一次），所以实现必须幂等。
 */
export interface Enhancer {
  /** 身份：诊断与测试读它；同名重复注册 = 用新实现替换旧的（重挂载语义）。 */
  id: string;
  /** 就地增强容器（不得返回替代节点 —— 调用方不做替换）。 */
  enhance(container: Element): void;
  /**
   * W9108：**执行顺序键**（小者先跑；缺省 100）。同键按注册顺序（sort 稳定）。
   *
   * 为什么必须有它（而不是靠「谁先注册」）：内置两遍（高亮 / 数学）现在也是
   * **可热开关的客户端插件**，关掉再打开 = 注销 + 重新注册 —— 重新注册必然排在
   * 当时已注册的其它遍之后。而 hljs 必须先于 code-extras（否则 code-extras 切好的
   * 行号会被 hljs 的 `highlightElement` 整体替换 innerHTML 而**静默抹掉**）。
   * 把顺序从「注册时机」变成「声明的常量」，重挂载就再也不可能破坏它。
   */
  order?: number;
}

/** 顺序键缺省值：未声明的遍排在内置两遍之后（保持既有相对顺序）。 */
const DEFAULT_ORDER = 100;

const enhancers: Enhancer[] = [];

/** 按顺序键排序（稳定：同键保持注册先后）。 */
function resort(): void {
  enhancers.sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER));
}

/**
 * 注册一个增强遍，返回注销器（对齐 DSH `register(...) -> dispose`）。
 * 幂等：同 id 重复注册 = 替换（重挂载语义），不产生重复执行。
 */
export function registerEnhancer(e: Enhancer): () => void {
  const i = enhancers.findIndex((x) => x.id === e.id);
  if (i >= 0) enhancers[i] = e;
  else enhancers.push(e);
  resort();
  return () => {
    const j = enhancers.indexOf(e);
    if (j >= 0) enhancers.splice(j, 1);
  };
}

/**
 * 按注册顺序对容器执行全部增强遍（遍历时快照，避免注册/注销改动正在跑的链）。
 *
 * `container` 是**作用域**：增强遍用 `container.querySelectorAll(sel)` 取目标，
 * 而 querySelectorAll **匹配不到容器自身**。所以调用方必须传「包住目标的容器」；
 * 若传的节点本身就是目标（例如预览一个代码文件时那个 `<pre>`），凡以 `pre` 为
 * 选择器的增强遍都会**静默跳过** —— 实测踩过：高亮正常但复制按钮/行号/徽标全没有。
 */
export function runEnhancers(container: Element): void {
  for (const e of enhancers.slice()) {
    // W1479: isolate each enhancer. Without this, ONE throwing enhancer silently
    // disables every enhancer after it in registration order — a bad plugin would
    // look like "the other features just stopped working". Reported WITH the id
    // so the culprit is identifiable; never swallowed.
    try {
      e.enhance(container);
    } catch (err) {
      console.warn('[enhance] enhancer "' + e.id + '" threw', err);
    }
  }
}

/** 当前注册的增强遍 id（注册顺序；诊断/测试用只读快照）。 */
export function enhancerIds(): readonly string[] {
  return enhancers.map((e) => e.id);
}
