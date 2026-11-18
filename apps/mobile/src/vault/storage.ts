import * as SecureStore from 'expo-secure-store';

// The vault key lives in expo-secure-store, backed by Android Keystore (ADR-001).
// It is deleted when the app is uninstalled (spike 01); recovery goes through the passkey
// and the wrapped copy on the server.
const VAULT_KEY = 'vault_key';
// The vault passkey's ID, kept here too so the silent check (decision 035) works offline. Not a secret.
const PASSKEY_CREDENTIAL_ID = 'passkey_credential_id';

export const loadVaultKey = () => SecureStore.getItemAsync(VAULT_KEY);
export const saveVaultKey = (encoded: string) => SecureStore.setItemAsync(VAULT_KEY, encoded);
export const deleteVaultKey = () => SecureStore.deleteItemAsync(VAULT_KEY);

// When the silent check first found the passkey missing (decision 035). A new passkey starts over.
const PASSKEY_MISSING_SINCE = 'passkey_missing_since';

export const loadPasskeyCredentialId = () => SecureStore.getItemAsync(PASSKEY_CREDENTIAL_ID);
export async function savePasskeyCredentialId(id: string): Promise<void> {
  await SecureStore.setItemAsync(PASSKEY_CREDENTIAL_ID, id);
  await SecureStore.deleteItemAsync(PASSKEY_MISSING_SINCE);
}
export async function deletePasskeyCredentialId(): Promise<void> {
  await SecureStore.deleteItemAsync(PASSKEY_CREDENTIAL_ID);
  await SecureStore.deleteItemAsync(PASSKEY_MISSING_SINCE);
}

export async function loadPasskeyMissingSince(): Promise<number | null> {
  const stored = await SecureStore.getItemAsync(PASSKEY_MISSING_SINCE);
  return stored ? Number(stored) : null;
}
export const savePasskeyMissingSince = (since: number | null) =>
  since === null ? SecureStore.deleteItemAsync(PASSKEY_MISSING_SINCE) : SecureStore.setItemAsync(PASSKEY_MISSING_SINCE, String(since));
