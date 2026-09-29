import { spawn } from 'node:child_process';
import { argv, exit, stderr, stdout } from 'node:process';

import { endpointFromDiscovery, fetchDiscovery } from './api.js';
import { ALL_CLIENTS, installFor, statusAll } from './clients.js';
import type { ClientId, Result } from './clients.js';
import { credentialPath, loadCredential, storeCredential } from './credentials.js';
import { serveSecureProxy } from './proxy.js';

const CLI_VERSION = '1.0.4';
const HELP = `\
problee-mcp ${CLI_VERSION} — securely install the Problee MCP server

Usage:
  PROBLEE_API_KEY=<key> npx @probleeprotocol/mcp install [--client <id>]
  npx @probleeprotocol/mcp register [--client <id>]
  npx @probleeprotocol/mcp status
  npx @probleeprotocol/mcp --help

Commands:
  install     Install from an existing private credential or PROBLEE_API_KEY.
              API keys are rejected on command-line arguments.
  register    Print how to obtain an API key and open the registration page.
              Registration is self-service since 2026-08-23: prove a wallet and
              the protocol issues the scopes that identity earns.
              This command creates no credential and exits non-zero.
  status      Show credential and client registration status without exposing secrets.
  serve       Secure local stdio-to-HTTPS proxy used by installed MCP clients;
              without a key it serves the public reads.

Client:
  --client    claude-desktop, claude-code, cursor, codex, or all (default)

Examples:
  PROBLEE_API_KEY=<key> npx @probleeprotocol/mcp install --client cursor
  npx @probleeprotocol/mcp register
  npx @probleeprotocol/mcp status

Docs: https://problee.com/for-agents
`;

function parseArgs(args: readonly string[]): {
  command: string;
  flags: Record<string, string>;
} {
  const positional = args[0]?.startsWith('--') ? ['help', ...args] : [...args];
  const [command = 'help', ...rest] = positional;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i];
    if (!argument?.startsWith('--')) continue;
    const [key, inlineValue] = argument.slice(2).split('=', 2);
    if (!key) continue;
    const next = rest[i + 1];
    const value = inlineValue ?? (next && !next.startsWith('--') ? next : 'true');
    flags[key] = value;
    if (inlineValue === undefined && next && !next.startsWith('--')) i++;
  }
  return { command, flags };
}

function fail(message: string): never {
  stdout.write(`✗ ${message}\n`);
  exit(2);
}

function resolveClients(value: string | undefined): ClientId[] {
  if (!value || value === 'all') return [...ALL_CLIENTS];
  const found = ALL_CLIENTS.find((client) => client === value);
  if (!found) {
    fail(`unknown client: ${value}. valid: ${ALL_CLIENTS.join(', ')}, all`);
  }
  return [found];
}

function assertNoArgvSecret(flags: Record<string, string>): void {
  if (flags['api-key']) {
    fail(
      'refusing --api-key because process arguments are observable; use PROBLEE_API_KEY'
    );
  }
}

function fmtAction(result: Result): string {
  const symbol = {
    added: '✓',
    updated: '↻',
    skipped: '·',
    manual: '!',
    missing: '—',
  }[result.action];
  const detail = result.detail ? `  ${result.detail}` : '';
  const path = result.configPath ? `  (${result.configPath})` : '';
  return `  ${symbol} ${result.client.padEnd(16)} ${result.action}${path}${detail}`;
}

function installClients(clients: readonly ClientId[]): Result[] {
  const results = clients.map((client) => installFor(client));
  for (const result of results) stdout.write(`${fmtAction(result)}\n`);

  const successful = results.filter((result) =>
    ['added', 'updated', 'skipped'].includes(result.action)
  );
  if (successful.length) {
    stdout.write(
      `\nNext: restart the affected app(s) and ask "What MCP tools do you have from Problee?"\n`
    );
  } else {
    throw new Error(
      'No MCP client was installed. Install a supported client or use --client with an available one, then rerun install.'
    );
  }
  return results;
}

async function currentEndpoint(): Promise<string> {
  return endpointFromDiscovery(await fetchDiscovery());
}

async function cmdInstall(flags: Record<string, string>): Promise<void> {
  assertNoArgvSecret(flags);
  const clients = resolveClients(flags.client);
  const endpoint = await currentEndpoint();
  const envApiKey = process.env.PROBLEE_API_KEY;
  const existing = loadCredential();
  const apiKey = envApiKey ?? existing?.apiKey;
  if (!apiKey) {
    fail('no private credential found; run `npx @probleeprotocol/mcp register`');
  }

  storeCredential({
    apiKey,
    endpoint,
    apiKeyId: existing?.apiKeyId,
    keyPrefix: existing?.keyPrefix ?? apiKey.slice(0, 8),
  });
  stdout.write(`Credential: ${credentialPath()} (private; key not printed)\n`);
  stdout.write(`Endpoint:   ${endpoint}\n`);
  stdout.write(`Clients:    ${clients.join(', ')}\n\n`);
  installClients(clients);
}

function openVerificationUrl(url: string): void {
  if (process.env.PROBLEE_NO_BROWSER === '1') return;
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The complete URL is printed so browser launch is only a convenience.
  }
}

const REGISTER_URL = 'https://problee.com/me/settings/agents';

/**
 * Registration left this CLI on 2026-08-23.
 *
 * This command used to drive the three-endpoint device flow, which is deleted;
 * a call to it now answers 404, so the command could only ever fail. The wallet
 * signature is the authority: prove control of a wallet and the protocol
 * issues the scopes that identity is entitled to, with no browser handoff to
 * poll for and no separate tier or spend-consent to request.
 *
 * The CLI deliberately does not touch wallet key material, so it hands the
 * operator the two real paths rather than inventing a third. It exits non-zero
 * because it produced no credential: a `register && install` chain must stop
 * here, not proceed to an install with nothing to install.
 */
async function cmdRegister(flags: Record<string, string>): Promise<void> {
  assertNoArgvSecret(flags);
  const clients = resolveClients(flags.client);
  stdout.write(
    [
      'Problee registration is self-service and no longer runs in this CLI.',
      '',
      'Get an API key from your account — every account can trade through the API and MCP, however it signed up:',
      `  1. Browser   ${REGISTER_URL}`,
      '               Sign in, then Create agent key. It is shown once.',
      '  2. API       POST https://api.problee.com/api/agent/v1/register',
      '               Closed by default since 2026-09-16. Read registration.paths[].status on',
      '               GET https://api.problee.com/api/agent/v1/mcp-discovery before calling it.',
      '',
      'The key carries full execute scopes; there is no tier to request.',
      '',
      'Then install without putting the key in process arguments:',
      `  PROBLEE_API_KEY=<key> npx @probleeprotocol/mcp install --client ${clients.join(',')}`,
      '',
    ].join('\n')
  );
  openVerificationUrl(REGISTER_URL);
  fail('no credential was created; run install with PROBLEE_API_KEY once you hold a key');
}

function cmdStatus(): void {
  const credential = loadCredential();
  stdout.write(`Problee MCP — credential and registered clients\n\n`);
  stdout.write(
    credential
      ? `  ✓ credential       ${credential.keyPrefix ?? 'stored'}… (${credentialPath()}, private)\n`
      : `  · credential       not found (${credentialPath()})\n`
  );
  for (const entry of statusAll()) {
    const symbol = entry.registered ? '✓' : '·';
    const where = entry.endpoint ? `→ ${entry.endpoint}` : '';
    stdout.write(
      `  ${symbol} ${entry.client.padEnd(16)} ${entry.registered ? 'registered' : 'not registered'} ${where}\n      ${entry.configPath}\n`
    );
  }
  stdout.write(`\nTo authorize and install: \`npx @probleeprotocol/mcp register\`\n`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(argv.slice(2));
  if (command === 'help' || flags.help === 'true' || flags.h === 'true') {
    stdout.write(HELP);
    return;
  }
  if (command === 'install') return cmdInstall(flags);
  if (command === 'status') return cmdStatus();
  if (command === 'register') return cmdRegister(flags);
  if (command === 'serve') return serveSecureProxy(CLI_VERSION);
  fail(`unknown command: ${command}\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const output = argv[2] === 'serve' ? stderr : stdout;
  output.write(`✗ error: ${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});
