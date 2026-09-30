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

const DEFAULT_API = "https://api.problee.com";

/** The agent API origin: registration, nonces. The override is for local verification only. */
export function apiOrigin(): string {
  return process.env.PROBLEE_API_URL ?? DEFAULT_API;
}

/** A single-use server nonce, for a registration signature or a per-tool wallet proof. */
export async function fetchNonce(origin = apiOrigin()): Promise<string> {
  const res = await fetch(`${origin}/api/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  const body = (await res.json().catch(() => null)) as { nonce?: unknown } | null;
  if (!res.ok || typeof body?.nonce !== "string" || !/^[0-9a-f]{16,128}$/i.test(body.nonce)) {
    throw new Error(`Problee did not issue a nonce (${res.status})`);
  }
  return body.nonce;
}
