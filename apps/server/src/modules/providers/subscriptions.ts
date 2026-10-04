/**
 * Subscription channels: Claude Pro/Max and Codex · ChatGPT. They hold no key
 * and no endpoint. Agents run on a device, and a device that is signed in to
 * the Claude or Codex CLI can simply use that — so a session on one of these
 * carries no channel at all, and its runtime uses the device's own login.
 *
 * They are the same two for everyone, so they are not rows: fixed ids the app
 * already knows, and a per-member switch.
 */
import type { ApiProtocol, RuntimeId } from "./catalog.ts";
import catalog from "./subscription-models.json" with { type: "json" };

export interface Subscription {
  id: string;
  kind: "claude-subscription" | "codex-subscription";
  name: string;
  runtime: Exclude<RuntimeId, "deepagents">;
  protocol: ApiProtocol;
  /** How a device signs in, for the member to run there. */
  login: string;
  default_model: string;
  models: { id: string; label: string }[];
}

const modelsOf = (kind: Subscription["kind"]) => catalog.subscriptions[kind];

export const SUBSCRIPTIONS: readonly Subscription[] = [
  {
    id: "ch-claude-subscription",
    kind: "claude-subscription",
    name: "Claude 订阅 (Pro / Max)",
    runtime: "claude_agent",
    protocol: "anthropic",
    login: "claude /login",
    default_model: modelsOf("claude-subscription").default_model,
    models: modelsOf("claude-subscription").models,
  },
  {
    id: "ch-codex-subscription",
    kind: "codex-subscription",
    name: "Codex · ChatGPT",
    runtime: "codex",
    protocol: "openai-response",
    login: "codex login",
    default_model: modelsOf("codex-subscription").default_model,
    models: modelsOf("codex-subscription").models,
  },
];

export const subscriptionOf = (id: string | null | undefined): Subscription | null =>
  SUBSCRIPTIONS.find((subscription) => subscription.id === id) ?? null;

/** The subscription a runtime falls back on when a session has no channel. */
export const subscriptionFor = (runtime: string): Subscription | null =>
  SUBSCRIPTIONS.find((subscription) => subscription.runtime === runtime) ?? null;
