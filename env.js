/**
 * Reading configuration from a .env file.
 *
 * The cloud needs a database URL before it can do anything, and until now that
 * had to be exported into the shell first. In PowerShell an `$env:` variable
 * lives only as long as that window, so every new terminal started without it
 * and the server refused to boot — a papercut that showed up again on every
 * restart, and would show up on the server every time somebody logged in to
 * check something.
 *
 * Written here rather than pulled in as a dependency. It is thirty lines, it
 * has to run before anything else in the process, and a deploy that needs
 * `npm install` to have succeeded before it can even read its own
 * configuration is a worse failure than the one it replaces.
 *
 * **Existing environment variables always win.** A value already exported —
 * by systemd, by a container, by somebody debugging in a terminal — is never
 * overwritten by the file. That keeps the file a convenience for development
 * and a default in production, rather than something that silently overrides
 * the deliberate choice somebody just made.
 *
 * The file holds a live database credential, so it must never be committed.
 * `.env` is in cloud/.gitignore; see .env.example for the shape.
 */

const fs = require('fs');
const path = require('path');

let loaded = false;

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // `export KEY=value` is accepted as well as `KEY=value`, so a file written
    // for a bash `source` works here unchanged.
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;

    const eq = body.indexOf('=');
    if (eq < 1) continue;

    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();

    // Quotes are stripped, and only then, so a password containing a # or a
    // space survives. An unquoted value keeps everything up to the end of the
    // line for the same reason — a trailing-comment rule would silently
    // truncate a credential at its first #.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

/**
 * Load once, from `cloud/.env` unless BLAZE_ENV_FILE points elsewhere.
 *
 * Silent when the file is absent: a properly configured server sets its
 * variables some other way, and a missing optional file is not a problem worth
 * a warning on every boot.
 */
function loadEnv() {
  if (loaded) return;
  loaded = true;

  const file = process.env.BLAZE_ENV_FILE || path.join(__dirname, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return;
  }

  const values = parse(text);
  let applied = 0;
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }

  if (applied) {
    // Names only. Every line this process logs ends up in a file somewhere,
    // and one of these values is a database password.
    console.log(`Config: read ${Object.keys(values).join(', ')} from ${path.basename(file)}.`);
  }
}

module.exports = { loadEnv, parse };
