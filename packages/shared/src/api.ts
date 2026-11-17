import { z } from 'zod';

// Request and response bodies shared by the server and the app.

const base64Url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

export const GoogleSignInRequest = z.object({ idToken: z.string().min(1).max(4096) });
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequest>;

export const RefreshRequest = z.object({ refreshToken: base64Url(64) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const AuthTokens = z.object({ accessToken: z.string(), refreshToken: z.string() });
export type AuthTokens = z.infer<typeof AuthTokens>;

/** What the server keeps of a vault (ADR-001): nothing it can decrypt. */
export const Vault = z.object({
  // Version byte, 24-byte nonce, 32-byte key and 16-byte tag: 73 bytes, 98 characters in base64url.
  wrappedVaultKey: base64Url(200),
  // Ed25519 public key, 32 bytes (decision 033).
  signingPublicKey: base64Url(43).length(43),
  // WebAuthn allows credential IDs up to 1023 bytes.
  passkeyCredentialId: base64Url(1400),
});
export type Vault = z.infer<typeof Vault>;
