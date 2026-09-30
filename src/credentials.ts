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
import { randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoredCredential {
  version: 1;
  apiKey: string;
  endpoint: string;
  apiKeyId?: string;
  keyPrefix?: string;
  /** A registered agent (`register --owner`): its ExternalAgent id and its own wallet. */
  agentId?: string;
  wallet?: { address: string; privateKey: string };
  storedAt: string;
}

function isWallet(value: unknown): boolean {
  if (value === undefined) return true;
  const wallet = value as { address?: unknown; privateKey?: unknown } | null;
  return (
    typeof wallet?.address === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(wallet.address) &&
    typeof wallet.privateKey === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(wallet.privateKey)
  );
}

function defaultCredentialPath(): string {
  if (platform() === 'win32') {
    const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'Problee', 'credentials.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'problee', 'credentials.json');
}

export function credentialPath(): string {
  return process.env.PROBLEE_CREDENTIALS_FILE ?? defaultCredentialPath();
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`Problee credential path is not a regular file: ${path}`);
  }
  if (platform() !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(
      `Problee credential file permissions are too broad (${(stat.mode & 0o777).toString(8)}); run chmod 600 ${path}`
    );
  }
}

export function loadCredential(): StoredCredential | null {
  const path = credentialPath();
  if (!existsSync(path)) return null;
  assertPrivateFile(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Problee credential file is not valid JSON: ${path}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<StoredCredential>).version !== 1 ||
    typeof (parsed as Partial<StoredCredential>).apiKey !== 'string' ||
    !(parsed as Partial<StoredCredential>).apiKey ||
    typeof (parsed as Partial<StoredCredential>).endpoint !== 'string' ||
    !(parsed as Partial<StoredCredential>).endpoint ||
    !isWallet((parsed as Partial<StoredCredential>).wallet)
  ) {
    throw new Error(`Problee credential file has an unsupported shape: ${path}`);
  }
  return parsed as StoredCredential;
}

export function storeCredential(
  credential: Omit<StoredCredential, 'version' | 'storedAt'>
): StoredCredential {
  if (!credential.apiKey || !credential.endpoint) {
    throw new Error('Cannot persist an empty Problee credential or endpoint');
  }

  const path = credentialPath();
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform() !== 'win32') chmodSync(directory, 0o700);

  const record: StoredCredential = {
    version: 1,
    ...credential,
    storedAt: new Date().toISOString(),
  };
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
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
  return record;
}
