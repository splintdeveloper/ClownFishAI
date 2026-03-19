'use strict';

// ─── ClownFish Extension Configuration ────────────────────────────────────────
// Fill in these values after completing the setup steps below.
// ─────────────────────────────────────────────────────────────────────────────
//
// STEP 1 — Firebase Project (console.firebase.google.com)
//   • Create a new project
//   • Authentication → Sign-in method → Enable Google
//   • Firestore Database → Create database (production mode)
//   • Project Settings → Your apps → Add Web App → copy the config values
//
// STEP 2 — Google OAuth Client (console.cloud.google.com)
//   • Same project Firebase created → APIs & Services → Credentials
//   • Create Credentials → OAuth 2.0 Client ID → Web application
//   • Authorized redirect URIs → add:
//       https://YOUR_EXTENSION_ID.chromiumapp.org/
//     (get the extension ID from chrome://extensions after loading unpacked)
//   • Copy the Client ID
//
// STEP 3 — Cloud Functions
//   After deploying functions/index.js, the base URL is:
//       https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net
//
// ─────────────────────────────────────────────────────────────────────────────

/* global CLOWNFISH_CONFIG */
// eslint-disable-next-line no-unused-vars
const CLOWNFISH_CONFIG = {
  // From Firebase Project Settings → General → Your apps → firebaseConfig
  firebaseApiKey:    'AIzaSyCuPkldUh1gez5qUacqMyGZzA-2MaX8TnI',
  firebaseProjectId: 'clownfishai',

  // Web application OAuth client ID (used for launchWebAuthFlow account picker)
  googleClientId:    '412993352953-ke3ldvhstuqpnqjdeoaqlma84neomm97.apps.googleusercontent.com',

  // Firebase Cloud Functions base URL
  cloudFunctionsBase: 'https://us-central1-clownfishai.cloudfunctions.net',
};
