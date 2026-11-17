import * as SecureStore from 'expo-secure-store';

// The vault key lives in expo-secure-store, backed by Android Keystore (ADR-001).
// It is deleted when the app is uninstalled (spike 01); recovery goes through the passkey.
const VAULT_KEY = 'vault_key';
// ponytail: the wrapped vault key is kept on the device only until the server stores it
// (sub-step 2). Until then it is deleted with the app, so recovery after reinstall cannot work yet.
const WRAPPED_VAULT_KEY = 'wrapped_vault_key';

export const loadVaultKey = () => SecureStore.getItemAsync(VAULT_KEY);
export const saveVaultKey = (encoded: string) => SecureStore.setItemAsync(VAULT_KEY, encoded);
export const deleteVaultKey = () => SecureStore.deleteItemAsync(VAULT_KEY);

export const loadWrappedVaultKey = () => SecureStore.getItemAsync(WRAPPED_VAULT_KEY);
export const saveWrappedVaultKey = (wrapped: string) => SecureStore.setItemAsync(WRAPPED_VAULT_KEY, wrapped);
export const deleteWrappedVaultKey = () => SecureStore.deleteItemAsync(WRAPPED_VAULT_KEY);
