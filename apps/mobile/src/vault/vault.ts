import * as sodium from 'react-native-libsodium';
import {
  Challenge,
  confirmPasskeyCheck,
  createVaultCrypto,
  deleteAccountMessage,
  PRF_SALT,
  replacePasskeyMessage,
  Vault,
  type ChallengePurpose,
  type ChallengeRequest,
  type DeleteAccountRequest,
  type PasskeyCheck,
  type VaultCrypto,
} from '@cw/shared';
import { hasPasskey } from '../../modules/credentials';
import { apiFetch, ApiError, dropLocalSession } from '../api/client';
import { wipe as wipeWallet } from '../wallet/store';
import { createPasskey, getPrfOutput, RP_ID } from './passkey';
import * as storage from './storage';

// The vault flows from ADR-001: create the vault, recover the vault key with the passkey, and
// repair the backup when the passkey was deleted (decision 035).
// The server keeps the wrapped vault key, the signing public key and the passkey's credential ID.

let vaultCrypto: VaultCrypto | undefined;
export async function getVaultCrypto(): Promise<VaultCrypto> {
  await sodium.ready;
  return (vaultCrypto ??= createVaultCrypto(sodium));
}

/** The vault key from this phone's secure storage, for sealing and opening items. */
export async function requireVaultKey(): Promise<Uint8Array> {
  const stored = await storage.loadVaultKey();
  if (!stored) throw new Error('No vault on this phone: create or recover the vault first');
  return sodium.from_base64(stored, sodium.base64_variants.URLSAFE_NO_PADDING);
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
 * 'unknown' means there is nothing to check yet (no vault key on this phone, or no passkey ID), or
 * that the passkey was found missing but not yet confirmed: a passkey created moments ago is not
 * visible to the check yet, so 'missing' needs a second miss 10 minutes later (confirmPasskeyCheck).
 */
export async function checkPasskey(): Promise<PasskeyCheck> {
  const [vaultKey, credentialId] = await Promise.all([storage.loadVaultKey(), storage.loadPasskeyCredentialId()]);
  if (!vaultKey || !credentialId) return 'unknown';
  const found = await hasPasskey(RP_ID, credentialId);
  const { result, missingSince } = confirmPasskeyCheck(found, await storage.loadPasskeyMissingSince(), Date.now());
  await storage.savePasskeyMissingSince(missingSince);
  return result;
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

  const { challengeId, challenge } = await getChallenge('replace_passkey');
  const signature = vc.signWithVaultKey(vaultKey, replacePasskeyMessage({ challenge, ...content }));

  const res = await apiFetch('/vault/passkey', {
    method: 'PUT',
    body: JSON.stringify({ challengeId, ...content, signature }),
  });
  if (!res.ok) throw new ApiError(res.status, 'The server did not accept the new passkey');
  await storage.savePasskeyCredentialId(created.credentialId);
  return { keyId: await keyId(vaultKey) };
}

/** A one-time challenge for an action the vault key must sign (decision 033). */
async function getChallenge(purpose: ChallengePurpose): Promise<Challenge> {
  const body: ChallengeRequest = { purpose };
  const res = await apiFetch('/vault/challenge', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, 'Could not get a challenge from the server');
  return Challenge.parse(await res.json());
}

/**
 * AUTH-6 (decision 043): deletes the account on the server first, then everything on this phone, so a
 * failure on the server leaves the phone as it was. With a vault, the server needs the vault key's
 * signature over a one-time challenge (decision 033). The caller confirms with the person and
 * authenticates the phone before calling this.
 */
export async function deleteAccount(): Promise<void> {
  const stored = await storage.loadVaultKey();
  // An empty JSON object when there is no vault key: Fastify rejects an empty body sent as application/json.
  let body = '{}';
  if (stored) {
    const { challengeId, challenge } = await getChallenge('delete_account');
    const signature = (await getVaultCrypto()).signWithVaultKey(decode(stored), deleteAccountMessage(challenge));
    body = JSON.stringify({ challengeId, signature } satisfies DeleteAccountRequest);
  }
  const res = await apiFetch('/account', { method: 'DELETE', body });
  // The account has a vault, but this phone does not hold its key.
  if (res.status === 400) throw new Error('Recover the vault on this phone first, then delete the account');
  if (res.status !== 204) throw new ApiError(res.status, 'The server did not delete the account');

  await wipeWallet();
  await storage.deleteVaultKey();
  await storage.deletePasskeyCredentialId();
  await dropLocalSession();
}

/** Development only: drops the vault key from this phone, as after a reinstall. */
export const forgetVaultKey = () => storage.deleteVaultKey();
