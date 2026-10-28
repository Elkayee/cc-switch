import type { PropsWithChildren } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillAutoUpdateStatus } from "@/lib/api/skills";

const getAutoUpdateStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/skills", () => ({
  skillsApi: {
    getAutoUpdateStatus: getAutoUpdateStatusMock,
  },
}));

import { useSkillAutoUpdateStatus } from "@/hooks/useSkills";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useSkillAutoUpdateStatus", () => {
  beforeEach(() => {
    getAutoUpdateStatusMock.mockReset();
  });

  it("loads persisted auto-update status", async () => {
    const status: SkillAutoUpdateStatus = {
      lastRunAt: 42,
      running: false,
      updatedCount: 3,
      failures: [],
    };
    getAutoUpdateStatusMock.mockResolvedValue(status);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useSkillAutoUpdateStatus(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(status);
  });
});
