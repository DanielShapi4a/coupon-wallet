import { requireNativeModule } from 'expo';

interface CredentialsModule {
  signInWithGoogle(webClientId: string): Promise<string>;
}

const Credentials = requireNativeModule<CredentialsModule>('Credentials');

/** Google's account picker via Android Credential Manager; resolves to a Google ID token. */
export const signInWithGoogle = (webClientId: string) => Credentials.signInWithGoogle(webClientId);
