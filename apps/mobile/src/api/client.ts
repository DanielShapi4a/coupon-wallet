import * as SecureStore from 'expo-secure-store';
import { AuthTokens } from '@cw/shared';
import { signInWithGoogle } from '../../modules/credentials';

// Set in apps/mobile/.env (see .env.example).
const API_URL = process.env.EXPO_PUBLIC_API_URL;
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

// The refresh token survives restarts in SecureStore; the access token lives in memory only.
const REFRESH_TOKEN = 'refresh_token';
let accessToken: string | null = null;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function requireConfig(): { apiUrl: string; webClientId: string } {
  if (!API_URL || !GOOGLE_WEB_CLIENT_ID) throw new Error('EXPO_PUBLIC_API_URL and EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID must be set');
  return { apiUrl: API_URL, webClientId: GOOGLE_WEB_CLIENT_ID };
}

async function saveTokens(tokens: AuthTokens): Promise<void> {
  accessToken = tokens.accessToken;
  await SecureStore.setItemAsync(REFRESH_TOKEN, tokens.refreshToken);
}

async function postTokens(path: string, body: unknown): Promise<AuthTokens | null> {
  const res = await fetch(`${requireConfig().apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, `${path} failed`);
  return AuthTokens.parse(await res.json());
}

/** Google's account picker, then a session with our server. */
export async function signIn(): Promise<void> {
  const idToken = await signInWithGoogle(requireConfig().webClientId);
  const tokens = await postTokens('/auth/google', { idToken });
  if (!tokens) throw new Error('The server did not accept the Google sign-in');
  await saveTokens(tokens);
}

export async function isSignedIn(): Promise<boolean> {
  return (await SecureStore.getItemAsync(REFRESH_TOKEN)) !== null;
}

/** Ends the session on the server too. Best effort: signing out works offline, the server copy then expires. */
export async function signOut(): Promise<void> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN);
  accessToken = null;
  await SecureStore.deleteItemAsync(REFRESH_TOKEN);
  if (refreshToken && API_URL) {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }
}

/** Drops the local session only, without telling the server (the server already ended it). */
export async function dropLocalSession(): Promise<void> {
  accessToken = null;
  await SecureStore.deleteItemAsync(REFRESH_TOKEN);
}

/** Trades the stored refresh token for a new pair. False means the session is over. */
async function refresh(): Promise<boolean> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN);
  const tokens = refreshToken ? await postTokens('/auth/refresh', { refreshToken }) : null;
  if (!tokens) {
    await dropLocalSession();
    return false;
  }
  await saveTokens(tokens);
  return true;
}

/** An authenticated request. Refreshes the access token once on 401, then retries. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { apiUrl } = requireConfig();
  const send = () =>
    fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers, authorization: `Bearer ${accessToken ?? ''}` },
    });

  if (!accessToken && !(await refresh())) throw new ApiError(401, 'Not signed in');
  let res = await send();
  if (res.status === 401) {
    if (!(await refresh())) throw new ApiError(401, 'Session expired, sign in again');
    res = await send();
  }
  return res;
}
