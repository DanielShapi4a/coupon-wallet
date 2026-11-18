import { formatShekels, type ItemState, type WalletItem } from '@cw/shared';

// Display text for the minimal screens. The real design, in Hebrew and English (I18N-1), comes later.

export function valueLabel(item: WalletItem): string {
  const v = item.metadata.value;
  switch (v.kind) {
    case 'stored_value':
      return v.remainingAgorot === null
        ? `${formatShekels(v.initialAgorot)} (balance unknown)`
        : `${formatShekels(v.remainingAgorot)} of ${formatShekels(v.initialAgorot)}`;
    case 'fixed_discount':
      return `${formatShekels(v.amountAgorot)} off${v.minPurchaseAgorot ? ` above ${formatShekels(v.minPurchaseAgorot)}` : ''}`;
    case 'percent_discount':
      return `${v.percent}% off`;
    case 'item_benefit':
      return item.details.benefitDescription ?? 'Benefit';
  }
}

export const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Jerusalem' }).replace(/\//g, '-') : 'no expiry';

export const STATE_LABEL: Record<ItemState, string> = {
  not_yet_valid: 'not valid yet',
  expiring_soon: 'expiring soon',
  expired: 'expired',
  partially_used: 'partially used',
  balance_unknown: 'balance unknown',
};

/**
 * RED-2: a long code without separators is shown in groups of four, so it is easy to read out.
 * A code that already has separators stays exactly as issued (decision 024). Copying always copies the original.
 */
export const groupCode = (code: string) => (/[\s-]/.test(code) ? code : (code.match(/.{1,4}/g)?.join(' ') ?? code));
