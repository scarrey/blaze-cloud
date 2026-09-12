/**
 * Does the dashboard actually render styled?
 *
 *   cd backend
 *   DATABASE_URL=... DASH_EMAIL=... DASH_PASSWORD=... \
 *     node scripts/run-script.js ../cloud/test/dashboard-renders.js
 *
 * A stylesheet growing from 0.4 kB to 53 kB proves Tailwind emitted something;
 * it does not prove the page uses it. This loads the real build in a browser,
 * signs in, opens each tab and reads *computed* styles — which is the only way
 * to tell "styled" from "a wall of unstyled HTML that happens to have the right
 * class names on it".
 *
 * Run through backend/scripts/run-script.js because that is the Electron
 * binary; Chromium here is the same engine the till renders in.
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

app.commandLine.appendSwitch('disable-gpu');
const log = (...a) => console.log(...a);
const ok = (l, c) => log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);
setTimeout(() => { log('TIMED OUT'); process.exit(1); }, 180000);

const PORT = 4392;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLOUD_ROOT = path.join(__dirname, '..');

let proc = null;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch (e) {}
    await wait(300);
  }
  return false;
}

app.whenReady().then(async () => {
 let win;
 try {
  proc = spawn('node', ['server.js'], {
    cwd: CLOUD_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!await waitFor(`${ORIGIN}/api/health`)) { log('cloud would not start'); process.exit(1); }

  win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: true } });
  const js = (code) => win.webContents.executeJavaScript(code).catch(e => ({ error: String(e.message).split('\n')[0] }));

  await win.loadURL(ORIGIN);
  await wait(2500);

  log('=== TAILWIND IS ACTUALLY APPLIED ===');
  // The sign-in form is plain inline styles, so probe the stylesheet directly:
  // build a node with a Tailwind class and read what the browser computes.
  const probe = await js(`
    (() => {
      const el = document.createElement('div');
      el.className = 'rounded-xl bg-white shadow-sm border border-gray-200 p-5';
      document.body.appendChild(el);
      const s = getComputedStyle(el);
      const out = {
        radius: s.borderRadius,
        background: s.backgroundColor,
        padding: s.padding,
        borderColor: s.borderColor,
      };
      el.remove();
      return out;
    })()`);
  log('   computed for .rounded-xl.bg-white.p-5 ->', JSON.stringify(probe));
  ok('rounded-xl produces a real radius', probe.radius && probe.radius !== '0px');
  ok('bg-white produces a real background', probe.background === 'rgb(255, 255, 255)');
  ok('p-5 produces real padding', probe.padding && probe.padding !== '0px');

  log('');
  log('=== SIGNING IN AND OPENING EACH TAB ===');
  const email = process.env.DASH_EMAIL;
  const password = process.env.DASH_PASSWORD;
  await js(`
    (async () => {
      await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
      });
    })()`);
  await win.webContents.reload();
  await wait(3500);

  const signedIn = await js(`!/Owner dashboard/.test(document.body.innerText)`);
  ok('signed in', signedIn === true);

  const TABS = ['Reports', 'Expenses', 'Shifts', 'Staff', 'Inventory'];
  for (const label of TABS) {
    const clicked = await js(`
      (() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return 'no tab';
        b.click();
        return 'clicked';
      })()`);
    await wait(2200);

    const state = await js(`
      (() => {
        const body = document.body;
        const text = body.innerText || '';
        // A screen that rendered has structure: elements with a real background
        // and a radius, not a bare document.
        const styled = [...document.querySelectorAll('div,section,table')].filter(el => {
          const s = getComputedStyle(el);
          return s.backgroundColor === 'rgb(255, 255, 255)' && parseFloat(s.borderRadius) > 0;
        }).length;
        return {
          styledBoxes: styled,
          chars: text.length,
          // Anything taller than the window that cannot be scrolled to is the
          // 100vh-clamp bug this test exists to catch.
          scrollable: document.documentElement.scrollHeight > window.innerHeight
            ? (getComputedStyle(document.body).overflowY !== 'hidden')
            : true,
          crashed: /Something went wrong|Cannot read|is not a function/i.test(text),
        };
      })()`);

    const good = clicked === 'clicked' && state.styledBoxes > 0 && !state.crashed && state.scrollable;
    ok(`${label.padEnd(10)} renders styled (${state.styledBoxes} cards, ${state.chars} chars${state.scrollable ? '' : ', NOT SCROLLABLE'})`, good);
  }
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  if (proc) { try { proc.kill(); } catch (e) {} }
  process.exit(0);
 }
});
