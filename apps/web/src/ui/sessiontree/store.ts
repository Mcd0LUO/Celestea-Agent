// ============================================================================
// ui/sessions/store.ts — 会话树的模块级状态（W748 从 ui/sessions.ts 拆出）。
//   只做搬家：变量所有权、初值、写入时机与拆分前逐字一致
//   （含「侧栏与设置页共用同一份模块级状态」这一既有语义）。
// ============================================================================
import type { SessionInfo, WorkspaceInfo } from '../../types';

let batchMode = false;
/** 批量勾选中已选会话 id。 */
export const selected = new Set<string>();

let wsList: WorkspaceInfo[] = [];
let sessions: SessionInfo[] = [];
let activeSession: string | null = null;
let searchQuery = '';
let sortMode: 'active' | 'name' = 'active';
let workerTimer: number | null = null;
let searchTimer: number | null = null;
/** Worker 组内容签名（不变则不重建）。 */
let workerSig = '';

/** W515：父会话 id → worker 子会话数（用于父会话行的「W n」徽标）。 */
let workersByParent = new Map<string, number>();

export const WORKER_POLL_MS = 5000;

export function isBatchMode(): boolean {
  return batchMode;
}

export function setBatchMode(v: boolean): void {
  batchMode = v;
}

export function getWsList(): WorkspaceInfo[] {
  return wsList;
}

export function setWsList(v: WorkspaceInfo[]): void {
  wsList = v;
}

export function getSessions(): SessionInfo[] {
  return sessions;
}

export function setSessions(v: SessionInfo[]): void {
  sessions = v;
}

export function getActiveSession(): string | null {
  return activeSession;
}

export function setActiveSession(v: string | null): void {
  activeSession = v;
}

export function getSearchQuery(): string {
  return searchQuery;
}

export function setSearchQuery(v: string): void {
  searchQuery = v;
}

export function getSortMode(): 'active' | 'name' {
  return sortMode;
}

export function setSortMode(v: 'active' | 'name'): void {
  sortMode = v;
}

export function getWorkerTimer(): number | null {
  return workerTimer;
}

export function setWorkerTimer(v: number | null): void {
  workerTimer = v;
}

export function getSearchTimer(): number | null {
  return searchTimer;
}

export function setSearchTimer(v: number | null): void {
  searchTimer = v;
}

export function getWorkerSig(): string {
  return workerSig;
}

export function setWorkerSig(v: string): void {
  workerSig = v;
}

export function getWorkersByParent(): Map<string, number> {
  return workersByParent;
}

export function setWorkersByParent(v: Map<string, number>): void {
  workersByParent = v;
}
