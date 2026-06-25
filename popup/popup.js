const DEFAULT_DOMAINS = [
  'mail.163.com', 'mail.126.com', 'mail.yeah.net',
  'mail.qq.com', 'mail.google.com',
  'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
  'mail.qiye.163.com', 'mailh.qiye.163.com', 'qy.163.com',
  'app.ym.163.com', 'ym.163.com'
];

document.getElementById('open-panel-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const toggle = document.getElementById('ai-mail-toggle');
      if (toggle) { toggle.click(); return; }
      const panel = document.getElementById('ai-mail-panel');
      if (panel) panel.classList.remove('hidden');
    }
  });
  window.close();
});

document.getElementById('options-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Detect current domain against user-configured list
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  const url = tab?.url || '';
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch (_) {}

  const { allowedDomains } = await chrome.storage.local.get(['allowedDomains']);
  const domains = allowedDomains || DEFAULT_DOMAINS;
  const found = domains.some(d => hostname === d || hostname.endsWith('.' + d));

  const el = document.getElementById('mail-detected');
  if (found) {
    el.textContent = `✅ ${hostname}`;
    el.style.color = '#6366f1';
  } else {
    el.textContent = '当前页面未启用';
    el.style.color = '#4b5563';
  }
});
