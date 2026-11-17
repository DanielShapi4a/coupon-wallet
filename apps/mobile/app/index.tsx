import { useCallback, useEffect, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as sodium from 'react-native-libsodium';
import { HealthResponse, selfTest } from '@cw/shared';
import { createVault, forgetVaultKey, getVaultStatus, recoverVault, resetLocalVault } from '../src/vault/vault';

// Set in apps/mobile/.env (see .env.example). In development it is the tunnel URL of the local server.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Development screen: the server connection, the crypto self-test, and the vault flows.
// The real screens are designed once the flows work.
export default function Home() {
  const [status, setStatus] = useState('Checking the server…');
  const [crypto, setCrypto] = useState('Running the crypto self-test…');
  const [vault, setVault] = useState('Checking the vault…');
  const [log, setLog] = useState<string[]>([]);

  const refreshVault = useCallback(async () => {
    const s = await getVaultStatus();
    setVault(
      `Vault key: ${s.hasVaultKey ? `present (id ${s.keyId})` : 'missing'} · wrapped copy: ${s.hasWrappedVaultKey ? 'present' : 'missing'}`,
    );
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
    refreshVault().catch((err) => setVault(`Vault: ERROR ${String(err)}`));
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
      <Text style={styles.text}>{vault}</Text>
      <View style={styles.buttons}>
        <Button
          title="Create vault"
          onPress={run('Create vault', async () => {
            const r = await createVault();
            return `OK, key id ${r.keyId}, ${r.confirmations} confirmation(s)`;
          })}
        />
        <Button
          title="Simulate new phone"
          onPress={run('Simulate new phone', async () => {
            await forgetVaultKey();
            const r = await recoverVault();
            return `recovered key id ${r.keyId}`;
          })}
        />
        <Button title="Reset local vault" onPress={run('Reset local vault', async () => (await resetLocalVault(), 'done'))} />
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
  log: { marginTop: 8 },
  logLine: { fontFamily: 'monospace', fontSize: 12, marginBottom: 4 },
});
