/** When an automation runs: checking a trigger, saying it in words, and turning it into a repeating job. */
import type { AutomationTrigger } from "@agent-base/db";
import { CronExpressionParser } from "cron-parser";
import cronstrueModule from "cronstrue/i18n.js";
import { badRequest } from "../../infra/errors.ts";
import type { Repeat } from "../../infra/jobs.ts";

// A CommonJS package: at run time the default import is the describer itself, whatever its typings say.
const cronstrue = cronstrueModule as unknown as {
  toString(expression: string, options: { locale: string; use24HourTimeFormat: boolean }): string;
};

const validTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export interface CronCheck {
  valid: boolean;
  human_readable: string | null;
  next_runs: string[];
  error_message: string | null;
}

/** Whether a cron expression can be scheduled in `tz`, how it reads, and when it fires next. */
export function checkCron(expr: string, tz: string): CronCheck {
  const invalid = (error_message: string): CronCheck => ({
    valid: false,
    human_readable: null,
    next_runs: [],
    error_message,
  });
  if (!validTimezone(tz)) return invalid(`unknown timezone "${tz}"`);
  // Minute resolution: the five classic fields. A sixth would schedule by the second.
  if (expr.trim().split(/\s+/).length !== 5)
    return invalid("a cron expression has five fields: minute hour day month weekday");
  try {
    const next = CronExpressionParser.parse(expr, { tz }).take(5);
    return {
      valid: true,
      human_readable: cronstrue.toString(expr, { locale: "zh_CN", use24HourTimeFormat: true }),
      next_runs: next.map((at) => at.toDate().toISOString()),
      error_message: null,
    };
  } catch (err) {
    return invalid((err as Error).message);
  }
}

export function checkInterval(
  seconds: number,
  minimum: number,
): { valid: boolean; human_readable: string | null; error_message: string | null } {
  if (!Number.isInteger(seconds) || seconds < minimum)
    return { valid: false, human_readable: null, error_message: `an interval is at least ${minimum} seconds` };
  return { valid: true, human_readable: describeInterval(seconds), error_message: null };
}

function describeInterval(seconds: number): string {
  for (const [size, unit] of [
    [86_400, "天"],
    [3600, "小时"],
    [60, "分钟"],
  ] as const)
    if (seconds % size === 0) return `每 ${seconds / size} ${unit}`;
  return `每 ${seconds} 秒`;
}

export function describe(trigger: AutomationTrigger): string {
  if (trigger.kind === "cron") {
    try {
      return cronstrue.toString(trigger.cron_expr ?? "", { locale: "zh_CN", use24HourTimeFormat: true });
    } catch {
      return trigger.cron_expr ?? "";
    }
  }
  return trigger.kind === "interval" ? describeInterval(trigger.seconds ?? 0) : "手动触发";
}

/** A trigger as it is stored: checked, and with its timezone settled. */
export function normalize(
  input: { kind: string; cron_expr?: string; timezone?: string | null; seconds?: number },
  limits: { defaultTimezone: string; minIntervalSeconds: number },
): AutomationTrigger {
  if (input.kind === "manual") return { kind: "manual" };
  if (input.kind === "interval") {
    const check = checkInterval(input.seconds ?? 0, limits.minIntervalSeconds);
    if (!check.valid) throw badRequest(check.error_message ?? "invalid interval", "invalid_interval");
    return { kind: "interval", seconds: input.seconds as number };
  }
  if (input.kind === "cron") {
    const timezone = input.timezone || limits.defaultTimezone;
    const check = checkCron(input.cron_expr ?? "", timezone);
    if (!check.valid) throw badRequest(`invalid schedule: ${check.error_message}`, "invalid_cron");
    return { kind: "cron", cron_expr: (input.cron_expr as string).trim(), timezone };
  }
  throw badRequest(
    "no event sources are available on this server; use a schedule or run by hand",
    "unsupported_trigger",
  );
}

/** How the trigger repeats, or null when it only runs by hand. */
export const repeatOf = (trigger: AutomationTrigger): Repeat | null =>
  trigger.kind === "cron"
    ? { pattern: trigger.cron_expr ?? "", tz: trigger.timezone ?? "UTC" }
    : trigger.kind === "interval"
      ? { everyMs: (trigger.seconds ?? 60) * 1000 }
      : null;
