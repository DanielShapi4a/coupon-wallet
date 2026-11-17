import { aad, FORMAT_VERSION } from './aad.ts';

// All client-side cryptography from ADR-001, in one place. Pure functions over bytes:
// key storage and the passkey flows live in the app.

/**
 * The libsodium functions this module uses. The app passes react-native-libsodium and
 * the tests pass libsodium-wrappers; both expose this API (ADR-002).
 */
export interface Sodium {
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: string,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: string,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_kdf_derive_from_key(subkeyLength: number, subkeyId: number, context: string, key: Uint8Array): Uint8Array;
  crypto_sign_seed_keypair(seed: Uint8Array): { publicKey: Uint8Array; privateKey: Uint8Array };
  crypto_sign_detached(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
  randombytes_buf(length: number): Uint8Array;
  to_string(bytes: Uint8Array): string;
  to_base64(bytes: Uint8Array, variant: number): string;
  from_base64(text: string, variant: number): Uint8Array;
  base64_variants: { URLSAFE_NO_PADDING: number };
}

export const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/** Fixed, versioned PRF input (ADR-001). Not a secret; changing it changes every wrapping key. */
export const PRF_SALT = 'coupon-wallet-prf-v1';

// crypto_kdf: one 256-bit input, one 8-character context per purpose (ADR-001 v5).
const KDF_CONTEXT = { wrapping: 'cwwrap01', signing: 'cwsign01' } as const;
const KDF_SUBKEY_ID = 1;

const VAULT_KEY_FIELD = { itemId: 'vault', field: 'key' } as const;

export interface VaultCrypto {
  generateVaultKey(): Uint8Array;
  encryptField(vaultKey: Uint8Array, itemId: string, field: string, plaintext: string): string;
  decryptField(vaultKey: Uint8Array, itemId: string, field: string, sealed: string): string;
  deriveWrappingKey(prfOutput: Uint8Array): Uint8Array;
  wrapVaultKey(vaultKey: Uint8Array, wrappingKey: Uint8Array): string;
  unwrapVaultKey(wrapped: string, wrappingKey: Uint8Array): Uint8Array;
  deriveSigningKeyPair(vaultKey: Uint8Array): { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Proves holding the vault key (decision 033): an Ed25519 signature, base64url. */
  signWithVaultKey(vaultKey: Uint8Array, message: string): string;
}

export function createVaultCrypto(sodium: Sodium): VaultCrypto {
  const encode = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  const decode = (text: string) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);

  // Envelope (decision 008): [format version, 1 byte][nonce, 24 bytes][ciphertext + tag].
  function seal(key: Uint8Array, itemId: string, field: string, plaintext: Uint8Array): string {
    requireLength(key, KEY_BYTES, 'key');
    const nonce = sodium.randombytes_buf(NONCE_BYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext, aad(itemId, field, FORMAT_VERSION), null, nonce, key,
    );
    const envelope = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
    envelope[0] = FORMAT_VERSION;
    envelope.set(nonce, 1);
    envelope.set(ciphertext, 1 + NONCE_BYTES);
    return encode(envelope);
  }

  function open(key: Uint8Array, itemId: string, field: string, sealed: string): Uint8Array {
    requireLength(key, KEY_BYTES, 'key');
    const envelope = decode(sealed);
    if (envelope.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error('Encrypted value is too short');
    const version = envelope[0];
    if (version !== FORMAT_VERSION) throw new Error(`Unsupported format version ${version}`);
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, envelope.subarray(1 + NONCE_BYTES), aad(itemId, field, version), envelope.subarray(1, 1 + NONCE_BYTES), key,
      );
    } catch {
      // Same message for a wrong key, a changed ciphertext and a wrong item or field: nothing to learn from it.
      throw new Error('Encrypted value cannot be decrypted');
    }
  }

  return {
    generateVaultKey: () => sodium.randombytes_buf(KEY_BYTES),

    encryptField: (vaultKey, itemId, field, plaintext) =>
      seal(vaultKey, itemId, field, new TextEncoder().encode(plaintext)),

    decryptField: (vaultKey, itemId, field, sealed) => sodium.to_string(open(vaultKey, itemId, field, sealed)),

    deriveWrappingKey(prfOutput) {
      requireLength(prfOutput, KEY_BYTES, 'PRF output');
      return sodium.crypto_kdf_derive_from_key(KEY_BYTES, KDF_SUBKEY_ID, KDF_CONTEXT.wrapping, prfOutput);
    },

    wrapVaultKey(vaultKey, wrappingKey) {
      requireLength(vaultKey, KEY_BYTES, 'vault key');
      return seal(wrappingKey, VAULT_KEY_FIELD.itemId, VAULT_KEY_FIELD.field, vaultKey);
    },

    unwrapVaultKey(wrapped, wrappingKey) {
      const vaultKey = open(wrappingKey, VAULT_KEY_FIELD.itemId, VAULT_KEY_FIELD.field, wrapped);
      requireLength(vaultKey, KEY_BYTES, 'vault key');
      return vaultKey;
    },

    deriveSigningKeyPair: signingKeyPair,

    signWithVaultKey: (vaultKey, message) =>
      encode(sodium.crypto_sign_detached(new TextEncoder().encode(message), signingKeyPair(vaultKey).privateKey)),
  };

  function signingKeyPair(vaultKey: Uint8Array) {
    requireLength(vaultKey, KEY_BYTES, 'vault key');
    const seed = sodium.crypto_kdf_derive_from_key(KEY_BYTES, KDF_SUBKEY_ID, KDF_CONTEXT.signing, vaultKey);
    const { publicKey, privateKey } = sodium.crypto_sign_seed_keypair(seed);
    return { publicKey, privateKey };
  }
}

function requireLength(bytes: Uint8Array, length: number, name: string): void {
  if (bytes.length !== length) throw new Error(`The ${name} must be ${length} bytes`);
}

export const hexToBytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

// react-native-libsodium only accepts a string AAD, so the phone cannot run the IETF vector
// (its AAD is binary). Instead the tests check libsodium-wrappers against the IETF vector, and
// this golden vector, computed with libsodium-wrappers, checks that the phone's library agrees.
// Key and nonce are the IETF vector's; the AAD is in this module's own format.
export const GOLDEN_VECTOR = {
  plaintext: 'ABCD-0000-1111',
  aad: 'item-1|code|v1',
  key: '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
  nonce: '404142434445464748494a4b4c4d4e4f5051525354555657',
  ciphertextAndTag: 'b04e30b076c0c46acb3f46e2c79fba256f3c182eaa064a47d4cf7fdbf0e7',
} as const;

/**
 * Checks the libsodium binding the caller passes in: the golden vector, then a round trip
 * through this module. The app runs it on the phone, the tests run it in Node.
 */
export function selfTest(sodium: Sodium): { ok: true } | { ok: false; failed: string } {
  try {
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(GOLDEN_VECTOR.plaintext),
      GOLDEN_VECTOR.aad,
      null,
      hexToBytes(GOLDEN_VECTOR.nonce),
      hexToBytes(GOLDEN_VECTOR.key),
    );
    const expected = hexToBytes(GOLDEN_VECTOR.ciphertextAndTag);
    if (ct.length !== expected.length || ct.some((b, i) => b !== expected[i])) return { ok: false, failed: 'golden vector' };

    const vc = createVaultCrypto(sodium);
    const key = vc.generateVaultKey();
    if (vc.decryptField(key, 'self-test', 'code', vc.encryptField(key, 'self-test', 'code', 'שובר 0000')) !== 'שובר 0000') {
      return { ok: false, failed: 'round trip' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, failed: String(err) };
  }
}
