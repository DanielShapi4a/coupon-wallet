import { z } from 'zod';
import type { VaultCrypto } from './vault-crypto.ts';

// The wallet item (domain-model.md). Decision 006 splits it in two:
// - metadata the server can read (merchant, value, dates, status, source), so it can send reminders;
// - secrets encrypted on the phone: the redemption details and every free-text field.
// Amounts are whole agorot, so money never goes through floating point.

const agorot = z.number().int().nonnegative().max(100_000_000);
const instant = z.iso.datetime({ offset: true });

/** Exactly one kind of value (domain model). A benefit's description is free text, so it is in the secrets. */
export const ItemValue = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stored_value'),
    initialAgorot: agorot,
    // Unknown is legitimate: never guessed (domain model).
    remainingAgorot: agorot.nullable(),
    lastVerifiedAt: instant.nullable(),
  }),
  z.object({ kind: z.literal('fixed_discount'), amountAgorot: agorot, minPurchaseAgorot: agorot.nullable() }),
  z.object({ kind: z.literal('percent_discount'), percent: z.number().gt(0).max(100), maxPurchaseAgorot: agorot.nullable() }),
  z.object({ kind: z.literal('item_benefit') }),
]);
export type ItemValue = z.infer<typeof ItemValue>;

/** What the server can read (decision 006). */
export const ItemMetadata = z.object({
  merchant: z.string().trim().min(1).max(100),
  value: ItemValue,
  status: z.enum(['draft', 'active', 'used', 'shared', 'archived']),
  usage: z.enum(['single', 'multi']),
  channel: z.enum(['store', 'online', 'both']).nullable(),
  transferable: z.enum(['yes', 'no', 'unknown']),
  receivedFrom: z.string().trim().max(100).nullable(),
  receivedAt: instant.nullable(),
  // A point in time, not just a date (domain model).
  validFrom: instant.nullable(),
  validUntil: instant.nullable(),
});
export type ItemMetadata = z.infer<typeof ItemMetadata>;

/** How to redeem: every part optional, all of it secret (domain model). */
export const ItemCredential = z.object({
  code: z.string().max(500).optional(),
  pin: z.string().max(50).optional(),
  barcode: z.object({ payload: z.string().max(2000), symbology: z.string().max(30) }).optional(),
  link: z.string().max(2000).optional(),
});
export type ItemCredential = z.infer<typeof ItemCredential>;

/** Free text: users type codes into it, so it is encrypted too (decision 006). */
export const ItemDetails = z.object({
  title: z.string().max(200).optional(),
  benefitDescription: z.string().max(500).optional(),
  notes: z.string().max(5000).optional(),
  terms: z.string().max(5000).optional(),
  originalMessage: z.string().max(10000).optional(),
});
export type ItemDetails = z.infer<typeof ItemDetails>;

/** An item as the phone holds it, decrypted. */
export interface WalletItem {
  id: string;
  version: number;
  metadata: ItemMetadata;
  credential: ItemCredential;
  details: ItemDetails;
}

const ciphertext = z.string().regex(/^[A-Za-z0-9_-]+$/).max(30_000);

/** An item as it travels and as the server stores it: metadata in the clear, secrets sealed. */
export const SealedItem = z.object({
  id: z.uuid(),
  // Grows with every change; the server keeps only newer versions (architecture.md).
  version: z.number().int().positive(),
  deleted: z.boolean(),
  metadata: ItemMetadata,
  credential: ciphertext,
  details: ciphertext,
});
export type SealedItem = z.infer<typeof SealedItem>;

// AAD field names: a sealed part opens only as the same part of the same item (ADR-001).
const CREDENTIAL_FIELD = 'credential';
const DETAILS_FIELD = 'details';

export function sealItem(vc: VaultCrypto, vaultKey: Uint8Array, item: WalletItem, deleted = false): SealedItem {
  return {
    id: item.id,
    version: item.version,
    deleted,
    metadata: ItemMetadata.parse(item.metadata),
    credential: vc.encryptField(vaultKey, item.id, CREDENTIAL_FIELD, JSON.stringify(ItemCredential.parse(item.credential))),
    details: vc.encryptField(vaultKey, item.id, DETAILS_FIELD, JSON.stringify(ItemDetails.parse(item.details))),
  };
}

export function openItem(vc: VaultCrypto, vaultKey: Uint8Array, sealed: SealedItem): WalletItem {
  return {
    id: sealed.id,
    version: sealed.version,
    metadata: sealed.metadata,
    credential: ItemCredential.parse(JSON.parse(vc.decryptField(vaultKey, sealed.id, CREDENTIAL_FIELD, sealed.credential))),
    details: ItemDetails.parse(JSON.parse(vc.decryptField(vaultKey, sealed.id, DETAILS_FIELD, sealed.details))),
  };
}

// --- Derived states (WAL-2). Facts are stored; states are computed from them (domain model). ---

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Expiring soon" and "expires this week" (WAL-3) share one window. */
export const EXPIRING_SOON_DAYS = 7;

export type ItemState = 'not_yet_valid' | 'expiring_soon' | 'expired' | 'partially_used' | 'balance_unknown';

export function itemStates(m: ItemMetadata, now: Date): ItemState[] {
  const states: ItemState[] = [];
  const t = now.getTime();
  if (m.validFrom && t < Date.parse(m.validFrom)) states.push('not_yet_valid');
  if (m.validUntil) {
    const until = Date.parse(m.validUntil);
    if (t >= until) states.push('expired');
    else if (until - t <= EXPIRING_SOON_DAYS * DAY_MS) states.push('expiring_soon');
  }
  if (m.value.kind === 'stored_value') {
    const { remainingAgorot, initialAgorot } = m.value;
    if (remainingAgorot === null) states.push('balance_unknown');
    else if (remainingAgorot > 0 && remainingAgorot < initialAgorot) states.push('partially_used');
  }
  return states;
}

const isOpen = (m: ItemMetadata) => m.status === 'active' || m.status === 'draft';

/** WAL-1: by expiry, soonest first; items without an expiry go last. */
export function sortForWallet<T extends { metadata: ItemMetadata }>(items: T[]): T[] {
  const key = (m: ItemMetadata) => (m.validUntil ? Date.parse(m.validUntil) : Number.POSITIVE_INFINITY);
  return [...items].sort((a, b) => key(a.metadata) - key(b.metadata) || a.metadata.merchant.localeCompare(b.metadata.merchant));
}

/**
 * WAL-3: the stored value still usable (discounts are not counted), and how many open items
 * expire within the week. Unknown balances count at their initial value, and are reported apart.
 */
export function walletSummary(items: { metadata: ItemMetadata }[], now: Date) {
  let storedAgorot = 0;
  let unknownBalances = 0;
  let expiringThisWeek = 0;
  for (const { metadata: m } of items) {
    if (!isOpen(m)) continue;
    const states = itemStates(m, now);
    if (states.includes('expired')) continue;
    if (states.includes('expiring_soon')) expiringThisWeek++;
    if (m.value.kind === 'stored_value') {
      storedAgorot += m.value.remainingAgorot ?? m.value.initialAgorot;
      if (m.value.remainingAgorot === null) unknownBalances++;
    }
  }
  return { storedAgorot, unknownBalances, expiringThisWeek };
}
