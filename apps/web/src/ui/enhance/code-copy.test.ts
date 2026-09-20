// @vitest-environment jsdom
// ============================================================================
// W895 · P0 验收：第一项可选组件「代码块复制」。
//   · 幂等 —— 流式每节拍重跑，按钮只能加一次；
//   · 包一层 .code-wrap —— pre 自己 overflow-x:auto，按钮放里面会横向滚走；
//   · 可关 —— 注销后不再施加（A3 的组件侧证明）。
// ============================================================================
import { beforeEach, describe, expect, it } from "vitest";
import { CODE_COPY_ID, codeCopyEnhancer } from "./code-copy";
import { enhancerIds, registerEnhancer, runEnhancers } from "./registry";
import { deactivatePlugin, registerEnhancerPlugin } from "../../plugins/register";
import { PLUGINS_STORAGE_KEY } from "../../plugins/store";

function containerWith(html: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "content";
  box.innerHTML = html;
  document.body.appendChild(box);
  return box;
}

beforeEach(() => {
  localStorage.removeItem(PLUGINS_STORAGE_KEY);
  document.body.innerHTML = "";
});

describe("W895 code-copy component", () => {
  it("adds exactly one button per code block, idempotently", () => {
    const box = containerWith("<pre><code>const a = 1;</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      runEnhancers(box);
      runEnhancers(box);
      expect(box.querySelectorAll("button.code-copy")).toHaveLength(1);
    } finally { off(); }
  });

  it("wraps the pre so the button does not scroll with the code", () => {
    const box = containerWith("<pre><code>x</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      const wrap = box.querySelector(".code-wrap");
      expect(wrap).not.toBeNull();
      // 按钮是 pre 的**兄弟**，不是子节点 —— 否则 overflow-x 会把它带走。
      expect(wrap!.querySelector("pre")).not.toBeNull();
      expect(wrap!.querySelector("button.code-copy")).not.toBeNull();
      expect(box.querySelector("pre button")).toBeNull();
    } finally { off(); }
  });

  it("handles several code blocks independently", () => {
    const box = containerWith("<pre><code>a</code></pre><p>text</p><pre><code>b</code></pre>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      expect(box.querySelectorAll("button.code-copy")).toHaveLength(2);
    } finally { off(); }
  });

  it("leaves a container with no code block untouched", () => {
    const box = containerWith("<p>just text</p>");
    const off = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      expect(box.querySelectorAll("button")).toHaveLength(0);
      expect(box.querySelectorAll(".code-wrap")).toHaveLength(0);
    } finally { off(); }
  });

  it("A3: turning the component off really unregisters it", () => {
    registerEnhancerPlugin(codeCopyEnhancer());
    expect(enhancerIds()).toContain(CODE_COPY_ID);
    deactivatePlugin(CODE_COPY_ID);
    expect(enhancerIds()).not.toContain(CODE_COPY_ID);
    // 关掉之后，新容器不再被施加该增强。
    const box = containerWith("<pre><code>x</code></pre>");
    runEnhancers(box);
    expect(box.querySelectorAll("button.code-copy")).toHaveLength(0);
  });
});
