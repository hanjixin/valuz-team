/**
 * The kinds of model channel that can be added, and what follows from a
 * channel's kind and protocol: which wire protocols it speaks, which runtimes
 * its models can drive, and where its endpoint is.
 */
import type { Schema } from "@agent-base/contract";

export type ApiProtocol = "anthropic" | "openai-completion" | "openai-response" | "gemini";
export type RuntimeId = "claude_agent" | "codex" | "deepagents";

type Descriptor = Required<Schema<"ProviderDescriptor">>;

const descriptor = (kind: string, display_name: string, overrides: Partial<Descriptor> = {}): Descriptor => ({
  kind,
  display_name,
  supports_managed_provider: false,
  supports_custom_base_url: false,
  supports_connection_test: true,
  supports_protocol_selection: false,
  default_base_url: "",
  anthropic_base_url: "",
  default_model: "",
  // Deliberately empty: the model list always comes from the upstream itself.
  model_options: [],
  docs_url: "",
  auth_type: "api_key",
  oauth_login_command: "",
  default_protocol: "",
  ...overrides,
});

/**
 * The channels a member can add. The two subscription channels (Claude Pro/Max,
 * Codex · ChatGPT) are not among them: they are built in, and hold nothing —
 * see `subscriptions.ts`.
 */
export const DESCRIPTORS: readonly Descriptor[] = [
  descriptor("anthropic", "Anthropic", {
    default_base_url: "https://api.anthropic.com/v1",
    default_model: "claude-sonnet-4-6",
  }),
  descriptor("openai", "OpenAI", { default_base_url: "https://api.openai.com/v1", default_model: "gpt-5.4" }),
  descriptor("deepseek", "DeepSeek", {
    supports_protocol_selection: true,
    supports_custom_base_url: true,
    default_base_url: "https://api.deepseek.com",
    default_model: "deepseek-v4-flash",
    docs_url: "https://api-docs.deepseek.com/zh-cn/",
  }),
  descriptor("zhipu", "智谱 (GLM)", {
    supports_protocol_selection: true,
    default_base_url: "https://open.bigmodel.cn/api/paas/v4",
    anthropic_base_url: "https://open.bigmodel.cn/api/anthropic",
    default_model: "glm-4-plus",
    docs_url: "https://open.bigmodel.cn/dev/api",
  }),
  descriptor("moonshot", "Moonshot (Kimi)", {
    supports_protocol_selection: true,
    default_base_url: "https://api.moonshot.cn/v1",
    anthropic_base_url: "https://api.moonshot.cn/anthropic",
    default_model: "kimi-k2-0905-preview",
    docs_url: "https://platform.moonshot.cn/docs/api/chat",
  }),
  descriptor("moonshot-kimi-coding", "Moonshot (Kimi Coding)", {
    default_base_url: "https://api.kimi.com/coding/v1",
    default_model: "kimi-for-coding",
    docs_url: "https://api.kimi.com/coding/",
  }),
  descriptor("minimax", "MiniMax", {
    supports_protocol_selection: true,
    default_base_url: "https://api.minimaxi.com/v1",
    anthropic_base_url: "https://api.minimaxi.com/anthropic",
    default_model: "MiniMax-M2",
    docs_url: "https://platform.minimaxi.com/document/Models",
  }),
  descriptor("compatible", "Custom (OpenAI-compatible)", { supports_custom_base_url: true }),
];

const BY_KIND = new Map(DESCRIPTORS.map((d) => [d.kind, d]));
export const descriptorOf = (kind: string): Descriptor | undefined => BY_KIND.get(kind);

const PROTOCOLS: readonly ApiProtocol[] = ["anthropic", "openai-completion", "openai-response", "gemini"];

/** A stored protocol in its current spelling; the bare legacy `openai` meant chat completions. */
export function pinnedProtocol(protocol: string | null | undefined): ApiProtocol | null {
  const raw = (protocol ?? "").trim().toLowerCase();
  if (raw === "openai") return "openai-completion";
  return (PROTOCOLS as readonly string[]).includes(raw) ? (raw as ApiProtocol) : null;
}

/** Every wire protocol the channel can drive. A protocol pinned on the channel wins. */
export function compatibleProtocols(kind: string, protocol: string | null | undefined): ApiProtocol[] {
  const pinned = pinnedProtocol(protocol);
  if (pinned) return [pinned];
  if (descriptorOf(kind)?.supports_protocol_selection) {
    // These upstreams expose both shapes; DeepSeek serves the Responses wire as well.
    return kind === "deepseek"
      ? ["anthropic", "openai-completion", "openai-response"]
      : ["anthropic", "openai-completion"];
  }
  if (kind === "anthropic") return ["anthropic"];
  if (kind === "openai") return ["openai-completion", "openai-response"];
  if (kind === "gemini") return ["gemini"];
  return ["openai-completion"];
}

/** Each runtime and the wire protocols it can send, in order of preference. */
export const RUNTIME_PROTOCOLS: readonly [RuntimeId, readonly ApiProtocol[]][] = [
  ["claude_agent", ["anthropic"]],
  ["codex", ["openai-response"]],
  // The native runtime speaks chat completions or Anthropic messages, whichever the channel does.
  ["deepagents", ["openai-completion", "anthropic"]],
];

/** The runtimes a model on these protocols can run on, in order of preference. */
export const runtimesFor = (protocols: readonly ApiProtocol[]): RuntimeId[] =>
  RUNTIME_PROTOCOLS.filter(([, accepted]) => protocols.some((p) => accepted.includes(p))).map(([runtime]) => runtime);

/** The two HTTP shapes that exist when listing or pinging models. */
export type WireShape = "anthropic" | "openai";
export const wireShape = (kind: string, protocol: string | null | undefined): WireShape =>
  (pinnedProtocol(protocol) ?? (kind === "anthropic" ? "anthropic" : "openai-completion")) === "anthropic"
    ? "anthropic"
    : "openai";

/** The endpoint to call: the channel's own, else the kind's default for the wire shape in use. */
export function endpointFor(kind: string, protocol: string | null | undefined, baseUrl: string | null): string {
  if (baseUrl) return baseUrl;
  const d = descriptorOf(kind);
  if (!d) return "";
  return (wireShape(kind, protocol) === "anthropic" && d.anthropic_base_url) || d.default_base_url;
}

/** The protocol `runtime` would speak to a channel offering `protocols`, or null when it cannot drive it. */
export function protocolFor(runtime: string, protocols: readonly ApiProtocol[]): ApiProtocol | null {
  const accepted = RUNTIME_PROTOCOLS.find(([id]) => id === runtime)?.[1] ?? [];
  return accepted.find((protocol) => protocols.includes(protocol)) ?? null;
}
