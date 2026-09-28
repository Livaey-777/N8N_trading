'use strict';
/**
 * Local-pilot bootstrap.
 *  - Creates .env from .env.example (generated DB password + n8n encryption key).
 *  - Creates runtime/n8n-owner.local.env holding a generated *test* owner account
 *    for the local n8n instance (kept apart from .env so owner-supplied secrets
 *    never need to be opened by tooling).
 * Never overwrites existing files and never prints generated values.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, ENV_FILE, ENV_EXAMPLE, parseEnv, describeSecret } = require('./env');

const OWNER_FILE = path.join(ROOT, 'runtime', 'n8n-owner.local.env');

function randomSecret(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function createEnv() {
  if (fs.existsSync(ENV_FILE)) {
    const env = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
    console.log('.env already exists — leaving it untouched.');
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'OPENROUTER_API_KEY', 'FRED_API_KEY']) {
      console.log(`  ${k}: ${describeSecret(env[k])}`);
    }
    return;
  }
  const generated = {
    N8N_ENCRYPTION_KEY: randomSecret(32),
    GI_PG_PASSWORD: randomSecret(24),
  };
  const lines = fs.readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/).map((line) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(generated, m[1]) && m[2].trim() === '') {
      return `${m[1]}=${generated[m[1]]}`;
    }
    return line;
  });
  fs.writeFileSync(ENV_FILE, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  console.log('.env created with generated local values (not shown).');
  console.log('Owner-supplied secrets NOT CONFIGURED yet: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, OPENROUTER_API_KEY.');
}

function createOwnerFile() {
  if (fs.existsSync(OWNER_FILE)) {
    console.log('local n8n owner file already exists.');
    return;
  }
  fs.mkdirSync(path.dirname(OWNER_FILE), { recursive: true });
  // n8n requires 8-64 chars incl. a number and an uppercase letter.
  const password = `Gi${randomSecret(14)}7Q`;
  fs.writeFileSync(OWNER_FILE, [
    '# Local-pilot n8n owner (test account on http://localhost:5678 only).',
    'N8N_LOCAL_OWNER_EMAIL=owner@gold-intel.test',
    `N8N_LOCAL_OWNER_PASSWORD=${password}`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  console.log(`local n8n owner test account written to ${path.relative(ROOT, OWNER_FILE)} (not shown).`);
}

createEnv();
createOwnerFile();
