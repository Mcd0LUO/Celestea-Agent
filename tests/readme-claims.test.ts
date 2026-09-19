// @vitest-environment node
/**
 * README 的「硬数字」必须与冻结契约一致。
 *
 * 为什么要有这条：README 首页写着「16 个内置工具」，而 contracts/tools.json 与
 * FROZEN_COUNTS.tools 都是 18（漏了 remember / forget）—— 人工维护的数字必然漂移，
 * 而 README 是别人看到的第一个东西。凡是可以机械核对的数字，就别靠人记。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FROZEN_COUNTS } from '@celestea/core';

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
const TOOLS = JSON.parse(readFileSync(join(process.cwd(), 'contracts', 'tools.json'), 'utf8')) as {
  tools: { name: string }[];
};

describe('README 硬数字 vs 冻结契约', () => {
  it('契约自洽（tools.json 与 FROZEN_COUNTS 一致）', () => {
    expect(TOOLS.tools).toHaveLength(FROZEN_COUNTS.tools);
  });

  it('README 写明的内置工具数量等于契约', () => {
    const m = /\*\*(\d+) 个内置工具\*\*/.exec(README);
    expect(m, 'README 应写明「**N 个内置工具**」').not.toBeNull();
    expect(Number((m as RegExpExecArray)[1])).toBe(TOOLS.tools.length);
  });

  it('README 逐个列出的工具名与契约完全一致', () => {
    const line = README.split('\n').find((l) => l.includes('个内置工具'));
    expect(line, '找不到内置工具那一行').toBeDefined();
    const listed = [...(line as string).matchAll(/`([a-z_]+)`/g)].map((x) => x[1]).sort();
    expect(listed).toEqual(TOOLS.tools.map((t) => t.name).sort());
  });
});
