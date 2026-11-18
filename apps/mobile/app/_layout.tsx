import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Button, Linking, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Stack } from 'expo-router';
import { hideFromRecents } from '../modules/credentials';

// AUTH-5 (decisions 028 and 042): locked on every start, and again after more than 5 minutes in the background.
// The lock is a cover over the app, so after unlocking the person is back on the same screen.
const RELOCK_AFTER_MS = 5 * 60 * 1000;

export default function Layout() {
  const [locked, setLocked] = useState(true);
  const [noScreenLock, setNoScreenLock] = useState(false);
  const [message, setMessage] = useState('');
  const backgroundAt = useRef<number | null>(null);

  const unlock = useCallback(async () => {
    setMessage('');
    // A passkey needs a screen lock, so this only happens if it was removed after the vault was made (decision 042).
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    setNoScreenLock(level === LocalAuthentication.SecurityLevel.NONE);
    if (level === LocalAuthentication.SecurityLevel.NONE) return;

    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Coupon Wallet' });
    if (result.success) return setLocked(false);
    if (result.error === 'lockout') setMessage('Too many attempts. Wait a moment and try again.');
    else if (result.error !== 'user_cancel' && result.error !== 'system_cancel') setMessage(`Could not unlock (${result.error})`);
  }, []);

  useEffect(() => {
    hideFromRecents();
    unlock();
  }, [unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundAt.current = Date.now();
      if (state !== 'active' || backgroundAt.current === null) return;
      // ponytail: wall-clock time; changing the phone's clock can shorten or stretch the 5 minutes.
      const away = Date.now() - backgroundAt.current;
      backgroundAt.current = null;
      if (away > RELOCK_AFTER_MS) {
        setLocked(true);
        unlock();
      }
    });
    return () => sub.remove();
  }, [unlock]);

  return (
    <>
      {/* Hidden from screen readers while locked, so the codes under the cover are not read out. */}
      <View style={styles.app} importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}>
        <Stack />
      </View>
      {locked && (
        <View style={styles.cover}>
          <Text style={styles.title}>Coupon Wallet is locked</Text>
          {noScreenLock ? (
            <>
              <Text style={styles.text}>
                Set a screen lock on this phone to open the wallet. Your items are safe and nothing was deleted.
              </Text>
              <Button title="Open security settings" onPress={() => Linking.sendIntent('android.settings.SECURITY_SETTINGS')} />
              <Button title="I set it, try again" onPress={unlock} />
            </>
          ) : (
            <Button title="Unlock" onPress={unlock} />
          )}
          {message ? <Text style={styles.text}>{message}</Text> : null}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  cover: { ...StyleSheet.absoluteFill, backgroundColor: '#fff', justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  text: { fontSize: 16, textAlign: 'center' },
});
