const DEFAULT_DOMAINS = [
  'mail.163.com',
  'mail.126.com',
  'mail.yeah.net',
  'mail.qq.com',
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.qiye.163.com',
  'mailh.qiye.163.com',
  'qy.163.com',
  'app.ym.163.com',
  'ym.163.com'
];

let allowedDomains = [...DEFAULT_DOMAINS];

// ── Load all settings ──────────────────────────────────────────────────────
chrome.storage.local.get(['settings', 'allowedDomains'], ({ settings = {}, allowedDomains: saved }) => {
  if (settings.claudeKey)    document.getElementById('claude-key').value = settings.claudeKey;
  document.getElementById('claude-model').value = settings.claudeModel || 'claude-sonnet-4-6';
  if (settings.openaiKey)    document.getElementById('openai-key').value = settings.openaiKey;
  document.getElementById('openai-model').value = settings.openaiModel || 'gpt-4o';
  if (settings.deepseekKey)  document.getElementById('deepseek-key').value = settings.deepseekKey;
  document.getElementById('deepseek-model').value = settings.deepseekModel || 'deepseek-flash';
  if (settings.geminiKey)    document.getElementById('gemini-key').value = settings.geminiKey;
  if (settings.glmKey)       document.getElementById('glm-key').value = settings.glmKey;
  document.getElementById('glm-model').value = settings.glmModel || 'glm-4-flash';

  allowedDomains = saved || [...DEFAULT_DOMAINS];
  renderDomains();
});

// ── Domain list rendering ──────────────────────────────────────────────────
function renderDomains() {
  const container = document.getElementById('domain-list');
  container.innerHTML = '';
  allowedDomains.forEach((domain, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1a1d2e;border:1px solid #2a2d3a;border-radius:8px';
    row.innerHTML = `
      <span style="font-size:13px;color:#9ca3af;flex-shrink:0">🌐</span>
      <span style="flex:1;font-size:13px;color:#c4c9d9;font-family:monospace">${domain}</span>
      <button data-idx="${idx}" class="del-domain" style="border:none;background:transparent;color:#4b5563;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px;transition:all 0.15s" title="删除">✕</button>
    `;
    row.querySelector('.del-domain').addEventListener('mouseover', e => e.target.style.color = '#fca5a5');
    row.querySelector('.del-domain').addEventListener('mouseout', e => e.target.style.color = '#4b5563');
    row.querySelector('.del-domain').addEventListener('click', () => {
      allowedDomains.splice(idx, 1);
      renderDomains();
    });
    container.appendChild(row);
  });
}

// ── Add domain ─────────────────────────────────────────────────────────────
document.getElementById('add-domain-btn').addEventListener('click', () => {
  const input = document.getElementById('new-domain');
  let domain = input.value.trim().toLowerCase();
  // Strip protocol and path if user pasted a full URL
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!domain) return;
  if (allowedDomains.includes(domain)) {
    showToast('⚠️ 该域名已存在');
    return;
  }
  allowedDomains.push(domain);
  renderDomains();
  input.value = '';
  showToast(`✅ 已添加 ${domain}`);
});

document.getElementById('new-domain').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-domain-btn').click();
});

// ── Save all ───────────────────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', () => {
  chrome.storage.local.get(['settings'], ({ settings: existing = {} }) => {
    const settings = {
      ...existing,
      claudeKey:    document.getElementById('claude-key').value.trim(),
      claudeModel:  document.getElementById('claude-model').value.trim(),
      openaiKey:    document.getElementById('openai-key').value.trim(),
      openaiModel:  document.getElementById('openai-model').value.trim(),
      deepseekKey:  document.getElementById('deepseek-key').value.trim(),
      deepseekModel: document.getElementById('deepseek-model').value.trim(),
      geminiKey:    document.getElementById('gemini-key').value.trim(),
      glmKey:       document.getElementById('glm-key').value.trim(),
      glmModel:     document.getElementById('glm-model').value.trim(),
    };
    chrome.storage.local.set({ settings, allowedDomains }, () => {
      showToast('✅ 设置已保存，请刷新邮箱页面生效');
    });
  });
});

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}
