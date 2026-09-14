// ============================================================================
// ui/grants/scope.ts — 范围输入校验（本地、提交前；设计 §3.2/§5.4）
//   （W748 从 ui/grants.ts 拆出；纯函数、零 DOM：判定与错误文案逐字未改。）
// ============================================================================
// ---- 范围校验（本地、提交前；§3.2） --------------------------------------------

/** 疑似凭据（与设计 §5.4 同口径）：命中即拒绝提交，且不回显该值。 */
export function looksLikeCredential(v: string): boolean {
  return /sk-/.test(v) || /Bearer\s/.test(v) || v.includes('\n') || v.length > 200;
}

const HOSTNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function isIPv4(v: string): boolean {
  const [addr, bits] = v.split('/');
  if (bits !== undefined && !/^\d{1,2}$/.test(bits)) return false;
  if (bits !== undefined && Number(bits) > 32) return false;
  const parts = (addr ?? '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isIPv6(v: string): boolean {
  const [addr, bits] = v.split('/');
  if (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > 128)) return false;
  if (!addr || !addr.includes(':')) return false;
  return /^[0-9a-fA-F:.]+$/.test(addr);
}

export function isHostOrCidr(v: string): boolean {
  if (v.length > 253) return false;
  if (isIPv4(v) || isIPv6(v)) return true;
  return HOSTNAME_RE.test(v);
}

export function splitList(raw: string): string[] {
  return raw
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function validateHosts(raw: string): { values: string[]; error: string } {
  const parts = splitList(raw);
  if (!parts.length) return { values: [], error: '请至少填写一个站点' };
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const v = parts[i]!;
    if (looksLikeCredential(v)) {
      return { values: [], error: '第 ' + (i + 1) + ' 项疑似包含凭据，不能作为站点提交' };
    }
    if (!isHostOrCidr(v)) {
      return { values: [], error: '第 ' + (i + 1) + ' 项不是有效的主机名、IP 或网段' };
    }
    out.push(v);
  }
  return { values: Array.from(new Set(out)), error: '' };
}

const TOOL_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;

export function validateTools(raw: string): { values: string[]; error: string } {
  const parts = splitList(raw);
  if (!parts.length) return { values: [], error: '请至少填写一个工具名' };
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const v = parts[i]!;
    if (looksLikeCredential(v)) {
      return { values: [], error: '第 ' + (i + 1) + ' 项疑似包含凭据，不能提交' };
    }
    if (!TOOL_RE.test(v)) return { values: [], error: '第 ' + (i + 1) + ' 项不是有效的工具名' };
    out.push(v);
  }
  return { values: Array.from(new Set(out)), error: '' };
}
