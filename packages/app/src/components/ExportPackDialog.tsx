import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from "@valuz/ui";
import { agentTemplatesApi, useTranslation } from "@valuz/core";

import { downloadBlob, toValuzpackFilename } from "./pack-filename";

type Tx = ReturnType<typeof useTranslation>["t"];
const k = (key: string) => key as Parameters<Tx>[0];

/**
 * Name + confirm a multi-agent export into a single ``.valuzpack``. The parent
 * passes the selected ``agentSlugs``; the user names the group, and we download
 * the bundled file. Connectors carry config only — never any keys (the backend
 * strips them).
 */
export function ExportPackDialog({
  open,
  onOpenChange,
  agentSlugs,
  defaultName,
  onExported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentSlugs: string[];
  /** Pre-fill the group name — e.g. the agent's own name for a single export.
   *  Falls back to a generic "my agent group". */
  defaultName?: string;
  /** Called after a successful export (e.g. to exit selection mode). */
  onExported?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset to defaults each time the dialog opens (deferred off the synchronous
  // effect body to satisfy the cascading-render lint).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setName(defaultName ?? t(k("agent.pack.defaultGroupName")));
      setDesc("");
    });
    return () => {
      cancelled = true;
    };
  }, [open, t, defaultName]);

  const handleExport = async () => {
    setBusy(true);
    try {
      const trimmed = name.trim();
      const trimmedDesc = desc.trim();
      const { blob } = await agentTemplatesApi.exportPack(agentSlugs, {
        name: trimmed || undefined,
        description: trimmedDesc || undefined,
      });
      downloadBlob(
        blob,
        toValuzpackFilename(name, defaultName ?? t(k("agent.pack.defaultGroupName"))),
      );
      toast.success(t(k("agent.pack.exportDone"), { count: agentSlugs.length }));
      onOpenChange(false);
      onExported?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(k("agent.pack.exportFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(k("agent.pack.exportMulti"))}</DialogTitle>
          <DialogDescription>{t(k("agent.pack.exportSub"))}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <label className="text-xs text-ink-meta">{t(k("agent.pack.groupName"))}</label>
            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <span className="shrink-0 text-xs text-ink-meta">.valuzpack</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-ink-meta">{t(k("agent.pack.groupDesc"))}</label>
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t(k("agent.pack.groupDescPlaceholder"))}
              rows={2}
            />
          </div>
          <div className="text-xs font-medium text-ink-body">
            {t(k("agent.pack.willPack"), { count: agentSlugs.length })}
          </div>
          <p className="text-xs leading-5 text-ink-meta">{t(k("agent.pack.exportNote"))}</p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t(k("agent.pack.cancelSelect"))}
          </Button>
          <Button onClick={() => void handleExport()} disabled={busy} loading={busy}>
            <Upload className="h-3.5 w-3.5" />
            {busy ? t(k("agent.pack.exporting")) : t(k("agent.pack.exportFile"))}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
