#!/usr/bin/env node
// Fixes missing execute bit on node-pty prebuilt binaries.
// npm strips +x from native files on install — this restores it.
// No-op on Windows (spawn-helper is not used there).

const { chmodSync, existsSync } = require('fs');
const { join } = require('path');

if (process.platform === 'win32') process.exit(0);

const platformKey = `${process.platform}-${process.arch}`;
const prebuildDir = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', platformKey);

for (const file of ['spawn-helper', 'pty.node']) {
  const filePath = join(prebuildDir, file);
  if (existsSync(filePath)) {
    try {
      chmodSync(filePath, 0o755);
    } catch (_) {
      // Best-effort — don't fail the install
    }
  }
}
