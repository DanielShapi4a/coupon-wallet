import * as sodium from 'react-native-libsodium';
import { Challenge, createVaultCrypto, PRF_SALT, replacePasskeyMessage, Vault, type VaultCrypto } from '@cw/shared';
import { hasPasskey } from '../../modules/credentials';
import { apiFetch, ApiError } from '../api/client';
import { createPasskey, getPrfOutput, RP_ID } from './passkey';
import * as storage from './storage';

// The vault flows from ADR-001: create the vault, recover the vault key with the passkey, and
// repair the backup when the passkey was deleted (decision 035).
// The server keeps the wrapped vault key, the signing public key and the passkey's credential ID.

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

async function fetchServerVault(): Promise<Vault | null> {
  const res = await apiFetch('/vault');
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, 'Could not read the vault from the server');
  return Vault.parse(await res.json());
}

export interface VaultStatus {
  hasVaultKey: boolean;
  keyId: string | null;
}

export async function getVaultStatus(): Promise<VaultStatus> {
  const vaultKey = await storage.loadVaultKey();
  return { hasVaultKey: vaultKey !== null, keyId: vaultKey ? await keyId(decode(vaultKey)) : null };
}

/** Whether the signed-in user already has a vault on the server. */
export const hasServerVault = async () => (await fetchServerVault()) !== null;

/** New vault: a random vault key, wrapped with the passkey's PRF output and stored on the server (ADR-001). */
export async function createVault(): Promise<{ keyId: string; confirmations: 1 | 2 }> {
  const vc = await getVaultCrypto();
  if (await storage.loadVaultKey()) throw new Error('A vault already exists on this device');
  if (await hasServerVault()) throw new Error('This account already has a vault: recover it instead');

  const vaultKey = vc.generateVaultKey();
  const created = await createPasskey(prfSalt(), randomBase64Url);
  const prfOutput = created.prfOutput ?? (await getPrfOutput(prfSalt(), randomBase64Url, created.credentialId));
  const vault: Vault = {
    wrappedVaultKey: vc.wrapVaultKey(vaultKey, vc.deriveWrappingKey(decode(prfOutput))),
    signingPublicKey: encode(vc.deriveSigningKeyPair(vaultKey).publicKey),
    passkeyCredentialId: created.credentialId,
  };

  // The server copy first: a vault key that exists only on this phone would be lost with it.
  const res = await apiFetch('/vault', { method: 'PUT', body: JSON.stringify(vault) });
  if (res.status !== 201) throw new ApiError(res.status, 'The server did not store the vault');
  await storage.saveVaultKey(encode(vaultKey));
  await storage.savePasskeyCredentialId(created.credentialId);
  return { keyId: await keyId(vaultKey), confirmations: created.prfOutput ? 1 : 2 };
}

/** Recovery on a new or reinstalled phone: unwrap the server copy with the passkey's PRF output. */
export async function recoverVault(): Promise<{ keyId: string }> {
  const vc = await getVaultCrypto();
  const vault = await fetchServerVault();
  if (!vault) throw new Error('This account has no vault on the server');

  const prfOutput = await getPrfOutput(prfSalt(), randomBase64Url, vault.passkeyCredentialId);
  const vaultKey = vc.unwrapVaultKey(vault.wrappedVaultKey, vc.deriveWrappingKey(decode(prfOutput)));
  // The unwrapped key must match the public key the server holds for this vault.
  if (encode(vc.deriveSigningKeyPair(vaultKey).publicKey) !== vault.signingPublicKey) {
    throw new Error('The recovered key does not match this vault');
  }
  await storage.saveVaultKey(encode(vaultKey));
  await storage.savePasskeyCredentialId(vault.passkeyCredentialId);
  return { keyId: await keyId(vaultKey) };
}

/**
 * Decision 035, layer 2: is the vault's passkey still there? Checked without any UI.
 * 'unknown' means there is nothing to check yet (no vault key on this phone, or no passkey ID).
 */
export async function checkPasskey(): Promise<'present' | 'missing' | 'unknown'> {
  const [vaultKey, credentialId] = await Promise.all([storage.loadVaultKey(), storage.loadPasskeyCredentialId()]);
  if (!vaultKey || !credentialId) return 'unknown';
  return (await hasPasskey(RP_ID, credentialId)) ? 'present' : 'missing';
}

/**
 * Decision 035, layer 3: self-repair. A new passkey wraps the same vault key, and the server
 * replaces its copy only with a signature by the vault key over a one-time challenge (decision 033).
 */
export async function repairPasskey(): Promise<{ keyId: string }> {
  const vc = await getVaultCrypto();
  const stored = await storage.loadVaultKey();
  if (!stored) throw new Error('No vault key on this phone: nothing to repair, recover instead');
  const vaultKey = decode(stored);

  const created = await createPasskey(prfSalt(), randomBase64Url);
  const prfOutput = created.prfOutput ?? (await getPrfOutput(prfSalt(), randomBase64Url, created.credentialId));
  const content = {
    wrappedVaultKey: vc.wrapVaultKey(vaultKey, vc.deriveWrappingKey(decode(prfOutput))),
    passkeyCredentialId: created.credentialId,
  };

  // An empty JSON object: Fastify rejects an empty body sent as application/json.
  const challengeRes = await apiFetch('/vault/challenge', { method: 'POST', body: '{}' });
  if (!challengeRes.ok) throw new ApiError(challengeRes.status, 'Could not get a challenge from the server');
  const { challengeId, challenge } = Challenge.parse(await challengeRes.json());
  const signature = vc.signWithVaultKey(vaultKey, replacePasskeyMessage({ challenge, ...content }));

  const res = await apiFetch('/vault/passkey', {
    method: 'PUT',
    body: JSON.stringify({ challengeId, ...content, signature }),
  });
  if (!res.ok) throw new ApiError(res.status, 'The server did not accept the new passkey');
  await storage.savePasskeyCredentialId(created.credentialId);
  return { keyId: await keyId(vaultKey) };
}

/** Development only: drops the vault key from this phone, as after a reinstall. */
export const forgetVaultKey = () => storage.deleteVaultKey();
