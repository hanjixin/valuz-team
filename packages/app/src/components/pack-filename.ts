/**
 * Turn a user's name/filename input into a ``<stem>.valuzpack`` download name —
 * trims, drops a pack extension the user may have typed (so it isn't doubled),
 * and falls back to ``fallback`` (then ``"pack"``) when empty. Shared by the
 * agent and project export dialogs so both name the download the same way.
 */
export function toValuzpackFilename(input: string, fallback: string): string {
  let stem = input.trim() || fallback.trim() || "pack";
  stem = stem.replace(/\.(valuzpack|valuz-project|zip)$/i, "").trim();
  return `${stem || "pack"}.valuzpack`;
}

/**
 * Download a Blob under an exact filename via an anchor click.
 *
 * The anchor MUST be attached to the document before clicking: a detached
 * anchor often has its ``download`` attribute ignored (Electron/Chromium then
 * fall back to a generated name), which is why the chosen file name didn't
 * stick. We attach, click, then revoke the object URL.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
