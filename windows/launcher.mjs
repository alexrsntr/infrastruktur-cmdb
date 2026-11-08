// Infrastruktur CMDB – launcher of the portable Windows test package ("Start CMDB.cmd").
//
// First start: creates a PostgreSQL database in the "data" folder next to it and random passwords.
// Every start: starts PostgreSQL and the CMDB (both only reachable from this computer) and opens the browser.
// Ctrl+C or closing the window stops everything. "Stop CMDB.cmd" (= --stop) stops leftovers.
//
// Options: --no-browser   do not open the browser
//          --stop         stop a running CMDB and its database
// Environment: CMDB_PORT (preferred web port, default 8080), CMDB_DATA_DIR (default: ..\data)

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, '..');
const DATA = path.resolve(process.env.CMDB_DATA_DIR || path.join(ROOT, 'data'));
const PGDATA = path.join(DATA, 'postgres');
const LOGS = path.join(DATA, 'logs');
const SECRETS_FILE = path.join(DATA, 'secrets.json');
const RUNTIME_FILE = path.join(DATA, 'runtime.json');
const STOP_FLAG = path.join(DATA, 'stop-requested');
const PGBIN = path.join(APP_DIR, 'pgsql', 'bin');
const CMDB_DIR = path.join(APP_DIR, 'cmdb');
const IS_WINDOWS = process.platform === 'win32';
const DB_USER = 'cmdb';
const DB_NAME = 'cmdb';

const args = new Set(process.argv.slice(2));
const openBrowser = !args.has('--no-browser') && process.env.CMDB_NO_BROWSER !== '1';

const say = (msg) => console.log(`[cmdb] ${msg}`);
const pgTool = (name) => path.join(PGBIN, IS_WINDOWS ? `${name}.exe` : name);

function fail(msg) {
  console.error(`\n[cmdb] ERROR: ${msg}\n`);
  process.exit(1);
}

function run(tool, toolArgs, opts = {}) {
  // stdio "inherit": never pipes – pg_ctl's background postgres would otherwise keep a pipe open
  const res = spawnSync(pgTool(tool), toolArgs, { stdio: opts.quiet ? 'ignore' : 'inherit', windowsHide: true });
  if (res.error) fail(`${tool} could not be started: ${res.error.message}`);
  return res.status ?? 1;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadSecrets() {
  const existing = readJson(SECRETS_FILE);
  if (existing?.dbPassword && existing?.sessionSecret && existing?.settingsKey) return existing;
  const secrets = {
    dbPassword: crypto.randomBytes(24).toString('base64url'),
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    settingsKey: crypto.randomBytes(48).toString('base64url'),
  };
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

/** Free = nobody answers on 127.0.0.1:port and we can bind it (only on 127.0.0.1, so no firewall prompt). */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    probe.setTimeout(500);
    const bindTest = () => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(true)));
    };
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('timeout', () => {
      probe.destroy();
      bindTest();
    });
    probe.once('error', () => bindTest());
  });
}

async function findPort(preferred, last) {
  for (let port = preferred; port <= last; port++) if (await isPortFree(port)) return port;
  fail(`no free port between ${preferred} and ${last}`);
}

function postgresStatus() {
  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) return { initialised: false, running: false };
  const running = run('pg_ctl', ['status', '-D', PGDATA], { quiet: true }) === 0;
  let port = null;
  if (running) {
    const pid = fs.readFileSync(path.join(PGDATA, 'postmaster.pid'), 'utf8').split(/\r?\n/);
    port = Number(pid[3]) || null; // line 4 of postmaster.pid is the port
  }
  return { initialised: true, running, port };
}

function stopPostgres() {
  if (postgresStatus().running) {
    say('Stopping the database …');
    run('pg_ctl', ['stop', '-D', PGDATA, '-m', 'fast', '-w', '-t', '30'], { quiet: true });
  }
}

/** The CMDB of an earlier start, if it is still running (checked via its health endpoint, not just the PID). */
async function runningApp() {
  const runtime = readJson(RUNTIME_FILE);
  if (!runtime?.appPort) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.appPort}/healthz`, { signal: AbortSignal.timeout(2000) });
    const body = res.ok ? await res.json() : null;
    return body?.status === 'ok' ? runtime : null;
  } catch {
    return null;
  }
}

async function stopApp() {
  const runtime = await runningApp();
  if (runtime?.appPid) {
    say('Stopping the CMDB …');
    fs.writeFileSync(STOP_FLAG, '');
    try {
      process.kill(runtime.appPid);
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(RUNTIME_FILE, { force: true });
}

function openInBrowser(url) {
  if (openBrowser && IS_WINDOWS) spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function ensureDatabase(port, password) {
  const require = createRequire(path.join(CMDB_DIR, 'package.json'));
  const { Client } = require('pg');
  const client = new Client({ host: '127.0.0.1', port, user: DB_USER, password, database: 'postgres' });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (!rowCount) {
      say('Creating the CMDB database …');
      await client.query(`CREATE DATABASE ${DB_NAME}`);
    }
  } finally {
    await client.end();
  }
}

async function waitUntilReady(url, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const res = await fetch(`${url}/readyz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------

async function main() {
  if (args.has('--stop')) {
    await stopApp();
    stopPostgres();
    say('Stopped.');
    return;
  }

  const already = await runningApp();
  if (already) {
    say(`The CMDB is already running: ${already.url}`);
    openInBrowser(already.url);
    return;
  }

  if (!fs.existsSync(pgTool('pg_ctl'))) fail(`PostgreSQL was not found in ${PGBIN}. Please unpack the complete ZIP file first.`);
  if (!fs.existsSync(path.join(CMDB_DIR, 'dist', 'server.mjs'))) fail('The CMDB program files are missing. Please unpack the complete ZIP file first.');

  fs.mkdirSync(LOGS, { recursive: true });
  const secrets = loadSecrets();

  // ---- database
  let pg = postgresStatus();
  if (!pg.initialised) {
    say('First start: setting up the database (takes a few seconds) …');
    const pwFile = path.join(DATA, 'initdb-password.tmp');
    fs.writeFileSync(pwFile, secrets.dbPassword, { mode: 0o600 });
    try {
      const status = run('initdb', ['-D', PGDATA, '-U', DB_USER, `--pwfile=${pwFile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], { quiet: true });
      if (status !== 0) fail('Setting up the database failed (initdb). Delete the "data" folder and try again.');
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
    pg = postgresStatus();
  }
  let pgPort = pg.port;
  if (!pg.running) {
    pgPort = await findPort(54329, 54399);
    say(`Starting the database on 127.0.0.1:${pgPort} …`);
    const status = run('pg_ctl', ['start', '-D', PGDATA, '-w', '-t', '60', '-l', path.join(LOGS, 'postgres.log'), '-o', `-p ${pgPort} -c listen_addresses=127.0.0.1`], { quiet: true });
    if (status !== 0) fail(`The database did not start. Details: ${path.join(LOGS, 'postgres.log')}`);
  } else {
    say(`The database is already running on 127.0.0.1:${pgPort}.`);
  }
  await ensureDatabase(pgPort, secrets.dbPassword);

  // ---- CMDB
  fs.rmSync(RUNTIME_FILE, { force: true });
  fs.rmSync(STOP_FLAG, { force: true });
  const preferred = Number(process.env.CMDB_PORT) || 8080;
  const appPort = await findPort(preferred, preferred + 20);
  const url = `http://localhost:${appPort}`;
  const env = { ...process.env };
  delete env.DATABASE_URL;
  Object.assign(env, {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(appPort),
    APP_BASE_URL: url,
    AUTH_MODE: 'local',
    DB_AUTH: 'password',
    PGHOST: '127.0.0.1',
    PGPORT: String(pgPort),
    PGDATABASE: DB_NAME,
    PGUSER: DB_USER,
    PGPASSWORD: secrets.dbPassword,
    PGSSLMODE: 'disable',
    SESSION_SECRET: secrets.sessionSecret,
    SETTINGS_ENCRYPTION_KEY: secrets.settingsKey,
    STORAGE_DRIVER: 'database',
  });
  say(`Starting the CMDB on ${url} …`);
  const app = spawn(process.execPath, ['--enable-source-maps', path.join(CMDB_DIR, 'dist', 'server.mjs')], { cwd: CMDB_DIR, env, stdio: 'inherit', windowsHide: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ url, appPort, pgPort, appPid: app.pid, launcherPid: process.pid }, null, 2));

  let stopping = false;
  const shutdown = (code) => {
    if (stopping) return;
    stopping = true;
    if (app.exitCode === null) app.kill();
    stopPostgres();
    fs.rmSync(RUNTIME_FILE, { force: true });
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => shutdown(0));
  app.on('exit', (code) => {
    if (stopping) return;
    if (fs.existsSync(STOP_FLAG)) {
      // stopped with "Stop CMDB.cmd"
      fs.rmSync(STOP_FLAG, { force: true });
      say('The CMDB was stopped.');
      shutdown(0);
      return;
    }
    console.error(`\n[cmdb] The CMDB stopped unexpectedly (exit code ${code}).`);
    shutdown(code || 1);
  });

  if (!(await waitUntilReady(`http://127.0.0.1:${appPort}`, 90))) {
    console.error('[cmdb] The CMDB did not become ready within 90 seconds.');
    shutdown(1);
    return;
  }
  console.log('');
  console.log('  ==============================================================');
  console.log(`   Infrastruktur CMDB is running:  ${url}`);
  console.log('   First visit: create your administrator account.');
  console.log('   To stop: close this window or press Ctrl+C.');
  console.log('  ==============================================================');
  console.log('');
  openInBrowser(url);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
