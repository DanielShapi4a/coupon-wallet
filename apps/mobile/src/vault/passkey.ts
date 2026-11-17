import * as Passkeys from 'react-native-passkeys';

// Until the product domain is chosen (decision 036), passkeys are bound to the GitHub Pages site
// that serves assetlinks.json for this app.
const RP_ID = 'danielshapi4a.github.io';

// Decision 035: the name is the warning. It shows in Google Password Manager, where the passkey can be deleted.
export const PASSKEY_NAME = 'Coupon Wallet key — do not delete';

/** Random bytes as base64url. Passed in from libsodium: Hermes has no Web Crypto (assumption). */
type RandomBase64Url = (bytes: number) => string;

/**
 * Creates the vault passkey with the PRF extension. Asks for the PRF output at creation too;
 * returns it when the authenticator supports that, so setup needs one confirmation instead of two.
 */
export async function createPasskey(
  prfSalt: string,
  randomBase64Url: RandomBase64Url,
): Promise<{ prfOutput: string | null }> {
  const result = await Passkeys.create({
    challenge: randomBase64Url(32),
    rp: { id: RP_ID, name: 'Coupon Wallet' },
    user: { id: randomBase64Url(16), name: PASSKEY_NAME, displayName: PASSKEY_NAME },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf: { eval: { first: prfSalt } } },
  });
  if (!result) throw new Error('The passkey was not created');
  const prf = result.clientExtensionResults.prf;
  if (!prf?.enabled) throw new Error('This passkey provider does not support PRF');
  return { prfOutput: prf.results?.first ?? null };
}

/** Asks the user to confirm with the vault passkey, and returns its PRF output for the fixed salt. */
export async function getPrfOutput(prfSalt: string, randomBase64Url: RandomBase64Url): Promise<string> {
  const result = await Passkeys.get({
    challenge: randomBase64Url(32),
    rpId: RP_ID,
    userVerification: 'required',
    extensions: { prf: { eval: { first: prfSalt } } },
  });
  const first = result?.clientExtensionResults.prf?.results?.first;
  if (!first) throw new Error('The passkey returned no PRF output');
  return first;
}
