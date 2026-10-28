import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webshim replaces `@tauri-apps/api/core` and `/event` when building for
 * browser mode. These tests pin the contract the ~36 existing call sites rely
 * on: `invoke()` resolving/rejecting like Tauri's, and `listen()` returning a
 * promise of an unlisten function that actually stops delivery.
 */

const TOKEN = "a".repeat(64);

function setLocation(search: string): void {
  window.history.replaceState({}, "", `/${search}`);
}

async function importCore() {
  return import("@/lib/webshim/core");
}

async function importEvent() {
  return import("@/lib/webshim/event");
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
  setLocation("");
});

describe("webshim core", () => {
  it("reports it is not running under Tauri", async () => {
    const { isTauri } = await importCore();
    expect(isTauri()).toBe(false);
  });

  it("takes the token from the URL, persists it, and strips it from the address bar", async () => {
    setLocation(`?token=${TOKEN}`);
    const { getServerToken } = await importCore();

    expect(getServerToken()).toBe(TOKEN);
    expect(localStorage.getItem("cc-switch:server-token")).toBe(TOKEN);
    expect(window.location.search).not.toContain("token");
  });

  // localStorage (not sessionStorage): a bookmarked or reopened tab has no
  // sessionStorage of its own, and the server keeps the same --token value
  // across restarts, so there is no reason a saved token should only last
  // one tab's lifetime.
  it("reuses a token from localStorage when the URL has none", async () => {
    localStorage.setItem("cc-switch:server-token", TOKEN);
    const { getServerToken } = await importCore();
    expect(getServerToken()).toBe(TOKEN);
  });

  it("prefers a token freshly given in the URL over a stored one", async () => {
    localStorage.setItem("cc-switch:server-token", "stale-token");
    setLocation(`?token=${TOKEN}`);
    const { getServerToken } = await importCore();
    expect(getServerToken()).toBe(TOKEN);
    expect(localStorage.getItem("cc-switch:server-token")).toBe(TOKEN);
  });

  it("posts cmd/args to /api/invoke with the bearer token and returns parsed JSON", async () => {
    setLocation(`?token=${TOKEN}`);
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { invoke } = await importCore();
    const result = await invoke<{ ok: boolean }>("get_providers", {
      app: "claude",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/invoke");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      cmd: "get_providers",
      args: { app: "claude" },
    });
  });

  it("sends an empty args object when none is given", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("null", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { invoke } = await importCore();
    await invoke("get_settings");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      cmd: "get_settings",
      args: {},
    });
  });

  it("resolves undefined for an empty body, matching a unit-return command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    const { invoke } = await importCore();
    await expect(invoke("save_settings")).resolves.toBeUndefined();
  });

  /**
   * Tauri's `invoke()` rejects with the command's own error value, not an
   * envelope. Existing `catch` blocks read it directly, so unwrapping is what
   * keeps them working unchanged.
   */
  it("rejects with the inner error value, unwrapped from the envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "provider not found" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const { invoke } = await importCore();
    await expect(invoke("switch_provider")).rejects.toBe("provider not found");
  });

  it("rejects with a transport error when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      ),
    );

    const { invoke, InvokeTransportError } = await importCore();
    await expect(invoke("get_settings")).rejects.toBeInstanceOf(
      InvokeTransportError,
    );
  });

  it("omits the Authorization header when no token is available", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("null", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { invoke } = await importCore();
    await invoke("get_settings");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });
});

/**
 * A 401 used to surface as a blank page: the rejection propagated out of
 * bootstrap's first `invoke()` with nothing rendered yet, so the user saw only
 * `{"error":"missing or invalid token"}` in devtools. These pin the two things
 * that fixes it — drop the token that just failed, and say so on screen.
 */
describe("webshim core auth failure", () => {
  function unauthorized() {
    return new Response(JSON.stringify({ error: "missing or invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("clears the stored token so a stale one is not retried forever", async () => {
    localStorage.setItem("cc-switch:server-token", TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    const { invoke } = await importCore();
    await expect(invoke("get_settings")).rejects.toBeDefined();

    expect(localStorage.getItem("cc-switch:server-token")).toBeNull();
  });

  it("shows a readable message instead of leaving a blank page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    const { invoke } = await importCore();
    await expect(invoke("get_settings")).rejects.toBeDefined();

    const overlay = document.querySelector("[data-cc-switch-auth-error]");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toMatch(/token/i);
  });

  it("still rejects with the server's error value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    const { invoke } = await importCore();
    await expect(invoke("get_settings")).rejects.toBe(
      "missing or invalid token",
    );
  });

  it("shows the message only once across repeated failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    const { invoke } = await importCore();
    await expect(invoke("get_settings")).rejects.toBeDefined();
    await expect(invoke("get_providers")).rejects.toBeDefined();

    expect(
      document.querySelectorAll("[data-cc-switch-auth-error]"),
    ).toHaveLength(1);
  });

  it("leaves the page alone for a non-auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "provider not found" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const { invoke } = await importCore();
    await expect(invoke("switch_provider")).rejects.toBe("provider not found");

    expect(document.querySelector("[data-cc-switch-auth-error]")).toBeNull();
  });
});

/** Minimal EventSource stand-in; jsdom has none. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CLOSED = 2;

  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (event: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  /** Simulates a frame arriving from the server. */
  dispatch(name: string, data: string): void {
    for (const fn of this.listeners.get(name) ?? []) {
      fn(new MessageEvent(name, { data }));
    }
  }
}

describe("webshim event", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("opens one EventSource carrying the token in the query string", async () => {
    setLocation(`?token=${TOKEN}`);
    const { listen } = await importEvent();

    await listen("provider-switched", () => {});

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe(`/api/events?token=${TOKEN}`);
  });

  it("shares a single connection across multiple subscriptions", async () => {
    const { listen } = await importEvent();

    await listen("provider-switched", () => {});
    await listen("usage-log-recorded", () => {});
    await listen("provider-switched", () => {});

    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("delivers a parsed payload in Tauri's event shape", async () => {
    const { listen } = await importEvent();
    const handler = vi.fn();

    await listen("provider-switched", handler);
    MockEventSource.instances[0].dispatch(
      "provider-switched",
      JSON.stringify({ providerId: "p1" }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      event: "provider-switched",
      payload: { providerId: "p1" },
    });
    expect(typeof handler.mock.calls[0][0].id).toBe("number");
  });

  it("stops delivering after unlisten", async () => {
    const { listen } = await importEvent();
    const handler = vi.fn();

    const unlisten = await listen("provider-switched", handler);
    MockEventSource.instances[0].dispatch("provider-switched", "null");
    expect(handler).toHaveBeenCalledTimes(1);

    unlisten();
    MockEventSource.instances[0].dispatch("provider-switched", "null");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps other subscribers alive when one unlistens", async () => {
    const { listen } = await importEvent();
    const first = vi.fn();
    const second = vi.fn();

    const off = await listen("provider-switched", first);
    await listen("provider-switched", second);

    off();
    MockEventSource.instances[0].dispatch("provider-switched", "null");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing handler from the others", async () => {
    const { listen } = await importEvent();
    const healthy = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await listen("provider-switched", () => {
      throw new Error("boom");
    });
    await listen("provider-switched", healthy);

    expect(() =>
      MockEventSource.instances[0].dispatch("provider-switched", "null"),
    ).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("passes through a payload that is not JSON instead of dropping the event", async () => {
    const { listen } = await importEvent();
    const handler = vi.fn();

    await listen("provider-switched", handler);
    MockEventSource.instances[0].dispatch("provider-switched", "not json");

    expect(handler.mock.calls[0][0].payload).toBe("not json");
  });

  it("once() fires a single time", async () => {
    const { once } = await importEvent();
    const handler = vi.fn();

    await once("provider-switched", handler);
    MockEventSource.instances[0].dispatch("provider-switched", "null");
    MockEventSource.instances[0].dispatch("provider-switched", "null");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects emit(), which has no browser-mode equivalent", async () => {
    const { emit } = await importEvent();
    await expect(emit("provider-switched")).rejects.toThrow(
      /not available in browser mode/,
    );
  });
});
