import { requireNativeModule } from 'expo';

interface CredentialsModule {
  signInWithGoogle(webClientId: string): Promise<string>;
  hasPasskey(rpId: string, credentialId: string): Promise<boolean>;
}

const Credentials = requireNativeModule<CredentialsModule>('Credentials');

/** Google's account picker via Android Credential Manager; resolves to a Google ID token. */
export const signInWithGoogle = (webClientId: string) => Credentials.signInWithGoogle(webClientId);

/** Whether the passkey still exists, checked without any UI (decision 035). Android 14+. */
export const hasPasskey = (rpId: string, credentialId: string) => Credentials.hasPasskey(rpId, credentialId);
