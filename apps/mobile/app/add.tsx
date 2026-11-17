import { useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { endOfDayInIsrael, parseShekels, type ItemMetadata, type ItemValue } from '@cw/shared';
import { addItem } from '../src/wallet/wallet';

type Kind = ItemValue['kind'];
const KINDS: { kind: Kind; label: string; amountLabel: string }[] = [
  { kind: 'stored_value', label: 'Stored value', amountLabel: 'Amount (₪)' },
  { kind: 'fixed_discount', label: 'Fixed discount', amountLabel: 'Discount (₪)' },
  { kind: 'percent_discount', label: 'Percent', amountLabel: 'Percent off' },
  { kind: 'item_benefit', label: 'Free item', amountLabel: 'What you get' },
];

// Manual entry (ADD-7): merchant, kind of value and amount are required; everything else is optional.
export default function AddItem() {
  const [merchant, setMerchant] = useState('');
  const [kind, setKind] = useState<Kind>('stored_value');
  const [amount, setAmount] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  function buildValue(): ItemValue | string {
    if (kind === 'item_benefit') return amount.trim() ? { kind } : 'Describe what you get';
    if (kind === 'percent_discount') {
      const percent = Number(amount);
      return percent > 0 && percent <= 100 ? { kind, percent, maxPurchaseAgorot: null } : 'Percent must be between 1 and 100';
    }
    const agorot = parseShekels(amount);
    if (agorot === null || agorot === 0) return 'Enter an amount in shekels, e.g. 100 or 49.90';
    return kind === 'stored_value'
      ? { kind, initialAgorot: agorot, remainingAgorot: agorot, lastVerifiedAt: null }
      : { kind, amountAgorot: agorot, minPurchaseAgorot: null };
  }

  async function save() {
    if (!merchant.trim()) return setError('Enter the store or merchant');
    const value = buildValue();
    if (typeof value === 'string') return setError(value);
    const until = validUntil.trim() ? endOfDayInIsrael(validUntil.trim()) : null;
    if (validUntil.trim() && !until) return setError('Valid until must be a date like 2026-12-31');

    const metadata: ItemMetadata = {
      merchant: merchant.trim(),
      value,
      status: 'active',
      usage: kind === 'stored_value' ? 'multi' : 'single',
      channel: null,
      transferable: 'unknown',
      receivedFrom: null,
      receivedAt: new Date().toISOString(),
      validFrom: null,
      validUntil: until,
    };
    try {
      await addItem({
        metadata,
        credential: code.trim() ? { code: code.trim() } : {},
        details: {
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(kind === 'item_benefit' ? { benefitDescription: amount.trim() } : {}),
        },
      });
      router.back();
    } catch (err) {
      setError(String(err));
    }
  }

  const amountLabel = KINDS.find((k) => k.kind === kind)!.amountLabel;
  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Add item' }} />
      <Text style={styles.label}>Store or merchant *</Text>
      <TextInput style={styles.input} value={merchant} onChangeText={setMerchant} placeholder="e.g. Swish" />

      <Text style={styles.label}>Kind of value *</Text>
      <View style={styles.kinds}>
        {KINDS.map((k) => (
          <Button key={k.kind} title={k.label} color={k.kind === kind ? undefined : '#999'} onPress={() => setKind(k.kind)} />
        ))}
      </View>

      <Text style={styles.label}>{amountLabel} *</Text>
      <TextInput
        style={styles.input}
        value={amount}
        onChangeText={setAmount}
        keyboardType={kind === 'item_benefit' ? 'default' : 'decimal-pad'}
      />

      <Text style={styles.label}>Valid until (YYYY-MM-DD)</Text>
      <TextInput style={styles.input} value={validUntil} onChangeText={setValidUntil} placeholder="2026-12-31" />

      <Text style={styles.label}>Code</Text>
      <TextInput style={styles.input} value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} />

      <Text style={styles.label}>Notes</Text>
      <TextInput style={[styles.input, styles.multiline]} value={notes} onChangeText={setNotes} multiline />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Save" onPress={save} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 6 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10, fontSize: 16 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  error: { color: '#B3261E', marginVertical: 8 },
});
