import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppToggleGroup } from "@/components/common/AppToggleGroup";

describe("AppToggleGroup", () => {
  it("exposes each app state and respects the shared disabled state", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <AppToggleGroup
        apps={{ claude: true }}
        appIds={["claude"]}
        onToggle={onToggle}
      />,
    );

    const enabledButton = screen.getByRole("button", { name: "Claude" });
    expect(enabledButton).toHaveAttribute("aria-pressed", "true");
    expect(enabledButton).toHaveAttribute("title", "Claude ✓");
    fireEvent.click(enabledButton);
    expect(onToggle).toHaveBeenCalledWith("claude", false);

    rerender(
      <AppToggleGroup
        apps={{ claude: false }}
        appIds={["claude"]}
        onToggle={onToggle}
        disabled
      />,
    );

    const disabledButton = screen.getByRole("button", { name: "Claude" });
    expect(disabledButton).toHaveAttribute("aria-pressed", "false");
    expect(disabledButton).toHaveAttribute("title", "Claude");
    expect(disabledButton).toBeDisabled();
  });
});
