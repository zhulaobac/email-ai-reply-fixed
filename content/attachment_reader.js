// AI Mail Reply - Attachment Reader
// Extracts text from email attachments (PDF only for now) so the AI can read
// attachment contents (e.g. PO numbers, product quantities) instead of just filenames.
//
// Loaded BEFORE content.js (see manifest.json content_scripts.js order).
// Exposes a single namespace on the content-script isolated world:
//   window.AIAttachment = { discoverAttachmentLinks, downloadAttachmentText,
//                           isPdfName, configureDebugDump }

(function () {
  const MAX_PAGES = 5;      // summary-page strategy: only read first N pages
  const MAX_CHARS = 6000;   // hard cap on extracted text length

  // ─── pdf.js bootstrap ───────────────────────────────────────────────────────
  // pdf.min.js is injected before this file and assigns window.pdfjsLib.
  // We set the worker once, lazily, on first use. MV3 CSP blocks eval/wasm-eval
  // in extension pages, but content scripts run in the page's context and the
  // worker is served via web_accessible_resources, so this works.
  let _pdfjsConfigured = false;
  function ensurePdfjs() {
    if (_pdfjsConfigured) return;
    if (typeof window.pdfjsLib === 'undefined') {
      throw new Error('pdf.js 未加载');
    }
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL('content/lib/pdf.worker.min.js');
      // Disable eval-based optimizations to stay friendly with strict CSP.
      if ('isEvalSupported' in window.pdfjsLib.GlobalWorkerOptions) {
        window.pdfjsLib.GlobalWorkerOptions.isEvalSupported = false;
      }
    } catch (e) {
      // Fall through; pdf.js can run without a worker (fake worker) as last resort.
      console.warn('[AI Mail Reply] pdf.js worker 配置失败，将使用降级模式:', e && e.message);
    }
    _pdfjsConfigured = true;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function isPdfName(name) {
    return /\.pdf(\?|$)/i.test((name || '').trim());
  }

  // Resolve a possibly-relative URL against the page origin.
  function resolveUrl(url) {
    if (!url) return '';
    try { return new URL(url, location.href).href; } catch (_) { return ''; }
  }

  // Heuristic: drop obviously non-resource hrefs.
  function looksLikeResourceUrl(url) {
    if (!url) return false;
    const u = url.trim().toLowerCase();
    if (!u) return false;
    if (u.startsWith('javascript:') || u.startsWith('mailto:') || u.startsWith('tel:')) return false;
    if (u === '#' || u === '/' ) return false;
    return true;
  }

  // Extract a clean filename from an attachment card element.
  function extractName(card) {
    let raw = '';
    const nameEl = card.querySelector('.attachment-name, [class*="attachment-name"]');
    if (nameEl && nameEl.textContent.trim()) {
      raw = nameEl.textContent.trim();
    } else {
      // The whole card text looks like "PO 2264.pdf83.4KOpenOpen folderDownload"
      raw = (card.textContent || '').trim();
    }
    // Strip trailing size + action labels: "PO 2264.pdf83.4KOpen..." → "PO 2264.pdf"
    const m = raw.match(/^(.*\.[a-zA-Z]{2,6})/);
    return m ? m[1] : raw;
  }

  // ─── React fiber access ─────────────────────────────────────────────────────
  // The Netease enterprise SPA is React + Ant Design. Download URLs are NOT
  // rendered to the DOM — they live in React component props/state (fiber).
  // Content scripts can read fiber via the __reactFiber$ / __reactInternalInstance$
  // keys React attaches to DOM nodes.

  const FIBER_KEYS = (() => {
    const keys = [];
    for (const k of Object.keys(document.body)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) keys.push(k);
    }
    // Fall back to common prefixes if none found on body yet (e.g. before mount).
    if (!keys.length) {
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      for (const k of Object.keys(probe)) {
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) keys.push(k);
      }
      probe.remove();
    }
    return keys;
  })();

  function getFiber(el) {
    if (!el || !FIBER_KEYS.length) return null;
    for (const k of FIBER_KEYS) {
      if (el[k]) return el[k];
    }
    return null;
  }

  // Walk up the fiber tree collecting every memoizedProps and memoizedState object.
  // memoizedState covers React function-component hooks (useState/useReducer) where
  // SPA download URLs typically live — props alone won't find them.
  // Returns an array of { depth, type, props } snapshots for inspection.
  function collectFiberProps(el, maxDepth = 25) {
    const snapshots = [];
    let fiber = getFiber(el);
    let depth = 0;
    while (fiber && depth < maxDepth) {
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object' && !Array.isArray(props)) {
        snapshots.push({ depth, type: fiber.type, props });
      }
      // Scan the hooks chain (memoizedState) for function component state
      let hook = fiber.memoizedState;
      while (hook) {
        if (hook.memoizedState && typeof hook.memoizedState === 'object') {
          snapshots.push({ depth: depth + 0.1, type: 'hook', props: hook.memoizedState });
        }
        hook = hook.next;
      }
      fiber = fiber.return;
      depth++;
    }
    return snapshots;
  }

  // Walk down the fiber tree (child + sibling chain) collecting memoizedProps + hooks.
  function collectFiberPropsDeep(el, maxDepth = 15) {
    const snapshots = [];
    function walk(fiber, depth) {
      if (!fiber || depth > maxDepth) return;
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object' && !Array.isArray(props)) {
        snapshots.push({ depth, type: fiber.type, props });
      }
      let hook = fiber.memoizedState;
      while (hook) {
        if (hook.memoizedState && typeof hook.memoizedState === 'object') {
          snapshots.push({ depth: depth + 0.1, type: 'hook', props: hook.memoizedState });
        }
        hook = hook.next;
      }
      walk(fiber.child, depth + 1);
      walk(fiber.sibling, depth);
    }
    walk(getFiber(el), 0);
    return snapshots;
  }

  // Deep-scan a fiber props snapshot for anything URL-ish.
  // Returns the first string that looks like a resource URL.
  function scanForUrl(obj, seen = new WeakSet(), depth = 0) {
    if (!obj || depth > 6) return '';
    if (typeof obj === 'string') {
      // Accept http(s) URLs, site-relative paths, blob:, data: that look like downloads.
      if (/^https?:\/\//i.test(obj) && looksLikeResourceUrl(obj)) return obj;
      if (/^\/[^/\s]/.test(obj) && /\.(pdf|download|attach|file)/i.test(obj)) return resolveUrl(obj);
      if (/^\/[^/\s]/.test(obj) && /download|attach|file/i.test(obj)) return resolveUrl(obj);
      if (/^blob:/.test(obj) || /^data:/.test(obj)) return obj;
      return '';
    }
    if (typeof obj !== 'object' || seen.has(obj)) return '';
    seen.add(obj);
    // Prefer keys that semantically hint at a download URL.
    const preferred = ['downloadUrl', 'downloadURL', 'url', 'href', 'src', 'fileUrl',
                       'attachmentUrl', 'link', 'download', 'file', 'previewUrl', 'attachUrl',
                       'contentUrl', 'location', 'path', 'downloadLink', 'fileUrlLink'];
    for (const key of preferred) {
      if (obj[key] != null) {
        const found = scanForUrl(obj[key], seen, depth + 1);
        if (found) return found;
      }
    }
    // Then any string-valued property.
    for (const key of Object.keys(obj)) {
      if (preferred.includes(key)) continue;
      const found = scanForUrl(obj[key], seen, depth + 1);
      if (found) return found;
    }
    return '';
  }

  // ─── Network-interceptor URL store ──────────────────────────────────────────
  // net_interceptor.js (MAIN world) stashes { filename: downloadUrl } pairs in
  // a hidden <script id="__ai_mail_attachment_urls__"> element. We read it here
  // (DOM is shared between main and isolated worlds) and match by filename.
  const NET_STORE_ID = '__ai_mail_attachment_urls__';
  function readNetStore() {
    try {
      const el = document.getElementById(NET_STORE_ID);
      if (!el) return {};
      return JSON.parse(el.textContent || '{}');
    } catch (_) { return {}; }
  }

  // PDF-blob URL store: net_interceptor.js logs every fetch/XHR whose content-
  // type is application/pdf into a hidden <script id="__ai_mail_pdf_urls__">.
  // This catches SPA preview/download requests that don't expose a filename-keyed
  // entry in the main URL store (e.g. URLs without a .pdf path segment).
  function readPdfUrlStore() {
    try {
      const el = document.getElementById('__ai_mail_pdf_urls__');
      if (!el) return [];
      return JSON.parse(el.textContent || '[]');
    } catch (_) { return []; }
  }
  function findPdfUrlFromStore(name) {
    if (!name) return '';
    const lower = name.toLowerCase();
    const base = lower.replace(/\.[^.]+$/, ''); // "po 2264"
    // 1. Main URL store (filename → url).
    const main = readNetStore();
    if (main[name]) {
      // Sanity: skip known non-PDF endpoints (analytics, logging).
      if (!isNonPdfEndpoint(main[name])) return main[name];
    }
    for (const k of Object.keys(main)) {
      if (k.toLowerCase() === lower && !isNonPdfEndpoint(main[k])) return main[k];
    }
    // 2. PDF URL store (recent PDF fetches). Match by filename in URL path or
    //    by the derived `name` net_interceptor stored alongside the url.
    const pdfList = readPdfUrlStore();
    // Prefer entries whose stored `name` matches and aren't non-PDF endpoints.
    let best = '';
    for (const e of pdfList) {
      if (!e.url) continue;
      if (isNonPdfEndpoint(e.url)) continue;  // skip analytics/logging
      const ename = (e.name || '').toLowerCase();
      if (ename === lower) return e.url;
      if (ename && ename.indexOf(lower) !== -1) best = e.url;
      // URL path contains the filename or its base.
      const u = e.url.toLowerCase();
      if (u.indexOf(lower) !== -1 || (base && u.indexOf(base) !== -1)) best = e.url;
    }
    return best;
  }

  // Heuristic: detect URLs that are clearly NOT serving the actual PDF binary
  // (analytics, logging, reporting endpoints that happen to reference the
  // filename in query params).
  function isNonPdfEndpoint(url) {
    if (!url) return false;
    const l = url.toLowerCase();
    return l.indexOf('func=log') !== -1 ||
           l.indexOf('log:report') !== -1 ||
           l.indexOf('/log/') !== -1 ||
           l.indexOf('action=attach_preview') !== -1 ||
           l.indexOf('analytics') !== -1 ||
           l.indexOf('sentry') !== -1 ||
           l.indexOf('hubble') !== -1 ||
           l.indexOf('bi.log') !== -1;
  }
  function findUrlFromNetStore(name) {
    if (!name) return '';
    // New combined lookup (covers both filename-keyed and PDF-blob stores).
    const hit = findPdfUrlFromStore(name);
    if (hit) return hit;
    const store = readNetStore();
    // Substring match (filename may have extra suffix in store or vice-versa).
    const lower = name.toLowerCase();
    for (const key of Object.keys(store)) {
      if (key.toLowerCase().indexOf(lower) !== -1 || lower.indexOf(key.toLowerCase()) !== -1) {
        return store[key];
      }
    }
    return '';
  }

  // Try to extract a download URL from the React fiber of a card element.
  function findUrlFromFiber(card) {
    // Walk up first (ancestor chain).
    let snapshots = collectFiberProps(card);
    for (const snap of snapshots) {
      const url = scanForUrl(snap.props);
      if (url) return url;
    }
    // Walk down (child/sibling chain).
    snapshots = collectFiberPropsDeep(card);
    for (const snap of snapshots) {
      const url = scanForUrl(snap.props);
      if (url) return url;
    }
    return '';
  }

  // ─── Resource Timing fallback ───────────────────────────────────────────────
  // performance.getEntriesByType('resource') lists every network resource the
  // browser fetched on this page. If the SPA fetched the PDF (preview/download)
  // but net_interceptor didn't capture a filename, we can still find the URL
  // here. We look for recent PDF-ish requests whose URL contains the filename
  // or its base, or whose path ends in .pdf.
  function findUrlFromResourceTiming(name) {
    if (!name) return '';
    try {
      const entries = performance.getEntriesByType('resource');
      const lower = name.toLowerCase();
      const base = lower.replace(/\.[^.]+$/, '').trim();
      let best = '';
      for (const e of entries) {
        const u = (e.name || '').toLowerCase();
        if (!u) continue;
        const isPdfUrl = /\.pdf(\?|#|$)/i.test(e.name) || u.indexOf('pdf') !== -1;
        const matchesName = u.indexOf(lower) !== -1;
        const matchesBase = base && base.length > 3 && u.indexOf(base) !== -1;
        if (isPdfUrl && (matchesName || matchesBase)) {
          // Prefer same-origin (most likely the real attachment fetch).
          best = e.name;
          if (e.name.indexOf(location.host) !== -1) return e.name;
        }
      }
      return best;
    } catch (_) { return ''; }
  }

  // ─── URL discovery ─────────────────────────────────────────────────────────
  // Strategy ladder for finding a download URL inside an attachment card:
  //   0. Network-interceptor store (filename + PDF-blob stores)
  //   1. React fiber props (SPA: URL is in component state, not DOM)
  //   2. <a download>  — explicit download link
  //   3. [class*="download"] / [class*="down"] <a href>  — download-styled link
  //   4. any <a href> that looks like a resource URL
  //   5. data-url / data-href / data-src attributes on the card or its children
  //   6. Resource Timing API (browser-recorded PDF fetches)
  function findUrlInCard(card) {
    const name = extractName(card);

    // 0. Network-interceptor stores (most reliable for SPA)
    const netUrl = findPdfUrlFromStore(name) || findUrlFromNetStore(name);
    if (netUrl) return netUrl;

    // 1. React fiber (SPA: URL is in component state, not DOM)
    const fiberUrl = findUrlFromFiber(card);
    if (fiberUrl) return fiberUrl;

    // 2. explicit <a download>
    let a = card.querySelector('a[download]');
    if (a) { const u = resolveUrl(a.getAttribute('href')); if (looksLikeResourceUrl(u)) return u; }

    // 3. download-styled anchor
    a = card.querySelector('a[class*="download"], a[class*="down"], [class*="download"] a');
    if (a) { const u = resolveUrl(a.getAttribute('href')); if (looksLikeResourceUrl(u)) return u; }

    // 4. any anchor with a real href
    const anchors = card.querySelectorAll('a[href]');
    for (const an of anchors) {
      const u = resolveUrl(an.getAttribute('href'));
      if (looksLikeResourceUrl(u)) return u;
    }

    // 5. data-* attributes on card or descendants
    const dataHolders = [card, ...card.querySelectorAll('[data-url], [data-href], [data-src]')];
    for (const el of dataHolders) {
      for (const key of ['data-url', 'data-href', 'data-src']) {
        const u = resolveUrl(el.getAttribute(key));
        if (looksLikeResourceUrl(u)) return u;
      }
    }

    // 6. Resource Timing API — browser-recorded PDF fetches (last-resort).
    const rtUrl = findUrlFromResourceTiming(name);
    if (rtUrl) return rtUrl;

    return '';
  }

  // Find all attachment cards in the Netease enterprise readmail container.
  // Returns [{ name, url, el }, ...]. Cards without a name are skipped.
  // Also merges in any net-interceptor-store URLs whose filename wasn't matched
  // to a card (covers cases where the DOM rendered differently than expected).
  function discoverAttachmentLinks(scope) {
    scope = scope || document;
    const container = scope.querySelector('[class*="readmail-attachments"]');
    const results = [];

    if (container) {
      // Card selectors mirror the ones in content.js readNeteaseEnterprise.
      let cards = [...container.querySelectorAll('[class*="attachment-card"], [class*="attachment "]')];
      // Some layouts put each attachment in an element that has the name but not a "card" class;
      // fall back to grouping by the name element.
      if (cards.length === 0) {
        const names = [...container.querySelectorAll('.attachment-name, [class*="attachment-name"]')];
        cards = names.map(n => n.closest('[class*="attachment"]') || n.parentElement).filter(Boolean);
      }

      const seen = new Set();
      for (const card of cards) {
        const name = extractName(card);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        results.push({ name, url: findUrlInCard(card), el: card });
      }
    }

    // Merge net-store entries not already captured (e.g. PDF files whose card
    // wasn't found but whose URL was intercepted from the SPA API).
    const netStore = readNetStore();
    const known = new Set(results.map(r => r.name.toLowerCase()));
    for (const filename of Object.keys(netStore)) {
      if (!known.has(filename.toLowerCase()) && isPdfName(filename)) {
        results.push({ name: filename, url: netStore[filename], el: null });
      }
    }
    return results;
  }

  // ─── Async URL discovery: Ant Design dropdown trigger ───────────────────────
  // The attachment card has class ant-dropdown-trigger; clicking it opens a
  // menu overlay (lazily rendered, not in DOM until opened) that contains a
  // "Download" action with the real href. We click, wait for the overlay, read
  // the anchors, then click the card again (or outside) to close it.
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function dispatchMouse(el, type, button) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: button || 0 }));
  }

  async function findUrlByDropdownClick(card) {
    console.log('[AI Mail Reply] findUrlByDropdownClick called, card className:', card.className.slice(0, 100));

    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };

    // ── Phase 1: hover → poll net-store (Netease fetches URL lazily on hover) ─
    const cardName = extractName(card);
    dispatchMouse(card, 'mouseenter');
    dispatchMouse(card, 'mouseover');
    console.log('[AI Mail Reply] hover triggered, polling net-store for:', cardName);
    for (let i = 0; i < 12; i++) {   // 12 × 250 ms = 3 s
      await sleep(250);
      const u = findUrlFromNetStore(cardName);
      if (u) {
        console.log('[AI Mail Reply] net-store found URL after hover (' + ((i + 1) * 250) + 'ms):', u.slice(0, 100));
        dispatchMouse(card, 'mouseleave');
        return u;
      }
    }
    dispatchMouse(card, 'mouseleave');
    console.log('[AI Mail Reply] net-store empty after hover; trying dropdown strategies');

    // ── Phase 2: try contextmenu (right-click) on card ───────────────────────
    // The Ant Design card has a right-click context menu with a Download option.
    try {
      const snapshot1 = new Set([...document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu')].filter(isVisible));
      dispatchMouse(card, 'contextmenu', 2);
      let overlay = null;
      for (let i = 0; i < 30; i++) {
        await sleep(50);
        const visible = [...document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu')].filter(isVisible);
        overlay = visible.find(d => !snapshot1.has(d));
        if (overlay) { console.log('[AI Mail Reply] contextmenu overlay appeared (' + (i * 50) + 'ms)'); break; }
      }

      // ── Phase 3: hunt for "more" icon button (excludes operate/open buttons) ─
      if (!overlay) {
        console.log('[AI Mail Reply] contextmenu: no overlay; hunting more-icon button');
        dispatchMouse(card, 'mouseenter');
        dispatchMouse(card, 'mouseover');
        await sleep(200);

        // The more-icon is typically the last small interactive child that is
        // NOT the operate (open-file) button. "operate" class = open-file button.
        let moreBtn = null;
        const allChildren = [...card.querySelectorAll('*')].filter(isVisible);
        for (let i = allChildren.length - 1; i >= 0; i--) {
          const child = allChildren[i];
          const cls = typeof child.className === 'string' ? child.className : '';
          if (/operate/i.test(cls)) continue;   // skip the open-file button
          const tag = child.tagName;
          if (tag === 'SVG' || tag === 'SPAN' || tag === 'I' || tag === 'BUTTON') {
            moreBtn = child;
            break;
          }
        }

        if (moreBtn) {
          console.log('[AI Mail Reply] clicking more-icon:', (typeof moreBtn.className === 'string' ? moreBtn.className : '').slice(0, 80));
          const snapshot2 = new Set([...document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu')].filter(isVisible));
          moreBtn.click();
          for (let i = 0; i < 30; i++) {
            await sleep(50);
            const visible = [...document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu')].filter(isVisible);
            overlay = visible.find(d => !snapshot2.has(d));
            if (overlay) { console.log('[AI Mail Reply] more-icon overlay appeared (' + (i * 50) + 'ms)'); break; }
          }
        }
        dispatchMouse(card, 'mouseleave');
      }

      // ── Phase 4: click Download in the overlay, read blob from MAIN-world store ──
      // net_interceptor.js (MAIN world) has pre-installed interceptors for
      // URL.createObjectURL and HTMLAnchorElement.prototype.click. When Download
      // is clicked the SPA fetches the PDF, creates a blob, and tries to trigger
      // a browser download. The interceptor captures the blob, converts it to a
      // base64 data URL, and writes it into a DOM bridge element. We poll that
      // element here from the isolated world.
      let url = '';
      if (overlay) {
        // 4a. Quick anchor href check.
        for (const a of overlay.querySelectorAll('a[href]')) {
          const u = resolveUrl(a.getAttribute('href'));
          if (looksLikeResourceUrl(u)) { url = u; break; }
        }

        // 4b. Trigger a menu item to make the SPA fetch the PDF. We prefer
        // "Preview" then "Download". Both cause the SPA to fetch the PDF, which
        // net_interceptor captures into the URL/blob stores.
        if (!url) {
          const items = [...overlay.querySelectorAll('li, [role="menuitem"]')];
          // Build a list of candidate items in priority order: Preview first
          // (opens an in-app viewer → SPA fetches PDF), then Download.
          const pick = (re) => items.find(el => re.test(el.textContent.trim()));
          const downloadItem = pick(/download/i);
          const previewItem = pick(/preview|预览|查看|open|打开/i);
          const targetItem = previewItem || downloadItem;

          if (targetItem) {
            console.log('[AI Mail Reply] triggering menu item:', targetItem.textContent.trim().slice(0, 40));

            function readBlobStore() {
              const el = document.getElementById('__ai_mail_attachment_blobs__');
              if (!el) return null;
              try { return JSON.parse(el.textContent || '{}'); } catch (_) { return null; }
            }

            // Snapshot stores BEFORE the click so we can detect new entries.
            const beforeBlob = readBlobStore() || {};
            const beforePdfUrls = readPdfUrlStore().length;

            // ── Invoke the Ant Design Menu onClick ──────────────────────────
            // The overlay is an antd <Menu> (<ul role="menu">). Click handling
            // is centralized on the MENU container, NOT on each <li>. The
            // container's onClick receives { key, keyPath, domEvent, item } and
            // routes by `key`. Each <li> carries its key on `data-menu-id`.
            // Calling the menu onClick directly is the reliable path; falling
            // back to a real native .click() on the item also works because antd
            // attaches its own click listener that synthesizes the same info.
            let triggered = false;
            const menuKey = targetItem.getAttribute('data-menu-id') || '';

            // Find the Menu container's onClick by walking the fiber UP from the
            // item — antd's Menu stores onClick on the <ul> fiber.
            function invokeMenuOnClick(itemEl) {
              const ul = itemEl.closest('ul, [role="menu"]');
              if (!ul) return false;
              // Direct __reactProps$ key (React 18 attaches props here).
              const propsKey = Object.keys(ul).find(k => k.startsWith('__reactProps$'));
              if (propsKey) {
                const rp = ul[propsKey];
                if (rp && typeof rp.onClick === 'function') {
                  console.log('[AI Mail Reply] invoking antd Menu onClick (props key), key:', menuKey);
                  const info = {
                    key: menuKey,
                    keyPath: [menuKey],
                    domEvent: { preventDefault() {}, stopPropagation() {}, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
                    item: { props: { eventKey: menuKey }, key: menuKey },
                  };
                  try { rp.onClick(info); return true; } catch (e) {
                    console.log('[AI Mail Reply] Menu onClick threw:', e && e.message);
                  }
                }
              }
              // Fiber walk-up to find onClick on the menu container.
              let f = getFiber(ul);
              let depth = 0;
              while (f && depth < 15) {
                const props = f.memoizedProps;
                if (props && typeof props.onClick === 'function') {
                  console.log('[AI Mail Reply] invoking antd Menu onClick (fiber depth ' + depth + '), key:', menuKey);
                  const info = {
                    key: menuKey,
                    keyPath: [menuKey],
                    domEvent: { preventDefault() {}, stopPropagation() {}, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
                    item: { props: { eventKey: menuKey }, key: menuKey },
                  };
                  try { props.onClick(info); return true; } catch (e) {
                    console.log('[AI Mail Reply] Menu fiber onClick threw:', e && e.message);
                  }
                }
                f = f.return; depth++;
              }
              return false;
            }

            // Also try the legacy per-item onClick (older antd / custom wrappers).
            function invokeItemOnClick(itemEl) {
              const propsKey = Object.keys(itemEl).find(k => k.startsWith('__reactProps$'));
              if (propsKey) {
                const rp = itemEl[propsKey];
                if (rp && typeof rp.onClick === 'function') {
                  console.log('[AI Mail Reply] invoking item onClick (props key)');
                  try { rp.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: 'click', target: itemEl, currentTarget: itemEl }); return true; }
                  catch (e) { console.log('[AI Mail Reply] item onClick threw:', e && e.message); }
                }
              }
              let f = getFiber(itemEl);
              let depth = 0;
              while (f && depth < 12) {
                const props = f.memoizedProps;
                if (props && typeof props.onClick === 'function') {
                  console.log('[AI Mail Reply] invoking item fiber onClick at depth', depth);
                  try { props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: 'click', target: itemEl, currentTarget: itemEl }); return true; }
                  catch (e) {}
                }
                if (props && typeof props.onItemClick === 'function') {
                  console.log('[AI Mail Reply] invoking onItemClick at depth', depth);
                  try { props.onItemClick({ domEvent: { preventDefault() {}, stopPropagation() {} }, key: menuKey }); return true; }
                  catch (e) {}
                }
                f = f.return; depth++;
              }
              return false;
            }

            try {
              triggered = invokeMenuOnClick(targetItem) || invokeItemOnClick(targetItem);
            } catch (e) {
              console.log('[AI Mail Reply] menu invocation failed:', e && e.message);
            }

            // Last resort: a REAL native click on the item. antd attaches its own
            // click listener to the document that closes the menu, but the item's
            // own click handler still fires first. We do NOT stop propagation of
            // the item's click — we WANT the SPA's download/preview handler to run.
            if (!triggered) {
              console.log('[AI Mail Reply] fallback: native .click() on menu item');
              try { targetItem.click(); triggered = true; } catch (_) {}
            }

            // Poll up to 6s for net_interceptor to register the PDF URL/blob.
            const pdfUrlCountBefore = readPdfUrlStore().length;
            for (let i = 0; i < 120; i++) {
              await sleep(50);
              // 1. URL store hit (PDF response was fetched, filename matched).
              const nsUrl = findPdfUrlFromStore(cardName);
              if (nsUrl) {
                url = nsUrl;
                console.log('[AI Mail Reply] PDF URL hit after menu click (' + ((i + 1) * 50) + 'ms):', nsUrl.slice(0, 100));
                break;
              }
              // 1b. window.open hit: a new URL appeared in pdf-url list (NOS signed URL,
              //     path is a hash so filename match fails — accept any new entry).
              const pdfList = readPdfUrlStore();
              if (pdfList.length > pdfUrlCountBefore) {
                for (let j = pdfList.length - 1; j >= pdfUrlCountBefore; j--) {
                  const e = pdfList[j];
                  if (!e || !e.url) continue;
                  if (isNonPdfEndpoint(e.url)) continue;
                  if (e.url.length < 30) continue;
                  url = e.url;
                  console.log('[AI Mail Reply] window.open NOS URL hit after menu click (' + ((i + 1) * 50) + 'ms):', url.slice(0, 100));
                  break;
                }
                if (url) break;
              }
              // 2. Blob store hit (download created an <a download> blob, or window.open/blob intercept).
              const afterBlob = readBlobStore() || {};
              const newKeys = Object.keys(afterBlob).filter(k => !beforeBlob[k]);
              if (newKeys.length) {
                // Accept any new blob key, including '__latest_blob__' from window.open intercept.
                const blobKey = newKeys[0];
                const dataUrl = afterBlob[blobKey];
                console.log('[AI Mail Reply] blob store hit after ' + ((i + 1) * 50) + 'ms, key:', blobKey, 'dataUrl length:', dataUrl.length);
                try {
                  const el = document.getElementById('__ai_mail_attachment_blobs__');
                  if (el) {
                    const store = JSON.parse(el.textContent || '{}');
                    delete store[blobKey];
                    el.textContent = JSON.stringify(store);
                  }
                } catch (_) {}
                // Always map to the card's actual filename so downloadAttachmentText can find it.
                url = '__dataurl__:' + cardName;
                window.__aiMailDataUrls__ = window.__aiMailDataUrls__ || {};
                window.__aiMailDataUrls__[cardName] = dataUrl;
                break;
              }
            }
          } else {
            console.log('[AI Mail Reply] no Preview/Download item found in overlay; items:', items.map(i => i.textContent.trim()).join(' | '));
          }
        }

        // Close the overlay via Escape (antd listens for it; cleaner than body click).
        try { overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
        await sleep(50);

        if (!url) console.log('[AI Mail Reply] no URL found after all strategies. overlay HTML:', overlay.outerHTML.slice(0, 600));
      } else {
        console.log('[AI Mail Reply] no overlay appeared from any strategy');
        try { document.body.click(); } catch(_) {}
      }
      return url;
    } catch (e) {
      console.log('[AI Mail Reply] findUrlByDropdownClick error:', e && e.message);
      return '';
    }
  }


  // Async variant of discoverAttachmentLinks: for cards where sync discovery
  // returned no URL, try opening the dropdown to reveal the download link.
  // Returns the same [{ name, url, el }] shape with URLs filled in where found.
  async function discoverAttachmentLinksAsync(links) {
    const out = [];
    for (const link of links) {
      let url = link.url;
      // Only attempt the expensive dropdown-click strategy for PDFs that still
      // have no URL. Non-PDF attachments (images, etc.) don't benefit from it,
      // and clicking their card would open a previewer instead of a menu.
      if (!url && isPdfName(link.name)) {
        // Before clicking, re-check the stores — the SPA may have fetched the
        // URL in the background since sync discovery ran.
        url = findPdfUrlFromStore(link.name) || findUrlFromResourceTiming(link.name);
        if (!url && link.el) {
          url = await findUrlByDropdownClick(link.el);
        }
        // Poll stores after the dropdown interaction — the hover/click may have
        // triggered a lazy SPA API call that net_interceptor captures async.
        // Also check Resource Timing as a last resort. Poll for up to 3s.
        if (!url) {
          for (let i = 0; i < 12; i++) {
            await sleep(250);
            url = findPdfUrlFromStore(link.name) || findUrlFromResourceTiming(link.name);
            if (url) {
              console.log('[AI Mail Reply] post-dropdown poll found URL for ' + link.name + ' after ' + ((i + 1) * 250) + 'ms');
              break;
            }
          }
        }
        // Last-resort fallback: Netease opens PDF via window.open(signedNosUrl)
        // where the URL path is a hash (not the original filename). The
        // net_interceptor stores it as addUrl(url, url). Scan the pdf-url list
        // for ANY newly-appeared https URL that isn't obviously a non-PDF endpoint.
        // NOTE: NOS signed URLs may have .png suffix in the path even for PDFs,
        // so we do NOT filter by extension here — we filter only by endpoint type
        // and recency, then let fetchAndVerifyPdf() confirm via magic bytes.
        if (!url) {
          const pdfList = readPdfUrlStore();
          // Work newest-first; pick the most recent non-analytics https URL.
          for (let i = pdfList.length - 1; i >= 0; i--) {
            const e = pdfList[i];
            if (!e || !e.url) continue;
            if (isNonPdfEndpoint(e.url)) continue;
            // Accept if it appeared within the last 10 s (generous window).
            if (e.t && Date.now() - e.t > 10000) continue;
            // Skip very short URLs (likely navigation or icons).
            if (e.url.length < 30) continue;
            console.log('[AI Mail Reply] window.open fallback URL for ' + link.name + ':', e.url.slice(0, 100));
            url = e.url;
            break;
          }
        }
      }
      out.push({ name: link.name, url, el: link.el });
    }
    return out;
  }

  // ─── PDF text extraction ────────────────────────────────────────────────────
  // Download + parse a single PDF. Returns { name, text, truncated, totalPages, error }.
  async function downloadAttachmentText(name, url) {
    const result = { name, text: '', truncated: false, totalPages: 0, error: null };
    if (!url) { result.error = 'no-url'; console.log('[AI Mail Reply] downloadAttachmentText: no url for ' + name); return result; }
    if (!isPdfName(name)) { result.error = 'not-pdf'; return result; }

    try {
      ensurePdfjs();
    } catch (e) {
      result.error = 'pdfjs-missing';
      console.log('[AI Mail Reply] downloadAttachmentText: pdfjs missing -', e && e.message);
      return result;
    }

    // Inner: fetch a URL, verify it's actually PDF (magic bytes), return ArrayBuffer.
    // Returns null if the response isn't PDF so the caller can try a fallback URL.
    async function fetchAndVerifyPdf(fetchUrl) {
      // ── Data URL shortcut: blob was captured by net_interceptor (MAIN world) ──
      if (fetchUrl.startsWith('__dataurl__:')) {
        const key = fetchUrl.slice('__dataurl__:'.length);
        const dataUrl = window.__aiMailDataUrls__ && window.__aiMailDataUrls__[key];
        if (dataUrl) {
          console.log('[AI Mail Reply] downloadAttachmentText: reading from data URL, length:', dataUrl.length);
          try {
            const base64 = dataUrl.split(',')[1];
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            try { delete window.__aiMailDataUrls__[key]; } catch (_) {}
            return bytes.buffer;
          } catch (e) {
            console.log('[AI Mail Reply] downloadAttachmentText: data URL decode failed -', e && e.message);
            return null;
          }
        }
        console.log('[AI Mail Reply] downloadAttachmentText: data URL missing for', key);
        return null;
      }

      // ── Normal fetch path ──────────────────────────────────────────────────
      console.log('[AI Mail Reply] downloadAttachmentText: fetching ' + name + ' from ' + fetchUrl.slice(0, 120));
      try {
        const res = await fetch(fetchUrl, { credentials: 'include' });
        console.log('[AI Mail Reply] downloadAttachmentText: fetch response status=' + res.status + ' content-type=' + (res.headers.get('content-type') || '(none)'));
        if (!res.ok) { console.log('[AI Mail Reply] downloadAttachmentText: HTTP error ' + res.status); return null; }
        const buf = await res.arrayBuffer();
        console.log('[AI Mail Reply] downloadAttachmentText: got ' + buf.byteLength + ' bytes');
        // Verify PDF magic bytes.
        const head = new Uint8Array(buf.slice(0, 5));
        const isPdfMagic = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
        if (!isPdfMagic) {
          const sniff = new TextDecoder().decode(buf.slice(0, 200));
          console.log('[AI Mail Reply] downloadAttachmentText: response is NOT a PDF. First 200 bytes:', sniff.slice(0, 200));
          // ── Netease attachment viewer redirect ──────────────────────────────
          // The URL may be a sirius-web attachment page (returns HTML) that
          // embeds the real download URL in its `fileUrl` query parameter.
          // Extract it and retry directly.
          try {
            const parsedUrl = new URL(fetchUrl, location.href);
            const innerUrl = parsedUrl.searchParams.get('fileUrl') || parsedUrl.searchParams.get('filePreviewUrl');
            if (innerUrl) {
              const resolvedInner = new URL(innerUrl, location.href).href;
              console.log('[AI Mail Reply] downloadAttachmentText: retrying with extracted fileUrl:', resolvedInner.slice(0, 120));
              const res2 = await fetch(resolvedInner, { credentials: 'include' });
              if (res2.ok) {
                const buf2 = await res2.arrayBuffer();
                const head2 = new Uint8Array(buf2.slice(0, 5));
                const isPdf2 = head2[0] === 0x25 && head2[1] === 0x50 && head2[2] === 0x44 && head2[3] === 0x46;
                if (isPdf2) {
                  console.log('[AI Mail Reply] downloadAttachmentText: fileUrl fetch succeeded, bytes:', buf2.byteLength);
                  return buf2;
                }
                console.log('[AI Mail Reply] downloadAttachmentText: fileUrl response also not PDF, status:', res2.status);
              }
            }
          } catch (e2) {
            console.log('[AI Mail Reply] downloadAttachmentText: fileUrl extraction failed -', e2 && e2.message);
          }
          return null;  // Signal caller to try a fallback URL.
        }
        return buf;
      } catch (e) {
        console.log('[AI Mail Reply] downloadAttachmentText: fetch exception -', e && e.message);
        return null;
      }
    }

    // Try the primary URL first.
    let arrayBuffer = await fetchAndVerifyPdf(url);

    // Fallback: if the primary URL returned non-PDF (e.g. an analytics endpoint),
    // use Resource Timing to find the real PDF fetch that the SPA made in response
    // to the Preview/Download click.
    if (!arrayBuffer) {
      const rtUrl = findUrlFromResourceTiming(name);
      if (rtUrl && rtUrl !== url) {
        console.log('[AI Mail Reply] downloadAttachmentText: retrying with Resource Timing URL:', rtUrl.slice(0, 120));
        arrayBuffer = await fetchAndVerifyPdf(rtUrl);
      }
    }

    if (!arrayBuffer) {
      result.error = 'no-valid-pdf-response';
      return result;
    }

    let pdf;
    try {
      const task = window.pdfjsLib.getDocument({ data: arrayBuffer });
      pdf = await task.promise;
      console.log('[AI Mail Reply] downloadAttachmentText: PDF parsed, ' + pdf.numPages + ' pages');
    } catch (e) {
      result.error = 'pdf-parse-failed';
      console.log('[AI Mail Reply] downloadAttachmentText: pdf.js parse failed -', e && e.message);
      return result;
    }

    try {
      result.totalPages = pdf.numPages;
      const limit = Math.min(MAX_PAGES, pdf.numPages);
      let text = '';
      let truncated = false;
      for (let i = 1; i <= limit; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        // Join text items, inserting a newline for vertical gaps (rough paragraph split).
        let pageText = '';
        let lastY = null;
        for (const item of content.items) {
          const str = item.str || '';
          if (!str) continue;
          const y = item.transform ? item.transform[5] : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) pageText += '\n';
          pageText += str;
          if (item.hasEOL) pageText += '\n';
          lastY = y;
        }
        text += (i > 1 ? '\n\n' : '') + pageText.trim();
        if (text.length >= MAX_CHARS) { truncated = true; break; }
      }

      if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
      result.text = text;
      result.truncated = truncated || (pdf.numPages > limit);
      result.totalPages = pdf.numPages;
      return result;
    } catch (e) {
      result.error = 'pdf-read-failed';
      return result;
    } finally {
      try { pdf.destroy(); } catch (_) {}
    }
  }

  // ─── Debug dump for attachment cards ────────────────────────────────────────
  // Called from content.js debugDumpDOM(). Logs each card's HTML + anchors +
  // data-* attrs + React fiber props to the console so we can fix URL discovery.
  function configureDebugDump() {
    // Net-interceptor store dump — shows URLs captured from SPA API responses.
    const netStore = readNetStore();
    const netKeys = Object.keys(netStore);
    console.log(`── Net-interceptor URL store: ${netKeys.length} entries`);
    netKeys.forEach(k => console.log(`  ${k} → ${netStore[k]}`));

    const container = document.querySelector('[class*="readmail-attachments"]');
    if (!container) {
      console.log('── No [class*="readmail-attachments"] container found');
      return;
    }
    const cards = [...container.querySelectorAll('[class*="attachment-card"], [class*="attachment "]')];
    console.log(`── Attachment cards found: ${cards.length}  (fiber keys: ${FIBER_KEYS.join(', ') || 'none'})`);
    cards.forEach((card, i) => {
      console.groupCollapsed(`  card[${i}] class="${card.className}"`);
      console.log('  outerHTML:', card.outerHTML.slice(0, 500));
      const anchors = [...card.querySelectorAll('a')];
      anchors.forEach((a, j) => {
        console.log(`    a[${j}] href=${a.getAttribute('href')} download=${a.getAttribute('download')} class=${a.className} onclick=${a.getAttribute('onclick') || ''}`);
      });
      const dataEls = [...card.querySelectorAll('[data-url],[data-href],[data-src],[data-download]')];
      dataEls.forEach((el, j) => {
        console.log(`    data[${j}] tag=${el.tagName} class=${el.className} ` +
          `data-url=${el.getAttribute('data-url') || ''} ` +
          `data-href=${el.getAttribute('data-href') || ''} ` +
          `data-src=${el.getAttribute('data-src') || ''} ` +
          `data-download=${el.getAttribute('data-download') || ''}`);
      });
      // React fiber props dump — the key diagnostic for SPA-hidden URLs.
      const snaps = collectFiberProps(card);
      console.log(`    fiber props snapshots: ${snaps.length}`);
      snaps.forEach((snap, k) => {
        // Serialize props but redact huge values / functions for readability.
        const safe = {};
        try {
          for (const key of Object.keys(snap.props)) {
            const v = snap.props[key];
            const tv = typeof v;
            if (tv === 'function') { safe[key] = 'ƒ()'; continue; }
            if (v instanceof Element) { safe[key] = '<' + v.tagName + '>'; continue; }
            if (tv === 'string') { safe[key] = v.length > 200 ? v.slice(0, 200) + '…' : v; continue; }
            if (v && tv === 'object') {
              try {
                const s = JSON.stringify(v, (kk, vv) => typeof vv === 'function' ? 'ƒ()' : vv, 0);
                safe[key] = s && s.length > 300 ? s.slice(0, 300) + '…' : s;
              } catch (_) { safe[key] = '[unserializable]'; }
              continue;
            }
            safe[key] = v;
          }
        } catch (_) {}
        console.log(`    fiber[${k}] depth=${snap.depth} type=${typeof snap.type === 'string' ? snap.type : (snap.type && snap.type.displayName) || (snap.type && snap.type.name) || 'fn'} props=`, safe);
      });
      console.log('  → discovered url:', findUrlInCard(card));
      console.groupEnd();
    });
  }

  // Expose on the isolated-world window for content.js
  window.AIAttachment = {
    discoverAttachmentLinks,
    discoverAttachmentLinksAsync,
    downloadAttachmentText,
    isPdfName,
    configureDebugDump,
    _findUrlFromNetStore: findUrlFromNetStore,  // exposed for debug logging in content.js
  };
})();
