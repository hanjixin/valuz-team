import { createPatch, diffLines } from "diff";
import type { ConversationTurn } from "@valuz/shared";

export interface TurnDiffFileChange {
  /** Absolute path the agent passed in. */
  file_path: string;
  additions: number;
  deletions: number;
  /** Concatenation of unified-diff blocks for every contributing tool
   *  call against this file (in chronological order). */
  unified_diff: string;
  /** True when at least one of the contributing tool calls returned
   *  with status === "error". The card surfaces this so the user knows
   *  the intended change may not have landed on disk. */
  has_error: boolean;
}

export interface TurnDiffSummary {
  changes: TurnDiffFileChange[];
  total_additions: number;
  total_deletions: number;
}

interface EditEntry {
  old_string: string;
  new_string: string;
}

interface ToolInputEdit {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
}

interface ToolInputMultiEdit {
  file_path?: unknown;
  edits?: unknown;
}

interface ToolInputWrite {
  file_path?: unknown;
  content?: unknown;
}

const isString = (v: unknown): v is string => typeof v === "string";

const parseInput = (raw: string | undefined): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const countAddsAndDels = (
  oldStr: string,
  newStr: string,
): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(oldStr, newStr)) {
    if (part.added) additions += part.count ?? 0;
    else if (part.removed) deletions += part.count ?? 0;
  }
  return { additions, deletions };
};

const editEntriesFromTool = (
  toolTitle: string,
  input: unknown,
): { file_path: string; entries: EditEntry[] } | null => {
  if (input === null || typeof input !== "object") return null;

  if (toolTitle === "Edit") {
    const e = input as ToolInputEdit;
    if (
      !isString(e.file_path) ||
      !isString(e.old_string) ||
      !isString(e.new_string)
    ) {
      return null;
    }
    return {
      file_path: e.file_path,
      entries: [{ old_string: e.old_string, new_string: e.new_string }],
    };
  }

  if (toolTitle === "MultiEdit") {
    const e = input as ToolInputMultiEdit;
    if (!isString(e.file_path) || !Array.isArray(e.edits)) return null;
    const entries: EditEntry[] = [];
    for (const item of e.edits) {
      if (item === null || typeof item !== "object") continue;
      const sub = item as ToolInputEdit;
      if (!isString(sub.old_string) || !isString(sub.new_string)) continue;
      entries.push({ old_string: sub.old_string, new_string: sub.new_string });
    }
    if (entries.length === 0) return null;
    return { file_path: e.file_path, entries };
  }

  if (toolTitle === "Write") {
    const e = input as ToolInputWrite;
    if (!isString(e.file_path) || !isString(e.content)) return null;
    // Treat Write as a full-file replacement against an empty baseline.
    // The aggregator can't reach the disk to know whether the file
    // existed before; counting every line as added is consistent with
    // how Cursor / VS Code render a brand-new file.
    return {
      file_path: e.file_path,
      entries: [{ old_string: "", new_string: e.content }],
    };
  }

  return null;
};

interface ToolInputApplyPatchChange {
  diff?: unknown;
  path?: unknown;
  kind?: unknown;
}

interface ToolInputApplyPatch {
  changes?: unknown;
}

interface ApplyPatchFileChange {
  file_path: string;
  unified_diff: string;
  additions: number;
  deletions: number;
}

/** Count adds/dels by scanning an already-formed unified diff's line
 *  prefixes (``+``/``-``, excluding the ``+++``/``---`` file headers). */
const countUnifiedDiffLines = (
  diff: string,
): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
};

/**
 * Parse a Codex ``apply_patch`` tool input into per-file diff rows.
 *
 * Codex emits one ``apply_patch`` call that may touch several files
 * (``{ changes: [{ diff, path, kind: { type } }] }``). The ``diff`` field's
 * shape depends on ``kind.type``:
 *
 *   * ``add``    — full new file content (NOT a unified diff; it can even
 *     begin with ``---`` YAML frontmatter). Rendered as an all-additions
 *     patch against an empty baseline, mirroring ``Write``.
 *   * ``delete`` — full prior content being removed → all-deletions patch.
 *   * ``update`` — already a unified diff with ``@@`` hunks and ``+``/``-``
 *     lines → used verbatim, counted from the prefixes.
 *
 * Returns ``null`` when nothing parseable is present.
 */
const applyPatchChangesFromInput = (
  input: unknown,
): ApplyPatchFileChange[] | null => {
  if (input === null || typeof input !== "object") return null;
  const e = input as ToolInputApplyPatch;
  if (!Array.isArray(e.changes)) return null;

  const out: ApplyPatchFileChange[] = [];
  for (const raw of e.changes) {
    if (raw === null || typeof raw !== "object") continue;
    const ch = raw as ToolInputApplyPatchChange;
    if (!isString(ch.path) || !isString(ch.diff)) continue;
    const kindType =
      ch.kind !== null && typeof ch.kind === "object"
        ? (ch.kind as { type?: unknown }).type
        : undefined;

    if (kindType === "add") {
      const { additions, deletions } = countAddsAndDels("", ch.diff);
      out.push({
        file_path: ch.path,
        unified_diff: createPatch(ch.path, "", ch.diff, "", ""),
        additions,
        deletions,
      });
    } else if (kindType === "delete") {
      const { additions, deletions } = countAddsAndDels(ch.diff, "");
      out.push({
        file_path: ch.path,
        unified_diff: createPatch(ch.path, ch.diff, "", "", ""),
        additions,
        deletions,
      });
    } else {
      // ``update`` and any unknown kind: trust the supplied unified diff.
      out.push({
        file_path: ch.path,
        unified_diff: ch.diff,
        ...countUnifiedDiffLines(ch.diff),
      });
    }
  }
  return out.length > 0 ? out : null;
};

interface PerFileAccumulator {
  file_path: string;
  additions: number;
  deletions: number;
  patches: string[];
  has_error: boolean;
}

/**
 * Walk a turn's tool blocks and produce an aggregated file-change
 * summary. Only Edit / MultiEdit / Write tool calls participate; every
 * other tool name is ignored so the renderer still shows them through
 * the generic per-tool card. Returns ``null`` when the turn made no
 * file changes — callers can use that as the "render no card" signal.
 */
export const aggregateTurnFileChanges = (
  turn: ConversationTurn,
): TurnDiffSummary | null => {
  const byFile = new Map<string, PerFileAccumulator>();

  const getOrCreateAcc = (filePath: string): PerFileAccumulator => {
    let acc = byFile.get(filePath);
    if (!acc) {
      acc = {
        file_path: filePath,
        additions: 0,
        deletions: 0,
        patches: [],
        has_error: false,
      };
      byFile.set(filePath, acc);
    }
    return acc;
  };

  for (const block of turn.blocks) {
    if (block.kind !== "tool") continue;
    const tool = block.tool;
    const title = tool.title;
    if (
      title !== "Edit" &&
      title !== "MultiEdit" &&
      title !== "Write" &&
      title !== "apply_patch"
    ) {
      continue;
    }
    const parsed = parseInput(tool.input);
    const isError = tool.status === "error";

    // Codex's single ``apply_patch`` call can touch several files and its
    // per-change diff doesn't fit Claude's old/new-string model — handle it
    // on its own path (already-formed unified diffs / full content).
    if (title === "apply_patch") {
      const changes = applyPatchChangesFromInput(parsed);
      if (!changes) continue;
      for (const ch of changes) {
        const acc = getOrCreateAcc(ch.file_path);
        acc.additions += ch.additions;
        acc.deletions += ch.deletions;
        acc.patches.push(ch.unified_diff);
        if (isError) acc.has_error = true;
      }
      continue;
    }

    const extracted = editEntriesFromTool(title, parsed);
    if (!extracted) continue;

    const acc = getOrCreateAcc(extracted.file_path);

    for (const entry of extracted.entries) {
      const { additions, deletions } = countAddsAndDels(
        entry.old_string,
        entry.new_string,
      );
      acc.additions += additions;
      acc.deletions += deletions;
      // ``createPatch`` produces a standard unified diff with a header.
      // We strip the leading file header (``Index:`` + ``===``) and
      // keep only ``---``/``+++``/``@@`` lines so concatenating multiple
      // patches per file stays compact and human-readable.
      const patch = createPatch(
        extracted.file_path,
        entry.old_string,
        entry.new_string,
        "",
        "",
      );
      acc.patches.push(patch);
    }
    if (isError) acc.has_error = true;
  }

  if (byFile.size === 0) return null;

  let totalAdditions = 0;
  let totalDeletions = 0;
  const changes: TurnDiffFileChange[] = [];
  for (const acc of byFile.values()) {
    totalAdditions += acc.additions;
    totalDeletions += acc.deletions;
    changes.push({
      file_path: acc.file_path,
      additions: acc.additions,
      deletions: acc.deletions,
      unified_diff: acc.patches.join("\n"),
      has_error: acc.has_error,
    });
  }

  return {
    changes,
    total_additions: totalAdditions,
    total_deletions: totalDeletions,
  };
};
