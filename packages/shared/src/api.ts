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

/** A one-time challenge for an action that needs proof of holding the vault key (decision 033). */
export const Challenge = z.object({ challengeId: z.uuid(), challenge: base64Url(64) });
export type Challenge = z.infer<typeof Challenge>;

/** Self-repair (decision 035): the same vault key, wrapped with a new passkey, signed with the vault key. */
export const ReplacePasskeyRequest = z.object({
  challengeId: z.uuid(),
  wrappedVaultKey: Vault.shape.wrappedVaultKey,
  passkeyCredentialId: Vault.shape.passkeyCredentialId,
  // Ed25519 signature, 64 bytes.
  signature: base64Url(86).length(86),
});
export type ReplacePasskeyRequest = z.infer<typeof ReplacePasskeyRequest>;

/**
 * What the app signs to replace the vault's passkey. It covers the challenge and the new content
 * together, so a captured signature cannot be replayed or attached to other content.
 */
export const replacePasskeyMessage = (r: { challenge: string; wrappedVaultKey: string; passkeyCredentialId: string }) =>
  ['cw-replace-passkey-v1', r.challenge, r.wrappedVaultKey, r.passkeyCredentialId].join('|');

/** What a challenge is for. Each purpose also signs its own message, so one cannot stand in for another. */
export const ChallengePurpose = z.enum(['replace_passkey', 'delete_account']);
export type ChallengePurpose = z.infer<typeof ChallengePurpose>;
export const ChallengeRequest = z.object({ purpose: ChallengePurpose });
export type ChallengeRequest = z.infer<typeof ChallengeRequest>;

/** Account deletion from the app (AUTH-6, decision 043): the vault key signs a one-time challenge. */
export const DeleteAccountRequest = z.object({ challengeId: z.uuid(), signature: ReplacePasskeyRequest.shape.signature });
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;
export const deleteAccountMessage = (challenge: string) => ['cw-delete-account-v1', challenge].join('|');
