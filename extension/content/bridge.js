// XActions Extension — Content Script Bridge
// Injected into x.com/twitter.com pages
// Bridges popup ↔ page context via chrome.runtime messaging
// by nichxbt

(() => {
  // Prevent double-injection
  if (window.__xactions_bridge_loaded) return;
  window.__xactions_bridge_loaded = true;

  // ============================================
  // INJECT AUTOMATION CODE INTO PAGE CONTEXT
  // ============================================
  // x.com's CSP uses a nonce-based script-src allowlist that blocks both
  // <script src="chrome-extension://..."> and inline injection from the page
  // context. Ask the service worker to run chrome.scripting.executeScript with
  // world:'MAIN', which bypasses the page CSP entirely.
  function injectScript() {
    try {
      chrome.runtime.sendMessage({ type: 'INJECT_PAGE_SCRIPT' }, () => {
        // If the service worker is not available or fails, fall back to the
        // legacy <script src> injection (may be CSP-blocked on x.com).
        if (chrome.runtime.lastError) {
          const script = document.createElement('script');
          script.src = chrome.runtime.getURL('content/injected.js');
          script.onload = () => script.remove();
          (document.head || document.documentElement).appendChild(script);
        }
      });
    } catch {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/injected.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    }
  }

  // Wait for DOM ready then inject
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectScript);
  } else {
    injectScript();
  }

  // ============================================
  // PAGE ↔ EXTENSION MESSAGING
  // ============================================
  
  // Listen for messages from injected page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'xactions-page') return;

    const msg = event.data;

    switch (msg.type) {
      case 'ACTION_PERFORMED':
        chrome.runtime.sendMessage({
          type: 'ACTION_PERFORMED',
          automationId: msg.automationId,
          action: msg.action,
        });
        chrome.runtime.sendMessage({
          type: 'ACTIVITY_LOG',
          entry: {
            time: Date.now(),
            type: 'action',
            automation: msg.automationId,
            message: msg.action,
          },
        });
        // Relay to the backend agent socket.
        chrome.runtime.sendMessage({
          type: 'AGENT_BRIDGE_MESSAGE',
          message: msg,
        });
        break;

      case 'AUTOMATION_COMPLETE':
        chrome.runtime.sendMessage({
          type: 'ACTIVITY_LOG',
          entry: {
            time: Date.now(),
            type: 'complete',
            automation: msg.automationId,
            message: `${msg.automationId} completed — ${msg.summary || 'done'}`,
          },
        });
        chrome.runtime.sendMessage({
          type: 'AGENT_BRIDGE_MESSAGE',
          message: msg,
        });
        break;

      case 'AUTOMATION_ERROR':
        chrome.runtime.sendMessage({
          type: 'ACTIVITY_LOG',
          entry: {
            time: Date.now(),
            type: 'error',
            automation: msg.automationId,
            message: msg.error,
          },
        });
        chrome.runtime.sendMessage({
          type: 'AGENT_BRIDGE_MESSAGE',
          message: msg,
        });
        break;

      case 'ACCOUNT_INFO':
        // Forward account info back to whoever requested it
        chrome.runtime.sendMessage({
          type: 'ACCOUNT_INFO_RESPONSE',
          data: msg.data,
        });
        break;

      case 'LLM_REQUEST':
        // x.com's CSP blocks the page from reaching LLM providers directly.
        // The service worker has host permissions for them, so relay the
        // chat-completion request there and post the answer back to the page.
        chrome.runtime.sendMessage({ type: 'LLM_REQUEST', id: msg.id, request: msg.request }, (response) => {
          const err = chrome.runtime.lastError;
          window.postMessage({
            source: 'xactions-extension',
            type: 'LLM_RESPONSE',
            id: msg.id,
            text: response?.text || '',
            model: response?.model || '',
            error: err ? err.message : (response?.error || null),
          }, '*');
        });
        break;
    }
  });

  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'RUN_AUTOMATION':
        window.postMessage({
          source: 'xactions-extension',
          type: 'RUN_AUTOMATION',
          automationId: message.automationId,
          settings: message.settings,
        }, '*');
        sendResponse({ success: true });
        break;

      case 'STOP_AUTOMATION':
        window.postMessage({
          source: 'xactions-extension',
          type: 'STOP_AUTOMATION',
          automationId: message.automationId,
        }, '*');
        sendResponse({ success: true });
        break;

      case 'STOP_ALL':
        window.postMessage({
          source: 'xactions-extension',
          type: 'STOP_ALL',
        }, '*');
        sendResponse({ success: true });
        break;

      case 'PAUSE_ALL':
        window.postMessage({
          source: 'xactions-extension',
          type: 'PAUSE_ALL',
        }, '*');
        sendResponse({ success: true });
        break;

      case 'RESUME_ALL':
        window.postMessage({
          source: 'xactions-extension',
          type: 'RESUME_ALL',
        }, '*');
        sendResponse({ success: true });
        break;

      case 'GET_ACCOUNT_INFO':
        // Ask the page script for the account and resolve THIS message with
        // the data, so the service worker's sendMessage promise gets the
        // account directly instead of via a separate ACCOUNT_INFO_RESPONSE.
        window.postMessage({
          source: 'xactions-extension',
          type: 'GET_ACCOUNT_INFO',
        }, '*');

        const onAccountInfo = (event) => {
          if (event.source !== window) return;
          if (!event.data || event.data.source !== 'xactions-page') return;
          if (event.data.type !== 'ACCOUNT_INFO') return;
          window.removeEventListener('message', onAccountInfo);
          sendResponse({ data: event.data.data });
        };
        window.addEventListener('message', onAccountInfo);
        // Timeout fallback: if the page never answers (injected not ready),
        // resolve anyway so the caller can retry.
        setTimeout(() => {
          window.removeEventListener('message', onAccountInfo);
        }, 3000);
        break;

      case 'AGENT_CONNECT':
        // Ask the page script for the current account; the reply flows back
        // through ACCOUNT_INFO -> ACCOUNT_INFO_RESPONSE.
        window.postMessage({
          source: 'xactions-extension',
          type: 'AGENT_CONNECT',
        }, '*');
        sendResponse({ success: true });
        break;

      case 'AGENT_DISCONNECT':
        window.postMessage({
          source: 'xactions-extension',
          type: 'AGENT_DISCONNECT',
        }, '*');
        sendResponse({ success: true });
        break;

      case 'PING':
        sendResponse({ pong: true });
        break;

      default:
        sendResponse({ error: 'Unknown message type' });
    }
    return true;
  });

  console.log('🔌 XActions bridge loaded');
})();
