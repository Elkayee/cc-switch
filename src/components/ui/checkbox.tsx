import * as React from "react";

import { cn } from "@/lib/utils";

type CheckedState = boolean | "indeterminate";

interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "checked" | "type"
> {
  checked?: CheckedState;
  onCheckedChange?: (checked: boolean) => void;
}

const CHECK_MARK = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}")`;

const MINUS_MARK = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M4 8h8" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>',
)}")`;

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      className,
      checked,
      onChange,
      onCheckedChange,
      "aria-checked": ariaChecked,
      style,
      ...props
    },
    ref,
  ) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const isIndeterminate = checked === "indeterminate";
    const isOn = checked === true || isIndeterminate;

    React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    React.useLayoutEffect(() => {
      if (inputRef.current) {
        inputRef.current.indeterminate = isIndeterminate;
      }
    });

    return (
      <input
        {...props}
        ref={inputRef}
        type="checkbox"
        checked={isIndeterminate ? false : checked}
        aria-checked={isIndeterminate ? "mixed" : ariaChecked}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.target.checked);
        }}
        style={{
          ...style,
          backgroundImage: isOn
            ? isIndeterminate
              ? MINUS_MARK
              : CHECK_MARK
            : undefined,
          backgroundSize: "100% 100%",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
        }}
        className={cn(
          "h-4 w-4 shrink-0 appearance-none rounded-[2px] border border-border-default bg-transparent p-px",
          "checked:border-transparent checked:bg-blue-600 dark:checked:bg-blue-600",
          isOn && "border-transparent bg-blue-600",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      />
    );
  },
);

Checkbox.displayName = "Checkbox";

export { Checkbox };
export type { CheckboxProps, CheckedState };
