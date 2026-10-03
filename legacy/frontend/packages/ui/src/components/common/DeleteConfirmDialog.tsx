import type { FC } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { useI18n } from "../../hooks/use-i18n";

export interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title?: string;
  description?: string;
  itemName?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
}

export const DeleteConfirmDialog: FC<DeleteConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  itemName,
  confirmLabel,
  cancelLabel,
  loading = false,
  onConfirm,
}) => {
  const { t } = useI18n();
  const _confirmLabel = confirmLabel ?? t("common.delete");
  const _cancelLabel = cancelLabel ?? t("common.cancel");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Don't pull focus onto Cancel/Confirm when the dialog opens — leaving
          focus off the buttons avoids an accidental Enter/Space confirming or
          dismissing a destructive action. */}
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-error-text" />
            {title ??
              (itemName
                ? t("ui.deleteConfirm.titleWithName", { name: itemName })
                : t("ui.deleteConfirm.title"))}
          </DialogTitle>
          <DialogDescription className="ml-7 text-left">
            {description ?? t("ui.deleteConfirm.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {_cancelLabel}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? t("ui.deleteConfirm.loading") : _confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
