// ============================================================================
// ui/enhance/image-zoom.ts — 图片灯箱（W895-C2 · 可选组件）
// ----------------------------------------------------------------------------
// 触发：消息正文里的 <img>（img 本来就在净化器白名单里，这里不动净化器）。
// 行为：点击 / Enter / Space 打开浮层显示原图；点遮罩、点关闭按钮、按 Esc 关闭。
//   · Esc **走既有 overlays 栈**（utils/overlays.ts 的唯一 document keydown），
//     不自己抢全局监听 —— 否则会与预览面板、命令面板的 Esc 打架；
//   · 打开时锁 body 滚动，关闭还原；浮层可聚焦、有 aria-label、焦点可见；
//   · 幂等：每张图 dataset.zoomDone 标记，不重复绑监听。
// ============================================================================
import { t } from "../../i18n";
import { popOverlay, pushOverlay, type OverlayHandle } from "../../utils/overlays";
import type { Enhancer } from "./registry";

/** 登记表 / 设置页 / 测试共用的身份。 */
export const IMAGE_ZOOM_ID = "display.imageZoom";

/** 一个「图片灯箱」遍（工厂：幂等，可反复调用）。 */
export function imageZoomEnhancer(): Enhancer {
  return { id: IMAGE_ZOOM_ID, enhance: applyImageZoom };
}

function applyImageZoom(container: Element): void {
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>("img"))) {
    if (img.dataset["zoomDone"] === "1") continue;
    img.dataset["zoomDone"] = "1";
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.setAttribute("aria-label", t("chat.imageZoom.view"));
    img.addEventListener("click", () => openLightbox(img));
    img.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openLightbox(img);
      }
    });
  }
}

/** 同一时刻只允许一个灯箱；句柄用于 overlays 栈精准摘除。 */
let handle: OverlayHandle | null = null;
let restoreOverflow = "";

/** 打开灯箱（重复调用先关旧的，保证只有一层）。 */
export function openLightbox(img: HTMLImageElement): void {
  closeLightbox();
  const overlay = document.createElement("div");
  overlay.className = "img-zoom";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", t("chat.imageZoom.view"));
  const big = document.createElement("img");
  big.className = "img-zoom-img";
  big.src = img.currentSrc !== "" ? img.currentSrc : img.src;
  big.alt = img.alt;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn img-zoom-close";
  close.textContent = t("chat.imageZoom.close");
  overlay.append(big, close);
  restoreOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLightbox();
  });
  close.addEventListener("click", () => closeLightbox());
  document.body.appendChild(overlay);
  handle = pushOverlay(closeLightbox);
  big.focus();
}

/** 关闭并清理（幂等：overlays 栈在 Esc 路径已先摘除，这里再 pop 是 no-op）。 */
export function closeLightbox(): void {
  document.querySelector(".img-zoom")?.remove();
  document.body.style.overflow = restoreOverflow;
  const h = handle;
  handle = null;
  if (h !== null) popOverlay(h);
}
