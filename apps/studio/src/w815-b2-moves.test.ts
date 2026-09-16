/**
 * W815 (R3 batch B2): session/workspace move compensation + id canonicalization.
 *
 * Handler cases drive the REAL app (makeHarness); the W815-9/10 store cases
 * live next to the store. Source:
 * /server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md
 * (B2 · W815-5/9/10/12 + N1 acceptance probes).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '@celestea/core';
import { createFakeRuntimeAdapter } from './fake-runtime-adapter.js';
import type { RuntimeAdapter } from './runtime-adapter.js';
import { getJson, jsonRequest, makeHarness, type StudioHarness } from './harness.test-util.js';
import * as sessionMeta from './store/session-meta.js';

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeHarness>[0] = {}): StudioHarness {
  const h = makeHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The fake adapter whose busy slot is true ONLY for the canonical id. */
function busyOnly(canonical: string): RuntimeAdapter {
  const base = createFakeRuntimeAdapter();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'isBusy') return (session?: string | null) => session === canonical;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as RuntimeAdapter;
}

describe('W815-5 canonical session id (B2)', () => {
  it('a percent-encoded id can no longer bypass the mode busy guard', async () => {
    const h = make({ runtime: busyOnly('sample-ws/se_ss'), session: { name: 'se_ss', log: '' } });
    // Hono decodes the param to 'sample-ws/se ss'; require() canonicalizes the
    // session component to 'se_ss' — the id the runtime is actually busy on.
    const res = await getJson(h.app, '/api/sessions/sample-ws%2Fse%20ss/mode', jsonRequest('POST', { mode: 'execution' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'turn 进行中，无法切换模式' });
  });

  it('the rename busy guard reads the same canonical id', async () => {
    const h = make({ runtime: busyOnly('sample-ws/se_ss'), session: { name: 'se_ss', log: '' } });
    const res = await getJson(h.app, '/api/sessions/sample-ws%2Fse%20ss/rename', jsonRequest('POST', { new_title: 'x' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'turn in progress; rename applies between turns' });
  });
});

describe('N1 rename meta-write rollback (B2)', () => {
  it('rolls the directory back and keeps active_session resolvable', async () => {
    const h = make({ session: { name: 's1', log: '' } });
    // Force writeTitle to fail: session.json is a DIRECTORY, so the plain
    // writeFileSync throws EISDIR before any bytes land.
    mkdirSync(join(h.workspace, 's1', 'session.json'));
    await getJson(h.app, '/api/sessions/sample-ws%2Fs1/activate', jsonRequest('POST'));
    const res = await getJson(h.app, '/api/sessions/sample-ws%2Fs1/rename', jsonRequest('POST', { new_title: 'renamed' }));
    expect(res.status).toBe(500);
    expect(String(res.body['error'])).toContain('meta write failed:');
    expect(existsSync(join(h.workspace, 's1', 'cli-main.jsonl'))).toBe(true);
    expect(existsSync(join(h.workspace, 'renamed'))).toBe(false);
    const list = await getJson(h.app, '/api/sessions');
    expect(list.body['active_session']).toBe('sample-ws/s1');
    expect((list.body['sessions'] as Array<{ id: string }>).some((r) => r.id === 'sample-ws/s1')).toBe(true);
  });
});

describe('W815-12 contract error strings (B2)', () => {
  function errorTemplates(id: string): string[] {
    const doc = JSON.parse(readFileSync(join(repoRoot(), 'contracts', 'endpoints.json'), 'utf8')) as {
      endpoints: Array<{ id: string; errors: Array<{ error: string }> }>;
    };
    return (doc.endpoints.find((e) => e.id === id)?.errors ?? []).map((e) => e.error);
  }

  it('lists the store real meta-write string for rename and branch', async () => {
    const h = make({ session: { name: 's1', log: '' } });
    mkdirSync(join(h.workspace, 's1', 'session.json'));
    const res = await getJson(h.app, '/api/sessions/sample-ws%2Fs1/rename', jsonRequest('POST', { new_title: 'renamed' }));
    expect(res.status).toBe(500);
    expect(String(res.body['error']).startsWith('meta write failed:')).toBe(true);
    expect(errorTemplates('post_session_rename')).toContain('meta write failed: {e}');
    expect(errorTemplates('post_session_branch')).toContain('meta write failed: {e}');
    // The retired 'meta copy failed' template was never emitted by the store.
    expect(errorTemplates('post_session_branch')).not.toContain('meta copy failed: {e}');
  });

  it('branch real meta-write failure matches the contract template', async () => {
    const h = make({ session: { name: 's1', log: '' } });
    const spy = vi.spyOn(sessionMeta, 'writeSessionMeta').mockImplementation(() => {
      throw new Error('forced meta failure');
    });
    const res = await getJson(h.app, '/api/sessions/sample-ws%2Fs1/branch', jsonRequest('POST', { title: 'copy' }));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'meta write failed: forced meta failure' });
  });
});
