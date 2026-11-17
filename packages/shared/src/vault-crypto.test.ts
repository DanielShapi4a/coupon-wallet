import { createPublicKey, verify } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVaultCrypto, GOLDEN_VECTOR, hexToBytes, selfTest, type VaultCrypto } from './vault-crypto.ts';

// Tests run on libsodium-wrappers; the phone runs react-native-libsodium.
// selfTest() runs the same known vector on the phone to catch any gap between the two.
let vc: VaultCrypto;
beforeAll(async () => {
  await sodium.ready;
  vc = createVaultCrypto(sodium);
});

const flipByte = (encoded: string, index: number): string => {
  const bytes = sodium.from_base64(encoded, sodium.base64_variants.URLSAFE_NO_PADDING);
  bytes[index] ^= 1;
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
};

// draft-irtf-cfrg-xchacha-03, appendix A.3.1 (AEAD_XCHACHA20_POLY1305).
const IETF_VECTOR = {
  plaintext:
    '4c616469657320616e642047656e746c656d656e206f662074686520636c6173' +
    '73206f66202739393a204966204920636f756c64206f6666657220796f75206f' +
    '6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73' +
    '637265656e20776f756c642062652069742e',
  aad: '50515253c0c1c2c3c4c5c6c7',
  key: '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
  nonce: '404142434445464748494a4b4c4d4e4f5051525354555657',
  ciphertextAndTag:
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
    '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
    '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
    '21f9664c97637da9768812f615c68b13b52e' +
    'c0875924c1c7987947deafd8780acf49',
};

describe('known vectors', () => {
  it('libsodium-wrappers matches the IETF XChaCha20-Poly1305 vector', () => {
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      hexToBytes(IETF_VECTOR.plaintext),
      hexToBytes(IETF_VECTOR.aad),
      null,
      hexToBytes(IETF_VECTOR.nonce),
      hexToBytes(IETF_VECTOR.key),
    );
    expect(sodium.to_hex(ct)).toBe(IETF_VECTOR.ciphertextAndTag);
  });

  it('selfTest passes: the golden vector and a field round trip', () => {
    expect(selfTest(sodium)).toEqual({ ok: true });
  });

  it('decryptField opens the golden vector in this module\'s envelope', () => {
    const envelope = new Uint8Array([1, ...hexToBytes(GOLDEN_VECTOR.nonce), ...hexToBytes(GOLDEN_VECTOR.ciphertextAndTag)]);
    const sealed = sodium.to_base64(envelope, sodium.base64_variants.URLSAFE_NO_PADDING);
    expect(vc.decryptField(hexToBytes(GOLDEN_VECTOR.key), 'item-1', 'code', sealed)).toBe(GOLDEN_VECTOR.plaintext);
  });
});

describe('field encryption', () => {
  it('round-trips a code', () => {
    const key = vc.generateVaultKey();
    const sealed = vc.encryptField(key, 'item-1', 'code', 'ABCD-0000-1111');
    expect(vc.decryptField(key, 'item-1', 'code', sealed)).toBe('ABCD-0000-1111');
  });

  it('uses a fresh nonce for every encryption', () => {
    const key = vc.generateVaultKey();
    expect(vc.encryptField(key, 'item-1', 'code', 'same')).not.toBe(vc.encryptField(key, 'item-1', 'code', 'same'));
  });

  it('fails with a wrong key', () => {
    const sealed = vc.encryptField(vc.generateVaultKey(), 'item-1', 'code', 'x');
    expect(() => vc.decryptField(vc.generateVaultKey(), 'item-1', 'code', sealed)).toThrow('cannot be decrypted');
  });

  it('fails when the ciphertext was changed', () => {
    const key = vc.generateVaultKey();
    const sealed = vc.encryptField(key, 'item-1', 'code', 'x');
    expect(() => vc.decryptField(key, 'item-1', 'code', flipByte(sealed, 30))).toThrow('cannot be decrypted');
  });

  it('fails when moved to another item or field (AAD mismatch)', () => {
    const key = vc.generateVaultKey();
    const sealed = vc.encryptField(key, 'item-1', 'code', 'x');
    expect(() => vc.decryptField(key, 'item-2', 'code', sealed)).toThrow('cannot be decrypted');
    expect(() => vc.decryptField(key, 'item-1', 'pin', sealed)).toThrow('cannot be decrypted');
  });

  it('reports an unknown format version clearly', () => {
    const key = vc.generateVaultKey();
    const bytes = sodium.from_base64(vc.encryptField(key, 'item-1', 'code', 'x'), sodium.base64_variants.URLSAFE_NO_PADDING);
    bytes[0] = 9;
    const sealed = sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
    expect(() => vc.decryptField(key, 'item-1', 'code', sealed)).toThrow('Unsupported format version 9');
  });

  it('rejects truncated input and keys of the wrong length', () => {
    const key = vc.generateVaultKey();
    expect(() => vc.decryptField(key, 'item-1', 'code', 'AQID')).toThrow('too short');
    expect(() => vc.encryptField(key.slice(0, 16), 'item-1', 'code', 'x')).toThrow('32 bytes');
  });
});

describe('vault key wrapping', () => {
  it('unwraps with the wrapping key derived from the same PRF output', () => {
    const vaultKey = vc.generateVaultKey();
    const prf = sodium.randombytes_buf(32);
    const wrapped = vc.wrapVaultKey(vaultKey, vc.deriveWrappingKey(prf));
    expect(vc.unwrapVaultKey(wrapped, vc.deriveWrappingKey(prf))).toEqual(vaultKey);
  });

  it('fails with the wrapping key of another passkey', () => {
    const wrapped = vc.wrapVaultKey(vc.generateVaultKey(), vc.deriveWrappingKey(sodium.randombytes_buf(32)));
    expect(() => vc.unwrapVaultKey(wrapped, vc.deriveWrappingKey(sodium.randombytes_buf(32)))).toThrow('cannot be decrypted');
  });

  it('derives the same wrapping key from the same PRF output', () => {
    const prf = sodium.randombytes_buf(32);
    expect(vc.deriveWrappingKey(prf)).toEqual(vc.deriveWrappingKey(prf));
  });

  it('rejects a PRF output of the wrong length', () => {
    expect(() => vc.deriveWrappingKey(sodium.randombytes_buf(16))).toThrow('32 bytes');
  });
});

describe('signing key pair (decision 033)', () => {
  it('is the same for the same vault key, and differs from the wrapping key', () => {
    const vaultKey = vc.generateVaultKey();
    const a = vc.deriveSigningKeyPair(vaultKey);
    expect(vc.deriveSigningKeyPair(vaultKey).publicKey).toEqual(a.publicKey);
    expect(a.publicKey).not.toEqual(vc.deriveWrappingKey(vaultKey));
  });

  it('produces signatures that Node.js crypto verifies, as the server will', () => {
    const { publicKey, privateKey } = vc.deriveSigningKeyPair(vc.generateVaultKey());
    const challenge = sodium.randombytes_buf(32);
    const signature = sodium.crypto_sign_detached(challenge, privateKey);
    // DER prefix of an Ed25519 SubjectPublicKeyInfo, followed by the 32-byte raw key.
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(verify(null, challenge, key, signature)).toBe(true);
    expect(verify(null, sodium.randombytes_buf(32), key, signature)).toBe(false);
  });
});
