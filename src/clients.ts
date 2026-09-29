// Per-client install handlers. Each one knows where its config lives and
// how to merge a Problee MCP server entry without clobbering existing servers.
//
// Returns { installed, configPath, action } where action is one of:
//   "added"    — entry written into config
//   "updated"  — entry already present, refreshed (auth/url changed)
//   "skipped"  — entry already present and identical
//   "manual"   — automatic install not supported on this client; user prompt printed

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export type ClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'codex';
export type Action = 'added' | 'updated' | 'skipped' | 'manual' | 'missing';
export type Result = {
  client: ClientId;
  action: Action;
  configPath?: string;
  detail?: string;
};

const SERVER_NAME = 'problee';
const PROXY_COMMAND = 'npx';
// Pin the bridge package. Registration rewrites this entry on upgrades, so a
// client restart cannot silently execute an unreviewed newer package.
const PROXY_ARGS = ['-y', '@probleeprotocol/mcp@1.0.4', 'serve'] as const;

function secureProxyEntry(): { command: string; args: string[] } {
  return { command: PROXY_COMMAND, args: [...PROXY_ARGS] };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`Refusing to replace non-file MCP configuration: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `Refusing to overwrite invalid MCP configuration at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function writeJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform() !== 'win32') chmodSync(directory, 0o700);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    if (platform() !== 'win32') {
      chmodSync(path, 0o600);
      const directoryDescriptor = openSync(directory, 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

// ─── Claude Desktop ────────────────────────────────────────────
// Config: ~/Library/Application Support/Claude/claude_desktop_config.json (mac)
//         %APPDATA%\Claude\claude_desktop_config.json                       (win)
//         ~/.config/Claude/claude_desktop_config.json                       (linux, when supported)

function claudeDesktopConfigPath(): string {
  const home = homedir();
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (platform() === 'win32') {
    const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appdata, 'Claude', 'claude_desktop_config.json');
  }
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

interface ClaudeDesktopConfig {
  mcpServers?: Record<
    string,
    | { url: string; transport?: string; headers?: Record<string, string> }
    | { command: string; args?: string[]; env?: Record<string, string> }
  >;
  [key: string]: unknown;
}

function installClaudeDesktop(): Result {
  const path = claudeDesktopConfigPath();
  const config: ClaudeDesktopConfig = readJson<ClaudeDesktopConfig>(path) ?? {};
  const existing = config.mcpServers?.[SERVER_NAME];
  const next = secureProxyEntry();
  const action: Action = !existing
    ? 'added'
    : JSON.stringify(existing) === JSON.stringify(next)
      ? 'skipped'
      : 'updated';
  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: next };
  if (action !== 'skipped') writeJson(path, config);
  return { client: 'claude-desktop', action, configPath: path };
}

// ─── Claude Code (Anthropic CLI) ────────────────────────────────
// Configured via: claude mcp add --transport http <name> <url> --header ...

function installClaudeCode(): Result {
  const claudeBin = which('claude');
  if (!claudeBin) {
    return {
      client: 'claude-code',
      action: 'missing',
      detail:
        'Claude Code CLI not found (`claude` not on PATH). Install from claude.ai/download then re-run.',
    };
  }
  const result = spawnSync(
    claudeBin,
    ['mcp', 'add', SERVER_NAME, '--', PROXY_COMMAND, ...PROXY_ARGS],
    { stdio: 'pipe', encoding: 'utf8' }
  );
  if (result.status === 0) return { client: 'claude-code', action: 'added' };
  const stderr = result.stderr ?? '';
  if (/already exists|already added/i.test(stderr)) {
    const removed = spawnSync(claudeBin, ['mcp', 'remove', SERVER_NAME], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (removed.status !== 0) {
      return {
        client: 'claude-code',
        action: 'manual',
        detail: (removed.stderr ?? '').trim() || 'could not replace existing Problee entry',
      };
    }
    const replaced = spawnSync(
      claudeBin,
      ['mcp', 'add', SERVER_NAME, '--', PROXY_COMMAND, ...PROXY_ARGS],
      { stdio: 'pipe', encoding: 'utf8' }
    );
    return replaced.status === 0
      ? { client: 'claude-code', action: 'updated' }
      : {
          client: 'claude-code',
          action: 'manual',
          detail: (replaced.stderr ?? '').trim() || `exit ${replaced.status}`,
        };
  }
  return {
    client: 'claude-code',
    action: 'manual',
    detail: stderr.trim() || `exit ${result.status}`,
  };
}

// ─── Cursor ──────────────────────────────────────────────────────
// Project: <repo>/.cursor/mcp.json
// Global:  ~/.cursor/mcp.json
// Format: { "mcpServers": { name: { url, type: "http", headers } } }

function cursorGlobalConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

interface CursorConfig {
  mcpServers?: Record<
    string,
    | { url: string; type?: string; headers?: Record<string, string> }
    | { command: string; args?: string[] }
  >;
}

function installCursor(): Result {
  const path = cursorGlobalConfigPath();
  const config: CursorConfig = readJson<CursorConfig>(path) ?? {};
  const existing = config.mcpServers?.[SERVER_NAME];
  const next = secureProxyEntry();
  const action: Action = !existing
    ? 'added'
    : JSON.stringify(existing) === JSON.stringify(next)
      ? 'skipped'
      : 'updated';
  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: next };
  if (action !== 'skipped') writeJson(path, config);
  return { client: 'cursor', action, configPath: path };
}

// ─── Codex (OpenAI) ─────────────────────────────────────────────
// Configured via: codex mcp add <name> --url <url> --bearer-token-env-var ...

function installCodex(): Result {
  const codexBin = which('codex');
  if (!codexBin) {
    return {
      client: 'codex',
      action: 'missing',
      detail: 'Codex CLI not found (`codex` not on PATH). Install from openai.com then re-run.',
    };
  }
  const result = spawnSync(
    codexBin,
    ['mcp', 'add', SERVER_NAME, '--', PROXY_COMMAND, ...PROXY_ARGS],
    { stdio: 'pipe', encoding: 'utf8' }
  );
  if (result.status === 0) {
    return {
      client: 'codex',
      action: 'added',
      detail: 'uses the local secure credential proxy',
    };
  }
  const stderr = result.stderr ?? '';
  if (/already exists|already added/i.test(stderr)) {
    const removed = spawnSync(codexBin, ['mcp', 'remove', SERVER_NAME], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (removed.status !== 0) {
      return {
        client: 'codex',
        action: 'manual',
        detail: (removed.stderr ?? '').trim() || 'could not replace existing Problee entry',
      };
    }
    const replaced = spawnSync(
      codexBin,
      ['mcp', 'add', SERVER_NAME, '--', PROXY_COMMAND, ...PROXY_ARGS],
      { stdio: 'pipe', encoding: 'utf8' }
    );
    return replaced.status === 0
      ? {
          client: 'codex',
          action: 'updated',
          detail: 'uses the local secure credential proxy',
        }
      : {
          client: 'codex',
          action: 'manual',
          detail: (replaced.stderr ?? '').trim() || `exit ${replaced.status}`,
        };
  }
  return {
    client: 'codex',
    action: 'manual',
    detail: stderr.trim() || `exit ${result.status}`,
  };
}

// ─── Status (read-only) ─────────────────────────────────────────

export interface StatusEntry {
  client: ClientId;
  configPath: string;
  registered: boolean;
  endpoint?: string;
}

export function statusAll(): StatusEntry[] {
  const out: StatusEntry[] = [];

  // Claude Desktop
  {
    const path = claudeDesktopConfigPath();
    const config = readJson<ClaudeDesktopConfig>(path);
    const entry = config?.mcpServers?.[SERVER_NAME];
    out.push({
      client: 'claude-desktop',
      configPath: path,
      registered: Boolean(entry),
      endpoint:
        entry && 'url' in entry
          ? entry.url
          : entry && 'command' in entry
            ? '(secure local proxy)'
            : undefined,
    });
  }

  // Cursor
  {
    const path = cursorGlobalConfigPath();
    const config = readJson<CursorConfig>(path);
    const entry = config?.mcpServers?.[SERVER_NAME];
    out.push({
      client: 'cursor',
      configPath: path,
      registered: Boolean(entry),
      endpoint:
        entry && 'url' in entry
          ? entry.url
          : entry && 'command' in entry
            ? '(secure local proxy)'
            : undefined,
    });
  }

  // Claude Code: best-effort — `claude mcp list` is the canonical check
  {
    const bin = which('claude');
    let registered = false;
    if (bin) {
      const r = spawnSync(bin, ['mcp', 'list'], { stdio: 'pipe', encoding: 'utf8' });
      registered = (r.stdout ?? '').includes(SERVER_NAME);
    }
    out.push({ client: 'claude-code', configPath: '(claude mcp list)', registered });
  }

  // Codex
  {
    const bin = which('codex');
    let registered = false;
    if (bin) {
      const r = spawnSync(bin, ['mcp', 'list'], { stdio: 'pipe', encoding: 'utf8' });
      registered = (r.stdout ?? '').includes(SERVER_NAME);
    }
    out.push({ client: 'codex', configPath: '(codex mcp list)', registered });
  }

  return out;
}

// ─── Public install dispatch ────────────────────────────────────

export function installFor(client: ClientId): Result {
  switch (client) {
    case 'claude-desktop':
      return installClaudeDesktop();
    case 'claude-code':
      return installClaudeCode();
    case 'cursor':
      return installCursor();
    case 'codex':
      return installCodex();
  }
}

export const ALL_CLIENTS: readonly ClientId[] = [
  'claude-desktop',
  'claude-code',
  'cursor',
  'codex',
] as const;

// ─── Helpers ────────────────────────────────────────────────────

function which(bin: string): string | null {
  const cmd = platform() === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [bin], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) return null;
  const first = (r.stdout ?? '').split(/\r?\n/)[0]?.trim();
  return first ? first : null;
}
