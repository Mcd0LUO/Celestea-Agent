#!/usr/bin/env node
/**
 * 门禁 · SSE 事件名三方一致 —— W1479。
 *
 * 为什么需要它：前端曾同时订阅 `context` 与 `inbox`，而服务端**永远发不出**这两个
 * 名字（`apps/studio/src/sse.ts` 的 `assertEventName` 每次 emit 都断言契约清单）。
 * 那两条监听是死代码，实时注入因此只在刷新后（走 transcript 回放）才出现——
 * 界面上「看起来接好了」，实际什么都不渲染。三方清单谁都不管谁，所以没人发现。
 *
 * 三方（缺一不可）：
 *   ① 冻结契约  contracts/sse-events.json      —— 线上协议的权威字节
 *   ② 服务端    packages/core SSE_EVENT_NAMES  —— 总线 emit 时的断言源
 *   ③ 前端      apps/web/src/sse.ts EVENT_NAMES —— 真正 addEventListener 的清单
 *
 * 规则：
 *   · ①②③ 的**集合**必须相等；
 *   · 前端可以**少听**某些名字，但必须在 KNOWN_UNLISTENED 里显式登记（不是靠漏写）；
 *   · 前端**多听**任何名字 = 死代码，直接失败。
 *
 * 用法：
 *   node tools/check-sse-events.mjs              # 对拍（pnpm check 用）
 *   node tools/check-sse-events.mjs --self-test  # 另证「能机械失败」
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 仓根：apps/web/tools/ -> apps/web -> apps -> <repo>。 */
const REPO = path.resolve(ROOT, '..', '..');

/**
 * 服务端会发、但前端**故意**不监听的名字，附理由。
 *
 * `turn_end`：前端从 `status` 的 phase 与 `done` 得知轮次结束；它没有独立的 UI 语义。
 * 这是**已知的**取舍，不是漂移——所以写在这里，而不是靠前端漏写一行。
 */
const KNOWN_UNLISTENED = new Map([['turn_end', 'the UI learns a turn end from the status phase and done']]);

const SELF_TEST = process.argv.includes('--self-test');

/** 冻结契约里的名字（顺序即契约顺序）。 */
function contractNames() {
  const file = path.join(REPO, 'contracts', 'sse-events.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(doc.events)) throw new Error('contracts/sse-events.json: events[] is missing');
  return doc.events.map((e) => e.name);
}

/** `packages/core` 里的 `SSE_EVENT_NAMES`（服务端 emit 断言的真源）。 */
function coreNames() {
  const file = path.join(REPO, 'packages', 'core', 'src', 'types.ts');
  const text = readFileSync(file, 'utf8');
  const m = /SSE_EVENT_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(text);
  if (m === null) throw new Error('packages/core/src/types.ts: SSE_EVENT_NAMES not found');
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

/** `apps/web/src/sse.ts` 的 `EVENT_NAMES`（真正 addEventListener 的清单）。 */
function frontendNames() {
  const file = path.join(ROOT, 'src', 'sse.ts');
  const text = readFileSync(file, 'utf8');
  const m = /const EVENT_NAMES[^=]*=\s*\[([\s\S]*?)\]/.exec(text);
  if (m === null) throw new Error('src/sse.ts: EVENT_NAMES not found');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** 前端 `SseEventName` 联合类型的成员（它必须与监听清单一致，否则类型在说谎）。 */
function frontendTypeNames() {
  const file = path.join(ROOT, 'src', 'types.ts');
  const text = readFileSync(file, 'utf8');
  const m = /export type SseEventName =([\s\S]*?);/.exec(text);
  if (m === null) throw new Error('src/types.ts: SseEventName not found');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const diff = (a, b) => a.filter((x) => !new Set(b).has(x));

function main() {
  const contract = SELF_TEST ? [...contractNames(), 'sabotage'] : contractNames();
  const core = coreNames();
  const front = frontendNames();
  const typeNames = frontendTypeNames();
  const problems = [];

  if (!same(contract, core)) {
    problems.push(`contracts/sse-events.json 与 packages/core SSE_EVENT_NAMES 不一致：只在前者 ${JSON.stringify(diff(contract, core))}；只在后者 ${JSON.stringify(diff(core, contract))}`);
  }

  const emitted = new Set(core);
  const dead = front.filter((n) => !emitted.has(n));
  if (dead.length > 0) {
    problems.push(`前端监听了服务端发不出的名字（死代码）：${JSON.stringify(dead)} —— 删掉监听，或把该名字加进契约`);
  }

  const unlistened = core.filter((n) => !new Set(front).has(n));
  const undocumented = unlistened.filter((n) => !KNOWN_UNLISTENED.has(n));
  if (undocumented.length > 0) {
    problems.push(`前端没监听 ${JSON.stringify(undocumented)}，且未在 KNOWN_UNLISTENED 登记（要么监听，要么写明理由）`);
  }
  const stale = [...KNOWN_UNLISTENED.keys()].filter((n) => !unlistened.includes(n));
  if (stale.length > 0) {
    problems.push(`KNOWN_UNLISTENED 里的 ${JSON.stringify(stale)} 其实已被监听（陈旧登记，请删）`);
  }

  if (!same(front, typeNames)) {
    problems.push(`src/sse.ts EVENT_NAMES 与 src/types.ts SseEventName 不一致：只在 EVENT_NAMES ${JSON.stringify(diff(front, typeNames))}；只在 SseEventName ${JSON.stringify(diff(typeNames, front))}`);
  }

  if (problems.length > 0) {
    for (const p of problems) console.error('✗ ' + p);
    console.error(`  （契约 ${contract.length} / core ${core.length} / 前端监听 ${front.length}）`);
    process.exit(1);
  }
  console.log(`✓ SSE 事件名门禁通过：契约 == core == 前端（${front.length} 个名字；前端刻意不监听 ${JSON.stringify(unlistened)}）`);
}

main();
