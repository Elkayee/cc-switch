import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { LanguagePickerDialog } from "@/components/LanguagePickerDialog";

const useSettingsQueryMock = vi.fn();
const saveMock = vi.fn();

vi.mock("@/lib/query", () => ({
  useSettingsQuery: (...args: unknown[]) => useSettingsQueryMock(...args),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    save: (...args: unknown[]) => saveMock(...args),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean;
    children: React.ReactNode;
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("LanguagePickerDialog", () => {
  beforeEach(() => {
    useSettingsQueryMock.mockReset();
    saveMock.mockReset();
    saveMock.mockResolvedValue(true);
    window.localStorage.clear();
  });

  it("stays closed while settings have not loaded", () => {
    useSettingsQueryMock.mockReturnValue({ data: undefined });
    render(<LanguagePickerDialog />, { wrapper: Wrapper });
    expect(screen.queryByText("languagePicker.title")).not.toBeInTheDocument();
  });

  it("stays closed after the picker has been confirmed", () => {
    useSettingsQueryMock.mockReturnValue({
      data: {
        showInTray: true,
        language: "en",
        languagePickerConfirmed: true,
      },
    });
    render(<LanguagePickerDialog />, { wrapper: Wrapper });
    expect(screen.queryByText("languagePicker.title")).not.toBeInTheDocument();
  });

  it("shows for existing users who already have a language but have not confirmed the picker", () => {
    useSettingsQueryMock.mockReturnValue({
      data: { showInTray: true, language: "en" },
    });
    render(<LanguagePickerDialog />, { wrapper: Wrapper });
    expect(screen.getByText("languagePicker.title")).toBeInTheDocument();
  });

  it("shows the language list when language has never been chosen", () => {
    useSettingsQueryMock.mockReturnValue({
      data: { showInTray: true },
    });
    render(<LanguagePickerDialog />, { wrapper: Wrapper });
    expect(screen.getByText("languagePicker.title")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "settings.languageOptionEnglish" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "settings.languageOptionVietnamese",
      }),
    ).toBeInTheDocument();
  });

  it("saves the chosen language to settings and localStorage", async () => {
    const user = userEvent.setup();
    const changeLanguageSpy = vi
      .spyOn(i18n, "changeLanguage")
      .mockResolvedValue(i18n.t);
    useSettingsQueryMock.mockReturnValue({
      data: { showInTray: true, firstRunNoticeConfirmed: true },
    });

    render(<LanguagePickerDialog />, { wrapper: Wrapper });
    await user.click(
      screen.getByRole("button", { name: "settings.languageOptionEnglish" }),
    );

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          language: "en",
          languagePickerConfirmed: true,
        }),
      );
    });
    expect(window.localStorage.getItem("language")).toBe("en");
    expect(changeLanguageSpy).toHaveBeenCalledWith("en");
    changeLanguageSpy.mockRestore();
  });
});
