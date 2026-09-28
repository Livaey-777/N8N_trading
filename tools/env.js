'use strict';
/**
 * Minimal .env loader shared by the local tooling.
 *
 * Secrets are read into memory only; nothing in this module ever prints a value.
 * Use `describeSecret()` to report presence as CONFIGURED / NOT CONFIGURED.
 */
const fs = require('fs');
const path = require('path');

/**
 * Project root. Prefer the working directory when it is the project (Node's
 * __dirname is a realpath, which on MSIX-virtualised Windows profiles points at
 * a LocalCache view from which executables cannot be launched).
 */
function devirtualise(p) {
  // ...\AppData\Local\Packages\<pkg>\LocalCache\Roaming\... -> ...\AppData\Roaming\...
  return p.replace(/([\\/])AppData\1Local\1Packages\1[^\\/]+\1LocalCache\1Roaming\1/i, '$1AppData$1Roaming$1');
}

function findRoot() {
  let dir = devirtualise(process.cwd());
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'gold-intelligence-n8n') return dir;
      } catch (_) { /* not our package.json */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..');
}

const ROOT = findRoot();
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function loadEnv({ required = true } = {}) {
  if (!fs.existsSync(ENV_FILE)) {
    if (required) throw new Error('.env not found. Run: node tools/setup-local.js');
    return {};
  }
  return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
}

function describeSecret(value) {
  return value && String(value).trim().length > 0 ? 'CONFIGURED' : 'NOT CONFIGURED';
}

module.exports = { ROOT, ENV_FILE, ENV_EXAMPLE, parseEnv, loadEnv, describeSecret };
