const PINNED_SUFFIX: Record<string, string> = {
  claude: "",
  gemini: "",
  "claude-desktop": "/claude-desktop",
  codex: "/v1",
  grokbuild: "/grokbuild/v1",
};

export interface PinnedProxyUrlInput {
  appId: string;
  providerId: string;
  takeoverOn: boolean;
  proxyRunning: boolean;
  isTauri: boolean;
  pageHostname: string;
  listenAddress: string;
  port: number;
}

/** Base URL for a pinned provider, or null when the copy button must be absent. */
export function pinnedProxyUrl(input: PinnedProxyUrlInput): string | null {
  return proxyEndpoint(input, `/${encodeURIComponent(input.providerId)}`);
}

/** Routing endpoint (no provider id): what a client points at while the app is routed. */
export function routeProxyUrl(
  input: Omit<PinnedProxyUrlInput, "providerId">,
): string | null {
  return proxyEndpoint(input, "");
}

function proxyEndpoint(
  input: Omit<PinnedProxyUrlInput, "providerId">,
  idSegment: string,
): string | null {
  const suffix = PINNED_SUFFIX[input.appId];
  if (
    suffix === undefined ||
    !input.takeoverOn ||
    !input.proxyRunning ||
    !Number.isInteger(input.port) ||
    input.port <= 0
  ) {
    return null;
  }
  const raw = input.isTauri
    ? input.listenAddress === "0.0.0.0"
      ? "127.0.0.1"
      : input.listenAddress === "::"
        ? "[::1]"
        : input.listenAddress
    : input.pageHostname;
  const host = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  return `http://${host}:${input.port}${idSegment}${suffix}`;
}
