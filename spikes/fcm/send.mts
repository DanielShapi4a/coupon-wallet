// SPIKE 02 (spike/fcm branch only): sends one message straight to FCM HTTP v1, without firebase-admin
// (ADR-002). The access token comes from a JWT signed with the service account key (OAuth 2.0 for
// service accounts); the key file stays outside the repo and is never printed.
//
//   FCM_SERVICE_ACCOUNT=<path to key.json> node spikes/fcm/send.mts <device token> [data|notification]
//
// data:         content-free, high priority; the app builds the text from local data (REM-3).
// notification: the fallback; a generic text that Android shows by itself.
import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';

const [deviceToken, mode = 'data'] = process.argv.slice(2);
const keyPath = process.env.FCM_SERVICE_ACCOUNT;
if (!deviceToken || !keyPath || !['data', 'notification'].includes(mode)) {
  console.error('usage: FCM_SERVICE_ACCOUNT=<key.json> node spikes/fcm/send.mts <device token> [data|notification]');
  process.exit(1);
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri: string;
}
const sa = JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccount;

const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer(sa.client_email)
  .setAudience(sa.token_uri)
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(await importPKCS8(sa.private_key, 'RS256'));
const tokenRes = await fetch(sa.token_uri, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
});
if (!tokenRes.ok) throw new Error(`access token: ${tokenRes.status} ${await tokenRes.text()}`);
const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

const sentAt = String(Date.now());
const message =
  mode === 'data'
    ? { token: deviceToken, data: { type: 'reminders', sentAt }, android: { priority: 'HIGH' } }
    : {
        token: deviceToken,
        notification: { title: 'Coupon Wallet', body: 'You have benefits expiring soon' },
        android: { priority: 'HIGH', notification: { channel_id: 'reminders' } },
      };

const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
  method: 'POST',
  headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ message }),
});
console.log(`${mode} message at ${new Date(Number(sentAt)).toISOString()}: ${res.status} ${await res.text()}`);
