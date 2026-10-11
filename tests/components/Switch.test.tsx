import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("keeps the default 24x16 size and the fork accent color", () => {
    render(<Switch aria-label="default" defaultChecked />);
    const element = screen.getByRole("switch", { name: "default" });
    expect(element).toHaveAttribute("data-size", "default");
    expect(element.className).toContain("h-4");
    expect(element.className).toContain("w-6");
    expect(element.className).toContain("data-[state=checked]:bg-blue-500");
  });

  it("uses the same accent color for the small variant", () => {
    render(<Switch aria-label="small" size="sm" />);
    const element = screen.getByRole("switch", { name: "small" });
    expect(element).toHaveAttribute("data-size", "sm");
    expect(element.className).toContain("h-3.5");
    expect(element.className).toContain("w-5");
    expect(element.className).toContain("data-[state=checked]:bg-blue-500");
  });
});
