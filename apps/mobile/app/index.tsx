import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as sodium from 'react-native-libsodium';
import { HealthResponse, selfTest } from '@cw/shared';

// Set in apps/mobile/.env (see .env.example). In development it is the tunnel URL of the local server.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Skeleton screen: proves the app reaches the server, parses a schema from @cw/shared,
// and that the phone's libsodium agrees with the one the tests run on.
export default function Home() {
  const [status, setStatus] = useState('Checking the server…');
  const [crypto, setCrypto] = useState('Running the crypto self-test…');

  useEffect(() => {
    sodium.ready
      .then(() => {
        const result = selfTest(sodium);
        setCrypto(result.ok ? 'Crypto self-test: PASS' : `Crypto self-test: FAIL (${result.failed})`);
      })
      .catch((err) => setCrypto(`Crypto self-test: FAIL (${String(err)})`));
  }, []);

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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  text: { fontSize: 16, textAlign: 'center' },
});
