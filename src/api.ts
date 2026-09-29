// Tiny client over mcp-discovery — single source of truth for install snippets.

export interface DiscoveryResponse {
  endpoint?: string;
  transport?: string;
  endpoints?: {
    remote?: {
      url?: string;
      transport?: string;
    };
  };
  installSnippets: {
    claudeCode?: string;
    cursorDeeplink?: string;
    codex?: string;
    [key: string]: string | undefined;
  };
  [key: string]: unknown;
}

const DEFAULT_DISCOVERY = "https://api.problee.com/api/agent/v1/mcp-discovery";
const DEFAULT_ENDPOINT = "https://mcp.problee.com";

export async function fetchDiscovery(
  url = process.env.PROBLEE_MCP_DISCOVERY_URL ?? DEFAULT_DISCOVERY,
): Promise<DiscoveryResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as DiscoveryResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isReviewedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "problee.com" || url.hostname.endsWith(".problee.com"))
    );
  } catch {
    return false;
  }
}

export function endpointFromDiscovery(d: DiscoveryResponse | null): string {
  // An explicit operator override is useful for local/staging verification.
  // Discovery itself is not allowed to redirect a bearer credential to an
  // unrelated origin.
  const override = process.env.PROBLEE_MCP_ENDPOINT;
  if (override) return override;
  const discovered = d?.endpoints?.remote?.url ?? d?.endpoint;
  return discovered && isReviewedEndpoint(discovered)
    ? discovered
    : DEFAULT_ENDPOINT;
}
