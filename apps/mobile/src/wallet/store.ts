import * as SQLite from 'expo-sqlite';
import { SealedItem } from '@cw/shared';

// The phone's copy of the wallet (local-first, decision 007). Items are kept sealed, in the same
// format as on the server, and opened only for display (architecture.md).
// Every change also adds an outbox row in the same transaction, so no change is lost if the app
// closes before it reaches the server (BAK-2).

const MIGRATIONS = [
  `CREATE TABLE items (
     id TEXT PRIMARY KEY NOT NULL,
     version INTEGER NOT NULL,
     deleted INTEGER NOT NULL,
     metadata TEXT NOT NULL,
     credential TEXT NOT NULL,
     details TEXT NOT NULL
   );
   CREATE TABLE outbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     item_id TEXT NOT NULL,
     version INTEGER NOT NULL
   );`,
];

let dbPromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function open(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('wallet.db');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  for (let v = row?.user_version ?? 0; v < MIGRATIONS.length; v++) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(MIGRATIONS[v]!);
      await db.execAsync(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

const getDb = () => (dbPromise ??= open());

interface ItemRow {
  id: string;
  version: number;
  deleted: number;
  metadata: string;
  credential: string;
  details: string;
}

const fromRow = (r: ItemRow): SealedItem =>
  SealedItem.parse({
    id: r.id,
    version: r.version,
    deleted: r.deleted === 1,
    metadata: JSON.parse(r.metadata),
    credential: r.credential,
    details: r.details,
  });

const upsert = (db: SQLite.SQLiteDatabase, item: SealedItem) =>
  db.runAsync(
    'INSERT OR REPLACE INTO items (id, version, deleted, metadata, credential, details) VALUES (?, ?, ?, ?, ?, ?)',
    item.id,
    item.version,
    item.deleted ? 1 : 0,
    JSON.stringify(item.metadata),
    item.credential,
    item.details,
  );

/** Saves a change and queues it for the server, in one transaction. */
export async function saveItem(item: SealedItem): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await upsert(db, item);
    await db.runAsync('INSERT INTO outbox (item_id, version) VALUES (?, ?)', item.id, item.version);
  });
}

export async function listItems(): Promise<SealedItem[]> {
  const rows = await (await getDb()).getAllAsync<ItemRow>('SELECT * FROM items WHERE deleted = 0');
  return rows.map(fromRow);
}

/** Includes deleted items: the outbox still has to send their deletion. */
export async function getItem(id: string): Promise<SealedItem | null> {
  const row = await (await getDb()).getFirstAsync<ItemRow>('SELECT * FROM items WHERE id = ?', id);
  return row ? fromRow(row) : null;
}

/** The latest queued version of each changed item. */
export async function pendingChanges(): Promise<{ itemId: string; version: number }[]> {
  return (await getDb()).getAllAsync<{ itemId: string; version: number }>(
    'SELECT item_id AS itemId, MAX(version) AS version FROM outbox GROUP BY item_id ORDER BY MIN(seq)',
  );
}

export async function markSent(itemId: string, version: number): Promise<void> {
  await (await getDb()).runAsync('DELETE FROM outbox WHERE item_id = ? AND version <= ?', itemId, version);
}

/** Recovery on a new or reinstalled phone: the server's copy becomes the local wallet. */
export async function replaceAll(items: SealedItem[]): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM items');
    for (const item of items) await upsert(db, item);
  });
}

/** Account deletion (AUTH-6): the local wallet goes too. The rows are sealed, and the vault key is deleted with them. */
export async function wipe(): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM items');
    await db.runAsync('DELETE FROM outbox');
  });
}

export async function countPending(): Promise<number> {
  const row = await (await getDb()).getFirstAsync<{ n: number }>('SELECT COUNT(DISTINCT item_id) AS n FROM outbox');
  return row?.n ?? 0;
}
