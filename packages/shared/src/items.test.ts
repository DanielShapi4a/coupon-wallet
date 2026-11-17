import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  itemStates,
  ItemMetadata,
  openItem,
  sealItem,
  SealedItem,
  sortForWallet,
  walletSummary,
  type WalletItem,
} from './items.ts';
import { createVaultCrypto, type VaultCrypto } from './vault-crypto.ts';

// Every code here is fake, in the real format (CLAUDE.md).
let vc: VaultCrypto;
beforeAll(async () => {
  await sodium.ready;
  vc = createVaultCrypto(sodium);
});

const NOW = new Date('2026-11-17T10:00:00+02:00');
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000).toISOString();

const metadata = (over: Partial<ItemMetadata> = {}): ItemMetadata => ({
  merchant: 'Swish',
  value: { kind: 'stored_value', initialAgorot: 10_000, remainingAgorot: 10_000, lastVerifiedAt: null },
  status: 'active',
  usage: 'multi',
  channel: 'store',
  transferable: 'unknown',
  receivedFrom: 'Clalit',
  receivedAt: null,
  validFrom: null,
  validUntil: day(30),
  ...over,
});

const item = (over: Partial<WalletItem> = {}): WalletItem => ({
  id: '0b7c8a52-3f7e-4c1a-9d2b-5e6f7a8b9c0d',
  version: 1,
  metadata: metadata(),
  credential: { code: '0000-1111-2222-3333', pin: '000' },
  details: { notes: 'two cards from the employer' },
  ...over,
});

describe('sealItem / openItem', () => {
  it('round-trips an item, with the secrets sealed and the metadata in the clear', () => {
    const key = vc.generateVaultKey();
    const sealed = SealedItem.parse(sealItem(vc, key, item()));
    expect(sealed.metadata.merchant).toBe('Swish');
    expect(JSON.stringify(sealed)).not.toContain('0000-1111');
    expect(JSON.stringify(sealed)).not.toContain('employer');
    expect(openItem(vc, key, sealed)).toEqual(item());
  });

  it('a sealed credential cannot be moved to another item or field (AAD)', () => {
    const key = vc.generateVaultKey();
    const a = sealItem(vc, key, item());
    const b = sealItem(vc, key, item({ id: '1c8d9b63-4a8f-4d2b-8e3c-6f7a8b9c0d1e' }));
    expect(() => openItem(vc, key, { ...b, credential: a.credential })).toThrow('cannot be decrypted');
    expect(() => openItem(vc, key, { ...a, details: a.credential })).toThrow('cannot be decrypted');
  });

  it('rejects invalid metadata before sealing', () => {
    const key = vc.generateVaultKey();
    expect(() => sealItem(vc, key, item({ metadata: metadata({ merchant: '  ' }) }))).toThrow();
    expect(() =>
      sealItem(vc, key, item({ metadata: metadata({ value: { kind: 'percent_discount', percent: 0, maxPurchaseAgorot: null } }) })),
    ).toThrow();
  });
});

describe('itemStates (WAL-2)', () => {
  it('computes validity from the dates', () => {
    expect(itemStates(metadata({ validFrom: day(2) }), NOW)).toContain('not_yet_valid');
    expect(itemStates(metadata({ validUntil: day(3) }), NOW)).toContain('expiring_soon');
    expect(itemStates(metadata({ validUntil: day(-1) }), NOW)).toContain('expired');
    expect(itemStates(metadata({ validUntil: day(30) }), NOW)).toEqual([]);
    expect(itemStates(metadata({ validUntil: null }), NOW)).toEqual([]);
  });

  it('treats the expiry instant itself as expired', () => {
    expect(itemStates(metadata({ validUntil: NOW.toISOString() }), NOW)).toContain('expired');
  });

  it('computes the balance states', () => {
    const value = (remainingAgorot: number | null) =>
      metadata({ value: { kind: 'stored_value', initialAgorot: 10_000, remainingAgorot, lastVerifiedAt: null } });
    expect(itemStates(value(4_000), NOW)).toContain('partially_used');
    expect(itemStates(value(10_000), NOW)).not.toContain('partially_used');
    expect(itemStates(value(0), NOW)).not.toContain('partially_used');
    expect(itemStates(value(null), NOW)).toContain('balance_unknown');
  });
});

describe('sortForWallet (WAL-1)', () => {
  it('sorts by expiry, soonest first, with no expiry last', () => {
    const items = [
      { metadata: metadata({ merchant: 'none', validUntil: null }) },
      { metadata: metadata({ merchant: 'later', validUntil: day(20) }) },
      { metadata: metadata({ merchant: 'soon', validUntil: day(2) }) },
    ];
    expect(sortForWallet(items).map((i) => i.metadata.merchant)).toEqual(['soon', 'later', 'none']);
  });
});

describe('walletSummary (WAL-3)', () => {
  it('sums open stored value, counts unknown balances apart, and counts what expires this week', () => {
    const items = [
      { metadata: metadata({ validUntil: day(3) }) },
      { metadata: metadata({ value: { kind: 'stored_value', initialAgorot: 65_500, remainingAgorot: null, lastVerifiedAt: null } }) },
      { metadata: metadata({ value: { kind: 'fixed_discount', amountAgorot: 8_000, minPurchaseAgorot: null }, validUntil: day(1) }) },
      { metadata: metadata({ validUntil: day(-1) }) },
      { metadata: metadata({ status: 'used' }) },
    ];
    expect(walletSummary(items, NOW)).toEqual({ storedAgorot: 75_500, unknownBalances: 1, expiringThisWeek: 2 });
  });
});
