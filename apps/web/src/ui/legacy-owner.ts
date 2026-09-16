// ============================================================================
// ui/legacy-owner.ts — 旧后端（SSE 无 session 字段）的流归属记录。
//   W805：从 chat.ts 拆出 —— 帧路由（chat.ts）与发送编排（ui/send.ts）共用同一份，
//   避免相互 import 形成环。新后端每帧都带 session，此记录不参与路由。
// ============================================================================
import type { SessionPane } from './viewctx';

let owner: SessionPane | null = null;

export function getLegacyOwner(): SessionPane | null {
  return owner;
}

export function setLegacyOwner(pane: SessionPane | null): void {
  owner = pane;
}
