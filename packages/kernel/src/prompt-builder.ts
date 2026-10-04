/**
 * User prompt assembly. The kernel does not assemble the agent system prompt —
 * each runtime owns its own base prompt and accepts an append. The kernel only
 * wraps the per-turn user message:
 *
 *     <system-reminder>...</system-reminder>
 *     <additional-context>...</additional-context>   # only if non-empty
 *     The user uploaded ...                          # only if attachments
 *     <user text>
 *
 * A slash-command turn (text begins with `/`) is sent verbatim, unwrapped.
 */
import type { ModelSettings, RuntimeProvider, SessionMode, UserMessage } from "@agent-base/protocol";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Suffixes whose content reaches the model as a non-text block.
export const IMAGE_READ_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"];

export const UNREADABLE_ATTACHMENT_NOTE = "this model cannot read it — parse it to text with a document tool";

/** True when the session's model explicitly declares no image input. */
export const modelRejectsImages = (settings: ModelSettings | null | undefined): boolean => {
  const modalities = settings?.input_modalities;
  return modalities != null && !modalities.includes("image");
};

const pad = (n: number): string => String(n).padStart(2, "0");

const tzLabel = (d: Date): string => {
  const name = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return name ?? "UTC";
};

export function buildUserPrompt(
  message: UserMessage,
  cwd: string,
  now: Date,
  options: { modelRejectsImages?: boolean } = {},
): string {
  // Slash-command turns must reach the SDK verbatim: a prepended reminder
  // demotes the command to plain text.
  if (message.text.startsWith("/")) return message.text;

  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const parts: string[] = [
    "<system-reminder>\n" +
      `current_datetime: ${WEEKDAY_NAMES[now.getDay()]} ${stamp} ${tzLabel(now)}\n` +
      `workspace_cwd: ${cwd}\n` +
      "</system-reminder>",
  ];
  if (message.additional_context) {
    parts.push(`<additional-context>\n${message.additional_context}\n</additional-context>`);
  }
  if (message.attachments.length > 0) {
    const lines = ["The user uploaded the following attachments (read them as needed):"];
    for (const a of message.attachments) {
      const lower = a.source_path.toLowerCase();
      if (a.parsed_path) {
        lines.push(`- ${a.source_path}  (extracted text: ${a.parsed_path})`);
      } else if (options.modelRejectsImages && IMAGE_READ_SUFFIXES.some((s) => lower.endsWith(s))) {
        lines.push(`- ${a.source_path}  [${UNREADABLE_ATTACHMENT_NOTE}]`);
      } else {
        lines.push(`- ${a.source_path}`);
      }
    }
    parts.push(lines.join("\n"));
  }
  parts.push(message.text);
  return parts.join("\n\n");
}

/**
 * Only the GOAL cells enter their native mode through the message channel
 * (Claude `/goal`, codex `/goal`). Plan is lowered at protocol level by each
 * runtime; the native Valuz runtime has no plan/goal primitive.
 */
export function wrapForMode(text: string, mode: SessionMode, runtime: RuntimeProvider): string {
  if (mode === "default" || text.startsWith("/")) return text;
  if (runtime === "valuz_agent" || runtime === "deepagents") return text;
  if (mode === "plan") return text;
  return `/${mode} ${text}`;
}
