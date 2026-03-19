'use strict';

// ─── ClownFish Auth + Subscription (Firebase REST — no SDK required) ──────────
// Depends on: config.js (must be loaded first in popup.html)
/* global CLOWNFISH_CONFIG, chrome */

// ─── Email / Password Sign-In ─────────────────────────────────────────────────
async function signInWithEmail(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CLOWNFISH_CONFIG.firebaseApiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || 'Sign-in failed';
    if (msg.includes('INVALID_PASSWORD') || msg.includes('EMAIL_NOT_FOUND') || msg.includes('INVALID_LOGIN_CREDENTIALS')) {
      throw new Error('Invalid email or password.');
    }
    throw new Error(msg);
  }
  const fbUser = await res.json();
  const stored = {
    uid:          fbUser.localId,
    email:        fbUser.email       || '',
    displayName:  fbUser.displayName || fbUser.email || 'User',
    idToken:      fbUser.idToken,
    refreshToken: fbUser.refreshToken,
    expiresAt:    Date.now() + 3500 * 1000,
  };
  await chrome.storage.local.set({ cf_user: stored });
  return stored;
}

// ─── Email / Password Sign-Up ─────────────────────────────────────────────────
async function signUpWithEmail(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${CLOWNFISH_CONFIG.firebaseApiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || 'Sign-up failed';
    if (msg.includes('EMAIL_EXISTS'))   throw new Error('An account with this email already exists.');
    if (msg.includes('WEAK_PASSWORD'))  throw new Error('Password must be at least 6 characters.');
    if (msg.includes('INVALID_EMAIL'))  throw new Error('Please enter a valid email address.');
    throw new Error(msg);
  }
  const fbUser = await res.json();
  const stored = {
    uid:          fbUser.localId,
    email:        fbUser.email       || '',
    displayName:  fbUser.displayName || fbUser.email || 'User',
    idToken:      fbUser.idToken,
    refreshToken: fbUser.refreshToken,
    expiresAt:    Date.now() + 3500 * 1000,
  };
  await chrome.storage.local.set({ cf_user: stored });
  return stored;
}

// ─── Saved Accounts ───────────────────────────────────────────────────────────
// Persists up to 5 previously-signed-in Google accounts so users can switch
// without going through the full OAuth flow every time.

async function _saveAccountToHistory(user) {
  if (!user?.uid) return;
  const { cf_saved_accounts = [] } = await chrome.storage.local.get('cf_saved_accounts');
  const entry = {
    uid:               user.uid,
    email:             user.email,
    displayName:       user.displayName,
    refreshToken:      user.refreshToken,
    googleAccessToken: user.googleAccessToken || null,
    googleTokenExpiry: user.googleTokenExpiry || 0,
    lastUsed:          Date.now(),
  };
  const idx = cf_saved_accounts.findIndex(a => a.uid === user.uid);
  if (idx >= 0) cf_saved_accounts[idx] = entry;
  else cf_saved_accounts.unshift(entry);
  await chrome.storage.local.set({ cf_saved_accounts: cf_saved_accounts.slice(0, 5) });
}

async function getSavedAccounts() {
  const { cf_saved_accounts = [] } = await chrome.storage.local.get('cf_saved_accounts');
  return cf_saved_accounts.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

// Sign in using a previously saved account via Firebase refresh token.
// No Google OAuth popup needed — uses the long-lived Firebase refresh token.
async function signInWithSavedAccount(savedAccount) {
  const refreshed = await _refreshIdToken(savedAccount.refreshToken);
  const stored = {
    uid:               savedAccount.uid,
    email:             savedAccount.email,
    displayName:       savedAccount.displayName,
    idToken:           refreshed.id_token,
    refreshToken:      refreshed.refresh_token || savedAccount.refreshToken,
    expiresAt:         Date.now() + parseInt(refreshed.expires_in || '3600', 10) * 1000,
    googleAccessToken: savedAccount.googleAccessToken || null,
    googleTokenExpiry: savedAccount.googleTokenExpiry || 0,
  };
  await chrome.storage.local.set({ cf_user: stored });
  await _saveAccountToHistory(stored);
  return stored;
}

// ─── Token Management ─────────────────────────────────────────────────────────
async function getCurrentUser() {
  const { cf_user } = await chrome.storage.local.get('cf_user');
  return cf_user || null;
}

async function signOut() {
  await chrome.storage.local.remove(['cf_user', 'cf_subscribed']);
}

async function _refreshIdToken(refreshToken) {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${CLOWNFISH_CONFIG.firebaseApiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    }
  );
  if (!res.ok) throw new Error('Token refresh failed — please sign in again');
  return res.json(); // { id_token, expires_in, refresh_token, ... }
}

// Returns a valid Firebase ID token, refreshing silently if near expiry.
// Returns null if the user is not signed in or if refresh fails.
async function getValidIdToken() {
  const user = await getCurrentUser();
  if (!user) return null;

  // Refresh if less than 60 seconds remain
  if (Date.now() > user.expiresAt - 60_000) {
    try {
      const refreshed = await _refreshIdToken(user.refreshToken);
      user.idToken   = refreshed.id_token;
      user.expiresAt = Date.now() + parseInt(refreshed.expires_in, 10) * 1000;
      if (refreshed.refresh_token) user.refreshToken = refreshed.refresh_token;
      await chrome.storage.local.set({ cf_user: user });
    } catch (_) {
      // Refresh failed — return null but keep stored user data so the
      // user stays visually signed-in and can retry when connectivity returns.
      return null;
    }
  }

  return user.idToken;
}

// ─── Subscription Check (Firestore REST) ─────────────────────────────────────
async function checkSubscription(uid, idToken) {
  try {
    const url =
      `https://firestore.googleapis.com/v1/projects/${CLOWNFISH_CONFIG.firebaseProjectId}` +
      `/databases/(default)/documents/users/${uid}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return false;
    const doc = await res.json();
    return doc.fields?.subscribed?.booleanValue === true;
  } catch (_) {
    return false;
  }
}

// ─── Google Sign-In (launchWebAuthFlow → Firebase signInWithIdp) ─────────────
// Uses launchWebAuthFlow with prompt=select_account so the user always gets an
// account picker — they can switch Google accounts at any time.
// The resulting access token is also stored so "From Doc" can call the Docs API
// using the exact account the user chose.
async function signInWithGoogle() {
  const redirectUri = chrome.identity.getRedirectURL();
  const scopes = [
    'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/documents.readonly',
  ];

  const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
  authUrl.searchParams.set('client_id',     CLOWNFISH_CONFIG.googleClientId);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('scope',         scopes.join(' '));
  // select_account = show account picker
  // consent        = never auto-resume an existing session, always show the flow
  // max_age=0      = treat any existing session as expired
  authUrl.searchParams.set('prompt',   'select_account consent');
  authUrl.searchParams.set('max_age',  '0');

  // Step 1 — show account picker, get a Google access token
  const { token: accessToken, expiry: googleTokenExpiry } = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in cancelled'));
          return;
        }
        const params  = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
        const token   = params.get('access_token');
        const expiry  = Date.now() + (parseInt(params.get('expires_in') || '3600', 10) - 60) * 1000;
        if (!token) { reject(new Error('No access token in response')); return; }
        resolve({ token, expiry });
      }
    );
  });

  // Step 2 — exchange the Google access token for a Firebase session
  const firebaseRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${CLOWNFISH_CONFIG.firebaseApiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        postBody:            `access_token=${accessToken}&providerId=google.com`,
        requestUri:          redirectUri,
        returnIdpCredential: true,
        returnSecureToken:   true,
      }),
    }
  );

  if (!firebaseRes.ok) {
    const err = await firebaseRes.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Google sign-in failed');
  }

  const fbUser = await firebaseRes.json();
  const stored = {
    uid:                fbUser.localId,
    email:              fbUser.email       || '',
    displayName:        fbUser.displayName || fbUser.email || 'User',
    idToken:            fbUser.idToken,
    refreshToken:       fbUser.refreshToken,
    expiresAt:          Date.now() + 3500 * 1000,
    googleAccessToken:  accessToken,       // used by "From Doc" → Docs API
    googleTokenExpiry,                     // epoch ms when the above token expires
  };
  await chrome.storage.local.set({ cf_user: stored });
  await _saveAccountToHistory(stored);
  return stored;
}

// ─── Promo Code Redemption (via Cloud Function) ───────────────────────────────
async function redeemPromoCode(idToken, code) {
  const base = CLOWNFISH_CONFIG.cloudFunctionsBase;
  if (!base || base.includes('YOUR_PROJECT')) {
    throw new Error('Cloud Functions URL not configured in config.js');
  }

  const res = await fetch(`${base}/redeemPromoCode`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ code }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) throw new Error('Cloud Functions not deployed yet — run: firebase deploy --only functions');
    throw new Error(data.message || `Server error (${res.status})`);
  }
  return data; // { success: true }
}

// ─── Stripe Checkout (via Cloud Function) ────────────────────────────────────
async function createCheckoutSession(idToken) {
  const base = CLOWNFISH_CONFIG.cloudFunctionsBase;
  if (!base || base.includes('YOUR_PROJECT')) {
    throw new Error('Cloud Functions URL not configured in config.js');
  }

  const res = await fetch(`${base}/createCheckoutSession`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status} from Cloud Function`);
  }

  const data = await res.json();
  if (!data.url) throw new Error('No checkout URL returned from Cloud Function');
  return data.url;
}
