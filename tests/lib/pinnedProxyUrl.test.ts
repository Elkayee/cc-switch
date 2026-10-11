import { describe, expect, it } from "vitest";
import { pinnedProxyUrl, routeProxyUrl } from "@/lib/pinnedProxyUrl";

const base = {
  providerId: "prov 1",
  takeoverOn: true,
  proxyRunning: true,
  isTauri: false,
  pageHostname: "localhost",
  listenAddress: "0.0.0.0",
  port: 18000,
};

describe("pinnedProxyUrl", () => {
  it("uses the page hostname and the proxy port in the browser", () => {
    expect(pinnedProxyUrl({ ...base, appId: "claude" })).toBe(
      "http://localhost:18000/prov%201",
    );
  });

  it("rewrites an all-interfaces Tauri listen address to loopback", () => {
    expect(
      pinnedProxyUrl({
        ...base,
        appId: "claude",
        isTauri: true,
        pageHostname: "tauri.localhost",
        listenAddress: "0.0.0.0",
        port: 15721,
      }),
    ).toBe("http://127.0.0.1:15721/prov%201");
  });

  it("adds the app path suffix", () => {
    expect(pinnedProxyUrl({ ...base, appId: "codex" })).toBe(
      "http://localhost:18000/prov%201/v1",
    );
    expect(pinnedProxyUrl({ ...base, appId: "grokbuild" })).toBe(
      "http://localhost:18000/prov%201/grokbuild/v1",
    );
    expect(pinnedProxyUrl({ ...base, appId: "claude-desktop" })).toBe(
      "http://localhost:18000/prov%201/claude-desktop",
    );
  });

  it("is absent unless takeover is on, the proxy is running, and the app is on the listener", () => {
    expect(
      pinnedProxyUrl({ ...base, appId: "claude", takeoverOn: false }),
    ).toBe(null);
    expect(
      pinnedProxyUrl({ ...base, appId: "claude", proxyRunning: false }),
    ).toBe(null);
    expect(pinnedProxyUrl({ ...base, appId: "opencode" })).toBe(null);
    expect(pinnedProxyUrl({ ...base, appId: "openclaw" })).toBe(null);
    expect(pinnedProxyUrl({ ...base, appId: "hermes" })).toBe(null);
  });
});

describe("routeProxyUrl", () => {
  const { providerId: _id, ...route } = base;

  it("is the proxy origin plus the app suffix, with no provider id", () => {
    expect(routeProxyUrl({ ...route, appId: "claude" })).toBe(
      "http://localhost:18000",
    );
    expect(routeProxyUrl({ ...route, appId: "codex" })).toBe(
      "http://localhost:18000/v1",
    );
    expect(routeProxyUrl({ ...route, appId: "grokbuild" })).toBe(
      "http://localhost:18000/grokbuild/v1",
    );
  });

  it("is absent when the proxy is down or the app is not on the listener", () => {
    expect(routeProxyUrl({ ...route, appId: "claude", proxyRunning: false })).toBe(
      null,
    );
    expect(routeProxyUrl({ ...route, appId: "opencode" })).toBe(null);
  });
});
