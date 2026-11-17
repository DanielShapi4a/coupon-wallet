import { OAuth2Client } from 'google-auth-library';

/** Verifies a Google ID token and returns the stable Google account ID (`sub`), or null. */
export type VerifyGoogleIdToken = (idToken: string) => Promise<string | null>;

export function googleIdTokenVerifier(webClientId: string): VerifyGoogleIdToken {
  const client = new OAuth2Client();
  return async (idToken) => {
    try {
      // Checks the signature against Google's keys, the expiry, the issuer and the audience.
      const ticket = await client.verifyIdToken({ idToken, audience: webClientId });
      return ticket.getPayload()?.sub ?? null;
    } catch {
      return null;
    }
  };
}
