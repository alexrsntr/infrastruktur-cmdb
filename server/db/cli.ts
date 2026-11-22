import { loadConfig } from '../config';
import { createPool } from './pool';
import { migrate } from './migrate';
import { seed } from './seed';
import { LocalAccountError, setLocalPassword } from '../auth/localAccounts';

const USAGE = `Usage:
  cli.ts migrate                   apply pending database migrations
  cli.ts seed [--force]            load the demo data (--force wipes the CMDB tables first – never in production)
  cli.ts set-password <e-mail>     set the password of an account (signs it out everywhere)
                                   The password is read from CMDB_NEW_PASSWORD, typed in (hidden) or piped in.`;

const command = process.argv[2];

/** Reads a line from the terminal without showing what is typed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new LocalAccountError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** The new password: CMDB_NEW_PASSWORD, typed in twice (terminal) or the first line of stdin (pipe). Never an argument. */
async function readNewPassword(): Promise<string> {
  const fromEnv = process.env.CMDB_NEW_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    const first = await promptHidden('New password: ');
    const second = await promptHidden('Repeat the new password: ');
    if (first !== second) throw new LocalAccountError('The two passwords are not the same.');
    return first;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  if (!piped) throw new LocalAccountError('No password given: set CMDB_NEW_PASSWORD, pipe the password in or run the command in a terminal (docker run -it …).');
  return piped;
}

async function setPassword(email: string | undefined) {
  if (!email || email.startsWith('-')) throw new LocalAccountError(USAGE);
  const password = await readNewPassword();
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const user = await setLocalPassword(pool, email, password);
    console.log(`Password set for ${user.displayName} <${user.email}> (role: ${user.role}). The account was signed out everywhere.`);
    if (!user.active) console.warn('Note: this account is deactivated – it cannot sign in until an administrator activates it again.');
    if (user.role !== 'admin')
      console.warn('Note: this account is not an administrator – while password sign-in is limited to administrators (or LOCAL_LOGIN_EMERGENCY is used), it cannot sign in with a password.');
  } finally {
    await pool.end();
  }
}

async function main() {
  if (command === 'set-password') return setPassword(process.argv[3]);
  if (command !== 'migrate' && command !== 'seed') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const pool = createPool(config);
  try {
    if (command === 'migrate') {
      const applied = await migrate(pool);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
    } else {
      await migrate(pool);
      const result = await seed(pool, { force: process.argv.includes('--force') });
      console.log(result);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  if (err instanceof LocalAccountError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
