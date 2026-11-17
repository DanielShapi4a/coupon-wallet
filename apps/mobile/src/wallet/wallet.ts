import * as sodium from 'react-native-libsodium';
import {
  openItem,
  SealedItem,
  sealItem,
  sortForWallet,
  uuidV4,
  type ItemCredential,
  type ItemDetails,
  type ItemMetadata,
  type WalletItem,
} from '@cw/shared';
import { apiFetch, isSignedIn } from '../api/client';
import { getVaultCrypto, requireVaultKey } from '../vault/vault';
import * as store from './store';

// Wallet operations: every change is sealed with the vault key, saved locally with an outbox
// entry, and then sent to the server in the background (BAK-1, BAK-2).

async function save(item: WalletItem, deleted = false): Promise<void> {
  const sealed = sealItem(await getVaultCrypto(), await requireVaultKey(), item, deleted);
  await store.saveItem(sealed);
  void syncNow().catch(() => undefined); // offline is fine: the outbox keeps it
}

async function open(sealed: SealedItem): Promise<WalletItem> {
  return openItem(await getVaultCrypto(), await requireVaultKey(), sealed);
}

export async function addItem(input: { metadata: ItemMetadata; credential: ItemCredential; details: ItemDetails }) {
  const item: WalletItem = { id: uuidV4(sodium.randombytes_buf(16)), version: 1, ...input };
  await save(item);
  return item.id;
}

/** Saves an edited item as a new version. */
export async function updateItem(item: WalletItem): Promise<void> {
  await save({ ...item, version: item.version + 1 });
}

export async function deleteItem(id: string): Promise<void> {
  const item = await getWalletItem(id);
  if (item) await save({ ...item, version: item.version + 1 }, true);
}

export async function getWalletItem(id: string): Promise<WalletItem | null> {
  const sealed = await store.getItem(id);
  return sealed && !sealed.deleted ? open(sealed) : null;
}

/** Every live item, opened, in wallet order (WAL-1). */
export async function listWallet(): Promise<WalletItem[]> {
  const items = await Promise.all((await store.listItems()).map(open));
  return sortForWallet(items);
}

let syncing: Promise<{ sent: number; pending: number }> | undefined;

/** Sends queued changes to the server. One run at a time; what fails stays queued for next time. */
export function syncNow(): Promise<{ sent: number; pending: number }> {
  return (syncing ??= (async () => {
    try {
      let sent = 0;
      if (await isSignedIn()) {
        for (const { itemId, version } of await store.pendingChanges()) {
          const item = await store.getItem(itemId);
          if (!item) {
            await store.markSent(itemId, version);
            continue;
          }
          const res = await apiFetch(`/items/${itemId}`, { method: 'PUT', body: JSON.stringify(item) });
          // 409: the server already has a newer version. With a single writer this should not happen; stop resending.
          if (res.ok || res.status === 409) {
            await store.markSent(itemId, item.version);
            sent++;
          } else {
            break;
          }
        }
      }
      return { sent, pending: await store.countPending() };
    } finally {
      syncing = undefined;
    }
  })());
}

/** After recovering the vault on a new or reinstalled phone: the server's items become the local wallet. */
export async function restoreFromServer(): Promise<number> {
  const res = await apiFetch('/items');
  if (!res.ok) throw new Error(`Could not read the items from the server (${res.status})`);
  const items = SealedItem.array().parse(await res.json());
  // Open each one before replacing anything: a wrong vault key must not wipe the local wallet.
  await Promise.all(items.map(open));
  await store.replaceAll(items);
  return items.length;
}
