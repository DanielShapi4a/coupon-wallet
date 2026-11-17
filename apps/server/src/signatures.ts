import { createPublicKey, verify } from 'node:crypto';

// Node.js crypto verifies Ed25519 natively (ADR-002): no library needed.
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32-byte raw key follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Checks an Ed25519 signature (base64url) over a UTF-8 message, against a raw public key (base64url). */
export function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  const raw = Buffer.from(publicKey, 'base64url');
  const sig = Buffer.from(signature, 'base64url');
  if (raw.length !== 32 || sig.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message, 'utf8'), key, sig);
}
