import { useCallback, useEffect, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as sodium from 'react-native-libsodium';
import { HealthResponse, selfTest } from '@cw/shared';
import { isSignedIn, signIn, signOut } from '../src/api/client';
import {
  checkPasskey,
  createVault,
  forgetVaultKey,
  getVaultStatus,
  hasServerVault,
  recoverVault,
  repairPasskey,
} from '../src/vault/vault';

// Set in apps/mobile/.env (see .env.example). In development it is the tunnel URL of the local server.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Development screen: the server connection, the crypto self-test, sign-in and the vault flows.
// The real screens are designed once the flows work.
export default function Home() {
  const [status, setStatus] = useState('Checking the server…');
  const [crypto, setCrypto] = useState('Running the crypto self-test…');
  const [vault, setVault] = useState('Checking the vault…');
  const [passkeyMissing, setPasskeyMissing] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const refreshVault = useCallback(async () => {
    try {
      // The silent check runs first and needs no network (decision 035).
      const passkey = await checkPasskey().catch((err) => `check failed: ${String(err)}`);
      setPasskeyMissing(passkey === 'missing');
      const signedIn = await isSignedIn();
      const local = await getVaultStatus();
      const server = signedIn ? ((await hasServerVault()) ? 'present' : 'missing') : 'sign in to check';
      setVault(
        `Signed in: ${signedIn ? 'yes' : 'no'}\n` +
          `Vault key on this phone: ${local.hasVaultKey ? `present (id ${local.keyId})` : 'missing'}\n` +
          `Vault on the server: ${server}\n` +
          `Passkey (silent check): ${passkey}`,
      );
    } catch (err) {
      setVault(`Vault: ERROR ${String(err)}`);
    }
  }, []);

  const run = (label: string, action: () => Promise<string>) => async () => {
    let line: string;
    try {
      line = `${label}: ${await action()}`;
    } catch (err) {
      line = `${label}: ERROR ${String(err)}`;
    }
    setLog((prev) => [line, ...prev]);
    await refreshVault();
  };

  useEffect(() => {
    sodium.ready
      .then(() => {
        const result = selfTest(sodium);
        setCrypto(result.ok ? 'Crypto self-test: PASS' : `Crypto self-test: FAIL (${result.failed})`);
      })
      .catch((err) => setCrypto(`Crypto self-test: FAIL (${String(err)})`));
    refreshVault();
  }, [refreshVault]);

  useEffect(() => {
    if (!API_URL) {
      setStatus('EXPO_PUBLIC_API_URL is not set');
      return;
    }
    fetch(`${API_URL}/health`)
      .then((res) => res.json())
      .then((json) => {
        const health = HealthResponse.parse(json);
        setStatus(health.ok ? 'Connected to the server, database up' : 'Server up, database down');
      })
      .catch((err) => setStatus(`Server unreachable: ${String(err)}`));
  }, []);

  return (
    <View style={styles.root}>
      <Text style={styles.text}>{status}</Text>
      <Text style={styles.text}>{crypto}</Text>

      <Text style={styles.heading}>Vault (development)</Text>
      {passkeyMissing && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Your backup was deleted. Repair it so the wallet can be recovered on a new phone.</Text>
          <Button
            title="Repair backup"
            onPress={run('Repair backup', async () => `OK, same key id ${(await repairPasskey()).keyId}, new passkey`)}
          />
        </View>
      )}
      <Text style={styles.text}>{vault}</Text>
      <View style={styles.buttons}>
        <Button title="Sign in with Google" onPress={run('Sign in', async () => (await signIn(), 'OK'))} />
        <Button
          title="Create vault"
          onPress={run('Create vault', async () => {
            const r = await createVault();
            return `OK, key id ${r.keyId}, ${r.confirmations} confirmation(s)`;
          })}
        />
        <Button
          title="Recover vault"
          onPress={run('Recover vault', async () => `recovered key id ${(await recoverVault()).keyId}`)}
        />
        <Button title="Forget key on this phone" onPress={run('Forget key', async () => (await forgetVaultKey(), 'done'))} />
        <Button title="Sign out" onPress={run('Sign out', async () => (await signOut(), 'done'))} />
      </View>
      <ScrollView style={styles.log}>
        {log.map((line, i) => (
          <Text key={i} selectable style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 64, gap: 12 },
  heading: { fontSize: 18, fontWeight: '600', marginTop: 16 },
  text: { fontSize: 16 },
  buttons: { gap: 8 },
  banner: { backgroundColor: '#FDECEA', borderRadius: 8, padding: 12, gap: 8 },
  bannerText: { fontSize: 15, color: '#7A1C14' },
  log: { marginTop: 8 },
  logLine: { fontFamily: 'monospace', fontSize: 12, marginBottom: 4 },
});
