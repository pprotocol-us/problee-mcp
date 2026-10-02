import { randomUUID } from 'node:crypto';

import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { sha256, stringToBytes } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { apiOrigin, fetchNonce } from './api.js';
import type { StoredCredential } from './credentials.js';

/**
 * The wallet of an agent registered with `register --owner`, held by the local
 * bridge. An AI app cannot sign, so without this an agent could read and quote
 * over MCP but never place an order. The bridge signs two things for it, and
 * only for the exact call the app made:
 *   - the per-tool wallet proof (`problee-mcp-auth:…`, EIP-191), bound by the
 *     server to the tool, the market or order, and the order terms;
 *   - the EIP-712 order the server returns, after checking that the order is
 *     the one the app asked for, field by field.
 * A call that brings its own proof or signature, or names another wallet, is
 * forwarded untouched.
 */
export interface BridgeWallet {
  agentId: string;
  apiKeyId: string;
  account: PrivateKeyAccount;
  apiOrigin: string;
}

export function bridgeWalletFrom(
  stored: StoredCredential | null,
  apiKey: string | undefined
): BridgeWallet | null {
  if (!stored?.wallet || !stored.agentId || !stored.apiKeyId || apiKey !== stored.apiKey) {
    return null;
  }
  return {
    agentId: stored.agentId,
    apiKeyId: stored.apiKeyId,
    account: privateKeyToAccount(stored.wallet.privateKey as `0x${string}`),
    apiOrigin: apiOrigin(),
  };
}

// ─── The canonical proof bytes ────────────────────────────────────────────
// A copy of packages/shared/src/mcpWalletProof.ts: this package is published on
// its own and cannot import the private workspace package.
// tests/walletSigner.test.mjs pins every byte to the original.

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function hashToolIntent(payload: unknown): string {
  const json = payload === undefined || payload === null ? '{}' : JSON.stringify(canonicalize(payload));
  return sha256(stringToBytes(json));
}

function encodeResourceSegment(value: string): string {
  return value.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\//g, '%2F');
}

export function buildResourceId(parts: { market?: string; order?: string; kind?: string }): string | null {
  const segments: string[] = [];
  if (parts.market) segments.push(`market:${parts.market.toLowerCase()}`);
  if (parts.order) segments.push(`order:${parts.order.toLowerCase()}`);
  if (parts.kind) segments.push(`kind:${encodeResourceSegment(parts.kind)}`);
  return segments.length > 0 ? segments.join('/') : null;
}

export interface WalletProofFields {
  agentId: string;
  apiKeyId: string;
  tool: string;
  scope: string | null;
  chainId: number | null;
  walletAddress: string;
  resourceId: string | null;
  payloadHash: string;
  nonce: string;
  timestamp: number;
}

export function buildWalletProofMessage(fields: WalletProofFields): string {
  for (const value of [fields.agentId, fields.apiKeyId, fields.walletAddress, fields.payloadHash, fields.nonce]) {
    if (value.includes(':')) throw new Error('MCP wallet-proof fields must not contain ":"');
  }
  return [
    'problee-mcp-auth',
    fields.agentId,
    fields.apiKeyId,
    fields.tool,
    fields.scope ?? '-',
    fields.chainId != null ? String(fields.chainId) : '-',
    fields.walletAddress.toLowerCase(),
    fields.resourceId ?? '-',
    fields.payloadHash,
    fields.nonce.toLowerCase(),
    String(fields.timestamp),
  ].join(':');
}

// ─── What each signed tool binds ──────────────────────────────────────────
// Mirrors the `requireMcpAuth(…, { binding })` calls in
// backend/src/adapters/protocol/mcp/mcpToolHandlers/orderbookTools.ts.

type Args = Record<string, unknown>;

interface Binding {
  scope: string;
  chainId: number | null;
  resourceId: string | null;
  payload: unknown;
}

function orderKind(args: Args): number {
  return typeof args.kind === 'number' ? args.kind : 0;
}

function priceBps(args: Args): number | undefined {
  if (typeof args.price === 'number') return args.price;
  if (typeof args.priceDecimal === 'number') return Math.round(args.priceDecimal * 10_000);
  return undefined;
}

const PLACE_ORDER = 'problee_place_limit_order';

const BINDINGS: Record<string, (args: Args) => Binding> = {
  [PLACE_ORDER]: (args) => ({
    scope: 'trade:execute',
    chainId: typeof args.chainId === 'number' ? args.chainId : null,
    resourceId: buildResourceId({ market: String(args.marketAddress ?? '') }),
    payload: { kind: orderKind(args), side: args.side, price: priceBps(args), amount: args.amount },
  }),
  problee_cancel_order: (args) => ({
    scope: 'trade:execute',
    chainId: null,
    resourceId:
      typeof args.orderHash === 'string' && args.orderHash
        ? buildResourceId({ order: args.orderHash })
        : buildResourceId({ kind: `clOrdId:${typeof args.clOrdId === 'string' ? args.clOrdId : ''}` }),
    payload: { orderHash: args.orderHash, clOrdId: args.clOrdId },
  }),
};

export const SIGNED_TOOLS: ReadonlySet<string> = new Set(Object.keys(BINDINGS));

/** Inputs the bridge supplies itself, so the app is never asked for them. */
const BRIDGE_INPUTS = ['walletAddress', 'walletSignature', 'signatureTimestamp', 'proofNonce', 'orderSignature', 'nonce'];

const BRIDGE_NOTE =
  'This local Problee bridge holds the agent wallet: it adds the wallet, the wallet proof and the order signature, and signs only the order stated in this call.';

/** The signed tools as the app should see them: the order terms only. */
export function describeSignedTools(listed: ListToolsResult): ListToolsResult {
  return {
    ...listed,
    tools: listed.tools.map((tool) => {
      if (!SIGNED_TOOLS.has(tool.name)) return tool;
      const properties: Record<string, object> = { ...(tool.inputSchema.properties ?? {}) };
      for (const name of BRIDGE_INPUTS) delete properties[name];
      const required = (tool.inputSchema.required ?? []).filter(
        (name) => !BRIDGE_INPUTS.includes(name) && name !== 'idempotencyKey'
      );
      return {
        ...tool,
        description: `${tool.description ?? ''}\n\n${BRIDGE_NOTE}`.trim(),
        inputSchema: { ...tool.inputSchema, properties, required },
      };
    }),
  };
}

// ─── Signing a call ───────────────────────────────────────────────────────

type Forward = (params: CallToolRequest['params']) => Promise<CallToolResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The bridge acts only on a call that brings no proof of its own and names no other wallet. */
function bridgeSigns(wallet: BridgeWallet, args: Args): boolean {
  if (args.walletSignature !== undefined || args.proofNonce !== undefined || args.orderSignature !== undefined) {
    return false;
  }
  return (
    args.walletAddress === undefined ||
    (typeof args.walletAddress === 'string' &&
      args.walletAddress.toLowerCase() === wallet.account.address.toLowerCase())
  );
}

async function withProof(wallet: BridgeWallet, tool: string, args: Args): Promise<Args> {
  const binding = BINDINGS[tool]!(args);
  const walletAddress = wallet.account.address.toLowerCase();
  const nonce = await fetchNonce(wallet.apiOrigin);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = buildWalletProofMessage({
    agentId: wallet.agentId,
    apiKeyId: wallet.apiKeyId,
    tool,
    scope: binding.scope,
    chainId: binding.chainId,
    walletAddress,
    resourceId: binding.resourceId,
    payloadHash: hashToolIntent(binding.payload),
    nonce,
    timestamp,
  });
  const walletSignature = await wallet.account.signMessage({ message });
  return { ...args, walletAddress, walletSignature, signatureTimestamp: timestamp, proofNonce: nonce };
}

export function resultValue(result: CallToolResult): unknown {
  const structured = result.structuredContent as { result?: unknown } | undefined;
  if (structured && 'result' in structured) return structured.result;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (first?.type !== 'text') return undefined;
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return undefined;
  }
}

/** Why the returned order is not the one asked for, or null when it is. */
function orderMismatch(wallet: BridgeWallet, args: Args, typedData: Record<string, unknown>): string | null {
  const message = typedData.message;
  const domain = typedData.domain;
  if (typedData.primaryType !== 'Order' || !isRecord(message) || !isRecord(domain)) {
    return 'the server returned something other than an order to sign';
  }
  // A placed order is signed under one domain; its name and version are hashed as written.
  if (domain.name !== 'ProbableOrderbook' || domain.version !== '1') {
    return 'the order to sign is under a different signing domain than an order placed here';
  }
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  const checks: Array<[string, unknown, unknown]> = [
    ['maker', message.maker, wallet.account.address],
    ['market', message.market, args.marketAddress],
    ['verifying contract', domain.verifyingContract, args.marketAddress],
    ['kind', message.kind, orderKind(args)],
    ['side', message.side, args.side],
    ['price', message.price, priceBps(args)],
    ['amount', message.amount, args.amount],
  ];
  if (args.expiry !== undefined) checks.push(['expiry', message.expiry, args.expiry]);
  if (args.chainId !== undefined) checks.push(['chainId', domain.chainId, args.chainId]);
  const wrong = checks.find(([, got, want]) => want === undefined || !same(got, want));
  return wrong ? `the order to sign has a different ${wrong[0]} than this call asked for` : null;
}

function refusal(reason: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'BRIDGE_REFUSED_TO_SIGN',
          detail: `The local Problee bridge did not sign: ${reason}. Nothing was placed.`,
        }),
      },
    ],
    isError: true,
  };
}

export function signingCallTool(wallet: BridgeWallet, forward: Forward): Forward {
  return async (params) => {
    const args = (params.arguments ?? {}) as Args;
    if (!SIGNED_TOOLS.has(params.name) || !bridgeSigns(wallet, args)) return forward(params);

    const idempotencyKey =
      typeof args.idempotencyKey === 'string' && args.idempotencyKey ? args.idempotencyKey : randomUUID();
    const first = await forward({
      ...params,
      arguments: await withProof(wallet, params.name, { ...args, idempotencyKey }),
    });
    if (params.name !== PLACE_ORDER) return first;

    const prepared = resultValue(first);
    if (!isRecord(prepared) || prepared.requiresSignature !== true || !isRecord(prepared.typedData)) {
      return first;
    }
    const typedData = prepared.typedData;
    const mismatch = orderMismatch(wallet, args, typedData);
    if (mismatch) return refusal(mismatch);

    const message = typedData.message as Record<string, unknown>;
    const orderSignature = await wallet.account.signTypedData(
      typedData as unknown as Parameters<PrivateKeyAccount['signTypedData']>[0]
    );
    return forward({
      ...params,
      arguments: await withProof(wallet, params.name, {
        ...args,
        // The signed submission is a different request, so it gets its own key,
        // derived so that one caller key keeps the whole call retry-safe.
        idempotencyKey: `${idempotencyKey}:signed`,
        nonce: String(message.nonce),
        expiry: Number(message.expiry),
        orderSignature,
      }),
    });
  };
}
