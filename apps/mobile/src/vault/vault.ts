import * as sodium from 'react-native-libsodium';
import { createVaultCrypto, PRF_SALT, type VaultCrypto } from '@cw/shared';
import { createPasskey, getPrfOutput } from './passkey';
import * as storage from './storage';

// The vault flows from ADR-001: create the vault, and recover the vault key with the passkey.

let vaultCrypto: VaultCrypto | undefined;
async function getVaultCrypto(): Promise<VaultCrypto> {
  await sodium.ready;
  return (vaultCrypto ??= createVaultCrypto(sodium));
}

const encode = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const decode = (text: string) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
const prfSalt = () => encode(new TextEncoder().encode(PRF_SALT));
const randomBase64Url = (bytes: number) => encode(sodium.randombytes_buf(bytes));

/**
 * A short, non-secret identifier of a vault key: the start of its signing public key.
 * Lets a person compare "before" and "after" a recovery without seeing the key.
 */
async function keyId(vaultKey: Uint8Array): Promise<string> {
  const { publicKey } = (await getVaultCrypto()).deriveSigningKeyPair(vaultKey);
  return sodium.to_hex(publicKey).slice(0, 8);
}

export interface VaultStatus {
  hasVaultKey: boolean;
  hasWrappedVaultKey: boolean;
  keyId: string | null;
}

export async function getVaultStatus(): Promise<VaultStatus> {
  const [vaultKey, wrapped] = await Promise.all([storage.loadVaultKey(), storage.loadWrappedVaultKey()]);
  return {
    hasVaultKey: vaultKey !== null,
    hasWrappedVaultKey: wrapped !== null,
    keyId: vaultKey ? await keyId(decode(vaultKey)) : null,
  };
}

/** New vault: a random vault key, wrapped with the passkey's PRF output (ADR-001). */
export async function createVault(): Promise<{ keyId: string; confirmations: 1 | 2 }> {
  const vc = await getVaultCrypto();
  if (await storage.loadVaultKey()) throw new Error('A vault already exists on this device');

  const vaultKey = vc.generateVaultKey();
  const created = await createPasskey(prfSalt(), randomBase64Url);
  const prfOutput = created.prfOutput ?? (await getPrfOutput(prfSalt(), randomBase64Url));
  const wrapped = vc.wrapVaultKey(vaultKey, vc.deriveWrappingKey(decode(prfOutput)));

  // The wrapped copy first: a vault key without a wrapped copy would be unrecoverable.
  await storage.saveWrappedVaultKey(wrapped);
  await storage.saveVaultKey(encode(vaultKey));
  return { keyId: await keyId(vaultKey), confirmations: created.prfOutput ? 1 : 2 };
}

/** Recovery: unwrap the stored copy with the passkey's PRF output, and keep the vault key on the device. */
export async function recoverVault(): Promise<{ keyId: string }> {
  const vc = await getVaultCrypto();
  const wrapped = await storage.loadWrappedVaultKey();
  if (!wrapped) throw new Error('No wrapped vault key on this device');

  const prfOutput = await getPrfOutput(prfSalt(), randomBase64Url);
  const vaultKey = vc.unwrapVaultKey(wrapped, vc.deriveWrappingKey(decode(prfOutput)));
  await storage.saveVaultKey(encode(vaultKey));
  return { keyId: await keyId(vaultKey) };
}

/** Development only: drops the vault key, as on a new phone. The wrapped copy stays. */
export const forgetVaultKey = () => storage.deleteVaultKey();

/** Development only: removes both keys from the device. The passkey stays in Google Password Manager. */
export async function resetLocalVault(): Promise<void> {
  await storage.deleteVaultKey();
  await storage.deleteWrappedVaultKey();
}
