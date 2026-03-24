'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(action, data = {}) {
  const tab = await getActiveTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { action, ...data });
  } catch (e) {
    return null;
  }
}

async function getSelectedText() {
  const res = await sendToContent('getSelectedText');
  return res?.text || '';
}

function setLoading(btn, loading, text = '') {
  if (loading) {
    btn.disabled = true;
    btn.dataset.orig = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span> ${text}`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.orig || btn.innerHTML;
  }
}

// ─── Auth State ───────────────────────────────────────────────────────────────
let currentUser  = null;

// ─── Provider endpoints ───────────────────────────────────────────────────────
const ENDPOINTS = {
  groq:   { url: 'https://api.groq.com/openai/v1/chat/completions',   defaultModel: 'llama-3.3-70b-versatile' },
  openai: { url: 'https://api.openai.com/v1/chat/completions',         defaultModel: 'gpt-4o-mini' },
};

// ─── AI API call (works with both Groq and OpenAI) ────────────────────────────
async function callOpenAI({ system, user, json = false, temperature = 0.3 }) {
  const data = await chrome.storage.local.get(['apiKey', 'model', 'provider']);
  const apiKey   = data.apiKey;
  const provider = data.provider || 'groq';
  const ep       = ENDPOINTS[provider] || ENDPOINTS.groq;
  const model    = data.model || ep.defaultModel;

  if (!apiKey) throw new Error('NO_API_KEY');

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
  };

  // Only apply json_object format for non-checker calls.
  // Some Groq model versions output stub JSON when this flag is set with
  // complex scoring prompts — callers that need it still pass json:true.
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }

  const result = await res.json();
  return result.choices[0].message.content;
}

// ─── JSON extractor ───────────────────────────────────────────────────────────
// Parses JSON from a raw model response regardless of whether the model wrapped
// it in a markdown code fence or returned it bare.  More reliable than relying
// on response_format:'json_object', which causes some Groq model versions to
// output a minimal stub instead of following the scoring instructions.
function extractJSON(text) {
  // 1. Already clean JSON
  try { return JSON.parse(text); } catch (_) {}
  // 2. Wrapped in ```json ... ``` or ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }
  // 3. Find the outermost { … } block
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  throw new Error('Could not parse JSON from AI response');
}

// ─── Auto Type Helper ─────────────────────────────────────────────────────────
// Sends text to the Auto Typer panel, navigates there, and kicks off targeting.
function sendToAutoTyper(text) {
  if (!text || !text.trim()) return;
  $('typer-text').value = text.trim();
  openPanel('autoTyper');
  $('typer-start-btn').click(); // triggers targeting mode and closes popup
}

// Generic copy helper with green flash feedback
function copyWithFeedback(btn, text) {
  if (!text || !text.trim()) return;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.color = '#10b981';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
  });
}

// Pulls text from the active tab's document into a textarea.
// Works with Google Docs, Google Classroom, Canvas LMS, and regular web pages.
async function loadFromDoc(btn, textareaId) {
  const orig = btn.textContent;
  btn.textContent = 'Loading…';
  btn.disabled = true;
  try {
    const res = await sendToContent('getPageText');

    const text = res?.text?.trim() || '';
    if (!text) {
      btn.textContent = 'No text found';
      btn.style.color = '#ef4444';
      btn.title = 'Could not read the document. If it\'s a school Google Doc, try: select all text (Ctrl+A), copy (Ctrl+C), then paste into the text area manually.';
      const reloadHint = document.createElement('p');
      reloadHint.textContent = 'Try reloading the tab';
      reloadHint.style.cssText = 'color:#ef4444;font-size:11px;margin:4px 0 0;text-align:right;';
      const row = btn.closest('.row.space') || btn.parentElement;
      row.parentElement.insertBefore(reloadHint, row.nextSibling);
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.title = ''; btn.disabled = false; reloadHint.remove(); }, 4000);
      return;
    }
    $(textareaId).value = text;
    $(textareaId).dispatchEvent(new Event('input'));
    btn.textContent = 'Loaded!';
    btn.style.color = '#10b981';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.disabled = false; }, 1500);
  } catch {
    btn.textContent = 'Error';
    btn.style.color = '#ef4444';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.disabled = false; }, 2000);
  }
}

// ─── Wheel Navigation ─────────────────────────────────────────────────────────
const PANEL_NAMES = {
  autoTyper:    'Auto Typer',
  aiChecker:    'AI Checker',
  aiRewriter:   'Rewriter',
  aiSearch:     'Problem Solver',
  aiCite:       'Citations',
  aiSummarize:  'Summarize',
};

function openPanel(tabId) {
  const panelId = tabId;
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${panelId}`);
  });
  $('panel-title').textContent = PANEL_NAMES[panelId] || panelId;
  $('wheel-view').classList.add('hidden');
  $('panel-view').classList.remove('hidden');
  // Highlight the active tool in the quick nav row
  document.querySelectorAll('.tqn-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
}

function returnToWheel() {
  $('panel-view').classList.add('hidden');
  $('wheel-view').classList.remove('hidden');
}

// ─── Tool Mode Switcher (AI Checker ↔ Fact Check | AI Writer ↔ Problem Solver) ─
function switchCheckerMode(mode) {
  document.querySelectorAll('#panel-aiChecker .tool-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('checker-aicheck-section').classList.toggle('hidden', mode !== 'aicheck');
  $('checker-factcheck-section').classList.toggle('hidden', mode !== 'factcheck');
}

function switchSolverMode(mode) {
  document.querySelectorAll('#panel-aiSearch .tool-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('solver-writer-section').classList.toggle('hidden', mode !== 'writer');
  $('solver-problems-section').classList.toggle('hidden', mode !== 'problems');
}

document.querySelectorAll('#panel-aiChecker .tool-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchCheckerMode(btn.dataset.mode));
});

document.querySelectorAll('#panel-aiSearch .tool-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSolverMode(btn.dataset.mode));
});

document.querySelectorAll('.wheel-item').forEach((item) => {
  item.addEventListener('click', () => openPanel(item.dataset.tab));
});

$('back-btn').addEventListener('click', returnToWheel);

// ─── Spin (click the center clownfish logo) ───────────────────────────────────
let _wheelAngle = 0;
let _spinEndTimer = null;

function spinWheel() {
  const center  = $('wheel-center');
  const spinner = $('wheel-spinner');
  const inners  = document.querySelectorAll('#wheel-spinner .wi-inner');

  const durS = 1.75;
  const ease = 'cubic-bezier(0.25, 0.1, 0.25, 1.0)';
  _wheelAngle += 0.75 * 360; // 0.75 rotations to the right each click

  spinner.style.transition = `transform ${durS}s ${ease}`;
  spinner.style.transform  = `rotate(${_wheelAngle}deg)`;

  Array.from(inners).forEach(el => {
    el.style.transition = `transform ${durS}s ${ease}`;
    el.style.transform  = `rotate(${-_wheelAngle}deg)`;
  });

  center.classList.add('spinning');
  clearTimeout(_spinEndTimer);
  _spinEndTimer = setTimeout(() => {
    center.classList.remove('spinning');
  }, durS * 1000 + 200);
}

$('wheel-center').addEventListener('click', spinWheel);

// ─── Settings / Header ────────────────────────────────────────────────────────
$('settings-btn').addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openOptions' }));
$('footer-settings').addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openOptions' }));
$('api-link')?.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openOptions' }));

// ─── FAQ Modal ────────────────────────────────────────────────────────────────
$('faq-btn').addEventListener('click', () => $('faq-modal').classList.remove('hidden'));
$('faq-close').addEventListener('click', () => $('faq-modal').classList.add('hidden'));
$('faq-modal').addEventListener('click', (e) => { if (e.target === $('faq-modal')) $('faq-modal').classList.add('hidden'); });

// ─── Quick tool nav row ───────────────────────────────────────────────────────
document.querySelectorAll('.tqn-btn').forEach(btn => {
  btn.addEventListener('click', () => openPanel(btn.dataset.tab));
});

// ─── Auth UI ──────────────────────────────────────────────────────────────────
function updateAuthUI(user) {
  $('auth-signed-out').classList.add('hidden');
  $('auth-pro').classList.add('hidden');
  $('logout-btn').classList.toggle('hidden', !user);

  if (!user) {
    $('auth-signed-out').classList.remove('hidden');
  } else {
    const initial = (user.email || 'U').charAt(0).toUpperCase();
    $('user-avatar-pro').textContent = initial;
    $('user-email-pro').textContent  = user.email;
    $('auth-pro').classList.remove('hidden');
  }
}

// ─── Auth Modal ───────────────────────────────────────────────────────────────
let _authIsSignUp = false;

function showAuthModal(isSignUp = false) {
  _authIsSignUp = isSignUp;
  $('auth-modal-title').textContent  = isSignUp ? 'Create Account' : 'Sign In';
  $('auth-submit-btn').textContent   = isSignUp ? 'Create Account' : 'Sign In';
  $('auth-toggle-btn').textContent   = isSignUp
    ? 'Already have an account? Sign in'
    : "Don't have an account? Create one";
  $('auth-error').classList.add('hidden');
  $('auth-email').value    = '';
  $('auth-password').value = '';
  $('auth-modal').classList.remove('hidden');
  setTimeout(() => $('auth-email').focus(), 50);

  // Load saved accounts
  _renderSavedAccounts();
}

async function _renderSavedAccounts() {
  const section = $('saved-accounts-section');
  const list    = $('saved-accounts-list');
  const accounts = await getSavedAccounts();

  if (!accounts.length) {
    section.classList.add('hidden');
    return;
  }

  list.innerHTML = '';
  accounts.forEach(acct => {
    const initial = (acct.displayName || acct.email || '?')[0].toUpperCase();
    const btn = document.createElement('button');
    btn.className = 'saved-acct-btn';
    btn.innerHTML = `
      <span class="saved-acct-avatar">${initial}</span>
      <span class="saved-acct-info">
        <span class="saved-acct-name">${acct.displayName || acct.email}</span>
        <span class="saved-acct-email">${acct.email}</span>
      </span>
    `;
    btn.addEventListener('click', async () => {
      const errEl = $('auth-error');
      errEl.classList.add('hidden');
      btn.disabled = true;
      try {
        currentUser = await signInWithSavedAccount(acct);
        updateAuthUI(currentUser);
        $('auth-modal').classList.add('hidden');
        await checkAndShowPaywall(currentUser);
      } catch (e) {
        errEl.textContent = e.message || 'Could not sign in — please use Google sign-in.';
        errEl.classList.remove('hidden');
        btn.disabled = false;
      }
    });
    list.appendChild(btn);
  });

  section.classList.remove('hidden');
}

async function _submitAuth() {
  const email    = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const errEl    = $('auth-error');
  const btn      = $('auth-submit-btn');

  if (!email || !password) {
    errEl.textContent = 'Please enter your email and password.';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled    = true;
  btn.textContent = _authIsSignUp ? 'Creating…' : 'Signing in…';
  errEl.classList.add('hidden');

  try {
    currentUser = _authIsSignUp
      ? await signUpWithEmail(email, password)
      : await signInWithEmail(email, password);
    updateAuthUI(currentUser);
    $('auth-modal').classList.add('hidden');
    await checkAndShowPaywall(currentUser);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    btn.disabled    = false;
    btn.textContent = _authIsSignUp ? 'Create Account' : 'Sign In';
  }
}

$('sign-in-btn').addEventListener('click', () => showAuthModal(false));
$('auth-modal-close').addEventListener('click', () => $('auth-modal').classList.add('hidden'));
$('auth-toggle-btn').addEventListener('click', () => showAuthModal(!_authIsSignUp));
$('auth-submit-btn').addEventListener('click', _submitAuth);

// Allow Enter key to submit
['auth-email', 'auth-password'].forEach(id => {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') _submitAuth(); });
});

// Sign Out (auth bar button + header logout button both call this)
async function _doSignOut() {
  await signOut();
  currentUser = null;
  updateAuthUI(null);
  _showPaywallView(false); // signed out → show paywall with sign-in prompt
}

$('sign-out-btn').addEventListener('click', _doSignOut);
$('logout-btn').addEventListener('click', _doSignOut);

// Google Sign-In — uses launchWebAuthFlow with account picker (auth.js)
$('google-signin-btn').addEventListener('click', async () => {
  const btn   = $('google-signin-btn');
  const errEl = $('auth-error');
  errEl.classList.add('hidden');
  btn.disabled = true;
  const GOOGLE_BTN_HTML = btn.innerHTML;
  btn.textContent = 'Connecting…';

  try {
    const user = await signInWithGoogle();
    currentUser = user;
    updateAuthUI(currentUser);
    $('auth-modal').classList.add('hidden');
    await checkAndShowPaywall(currentUser);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = GOOGLE_BTN_HTML;
  }
});


// ─── Paywall ──────────────────────────────────────────────────────────────────
async function checkAndShowPaywall(user) {
  if (!user) { _showPaywallView(false); return; }

  // Instant local cache check — avoids a Firestore round-trip on every open
  const { cf_subscribed } = await chrome.storage.local.get('cf_subscribed');
  if (cf_subscribed) { _hidePaywall(); return; }

  // Verify against Firestore (network call)
  try {
    const idToken = await getValidIdToken();
    if (idToken) {
      const subscribed = await checkSubscription(user.uid, idToken);
      if (subscribed) {
        await chrome.storage.local.set({ cf_subscribed: true });
        _hidePaywall();
        return;
      }
    }
  } catch (_) {}

  _showPaywallView(true);
}

function _showPaywallView(isSignedIn) {
  $('wheel-view').classList.add('hidden');
  $('panel-view').classList.add('hidden');
  $('paywall-view').classList.remove('hidden');
  $('paywall-actions').classList.toggle('hidden', !isSignedIn);
  $('paywall-signin-prompt').classList.toggle('hidden', isSignedIn);
  $('paywall-error').classList.add('hidden');
}

function _hidePaywall() {
  $('paywall-view').classList.add('hidden');
  $('wheel-view').classList.remove('hidden');
}

// "Unlock for $0.99" — open Stripe Checkout in a new tab
$('paywall-buy-btn').addEventListener('click', async () => {
  const btn = $('paywall-buy-btn');
  setLoading(btn, true, 'Opening checkout…');
  $('paywall-error').classList.add('hidden');
  try {
    const idToken = await getValidIdToken();
    if (!idToken) throw new Error('Please sign in first.');
    const url = await createCheckoutSession(idToken);
    chrome.tabs.create({ url });
  } catch (e) {
    $('paywall-error').textContent = e.message;
    $('paywall-error').classList.remove('hidden');
    setLoading(btn, false);
  }
});

// "I've already paid" — re-check Firestore
$('paywall-paid-btn').addEventListener('click', async () => {
  const btn = $('paywall-paid-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  $('paywall-error').classList.add('hidden');
  try {
    const user = await getCurrentUser();
    const idToken = await getValidIdToken();
    if (idToken && user) {
      const subscribed = await checkSubscription(user.uid, idToken);
      if (subscribed) {
        await chrome.storage.local.set({ cf_subscribed: true });
        _hidePaywall();
        return;
      }
    }
    $('paywall-error').textContent = 'No payment found yet — complete checkout first.';
    $('paywall-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = "I've already paid →";
  }
});

// Promo code
$('paywall-promo-btn').addEventListener('click', async () => {
  const code = $('paywall-promo-input').value.trim();
  if (!code) return;
  const btn = $('paywall-promo-btn');
  setLoading(btn, true, '…');
  $('paywall-error').classList.add('hidden');
  try {
    const idToken = await getValidIdToken();
    if (!idToken) throw new Error('Please sign in first.');
    await redeemPromoCode(idToken, code);
    await chrome.storage.local.set({ cf_subscribed: true });
    _hidePaywall();
  } catch (e) {
    $('paywall-error').textContent = e.message;
    $('paywall-error').classList.remove('hidden');
    setLoading(btn, false);
  }
});

$('paywall-promo-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('paywall-promo-btn').click();
});

// "Sign in" from paywall — reuse existing auth modal
$('paywall-signin-btn').addEventListener('click', () => showAuthModal(false));

// ─── On Popup Load ────────────────────────────────────────────────────────────
(async function init() {
  // ── Auth check ────────────────────────────────────────────────────────────
  // Load stored user and show as signed-in immediately — no network call.
  // Token is refreshed lazily the first time a feature needs it.
  currentUser = await getCurrentUser();
  updateAuthUI(currentUser);
  await checkAndShowPaywall(currentUser);

  // ── Text references ───────────────────────────────────────────────────────
  _initRefs();

  // ── Dark mode ─────────────────────────────────────────────────────────────
  const { cf_dark_mode } = await chrome.storage.local.get('cf_dark_mode');
  if (cf_dark_mode) document.body.classList.add('dark');
  _updateDarkBtn(cf_dark_mode);

  $('darkmode-btn').addEventListener('click', async () => {
    const isDark = document.body.classList.toggle('dark');
    await chrome.storage.local.set({ cf_dark_mode: isDark });
    _updateDarkBtn(isDark);
  });

  function _updateDarkBtn(isDark) {
    $('darkmode-btn').innerHTML = isDark
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
      : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    $('darkmode-btn').title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  // Check API key
  const data = await chrome.storage.local.get([
    'apiKey', 'defaultWpm', 'defaultRandomness',
    'typerRunning', 'typerProgress', 'typerComplete',
    'contextPending', 'selectionPending',
    'saved_typer', 'saved_checker', 'saved_rewriter',
    'saved_writer', 'saved_cite', 'saved_facts', 'saved_summarize',
  ]);

  if (!data.apiKey) {
    $('api-warning').classList.remove('hidden');
  }

  // Restore persisted textarea content
  if (data.saved_typer)      $('typer-text').value       = data.saved_typer;
  if (data.saved_checker)   $('checker-text').value     = data.saved_checker;
  if (data.saved_rewriter)  $('rewriter-input').value   = data.saved_rewriter;
  if (data.saved_writer)    $('writer-input').value     = data.saved_writer;
  if (data.saved_cite)      $('cite-text').value        = data.saved_cite;
  if (data.saved_facts)     $('facts-text').value       = data.saved_facts;
  if (data.saved_summarize) $('summarize-input').value  = data.saved_summarize;

  // Restore typer defaults
  if (data.defaultWpm) {
    $('wpm-slider').value = data.defaultWpm;
    $('wpm-display').textContent = data.defaultWpm;
  }
  if (data.defaultRandomness !== undefined) {
    $('randomness-slider').value = data.defaultRandomness;
    $('randomness-display').textContent = data.defaultRandomness;
  }
  if (data.defaultTypoRate !== undefined) {
    $('typo-slider').value = data.defaultTypoRate;
    $('typo-display').textContent = data.defaultTypoRate;
  }

  // Restore live typer state
  if (data.typerRunning) {
    setTyperUI('active');
    if (data.typerProgress) {
      updateTyperProgress(data.typerProgress.current, data.typerProgress.total);
    }
  } else if (data.typerComplete) {
    setTyperUI('done');
  }

  // Handle context menu pending action (right-click from page)
  if (data.contextPending && Date.now() - data.contextPending.timestamp < 10000) {
    const { tab, text } = data.contextPending;
    await chrome.storage.local.remove('contextPending');

    // factCheck now lives inside aiChecker — redirect the panel
    const resolvedTab = tab === 'factCheck' ? 'aiChecker' : tab;

    // Switch to the requested panel
    openPanel(resolvedTab);

    // Pre-fill the text
    const inputMap = { aiChecker: 'checker-text', aiRewriter: 'rewriter-input', aiSearch: 'writer-input', aiCite: 'cite-text', factCheck: 'facts-text' };
    const inputId = inputMap[tab];
    if (inputId) $(inputId).value = text;
    if (tab === 'factCheck') switchCheckerMode('factcheck');

    $('context-banner').classList.remove('hidden');
    const names = { aiChecker: 'AI Check', aiRewriter: 'Rewrite', aiSearch: 'Problem Solver', aiCite: 'Cite', factCheck: 'Fact Check' };
    $('context-tab-name').textContent = names[tab] || resolvedTab;
    setTimeout(() => $('context-banner').classList.add('hidden'), 4000);
  }

  // Handle selection-mode result (user highlighted text on page after clicking Select)
  if (data.selectionPending && Date.now() - data.selectionPending.timestamp < 30000) {
    const { feature, text } = data.selectionPending;
    await chrome.storage.local.remove('selectionPending');

    // factCheck now lives inside aiChecker — redirect the panel
    const resolvedFeature = feature === 'factCheck' ? 'aiChecker' : feature;

    // Switch to the right panel
    openPanel(resolvedFeature);

    // Fill the input
    const inputMap = { aiChecker: 'checker-text', aiRewriter: 'rewriter-input', aiSearch: 'writer-input', aiCite: 'cite-text', factCheck: 'facts-text' };
    const inputId = inputMap[feature];
    if (inputId) $(inputId).value = text;
    if (feature === 'factCheck') switchCheckerMode('factcheck');

    // Auto-run immediately
    const runMap = { aiChecker: 'checker-analyze-btn', aiRewriter: 'rewriter-btn', aiSearch: 'writer-btn', aiCite: 'cite-btn', factCheck: 'facts-btn' };
    const runId = runMap[feature];
    if (runId) setTimeout(() => $(runId).click(), 50);
  }
})();

// ─── AUTO TYPER ───────────────────────────────────────────────────────────────
const wpmSlider = $('wpm-slider');
const randomnessSlider = $('randomness-slider');
const typoSlider = $('typo-slider');
const typerStartBtn = $('typer-start-btn');
const typerStopBtn = $('typer-stop-btn');

wpmSlider.addEventListener('input', () => {
  $('wpm-display').textContent = wpmSlider.value;
});

randomnessSlider.addEventListener('input', () => {
  $('randomness-display').textContent = randomnessSlider.value;
});

typoSlider.addEventListener('input', () => {
  $('typo-display').textContent = typoSlider.value;
  chrome.storage.local.set({ defaultTypoRate: parseInt(typoSlider.value) });
});

typerStartBtn.addEventListener('click', async () => {
  const text = $('typer-text').value.trim();
  if (!text) {
    flashError($('typer-text'), 'Enter some text to type first.');
    return;
  }

  const config = {
    text,
    wpm: parseInt(wpmSlider.value),
    randomness: parseInt(randomnessSlider.value),
    typoRate: parseInt(typoSlider.value),
  };

  const tab = await getActiveTab();
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'startAutoTyper', config });
    setTyperUI('targeting');
    $('typer-hint').textContent = 'Click on the target field in the page…';
    // Close popup so user can interact with the page
    window.close();
  } catch (e) {
    flashError($('typer-text'), 'Could not connect to page. Refresh and try again.');
  }
});

typerStopBtn.addEventListener('click', async () => {
  await sendToContent('stopAutoTyper');
  setTyperUI('ready');
  $('typer-hint').textContent = 'After clicking Start, click the target field on the page';
  await chrome.storage.local.set({ typerRunning: false, typerProgress: null });
});

function setTyperUI(state) {
  const pill = $('typer-status-pill');
  const label = $('typer-status-label');
  const dot = pill.querySelector('.dot');
  const progressTrack = $('typer-progress-track');

  pill.className = `status-pill ${state === 'active' ? 'active' : state === 'done' ? 'done' : 'ready'}`;

  switch (state) {
    case 'ready':
      label.textContent = 'Ready';
      dot.classList.remove('pulse');
      typerStartBtn.classList.remove('hidden');
      typerStopBtn.classList.add('hidden');
      progressTrack.classList.add('hidden');
      break;
    case 'targeting':
      label.textContent = 'Targeting…';
      dot.classList.add('pulse');
      typerStartBtn.classList.add('hidden');
      typerStopBtn.classList.remove('hidden');
      break;
    case 'active':
      label.textContent = 'Typing…';
      dot.classList.add('pulse');
      typerStartBtn.classList.add('hidden');
      typerStopBtn.classList.remove('hidden');
      progressTrack.classList.remove('hidden');
      break;
    case 'done':
      label.textContent = 'Done ✓';
      dot.classList.remove('pulse');
      typerStartBtn.classList.remove('hidden');
      typerStopBtn.classList.add('hidden');
      progressTrack.classList.add('hidden');
      break;
  }
}

function updateTyperProgress(current, total) {
  const fill = $('typer-progress-fill');
  const label = $('typer-status-label');
  const pct = total ? Math.round((current / total) * 100) : 0;
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `Typing… ${current}/${total}`;
}

// Poll typer progress while popup is open and typer is running
setInterval(async () => {
  const { typerRunning, typerProgress } = await chrome.storage.local.get(['typerRunning', 'typerProgress']);
  if (typerRunning && typerProgress) {
    updateTyperProgress(typerProgress.current, typerProgress.total);
  }
}, 500);

// ─── Text Persistence ─────────────────────────────────────────────────────────
// Auto-save each textarea to storage on every keystroke
[
  ['typer-text',      'saved_typer'],
  ['checker-text',    'saved_checker'],
  ['rewriter-input',  'saved_rewriter'],
  ['writer-input',    'saved_writer'],
  ['cite-text',       'saved_cite'],
  ['facts-text',      'saved_facts'],
  ['summarize-input', 'saved_summarize'],
].forEach(([elId, key]) => {
  const el = $(elId);
  if (el) el.addEventListener('input', () => chrome.storage.local.set({ [key]: el.value }));
});

// Clear buttons — wipe storage key + textarea, hide any results
$('typer-clear-btn').addEventListener('click', () => {
  $('typer-text').value = '';
  chrome.storage.local.remove('saved_typer');
});
$('checker-clear-btn').addEventListener('click', () => {
  $('checker-text').value = '';
  $('checker-result').classList.add('hidden');
  chrome.storage.local.remove('saved_checker');
});
$('rewriter-clear-btn').addEventListener('click', () => {
  $('rewriter-input').value = '';
  $('rewriter-output-wrap').classList.add('hidden');
  chrome.storage.local.remove('saved_rewriter');
});
$('writer-clear-btn').addEventListener('click', () => {
  $('writer-input').value = '';
  $('writer-output-wrap').classList.add('hidden');
  chrome.storage.local.remove('saved_writer');
});
$('cite-clear-btn').addEventListener('click', () => {
  $('cite-text').value = '';
  $('cite-results').classList.add('hidden');
  chrome.storage.local.remove('saved_cite');
});
$('facts-clear-btn').addEventListener('click', () => {
  $('facts-text').value = '';
  $('facts-results').classList.add('hidden');
  lastFactResults = null;
  chrome.storage.local.remove('saved_facts');
});
$('summarize-clear-btn').addEventListener('click', () => {
  $('summarize-input').value = '';
  $('summarize-output-wrap').classList.add('hidden');
  chrome.storage.local.remove('saved_summarize');
});

// Clear All — wipes every tool's inputs and results at once
$('clear-all-btn').addEventListener('click', () => {
  // Auto Typer
  $('typer-text').value = '';
  // AI Checker
  $('checker-text').value = '';
  $('checker-result').classList.add('hidden');
  // Rewriter
  $('rewriter-input').value = '';
  $('rewriter-output-wrap').classList.add('hidden');
  // AI Writer
  $('writer-input').value = '';
  $('writer-output-wrap').classList.add('hidden');
  $('writer-directions-wrap').classList.add('hidden');
  $('writer-outline-wrap').classList.add('hidden');
  // Citations
  $('cite-text').value = '';
  $('cite-results').classList.add('hidden');
  // Fact Check
  $('facts-text').value = '';
  $('facts-results').classList.add('hidden');
  lastFactResults = null;
  // Summarize
  $('summarize-input').value = '';
  $('summarize-output-wrap').classList.add('hidden');
  // Problem Solver (Multi-Problem session)
  $('mc-session').classList.add('hidden');
  $('mc-empty-state').classList.remove('hidden');
  $('mc-answer-wrap').classList.add('hidden');
  $('mc-answer-textarea').value = '';
  $('mc-answers-loading').classList.add('hidden');
  $('mc-answers-error').classList.add('hidden');
  $('mc-load-btn').textContent = 'Load Questions from Doc';
  sendToContent('clearMCHighlight');
  // Remove all saved storage
  chrome.storage.local.remove(['saved_typer','saved_checker','saved_rewriter','saved_writer','saved_cite','saved_facts','saved_summarize','mc_questions','mc_current_idx','mc_answers_cache','mc_doc_context','mc_plan']);
});

// From Doc buttons — pull text from the active tab into each tool's textarea
$('checker-fromdoc-btn').addEventListener('click',  (e) => loadFromDoc(e.currentTarget, 'checker-text'));
$('rewriter-fromdoc-btn').addEventListener('click', (e) => loadFromDoc(e.currentTarget, 'rewriter-input'));
$('writer-fromdoc-btn').addEventListener('click',   (e) => loadFromDoc(e.currentTarget, 'writer-input'));
$('cite-fromdoc-btn').addEventListener('click',     (e) => loadFromDoc(e.currentTarget, 'cite-text'));
$('facts-fromdoc-btn').addEventListener('click',    (e) => loadFromDoc(e.currentTarget, 'facts-text'));
$('summarize-fromdoc-btn').addEventListener('click',(e) => loadFromDoc(e.currentTarget, 'summarize-input'));

// ─── AI CHECKER ───────────────────────────────────────────────────────────────
let lastCheckerResult = null;

$('checker-copy-btn').addEventListener('click', () => {
  copyWithFeedback($('checker-copy-btn'), $('checker-text').value);
});

$('checker-autotype-btn').addEventListener('click', () => {
  sendToAutoTyper($('checker-text').value);
});

$('checker-analyze-btn').addEventListener('click', async () => {
  const text = $('checker-text').value.trim();
  if (!text) { flashError($('checker-text'), 'Enter text to analyze.'); return; }

  const btn = $('checker-analyze-btn');
  setLoading(btn, true, 'Analyzing…');
  $('checker-result').classList.add('hidden');

  try {
    const raw = await callOpenAI({
      system: `Strict AI detector, same standard as GPTZero/ZeroGPT. Default: text is AI. Surface tricks (contractions, em dashes, casual phrases, rhetorical questions) are AI humanization tactics — ignore them, they do NOT lower the score.

SCORING: Start at 20, add points below, cap 100. Apply deductions where signals are genuinely absent.

HIGH (+12-18 each):
• Sentence length uniformity — most sentences 15-30 words with little variation
• Predictable word choice — every word is the safest expected option, nothing surprising or personal
• Paragraph structure uniformity — same length, same intro→expand→conclude pattern throughout

MEDIUM (+6-10 each):
• AI clichés (per occurrence): "It is/It's worth noting" / "It's interesting to note" / "It's hard to overstate" / Furthermore / Moreover / Additionally / "In conclusion" / "To summarize" / Certainly / Evidently / Undoubtedly / "Delve into" / Utilize / Multifaceted / Comprehensive / Pivotal / Nuanced / "Double-edged sword" / "Seismic shift" / Unprecedented / Landscape (metaphorical)
• Em dash overuse — more than 2 em dashes signals AI faking humanness
• Performed casualness — informal phrases feel inserted onto otherwise formal text
• Transition overuse — "on the one hand/other hand", However, In contrast used structurally
• Moral conclusion — final paragraph wraps up with lessons learned or why it matters today
• Academic register — uniformly formal vocab and sentence construction despite surface contractions
• Heavy passive voice throughout — "was observed", "were created", "is considered" used repeatedly

LOW (+3-5 each):
• Uniform information density — every sentence equally loaded
• Reflexive hedging — may/might/could/in some cases used habitually
• Precise statistics fluently woven into essay prose

DEDUCTIONS (apply these when signals are genuinely absent or well-executed):
• Genuine sentence length variety with a real mix of short and long: -8
• Clearly active voice throughout, no passive constructions: -6
• Word choices that feel personal or unexpected, not textbook safe: -8
• Paragraphs noticeably uneven in length and structure: -6
• Personal voice, opinions, or direct statements without hedging: -6

Do NOT default to 60-75% as a safe middle. Score what you actually find. Raw unedited AI = 80-95%. Well-humanized AI = 45-65%. Genuinely human writing = 15-40%.

Return ONLY valid JSON:
{"score":<0-100>,"confidence":"low|medium|high","verdict":"<e.g. Almost certainly AI-generated>","indicators":["<signal: example from text>"]}`,
      user: text,
      json: false,
      temperature: 0.6,
    });

    const result = extractJSON(raw);
    lastCheckerResult = result;
    renderCheckerResult(result);
  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      $('api-warning').classList.remove('hidden');
      alert('Set your OpenAI API key in Settings first.');
    } else {
      alert(`Analysis failed: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

function renderCheckerResult({ score, confidence, verdict, indicators }) {
  const circle = $('checker-circle');
  const pctEl = $('checker-pct');
  const verdictEl = $('checker-verdict');
  const confEl = $('checker-confidence');
  const bar = $('checker-bar');
  const indicatorsEl = $('checker-indicators');

  const level = score < 35 ? 'low' : score < 65 ? 'medium' : 'high';
  const colors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };

  circle.className = `ai-score-circle ${level}`;
  pctEl.textContent = `${score}%`;
  verdictEl.textContent = verdict;
  verdictEl.style.color = colors[level];
  confEl.textContent = `Confidence: ${confidence}`;

  bar.className = `score-bar-fill ${level}`;
  bar.style.width = `${score}%`;

  indicatorsEl.innerHTML = (indicators || [])
    .map((ind) => `<div class="indicator-item">• ${escHtml(ind)}</div>`)
    .join('');

  $('checker-result').classList.remove('hidden');
}

// ─── AI REWRITER ──────────────────────────────────────────────────────────────

$('intensity-slider').addEventListener('input', () => {
  $('intensity-display').textContent = $('intensity-slider').value;
});

$('style-slider').addEventListener('input', () => {
  $('style-display').textContent = $('style-slider').value;
});

// ── Text References ────────────────────────────────────────────────────────────
// Stored in chrome.storage.local as cf_text_refs: [{name, text, chars}]
const MAX_REFS = 5;
const MAX_REF_CHARS = 8000; // per file, to stay within context limits

async function _loadRefs() {
  const { cf_text_refs = [] } = await chrome.storage.local.get('cf_text_refs');
  return cf_text_refs;
}

async function _saveRefs(refs) {
  await chrome.storage.local.set({ cf_text_refs: refs });
}

function _renderRefs(refs) {
  const list = $('text-refs-list');
  list.innerHTML = '';
  refs.forEach((ref, idx) => {
    const item = document.createElement('div');
    item.className = 'text-ref-item';
    item.innerHTML = `
      <span class="text-ref-icon">${ref.name.endsWith('.pdf') ? '📄' : '📝'}</span>
      <span class="text-ref-name" title="${ref.name}">${ref.name}</span>
      <span class="text-ref-chars">${(ref.chars / 1000).toFixed(1)}k chars</span>
      <button class="text-ref-remove" data-idx="${idx}" title="Remove">✕</button>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll('.text-ref-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const refs = await _loadRefs();
      refs.splice(parseInt(btn.dataset.idx, 10), 1);
      await _saveRefs(refs);
      _renderRefs(refs);
    });
  });
}

function _extractPDFText(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);

  const parts = [];
  // Extract text from BT...ET blocks
  const btEt = /BT([\s\S]*?)ET/g;
  let m;
  while ((m = btEt.exec(raw)) !== null) {
    const block = m[1];
    // Literal string Tj: (text)Tj
    const tj = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|TJ|'|")/g;
    let tm;
    while ((tm = tj.exec(block)) !== null) {
      parts.push(tm[1]
        .replace(/\\n/g, '\n').replace(/\\r/g, '')
        .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\'));
    }
    // Array TJ: [(text) num ...] TJ
    const atj = /\[([^\]]*)\]\s*TJ/g;
    let am;
    while ((am = atj.exec(block)) !== null) {
      const strs = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let sm;
      while ((sm = strs.exec(am[1])) !== null) {
        parts.push(sm[1].replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\'));
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function _extractFileText(file) {
  if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }
  // PDF
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try { resolve(_extractPDFText(e.target.result) || '(No extractable text found in this PDF)'); }
      catch (_) { resolve('(Could not read this PDF)'); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

$('text-refs-upload').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;

  const refs = await _loadRefs();
  for (const file of files) {
    if (refs.length >= MAX_REFS) break;
    const lbl = $('text-refs-upload').previousElementSibling; // the label
    const origText = lbl ? lbl.textContent.trim() : '';

    let rawText = '';
    try { rawText = await _extractFileText(file); } catch (_) {}
    const text = rawText.slice(0, MAX_REF_CHARS);
    refs.push({ name: file.name, text, chars: text.length });
  }
  await _saveRefs(refs);
  _renderRefs(refs);
});

// Load refs on startup (called inside init())
async function _initRefs() {
  const refs = await _loadRefs();
  _renderRefs(refs);
}

$('rewriter-btn').addEventListener('click', async () => {
  const text = $('rewriter-input').value.trim();
  if (!text) { flashError($('rewriter-input'), 'Enter text to humanize.'); return; }

  const intensity  = $('intensity-slider').value;
  const styleLevel = parseInt($('style-slider').value, 10);
  const btn = $('rewriter-btn');
  setLoading(btn, true, 'Humanizing…');
  $('rewriter-output-wrap').classList.add('hidden');

  // Build optional style-reference block
  let styleBlock = '';
  if (styleLevel > 0) {
    const refs = await _loadRefs();
    if (refs.length > 0) {
      const charsEach = Math.floor(4000 / refs.length);
      const samples = refs.map(r => r.text.slice(0, charsEach)).join('\n\n---\n\n');
      const influence = styleLevel <= 3
        ? 'Subtle — mainly borrow some vocabulary and a few phrases from the samples'
        : styleLevel <= 6
          ? 'Moderate — blend the user\'s sentence rhythms, word choices, and tone throughout'
          : 'Strong — write as if the user themselves wrote this; closely mirror their voice, phrasing, and style';
      styleBlock = `

PERSONALIZED STYLE (Level ${styleLevel}/10 — ${influence}):
Study the writing samples below and mirror the user's natural style:
• Use vocabulary and words they commonly choose
• Match their sentence rhythm and structure patterns
• Reflect their level of formality / casualness
• Echo their characteristic ways of phrasing things
Do NOT copy sentences — adapt the style only.

USER'S WRITING SAMPLES:
${samples}`;
    }
  }

  try {
    const result = await callOpenAI({
      system: `Rewrite AI text to defeat GPTZero, ZeroGPT, Originality.ai. Apply every rule.

NEVER:
• Em dashes or hyphens (— or -) anywhere — rewrite the sentence instead
• These words/phrases: Furthermore / Moreover / Additionally / "It is/It's worth noting" / "It's interesting to note" / "It's hard to overstate" / "In conclusion" / "In summary" / "To summarize" / Certainly / Evidently / Undoubtedly / "Delve into" / Utilize / Multifaceted / Comprehensive / Pivotal / Nuanced / "Double-edged sword" / "Seismic shift" / Unprecedented / Straightforward / "As we can see"
• "On the one hand / on the other hand" parallel argument structure
• End with a moral conclusion paragraph (lessons learned, why it matters today) — instead finish on a specific detail or just stop after the last real point

ALWAYS:
1. Sentence length variation — sentences should naturally range from short to long across each paragraph. A paragraph should NOT have all sentences around the same length. Aim for real variety: some around 8-15 words, some around 20-30 words, occasionally longer. Do NOT make most sentences short — that is just as robotic as uniform long sentences. The mix is what matters.
2. Paragraph length — make paragraphs visibly uneven in length. Not everything the same size on the page.
3. Kill passive voice — rewrite every passive construction into active voice. "Was observed" → "showed", "were created" → "created", "is considered" → "people consider", "was made" → "they made."
4. Kill reflexive hedging — remove may/might/could/in some cases used out of habit; state known things directly
5. Unpredictable word choices — avoid the most expected textbook word. "moved to cities" not "migrated to urban centers", "got worse" not "deteriorated", "a lot of" not "numerous", "shows" not "demonstrates", "started" not "commenced", "buy" not "purchase", "about" not "regarding"
6. Vary information density — some sentences carry a lot, some are lighter observations; don't load every sentence equally
7. Contractions everywhere natural — it's, don't, can't, won't, that's, they're, isn't, wasn't, didn't
8. Vary sentence openings — no two consecutive sentences start the same way; mix subject-first, "And/But/So" starts, dependent clauses, time/place details
9. Break structural symmetry — if paragraphs all follow the same intro→expand→conclude pattern, break it; reorganize so the structure feels less planned

INTENSITY ${intensity}/10 — depth of rewrite and vocabulary casualness:
• 1-3: Vocabulary/cliché cleanup only. Swap formal words for plain ones, add contractions, fix passive voice, minimal restructuring.
• 4-6: Rewrite full sentences and clauses that sound like a textbook. Change how things are expressed, not just the words. Make sure sentence length rule (1) is enforced per paragraph. "The results indicated a substantial improvement in performance" → "The results showed it was working a lot better."
• 7-10: Rebuild every sentence that sounds AI-written from scratch. Would a real person say this? If not, rebuild it. Enforce sentence length rule (1) strictly. Use everyday vocabulary — nothing academic or polished. "As industrialization accelerated, significant population migration from rural regions to urban centers was observed" → "As factories started showing up everywhere, people packed up and moved to the cities."

PRESERVE all facts and meaning exactly. Do not add or remove anything.
Return ONLY the rewritten text. No intro, no explanation.${styleBlock}`,
      user: text,
      temperature: 0.9,
    });

    $('rewriter-output').value = result;
    $('rewriter-output-wrap').classList.remove('hidden');
  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      $('api-warning').classList.remove('hidden');
      alert('Set your OpenAI API key in Settings first.');
    } else {
      alert(`Rewrite failed: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

$('rewriter-copy-btn').addEventListener('click', () => {
  copyWithFeedback($('rewriter-copy-btn'), $('rewriter-output').value);
});

$('rewriter-autotype-btn').addEventListener('click', () => {
  sendToAutoTyper($('rewriter-output').value);
});

// ─── AI WRITER ────────────────────────────────────────────────────────────────
$('writer-btn').addEventListener('click', async () => {
  const prompt = $('writer-input').value.trim();
  if (!prompt) { flashError($('writer-input'), 'Enter an assignment or prompt first.'); return; }

  const length = $('writer-length').value;
  const tone   = $('writer-tone').value;
  const btn    = $('writer-btn');
  setLoading(btn, true, 'Writing…');
  $('writer-output-wrap').classList.add('hidden');

  const lengthGuide = {
    short:  '1–2 paragraphs (roughly 100–200 words)',
    medium: '3–5 paragraphs (roughly 300–500 words)',
    long:   '6 or more paragraphs (roughly 600–900 words)',
  }[length];

  const toneGuide = {
    academic: 'Use a formal, academic tone appropriate for school submissions. Structured arguments, evidence-based reasoning, formal vocabulary — but still natural and human.',
    casual:   'Use a relaxed, conversational tone. Write the way a smart person talks — clear, direct, personable, occasionally funny or self-aware.',
    creative: 'Use a vivid, engaging creative voice. Strong imagery, varied rhythm, personality, and originality.',
  }[tone];

  try {
    const result = await callOpenAI({
      system: `You are an expert writer producing polished, human-quality content that will pass AI detection tools.

TONE: ${toneGuide}

LENGTH: Write ${lengthGuide}.

CRITICAL — make it sound unmistakably human:
• Vary sentence length dramatically. Short ones. Fragments even. Then a longer, more flowing sentence that builds and adds detail naturally. Then medium. Never let three sentences in a row be the same length.
• Use contractions freely: it's, don't, can't, won't, I'd, that's, isn't, we've.
• Use em dashes — like this — for asides or emphasis. Use them once or twice.
• Avoid these AI clichés entirely: "Furthermore", "Moreover", "Additionally", "It is important to note", "It is worth noting", "In conclusion", "To summarize", "Certainly", "Evidently", "Undoubtedly", "Delve into", "Comprehensive", "Crucial", "Leverage", "Utilize" (use "use" instead).
• Don't start every paragraph with a topic sentence. Let ideas develop more organically.
• Include one small concrete detail or specific example that makes it feel real and researched.
• End strongly — not with a generic summary sentence.

Return ONLY the written content. No preamble, no "Here is your essay:", no explanation.`,
      user: prompt,
    });

    $('writer-output').value = result;
    $('writer-output-wrap').classList.remove('hidden');
  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      $('api-warning').classList.remove('hidden');
      alert('Set your API key in Settings first.');
    } else {
      alert(`Writing failed: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

$('writer-copy-btn').addEventListener('click', () => {
  copyWithFeedback($('writer-copy-btn'), $('writer-output').value);
});

$('writer-autotype-btn').addEventListener('click', () => {
  sendToAutoTyper($('writer-output').value);
});

// ─── ADVANCED WRITER ──────────────────────────────────────────────────────────

let advSelectedDirection = null; // holds the chosen direction object between steps

// Helper: show only the writer UI elements for a given step
function advShowStep(step) {
  const controlsRow   = $('writer-controls-row');
  const buttonsRow    = $('writer-buttons-row');
  const directionsWrap = $('writer-directions-wrap');
  const outlineWrap   = $('writer-outline-wrap');
  const outputWrap    = $('writer-output-wrap');

  // Reset all first
  [controlsRow, buttonsRow, directionsWrap, outlineWrap].forEach(el => {
    el.classList.add('hidden');
  });

  if (step === 'input') {
    controlsRow.classList.remove('hidden');
    buttonsRow.classList.remove('hidden');
  } else if (step === 'directions') {
    directionsWrap.classList.remove('hidden');
  } else if (step === 'outline') {
    outlineWrap.classList.remove('hidden');
  } else if (step === 'essay') {
    // Show output + let user clear to start over
    outputWrap.classList.remove('hidden');
  }
}

// Helper: convert outline JSON array → readable plain text for the textarea
function outlineToText(outline) {
  return outline.map(section => {
    const pts = section.points.map(p => `  • ${p}`).join('\n');
    return `${section.section}\n${pts}`;
  }).join('\n\n');
}

// STEP 0 → STEP 1: Generate 3 directions
$('writer-advanced-btn').addEventListener('click', async () => {
  const prompt = $('writer-input').value.trim();
  if (!prompt) { flashError($('writer-input'), 'Enter a prompt first.'); return; }

  const btn = $('writer-advanced-btn');
  setLoading(btn, true, 'Thinking…');

  // Show directions panel with a loading state immediately
  advShowStep('directions');
  $('writer-directions-list').innerHTML =
    '<div class="direction-loading"><span class="spinner"></span> Generating directions…</div>';

  try {
    const raw = await callOpenAI({
      system: `You are a writing strategy assistant. Generate exactly 3 meaningfully different strategic directions a writer could take for the given prompt. Each direction should represent a genuinely different approach — different angle, structure, or emphasis, not just minor rephrasing.

For "sources" choose ONE of: Academic | Mixed | General
For "tone" write a short descriptor like: Formal academic / Semi-academic / Conversational / Narrative / Analytical

Return ONLY valid JSON:
{
  "directions": [
    {
      "title": "3–5 word approach name",
      "sources": "Academic | Mixed | General",
      "tone": "short tone descriptor",
      "topic_sentence": "One sentence capturing the core angle this direction takes.",
      "bullets": ["Specific structural or thematic choice", "What evidence or sourcing style it uses", "What makes this approach distinct from the others"]
    }
  ]
}`,
      user: `Writing prompt: "${prompt}"`,
      json: true,
      temperature: 0.8,
    });

    const data = JSON.parse(raw);
    const directions = data.directions || [];
    if (!directions.length) throw new Error('No directions returned.');

    // Render direction cards
    $('writer-directions-list').innerHTML = directions.map((d, i) => `
      <div class="direction-card" data-idx="${i}">
        <div class="direction-card-title">${d.title}</div>
        <div class="direction-badges">
          <span class="direction-badge sources">${d.sources}</span>
          <span class="direction-badge tone">${d.tone}</span>
        </div>
        <div class="direction-summary">
          <p style="margin-bottom:5px">${d.topic_sentence}</p>
          <ul style="margin:0 0 0 14px;padding:0;line-height:1.65">
            ${(d.bullets || []).map(b => `<li>${b}</li>`).join('')}
          </ul>
        </div>
      </div>
    `).join('');

    // Store directions on cards for click handler
    $('writer-directions-list').querySelectorAll('.direction-card').forEach((card, i) => {
      card._direction = directions[i];
    });

  } catch (e) {
    $('writer-directions-list').innerHTML = '';
    advShowStep('input');
    if (e.message === 'NO_API_KEY') {
      alert('Set your API key in Settings first.');
    } else {
      alert(`Couldn't generate directions: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

// STEP 1 → STEP 2: Direction card clicked → generate outline
$('writer-directions-list').addEventListener('click', async (e) => {
  const card = e.target.closest('.direction-card');
  if (!card) return;

  // Mark selected
  $('writer-directions-list').querySelectorAll('.direction-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');

  advSelectedDirection = card._direction;
  const prompt  = $('writer-input').value.trim();
  const length  = $('writer-length').value;
  const lengthGuide = { short: '2 sections', medium: '4–5 sections', long: '6–7 sections' }[length];

  // Disable all cards while loading
  $('writer-directions-list').querySelectorAll('.direction-card').forEach(c => {
    c.style.pointerEvents = 'none'; c.style.opacity = c === card ? '1' : '0.4';
  });
  card.innerHTML += '<div class="direction-loading" style="padding:10px 0 2px"><span class="spinner"></span> Building outline…</div>';

  try {
    const raw = await callOpenAI({
      system: `You are a writing outline specialist. Generate a detailed, well-structured outline for the given prompt using the specified direction and tone.

The outline should have ${lengthGuide}. Each section needs a clear title and 3–4 specific bullet points (not generic — make them specific to the prompt).

Return ONLY valid JSON:
{
  "outline": [
    {
      "section": "Section title",
      "points": ["Specific point 1", "Specific point 2", "Specific point 3"]
    }
  ]
}`,
      user: `Prompt: "${prompt}"

Direction chosen:
- Title: ${advSelectedDirection.title}
- Tone: ${advSelectedDirection.tone}
- Sources: ${advSelectedDirection.sources}
- Approach: ${advSelectedDirection.summary}`,
      json: true,
      temperature: 0.5,
    });

    const data = JSON.parse(raw);
    const outline = data.outline || [];
    if (!outline.length) throw new Error('No outline returned.');

    $('writer-outline-text').value = outlineToText(outline);
    advShowStep('outline');

  } catch (e) {
    // Re-enable cards on failure
    $('writer-directions-list').querySelectorAll('.direction-card').forEach(c => {
      c.style.pointerEvents = ''; c.style.opacity = '';
      c.querySelector('.direction-loading')?.remove();
    });
    if (e.message === 'NO_API_KEY') {
      alert('Set your API key in Settings first.');
    } else {
      alert(`Couldn't generate outline: ${e.message}`);
    }
  }
});

// Back: directions → input
$('writer-dir-back-btn').addEventListener('click', () => {
  advShowStep('input');
});

// Back: outline → directions
$('writer-outline-back-btn').addEventListener('click', () => {
  // Re-enable cards (restore from the loading state)
  $('writer-directions-list').querySelectorAll('.direction-card').forEach(c => {
    c.style.pointerEvents = ''; c.style.opacity = '';
    c.querySelector('.direction-loading')?.remove();
  });
  advShowStep('directions');
});

// STEP 2 → STEP 3: Generate the full essay from approved outline
$('writer-generate-btn').addEventListener('click', async () => {
  const prompt  = $('writer-input').value.trim();
  const outline = $('writer-outline-text').value.trim();
  const length  = $('writer-length').value;
  const btn     = $('writer-generate-btn');

  if (!outline) { flashError($('writer-outline-text'), 'Outline is empty.'); return; }

  setLoading(btn, true, 'Writing…');
  $('writer-output-wrap').classList.add('hidden');

  const lengthGuide = {
    short:  '1–2 paragraphs (roughly 100–200 words)',
    medium: '3–5 paragraphs (roughly 300–500 words)',
    long:   '6 or more paragraphs (roughly 600–900 words)',
  }[length];

  const toneGuide = advSelectedDirection
    ? `Tone: ${advSelectedDirection.tone}. Sources level: ${advSelectedDirection.sources}.`
    : '';

  try {
    const result = await callOpenAI({
      system: `You are an expert writer producing polished, human-quality content.

${toneGuide}
LENGTH: Write ${lengthGuide}.

Follow the outline provided — cover every section and bullet point in order, but write it as flowing prose, not a list.

CRITICAL — make it sound unmistakably human:
• Vary sentence length dramatically. Short ones. Fragments even. Then a longer, more flowing sentence that builds naturally. Never three sentences the same length in a row.
• Use contractions freely: it's, don't, can't, won't, I'd, that's, we've.
• Use em dashes — like this — for asides or emphasis. Once or twice.
• Avoid AI clichés entirely: "Furthermore", "Moreover", "Additionally", "It is important to note", "In conclusion", "To summarize", "Certainly", "Delve into", "Comprehensive", "Leverage", "Utilize".
• Include one concrete detail or specific example that makes it feel real.
• End strongly — not with a generic summary sentence.

Return ONLY the written content. No preamble, no labels, no explanation.`,
      user: `Original prompt: "${prompt}"

Outline to follow:
${outline}`,
      temperature: 0.75,
    });

    $('writer-output').value = result;
    advShowStep('essay');

  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      alert('Set your API key in Settings first.');
    } else {
      alert(`Writing failed: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

// Clear button resets everything including advanced state
$('writer-clear-btn').addEventListener('click', () => {
  advShowStep('input');
  advSelectedDirection = null;
  $('writer-directions-list').innerHTML = '';
  $('writer-outline-text').value = '';
  $('writer-output-wrap').classList.add('hidden');
}, { capture: true }); // run before any other clear handler

// ─── AI CITE (Citations) ──────────────────────────────────────────────────────

$('cite-btn').addEventListener('click', async () => {
  const text = $('cite-text').value.trim();
  if (!text) { flashError($('cite-text'), 'Enter text to find sources.'); return; }
  const style = $('cite-style').value;
  const btn = $('cite-btn');
  setLoading(btn, true, 'Finding…');
  $('cite-results').classList.add('hidden');

  try {
    const raw = await callOpenAI({
      system: `You are a citation assistant. Analyze the provided text and identify the key factual claims, statistics, referenced works, and specific data that would need academic citations.

For each claim, suggest the most likely authoritative source (textbooks, academic journals, government databases, major publications). These are educated suggestions — the user MUST verify sources exist and contain this information before use in academic work.

Format all citations in ${style} style, following the standard exactly.

For the "url" field, provide the most likely direct URL to the source (e.g. "https://www.ncbi.nlm.nih.gov/pmc/articles/...", "https://www.jstor.org/stable/...", "https://doi.org/...", "https://www.nature.com/articles/..."). If no specific URL can be determined, provide the homepage of the most likely publisher or database (e.g. "https://www.jstor.org").

Return ONLY valid JSON:
{
  "citations": [
    {
      "claim": "brief label for what this citation supports (max 15 words)",
      "formatted": "full ${style} citation string",
      "url": "direct URL to the source or publisher website",
      "confidence": "high|medium|low",
      "verify_note": "one short tip for verifying this source"
    }
  ]
}`,
      user: text,
      json: true,
    });

    const result = JSON.parse(raw);
    renderCiteResults(result.citations || []);
  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      $('api-warning').classList.remove('hidden');
      alert('Set your API key in Settings first.');
    } else {
      alert(`Citation search failed: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

function renderCiteResults(citations) {
  const el = $('cite-results');
  if (!citations.length) {
    el.innerHTML = '<p class="hint">No specific claims requiring citation were found.</p>';
    el.classList.remove('hidden');
    return;
  }

  el.innerHTML = `
    <div class="cite-warning"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-2px;margin-right:4px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> AI-suggested sources — verify before submitting academic work</div>
    <div class="cite-select-bar" id="cite-select-bar">
      <span class="cite-select-count" id="cite-select-count">0 selected</span>
      <button class="btn ghost sm" id="cite-copy-selected-btn" disabled>Copy Selected</button>
    </div>
    ${citations.map((c, i) => `
      <label class="cite-item cite-item-label" data-idx="${i}">
        <input type="checkbox" class="cite-checkbox" data-idx="${i}" data-text="${encodeURIComponent(c.formatted)}">
        <div class="cite-item-body">
          <div class="cite-claim">${escHtml(c.claim)}</div>
          <div class="cite-formatted">${escHtml(c.formatted)}</div>
          ${c.url ? `<div class="cite-url"><a href="${escHtml(c.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">🔗 ${escHtml(c.url)}</a></div>` : ''}
          <div class="cite-meta">
            <span class="cite-conf conf-${c.confidence}">${c.confidence} confidence</span>
            ${c.verify_note ? `<span class="cite-note">💡 ${escHtml(c.verify_note)}</span>` : ''}
          </div>
        </div>
      </label>
    `).join('')}
  `;
  el.classList.remove('hidden');

  const updateBar = () => {
    const checked = el.querySelectorAll('.cite-checkbox:checked');
    const count = checked.length;
    el.querySelector('#cite-select-count').textContent = `${count} selected`;
    const copyBtn = el.querySelector('#cite-copy-selected-btn');
    copyBtn.disabled = count === 0;
  };

  el.querySelectorAll('.cite-checkbox').forEach(cb => {
    cb.addEventListener('change', updateBar);
  });

  el.querySelector('#cite-copy-selected-btn').addEventListener('click', (e) => {
    const checked = el.querySelectorAll('.cite-checkbox:checked');
    const lines = Array.from(checked).map((cb, i) => `${i + 1}. ${decodeURIComponent(cb.dataset.text)}`);
    copyWithFeedback(e.currentTarget, lines.join('\n\n'));
  });
}

// ─── FACT CHECK ───────────────────────────────────────────────────────────────
let lastFactResults = null;


$('facts-btn').addEventListener('click', async () => {
  const text = $('facts-text').value.trim();
  if (!text) { flashError($('facts-text'), 'Enter text to fact-check.'); return; }
  const btn = $('facts-btn');
  setLoading(btn, true, 'Checking…');
  $('facts-results').classList.add('hidden');
  lastFactResults = null;

  try {
    const raw = await callOpenAI({
      system: `You are a rigorous fact-checking assistant. Analyze the provided text and assess each objective factual claim.

When evaluating a claim, consider whether it is documented or corroborated by credible sources such as:
- Major news organisations (NYT, Washington Post, BBC, NPR, KQED, Reuters, AP)
- Peer-reviewed academic journals or established historians
- Government agencies, official statistics, or scientific consensus bodies (CDC, WHO, NASA, IPCC, etc.)
- Authoritative encyclopedias or reference works

If a claim is consistent with or well-documented by such sources, classify it as "true" even if it sounds surprising or specific. Only flag claims as "false" when they are clearly contradicted by credible authoritative sources or established consensus.

Rate each claim as:
- "true": supported by credible sources or established consensus
- "false": directly contradicted by credible authoritative sources
- "uncertain": credible sources conflict, actively debated among experts, or verifiable only with specific sourcing
- "opinion": subjective statement that cannot be objectively fact-checked

Focus on verifiable objective claims. Be concise and precise. Include mention of the type of sources that inform your assessment.

Return ONLY valid JSON:
{
  "claims": [
    {
      "text": "exact or near-exact short quote of the claim from the text",
      "verdict": "true|false|uncertain|opinion",
      "explanation": "one concise sentence referencing the kind of sources that support or contradict this"
    }
  ],
  "summary": "1-2 sentence overall fact-check assessment"
}`,
      user: text,
      json: true,
    });

    const result = JSON.parse(raw);
    lastFactResults = result.claims || [];
    renderFactResults(result);
  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      $('api-warning').classList.remove('hidden');
      alert('Set your API key in Settings first.');
    } else {
      alert(`Fact check failed: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

$('facts-highlight-btn').addEventListener('click', async () => {
  if (!lastFactResults) { alert('Run a fact check first.'); return; }
  await sendToContent('highlightClaims', { claims: lastFactResults });
});

function renderFactResults({ claims, summary }) {
  const el = $('facts-results');
  const icon  = { true: '[TRUE]', false: '[FALSE]', uncertain: '[UNCERTAIN]', opinion: '[OPINION]' };
  const iconHtml = {
    true:      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    false:     `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    uncertain: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    opinion:   `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  };
  const color = { true: 'var(--success)', false: 'var(--danger)', uncertain: 'var(--warning)', opinion: 'var(--muted2)' };
  const nonTrue = (claims || []).filter(c => c.verdict !== 'true');

  // Build plain-text version for copy/auto-type
  const plainText = [
    summary ? `FACT CHECK SUMMARY:\n${summary}` : '',
    nonTrue.length ? '\nCLAIMS FLAGGED:' : '',
    ...nonTrue.map(c => `\n${icon[c.verdict] || '?'} ${c.verdict.toUpperCase()}: "${c.text}"\n   ${c.explanation}`),
  ].filter(Boolean).join('\n');

  el.innerHTML = `
    <div class="output-header" style="margin-bottom:8px">
      <span>Fact Check Results</span>
      <div class="row gap-2">
        <button class="btn ghost sm" id="facts-copy-btn">Copy</button>
        <button class="btn ghost sm" id="facts-autotype-btn"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:3px"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="6" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="10" r="1" fill="currentColor" stroke="none"/><rect x="7.5" y="13" width="9" height="2" rx="1" fill="currentColor" stroke="none"/></svg> Auto Type</button>
      </div>
    </div>
    ${summary ? `<div class="facts-summary">${escHtml(summary)}</div>` : ''}
    ${nonTrue.map(c => `
      <div class="fact-item verdict-${c.verdict}">
        <div class="fact-header">
          <span class="fact-icon">${iconHtml[c.verdict] || '?'}</span>
          <span class="fact-verdict" style="color:${color[c.verdict]}">${c.verdict.toUpperCase()}</span>
        </div>
        <div class="fact-claim">"${escHtml(c.text)}"</div>
        <div class="fact-explanation">${escHtml(c.explanation)}</div>
      </div>
    `).join('')}
    ${nonTrue.length === 0
      ? '<p class="hint" style="text-align:center;padding:8px 0"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-2px;margin-right:3px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> No false or uncertain claims detected.</p>'
      : '<p class="hint" style="margin-top:4px">Use the <strong>Highlight</strong> button to mark these in the page.</p>'}
  `;
  el.classList.remove('hidden');

  el.querySelector('#facts-copy-btn')?.addEventListener('click', (e) => {
    copyWithFeedback(e.currentTarget, $('facts-text').value);
  });
  el.querySelector('#facts-autotype-btn')?.addEventListener('click', () => {
    sendToAutoTyper($('facts-text').value);
  });
}

// ─── SUMMARIZE ────────────────────────────────────────────────────────────────

$('summarize-btn').addEventListener('click', async () => {
  const text = $('summarize-input').value.trim();
  if (!text) { flashError($('summarize-input'), 'Enter text to summarize.'); return; }

  const lengthMode = $('summarize-length').value;
  const btn = $('summarize-btn');
  setLoading(btn, true, 'Summarizing…');
  $('summarize-output-wrap').classList.add('hidden');

  const lengthGuide = {
    short:    'Write a brief summary in 2–3 sentences. Capture only the core idea.',
    medium:   'Write a clear 1-paragraph summary covering the main points and purpose.',
    detailed: 'List the key points as a bullet list. Each bullet should be a distinct, important takeaway. Use concise plain language.',
  }[lengthMode];

  try {
    const result = await callOpenAI({
      system: `You are a summarization assistant. Summarize the provided text clearly and concisely.

${lengthGuide}

Rules:
- Stay accurate to what the text actually says — do not add information
- Use plain, clear language
- Do not include preamble like "This text discusses..." or "Here is a summary:"
- Return only the summary itself`,
      user: text,
      temperature: 0.3,
    });

    $('summarize-output').value = result.trim();
    $('summarize-output-wrap').classList.remove('hidden');
  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      $('api-warning').classList.remove('hidden');
      alert('Set your API key in Settings first.');
    } else {
      alert(`Summarize failed: ${e.message}`);
    }
  } finally {
    setLoading(btn, false);
  }
});

$('summarize-copy-btn').addEventListener('click', () => {
  copyWithFeedback($('summarize-copy-btn'), $('summarize-output').value);
});

$('summarize-autotype-btn').addEventListener('click', () => {
  sendToAutoTyper($('summarize-output').value);
});

// ─── Utility: HTML escape ─────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Utility: Flash Error ────────────────────────────────────────────────────
function flashError(el, msg) {
  el.style.borderColor = '#ef4444';
  el.style.boxShadow = '0 0 0 2px rgba(239,68,68,0.2)';
  el.title = msg;
  setTimeout(() => {
    el.style.borderColor = '';
    el.style.boxShadow = '';
    el.title = '';
  }, 2000);
}

// ─── MULTIPLE CHOICE ─────────────────────────────────────────────────────────
//
// Flow:
//   1. User clicks "Load Questions from Doc"
//   2. Pulls document text via getPageText (same pipeline as all From Doc buttons)
//   3. AI call extracts all questions → saved to chrome.storage.local
//   4. One question shown at a time; AI generates 3 answer options on demand
//   5. User clicks an answer → auto-typed, state advances to next question
//   6. State persists across popup opens (popup closes during auto-type)
//
// Storage keys: mc_questions, mc_current_idx, mc_answers_cache, mc_doc_context, mc_plan

const LABELS = ['A', 'B', 'C'];

// Load current MC state and render the panel on startup
(async function initMultiChoice() {
  const data = await chrome.storage.local.get(['mc_questions', 'mc_current_idx']);
  if (data.mc_questions && data.mc_questions.length > 0) {
    const idx = data.mc_current_idx ?? 0;
    if (idx < data.mc_questions.length) {
      // Resume existing session
      $('mc-empty-state').classList.add('hidden');
      $('mc-session').classList.remove('hidden');
      renderMCQuestion(data.mc_questions, idx);
    } else {
      // Session complete — show completion message in empty state
      showMCComplete();
    }
  }
})();

$('mc-load-btn').addEventListener('click', async () => {
  const btn = $('mc-load-btn');
  setLoading(btn, true, 'Reading document…');

  try {
    const res = await sendToContent('getPageText');
    const docText = res?.text?.trim() || '';

    if (!docText) {
      setLoading(btn, false);
      flashError(btn, 'No text found in document. Make sure you\'re on a Google Doc or similar page.');
      btn.textContent = 'No text found';
      btn.style.color = '#ef4444';
      const mcReloadHint = document.createElement('p');
      mcReloadHint.textContent = 'Try reloading the tab';
      mcReloadHint.style.cssText = 'color:#ef4444;font-size:11px;margin:4px 0 0;text-align:center;';
      btn.parentElement.insertBefore(mcReloadHint, btn.nextSibling);
      setTimeout(() => { btn.textContent = 'Load Questions from Doc'; btn.style.color = ''; mcReloadHint.remove(); }, 3000);
      return;
    }

    // Step 1: Holistic analysis — understand the whole assignment before answering any part
    setLoading(btn, true, 'Analyzing assignment…');

    const planRaw = await callOpenAI({
      system: `You are a student assistant. Read this entire assignment and form a complete holistic plan BEFORE filling in any individual field.

Identify:
1. The main question or prompt being asked
2. A clear overall thesis or answer to the main prompt (1-2 sentences)
3. Exactly how many sources are required and what real, credible sources to use (with actual URLs)
4. Specific evidence points that support the thesis, numbered and spread across the sources

Return ONLY valid JSON:
{
  "overall_thesis": "complete answer to the main prompt in 1-2 sentences",
  "sources": [
    { "number": 1, "url": "real URL", "name": "source name", "value": "1 specific value of this source", "limitation": "1 specific limitation of this source" }
  ],
  "evidence": [
    { "source_number": 1, "fact": "specific evidence from the source", "significance": "how this directly answers the main prompt" }
  ]
}`,
      user: docText.slice(0, 6000),
      json: true,
      temperature: 0.4,
    });

    const plan = extractJSON(planRaw) || {};

    // Step 2: Fill every item using the plan as the single source of truth
    setLoading(btn, true, 'Filling in answers…');

    const raw = await callOpenAI({
      system: `You are a student assistant. Using the provided plan, fill in ALL fields for this assignment. The plan has already decided the thesis, sources, and evidence — use it consistently for every field.

Rules:
- ALL fields for "Source #1" must use source number 1 from the plan (same URL, same name, same value/limitation)
- ALL fields for "Source #2" must use source number 2 from the plan (same URL, same name, same value/limitation)
- Evidence fields should draw from the plan's evidence list in order
- For URL/link fields: use the exact URL from the plan
- Write naturally, like a knowledgeable student
- Fill-in-the-blank / single field: 1 sentence; short answer: 2-3 sentences; analysis: 3-5 sentences

IDENTIFY fill-in items:
- Questions with "?" expecting a written answer
- Blank/labeled fields (e.g. "Name: ___", "Response:")
- Table cells with placeholder text ("Paste link here", "Write here", "Your answer here")
- Structured prompts ("1 Value:", "1 Limitation:", "Significance:", "How does this help your question?", etc.)
- Any field or cell clearly meant to be filled in by the student

For table-based assignments: label each item as "[Section] — [Prompt]" (e.g. "Source #1 — Paste link here", "Source #1 OPVL — 1 Value").

SKIP: headings, pure instructions, word banks, already-filled content.

Return ONLY valid JSON:
{ "items": [ { "question": "field label or prompt", "answer": "your answer" }, ... ] }
Order items top to bottom, left to right. If nothing to fill in, return { "items": [] }.`,
      user: `Plan (use this as the single source of truth for all answers):
${JSON.stringify(plan, null, 2)}

Assignment document (identify all fields to fill in, then answer using the plan):
${docText.slice(0, 6000)}`,
      json: true,
      temperature: 0.3,
    });

    const parsed = extractJSON(raw);
    const items = parsed?.items;

    if (!Array.isArray(items) || items.length === 0) {
      setLoading(btn, false);
      btn.textContent = 'No questions found';
      btn.style.color = '#f59e0b';
      setTimeout(() => { btn.textContent = 'Load Questions from Doc'; btn.style.color = ''; }, 3000);
      return;
    }

    const questions    = items.map(item => item.question || '');
    const answersCache = items.reduce((acc, item, i) => { acc[i] = item.answer || ''; return acc; }, {});

    // Save session state with all answers pre-loaded
    await chrome.storage.local.set({
      mc_questions:    questions,
      mc_current_idx:  0,
      mc_answers_cache: answersCache,
      mc_doc_context:  docText.slice(0, 4000),
      mc_plan:         plan,
    });

    setLoading(btn, false);
    $('mc-empty-state').classList.add('hidden');
    $('mc-session').classList.remove('hidden');
    renderMCQuestion(questions, 0);

  } catch (err) {
    setLoading(btn, false);
    btn.textContent = err.message === 'NO_API_KEY' ? 'No API key — check Settings' : 'Error loading';
    btn.style.color = '#ef4444';
    setTimeout(() => { btn.textContent = 'Load Questions from Doc'; btn.style.color = ''; }, 3000);
  }
});

function renderMCQuestion(questions, idx) {
  const total = questions.length;
  const q = questions[idx];

  // Update counter + progress bar
  $('mc-q-counter').textContent = `Question ${idx + 1} of ${total}`;
  const pct = Math.round((idx / total) * 100);
  $('mc-progress-fill').style.width = `${pct}%`;

  // Update question text
  $('mc-question-text').textContent = q;

  // Update prev/skip buttons
  $('mc-prev-btn').disabled = idx === 0;

  // Clear previous answer and show loading
  $('mc-answer-wrap').classList.add('hidden');
  $('mc-answer-textarea').value = '';
  $('mc-answers-loading').classList.remove('hidden');
  $('mc-answers-error').classList.add('hidden');

  // Highlight the question on the page so the user can see it (no auto-focus)
  sendToContent('highlightMCQuestion', { text: q });

  // Generate answer (from cache or AI)
  generateAnswerForQuestion(questions, idx);

  // Pre-fetch next answer silently in the background
  if (idx + 1 < questions.length) {
    generateAnswerForQuestion(questions, idx + 1, { render: false }).catch(() => {});
  }
}

async function generateAnswerForQuestion(questions, idx, { render = true, previousAnswer = null } = {}) {
  try {
    const data = await chrome.storage.local.get(['mc_answers_cache', 'mc_doc_context', 'mc_plan']);
    const cache = data.mc_answers_cache || {};
    const context = data.mc_doc_context || '';
    const plan = data.mc_plan || null;

    let answer;
    if (cache[idx] && !previousAnswer) {
      answer = cache[idx];
    } else {
      const avoidNote = previousAnswer
        ? `\n- A previous attempt gave this answer: "${previousAnswer}" — you MUST use a completely different approach, angle, structure, and wording. Do not reuse any phrases or sentence structures from that answer.`
        : '';
      const raw = await callOpenAI({
        system: `You are a helpful student assistant. Generate a single, well-written answer for the given assignment question or fill-in field.

Guidelines:
- Calibrate length to the question: fill-in-the-blank → 1 sentence; short answer → 2–3 sentences; analysis → 3–5 sentences
- Sound like a knowledgeable student wrote it — natural, not robotic
- If the field is part of a table (e.g. "Source #1 — Significance" or "OPVL — 1 Value"), use all the surrounding questions and document context to understand what source/topic is being analyzed and tailor the answer accordingly. All fields in the same table section relate to the same source or topic.
- If the field expects a URL or link, provide a real, relevant URL
- Only output the answer text itself — no labels, prefixes, or explanations${avoidNote}

Return ONLY valid JSON: { "answer": "answer text here" }`,
        user: `Field to fill in: ${questions[idx]}

${plan ? `Overall assignment plan (use this for consistency):\n${JSON.stringify(plan, null, 2)}\n\n` : ''}All fields in this assignment (for context):
${questions.slice(0, 12).map((q, i) => `${i + 1}. ${q}`).join('\n')}

Document context:
${context.slice(0, 2000)}`,
        json: true,
        temperature: previousAnswer ? 0.95 : 0.7,
      });

      const parsed = extractJSON(raw);
      answer = parsed?.answer;
      if (!answer || typeof answer !== 'string') throw new Error('Bad answer response');

      cache[idx] = answer;
      await chrome.storage.local.set({ mc_answers_cache: cache });
    }

    if (render) {
      $('mc-answers-loading').classList.add('hidden');
      $('mc-answer-textarea').value = answer;
      $('mc-answer-wrap').classList.remove('hidden');
    }

  } catch (err) {
    if (render) {
      $('mc-answers-loading').classList.add('hidden');
      $('mc-answers-error').classList.remove('hidden');
      const retryBtn = $('mc-retry-btn');
      retryBtn.onclick = () => {
        $('mc-answers-error').classList.add('hidden');
        $('mc-answers-loading').classList.remove('hidden');
        generateAnswerForQuestion(questions, idx);
      };
    }
  }
}

// Auto-Type & Next button
$('mc-autotype-btn').addEventListener('click', async () => {
  const text = $('mc-answer-textarea').value.trim();
  if (!text) return;

  const data = await chrome.storage.local.get(['mc_questions', 'mc_current_idx']);
  const idx = data.mc_current_idx ?? 0;
  const questions = data.mc_questions || [];
  const nextIdx = idx + 1;
  await chrome.storage.local.set({ mc_current_idx: nextIdx });

  showMCTypingState();

  const settings = await chrome.storage.local.get(['wpm', 'randomness', 'typoRate']);
  sendToContent('startMCTyping', {
    text,
    questionText: questions[idx],
    wpm: settings.wpm || 60,
    randomness: settings.randomness || 20,
    typoRate: settings.typoRate || 0,
  });
});

// Generate New Answer button
$('mc-regen-btn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['mc_questions', 'mc_current_idx', 'mc_answers_cache']);
  const idx = data.mc_current_idx ?? 0;
  const questions = data.mc_questions || [];
  // Capture current answer to avoid repeating it
  const previousAnswer = $('mc-answer-textarea').value.trim() || null;
  // Clear cache for this question to force regeneration
  const cache = data.mc_answers_cache || {};
  delete cache[idx];
  await chrome.storage.local.set({ mc_answers_cache: cache });

  $('mc-answer-wrap').classList.add('hidden');
  $('mc-answer-textarea').value = '';
  $('mc-answers-loading').classList.remove('hidden');
  generateAnswerForQuestion(questions, idx, { previousAnswer });
});

function showMCTypingState() {
  $('mc-answer-wrap').classList.add('hidden');
  $('mc-answers-loading').classList.add('hidden');
  $('mc-answers-error').classList.add('hidden');
  $('mc-typing-state').classList.remove('hidden');
  $('mc-prev-btn').disabled = true;
  $('mc-skip-btn').disabled = true;
}

function hideMCTypingState() {
  $('mc-typing-state').classList.add('hidden');
  $('mc-prev-btn').disabled = false;
  $('mc-skip-btn').disabled = false;
}

// Prev / Skip navigation
$('mc-prev-btn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['mc_questions', 'mc_current_idx']);
  if (!data.mc_questions) return;
  const newIdx = Math.max(0, (data.mc_current_idx ?? 0) - 1);
  await chrome.storage.local.set({ mc_current_idx: newIdx });
  renderMCQuestion(data.mc_questions, newIdx);
});

$('mc-skip-btn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['mc_questions', 'mc_current_idx']);
  if (!data.mc_questions) return;
  const newIdx = (data.mc_current_idx ?? 0) + 1;
  if (newIdx >= data.mc_questions.length) {
    await chrome.storage.local.set({ mc_current_idx: newIdx });
    sendToContent('clearMCHighlight');
    $('mc-session').classList.add('hidden');
    $('mc-empty-state').classList.remove('hidden');
    showMCComplete();
    return;
  }
  await chrome.storage.local.set({ mc_current_idx: newIdx });
  renderMCQuestion(data.mc_questions, newIdx);
});

// Reset session
$('mc-reset-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['mc_questions', 'mc_current_idx', 'mc_answers_cache', 'mc_doc_context', 'mc_plan']);
  sendToContent('clearMCHighlight');
  $('mc-session').classList.add('hidden');
  $('mc-empty-state').classList.remove('hidden');
  // Reset load button text in case it was changed
  const btn = $('mc-load-btn');
  btn.textContent = 'Load Questions from Doc';
  btn.style.color = '';
  btn.disabled = false;
});

function showMCComplete() {
  const btn = $('mc-load-btn');
  btn.textContent = 'All done! Load new session';
  btn.style.color = '#10b981';
  // Reset colour after a moment so it doesn't look broken
  setTimeout(() => { btn.style.color = ''; }, 3000);
}

// Listen for content.js → popup broadcast when MC typing finishes
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'mcTypingDone') return;
  hideMCTypingState();
  (async () => {
    const data = await chrome.storage.local.get(['mc_questions', 'mc_current_idx']);
    if (!data.mc_questions) return;
    const nextIdx = data.mc_current_idx ?? 0;
    if (nextIdx >= data.mc_questions.length) {
      sendToContent('clearMCHighlight');
      $('mc-session').classList.add('hidden');
      $('mc-empty-state').classList.remove('hidden');
      showMCComplete();
      return;
    }
    renderMCQuestion(data.mc_questions, nextIdx);
  })();
});
