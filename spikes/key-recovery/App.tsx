// ponytail: throwaway spike screen (docs/spikes/spike-01-key-recovery.md). Each button runs one
// experiment and logs PASS/FAIL lines. Nothing here ships; findings go into ADR-001.
import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Passkeys from 'react-native-passkeys';
import * as s from 'react-native-libsodium';

const RP_ID = 'danielshapi4a.github.io';
const VAULT_KEY_ITEM = 'spike_vault_key';

const b64url = (b: Uint8Array) => s.to_base64(b, s.base64_variants.URLSAFE_NO_PADDING);
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
const encrypt = (m: string | Uint8Array, aad: string, nonce: Uint8Array, key: Uint8Array) =>
  s.crypto_aead_xchacha20poly1305_ietf_encrypt(m, aad, null, nonce, key);
const decrypt = (c: Uint8Array, aad: string, nonce: Uint8Array, key: Uint8Array) =>
  s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, c, aad, nonce, key);
const newNonce = () => s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
// ADR-001: 128-bit recovery key -> HKDF-SHA256 -> 256-bit wrapping key
const wrappingKeyFrom = (recoveryKey: Uint8Array) =>
  s._unstable_crypto_kdf_hkdf_sha256_expand(
    s._unstable_crypto_kdf_hkdf_sha256_extract(recoveryKey, new Uint8Array(0)),
    'cw-wrap-v1',
    32,
  );
// Decision 033: signing keypair derived from the vault key proves possession of the vault
const signingKeyFrom = (vaultKey: Uint8Array) =>
  s.crypto_sign_seed_keypair(s.crypto_kdf_derive_from_key(32, 1, 'cwsign01', vaultKey));

function cryptoChecks(): string[] {
  const out: string[] = [];
  const check = (name: string, ok: boolean) => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}`);

  const vaultKey = s.randombytes_buf(32);
  const nonce = newNonce();
  const ct = encrypt('ABCD-1234', 'item-1|code|v1', nonce, vaultKey);
  check('encrypt/decrypt round trip', s.to_string(decrypt(ct, 'item-1|code|v1', nonce, vaultKey)) === 'ABCD-1234');
  check('wrong AAD rejected', throws(() => decrypt(ct, 'item-2|code|v1', nonce, vaultKey)));
  const tampered = ct.slice();
  tampered[0] ^= 1;
  check('tampered ciphertext rejected', throws(() => decrypt(tampered, 'item-1|code|v1', nonce, vaultKey)));

  const wrapNonce = newNonce();
  const wrapped = encrypt(vaultKey, 'vault|v1', wrapNonce, wrappingKeyFrom(s.randombytes_buf(16)));
  const recoveryKey = s.randombytes_buf(16);
  const wrappedOk = encrypt(vaultKey, 'vault|v1', wrapNonce, wrappingKeyFrom(recoveryKey));
  check(
    'unwrap with the right recovery key',
    s.to_hex(decrypt(wrappedOk, 'vault|v1', wrapNonce, wrappingKeyFrom(recoveryKey))) === s.to_hex(vaultKey),
  );
  check('unwrap with a wrong recovery key rejected', throws(() => decrypt(wrapped, 'vault|v1', wrapNonce, wrappingKeyFrom(recoveryKey))));

  const kp = signingKeyFrom(vaultKey);
  const challenge = s.randombytes_buf(32);
  const sig = s.crypto_sign_detached(challenge, kp.privateKey);
  check('signature verifies', s.crypto_sign_verify_detached(sig, challenge, kp.publicKey));
  check('signature on another challenge fails', !s.crypto_sign_verify_detached(sig, s.randombytes_buf(32), kp.publicKey));
  check('same vault key gives same public key', s.to_hex(signingKeyFrom(vaultKey).publicKey) === s.to_hex(kp.publicKey));
  return out;
}

async function saveVaultKey(): Promise<string[]> {
  const existing = await SecureStore.getItemAsync(VAULT_KEY_ITEM);
  if (existing) return [`already saved: ${existing.slice(0, 16)}…`];
  const key = s.to_hex(s.randombytes_buf(32));
  await SecureStore.setItemAsync(VAULT_KEY_ITEM, key);
  return [`saved new vault key: ${key.slice(0, 16)}…`];
}

async function readVaultKey(): Promise<string[]> {
  const key = await SecureStore.getItemAsync(VAULT_KEY_ITEM);
  return [key ? `vault key present: ${key.slice(0, 16)}…` : 'vault key MISSING'];
}

async function createPasskey(): Promise<string[]> {
  if (!Passkeys.isSupported()) return ['passkeys NOT supported on this device'];
  const res = await Passkeys.create({
    challenge: b64url(s.randombytes_buf(32)),
    rp: { id: RP_ID, name: 'Coupon Wallet spike' },
    user: { id: b64url(s.randombytes_buf(16)), name: 'spike-user', displayName: 'Spike user' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf: {} },
  } as any);
  return [`created: ${res ? 'yes' : 'no'}`, `extension results: ${JSON.stringify(res?.clientExtensionResults ?? null)}`];
}

async function readPrf(): Promise<string[]> {
  // A fixed salt gives a stable PRF output per passkey: same output after reinstall = recovery works.
  const salt = b64url(s.crypto_generichash(32, 'coupon-wallet-prf-v1', null));
  const res = await Passkeys.get({
    challenge: b64url(s.randombytes_buf(32)),
    rpId: RP_ID,
    userVerification: 'required',
    extensions: { prf: { eval: { first: salt } } },
  } as any);
  const first = (res?.clientExtensionResults as any)?.prf?.results?.first;
  return first
    ? [`PRF output starts with: ${String(first).slice(0, 16)}`, 'write it down, reinstall the app, run again, compare']
    : [`no PRF output. extension results: ${JSON.stringify(res?.clientExtensionResults ?? null)}`];
}

type Step = [label: string, run: () => string[] | Promise<string[]>];
const steps: Step[] = [
  ['1. Crypto checks', cryptoChecks],
  ['2a. Save vault key (SecureStore)', saveVaultKey],
  ['2b. Read vault key (SecureStore)', readVaultKey],
  ['3a. Create passkey with PRF', createPasskey],
  ['3b. Read PRF output', readPrf],
];

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const run = async ([label, fn]: Step) => {
    let lines: string[];
    try {
      lines = await fn();
    } catch (e) {
      lines = [`ERROR ${String(e)}`];
    }
    setLog((prev) => [`— ${label}`, ...lines, ...prev]);
  };
  return (
    <View style={styles.root}>
      {steps.map((step) => (
        <Button key={step[0]} title={step[0]} onPress={() => run(step)} />
      ))}
      <ScrollView style={styles.log}>
        {log.map((line, i) => (
          <Text key={i} selectable style={styles.line}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 48, paddingHorizontal: 12, gap: 8 },
  log: { marginTop: 8 },
  line: { fontFamily: 'monospace', fontSize: 12 },
});
