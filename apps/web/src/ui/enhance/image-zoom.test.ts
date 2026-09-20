// @vitest-environment jsdom
/**
 * W895-C2 — 图片灯箱。
 *
 * 打开/关闭（遮罩、按钮、Esc 走 overlays 栈）、滚动锁与还原、无障碍属性、幂等。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ZoomMod {
  imageZoomEnhancer(): { id: string; enhance(c: Element): void };
  openLightbox(img: HTMLImageElement): void;
  closeLightbox(): void;
  IMAGE_ZOOM_ID: string;
}
interface OverlaysMod {
  overlayDepth(): number;
}

async function mods(): Promise<{ zoom: ZoomMod; overlays: OverlaysMod }> {
  const zoom = (await import(/* @vite-ignore */ "./image-zoom")) as ZoomMod;
  const overlays = (await import(/* @vite-ignore */ "../../utils/overlays")) as OverlaysMod;
  return { zoom, overlays };
}

function imageIn(container: Element): HTMLImageElement {
  const img = document.createElement("img");
  img.src = "photo.png";
  img.alt = "a photo";
  container.appendChild(img);
  return img;
}

beforeEach(() => {
  vi.resetModules();
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

describe("W895-C2 imageZoomEnhancer", () => {
  it("给图片加可聚焦/aria 属性，点击打开灯箱并锁滚动", async () => {
    const { zoom, overlays } = await mods();
    const container = document.createElement("div");
    const img = imageIn(container);
    zoom.imageZoomEnhancer().enhance(container);
    expect(img.dataset["zoomDone"]).toBe("1");
    expect(img.tabIndex).toBe(0);
    expect(img.getAttribute("role")).toBe("button");
    expect(img.getAttribute("aria-label")).toBeTruthy();

    img.click();
    const overlay = document.querySelector(".img-zoom");
    expect(overlay).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    expect(overlays.overlayDepth()).toBe(1);
    expect(overlay!.querySelector<HTMLImageElement>(".img-zoom-img")?.alt).toBe("a photo");
  });

  it("点遮罩关闭并还原滚动；幂等重入只开一层", async () => {
    const { zoom, overlays } = await mods();
    const container = document.createElement("div");
    const img = imageIn(container);
    const enh = zoom.imageZoomEnhancer();
    enh.enhance(container);
    enh.enhance(container); // 幂等：不重复绑监听
    img.click();
    const overlay = document.querySelector(".img-zoom") as HTMLElement;
    overlay.click(); // 遮罩（target === overlay）
    expect(document.querySelector(".img-zoom")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(overlays.overlayDepth()).toBe(0);
  });

  it("Esc 走既有 overlays 栈关闭（不抢全局监听）", async () => {
    const { zoom, overlays } = await mods();
    const container = document.createElement("div");
    const img = imageIn(container);
    zoom.imageZoomEnhancer().enhance(container);
    img.click();
    expect(overlays.overlayDepth()).toBe(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".img-zoom")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(overlays.overlayDepth()).toBe(0);
  });

  it("关闭按钮关闭", async () => {
    const { zoom } = await mods();
    const container = document.createElement("div");
    const img = imageIn(container);
    zoom.imageZoomEnhancer().enhance(container);
    img.click();
    (document.querySelector(".img-zoom-close") as HTMLButtonElement).click();
    expect(document.querySelector(".img-zoom")).toBeNull();
  });
});
