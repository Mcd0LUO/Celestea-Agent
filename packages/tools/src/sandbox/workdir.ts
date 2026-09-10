/**
 * Workdir resolution shared by every sandbox provider.
 *
 * The workdir is the *only* thing a provider may assume is writable, so it is
 * resolved once, canonically, and checked against the configured root before a
 * single process is spawned. This is a **lexical** check (the host has no
 * `CAP_SYS_CHROOT`, see W274 §5): it stops accidental escapes and report
 * nonsense, it is not a containment boundary — containment comes from the
 * provider (bwrap read-only root / masks).
 */

import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { SandboxConfig } from "@celestea/core";
import { SandboxError } from "@celestea/core";

import { isInside } from "../guard/paths.js";
import { ENV_SHELL_ROOT, ENV_SHELL_WORKDIR } from "./config.js";

/** Resolve the effective workdir: existing, canonical, inside `config.root`. */
export async function resolveWorkdir(config: SandboxConfig, override?: string): Promise<string> {
  const root = (await canonicalOf(config.root)) ?? resolve(config.root);
  const target = override === undefined ? config.workdir : await resolveOverride(config.workdir, override);
  if (override === undefined) await mkdir(target, { recursive: true }).catch(() => undefined);
  const resolved = await canonicalOf(target);
  if (resolved === null) {
    throw new SandboxError("workdir", `workdir '${target}' cannot be resolved`, { requested: target });
  }
  if (!isInside(resolved, root)) {
    throw new SandboxError(
      "workdir",
      `workdir '${target}' is outside the sandbox root '${root}' (widen with ${ENV_SHELL_ROOT} or adjust ${ENV_SHELL_WORKDIR})`,
      { requested: target, root },
    );
  }
  return resolved;
}

async function resolveOverride(workdir: string, override: string): Promise<string> {
  const target = isAbsolute(override) ? override : resolve(workdir, override);
  const info = await stat(target).catch(() => null);
  if (info === null) {
    throw new SandboxError("workdir", `workdir '${override}' does not exist`, { requested: override });
  }
  if (!info.isDirectory()) {
    throw new SandboxError("workdir", `workdir '${override}' is not a directory`, { requested: override });
  }
  return target;
}

async function canonicalOf(target: string): Promise<string | null> {
  return realpath(target).catch(() => null);
}
