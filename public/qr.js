(() => {
  'use strict';

  const form = document.querySelector('#pairing-form');
  const keyInput = document.querySelector('#api-key');
  const showButton = document.querySelector('#show-qr');
  const refreshButton = document.querySelector('#refresh-qr');
  const copyButton = document.querySelector('#copy-qr');
  const status = document.querySelector('#connection-status');
  const codePanel = document.querySelector('.pairing-code');
  const image = document.querySelector('#qr-image');
  const placeholder = document.querySelector('#qr-placeholder');
  const placeholderText = document.querySelector('#placeholder-text');
  const rawSection = document.querySelector('#raw-qr');
  const qrText = document.querySelector('#qr-text');
  const expiry = document.querySelector('#expires-in');
  const detail = document.querySelector('#pairing-detail');
  const feedback = document.querySelector('#feedback');
  const copyStatus = document.querySelector('#copy-status');

  const stateLabels = {
    connecting: 'Connecting',
    qr_required: 'Waiting for scan',
    reconnecting: 'Reconnecting',
    logged_out: 'Signed out',
    failed: 'Connection failed',
    stopped: 'Disconnected',
    connected: 'Connected',
  };

  let apiKey = '';
  let authorized = false;
  let connected = false;
  let currentRequest = null;
  let pollTimer = null;
  let expiryTimer = null;
  let expiresAt = null;
  let qrSignature = '';
  let pendingRefresh = false;
  let suspended = document.hidden;
  const refreshedCodes = new Set();

  function setFeedback(message) {
    feedback.textContent = message || '';
    feedback.hidden = !message;
  }

  function setStatus(state, label) {
    status.dataset.state = state;
    status.textContent = label || stateLabels[state] || 'Waiting for WhatsApp';
  }

  function setBusy(busy) {
    codePanel.setAttribute('aria-busy', String(busy));
    showButton.disabled = busy;
    refreshButton.disabled = busy;
    showButton.textContent = busy ? 'Please wait…' : 'Show QR code';
  }

  function stopTimers() {
    clearTimeout(pollTimer);
    clearInterval(expiryTimer);
    pollTimer = null;
    expiryTimer = null;
  }

  function clearCode(message) {
    clearInterval(expiryTimer);
    expiryTimer = null;
    expiresAt = null;
    qrSignature = '';
    image.hidden = true;
    image.removeAttribute('src');
    placeholder.hidden = false;
    placeholderText.textContent = message;
    qrText.value = '';
    rawSection.hidden = true;
    expiry.textContent = '';
    copyStatus.textContent = '';
  }

  function expireCode() {
    const expiredSignature = qrSignature;
    clearCode('This QR code has expired.');
    setStatus('qr_required', 'QR code expired');
    detail.textContent = 'A fresh code is needed before you can link your phone.';
    if (expiredSignature && !refreshedCodes.has(expiredSignature)) {
      refreshedCodes.add(expiredSignature);
      // Bound memory while retaining recent codes to avoid retrying a stale response.
      if (refreshedCodes.size > 30) refreshedCodes.delete(refreshedCodes.values().next().value);
      pendingRefresh = true;
      continueRequests();
    }
  }

  function updateExpiry() {
    if (expiresAt === null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expireCode();
      return;
    }
    const seconds = Math.ceil(remaining / 1000);
    expiry.textContent = `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function isQrImage(value) {
    return typeof value === 'string'
      && /^data:image\/(?:png;base64,|svg\+xml;(?:base64|charset=utf-8),|svg\+xml,)/i.test(value);
  }

  function render(data) {
    connected = data.connected === true;
    setStatus(connected ? 'connected' : data.state);
    refreshButton.hidden = connected || !authorized;
    setFeedback(data.error);

    if (connected) {
      pendingRefresh = false;
      clearCode('Your WhatsApp is connected.');
      detail.textContent = 'This device is linked. You can now send messages.';
      return;
    }

    if (typeof data.qr === 'string' && data.qr) {
      clearInterval(expiryTimer);
      qrSignature = `${data.generatedAt || ''}:${data.qr}`;
      const parsedExpiry = Date.parse(data.expiresAt);
      expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : null;
      if (expiresAt !== null && expiresAt <= Date.now()) {
        expireCode();
        return;
      }
      qrText.value = data.qr;
      rawSection.hidden = false;
      copyStatus.textContent = '';
      if (isQrImage(data.qrImage)) {
        image.src = data.qrImage;
        image.hidden = false;
        placeholder.hidden = true;
      } else {
        image.hidden = true;
        image.removeAttribute('src');
        placeholder.hidden = false;
        placeholderText.textContent = 'Use the QR code text below, or request a fresh code.';
      }
      detail.textContent = 'Scan this code with WhatsApp on your phone.';
      expiry.textContent = '';
      updateExpiry();
      if (expiresAt !== null && !suspended) expiryTimer = setInterval(updateExpiry, 1000);
      return;
    }

    const waiting = data.state === 'connecting' || data.state === 'reconnecting' || data.state === 'qr_required';
    clearCode(waiting ? 'Waiting for a pairing code…' : 'Request a fresh code to link your phone.');
    detail.textContent = waiting
      ? 'Keep this page open. The code will appear when WhatsApp is ready.'
      : 'Use Generate fresh QR to try connecting again.';
  }

  function continueRequests() {
    if (suspended || !authorized || !apiKey || currentRequest) return;
    clearTimeout(pollTimer);
    if (pendingRefresh && !connected) {
      pendingRefresh = false;
      void requestCode(true);
    } else {
      pollTimer = setTimeout(() => { void requestCode(false); }, 3000);
    }
  }

  async function requestCode(fresh) {
    if (!apiKey || suspended) return;
    if (currentRequest) {
      if (!fresh || currentRequest.fresh) return;
      currentRequest.controller.abort();
      currentRequest = null;
    }
    clearTimeout(pollTimer);
    const request = { controller: new AbortController(), fresh };
    currentRequest = request;
    const timeout = setTimeout(() => {
      request.timedOut = true;
      request.controller.abort();
    }, 30000);
    if (fresh) {
      setBusy(true);
      setFeedback('');
      if (!connected) {
        clearCode('Requesting a fresh pairing code…');
        setStatus('connecting');
        detail.textContent = 'Keep this page open while WhatsApp prepares the code.';
      }
    }

    try {
      const response = await fetch(fresh ? '/qr' : '/qr/status', {
        method: fresh ? 'POST' : 'GET',
        headers: { 'x-api-key': apiKey, ...(fresh ? { 'Content-Type': 'application/json' } : {}) },
        body: fresh ? JSON.stringify({ fresh: true }) : undefined,
        cache: 'no-store',
        credentials: 'omit',
        signal: request.controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (currentRequest !== request) return;
      if (response.status === 401 || response.status === 403) {
        authorized = false;
        apiKey = '';
        connected = false;
        pendingRefresh = false;
        stopTimers();
        clearCode('Enter a valid API key to show a QR code.');
        keyInput.required = true;
        keyInput.placeholder = '';
        refreshButton.hidden = true;
        setStatus('idle', 'API key required');
        setFeedback('The API key was not accepted. Enter the server API key and try again.');
        keyInput.focus();
        return;
      }
      if (!data || typeof data.state !== 'string' || typeof data.connected !== 'boolean') {
        throw new Error(response.ok ? 'The server returned an unexpected response. Try again.' : `The server could not provide a QR code (${response.status}). Try again.`);
      }
      if (!response.ok && response.status !== 503) {
        throw new Error(typeof data.error === 'string' ? data.error : 'The request failed. Try again.');
      }
      authorized = true;
      if (fresh) keyInput.value = '';
      keyInput.required = false;
      keyInput.placeholder = 'API key accepted';
      render(data);
    } catch (error) {
      if (currentRequest !== request || suspended) return;
      if (error.name !== 'AbortError' || request.timedOut) {
        setFeedback(request.timedOut
          ? 'The request timed out. Check the server connection, then try again.'
          : error instanceof TypeError
            ? 'Cannot reach the server. Check your connection and try again.'
            : error.message);
      }
    } finally {
      clearTimeout(timeout);
      if (currentRequest === request) {
        currentRequest = null;
        setBusy(false);
        continueRequests();
      }
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (currentRequest?.fresh) return;
    const enteredKey = keyInput.value.trim();
    if (enteredKey) {
      if (apiKey !== enteredKey) {
        authorized = false;
        connected = false;
        pendingRefresh = false;
        refreshedCodes.clear();
      }
      apiKey = enteredKey;
    }
    if (!apiKey) {
      setFeedback('Enter the server API key to show a QR code.');
      keyInput.focus();
      return;
    }
    void requestCode(true);
  });

  refreshButton.addEventListener('click', () => {
    pendingRefresh = false;
    void requestCode(true);
  });

  copyButton.addEventListener('click', async () => {
    if (expiresAt !== null && expiresAt <= Date.now()) updateExpiry();
    const value = qrText.value;
    if (!value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      copyStatus.textContent = 'QR code text copied.';
    } catch {
      qrText.focus();
      qrText.select();
      qrText.setSelectionRange(0, qrText.value.length);
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Keep the text selected for manual copying. */ }
      copyStatus.textContent = copied ? 'QR code text copied.' : 'QR text selected. Use your device’s Copy command.';
    }
  });

  function suspend() {
    suspended = true;
    stopTimers();
    if (qrText.value) clearCode('Checking pairing status when you return…');
    if (currentRequest) {
      currentRequest.controller.abort();
      currentRequest = null;
      setBusy(false);
    }
  }

  function resume() {
    suspended = false;
    if (expiresAt !== null) {
      updateExpiry();
      if (expiresAt !== null) expiryTimer = setInterval(updateExpiry, 1000);
    }
    if (authorized && !currentRequest) {
      if (pendingRefresh && !connected) {
        pendingRefresh = false;
        void requestCode(true);
      } else {
        void requestCode(false);
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else resume();
  });
  window.addEventListener('pagehide', () => {
    suspend();
    apiKey = '';
    authorized = false;
    connected = false;
    pendingRefresh = false;
    keyInput.value = '';
    keyInput.required = true;
    keyInput.placeholder = '';
    refreshButton.hidden = true;
    clearCode('Enter your API key to show a QR code.');
    setStatus('idle', 'Ready to pair');
    detail.textContent = 'Keep this page open while you link your phone.';
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted && !document.hidden) resume(); });
})();
