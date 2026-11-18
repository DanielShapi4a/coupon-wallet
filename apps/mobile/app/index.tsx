import { useCallback, useState } from 'react';
import { Button, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import { formatShekels, itemStates, walletSummary, type WalletItem } from '@cw/shared';
import { getVaultStatus } from '../src/vault/vault';
import { dateLabel, STATE_LABEL, valueLabel } from '../src/wallet/format';
import { listWallet, syncNow } from '../src/wallet/wallet';

// The wallet (WAL-1 to WAL-3). A minimal working screen; the real design comes later.
export default function Wallet() {
  const [items, setItems] = useState<WalletItem[] | null>(null);
  const [hasVault, setHasVault] = useState(true);
  const [sync, setSync] = useState('');
  const [error, setError] = useState('');

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const { hasVaultKey } = await getVaultStatus();
          setHasVault(hasVaultKey);
          if (!hasVaultKey) return;
          setItems(await listWallet());
          const { pending } = await syncNow();
          setSync(pending ? `${pending} change(s) not synced yet` : 'Synced');
        } catch (err) {
          setError(String(err));
        }
      })();
    }, []),
  );

  const now = new Date();
  const summary = items ? walletSummary(items, now) : null;

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: 'Wallet' }} />
      {!hasVault ? (
        <View style={styles.empty}>
          <Text style={styles.text}>No vault on this phone yet. Sign in and create or recover the vault first.</Text>
          <Button title="Set up (development)" onPress={() => router.push('/dev')} />
        </View>
      ) : (
        <>
          {summary && (
            <Text style={styles.summary}>
              Stored value: {formatShekels(summary.storedAgorot)}
              {summary.unknownBalances ? ` (${summary.unknownBalances} unknown)` : ''} · Expiring this week:{' '}
              {summary.expiringThisWeek}
            </Text>
          )}
          <FlatList
            data={items ?? []}
            keyExtractor={(i) => i.id}
            ListEmptyComponent={<Text style={styles.text}>{items ? 'No items yet.' : 'Loading…'}</Text>}
            renderItem={({ item }) => {
              const states = itemStates(item.metadata, now);
              return (
                <Pressable style={styles.row} onPress={() => router.push(`/item/${item.id}`)}>
                  <Text style={styles.merchant}>{item.metadata.merchant}</Text>
                  <Text style={styles.text}>{valueLabel(item)}</Text>
                  <Text style={styles.meta}>
                    Valid until {dateLabel(item.metadata.validUntil)}
                    {states.length ? ` · ${states.map((s) => STATE_LABEL[s]).join(', ')}` : ''}
                    {item.metadata.status === 'used' ? ' · used' : ''}
                  </Text>
                </Pressable>
              );
            }}
          />
          <Text style={styles.meta}>{error || sync}</Text>
          <Button title="Add item" onPress={() => router.push('/add')} />
        </>
      )}
      <Button title="Development" onPress={() => router.push('/dev')} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 8 },
  empty: { gap: 12, paddingVertical: 24 },
  summary: { fontSize: 16, fontWeight: '600' },
  row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc', gap: 2 },
  merchant: { fontSize: 17, fontWeight: '600' },
  text: { fontSize: 15 },
  meta: { fontSize: 13, color: '#666' },
});
