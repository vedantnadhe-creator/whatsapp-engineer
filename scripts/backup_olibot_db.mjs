#!/usr/bin/env node
// backup_olibot_db.mjs — snapshot every OliBot SQLite DB (+ the WhatsApp auth_info creds)
// every 12h. Uses better-sqlite3's online backup API, which is the only safe way to copy a
// WAL-mode DB that is being written to — `cp sessions.db` alone silently drops the WAL and
// hands you a stale or torn file.
//
//   local:  ~/backups/olibot/<instance>-<UTC stamp>.db.gz   (last LOCAL_KEEP kept)
//   remote: oci://pl-dev-olibot-backups/<instance>/…        (bucket lifecycle expires at 30d)
//
// Scheduled by olibot-backup.timer (see scripts/olibot-backup.{service,timer}).
// Restore: gunzip the .db.gz, stop the service, replace sessions.db (delete -wal/-shm), start.
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const HOME = process.env.HOME || '/home/ubuntu';
const OUT = path.join(HOME, 'backups', 'olibot');
const BUCKET = 'pl-dev-olibot-backups';
const LOCAL_KEEP = 14; // 7 days at 12h
// instance name → directory. Both dashboards write their own sessions.db.
const INSTANCES = {
    olibot: path.join(HOME, 'whatsapp-engineer'),
    olibot_qweasd: path.join(HOME, 'whatsapp-engineer-qweasd'),
};
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const oci = (...args) => execFileSync(path.join(HOME, '.local', 'bin', 'oci'), args, { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, SUPPRESS_LABEL_WARNING: 'True' } });

async function gzipFile(src, dest) {
    await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dest));
    unlinkSync(src);
}

function prune(prefix) {
    readdirSync(OUT).filter(f => f.startsWith(prefix + '-') && f.endsWith('.gz'))
        .sort().slice(0, -LOCAL_KEEP).forEach(f => unlinkSync(path.join(OUT, f)));
}

mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const [name, dir] of Object.entries(INSTANCES)) {
    const src = path.join(dir, 'sessions.db');
    if (!existsSync(src)) { console.log(`[${name}] skip — ${src} missing`); continue; }
    const raw = path.join(OUT, `${name}-${stamp}.db`);
    const gz = raw + '.gz';
    try {
        const db = new Database(src, { readonly: true });
        await db.backup(raw);
        db.close();
        // Sanity: the copy must open and answer a query before we call it a backup.
        const check = new Database(raw, { readonly: true });
        const { n } = check.prepare('SELECT count(*) AS n FROM sessions').get();
        check.close();
        for (const side of ['-wal', '-shm']) if (existsSync(raw + side)) unlinkSync(raw + side);
        await gzipFile(raw, gz);
        oci('os', 'object', 'put', '--bucket-name', BUCKET, '--name', `${name}/${path.basename(gz)}`, '--file', gz, '--force');
        console.log(`[${name}] ok — ${n} sessions, ${(statSync(gz).size / 1e6).toFixed(1)} MB → ${gz}`);
        prune(name);
    } catch (err) {
        failed++;
        console.error(`[${name}] FAILED — ${err.message}`);
        if (existsSync(raw)) unlinkSync(raw);
    }
}

// WhatsApp session creds — tiny, and a restored DB without them means re-pairing the phone.
const auth = path.join(INSTANCES.olibot, 'auth_info');
if (existsSync(auth)) {
    const tgz = path.join(OUT, `auth_info-${stamp}.tgz`);
    try {
        execFileSync('tar', ['-czf', tgz, '-C', INSTANCES.olibot, 'auth_info']);
        oci('os', 'object', 'put', '--bucket-name', BUCKET, '--name', `auth_info/${path.basename(tgz)}`, '--file', tgz, '--force');
        console.log(`[auth_info] ok → ${tgz}`);
        prune('auth_info');
    } catch (err) { failed++; console.error(`[auth_info] FAILED — ${err.message}`); }
}
process.exit(failed ? 1 : 0);
