import { Switch } from "@/components/ui/switch";

export interface ToggleRowProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
}

export function ToggleRow({
  icon,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
}: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-2 transition-colors hover:bg-muted/50">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <div className="min-w-0 space-y-1">
          <p className="text-ui font-semibold">{title}</p>
          {description ? (
            <p className="text-ui text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={title}
      />
    </div>
  );
}
