// Backup, verify and restore for the SQLite database and the private uploads folder.
//
//   npm run backup                              create a backup under BACKUP_DIR (default ./backups)
//   npm run backup -- --verify <backup-dir>     check file hashes and run PRAGMA integrity_check
//   npm run backup -- --restore <backup-dir>    restore into DATA_DIR (stop the server first; add --force to replace existing data)
//
// A backup contains personal data and private documents. Treat it like production data: encrypt it and keep it off the host.
// This script does not encrypt, upload or rotate anything. Those are operator decisions (see docs/OPERATIONS.md).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../apps/api/src/core.ts';

const sha256File = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const walk = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
const sqlQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

type Manifest = { created_at: string; source_db: string; files: { path: string; bytes: number; sha256: string }[] };

export function createBackup(opts: { dataDir?: string; dbFile?: string; outRoot?: string } = {}) {
  const dbFile = opts.dbFile ?? config.dbFile;
  const dataDir = opts.dataDir ?? config.dataDir;
  const outRoot = opts.outRoot ?? process.env.BACKUP_DIR ?? path.resolve('backups');
  if (!fs.existsSync(dbFile)) throw new Error(`No database found at ${dbFile}.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outRoot, `alabatt-ces-${stamp}`);
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true, mode: 0o700 });

  // VACUUM INTO writes a consistent snapshot even while the server is running in WAL mode.
  const src = new DatabaseSync(dbFile);
  try {
    src.exec(`VACUUM INTO ${sqlQuote(path.join(dir, 'alabatt-ces.sqlite'))}`);
  } finally {
    src.close();
  }
  const uploads = path.join(dataDir, 'uploads');
  if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(dir, 'uploads'), { recursive: true });

  const files = walk(dir).map((f) => ({ path: path.relative(dir, f), bytes: fs.statSync(f).size, sha256: sha256File(f) }));
  const manifest: Manifest = { created_at: new Date().toISOString(), source_db: path.basename(dbFile), files };
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  for (const f of walk(dir)) fs.chmodSync(f, 0o600);
  return { dir, files: files.length };
}

export function verifyBackup(dir: string) {
  const mf = path.join(dir, 'MANIFEST.json');
  if (!fs.existsSync(mf)) throw new Error('MANIFEST.json is missing: this is not a backup folder.');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) as Manifest;
  for (const f of manifest.files) {
    const full = path.join(dir, f.path);
    if (!fs.existsSync(full)) throw new Error(`Missing file: ${f.path}`);
    if (sha256File(full) !== f.sha256) throw new Error(`Hash mismatch (file changed or corrupted): ${f.path}`);
  }
  const known = new Set(manifest.files.map((f) => f.path).concat('MANIFEST.json'));
  const extra = walk(dir).map((f) => path.relative(dir, f)).filter((p) => !known.has(p));
  if (extra.length) throw new Error(`Unexpected files not in the manifest: ${extra.join(', ')}`);
  const db = new DatabaseSync(path.join(dir, 'alabatt-ces.sqlite'), { readOnly: true });
  try {
    const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (r.integrity_check !== 'ok') throw new Error(`SQLite integrity_check failed: ${r.integrity_check}`);
  } finally {
    db.close();
  }
  return { files: manifest.files.length, created_at: manifest.created_at };
}

export function restoreBackup(dir: string, opts: { dataDir?: string; dbFile?: string; force?: boolean } = {}) {
  verifyBackup(dir); // never restore something that has not been verified
  const dbFile = opts.dbFile ?? config.dbFile;
  const dataDir = opts.dataDir ?? config.dataDir;
  const uploads = path.join(dataDir, 'uploads');
  const exists = fs.existsSync(dbFile) || (fs.existsSync(uploads) && fs.readdirSync(uploads).length > 0);
  if (exists && !opts.force) throw new Error(`Refusing to overwrite existing data in ${dataDir}. Stop the server and re-run with --force (the old data is moved aside, not deleted).`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (exists) {
    const aside = path.join(dataDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(aside, { mode: 0o700 });
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) if (fs.existsSync(f)) fs.renameSync(f, path.join(aside, path.basename(f)));
    if (fs.existsSync(uploads)) fs.renameSync(uploads, path.join(aside, 'uploads'));
  }
  fs.copyFileSync(path.join(dir, 'alabatt-ces.sqlite'), dbFile);
  fs.cpSync(path.join(dir, 'uploads'), uploads, { recursive: true });
  return { dbFile, uploads };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (args.includes('--verify')) {
      const dir = arg('--verify');
      if (!dir) throw new Error('Usage: --verify <backup-dir>');
      const r = verifyBackup(dir);
      console.log(`OK: ${r.files} files match the manifest and SQLite integrity_check passed (backup taken ${r.created_at}).`);
    } else if (args.includes('--restore')) {
      const dir = arg('--restore');
      if (!dir) throw new Error('Usage: --restore <backup-dir> [--force]');
      const r = restoreBackup(dir, { force: args.includes('--force') });
      console.log(`Restored database to ${r.dbFile} and uploads to ${r.uploads}. Start the server and sign in to confirm.`);
    } else {
      const r = createBackup();
      console.log(`Backup written to ${r.dir} (${r.files} files).`);
      console.log('It contains personal data and private documents: encrypt it and store it off this machine.');
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
