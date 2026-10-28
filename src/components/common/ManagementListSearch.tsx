import type { Ref } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ManagementListSearchProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearLabel: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Shared, presentation-only search field for local management lists. */
export function ManagementListSearch({
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  clearLabel,
  className,
  inputRef,
}: ManagementListSearchProps) {
  return (
    <div role="search" className={cn("relative flex-shrink-0 mb-2", className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onValueChange("");
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="pl-8 pr-8"
      />
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onValueChange("")}
          aria-label={clearLabel}
          title={clearLabel}
          className="absolute right-2 top-1/2 -translate-y-1/2"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
