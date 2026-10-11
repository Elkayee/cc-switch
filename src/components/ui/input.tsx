import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared look for Input / Select trigger / Textarea (upstream exports this; the
 * fork renders it in the compact 12.35px / 4px-radius style).
 */
export const fieldClass =
  "w-full rounded-[4px] border border-border-default bg-transparent px-2 text-[12.35px] leading-[1.3] text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-blue-500 focus-visible:ring-1 focus-visible:ring-blue-500/40 aria-[invalid=true]:border-red-500 disabled:cursor-not-allowed disabled:opacity-50";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          fieldClass,
          "flex h-6 py-1 file:border-0 file:bg-transparent file:text-[12.35px] file:font-medium file:text-foreground",
          className,
        )}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
