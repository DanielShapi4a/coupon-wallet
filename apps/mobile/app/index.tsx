import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { HealthResponse } from '@cw/shared';

// Set in apps/mobile/.env (see .env.example). In development it is the tunnel URL of the local server.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Skeleton screen: proves the app reaches the server and parses a schema from @cw/shared.
export default function Home() {
  const [status, setStatus] = useState('Checking the server…');

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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  text: { fontSize: 16, textAlign: 'center' },
});
