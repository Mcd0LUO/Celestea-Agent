/**
 * Runtime compose seam (P3 placeholder).
 *
 * P0 freezes the profile key set (12 keys) and the three key-resolution paths
 * so P3 cannot invent new ones.
 */

export interface Profile {
  model: string;
  base_url: string;
  api_key_env: string;
  api_key_file: string | null;
  max_steps: number;
  max_parallel_tool_calls: number;
  reasoning_effort: string | null;
  max_output_tokens: number | null;
  context_window_tokens: number;
  system_prompt: string;
  request_format: "chat_completions" | "responses" | "anthropic_messages";
  temperature: number | null;
}

export const PROFILE_KEYS = [
  "model",
  "base_url",
  "api_key_env",
  "api_key_file",
  "max_steps",
  "max_parallel_tool_calls",
  "reasoning_effort",
  "max_output_tokens",
  "context_window_tokens",
  "system_prompt",
  "request_format",
  "temperature",
] as const;

/** resolve_api_key order: env -> api_key_file -> ~/.celestea config. */
export type KeySource = "env" | "api_key_file" | "home_config" | "provider_store" | "borrowed_engine_key" | "none";

export const COMPOSE_STEPS = [
  "load_dotenv",
  "load_workspaces_registry",
  "restore_active_session",
  "resolve_profile",
  "raise_max_steps",
  "load_providers",
  "apply_startup_default",
  "build_gen",
  "assemble_system_prompt",
  "runtime_compose",
  "build_app_state",
  "spawn_autowake",
  "register_routes",
  "serve",
  "shutdown",
] as const;

export const DEFAULT_BIND = "127.0.0.1:3777";
export const CONTEXT_WINDOW = 1_000_000;
