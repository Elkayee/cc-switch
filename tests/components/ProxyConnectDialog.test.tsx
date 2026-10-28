import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ProxyConnectDialog } from "@/components/providers/ProxyConnectDialog";
import { authApi } from "@/lib/api/auth";
import type { UpstreamInfo } from "@/lib/upstreamInfo";

const renderDialog = (credential: UpstreamInfo["credential"]) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProxyConnectDialog
        open
        onOpenChange={vi.fn()}
        providerName="xAI"
        appId="claude"
        providerId="p 1"
        proxyUrl="http://127.0.0.1:15721/p%201"
        upstream={{
          baseUrl: "https://api.x.ai/v1",
          endpoint: "https://api.x.ai/v1/responses",
          isFullUrl: false,
          credential,
          model: "grok-4",
        }}
      />
    </QueryClientProvider>,
  );

describe("ProxyConnectDialog", () => {
  it("shows the OAuth token and the token URL for xAI accounts", async () => {
    const spy = vi.spyOn(authApi, "getProviderDirectToken").mockResolvedValue({
      access_token: "tok-123",
      token_type: "Bearer",
      auth_provider: "xai_oauth",
      endpoint: "https://api.x.ai/v1/responses",
      headers: [],
      expires_at: null,
      expires_in: null,
      refreshed: false,
      retry_after: null,
      account_id: "acc",
    });
    renderDialog({
      kind: "managed",
      authProvider: "xai_oauth",
      accountId: "acc",
    });

    await waitFor(() =>
      expect(
        screen.getByDisplayValue(
          "http://127.0.0.1:15721/auth/token/claude/p%201",
        ),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue("tok-123")).toBeTruthy(),
    );
    expect(spy).toHaveBeenCalledWith("claude", "p 1");
    // masked until revealed
    expect((screen.getByDisplayValue("tok-123") as HTMLInputElement).type).toBe(
      "password",
    );
  });

  it("does not fetch a token for a static key", () => {
    const spy = vi.spyOn(authApi, "getProviderDirectToken");
    spy.mockClear();
    renderDialog({ kind: "key", value: "sk-static" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the Codex workspace header and the endpoint the backend returned", async () => {
    vi.spyOn(authApi, "getProviderDirectToken").mockResolvedValue({
      access_token: "tok-codex",
      token_type: "Bearer",
      auth_provider: "codex_oauth",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      headers: [{ name: "ChatGPT-Account-Id", value: "ws-1" }],
      expires_at: null,
      expires_in: null,
      refreshed: false,
      retry_after: null,
      account_id: "acc",
    });
    renderDialog({
      kind: "managed",
      authProvider: "codex_oauth",
      accountId: "acc",
    });

    await waitFor(() =>
      expect(screen.getByDisplayValue("tok-codex")).toBeTruthy(),
    );
    expect(
      screen.getByDisplayValue(
        "https://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("ChatGPT-Account-Id: ws-1")).toBeTruthy();
  });

  it("shows the refusal for an account that cannot be served", async () => {
    vi.spyOn(authApi, "getProviderDirectToken").mockRejectedValue(
      new Error("GitHub Enterprise Server accounts are not served"),
    );
    renderDialog({
      kind: "managed",
      authProvider: "github_copilot",
      accountId: "acc",
    });
    await waitFor(() =>
      expect(
        screen.getByText("GitHub Enterprise Server accounts are not served"),
      ).toBeTruthy(),
    );
  });
});
