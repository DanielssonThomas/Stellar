import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const schemaVersion = 1;
export const retentionDays = 180;
const applicationId = 0x53544549;
const migrations = ['001-tables.sql', '001-views.sql'].map(
  (file) => new URL(`./migrations/${file}`, import.meta.url),
);

export function defaultDatabasePath() {
  const home = os.homedir();
  const root =
    process.platform === 'win32'
      ? path.join(
          process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
          'Stellar',
        )
      : path.join(
          process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'),
          'stellar',
        );
  return path.join(root, 'engineering-intelligence.sqlite');
}

export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(
  dbPath = defaultDatabasePath(),
  { readOnly = false } = {},
) {
  if (!readOnly && dbPath !== ':memory:')
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    db.exec(
      'PRAGMA busy_timeout = 100; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF',
    );
    const identity = () => [
      db.prepare('PRAGMA application_id').get().application_id,
      db.prepare('PRAGMA user_version').get().user_version,
    ];
    const [id, version] = identity();
    if (!readOnly && id === 0 && version === 0) {
      transaction(db, () => {
        const [currentId, currentVersion] = identity();
        if (currentId === applicationId && currentVersion === schemaVersion)
          return;
        if (
          currentId !== 0 ||
          currentVersion !== 0 ||
          db
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
            )
            .get()
        ) {
          throw new Error('Unrecognized engineering database');
        }
        for (const file of migrations) db.exec(readFileSync(file, 'utf8'));
        db.exec(
          `PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${schemaVersion}`,
        );
      });
    } else if (id !== applicationId || version !== schemaVersion) {
      throw new Error('Unsupported engineering database version');
    }
    if (readOnly) {
      db.exec('PRAGMA query_only = ON');
    } else {
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
        PRAGMA wal_autocheckpoint = 512; PRAGMA journal_size_limit = 4194304;
        PRAGMA max_page_count = 32768`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withDatabase(dbPath, operation, options) {
  const db = openDatabase(dbPath, options);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

export function maintainDatabase(dbPath, now = new Date()) {
  const cutoff = new Date(
    now.getTime() - retentionDays * 86_400_000,
  ).toISOString();
  return withDatabase(dbPath, (db) => {
    const removed = transaction(db, () => {
      db.prepare(
        `INSERT INTO retired_sessions
        SELECT id, issue_number, observed_tokens, usage_complete FROM engineering_sessions
        WHERE issue_number IS NOT NULL AND id IN (
          SELECT id FROM sessions WHERE last_seen_at < ? ORDER BY last_seen_at, id LIMIT 500
        ) ON CONFLICT DO NOTHING`,
      ).run(cutoff);
      const sessions = db
        .prepare(
          `DELETE FROM sessions WHERE id IN (
        SELECT id FROM sessions WHERE last_seen_at < ? ORDER BY last_seen_at, id LIMIT 500
      )`,
        )
        .run(cutoff).changes;
      const allowance = db
        .prepare(
          `DELETE FROM allowance_observations WHERE
        (source, window_minutes, resets_at, observed_at) IN (
          SELECT source, window_minutes, resets_at, observed_at
          FROM allowance_observations WHERE observed_at < ? LIMIT 500
        )`,
        )
        .run(cutoff).changes;
      const signatures = db
        .prepare(
          `DELETE FROM failures WHERE fingerprint IN (
        SELECT fingerprint FROM failures f
        WHERE NOT EXISTS (SELECT 1 FROM attempts a WHERE a.fingerprint = f.fingerprint)
          AND NOT EXISTS (SELECT 1 FROM intervention_failures i WHERE i.fingerprint = f.fingerprint)
        LIMIT 500
      )`,
        )
        .run().changes;
      return { sessions, allowance, signatures };
    });
    db.exec('PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE)');
    return removed;
  });
}
