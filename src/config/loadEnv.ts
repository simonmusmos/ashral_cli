import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function loadFile(envPath: string): void {
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const exportPrefix = line.startsWith('export ') ? 'export '.length : 0;
    const normalized = line.slice(exportPrefix);
    const separatorIndex = normalized.indexOf('=');

    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(normalized.slice(separatorIndex + 1).trim());

    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

/**
 * Loads .env files in priority order (later files do NOT override earlier ones):
 *   1. ~/.ashral/.env  — global user config, credentials live here
 *   2. <cwd>/.env     — project-level overrides
 *
 * This means Firebase credentials set once in ~/.ashral/.env work from any directory.
 */
export function loadEnvFile(): void {
  loadFile(join(homedir(), '.ashral', '.env'));
  loadFile(resolve(process.cwd(), '.env'));
}
