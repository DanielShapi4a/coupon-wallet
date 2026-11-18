// SPIKE 02 (spike/fcm branch only; temporary code, never merged to main).
// Question 1: does a content-free FCM message (data only, high priority) wake the app, in every app
// state, so it can build the reminder text from local data (REM-3)? The text says how it got here and
// how long it took, so a screenshot of the notification is the measurement.
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { itemStates } from '@cw/shared';
import { listItems } from '../wallet/store';

export const TASK = 'cw-spike-fcm';
// REM-2: separate channels for reminders and for security alerts.
export const CHANNELS = { reminders: 'reminders', security: 'security' } as const;

// While the app is open, show notifications too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/** The reminder text from the phone's own data. The message itself carries only a send time. */
async function showReminder(data: Record<string, unknown>) {
  const sentAt = Number(data.sentAt);
  const delay = Number.isFinite(sentAt) ? `${((Date.now() - sentAt) / 1000).toFixed(1)}s` : 'unknown';
  let summary: string;
  try {
    const items = await listItems();
    const now = new Date();
    const soon = items.filter((i) => itemStates(i.metadata, now).includes('expiring_soon'));
    const merchants = [...new Set(soon.map((i) => i.metadata.merchant))].join(', ');
    summary = soon.length ? `${soon.length} expiring soon: ${merchants}` : `${items.length} item(s), none expiring soon`;
  } catch (err) {
    summary = `could not read the wallet (${String(err)})`;
  }
  await Notifications.scheduleNotificationAsync({
    content: { title: 'Coupon Wallet (spike 02)', body: `${summary}. Delay ${delay}.` },
    trigger: { channelId: CHANNELS.reminders },
  });
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  if ('actionIdentifier' in data) return; // a tap on a notification, not a message
  const payload = data.data.dataString ? JSON.parse(data.data.dataString) : data.data;
  await showReminder(payload);
});
Notifications.registerTaskAsync(TASK);

/** Permission, the two channels, and this phone's FCM token (logged for the sender script). */
export async function setUpNotifications(): Promise<string> {
  const { granted } = await Notifications.requestPermissionsAsync();
  await Notifications.setNotificationChannelAsync(CHANNELS.reminders, {
    name: 'Reminders',
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync(CHANNELS.security, {
    name: 'Security',
    importance: Notifications.AndroidImportance.HIGH,
  });
  const token = (await Notifications.getDevicePushTokenAsync()).data as string;
  console.log(`SPIKE02 FCM token: ${token}`);
  const registered = await TaskManager.isTaskRegisteredAsync(TASK);
  return `permission ${granted ? 'granted' : 'denied'}, task registered: ${registered}, token ${token.slice(0, 12)}… (full token in the Metro log)`;
}
