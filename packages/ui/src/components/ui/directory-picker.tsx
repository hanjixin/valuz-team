import { FolderOpen } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/cn";
import { useI18n } from "../../hooks/use-i18n";

export interface DirectoryPickerProps {
  value: string;
  placeholder?: string;
  onBrowse: () => void;
  className?: string;
}

export const DirectoryPicker = ({
  value,
  placeholder,
  onBrowse,
  className,
}: DirectoryPickerProps) => {
  const { t } = useI18n();
  const ph = placeholder ?? t("directoryPicker.placeholder");

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <button
        type="button"
        className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-input bg-surface px-2.5 text-left text-sm text-foreground shadow-none outline-none transition-[border-color,box-shadow,color,background-color] hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
        onClick={onBrowse}
      >
        <span
          className={cn(
            "min-w-0 truncate",
            value ? "font-mono text-foreground" : "text-muted-foreground",
          )}
        >
          {value || ph}
        </span>
      </button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 rounded-lg border-input px-2.5 text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 focus-visible:ring-offset-0"
        onClick={onBrowse}
      >
        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
        {t("directoryPicker.select")}
      </Button>
    </div>
  );
};
