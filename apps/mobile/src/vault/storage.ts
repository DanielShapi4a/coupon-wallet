import * as SecureStore from 'expo-secure-store';

// The vault key lives in expo-secure-store, backed by Android Keystore (ADR-001).
// It is deleted when the app is uninstalled (spike 01); recovery goes through the passkey
// and the wrapped copy on the server.
const VAULT_KEY = 'vault_key';

export const loadVaultKey = () => SecureStore.getItemAsync(VAULT_KEY);
export const saveVaultKey = (encoded: string) => SecureStore.setItemAsync(VAULT_KEY, encoded);
export const deleteVaultKey = () => SecureStore.deleteItemAsync(VAULT_KEY);
