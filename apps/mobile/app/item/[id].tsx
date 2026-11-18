import { useCallback, useState } from 'react';
import { Alert, Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { itemStates, parseShekels, type WalletItem } from '@cw/shared';
import { dateLabel, groupCode, STATE_LABEL, valueLabel } from '../../src/wallet/format';
import { deleteItem, getWalletItem, updateItem } from '../../src/wallet/wallet';

// Redemption (RED-2, RED-5). Works offline: everything comes from the phone (RED-1).
export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<WalletItem | null>(null);
  const [balance, setBalance] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => setItem(await getWalletItem(id)), [id]);
  useFocusEffect(
    useCallback(() => {
      load().catch((err) => setMessage(String(err)));
    }, [load]),
  );

  if (!item) return <Text style={styles.root}>{message || 'Loading…'}</Text>;
  const { metadata, credential, details } = item;
  const states = itemStates(metadata, new Date());

  async function markUsed() {
    await updateItem({ ...item!, metadata: { ...metadata, status: 'used' } });
    router.back();
  }

  // RED-5: after using a stored-value item, record the new balance; lastVerifiedAt moves to now.
  async function saveBalance() {
    if (metadata.value.kind !== 'stored_value') return;
    const remaining = parseShekels(balance);
    if (remaining === null || remaining > metadata.value.initialAgorot) return setMessage('Enter the remaining balance in shekels');
    await updateItem({
      ...item!,
      metadata: {
        ...metadata,
        value: { ...metadata.value, remainingAgorot: remaining, lastVerifiedAt: new Date().toISOString() },
        status: remaining === 0 ? 'used' : metadata.status,
      },
    });
    setBalance('');
    setMessage('Balance updated');
    await load();
  }

  function confirmDelete() {
    Alert.alert('Delete this item?', 'It is removed from this phone and from the backup.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteItem(item!.id).then(() => router.back()) },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Stack.Screen options={{ title: metadata.merchant }} />
      <Text style={styles.value}>{valueLabel(item)}</Text>
      <Text style={styles.meta}>
        Valid until {dateLabel(metadata.validUntil)}
        {states.length ? ` · ${states.map((s) => STATE_LABEL[s]).join(', ')}` : ''}
        {metadata.status === 'used' ? ' · used' : ''}
      </Text>
      {metadata.transferable === 'no' && <Text style={styles.meta}>Personal, not transferable (RED-6)</Text>}

      {credential.code ? (
        <View style={styles.codeBox}>
          <Text style={styles.code} selectable>
            {groupCode(credential.code)}
          </Text>
          <Button
            title="Copy code"
            onPress={() => Clipboard.setStringAsync(credential.code!).then(() => setMessage('Code copied'))}
          />
        </View>
      ) : (
        <Text style={styles.meta}>No code saved</Text>
      )}
      {credential.pin ? <Text style={styles.text}>PIN: {credential.pin}</Text> : null}
      {details.notes ? <Text style={styles.text}>{details.notes}</Text> : null}

      {metadata.value.kind === 'stored_value' && (
        <View style={styles.section}>
          <Text style={styles.label}>Remaining balance (₪)</Text>
          <TextInput style={styles.input} value={balance} onChangeText={setBalance} keyboardType="decimal-pad" />
          <Button title="Update balance" onPress={saveBalance} />
        </View>
      )}
      <View style={styles.section}>
        <Button title="Mark as used" onPress={markUsed} />
        <Button title="Delete" color="#B3261E" onPress={confirmDelete} />
      </View>
      {message ? <Text style={styles.meta}>{message}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 8 },
  value: { fontSize: 20, fontWeight: '600' },
  meta: { fontSize: 13, color: '#666' },
  text: { fontSize: 15 },
  // RED-2: large, in a monospace font that tells similar characters apart.
  codeBox: { marginVertical: 12, padding: 16, borderRadius: 8, backgroundColor: '#F2F2F2', gap: 8 },
  code: { fontFamily: 'monospace', fontSize: 28, letterSpacing: 2, textAlign: 'center' },
  section: { gap: 8, marginTop: 12 },
  label: { fontSize: 14, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10, fontSize: 16 },
});
