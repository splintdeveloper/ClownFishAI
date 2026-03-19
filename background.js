'use strict';

// ─── Context Menus ────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'docplus-search',
      title: 'DocPlus: AI Writer selection',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id: 'docplus-check',
      title: 'DocPlus: Check for AI content',
      contexts: ['selection'],
    });

    chrome.contextMenus.create({
      id: 'docplus-rewrite',
      title: 'DocPlus: Humanize selection',
      contexts: ['selection'],
    });
  });
});

// ─── Context Menu Click Handler ───────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  const selectedText = info.selectionText || '';

  const actionMap = {
    'docplus-search': 'aiSearch',
    'docplus-check': 'aiChecker',
    'docplus-rewrite': 'aiRewriter',
  };

  const targetTab = actionMap[info.menuItemId];
  if (!targetTab) return;

  // Store the pending context text and which tab to open
  chrome.storage.local.set({
    contextPending: {
      tab: targetTab,
      text: selectedText,
      timestamp: Date.now(),
    },
  });

  // Open the popup (we can't programmatically open popup in MV3, so we
  // use a notification-style badge and the user opens the popup)
  chrome.action.setBadgeText({ text: '!', tabId: tab.id });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId: tab.id });

  // Clear badge after 8 seconds
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId: tab.id });
  }, 8000);
});

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }

  // ─── Google Docs API Fetch ────────────────────────────────────────────────
  // Uses chrome.identity.getAuthToken() (no extra login — uses the user's
  // existing Chrome/Google account) then calls the official Docs REST API.
  // This is the most reliable method and works on school accounts.
  if (message.action === 'fetchGDocsAPI') {
    const { docId } = message;
    (async () => {
      try {
        // Use the Google access token stored when the user signed in with Google.
        // This guarantees From Doc uses the exact account they chose, not Chrome's
        // primary profile account.
        const { cf_user } = await chrome.storage.local.get('cf_user');
        if (!cf_user?.googleAccessToken) {
          sendResponse({ notSignedIn: true });
          return;
        }

        let token = cf_user.googleAccessToken;

        // Silently refresh if the token is expired (no UI shown).
        if (Date.now() > (cf_user.googleTokenExpiry || 0)) {
          const clientId   = '412993352953-ke3ldvhstuqpnqjdeoaqlma84neomm97.apps.googleusercontent.com';
          const redirectUri = chrome.identity.getRedirectURL();
          const scopes = [
            'openid', 'email', 'profile',
            'https://www.googleapis.com/auth/documents.readonly',
          ];
          const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
          authUrl.searchParams.set('client_id',     clientId);
          authUrl.searchParams.set('response_type', 'token');
          authUrl.searchParams.set('redirect_uri',  redirectUri);
          authUrl.searchParams.set('scope',         scopes.join(' '));
          authUrl.searchParams.set('prompt',        'none');
          authUrl.searchParams.set('login_hint',    cf_user.email);

          const refreshed = await new Promise((resolve) => {
            chrome.identity.launchWebAuthFlow(
              { url: authUrl.toString(), interactive: false },
              (redirectUrl) => {
                if (chrome.runtime.lastError || !redirectUrl) { resolve(null); return; }
                const params  = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
                const tok     = params.get('access_token');
                const expiry  = Date.now() + (parseInt(params.get('expires_in') || '3600', 10) - 60) * 1000;
                if (tok) {
                  // Persist the refreshed token
                  chrome.storage.local.get('cf_user', ({ cf_user: u }) => {
                    if (u) { u.googleAccessToken = tok; u.googleTokenExpiry = expiry; chrome.storage.local.set({ cf_user: u }); }
                  });
                }
                resolve(tok || null);
              }
            );
          });

          if (!refreshed) { sendResponse({ notSignedIn: true }); return; }
          token = refreshed;
        }

        const res = await fetch(
          `https://docs.googleapis.com/v1/documents/${docId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!res.ok) {
          sendResponse({ error: `HTTP ${res.status}` });
          return;
        }

        const doc = await res.json();

        function extractText(contentArr) {
          let out = '';
          for (const elem of (contentArr || [])) {
            if (elem.paragraph) {
              for (const pe of (elem.paragraph.elements || [])) {
                if (pe.textRun?.content) out += pe.textRun.content;
              }
            } else if (elem.table) {
              for (const row of (elem.table.tableRows || [])) {
                for (const cell of (row.tableCells || [])) {
                  out += extractText(cell.content);
                }
              }
            }
          }
          return out;
        }

        const text = extractText(doc.body?.content).trim();
        sendResponse({ text });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // ─── Google Docs Export Fetch ─────────────────────────────────────────────
  // Fetched from the service worker (not the content script) so it bypasses
  // CORB. The user's active Google session cookie is included automatically.
  if (message.action === 'fetchGDocsExport') {
    const { docId, authUser } = message;
    (async () => {
      try {
        const res = await fetch(
          `https://docs.google.com/document/d/${docId}/export?format=txt&authuser=${authUser || '0'}`,
          { credentials: 'include' }
        );
        if (!res.ok) { sendResponse({ error: `HTTP ${res.status}` }); return; }
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('text/html')) { sendResponse({ error: 'blocked' }); return; }
        const text = (await res.text()).trim();
        sendResponse({ text });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // ─── Google Docs Mobile (mobilebasic) Fetch ────────────────────────────────
  // /mobilebasic renders as plain HTML (no canvas) using browser session cookies.
  // Often works on school accounts even when the export endpoint is DLP-blocked.
  if (message.action === 'fetchGDocsMobile') {
    const { docId } = message;
    (async () => {
      try {
        const res = await fetch(
          `https://docs.google.com/document/d/${docId}/mobilebasic`,
          { credentials: 'include' }
        );
        if (!res.ok) { sendResponse({ error: `HTTP ${res.status}` }); return; }
        const html = await res.text();
        if (html.includes('ServiceLogin') || html.includes('/o/oauth2')) {
          sendResponse({ error: 'not authenticated' }); return;
        }
        const text = html
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        sendResponse({ text });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.action === 'openPopupForSelection') {
    // chrome.action.openPopup() requires Chrome 127+
    if (chrome.action.openPopup) {
      chrome.action.openPopup().catch(() => showSelectionBadge(sender.tab?.id));
    } else {
      showSelectionBadge(sender.tab?.id);
    }
    sendResponse({ ok: true });
  }

  // ─── Google Firebase Exchange ───────────────────────────────────────────────
  // The popup gets the Google access token (requires UI context), then hands it
  // here so the Firebase exchange + storage happen in the background worker —
  // surviving a popup close if the user clicks away mid-flow.
  if (message.action === 'googleFirebaseExchange') {
    const { token, firebaseApiKey, redirectUri } = message;
    (async () => {
      try {
        const firebaseRes = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${firebaseApiKey}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              postBody:            `access_token=${token}&providerId=google.com`,
              requestUri:          redirectUri,
              returnIdpCredential: true,
              returnSecureToken:   true,
            }),
          }
        );
        if (!firebaseRes.ok) {
          const err = await firebaseRes.json().catch(() => ({}));
          try { sendResponse({ error: err.error?.message || 'Google sign-in failed' }); } catch (_) {}
          return;
        }
        const fbUser = await firebaseRes.json();
        const stored = {
          uid:          fbUser.localId,
          email:        fbUser.email       || '',
          displayName:  fbUser.displayName || fbUser.email || 'User',
          idToken:      fbUser.idToken,
          refreshToken: fbUser.refreshToken,
          expiresAt:    Date.now() + 3500 * 1000,
        };
        await chrome.storage.local.set({ cf_user: stored });
        try { sendResponse({ user: stored }); } catch (_) {}
      } catch (e) {
        try { sendResponse({ error: e.message }); } catch (_) {}
      }
    })();
  }

  return true;
});

function showSelectionBadge(tabId) {
  if (!tabId) return;
  chrome.action.setBadgeText({ text: '✓', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#f97316', tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 8000);
}
