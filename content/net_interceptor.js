// AI Mail Reply - Network Interceptor (MAIN WORLD)
// Runs in the page's main world (NOT the content-script isolated world) so it
// can monkey-patch the REAL window.fetch and XMLHttpRequest that the mail SPA
// uses. It scans JSON responses for attachment download URLs and stashes them
// in a hidden DOM element so the isolated-world attachment_reader.js can read
// them by filename.
//
// Why main world? The Netease enterprise SPA (React + Ant Design) keeps
// download URLs in component state / API responses, never in the DOM. Content
// scripts run in an isolated world with their own copy of fetch, so hooking
// fetch there would miss the page's requests. This script must run at
// document_start to patch before the SPA makes any requests.

(function () {
  'use strict';
  if (window.__AI_MAIL_NET_INTERCEPTOR__) return; // guard against re-injection
  window.__AI_MAIL_NET_INTERCEPTOR__ = true;
  console.log('[AI Mail Reply] net_interceptor loaded in MAIN world');

  // Eagerly create both DOM bridge elements so the isolated-world content script
  // can detect that net_interceptor is active simply by checking their existence.
  function initStoreEl(id) {
    if (!document.getElementById(id)) {
      const el = document.createElement('script');
      el.id = id; el.type = 'application/json'; el.style.display = 'none'; el.textContent = '{}';
      (document.head || document.documentElement).appendChild(el);
    }
  }
  // Run immediately if possible, otherwise defer to DOMContentLoaded.
  function initStores() { initStoreEl('__ai_mail_attachment_urls__'); initStoreEl('__ai_mail_attachment_blobs__'); }
  if (document.head || document.documentElement) { initStores(); }
  else { document.addEventListener('DOMContentLoaded', initStores, { once: true }); }

  // ─── URL store (DOM-bridged for the isolated world) ─────────────────────────
  // We use a hidden <script type="application/json"> element as a shared bridge
  // because DOM is shared between main and isolated worlds; JS objects are not.
  const STORE_ID = '__ai_mail_attachment_urls__';
  function getStoreEl() {
    let el = document.getElementById(STORE_ID);
    if (!el) {
      el = document.createElement('script');
      el.id = STORE_ID;
      el.type = 'application/json';
      el.style.display = 'none';
      // document.head may not exist yet at document_start; use documentElement.
      (document.head || document.documentElement).appendChild(el);
      el.textContent = '{}';
    }
    return el;
  }
  function readStore() {
    try { return JSON.parse(getStoreEl().textContent || '{}'); } catch (_) { return {}; }
  }
  function writeStore(obj) {
    try { getStoreEl().textContent = JSON.stringify(obj); } catch (_) {}
  }
  function addUrl(filename, url) {
    if (!filename || !url) return;
    const store = readStore();
    // Don't overwrite a real URL with a less-useful one.
    if (store[filename] && store[filename].length > url.length) return;
    store[filename] = url;
    writeStore(store);
    console.log('[AI Mail Reply] net_interceptor captured: ' + filename + ' → ' + url.slice(0, 120));
  }

  // ─── Response scanner ───────────────────────────────────────────────────────
  // Deep-walk a parsed JSON response and collect { filename, url } pairs.
  // Heuristic: any object that has BOTH a name/filename field AND a url/href/
  // downloadUrl field is a candidate. Also collect any string that looks like
  // a download URL and associate it with the nearest filename in the same object.
  const FILENAME_KEYS = ['name', 'fileName', 'filename', 'file_name', 'title', 'displayName', 'attachmentName', 'origName', 'originName', 'realName'];
  const URL_KEYS = ['url', 'href', 'downloadUrl', 'downloadURL', 'fileUrl', 'fileURL', 'attachmentUrl', 'attachUrl', 'download', 'link', 'previewUrl', 'src', 'contentUrl', 'location', 'path'];

  function looksLikeDownloadUrl(s) {
    if (typeof s !== 'string' || s.length < 5) return false;
    const lower = s.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return false;
    if (lower === '#' || lower === '/') return false;
    // Accept absolute http(s) URLs and blob/data URIs.
    if (/^https?:\/\//i.test(s) || s.startsWith('blob:') || s.startsWith('data:')) return true;
    // Accept site-relative paths: Netease attachment URLs look like "/dav/...", "/api/...", "/ajax/...".
    // Exclude static asset paths and hash-navigation.
    if (s.startsWith('/') && s.length > 3 && !/^\/static\//.test(s) && !/#/.test(s)) return true;
    return false;
  }

  function looksLikeFilename(s) {
    if (typeof s !== 'string' || s.length < 2) return false;
    // Has an extension and no spaces-newlines typical of prose. Allow spaces in names.
    return /\.[a-z0-9]{2,8}(\?|$)/i.test(s) && !/[\n\r]/.test(s) && s.length < 300;
  }

  function scanObject(obj, found, depth) {
    if (!obj || depth > 10) return;
    if (Array.isArray(obj)) {
      for (const item of obj) scanObject(item, found, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      // Collect any filename and any url from THIS object's own keys.
      let filename = '';
      let url = '';
      for (const key of FILENAME_KEYS) {
        if (typeof obj[key] === 'string' && looksLikeFilename(obj[key])) { filename = obj[key]; break; }
      }
      for (const key of URL_KEYS) {
        if (typeof obj[key] === 'string' && looksLikeDownloadUrl(obj[key])) { url = obj[key]; break; }
      }
      // If this object has both, record the pair.
      if (filename && url) {
        found[filename] = url;
      }

      // Also collect all URL strings in this object in case a sibling/ancestor
      // object carries the filename. We store them in a side-channel keyed by
      // all filenames visible at this level — useful when Netease API returns
      // { attachmentList: [{ name, size }, ...], downloadUrls: { name: url } }.
      // Scan all string values for URLs and all string values for filenames,
      // then associate them if there's exactly one of each in this object scope.
      if (!filename || !url) {
        const allFilenames = [];
        const allUrls = [];
        for (const key of Object.keys(obj)) {
          const v = obj[key];
          if (typeof v === 'string') {
            if (looksLikeFilename(v)) allFilenames.push(v);
            if (looksLikeDownloadUrl(v)) allUrls.push(v);
          }
        }
        if (allFilenames.length === 1 && allUrls.length === 1) {
          found[allFilenames[0]] = allUrls[0];
        }
      }

      // Recurse into all values.
      for (const key of Object.keys(obj)) {
        scanObject(obj[key], found, depth + 1);
      }
    }
  }

  function processResponseText(text) {
    if (!text || text.length < 2) return;
    // Fast reject: only attempt JSON parse if it looks like JSON.
    const trimmed = text.trimLeft ? text.trimLeft() : text.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
    let data;
    try { data = JSON.parse(text); } catch (_) { return; }
    const found = {};
    scanObject(data, found, 0);
    for (const filename of Object.keys(found)) {
      addUrl(filename, found[filename]);
    }
  }

  // ─── Blob store (DOM-bridged for the isolated world) ────────────────────────
  // When Netease clicks "Download", it does:
  //   fetch(api) → blob → URL.createObjectURL(blob) → <a download>.click()
  // We intercept at the createObjectURL step (MAIN world only can do this) and
  // store the raw blob bytes as a base64 data-URL in a DOM element so the
  // isolated-world content script can read and parse them via pdf.js.
  const BLOB_STORE_ID = '__ai_mail_attachment_blobs__';
  function getBlobStoreEl() {
    let el = document.getElementById(BLOB_STORE_ID);
    if (!el) {
      el = document.createElement('script');
      el.id = BLOB_STORE_ID;
      el.type = 'application/json';
      el.style.display = 'none';
      el.textContent = '{}';
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function storeBlobForName(name, dataUrl) {
    try {
      const el = getBlobStoreEl();
      const store = JSON.parse(el.textContent || '{}');
      store[name] = dataUrl;
      el.textContent = JSON.stringify(store);
      console.log('[AI Mail Reply] net_interceptor: stored blob for', name, 'dataUrl length:', dataUrl.length);
    } catch (_) {}
  }

  // Track the most recent blob created (filename matched by the <a download> attr).
  let _pendingBlob = null;

  const _origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = _origCreateObjectURL.call(URL, obj);
    if (obj instanceof Blob && obj.size > 0) {
      _pendingBlob = obj;
      console.log('[AI Mail Reply] net_interceptor: createObjectURL intercepted, blob size:', obj.size);
    }
    return blobUrl;
  };

  // Watch for <a download> clicks that follow createObjectURL.
  document.addEventListener('click', function (e) {
    if (!_pendingBlob) return;
    const a = e.target && (e.target.tagName === 'A' ? e.target : e.target.closest('a'));
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const download = a.getAttribute('download') || a.getAttribute('data-filename') || '';
    if (!href.startsWith('blob:') && !download) return;

    const filename = download || href;
    const blob = _pendingBlob;
    _pendingBlob = null;

    // Convert blob to base64 data URL asynchronously and bridge to DOM.
    const reader = new FileReader();
    reader.onload = function () {
      storeBlobForName(filename, reader.result);
    };
    reader.readAsDataURL(blob);
    console.log('[AI Mail Reply] net_interceptor: <a download> click, filename:', filename);
  }, true);

  // Also watch for programmatic <a>.click() by overriding HTMLAnchorElement.click.
  // IMPORTANT: Only suppress the download when the plugin is actively reading an
  // attachment (__aiMailInterceptActive__). Otherwise always call the original so
  // downloads on other websites (or user-initiated downloads) work normally.
  const _origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.getAttribute('href') || '';
    const download = this.getAttribute('download') || '';
    if ((href.startsWith('blob:') || download) && window.__aiMailInterceptActive__) {
      const filename = download || filenameFromBlobHref(href);
      const blob = _pendingBlob;
      if (blob) {
        _pendingBlob = null;
        const reader = new FileReader();
        reader.onload = function () { storeBlobForName(filename || href, reader.result); };
        reader.readAsDataURL(blob);
        console.log('[AI Mail Reply] net_interceptor: programmatic <a>.click() suppressed (plugin active), filename:', filename);
        // Suppress the actual download — plugin will fetch PDF via the blob data URL.
        return;
      }
      if (href.startsWith('blob:')) {
        fetch(href).then(r => r.blob()).then(b => {
          const reader = new FileReader();
          reader.onload = function () { storeBlobForName(filename || href, reader.result); };
          reader.readAsDataURL(b);
          console.log('[AI Mail Reply] net_interceptor: fetched existing blob URL for:', filename || href);
        }).catch(() => {});
        return; // suppress while plugin is active
      }
    }
    // Not intercepting — call original so downloads work normally everywhere.
    return _origAnchorClick.apply(this, arguments);
  };

  // Helper: extract a filename from a blob: href (last resort, usually empty).
  function filenameFromBlobHref(href) { return ''; }

  // ─── Hook window.open (Netease opens PDF preview via window.open(signedUrl)) ──
  // Do NOT block the call — we record the URL and let the browser open the tab.
  // The URL is a signed NOS download link; we store it in net-store so the
  // isolated-world content script can fetch it directly to extract PDF text.
  const _origWindowOpen = window.open;
  window.open = function (url, target, features) {
    if (url && typeof url === 'string' && url.length > 5) {
      if (url.startsWith('blob:')) {
        // blob: URL — convert to data URL and store so content script can parse it.
        const blobToCapture = _pendingBlob;
        if (blobToCapture) {
          _pendingBlob = null;
          const reader = new FileReader();
          reader.onload = function () {
            storeBlobForName('__latest_blob__', reader.result);
            console.log('[AI Mail Reply] net_interceptor: window.open(blob:) captured pending blob, size:', blobToCapture.size);
          };
          reader.readAsDataURL(blobToCapture);
        } else {
          // Fetch the existing blob URL and convert.
          fetch(url).then(r => r.blob()).then(b => {
            const reader = new FileReader();
            reader.onload = function () {
              storeBlobForName('__latest_blob__', reader.result);
              console.log('[AI Mail Reply] net_interceptor: window.open(blob:) fetched existing blob, size:', b.size);
            };
            reader.readAsDataURL(b);
          }).catch(() => {});
        }
      } else {
        // http(s) URL — only intercept when the plugin's attachment reader is
        // actively running (flag set by attachment_reader.js). When the user
        // manually clicks Preview/Download we must NOT suppress the tab.
        if (!window.__aiMailInterceptActive__) {
          return _origWindowOpen.apply(this, arguments);
        }

        const derivedName = filenameFromUrl(url);
        console.log('[AI Mail Reply] net_interceptor: window.open intercepted url:', url.slice(0, 120), 'derived filename:', derivedName);

        let bestUrl = url;
        let bestName = derivedName;
        let extracted = false;
        try {
          const u = new URL(url, location.href);
          const fileUrl = u.searchParams.get('fileUrl');
          const fileName = u.searchParams.get('fileName');
          if (fileName) bestName = decodeURIComponent(fileName);
          if (fileUrl) {
            bestUrl = decodeURIComponent(fileUrl);
            extracted = true;
            console.log('[AI Mail Reply] net_interceptor: extracted fileUrl from attachment page:', bestUrl.slice(0, 120));
          }
        } catch (_) {}

        if (bestName) addUrl(bestName, bestUrl);
        addUrl(url, url);
        registerPdfResponse(bestUrl, '');
        if (bestUrl !== url) registerPdfResponse(url, '');

        if (extracted) {
          console.log('[AI Mail Reply] net_interceptor: suppressing window.open (fileUrl extracted, plugin-initiated)');
          return null;
        }
      }
    }
    // Let the browser open the tab only if we couldn't extract the URL.
    return _origWindowOpen.apply(this, arguments);
  };

  // ─── Extract a filename from a URL's path or content-disposition ───────────
  // Used to key the URL store for binary (PDF) downloads whose response body
  // isn't JSON — we register the REQUEST url so the isolated world can fetch it.
  function filenameFromUrl(urlStr) {
    if (!urlStr) return '';
    try {
      const u = new URL(urlStr, location.href);
      // Last path segment, strip query/hash.
      let seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      // Strip a trailing query-like suffix that slipped into pathname.
      seg = seg.split(/[?#]/)[0];
      // Heuristic: keep only if it looks like a filename (has an extension).
      if (/\.[a-z0-9]{2,8}$/i.test(seg)) return seg;
      // Fall back to a `filename=` query param — but ONLY if the path looks
      // like a download endpoint (not a log/analytics endpoint).
      const p = u.pathname.toLowerCase();
      if (/download|attach|file|preview|dav/i.test(p)) {
        const fn = u.searchParams.get('filename') || u.searchParams.get('fileName') || '';
        if (fn) return decodeURIComponent(fn);
      }
      return '';
    } catch (_) { return ''; }
  }

  function looksPdfContentType(ct) {
    if (!ct) return false;
    const l = ct.toLowerCase();
    return l.indexOf('application/pdf') !== -1 || l.indexOf('-pdf') !== -1;
  }

  // Register a binary (PDF) response: store request URL keyed by derived filename.
  function registerPdfResponse(reqUrl, contentType) {
    if (!reqUrl) return;
    const name = filenameFromUrl(reqUrl);
    if (name) addUrl(name, reqUrl);
    // Always also keep the raw URL in a flat list — isolated world can scan it.
    try {
      const el = document.getElementById('__ai_mail_pdf_urls__') || (() => {
        const e = document.createElement('script');
        e.id = '__ai_mail_pdf_urls__'; e.type = 'application/json'; e.style.display = 'none';
        e.textContent = '[]';
        (document.head || document.documentElement).appendChild(e);
        return e;
      })();
      const arr = JSON.parse(el.textContent || '[]');
      arr.push({ url: reqUrl, name, ct: contentType || '', t: Date.now() });
      // Keep last 50 entries to avoid unbounded growth.
      if (arr.length > 50) arr.splice(0, arr.length - 50);
      el.textContent = JSON.stringify(arr);
    } catch (_) {}
  }

  // ─── Hook fetch ─────────────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      // Capture request URL synchronously (input may be a Request object).
      let reqUrl = '';
      try {
        reqUrl = (typeof input === 'string') ? input
              : (input && input.url) ? input.url
              : '';
      } catch (_) {}
      return originalFetch.apply(this, arguments).then(response => {
        try {
          const ct = response.headers.get('content-type') || '';
          if (ct.indexOf('json') !== -1 || ct.indexOf('text') !== -1) {
            // Clone so the page still gets the body. Scan JSON-ish bodies.
            response.clone().text().then(processResponseText).catch(() => {});
          }
          // Binary PDF responses: SPA often fetches the PDF via fetch() for
          // preview/download. Register the request URL so the isolated world
          // can fetch it again to extract text. ONLY register by content-type
          // to avoid false positives from analytics URLs.
          if (looksPdfContentType(ct)) {
            registerPdfResponse(response.url || reqUrl, ct);
          }
        } catch (_) {}
        return response;
      });
    };
  }

  // ─── Hook XMLHttpRequest ────────────────────────────────────────────────────
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalAddEventListener = XMLHttpRequest.prototype.addEventListener;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ai_url__ = url;
    return originalOpen.apply(this, arguments);
  };

  // Helper: scan XHR response text when the request completes.
  function tryProcessXhr(xhr) {
    if (xhr.readyState !== 4) return;
    try {
      const ct = xhr.getResponseHeader('content-type') || '';
      if (ct.indexOf('json') !== -1 || ct.indexOf('text') !== -1) {
        processResponseText(xhr.responseText);
      }
      // Binary PDF responses via XHR: register the request URL.
      // ONLY register by content-type — never by URL pattern, to avoid
      // false positives from analytics/reporting URLs that contain
      // "filename=xxx.pdf" in query params (e.g. log:report&action=attach_preview).
      if (looksPdfContentType(ct)) {
        registerPdfResponse(xhr.responseURL || xhr.__ai_url__, ct);
      }
    } catch (_) {}
  }

  XMLHttpRequest.prototype.send = function (body) {
    const self = this;
    // Wrap onreadystatechange (property-style handler).
    const originalOnReady = this.onreadystatechange;
    this.onreadystatechange = function () {
      tryProcessXhr(self);
      if (typeof originalOnReady === 'function') originalOnReady.apply(this, arguments);
    };
    // Also wrap onload — Netease SPA commonly uses xhr.onload instead of
    // onreadystatechange. We wrap it lazily after send() since it may be
    // assigned after send() in some SPA patterns.
    const originalOnLoad = this.onload;
    this.onload = function (event) {
      tryProcessXhr(self);
      if (typeof originalOnLoad === 'function') return originalOnLoad.apply(this, arguments);
    };
    return originalSend.apply(this, arguments);
  };

  // Also intercept addEventListener-style handlers. The Netease SPA uses both
  // styles; patching only onreadystatechange misses addEventListener calls.
  XMLHttpRequest.prototype.addEventListener = function (type, listener, options) {
    if (type === 'readystatechange' || type === 'load') {
      const self = this;
      const wrapped = function (event) {
        tryProcessXhr(self);
        return listener.apply(this, arguments);
      };
      return originalAddEventListener.call(this, type, wrapped, options);
    }
    return originalAddEventListener.apply(this, arguments);
  };
})();
