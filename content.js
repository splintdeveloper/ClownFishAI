'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let typerState = {
  active: false,
  targeting: false,
  text: '',
  wpm: 60,
  randomness: 20,
  typoRate: 0,
  charIndex: 0,
  targetElement: null,
  intervalId: null,
};

let keepAliveAudio = null;
let typingWorker   = null; // Web Worker handles timing — immune to tab throttling
let pendingTickFn  = null; // function to call on next worker tick (for multi-step typo sequences)
let hudEl = null;
let overlayEl = null;
let overlayMsgEl = null;
let hoveredEl = null;

// ─── Selection Mode State ─────────────────────────────────────────────────────
let selectionMode = { active: false, feature: '' };
let selectionBannerEl = null;

// ─── Selection Cache ──────────────────────────────────────────────────────────
// Problem: opening the popup clears the page selection before the content script
// can read it. Problem 2: Google Docs keeps its selection inside an iframe, so
// window.getSelection() in the main frame always returns "".
// Fix: cache on every selectionchange, including inside same-origin iframes.

let lastSelection = '';
let iframeListenersAttached = new WeakSet();

function readAllSelections() {
  // Main frame first
  const main = window.getSelection()?.toString().trim() || '';
  if (main) return main;
  // Walk all accessible (same-origin) iframes — Google Docs lives here
  for (const fr of document.querySelectorAll('iframe')) {
    try {
      const t = fr.contentWindow?.getSelection()?.toString().trim() || '';
      if (t) return t;
    } catch (_) {}
  }
  return '';
}

document.addEventListener('selectionchange', () => {
  const t = readAllSelections();
  if (t) lastSelection = t;
});

// Attach the same listener inside every accessible iframe (e.g. Google Docs).
function attachIframeSelectionListeners() {
  for (const fr of document.querySelectorAll('iframe')) {
    try {
      const doc = fr.contentDocument;
      if (doc && !iframeListenersAttached.has(fr)) {
        doc.addEventListener('selectionchange', () => {
          const t = fr.contentWindow?.getSelection()?.toString().trim() || '';
          if (t) lastSelection = t;
        });
        iframeListenersAttached.add(fr);
      }
    } catch (_) {}
  }
}
// Run immediately and again after the page (+ iframes) has fully settled.
attachIframeSelectionListeners();
setTimeout(attachIframeSelectionListeners, 1500);
setTimeout(attachIframeSelectionListeners, 4000);

// ─── Audio Keep-Alive ─────────────────────────────────────────────────────────
// Plays a near-ultrasonic tone at near-zero volume so Chrome doesn't throttle
// background tab timers. The tab will show a speaker icon while active.
function startKeepAliveAudio() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 18500;    // ~18.5 kHz — mostly inaudible to adults
    gain.gain.value = 0.008;        // enough for Chrome to show the speaker icon on the tab
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    keepAliveAudio = { ctx, osc };
    // Chrome may suspend the AudioContext when the tab goes to background.
    // Resume it immediately so timer throttling doesn't kick in.
    document.addEventListener('visibilitychange', _onKeepAliveVisibility);
  } catch (_) {}
}

function stopKeepAliveAudio() {
  if (keepAliveAudio) {
    try { keepAliveAudio.osc.stop(); keepAliveAudio.ctx.close(); } catch (_) {}
    keepAliveAudio = null;
  }
  document.removeEventListener('visibilitychange', _onKeepAliveVisibility);
}

function _onKeepAliveVisibility() {
  // Resume the AudioContext any time Chrome tries to suspend it
  if (keepAliveAudio?.ctx?.state === 'suspended') {
    keepAliveAudio.ctx.resume().catch(() => {});
  }
}

// ─── Typing Web Worker ────────────────────────────────────────────────────────
// Web Worker timers run on a separate thread and are NEVER throttled by Chrome
// in background tabs — unlike main-thread setTimeout which gets capped to ~1Hz.
// The worker receives a delay (ms), waits that long, then posts 'tick' back.
// It also sends a 'keepAlive' ping every 4 s so the main thread can resume the
// AudioContext if Chrome tried to suspend it.
function createTypingWorker() {
  const code = `
    var t = null;
    setInterval(function(){ self.postMessage({ type: 'keepAlive' }); }, 4000);
    self.onmessage = function(e) {
      if (e.data.action === 'scheduleNext') {
        clearTimeout(t);
        t = setTimeout(function(){ self.postMessage({ type: 'tick' }); }, e.data.ms);
      } else if (e.data.action === 'stop') {
        clearTimeout(t);
      }
    };
  `;
  try {
    const blob = new Blob([code], { type: 'text/javascript' });
    const url  = URL.createObjectURL(blob);
    const w    = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  } catch (_) {
    return null; // fallback to main-thread setTimeout
  }
}

// ─── Delay Calculation ────────────────────────────────────────────────────────
function calcDelay(wpm, randomness) {
  const base = (60 * 1000) / (wpm * 5);
  const variance = base * (randomness / 100) * 1.5;
  const offset = (Math.random() - 0.5) * variance;
  return Math.max(15, base + offset);
}

function shouldPause() {
  return Math.random() < 0.025; // 2.5% chance of a "thinking" pause
}

// ─── QWERTY Adjacency Map (for realistic typos) ───────────────────────────────
const ADJACENT_KEYS = {
  q:['w','a'],             w:['q','e','a','s'],      e:['w','r','s','d'],
  r:['e','t','d','f'],     t:['r','y','f','g'],       y:['t','u','g','h'],
  u:['y','i','h','j'],     i:['u','o','j','k'],       o:['i','p','k','l'],
  p:['o','l'],
  a:['q','w','s','z'],     s:['a','w','e','d','z','x'], d:['s','e','r','f','x','c'],
  f:['d','r','t','g','c','v'], g:['f','t','y','h','v','b'], h:['g','y','u','j','b','n'],
  j:['h','u','i','k','n','m'], k:['j','i','o','l','m'],   l:['k','o','p'],
  z:['a','s','x'],         x:['z','s','d','c'],       c:['x','d','f','v'],
  v:['c','f','g','b'],     b:['v','g','h','n'],       n:['b','h','j','m'],
  m:['n','j','k'],
};

function getAdjacentChar(char) {
  const lower = char.toLowerCase();
  const neighbors = ADJACENT_KEYS[lower];
  if (!neighbors || neighbors.length === 0) return null;
  const wrong = neighbors[Math.floor(Math.random() * neighbors.length)];
  return (char !== lower) ? wrong.toUpperCase() : wrong; // preserve original case
}

// ─── Scheduling Helper ────────────────────────────────────────────────────────
// Centralises all "schedule the next action" calls so multi-step typo sequences
// (wrong char → pause → backspace → correct char) can use the same Web Worker.
function scheduleNext(ms, fn) {
  if (typingWorker) {
    pendingTickFn = fn;
    typingWorker.postMessage({ action: 'scheduleNext', ms: Math.round(ms) });
  } else {
    typerState.intervalId = setTimeout(fn, ms);
  }
}

function _charDelay(char) {
  let delay = calcDelay(typerState.wpm, typerState.randomness);
  if ('.!?'.includes(char)) delay += 150 + Math.random() * 200;
  else if (',;:'.includes(char)) delay += 60 + Math.random() * 80;
  if (shouldPause()) delay += 300 + Math.random() * 800;
  return delay;
}

// ─── Typing Engine ────────────────────────────────────────────────────────────
function typeNextChar() {
  if (!typerState.active) { stopTyping(); return; }
  if (typerState.charIndex >= typerState.text.length) { finishTyping(); return; }

  const char = typerState.text[typerState.charIndex];

  // ── Typo simulation ───────────────────────────────────────────────────────
  // Only mis-type alphabetic characters so punctuation/spaces stay clean.
  const typoRate = typerState.typoRate || 0;
  if (typoRate > 0 && /[a-zA-Z]/.test(char) && Math.random() * 100 < typoRate) {
    const wrongChar = getAdjacentChar(char);
    if (wrongChar) {
      // 1. Type the wrong character (charIndex NOT yet advanced)
      insertChar(wrongChar);
      updateHUD();

      // 2. Hold the wrong character on screen long enough to be clearly visible
      scheduleNext(500 + Math.random() * 400, () => {
        if (!typerState.active) { stopTyping(); return; }

        // 3. Backspace over the wrong character
        deleteChar();

        // 4. Short pause after the backspace, then type the correct character
        scheduleNext(100 + Math.random() * 150, () => {
          if (!typerState.active) { stopTyping(); return; }
          insertChar(char);
          typerState.charIndex++;
          updateHUD();
          scheduleNext(_charDelay(char), typeNextChar);
        });
      });
      return;
    }
  }

  // ── Normal typing ─────────────────────────────────────────────────────────
  insertChar(char);
  typerState.charIndex++;
  updateHUD();
  scheduleNext(_charDelay(char), typeNextChar);
}

// ─── Character Insertion ──────────────────────────────────────────────────────
// Priority order:
//   1. Active element is an IFRAME → type inside that iframe's document
//   2. Active element is a real input/contenteditable → type directly
//   3. Google Docs fallback: scan for the texteventtarget iframe by class
//   4. Stored target element → direct insertion or keyboard events

let cachedIframe = null; // perf: avoid re-querying the DOM every character

function insertChar(char) {
  const isBackground = document.hidden;

  // 1. document.activeElement is an IFRAME — only reliable when tab is visible.
  //    Skip this check in the background; activeElement will have lost focus.
  if (!isBackground) {
    const active = document.activeElement;
    if (active?.tagName === 'IFRAME') {
      try {
        if (typeInIframeDoc(active.contentDocument, char)) {
          cachedIframe = active;
          return;
        }
      } catch (_) {}
    }
  }

  // 2. Use the cached iframe if we've already found it this session
  if (cachedIframe) {
    try {
      if (typeInIframeDoc(cachedIframe.contentDocument, char)) return;
    } catch (_) {
      cachedIframe = null; // stale — clear it
    }
  }

  // 3. Google Docs: find the texteventtarget iframe by class, then scan all iframes
  if (window.location.hostname === 'docs.google.com') {
    const found = findEditableIframe();
    if (found) {
      try {
        if (typeInIframeDoc(found.contentDocument, char)) {
          cachedIframe = found;
          return;
        }
      } catch (_) {}
    }
  }

  // 4. Regular active element — only check when foregrounded (background tab
  //    activeElement is unreliable and won't be the typing target).
  if (!isBackground) {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement
        && active.tagName !== 'IFRAME') {
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
        insertIntoInput(active, char); return;
      }
      if (active.isContentEditable || active.contentEditable === 'true') {
        insertIntoContentEditable(active, char); return;
      }
    }
  }

  // 5. Fall back to the originally-clicked element.
  //    For inputs/textareas this works without focus; for contentEditable we
  //    briefly refocus so execCommand succeeds even in a background tab.
  const el = typerState.targetElement;
  if (!el) { dispatchKeyEvents(document.body, char); return; }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    insertIntoInput(el, char);
  } else if (el.isContentEditable || el.contentEditable === 'true') {
    if (isBackground) el.focus(); // re-focus needed for execCommand in background
    insertIntoContentEditable(el, char);
  } else {
    dispatchKeyEvents(document.body, char);
  }
}

// Find the editable iframe (Google Docs' texteventtarget or any contenteditable body)
function findEditableIframe() {
  // Known Google Docs class
  const known = document.querySelector('.docs-texteventtarget-iframe');
  if (known) return known;
  // Generic scan: any same-origin iframe with contenteditable body
  for (const fr of document.querySelectorAll('iframe')) {
    try {
      const doc = fr.contentDocument;
      if (doc?.body?.isContentEditable || doc?.body?.contentEditable === 'true') return fr;
    } catch (_) {}
  }
  return null;
}

// Type one character into an iframe's document.
// Tries execCommand first (most reliable for contenteditable), then InputEvent.
function typeInIframeDoc(iDoc, char) {
  if (!iDoc?.body) return false;

  // execCommand — deprecated but still works in Chrome as of 2025
  try {
    const ok = char === '\n'
      ? iDoc.execCommand('insertParagraph', false)
      : iDoc.execCommand('insertText', false, char);
    if (ok) return true;
  } catch (_) {}

  // InputEvent — modern alternative
  try {
    const target = iDoc.activeElement || iDoc.body;
    const type = char === '\n' ? 'insertParagraph' : 'insertText';
    target.dispatchEvent(new InputEvent('beforeinput', {
      inputType: type, data: char === '\n' ? null : char, bubbles: true, cancelable: true,
    }));
    target.dispatchEvent(new InputEvent('input', {
      inputType: type, data: char === '\n' ? null : char, bubbles: true,
    }));
    return true;
  } catch (_) {}

  return false;
}

function insertIntoInput(el, char) {
  const start = el.selectionStart ?? el.value.length;
  const end   = el.selectionEnd   ?? el.value.length;
  el.value = el.value.substring(0, start) + char + el.value.substring(end);
  el.selectionStart = el.selectionEnd = start + 1;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function insertIntoContentEditable(el, char) {
  el.focus();
  if (char === '\n') document.execCommand('insertParagraph', false);
  else               document.execCommand('insertText', false, char);
}

function dispatchKeyEvents(el, char) {
  const keyCode = char.toUpperCase().charCodeAt(0);
  const opts = {
    key:       char === '\n' ? 'Enter' : char,
    code:      char === ' '  ? 'Space' : char === '\n' ? 'Enter' : `Key${char.toUpperCase()}`,
    keyCode:   char === '\n' ? 13 : char === ' ' ? 32 : keyCode,
    charCode:  char.charCodeAt(0),
    which:     char.charCodeAt(0),
    bubbles: true, cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown',  opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup',    opts));
}

// ─── Character Deletion (for typo backspace) ──────────────────────────────────
// Mirrors the same routing logic as insertChar so backspace lands in the right target.
function deleteChar() {
  const isBackground = document.hidden;

  if (!isBackground) {
    const active = document.activeElement;
    if (active?.tagName === 'IFRAME') {
      try { if (deleteInIframeDoc(active.contentDocument)) return; } catch (_) {}
    }
  }

  if (cachedIframe) {
    try {
      if (deleteInIframeDoc(cachedIframe.contentDocument)) return;
    } catch (_) { cachedIframe = null; }
  }

  if (window.location.hostname === 'docs.google.com') {
    const found = findEditableIframe();
    if (found) {
      try {
        if (deleteInIframeDoc(found.contentDocument)) { cachedIframe = found; return; }
      } catch (_) {}
    }
  }

  if (!isBackground) {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement
        && active.tagName !== 'IFRAME') {
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
        deleteInInput(active); return;
      }
      if (active.isContentEditable || active.contentEditable === 'true') {
        // Always re-focus before execCommand — focus can drift during the async pause
        active.focus();
        deleteInContentEditable(active); return;
      }
    }
  }

  const el = typerState.targetElement;
  if (!el) return;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    deleteInInput(el);
  } else if (el.isContentEditable || el.contentEditable === 'true') {
    el.focus(); // always focus, not just in background
    deleteInContentEditable(el);
  }
}

function deleteInContentEditable(el) {
  // Extend the selection one character backward so execCommand('delete') always
  // has something to remove — bare execCommand('delete') can silently no-op when
  // the selection is already collapsed in certain editors/contexts.
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && sel.getRangeAt(0).collapsed) {
    sel.modify('extend', 'backward', 'character');
  }
  const ok = document.execCommand('delete', false);
  if (!ok) {
    // Fallback: dispatch beforeinput with deleteContentBackward so the browser
    // (or the editor's own event handler) processes the deletion.
    el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
    }));
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward', bubbles: true,
    }));
  }
}

function deleteInInput(el) {
  const start = el.selectionStart ?? el.value.length;
  if (start === 0) return;
  el.value = el.value.substring(0, start - 1) + el.value.substring(start);
  el.selectionStart = el.selectionEnd = start - 1;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function deleteInIframeDoc(iDoc) {
  if (!iDoc?.body) return false;
  try {
    const ok = iDoc.execCommand('delete', false);
    if (ok) return true;
  } catch (_) {}
  // InputEvent fallback (deleteContentBackward = backspace)
  try {
    const target = iDoc.activeElement || iDoc.body;
    target.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
    }));
    target.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward', bubbles: true,
    }));
    return true;
  } catch (_) {}
  return false;
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────
function startTargeting(config) {
  typerState.text        = config.text;
  typerState.wpm         = config.wpm;
  typerState.randomness  = config.randomness;
  typerState.typoRate    = config.typoRate || 0;
  typerState.charIndex   = 0;
  typerState.targeting   = true;
  typerState.active      = false;
  cachedIframe           = null; // reset for new session
  showOverlay();
}

function beginTyping(element) {
  typerState.active        = true;
  typerState.targeting     = false;
  typerState.targetElement = element;
  typerState.charIndex     = 0;

  hideOverlay();
  showHUD();
  startKeepAliveAudio();

  // Spin up the Web Worker timer (background-tab-safe scheduling)
  if (typingWorker) { typingWorker.terminate(); typingWorker = null; }
  typingWorker = createTypingWorker();
  if (typingWorker) {
    typingWorker.onmessage = function(e) {
      if (e.data.type === 'tick') {
        // pendingTickFn is set by scheduleNext() for multi-step sequences (typo corrections).
        // Falls back to typeNextChar for normal ticks.
        const fn = pendingTickFn || typeNextChar;
        pendingTickFn = null;
        fn();
      } else if (e.data.type === 'keepAlive') {
        // Worker ping: resume AudioContext if Chrome suspended it
        if (keepAliveAudio?.ctx?.state === 'suspended') {
          keepAliveAudio.ctx.resume().catch(() => {});
        }
      }
    };
  }

  // Only force-focus real inputs. For Google Docs / iframe editors the click
  // already positioned the cursor — calling .focus() on a generic div undoes it.
  if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ||
      element.isContentEditable || element.contentEditable === 'true')) {
    element.focus();
  }

  scheduleNext(calcDelay(typerState.wpm, typerState.randomness), typeNextChar);
  chrome.storage.local.set({ typerRunning: true });
}

function stopTyping() {
  typerState.active    = false;
  typerState.targeting = false;
  if (typerState.intervalId) { clearTimeout(typerState.intervalId); typerState.intervalId = null; }
  if (typingWorker) { typingWorker.postMessage({ action: 'stop' }); typingWorker.terminate(); typingWorker = null; }
  stopKeepAliveAudio();
  hideHUD();
  hideOverlay();
  chrome.storage.local.set({ typerRunning: false, typerProgress: null });
}

function finishTyping() {
  typerState.active = false;
  if (typerState.intervalId) { clearTimeout(typerState.intervalId); typerState.intervalId = null; }
  if (typingWorker) { typingWorker.postMessage({ action: 'stop' }); typingWorker.terminate(); typingWorker = null; }
  stopKeepAliveAudio();
  showHUDComplete();
  chrome.storage.local.set({ typerRunning: false, typerComplete: true, typerProgress: null });
  setTimeout(() => { hideHUD(); chrome.storage.local.set({ typerComplete: false }); }, 3000);
}

// ─── Targeting Overlay ────────────────────────────────────────────────────────
// No blocking overlay div — clicks pass through to the page so that Google Docs
// (and other editors) receive the click and set focus + cursor position correctly.
// We show only a floating message box (pointer-events:none) and change the cursor.
function showOverlay() {
  if (overlayMsgEl) removeOverlay();

  overlayMsgEl = document.createElement('div');
  overlayMsgEl.id = 'docplus-overlay-msg';
  overlayMsgEl.innerHTML = `
    <span class="dp-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="6" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="10" r="1" fill="currentColor" stroke="none"/><rect x="7.5" y="13" width="9" height="2" rx="1" fill="currentColor" stroke="none"/></svg></span>
    <div class="dp-title">DocPlus Auto Typer</div>
    <div class="dp-sub">Click where you want to type</div>
    <div class="dp-sub" style="margin-top:8px;font-size:11px;color:#475569">Press <kbd style="background:#2d2d4e;padding:1px 5px;border-radius:3px;color:#e2e8f0">Esc</kbd> to cancel</div>
  `;
  document.body.appendChild(overlayMsgEl);
  document.body.style.cursor = 'crosshair';

  document.addEventListener('mouseover', onOverlayMouseover);
  document.addEventListener('mouseout',  onOverlayMouseout);
  // Capture phase: we see the click first, but do NOT preventDefault —
  // the click still reaches Google Docs / the editor.
  document.addEventListener('click', onOverlayClick, true);
  document.addEventListener('keydown', onOverlayKeydown);
}

function removeOverlay() {
  if (overlayEl)    { overlayEl.remove();    overlayEl = null; }
  if (overlayMsgEl) { overlayMsgEl.remove(); overlayMsgEl = null; }
  if (hoveredEl)    { hoveredEl.classList.remove('docplus-hover-highlight'); hoveredEl = null; }
  document.body.style.cursor = '';
  document.removeEventListener('mouseover', onOverlayMouseover);
  document.removeEventListener('mouseout',  onOverlayMouseout);
  document.removeEventListener('click',     onOverlayClick, true);
  document.removeEventListener('keydown',   onOverlayKeydown);
}

function hideOverlay() { removeOverlay(); }

function onOverlayMouseover(e) {
  if (hoveredEl) hoveredEl.classList.remove('docplus-hover-highlight');
  const el = e.target;
  if (el && !overlayMsgEl?.contains(el)) {
    hoveredEl = el;
    el.classList.add('docplus-hover-highlight');
  }
}

function onOverlayMouseout(e) {
  if (e.target) e.target.classList.remove('docplus-hover-highlight');
}

function onOverlayClick(e) {
  if (!typerState.targeting) return;
  if (overlayMsgEl?.contains(e.target)) return;

  // Do NOT preventDefault / stopPropagation — the click must reach the page
  // so the editor sets focus and places the text cursor correctly.
  const el = e.target;
  if (el) el.classList.remove('docplus-hover-highlight');
  removeOverlay();

  // Wait for the click to fully process and editor focus to settle.
  setTimeout(() => beginTyping(el), 200);
}

function onOverlayKeydown(e) {
  if (e.key === 'Escape') stopTyping();
}

// ─── Floating HUD ─────────────────────────────────────────────────────────────
function createHUD() {
  if (hudEl) return;
  hudEl = document.createElement('div');
  hudEl.id = 'docplus-hud';
  hudEl.className = 'hidden';
  hudEl.innerHTML = `
    <div class="docplus-pill">
      <span class="docplus-badge">D+</span>
      <div class="docplus-info">
        <div class="docplus-status-text">
          <span class="docplus-typing-dot"></span>
          <span id="dp-status-label">Typing...</span>
        </div>
        <div class="docplus-progress-bar">
          <div class="docplus-progress-fill" id="dp-progress-fill"></div>
        </div>
      </div>
      <button class="docplus-stop-btn" id="dp-stop-btn">Stop</button>
    </div>
  `;
  document.body.appendChild(hudEl);
  document.getElementById('dp-stop-btn').addEventListener('click', stopTyping);
  makeDraggable(hudEl, hudEl.querySelector('.docplus-pill'));
}

function showHUD() {
  createHUD();
  hudEl.classList.remove('hidden');
  updateHUD();
}

function updateHUD() {
  if (!hudEl || hudEl.classList.contains('hidden')) return;
  const label = document.getElementById('dp-status-label');
  const fill  = document.getElementById('dp-progress-fill');
  if (!label || !fill) return;
  const pct = typerState.text.length
    ? Math.round((typerState.charIndex / typerState.text.length) * 100) : 0;
  label.textContent = `Typing... ${typerState.charIndex}/${typerState.text.length} chars`;
  fill.style.width = `${pct}%`;
  chrome.storage.local.set({ typerProgress: { current: typerState.charIndex, total: typerState.text.length } });
}

function showHUDComplete() {
  if (!hudEl) return;
  const label = document.getElementById('dp-status-label');
  const fill  = document.getElementById('dp-progress-fill');
  const dot   = hudEl.querySelector('.docplus-typing-dot');
  if (label) label.textContent = 'Done! ✓';
  if (fill)  fill.style.width = '100%';
  if (dot)   { dot.style.background = '#10b981'; dot.style.animation = 'none'; }
}

function hideHUD() {
  if (hudEl) hudEl.classList.add('hidden');
}

// ─── Draggable HUD ────────────────────────────────────────────────────────────
function makeDraggable(el, handle) {
  let startX, startY, origX, origY;
  handle.addEventListener('mousedown', (e) => {
    startX = e.clientX; startY = e.clientY;
    const rect = el.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
    function onMove(e) {
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = `${origX + e.clientX - startX}px`;
      el.style.top  = `${origY + e.clientY - startY}px`;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Global Escape ────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && typerState.active) stopTyping();
});

// ─── Selection Mode ───────────────────────────────────────────────────────────
function startSelectionMode(feature) {
  selectionMode.active = true;
  selectionMode.feature = feature;
  showSelectionBanner();
  document.addEventListener('mouseup', onSelectionMouseup);
  document.addEventListener('keydown', onSelectionEsc);
  // Attach into every accessible same-origin iframe so Google Docs'
  // editing surface (which lives inside an iframe) fires mouseup correctly.
  for (const fr of document.querySelectorAll('iframe')) {
    try {
      fr.contentDocument?.addEventListener('mouseup', onSelectionMouseup);
      fr.contentDocument?.addEventListener('keydown', onSelectionEsc);
    } catch (_) {}
  }
}

function stopSelectionMode() {
  selectionMode.active = false;
  selectionMode.feature = '';
  hideSelectionBanner();
  document.removeEventListener('mouseup', onSelectionMouseup);
  document.removeEventListener('keydown', onSelectionEsc);
  for (const fr of document.querySelectorAll('iframe')) {
    try {
      fr.contentDocument?.removeEventListener('mouseup', onSelectionMouseup);
      fr.contentDocument?.removeEventListener('keydown', onSelectionEsc);
    } catch (_) {}
  }
}

function showSelectionBanner() {
  if (selectionBannerEl) selectionBannerEl.remove();
  selectionBannerEl = document.createElement('div');
  selectionBannerEl.id = 'docplus-select-banner';
  selectionBannerEl.innerHTML = `
    <span class="dp-sel-icon">✏️</span>
    <span class="dp-sel-text">Highlight the text you want to analyze</span>
    <span class="dp-sel-key">Esc to cancel</span>
  `;
  document.body.appendChild(selectionBannerEl);
}

function hideSelectionBanner() {
  if (selectionBannerEl) { selectionBannerEl.remove(); selectionBannerEl = null; }
}

function onSelectionMouseup() {
  // Small delay so the browser finalizes the selection range
  setTimeout(() => {
    if (!selectionMode.active) return;
    const text = readAllSelections();
    if (!text) return; // nothing selected yet — keep waiting
    const feature = selectionMode.feature;
    stopSelectionMode();
    chrome.storage.local.set({
      selectionPending: { feature, text, timestamp: Date.now() },
    });
    // Ask background to open the popup
    chrome.runtime.sendMessage({ action: 'openPopupForSelection' });
  }, 60);
}

function onSelectionEsc(e) {
  if (e.key === 'Escape') stopSelectionMode();
}

// ─── Page Highlighting (Fact Check) ───────────────────────────────────────────
function highlightClaimsOnPage(claims) {
  for (const claim of claims) {
    if (claim.verdict === 'true' || claim.verdict === 'opinion') continue;
    const color = claim.verdict === 'false'
      ? 'rgba(239,68,68,0.30)'
      : 'rgba(245,158,11,0.30)'; // uncertain = amber
    highlightTextSnippet(claim.text, color);
  }
}

function highlightTextSnippet(snippet, bgColor) {
  if (!snippet || snippet.length < 5) return;
  // Normalise: strip surrounding quotes, take first 40 meaningful chars
  const clean = snippet.replace(/^["""']+|["""']+$/g, '').trim();
  const key   = clean.substring(0, 40).toLowerCase();
  if (!key) return;

  // Google Docs: highlight leaf spans inside the matching paragraph
  if (window.location.hostname === 'docs.google.com') {
    const paras = document.querySelectorAll('.kix-paragraphrenderer');
    for (const para of paras) {
      if (para.innerText.toLowerCase().includes(key.substring(0, 20))) {
        para.querySelectorAll('span').forEach(span => {
          if (!span.children.length && span.textContent.trim()) {
            span.style.setProperty('background-color', bgColor, 'important');
            span.dataset.dpHighlight = '1';
          }
        });
        return;
      }
    }
    return;
  }

  // Regular pages: walk text nodes and wrap match in a <mark>
  try {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = tw.nextNode())) {
      const parent = node.parentElement;
      if (!parent || ['SCRIPT','STYLE','NOSCRIPT','MARK'].includes(parent.tagName)) continue;
      const idx = node.textContent.toLowerCase().indexOf(key.substring(0, 20));
      if (idx === -1) continue;
      try {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, Math.min(idx + clean.length, node.textContent.length));
        const mark = document.createElement('mark');
        mark.dataset.dpHighlight = '1';
        mark.style.cssText = `background:${bgColor};border-radius:2px;padding:0`;
        range.surroundContents(mark);
      } catch (_) {}
      return; // first occurrence only
    }
  } catch (_) {}
}

function clearDocplusHighlights() {
  // Regular page <mark> elements
  document.querySelectorAll('mark[data-dp-highlight]').forEach(m => {
    const frag = document.createDocumentFragment();
    while (m.firstChild) frag.appendChild(m.firstChild);
    m.replaceWith(frag);
  });
  // Google Docs span overrides
  document.querySelectorAll('span[data-dp-highlight]').forEach(s => {
    s.style.removeProperty('background-color');
    delete s.dataset.dpHighlight;
  });
}

// ─── Helpers: get selection from main frame + all accessible iframes ──────────
function getLiveSelection() {
  const main = window.getSelection()?.toString().trim() || '';
  if (main) return main;
  for (const fr of document.querySelectorAll('iframe')) {
    try {
      const t = fr.contentWindow?.getSelection()?.toString().trim() || '';
      if (t) return t;
    } catch (_) {}
  }
  return '';
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case 'startAutoTyper':
      if (typerState.active) stopTyping();
      startTargeting(message.config);
      sendResponse({ ok: true });
      break;

    case 'stopAutoTyper':
      stopTyping();
      sendResponse({ ok: true });
      break;

    case 'getTyperStatus':
      sendResponse({
        active: typerState.active, targeting: typerState.targeting,
        charIndex: typerState.charIndex, total: typerState.text.length,
      });
      break;

    case 'getSelectedText': {
      // Try live selection (main frame + all iframes), then fall back to cache.
      // The cache exists because opening the popup clears the live selection.
      const live = getLiveSelection();
      const text = live || lastSelection;
      lastSelection = ''; // consume so it's not reused
      sendResponse({ text });
      break;
    }

    case 'contextSearch': {
      const live = getLiveSelection();
      sendResponse({ text: live || lastSelection });
      break;
    }

    case 'startSelectionMode':
      if (selectionMode.active) stopSelectionMode();
      startSelectionMode(message.feature || 'aiChecker');
      sendResponse({ ok: true });
      break;

    case 'getPageText': {
      // Async IIFE — the outer listener already returns true to keep the
      // channel open, so calling sendResponse from inside here is safe.
      (async () => {
        let text = '';
        const host = window.location.hostname;

        // ── Google Docs ───────────────────────────────────────────────────────
        if (host === 'docs.google.com') {
          // Attempt 0: Official Google Docs REST API via chrome.identity token.
          // Most reliable — works on school accounts, no clipboard needed.
          {
            const m = window.location.pathname.match(/\/document\/d\/([^/]+)/);
            if (m) {
              try {
                const result = await chrome.runtime.sendMessage({
                  action: 'fetchGDocsAPI',
                  docId: m[1],
                });
                // notSignedIn just means no Google token — continue to fallbacks
                // (export URL + DOM scraping work with the browser's existing session)
                if (result?.text) text = result.text;
              } catch (_) {}
            }
          }

          if (text) { sendResponse({ text }); return; }

          // Attempt 1: Ctrl+A → Ctrl+C → read clipboard.
          // Google Docs has a hidden iframe (.docs-texteventtarget-iframe) that
          // receives all keyboard events. We dispatch Ctrl+A then Ctrl+C there,
          // wait for Google Docs to populate the clipboard, then read it.
          // This works even on school accounts where the export API is blocked.
          try {
            const txFrame = document.querySelector('.docs-texteventtarget-iframe');
            const txTarget = txFrame?.contentDocument?.body || document.body;

            const sendKey = (key, code) => {
              const opts = { key, code, ctrlKey: true, bubbles: true, cancelable: true, composed: true };
              txTarget.dispatchEvent(new KeyboardEvent('keydown', opts));
              txTarget.dispatchEvent(new KeyboardEvent('keyup',  opts));
            };

            sendKey('a', 'KeyA');                        // Ctrl+A — select all
            await new Promise(r => setTimeout(r, 250));
            sendKey('c', 'KeyC');                        // Ctrl+C — copy
            await new Promise(r => setTimeout(r, 350));

            text = (await navigator.clipboard.readText()).trim();
          } catch (_) {}

          // Attempt 2: export API via background service worker.
          // Fetching from a content script is blocked by CORB; the service
          // worker fetches it instead (same session cookies, no CORB).
          // Try authuser 0, 1, 2 — school accounts are often at index 1 or 2.
          if (!text) {
            const m = window.location.pathname.match(/\/document\/d\/([^/]+)/);
            if (m) {
              const urlAuthUser = new URLSearchParams(window.location.search).get('authuser');
              const authUsersToTry = urlAuthUser
                ? [urlAuthUser]
                : ['0', '1', '2'];
              for (const au of authUsersToTry) {
                try {
                  const result = await chrome.runtime.sendMessage({
                    action: 'fetchGDocsExport',
                    docId: m[1],
                    authUser: au,
                  });
                  if (result?.text) { text = result.text; break; }
                } catch (_) {}
              }
            }
          }

          // Attempt 2b: mobilebasic — Google's simple HTML render of the doc.
          // Uses browser session cookies; not canvas-based so text is in the DOM.
          // Often succeeds on school accounts even when the export is DLP-blocked.
          if (!text) {
            const m = window.location.pathname.match(/\/document\/d\/([^/]+)/);
            if (m) {
              try {
                const result = await chrome.runtime.sendMessage({
                  action: 'fetchGDocsMobile',
                  docId: m[1],
                });
                if (result?.text) text = result.text;
              } catch (_) {}
            }
          }

          // Attempt 2: textContent on paragraph renderers.
          // innerText returns empty when Google renders text on canvas.
          // textContent reads hidden/opacity-0 text nodes that Google keeps
          // for cursor positioning and accessibility even in canvas mode.
          if (!text) {
            const paras = document.querySelectorAll('.kix-paragraphrenderer');
            if (paras.length) {
              const candidate = Array.from(paras)
                .map(p => p.textContent.trim())
                .filter(t => t.length > 0)
                .join('\n');
              if (candidate) text = candidate;
            }
          }

          // Attempt 3: kix-lineview-text-block — the actual text-layer elements
          // inside the Kix rendering engine, one per line.
          if (!text) {
            const blocks = document.querySelectorAll('.kix-lineview-text-block');
            if (blocks.length) {
              text = Array.from(blocks)
                .map(b => b.textContent.trim())
                .filter(t => t.length > 0)
                .join(' ');
            }
          }

          // Attempt 4: Range.toString() on the editor container.
          // This asks the browser to stringify the full node content including
          // any text nodes that innerText/textContent might miss.
          if (!text) {
            for (const sel of ['.kix-appview-editor', '.docs-editor-container', '#docs-editor']) {
              const el = document.querySelector(sel);
              if (!el) continue;
              try {
                const range = document.createRange();
                range.selectNodeContents(el);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                const t = selection.toString().trim();
                selection.removeAllRanges();
                if (t) { text = t; break; }
              } catch (_) {}
            }
          }

          // NEVER fall through to the body scraper for Google Docs —
          // it returns all the UI chrome (menus, language lists, sidebars).
          // Pass a hint so the popup can show a helpful message.
          sendResponse({ text, gdocsCanvasMode: !text });
          return;
        }

        // ── Google Classroom ─────────────────────────────────────────────────
        if (host === 'classroom.google.com') {
          const content = document.querySelector('[jsname] .roS2xe, .onkcGd, [data-course-work-type]');
          if (content) text = content.innerText?.trim() || '';
        }

        // ── Accessible iframes (Canvas LMS, other editors) ───────────────────
        // Skip frames whose text looks like JS initialization dumps.
        if (!text) {
          for (const fr of document.querySelectorAll('iframe')) {
            try {
              const t = fr.contentDocument?.body?.innerText?.trim() || '';
              const looksLikeCode = /^\s*(window\.|_docs_flag|function |var |let |const |\{|\[)/.test(t);
              if (t.length > 200 && !looksLikeCode) { text = t; break; }
            } catch (_) {}
          }
        }

        // ── Smart content fallback — strips chrome, keeps article/main only ──
        if (!text) {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll(
            'script, style, noscript, nav, header, footer, aside, ' +
            '[role="navigation"], [role="banner"], [role="complementary"], ' +
            '.header, .footer, .nav, .sidebar, .menu'
          ).forEach(el => el.remove());
          const main = clone.querySelector('article, main, [role="main"], [role="document"], .document-content, #content, .content') || clone;
          text = main.innerText?.trim() || '';
        }

        sendResponse({ text });
      })();
      break;
    }

    case 'highlightClaims': {
      clearDocplusHighlights();
      if (Array.isArray(message.claims)) highlightClaimsOnPage(message.claims);
      sendResponse({ ok: true });
      break;
    }

    case 'clearHighlights': {
      clearDocplusHighlights();
      sendResponse({ ok: true });
      break;
    }

    default:
      sendResponse({ ok: false, error: 'Unknown action' });
  }
  return true; // keep channel open for async
});

// ─── Init ─────────────────────────────────────────────────────────────────────
createHUD();
