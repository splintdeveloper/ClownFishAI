'use strict';

const providerSelect = document.getElementById('provider');
const apiKeyInput    = document.getElementById('api-key');
const keyLabel       = document.getElementById('key-label');
const providerHint   = document.getElementById('provider-hint');
const modelSelect    = document.getElementById('model');
const toggleBtn      = document.getElementById('toggle-visibility');
const testBtn        = document.getElementById('test-btn');
const saveBtn        = document.getElementById('save-btn');
const statusEl       = document.getElementById('status');

const defaultWpmSlider       = document.getElementById('default-wpm');
const defaultWpmValue        = document.getElementById('default-wpm-value');
const defaultRandomnessSlider = document.getElementById('default-randomness');
const defaultRandomnessValue  = document.getElementById('default-randomness-value');
const saveTyperBtn  = document.getElementById('save-typer-btn');
const typerStatusEl = document.getElementById('typer-status');

// ─── Provider config ──────────────────────────────────────────────────────────
const PROVIDERS = {
  groq: {
    label: 'Groq API Key',
    placeholder: 'gsk_...',
    hint: 'Get a free key at <strong>console.groq.com</strong> — no credit card required. <a href="#setup-guide" id="setup-guide-link" class="hint-link">→ See setup guide</a>',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    testEndpoint: 'https://api.groq.com/openai/v1/models',
    models: [
      { value: 'llama-3.3-70b-versatile',  label: 'Llama 3.3 70B (Best Quality — Free)' },
      { value: 'llama-3.1-8b-instant',      label: 'Llama 3.1 8B Instant (Fastest — Free)' },
      { value: 'mixtral-8x7b-32768',        label: 'Mixtral 8x7B (Free)' },
      { value: 'gemma2-9b-it',              label: 'Gemma 2 9B (Free)' },
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openai: {
    label: 'OpenAI API Key',
    placeholder: 'sk-...',
    hint: 'Get a key at <strong>platform.openai.com</strong>. Requires a paid account.',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    testEndpoint: 'https://api.openai.com/v1/models',
    models: [
      { value: 'gpt-4o-mini',    label: 'GPT-4o Mini (Fast, Affordable)' },
      { value: 'gpt-4o',         label: 'GPT-4o (Best Quality)' },
      { value: 'gpt-4-turbo',    label: 'GPT-4 Turbo' },
      { value: 'gpt-3.5-turbo',  label: 'GPT-3.5 Turbo (Fastest)' },
    ],
    defaultModel: 'gpt-4o-mini',
  },
};

// ─── Update UI when provider changes ─────────────────────────────────────────
function applyProvider(providerKey, savedModel) {
  const p = PROVIDERS[providerKey];
  keyLabel.textContent = p.label;
  apiKeyInput.placeholder = p.placeholder;
  providerHint.innerHTML = p.hint;

  modelSelect.innerHTML = p.models
    .map(m => `<option value="${m.value}">${m.label}</option>`)
    .join('');

  modelSelect.value = savedModel || p.defaultModel;
}

// ─── Smooth-scroll "See setup guide" link (CSP-safe, no inline onclick) ──────
providerHint.addEventListener('click', (e) => {
  const a = e.target.closest('a[href="#setup-guide"]');
  if (a) {
    e.preventDefault();
    const guide = document.getElementById('setup-guide');
    if (guide) guide.scrollIntoView({ behavior: 'smooth' });
  }
});

providerSelect.addEventListener('change', () => {
  applyProvider(providerSelect.value, null);
  // Clear key when switching providers to avoid confusion
  apiKeyInput.value = '';
  statusEl.classList.add('hidden');
});

// ─── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.local.get(['provider', 'apiKey', 'model', 'defaultWpm', 'defaultRandomness'], (data) => {
  const pKey = data.provider || 'groq';
  providerSelect.value = pKey;
  applyProvider(pKey, data.model);

  if (data.apiKey) apiKeyInput.value = data.apiKey;

  if (data.defaultWpm) {
    defaultWpmSlider.value = data.defaultWpm;
    defaultWpmValue.textContent = data.defaultWpm;
  }
  if (data.defaultRandomness !== undefined) {
    defaultRandomnessSlider.value = data.defaultRandomness;
    defaultRandomnessValue.textContent = data.defaultRandomness;
  }
});

// ─── Toggle visibility ────────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// ─── Sliders ──────────────────────────────────────────────────────────────────
defaultWpmSlider.addEventListener('input', () => {
  defaultWpmValue.textContent = defaultWpmSlider.value;
});
defaultRandomnessSlider.addEventListener('input', () => {
  defaultRandomnessValue.textContent = defaultRandomnessSlider.value;
});

// ─── Save AI settings ─────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus(statusEl, 'Please enter an API key.', 'error');
    return;
  }
  chrome.storage.local.set({
    provider: providerSelect.value,
    apiKey: key,
    model: modelSelect.value,
  }, () => {
    showStatus(statusEl, 'Settings saved.', 'success');
  });
});

// ─── Test API key ─────────────────────────────────────────────────────────────
testBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus(statusEl, 'Enter an API key first.', 'error');
    return;
  }
  const p = PROVIDERS[providerSelect.value];
  showStatus(statusEl, 'Testing connection...', 'loading');
  try {
    const res = await fetch(p.testEndpoint, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (res.ok) {
      showStatus(statusEl, '✓ API key is valid!', 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      showStatus(statusEl, `Error: ${err.error?.message || 'Invalid API key'}`, 'error');
    }
  } catch (e) {
    showStatus(statusEl, 'Network error. Check your connection.', 'error');
  }
});

// ─── Save typer defaults ──────────────────────────────────────────────────────
saveTyperBtn.addEventListener('click', () => {
  chrome.storage.local.set({
    defaultWpm: parseInt(defaultWpmSlider.value),
    defaultRandomness: parseInt(defaultRandomnessSlider.value),
  }, () => {
    showStatus(typerStatusEl, 'Defaults saved.', 'success');
  });
});

function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
  if (type !== 'loading') {
    setTimeout(() => el.classList.add('hidden'), 3000);
  }
}
