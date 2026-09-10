/**
 * Host-side mutable settings (the `USER_OVERRIDE` slot + the base-url override).
 *
 * Two things are NOT engine state but must survive between requests:
 *   - `system_prompt` (POST /api/config): a non-empty value bypasses the whole
 *     prompt registry assembly; an empty value clears the override and falls
 *     back to `build_gen` (`src/prompts.rs` memoryOverride);
 *   - `base_url` (POST /api/config): an empty value clears the override so the
 *     env / provider default chain applies again.
 *
 * The api_key is deliberately NOT here: it goes straight into the process env
 * and is never held in a field that could be serialized by accident.
 */

export class StudioSettings {
  private systemPrompt: string | null = null;
  private baseUrl: string | null = null;

  systemPromptOverride(): string | null {
    return this.systemPrompt;
  }

  /** "" clears the override (fall back to the registry assembly). */
  setSystemPromptOverride(value: string): void {
    this.systemPrompt = value.trim() === "" ? null : value;
  }

  baseUrlOverride(): string | null {
    return this.baseUrl;
  }

  /** "" clears the override (fall back to env / provider chain). */
  setBaseUrlOverride(value: string): void {
    this.baseUrl = value === "" ? null : value;
  }
}
