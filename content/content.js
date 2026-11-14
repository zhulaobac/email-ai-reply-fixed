// AI Mail Reply - Content Script

(function () {
  if (document.getElementById('ai-mail-toggle')) return; // already injected

  // ─── Default allowed domains ────────────────────────────────────────────────
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

  // Check if current domain is allowed, then init
  chrome.storage.local.get(['allowedDomains'], (data) => {
    const allowed = data.allowedDomains || DEFAULT_DOMAINS;
    const host = location.hostname;
    const isAllowed = allowed.some(d => host === d || host.endsWith('.' + d));
    if (isAllowed) init();
  });

  function init() {

  // ─── Default skills ────────────────────────────────────────────────────────
  const DEFAULT_SKILLS = [
    {
      id: 'professional',
      emoji: '💼',
      name: '专业商务',
      desc: '正式、简洁的商务风格',
      prompt: '请用专业、正式的商务语气回复这封邮件。语言简洁、逻辑清晰，避免口语化表达。回复需直接切题，表达明确立场和行动计划。'
    },
    {
      id: 'trade',
      emoji: '🌐',
      name: '外贸销售',
      desc: '外贸英文，客户维护',
      prompt: '你是一位经验丰富的外贸销售代表。请用真诚、专业的美式商务英语回复这封邮件。语气友好但不失专业，注重客户关系维护，内容简洁有力，避免冗长套话。'
    },
    {
      id: 'friendly',
      emoji: '😊',
      name: '轻松友好',
      desc: '亲切自然的沟通风格',
      prompt: '请用轻松、友好的语气回复这封邮件。保持亲切自然，像朋友间交流一样，但仍然保持礼貌和专业。'
    },
    {
      id: 'customer_service',
      emoji: '🎯',
      name: '客户服务',
      desc: '耐心解答，解决问题',
      prompt: '请以客户服务专员的身份回复这封邮件。态度耐心友好，认可客户的问题或诉求，提供清晰的解决方案或下一步行动，让客户感到被重视。'
    },
    {
      id: 'brief',
      emoji: '⚡',
      name: '简短快捷',
      desc: '3句话内，直接明了',
      prompt: '请用最简洁的方式回复这封邮件，控制在3句话以内。直接给出核心答案或行动，不要寒暄和多余的铺垫。'
    }
  ];

  // ─── State ──────────────────────────────────────────────────────────────────
  let panelVisible = false;
  let currentProvider = 'claude';
  let currentSkillId = 'professional';
  let currentSkillType = 'reply';        // 'reply' | 'analyze'
  let currentAnalyzeSkillId = '';        // empty = use first analyze skill
  let customSkills = [];                 // reply skills
  let customAnalyzeSkills = [];          // analyze skills
  let settings = {};

  // ─── Default analyze skills ───────────────────────────────────────────────
  const DEFAULT_ANALYZE_SKILLS = [
    {
      id: 'analyze_po',
      emoji: '📋',
      name: 'PO 订单分析',
      desc: '解读采购订单关键信息',
      prompt: `你是一位专业的外贸订单分析师。请分析这封邮件（包括附件信息），提取并整理以下内容：
1. PO编号
2. 客户名称与联系人
3. 产品及数量
4. 要求交货期
5. 付款方式
6. 特殊要求或注意事项
7. 需要我方回复或跟进的事项
请用清晰的条目格式输出，不需要完整回复邮件。`
    },
    {
      id: 'analyze_thread',
      emoji: '🧵',
      name: '往来历史梳理',
      desc: '梳理邮件往来的关键节点',
      prompt: `请分析这封邮件的历史往来内容，梳理出：
1. 沟通背景与起因
2. 双方的关键诉求
3. 已达成的共识或决定
4. 尚未解决的问题
5. 下一步行动建议
用简洁的条目格式输出，重点突出待办事项。`
    },
    {
      id: 'analyze_risk',
      emoji: '⚠️',
      name: '风险识别',
      desc: '识别邮件中的潜在风险点',
      prompt: `请以风险管理的视角分析这封邮件（含附件信息），识别：
1. 合同/条款风险
2. 交期风险
3. 付款风险
4. 沟通误解风险
5. 建议的应对措施
每项风险标明【高/中/低】风险等级。`
    }
  ];

  // ─── Shared constants ────────────────────────────────────────────────────────
  const KEY_MAP = {
    claude: 'claudeKey', openai: 'openaiKey', deepseek: 'deepseekKey', gemini: 'geminiKey', glm: 'glmKey'
  };
  const MODEL_MAP = {
    claude: 'claudeModel', openai: 'openaiModel', deepseek: 'deepseekModel', gemini: 'geminiModel', glm: 'glmModel'
  };
  const PROVIDER_NAMES = {
    claude: 'Claude (Anthropic)', openai: 'OpenAI / GPT', deepseek: 'DeepSeek', gemini: 'Gemini', glm: '智谱 GLM'
  };

  // ─── Build UI ───────────────────────────────────────────────────────────────
  const toggle = document.createElement('button');
  toggle.id = 'ai-mail-toggle';
  toggle.innerHTML = '✦';
  toggle.title = 'AI Mail Reply';
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.id = 'ai-mail-panel';
  panel.className = 'hidden';
  panel.innerHTML = `
    <div id="ai-mail-header">
      <div id="ai-mail-header-left">
        <div id="ai-mail-logo">✦</div>
        <span id="ai-mail-title">AI Mail Reply</span>
      </div>
      <div id="ai-mail-header-right">
        <button class="ai-mail-icon-btn" id="ai-mail-refresh-btn" title="重新读取邮件">↻</button>
        <button class="ai-mail-icon-btn" id="ai-mail-close-btn" title="关闭">✕</button>
      </div>
    </div>

    <div id="ai-mail-tabs">
      <button class="ai-mail-tab active" data-tab="reply" data-skill-tab="reply">✦ 回复</button>
      <button class="ai-mail-tab" data-tab="reply" data-skill-tab="analyze">🔍 分析</button>
      <div class="ai-mail-tab-spacer"></div>
      <button class="ai-mail-tab secondary" data-tab="skills">我的 Skill</button>
      <button class="ai-mail-tab secondary" data-tab="settings">设置</button>
    </div>

    <div id="ai-mail-body">

      <!-- ── REPLY TAB ── -->
      <div class="ai-mail-panel-tab active" id="tab-reply">

        <!-- Email preview (shared) -->
        <div id="ai-mail-email-preview">
          <div class="ai-mail-preview-label">当前邮件 <span id="preview-translate-hint">· 悬停查看中文译文</span></div>
          <div class="ai-mail-preview-meta" id="preview-from">发件人：<span id="preview-from-val">读取中...</span></div>
          <div class="ai-mail-preview-meta" id="preview-subject">主题：<span id="preview-subject-val">—</span></div>
          <div class="ai-mail-preview-text" id="preview-body">正在读取邮件内容...</div>
          <div id="preview-attachments"></div>
          <!-- Translation tooltip -->
          <div id="ai-mail-translate-tooltip">
            <div id="ai-mail-translate-content">正在翻译...</div>
          </div>
        </div>

        <!-- Provider (shared) -->
        <div>
          <div class="ai-mail-section-label">AI 服务商</div>
          <div class="ai-mail-provider-grid">
            <button class="ai-mail-provider-btn active" data-provider="claude">Claude</button>
            <button class="ai-mail-provider-btn" data-provider="openai">GPT</button>
            <button class="ai-mail-provider-btn" data-provider="deepseek">DeepSeek</button>
            <button class="ai-mail-provider-btn" data-provider="gemini">Gemini</button>
            <button class="ai-mail-provider-btn" data-provider="glm">智谱 GLM</button>
          </div>
        </div>

        <!-- ── 回复模式区块 ── -->
        <div id="mode-reply-section">
          <div class="ai-mail-skill-list" id="skill-list"></div>
          <textarea id="ai-mail-instruction" rows="4" placeholder="补充要求（可选）：如「语气更正式」…&#10;已生成邮件后：直接填写要求点「重新生成」可整体调整草稿；也可先选中某句话，再描述如何修改后点「优化选中」"></textarea>
          <div class="ai-mail-error" id="ai-mail-error"></div>
          <button id="ai-mail-generate-btn" style="width:100%">
            <span id="generate-btn-text">✦ 生成回复</span>
          </button>
          <div id="ai-mail-result-area">
            <div class="ai-mail-result-label">
              <span>✦ 生成结果</span>
              <span id="ai-mail-selection-hint" style="display:none">✂️ 已选中文字，在补充要求里描述修改意图后点「优化选中」</span>
            </div>
            <div id="ai-mail-result-text" contenteditable="true" spellcheck="false"></div>
            <div class="ai-mail-result-actions">
              <button class="ai-mail-action-btn" id="ai-mail-copy-btn">📋 复制</button>
              <button class="ai-mail-action-btn" id="ai-mail-regen-btn">↺ 重新生成</button>
              <button class="ai-mail-action-btn refine" id="ai-mail-refine-btn" style="display:none">✨ 优化选中</button>
              <button class="ai-mail-action-btn primary" id="ai-mail-insert-btn">✍ 插入草稿</button>
            </div>
          </div>
        </div>

        <!-- ── 分析模式区块 ── -->
        <div id="mode-analyze-section" style="display:none">
          <div class="ai-mail-skill-list" id="analyze-skill-list"></div>
          <textarea id="ai-mail-analyze-instruction" rows="4" placeholder="补充要求（可选）：如「重点关注价格条款」、「用中文输出」…"></textarea>
          <div class="ai-mail-error" id="ai-mail-analyze-error"></div>
          <button id="ai-mail-analyze-btn" style="width:100%">
            <span id="analyze-btn-text">🔍 开始分析</span>
          </button>
          <div id="ai-mail-analyze-area">
            <div class="ai-mail-analyze-label">📊 分析结果</div>
            <div id="ai-mail-analyze-text"></div>
            <div class="ai-mail-result-actions">
              <button class="ai-mail-action-btn" id="ai-mail-analyze-copy-btn">📋 复制</button>
              <button class="ai-mail-action-btn" id="ai-mail-reanalyze-btn">↺ 重新分析</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── SKILLS TAB ── -->
      <div class="ai-mail-panel-tab" id="tab-skills">

        <!-- Skill 类型切换 -->
        <div style="display:flex;gap:6px;margin-bottom:12px">
          <button class="ai-skill-type-btn active" data-skill-type="reply">✦ 回复 Skill</button>
          <button class="ai-skill-type-btn" data-skill-type="analyze">🔍 分析 Skill</button>
        </div>

        <div class="ai-mail-section-label">新建 Skill</div>
        <div class="ai-skill-form">
          <input type="text" id="new-skill-emoji" placeholder="Emoji（如 🚀）" style="width:70px;display:inline-block" maxlength="4">
          <input type="text" id="new-skill-name" placeholder="Skill 名称">
          <input type="text" id="new-skill-desc" placeholder="简短描述">
          <textarea id="new-skill-prompt" placeholder="System Prompt：详细说明分析角度、输出格式…" rows="5"></textarea>
          <button class="ai-skill-save-btn" id="save-skill-btn">保存 Skill</button>
        </div>

        <div class="ai-mail-section-label" style="margin-top:4px">已保存的 Skill</div>
        <div class="ai-skill-saved-list" id="saved-skills-list">
          <div style="font-size:12px;color:#374151;padding:8px 0">还没有自定义 Skill</div>
        </div>
      </div>

      <!-- ── SETTINGS TAB ── -->
      <div class="ai-mail-panel-tab" id="tab-settings">
        <a class="ai-mail-section-label ai-provider-link" href="https://console.anthropic.com/settings/keys" target="_blank" title="点击获取 Claude API Key">Claude <span class="ai-link-icon">↗</span></a>
        <div class="ai-settings-group">
          <div class="ai-settings-row">
            <label>API Key</label>
            <input type="password" id="setting-claude-key" placeholder="sk-ant-...">
          </div>
          <div class="ai-settings-row">
            <label>模型</label>
            <input type="text" id="setting-claude-model" list="dl-claude-model" placeholder="选择或输入模型名">
            <datalist id="dl-claude-model">
              <option value="claude-sonnet-4-6" label="claude-sonnet-4-6（推荐）"></option>
              <option value="claude-opus-4-6" label="claude-opus-4-6（最强）"></option>
              <option value="claude-opus-4-7" label="claude-opus-4-7"></option>
              <option value="claude-opus-4-8" label="claude-opus-4-8（最新旗舰）"></option>
              <option value="claude-haiku-4-5-20251001" label="claude-haiku-4-5（最快）"></option>
            </datalist>
          </div>
        </div>

        <a class="ai-mail-section-label ai-provider-link" href="https://platform.openai.com/api-keys" target="_blank" title="点击获取 OpenAI API Key" style="margin-top:8px">OpenAI / GPT <span class="ai-link-icon">↗</span></a>
        <div class="ai-settings-group">
          <div class="ai-settings-row">
            <label>API Key</label>
            <input type="password" id="setting-openai-key" placeholder="sk-...">
          </div>
          <div class="ai-settings-row">
            <label>模型</label>
            <input type="text" id="setting-openai-model" list="dl-openai-model" placeholder="选择或输入模型名">
            <datalist id="dl-openai-model">
              <option value="gpt-5.5" label="gpt-5.5（最新旗舰）"></option>
              <option value="gpt-5.4" label="gpt-5.4（推荐）"></option>
              <option value="gpt-5.4-mini" label="gpt-5.4-mini（快速）"></option>
              <option value="gpt-5.3" label="gpt-5.3（均衡）"></option>
              <option value="gpt-4o" label="gpt-4o（经典）"></option>
            </datalist>
          </div>
        </div>

        <a class="ai-mail-section-label ai-provider-link" href="https://platform.deepseek.com/api_keys" target="_blank" title="点击获取 DeepSeek API Key" style="margin-top:8px">DeepSeek <span class="ai-link-icon">↗</span></a>
        <div class="ai-settings-group">
          <div class="ai-settings-row">
            <label>API Key</label>
            <input type="password" id="setting-deepseek-key" placeholder="sk-...">
          </div>
          <div class="ai-settings-row">
            <label>模型</label>
            <input type="text" id="setting-deepseek-model" list="dl-deepseek-model" placeholder="选择或输入模型名">
            <datalist id="dl-deepseek-model">
              <option value="deepseek-flash" label="deepseek-flash（最新 4.1·推荐）"></option>
              <option value="deepseek-v4-pro" label="deepseek-v4-pro（最强）"></option>
              <option value="deepseek-v4-flash" label="deepseek-v4-flash（快速）"></option>
              <option value="deepseek-chat" label="deepseek-chat（旧版）"></option>
              <option value="deepseek-reasoner" label="deepseek-reasoner（旧版推理）"></option>
            </datalist>
          </div>
        </div>

        <a class="ai-mail-section-label ai-provider-link" href="https://aistudio.google.com/app/apikey" target="_blank" title="点击获取 Gemini API Key" style="margin-top:8px">Gemini <span class="ai-link-icon">↗</span></a>
        <div class="ai-settings-group">
          <div class="ai-settings-row">
            <label>API Key</label>
            <input type="password" id="setting-gemini-key" placeholder="AIza...">
          </div>
          <div class="ai-settings-row">
            <label>模型</label>
            <input type="text" id="setting-gemini-model" list="dl-gemini-model" placeholder="选择或输入模型名">
            <datalist id="dl-gemini-model">
              <option value="gemini-3.5-flash" label="gemini-3.5-flash（最新旗舰）"></option>
              <option value="gemini-3.1-pro" label="gemini-3.1-pro（最强推理）"></option>
              <option value="gemini-3.1-flash-lite" label="gemini-3.1-flash-lite（高性价比）"></option>
              <option value="gemini-2.5-pro" label="gemini-2.5-pro（稳定版）"></option>
              <option value="gemini-2.5-flash" label="gemini-2.5-flash（推荐·均衡）"></option>
              <option value="gemini-2.5-flash-lite" label="gemini-2.5-flash-lite（最经济）"></option>
            </datalist>
          </div>
        </div>

        <a class="ai-mail-section-label ai-provider-link" href="https://open.bigmodel.cn/apikey/platform" target="_blank" title="点击获取智谱 GLM API Key" style="margin-top:8px">智谱 GLM <span class="ai-link-icon">↗</span></a>
        <div class="ai-settings-group">
          <div class="ai-settings-row">
            <label>API Key</label>
            <input type="password" id="setting-glm-key" placeholder="id.secret 格式">
          </div>
          <div class="ai-settings-row">
            <label>模型</label>
            <input type="text" id="setting-glm-model" list="dl-glm-model" placeholder="选择或输入模型名">
            <datalist id="dl-glm-model">
              <option value="glm-5.1" label="glm-5.1（最新旗舰）"></option>
              <option value="glm-5" label="glm-5（强推理）"></option>
              <option value="glm-4.7" label="glm-4.7（推荐·均衡）"></option>
              <option value="glm-4.7-flash" label="glm-4.7-flash（免费·推荐）"></option>
              <option value="glm-4-flash" label="glm-4-flash（旧版免费）"></option>
            </datalist>
          </div>
        </div>

        <button class="ai-settings-save-btn" id="save-settings-btn">💾 保存设置</button>

        <div class="ai-settings-hint">
          API Key 保存在本地浏览器 storage 中，不会上传到任何服务器。
        </div>
      </div>

    </div>
  `;
  document.body.appendChild(panel);

  // ─── Tab switching ───────────────────────────────────────────────────────────
  // All four tab buttons share the same click handler.
  // Buttons with data-tab="reply" also carry data-skill-tab to control mode section.
  panel.querySelectorAll('.ai-mail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      const skillTab = tab.dataset.skillTab; // present only on reply/analyze tabs

      // Update active state — only one tab active at a time across all four.
      panel.querySelectorAll('.ai-mail-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Show the correct panel-tab content pane.
      panel.querySelectorAll('.ai-mail-panel-tab').forEach(t => t.classList.remove('active'));
      document.getElementById(`tab-${targetTab}`).classList.add('active');

      // If it's a reply/analyze tab, also switch the mode section inside tab-reply.
      if (skillTab) switchSkillSubtab(skillTab);
    });
  });

  // Mode section switcher (called by tab click above, or programmatically).
  function switchSkillSubtab(skillTab) {
    const isReply = skillTab === 'reply';
    document.getElementById('mode-reply-section').style.display = isReply ? '' : 'none';
    document.getElementById('mode-analyze-section').style.display = isReply ? 'none' : '';
    if (isReply) {
      document.getElementById('ai-mail-analyze-area').classList.remove('visible');
    } else {
      document.getElementById('ai-mail-result-area').classList.remove('visible');
    }
  }

  // ─── Open / close panel ─────────────────────────────────────────────────────
  // ─── Extension context health check ─────────────────────────────────────────
  // chrome.runtime.id becomes undefined when the extension is reloaded or the
  // SPA navigates and invalidates the content-script context. This is the only
  // reliable synchronous check — chrome.runtime.sendMessage still exists but
  // throws "Extension context invalidated" when called on a dead context.
  function isExtensionAlive() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function checkExtensionContext() {
    if (!isExtensionAlive()) {
      showError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试');
      document.getElementById('ai-mail-generate-btn').disabled = true;
      return false;
    }
    return true;
  }

  function openPanel() {
    panelVisible = true;
    panel.classList.remove('hidden');
    toggle.classList.add('panel-open');
    checkExtensionContext();
    readEmail();
  }

  function closePanel() {
    panelVisible = false;
    panel.classList.add('hidden');
    toggle.classList.remove('panel-open');
  }

  toggle.addEventListener('click', openPanel);
  document.getElementById('ai-mail-close-btn').addEventListener('click', closePanel);
  document.getElementById('ai-mail-refresh-btn').addEventListener('click', () => {
    // Re-read email
    readEmail();
    debugDumpDOM();

    // Clear reply mode
    document.getElementById('ai-mail-instruction').value = '';
    document.getElementById('ai-mail-result-text').textContent = '';
    document.getElementById('ai-mail-result-area').classList.remove('visible');
    clearError();
    clearResultSelection();

    // Clear analyze mode
    document.getElementById('ai-mail-analyze-instruction').value = '';
    document.getElementById('ai-mail-analyze-text').textContent = '';
    document.getElementById('ai-mail-analyze-area').classList.remove('visible');
    clearAnalyzeError();
  });

  function debugDumpDOM() {
    // Dump candidate elements to console so we can identify correct selectors
    const host = location.hostname;
    console.group('[AI Mail Reply] DOM Debug Dump — ' + host);

    // 1. All elements with text resembling an email address or sender name
    const allText = [...document.querySelectorAll('*')].filter(el => {
      if (el.children.length > 3) return false;
      const t = el.textContent.trim();
      return (t.includes('@') || t.length < 80) && t.length > 2 && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE';
    });

    // 2. Log From/Subject/Attach candidates
    console.log('── Potential FROM elements:');
    ['from', 'sender', 'author', 'mail-from', 'mailFrom'].forEach(kw => {
      document.querySelectorAll(`[class*="${kw}"]`).forEach(el => {
        const t = el.textContent.trim().slice(0, 80);
        if (t) console.log(`  [class*="${kw}"]`, el.className, '→', t);
      });
    });

    console.log('── Potential SUBJECT elements:');
    ['subject', 'title', 'mailTitle', 'letter-title', 'letterTitle'].forEach(kw => {
      document.querySelectorAll(`[class*="${kw}"]`).forEach(el => {
        const t = el.textContent.trim().slice(0, 80);
        if (t && el.children.length < 4) console.log(`  [class*="${kw}"]`, el.className, '→', t);
      });
    });

    console.log('── Potential ATTACHMENT elements:');
    ['attach', 'file', 'annex', 'accessory'].forEach(kw => {
      document.querySelectorAll(`[class*="${kw}"]`).forEach(el => {
        const t = el.textContent.trim().slice(0, 80);
        if (t && t.includes('.')) console.log(`  [class*="${kw}"]`, el.className, '→', t);
      });
    });

    console.log('── Iframes on page:');
    document.querySelectorAll('iframe').forEach(f => {
      console.log('  iframe id=' + f.id + ' name=' + f.name + ' src=' + f.src?.slice(0, 60));
    });

    // Detailed attachment-card dump — helps fix PDF URL discovery if it fails.
    // (attachment_reader.js exposes AIAttachment.configureDebugDump for this.)
    if (window.AIAttachment && window.AIAttachment.configureDebugDump) {
      console.log('── Attachment cards (for PDF download-URL discovery):');
      try { window.AIAttachment.configureDebugDump(); } catch (e) {
        console.log('  (dump failed)', e && e.message);
      }
    }

    console.groupEnd();
    showToast('📋 调试信息已输出到控制台 (F12)');
  }

  // ─── Drag to move panel ──────────────────────────────────────────────────────
  let dragging = false, dragOffX = 0, dragOffY = 0;
  document.getElementById('ai-mail-header').addEventListener('mousedown', e => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;
    panel.style.transition = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = (e.clientX - dragOffX) + 'px';
    panel.style.top = (e.clientY - dragOffY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    panel.style.transition = '';
  });

  // ─── Provider buttons ────────────────────────────────────────────────────────
  panel.querySelectorAll('.ai-mail-provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.ai-mail-provider-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentProvider = btn.dataset.provider;
    });
  });

  // ─── Skills rendering ────────────────────────────────────────────────────────
  function getAllSkills() {
    return [...DEFAULT_SKILLS, ...customSkills];
  }

  function getAllAnalyzeSkills() {
    return [...DEFAULT_ANALYZE_SKILLS, ...customAnalyzeSkills];
  }

  // Render the skill list in the Reply tab (reply skills only)
  function renderSkillList() {
    const list = document.getElementById('skill-list');
    list.innerHTML = '';
    getAllSkills().forEach(skill => {
      const item = document.createElement('div');
      item.className = 'ai-mail-skill-item' + (skill.id === currentSkillId ? ' active' : '');
      item.innerHTML = `
        <span class="ai-mail-skill-emoji">${skill.emoji}</span>
        <div class="ai-mail-skill-info">
          <div class="ai-mail-skill-name">${skill.name}</div>
          <div class="ai-mail-skill-desc">${skill.desc}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        currentSkillId = skill.id;
        list.querySelectorAll('.ai-mail-skill-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      });
      list.appendChild(item);
    });
  }

  // Render analyze skill list in the Reply tab (for analyze button)
  function renderAnalyzeSkillList() {
    let list = document.getElementById('analyze-skill-list');
    if (!list) return;
    list.innerHTML = '';
    const skills = getAllAnalyzeSkills();
    if (!currentAnalyzeSkillId && skills.length) currentAnalyzeSkillId = skills[0].id;
    skills.forEach(skill => {
      const item = document.createElement('div');
      item.className = 'ai-mail-skill-item' + (skill.id === currentAnalyzeSkillId ? ' active' : '');
      item.innerHTML = `
        <span class="ai-mail-skill-emoji">${skill.emoji}</span>
        <div class="ai-mail-skill-info">
          <div class="ai-mail-skill-name">${skill.name}</div>
          <div class="ai-mail-skill-desc">${skill.desc}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        currentAnalyzeSkillId = skill.id;
        list.querySelectorAll('.ai-mail-skill-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      });
      list.appendChild(item);
    });
  }

  // Render saved skills in the Skills tab (type-aware)
  function renderSavedSkills() {
    const container = document.getElementById('saved-skills-list');
    const isAnalyze = currentSkillType === 'analyze';
    const skills = isAnalyze ? customAnalyzeSkills : customSkills;
    if (skills.length === 0) {
      container.innerHTML = '<div style="font-size:12px;color:#374151;padding:8px 0">还没有自定义 Skill</div>';
      return;
    }
    container.innerHTML = '';
    skills.forEach((skill, idx) => {
      const item = document.createElement('div');
      item.className = 'ai-skill-saved-item';
      item.innerHTML = `
        <span style="font-size:14px">${skill.emoji}</span>
        <span class="ai-skill-saved-name">${skill.name}</span>
        <button class="ai-skill-del-btn" data-idx="${idx}" title="删除">✕</button>
      `;
      item.querySelector('.ai-skill-del-btn').addEventListener('click', () => {
        skills.splice(idx, 1);
        if (isAnalyze) saveCustomAnalyzeSkills(); else saveCustomSkills();
        renderSavedSkills();
        if (isAnalyze) renderAnalyzeSkillList(); else renderSkillList();
      });
      container.appendChild(item);
    });
  }

  // Skill type toggle (in Skills tab)
  document.querySelectorAll('.ai-skill-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ai-skill-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSkillType = btn.dataset.skillType;
      document.getElementById('new-skill-prompt').placeholder =
        currentSkillType === 'analyze'
          ? 'System Prompt：说明分析角度、输出格式（条目/表格）、关注重点…'
          : 'System Prompt：详细描述这个 Skill 的回复风格、角色、注意事项…';
      renderSavedSkills();
    });
  });

  document.getElementById('save-skill-btn').addEventListener('click', () => {
    const emoji = document.getElementById('new-skill-emoji').value.trim() || '⚙️';
    const name = document.getElementById('new-skill-name').value.trim();
    const desc = document.getElementById('new-skill-desc').value.trim();
    const prompt = document.getElementById('new-skill-prompt').value.trim();
    if (!name || !prompt) { showToast('请填写名称和 Prompt'); return; }
    const skill = { id: (currentSkillType === 'analyze' ? 'analyze_custom_' : 'custom_') + Date.now(), emoji, name, desc: desc || name, prompt };
    if (currentSkillType === 'analyze') {
      customAnalyzeSkills.push(skill);
      saveCustomAnalyzeSkills();
      renderAnalyzeSkillList();
    } else {
      customSkills.push(skill);
      saveCustomSkills();
      renderSkillList();
    }
    renderSavedSkills();
    document.getElementById('new-skill-name').value = '';
    document.getElementById('new-skill-desc').value = '';
    document.getElementById('new-skill-prompt').value = '';
    document.getElementById('new-skill-emoji').value = '';
    showToast('✅ Skill 已保存');
  });

  function saveCustomSkills() {
    if (!isExtensionAlive()) return;
    chrome.storage.local.set({ customSkills });
  }

  function saveCustomAnalyzeSkills() {
    if (!isExtensionAlive()) return;
    chrome.storage.local.set({ customAnalyzeSkills });
  }

  // ─── Email reading ────────────────────────────────────────────────────────────
  // attachments: Array<{ name, url, text? }>  (url/text empty on non-Netease-Enterprise)
  // attachmentText: lazily-extracted full text of all readable attachments (PDF),
  //                 populated by ensureAttachmentTexts() on demand, then cached.
  let emailData = { from: '', subject: '', body: '', attachments: [], attachmentText: '', attachmentTextReady: false };

  function readEmail() {
    // Invalidate cached attachment text on every (re)read — a different mail may be open.
    emailData.attachmentText = '';
    emailData.attachmentTextReady = false;

    const host = location.hostname;
    if (host === 'mail.qiye.163.com' || host === 'mailh.qiye.163.com' || host === 'qy.163.com' || host.includes('app.ym.163.com') || host.includes('ym.163.com')) {
      readNeteaseEnterprise();
    } else if (host.includes('163.com') || host.includes('126.com') || host.includes('yeah.net')) {
      readNetease();
    } else if (host.includes('qq.com')) {
      readQQMail();
    } else if (host.includes('gmail.com')) {
      readGmail();
    } else if (host.includes('outlook')) {
      readOutlook();
    } else {
      readGeneric();
    }
    updatePreview();
  }

  function readNetease() {
    // 网易邮箱 iframe 内容
    try {
      // 发件人
      const fromEl = document.querySelector('.from .mailAddress, [class*="from"] .address, .nui-addr-name, .nui-addr-addr');
      emailData.from = fromEl ? fromEl.textContent.trim() : trySelectors(['.header-from', '[class*="fromName"]', '.readHead .name']);

      // 主题
      const subjectEl = document.querySelector('.subject .title, [class*="readTitle"], h1[class*="subject"]');
      emailData.subject = subjectEl ? subjectEl.textContent.trim() : trySelectors(['[class*="subject"]', '.readHead h2']);

      // 正文 - 可能在 iframe 里
      let body = '';
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (iDoc && iDoc.body) {
            const text = iDoc.body.innerText.trim();
            if (text.length > body.length) body = text;
          }
        } catch (_) {}
      }
      if (!body) {
        const bodyEl = document.querySelector('.readMail-body, [class*="mail-content"], .mailBody');
        body = bodyEl ? bodyEl.innerText.trim() : '';
      }
      emailData.body = body;

      // 附件 — 限定在当前邮件阅读区，避免抓取其他邮件的附件
      const mailScope163 = document.querySelector(
        '.readMail-wrap, .mail-read-container, [class*="readMail"], #readDiv, .contentDiv'
      ) || document;
      const attachEls = mailScope163.querySelectorAll('.attachment-name, .nui-attach-name, [class*="attachName"]');
      emailData.attachments = [...attachEls].map(el => el.textContent.trim()).filter(Boolean)
        .map(name => ({ name, url: '', text: '' })); // name-only; PDF extraction not supported here
    } catch (e) {
      readGeneric();
    }
  }

  function readQQMail() {
    try {
      const iframe = document.querySelector('#mainFrame');
      const doc = iframe ? (iframe.contentDocument || iframe.contentWindow.document) : document;
      emailData.from = doc.querySelector('#senderName, .sender .name')?.textContent.trim() || '';
      emailData.subject = doc.querySelector('#subject, .subject')?.textContent.trim() || '';
      emailData.body = doc.querySelector('#mailContentContainer, #contentDiv')?.innerText.trim() || '';
      const attachs = doc.querySelectorAll('.attachmentNameWithoutLink, .attach_name');
      emailData.attachments = [...attachs].map(el => el.textContent.trim()).filter(Boolean)
        .map(name => ({ name, url: '', text: '' }));
    } catch (_) { readGeneric(); }
  }

  function readGmail() {
    try {
      emailData.from = document.querySelector('.gD')?.getAttribute('email') || document.querySelector('.go')?.textContent.trim() || '';
      emailData.subject = document.querySelector('h2.hP')?.textContent.trim() || '';
      emailData.body = document.querySelector('.a3s.aiL')?.innerText.trim() || '';
      // Gmail: .nH is the reading pane wrapper; .aQw contains attachment chips
      const gmailPane = document.querySelector('.nH .if, .AO, [role="main"]') || document;
      const attachs = gmailPane.querySelectorAll('.aQw span[data-tooltip], .aV3 .aB');
      emailData.attachments = [...attachs].map(el => el.getAttribute('data-tooltip') || el.textContent.trim()).filter(t => t && t.includes('.'))
        .map(name => ({ name, url: '', text: '' }));
    } catch (_) { readGeneric(); }
  }

  function readOutlook() {
    try {
      emailData.from = document.querySelector('[class*="senderName"]')?.textContent.trim() || '';
      emailData.subject = document.querySelector('[class*="subject"]')?.textContent.trim() || '';
      emailData.body = document.querySelector('[class*="emailBody"]')?.innerText.trim() || '';
      emailData.attachments = [];
    } catch (_) { readGeneric(); }
  }

  function readNeteaseEnterprise() {
    // 网易企业邮箱支持两种架构：
    // 旧版 (mail.qiye.163.com): iframe 嵌套，内容在 mainFrame 内
    // 新版 SPA (mailh.qiye.163.com): 无 iframe，内容直接在主 document
    try {
      // ── mailh.qiye.163.com 新版 SPA 精准选择器 ─────────────────────────
      // 基于 DOM 调试数据确认的实际 class 名

      // ── From: 找当前阅读邮件的发件人 ────────────────────────────────────
      // 问题：.from-name 在邮件列表和阅读区都有，全页扫描会抓到列表里第一封
      // 解决：优先用 senderEmailWrapper（只在阅读区头部出现），提取名字部分
      emailData.from = (() => {
        // Strategy A: 阅读区 header 里的 senderEmailWrapper（最准确）
        const senderWrap = document.querySelector('[class*="senderEmailWrapper"]');
        if (senderWrap) {
          // 文本格式: "Orders @ Caribbean Creations<orders@...>Copy"
          // 取第一个子节点文本或整体文本去掉 email 部分
          const raw = senderWrap.textContent.trim();
          const match = raw.match(/^(.+?)<[^>]+>/);
          if (match) return match[1].trim();
          // fallback: 取 senderEmailWrapper 内第一个非 email/Copy 的文本节点
          const children = [...senderWrap.childNodes];
          for (const node of children) {
            const t = node.textContent?.trim();
            if (t && !t.includes('@') && t !== 'Copy' && t.length > 1) return t;
          }
          return raw.split('<')[0].trim();
        }
        // Strategy B: 阅读区 header 里 sender--show-name 区域的 from-name
        // 用 [class*="sender-show"] 限定作用域，避免列表污染
        const senderHeader = document.querySelector('[class*="sender-show"], [class*="sender--show"]');
        if (senderHeader) {
          const fn = senderHeader.querySelector('.from-name, [class*="from-name"]');
          if (fn) return fn.textContent.trim();
        }
        // Strategy C: title class 里有 "From:" label 的同级 from-name
        // 阅读区头部结构: .title"From:" + .from-wrap > .from-name
        const titleEls = [...document.querySelectorAll('.title')];
        for (const el of titleEls) {
          if (el.textContent.trim() === 'From:') {
            const wrap = el.closest('[class*="header"], [class*="detail"], [class*="read"]');
            if (wrap) {
              const fn = wrap.querySelector('.from-name, [class*="from-name"]');
              if (fn) return fn.textContent.trim();
            }
            // try sibling
            const sib = el.nextElementSibling;
            if (sib) {
              const fn = sib.querySelector('.from-name') || sib;
              return fn.textContent.trim();
            }
          }
        }
        return '';
      })();

      // ── Subject: index-module--title-wrap 里的 ant-dropdown-trigger ─────
      emailData.subject = (() => {
        // 最准确：阅读区标题栏，class 含 title-wrap 且文字是邮件标题
        const titleWrap = document.querySelector('[class*="title-wrap"] .ant-dropdown-trigger, [class*="title-wrap"] [class*="u-info-title"]');
        if (titleWrap) return titleWrap.textContent.trim();
        // fallback: MailTab 标签上有邮件标题
        const tabs = [...document.querySelectorAll('[class*="tab-title"]')];
        for (const t of tabs) {
          const txt = t.textContent.trim();
          if (txt && txt !== 'Inbox' && txt !== 'Drafts' && txt.length > 1) return txt;
        }
        return document.title || '';
      })();

      // ── Body: mail-content-iframe 里的内容 ──────────────────────────────
      let body = '';
      // 调试确认: iframe id="mail-content-iframe"
      const contentFrame = document.getElementById('mail-content-iframe');
      if (contentFrame) {
        try {
          const iDoc = contentFrame.contentDocument || contentFrame.contentWindow?.document;
          if (iDoc?.body) body = iDoc.body.innerText?.trim() || '';
        } catch (_) {}
      }
      // fallback: 其他 iframe
      if (!body) {
        document.querySelectorAll('iframe').forEach(iframe => {
          try {
            const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iDoc?.body) {
              const t = iDoc.body.innerText?.trim() || '';
              if (t.length > body.length) body = t;
            }
          } catch (_) {}
        });
      }
      emailData.body = body;

      // Attachments — scope to the readmail-attachments container confirmed by debug.
      // Capture both filename AND download URL so we can extract PDF text on demand.
      // (URL discovery lives in attachment_reader.js; gracefully degrades to name-only.)
      emailData.attachments = (() => {
        const links = (window.AIAttachment && window.AIAttachment.discoverAttachmentLinks)
          ? window.AIAttachment.discoverAttachmentLinks(document)
          : [];
        if (links.length) {
          return links.map(l => ({ name: l.name, url: l.url, text: '', el: l.el }));
        }
        // Fallback: name-only (old behavior) if URL discovery found nothing.
        const attachContainer = document.querySelector('[class*="readmail-attachments"]');
        if (attachContainer) {
          const names = [...attachContainer.querySelectorAll('.attachment-name, [class*="attachment-name"]')]
            .map(el => el.textContent.trim()).filter(Boolean);
          if (names.length) {
            return names.map(name => ({ name, url: '', text: '' }));
          }
        }
        return [];
      })();

      // Fallback to generic if nothing found
      if (!emailData.from && !emailData.subject && !emailData.body) {
        readGeneric();
      }
    } catch (e) {
      readGeneric();
    }
  }

  function readAttachmentsScoped(doc) {
    // Priority 1: find the currently-active/focused mail reading pane
    // 网易企业邮箱的阅读区容器候选
    const containerSelectors = [
      '.readMail-wrap',        // 阅读主容器
      '.mail-read-container',
      '.readTitle',            // 往上找最近的邮件容器
      '[class*="readMail"]',
      '[class*="mail-read"]',
      '.nui-mail-detail',
      '#readDiv',
      '.contentDiv',
    ];

    let container = null;
    for (const sel of containerSelectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) { container = el; break; }
      } catch (_) {}
    }

    // Priority 2: look inside nested content iframes for attachment zones
    if (!container) {
      // Try to find attachment section in nested iframes
      const iframes = doc.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iDoc) continue;
          const attachZone = iDoc.querySelector(
            '[class*="attach"], .attachment-list, .attach-list, .file-list'
          );
          if (attachZone) {
            const names = [...attachZone.querySelectorAll(
              '[class*="name"], [class*="filename"], [class*="file-name"], span, a'
            )]
              .map(el => el.textContent.trim())
              .filter(t => t.length > 1 && t.includes('.'));
            if (names.length) return names;
          }
        } catch (_) {}
      }
    }

    // Scope the search: if we have a container use it, otherwise fall back to doc
    // but apply strict filters to avoid cross-email contamination
    const scope = container || doc;

    // Strict selectors — prefer attachment-specific class names
    const strictSelectors = [
      '.attachment-name',
      '.nui-attach-name',
      '[class*="attachName"]',
      '[class*="attach-name"]',
      '[class*="fileName"]',
      '[class*="file-name"]',
    ];

    for (const sel of strictSelectors) {
      try {
        const els = scope.querySelectorAll(sel);
        if (els.length) {
          return [...els].map(el => el.textContent.trim()).filter(Boolean);
        }
      } catch (_) {}
    }

    // Last resort: only if we have a scoped container (not full doc)
    if (container) {
      const loose = container.querySelectorAll('[class*="attach"] .name, .file-name');
      return [...loose].map(el => el.textContent.trim()).filter(Boolean);
    }

    return [];
  }

  function trySelectorsInDoc(doc, selectors, returnInnerText = false) {
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) return returnInnerText ? (el.innerText?.trim() || '') : el.textContent.trim();
      } catch (_) {}
    }
    return '';
  }

  function readGeneric() {
    // Fallback: grab visible text blocks
    emailData.from = '';
    emailData.subject = document.title;
    emailData.body = document.body.innerText.slice(0, 2000);
    emailData.attachments = [];
  }

  function trySelectors(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el.textContent.trim();
    }
    return '';
  }

  function updatePreview() {
    document.getElementById('preview-from-val').textContent = emailData.from || '（未检测到）';
    document.getElementById('preview-subject-val').textContent = emailData.subject || '（未检测到）';
    document.getElementById('preview-body').textContent = emailData.body
      ? emailData.body.slice(0, 300) + (emailData.body.length > 300 ? '…' : '')
      : '（未检测到邮件内容，请在网易邮箱中打开一封邮件）';
    // Clear translation cache when email changes
    _translationCache = null;
    _translating = false;
    document.getElementById('ai-mail-translate-tooltip').classList.remove('visible');
    // Show/hide hint based on whether there's content to translate
    const hasEnglish = emailData.body && emailData.body.trim().length > 10;
    document.getElementById('preview-translate-hint').style.display = hasEnglish ? '' : 'none';

    const attachContainer = document.getElementById('preview-attachments');
    attachContainer.innerHTML = '';
    emailData.attachments.forEach(a => {
      const name = typeof a === 'string' ? a : a.name;
      const badge = document.createElement('span');
      badge.className = 'ai-mail-attach-badge';
      badge.textContent = '📎 ' + name;
      attachContainer.appendChild(badge);
    });
  }

  // ─── Email preview translation on hover ──────────────────────────────────────
  let _translationCache = null;   // null = not yet translated
  let _translating = false;       // prevent concurrent requests
  let _translateHideTimer = null;

  const _previewEl = document.getElementById('ai-mail-email-preview');
  const _tooltipEl = document.getElementById('ai-mail-translate-tooltip');
  const _tooltipContent = document.getElementById('ai-mail-translate-content');

  _previewEl.addEventListener('mouseenter', async () => {
    clearTimeout(_translateHideTimer);

    if (!emailData.body || emailData.body.trim().length < 10) return;

    // Show tooltip immediately (with cached or loading state)
    _tooltipEl.classList.add('visible');

    if (_translationCache) {
      _tooltipContent.textContent = _translationCache;
      return;
    }
    if (_translating) return; // already in flight

    // Check if API is available
    if (!isExtensionAlive()) return;
    const apiKey = settings[KEY_MAP[currentProvider]];
    if (!apiKey) {
      _tooltipContent.textContent = '（请先配置 AI 服务商 API Key）';
      return;
    }

    _translating = true;
    _tooltipContent.textContent = '正在翻译...';

    // Translate the latest reply (first ~800 chars of body to keep it fast)
    const textToTranslate = emailData.body.slice(0, 800);
    const model = settings[MODEL_MAP[currentProvider]] || undefined;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'CALL_AI',
        payload: {
          provider: currentProvider,
          apiKey,
          model,
          systemPrompt: '你是一个专业翻译，将用户提供的邮件内容翻译成中文。只输出译文，不要解释、不要前缀，保留原文的段落结构。如果原文已经是中文则原样输出。',
          messages: [{ role: 'user', content: `请将以下邮件内容翻译成中文：\n\n${textToTranslate}` }]
        }
      });

      if (result && !result.error && result.text) {
        _translationCache = result.text;
        _tooltipContent.textContent = _translationCache;
      } else {
        _tooltipContent.textContent = '翻译失败，请重试';
        _translationCache = null;
      }
    } catch (_) {
      _tooltipContent.textContent = '翻译失败，请重试';
      _translationCache = null;
    } finally {
      _translating = false;
    }
  });

  _previewEl.addEventListener('mouseleave', () => {
    // Small delay so tooltip doesn't flicker if cursor briefly exits
    _translateHideTimer = setTimeout(() => {
      _tooltipEl.classList.remove('visible');
    }, 200);
  });

  // Keep tooltip visible when cursor enters tooltip itself
  _tooltipEl.addEventListener('mouseenter', () => clearTimeout(_translateHideTimer));
  _tooltipEl.addEventListener('mouseleave', () => {
    _translateHideTimer = setTimeout(() => {
      _tooltipEl.classList.remove('visible');
    }, 200);
  });

  // ─── Generate reply ───────────────────────────────────────────────────────────
  document.getElementById('ai-mail-generate-btn').addEventListener('click', generateReply);
  document.getElementById('ai-mail-regen-btn').addEventListener('click', regenerateReply);

  // "重新生成"：如果已经有草稿、并且用户填写了补充要求，则把补充要求理解为
  // "在已有草稿基础上调整"，而不是丢掉草稿、拿原始邮件从头再生成一遍。
  // 没有草稿或没填补充要求时，行为和"生成回复"一致（从原始邮件重新生成一版）。
  async function regenerateReply() {
    const resultArea = document.getElementById('ai-mail-result-area');
    const existingDraft = document.getElementById('ai-mail-result-text').textContent.trim();
    const extra = document.getElementById('ai-mail-instruction').value.trim();

    if (!resultArea.classList.contains('visible') || !existingDraft || !extra) {
      return generateReply();
    }

    if (typeof chrome !== 'undefined' && chrome.storage) {
      const stored = await chrome.storage.local.get(['settings']);
      if (stored.settings) settings = stored.settings;
    }

    const apiKey = settings[KEY_MAP[currentProvider]];
    if (!apiKey) {
      const anyConfigured = Object.values(KEY_MAP).some(k => !!settings[k]);
      if (!anyConfigured) {
        showErrorWithAction(
          '尚未配置任何 AI 服务商，请先前往「设置」填写 API Key',
          '去设置',
          () => { document.querySelector('.ai-mail-tab[data-tab="settings"]').click(); }
        );
      } else {
        const providerName = PROVIDER_NAMES[currentProvider] || currentProvider;
        showError(`请先在「设置」中填写 ${providerName} 的 API Key`);
      }
      return;
    }

    if (!isExtensionAlive()) {
      showError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试');
      return;
    }

    setLoading(true);
    clearError();

    const skill = getAllSkills().find(s => s.id === currentSkillId) || DEFAULT_SKILLS[0];
    const model = settings[MODEL_MAP[currentProvider]] || undefined;

    const OUTPUT_RULE = `

【重要输出规则】
- 只输出调整后的完整邮件正文本身，不要输出任何其他内容
- 不要输出分析、假设、补充说明、修改点罗列等
- 不要输出"以下是调整后的邮件："之类的前缀
- 输出语言必须使用英文（English）
- 下面的"补充要求"只是调整说明，通常是用中文写的，这不代表要把邮件正文换成中文——除非补充要求里明确写了"翻译成中文"之类的语言切换指令，否则邮件正文必须保持英文
- 直接以邮件称呼（如 Hi Brunel,）开头；结尾不要带任何签名、署名、名字、联系方式或客套结束语（邮箱软件会自动补全签名）`;

    const systemPrompt = `${skill.prompt}\n\n你现在的任务是基于下面这封已经生成好的邮件草稿，按照补充要求对它做整体调整，而不是抛开草稿、重新写一封新邮件。草稿中没有被补充要求涉及的内容应尽量保留。${OUTPUT_RULE}`;

    const userMessage = `已生成的邮件草稿：\n${existingDraft}\n\n补充要求（请据此调整上面的草稿，并输出调整后的完整邮件正文）：${extra}`;

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'CALL_AI',
        payload: { provider: currentProvider, apiKey, model, systemPrompt, messages: [{ role: 'user', content: userMessage }] }
      });
    } catch (e) {
      setLoading(false);
      const msg = e && e.message ? e.message : '';
      if (msg.includes('Extension context invalidated') || msg.includes('context invalidated')) {
        showError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试');
      } else {
        showError('插件通信失败，请刷新页面后重试（F5）');
      }
      return;
    }

    setLoading(false);

    if (!result) {
      showError('未收到 AI 响应，请刷新页面后重试（F5）');
      return;
    }
    if (result.error) {
      showError('API 错误：' + result.error);
      return;
    }

    document.getElementById('ai-mail-result-text').textContent = result.text;
    clearResultSelection();
    showToast('✅ 已基于补充要求调整草稿');
  }
  document.getElementById('ai-mail-analyze-btn').addEventListener('click', analyzeEmail);
  document.getElementById('ai-mail-reanalyze-btn').addEventListener('click', analyzeEmail);

  // ─── Attachment text extraction (PDF) ─────────────────────────────────────────
  // On-demand: discovers download URLs (incl. async dropdown-click fallback),
  // downloads each PDF via attachment_reader.js, extracts its text, caches it
  // back onto emailData.attachments[].text + emailData.attachmentText.
  // Cached per-email; cleared when readEmail() repopulates attachments. Best-effort:
  // any failure (no url, not pdf, parse error) leaves that attachment's text empty.
  // `statusCb(status)` lets the caller update button text during the (slow) download.
  async function ensureAttachmentTexts(statusCb) {
    if (emailData.attachmentTextReady) { return; }
    if (!window.AIAttachment || !window.AIAttachment.downloadAttachmentText) {
      console.log('[AI Mail Reply] AIAttachment module not available — cannot extract attachments');
      return;
    }

    console.log('[AI Mail Reply] ensureAttachmentTexts: attachments =', emailData.attachments.map(a => ({ name: a.name, url: a.url ? a.url.slice(0, 80) : '(empty)', text: a.text ? a.text.length + ' chars' : '(none)' })));

    // Step 1: ensure every PDF attachment has a download URL. Sync discovery
    // (readNeteaseEnterprise) may have left url empty on SPA cards whose links
    // live in React state — the async dropdown-click fallback reveals them.
    const pdfsWithoutUrl = emailData.attachments.filter(a =>
      window.AIAttachment.isPdfName(a.name) && !a.url
    );
    console.log('[AI Mail Reply] PDFs without URL (pre-async-discovery):', pdfsWithoutUrl.length, pdfsWithoutUrl.map(a => a.name));
    if (pdfsWithoutUrl.length && window.AIAttachment.discoverAttachmentLinksAsync) {
      console.log('[AI Mail Reply] calling discoverAttachmentLinksAsync for', pdfsWithoutUrl.length, 'PDFs without URL');
      if (statusCb) statusCb('⏳ 查找附件链接…');
      try {
        const refreshed = await window.AIAttachment.discoverAttachmentLinksAsync(emailData.attachments);
        // Merge any newly-discovered URLs back into emailData.attachments.
        for (const r of refreshed) {
          const target = emailData.attachments.find(a => a.name === r.name);
          if (target && r.url && !target.url) {
            target.url = r.url;
            console.log('[AI Mail Reply] async discovery found URL for ' + r.name + ': ' + r.url.slice(0, 100));
          }
        }
      } catch (e) {
        console.log('[AI Mail Reply] async discovery error:', e && e.message);
      }
    }

    // Step 2: download + extract text for PDFs that have a URL but no cached text.
    const pdfs = emailData.attachments.filter(a => window.AIAttachment.isPdfName(a.name) && a.url && !a.text);
    const pdfsNoUrl = emailData.attachments.filter(a => window.AIAttachment.isPdfName(a.name) && !a.url);
    console.log('[AI Mail Reply] PDFs to download:', pdfs.length, pdfs.map(a => a.name));
    console.log('[AI Mail Reply] PDFs still without URL (will be skipped):', pdfsNoUrl.length, pdfsNoUrl.map(a => a.name));
    // Dump full net-store so we can see ALL URLs interceptor captured (not just for this PDF).
    try {
      const storeEl = document.getElementById('__ai_mail_attachment_urls__');
      const storeData = storeEl ? storeEl.textContent : '(element not found)';
      console.log('[AI Mail Reply] net-store full dump:', storeData);
    } catch (_) {}
    pdfsNoUrl.forEach(a => { console.log('[AI Mail Reply] PDF no-url card HTML:', a.el ? a.el.outerHTML.slice(0, 500) : '(no el)', '; net-store match:', window.AIAttachment._findUrlFromNetStore ? window.AIAttachment._findUrlFromNetStore(a.name) : '(no fn)'); });
    if (pdfs.length && statusCb) statusCb('⏳ 读取附件…');
    // Download + parse concurrently; individual failures are isolated.
    const results = await Promise.all(
      pdfs.map(a => window.AIAttachment.downloadAttachmentText(a.name, a.url).catch((e) => ({ name: a.name, text: '', error: 'unknown: ' + (e && e.message) })))
    );
    for (const r of results) {
      console.log('[AI Mail Reply] downloadAttachmentText result for ' + r.name + ':', { error: r.error, totalPages: r.totalPages, textLen: r.text ? r.text.length : 0, textPreview: r.text ? r.text.slice(0, 100) : '' });
      const target = emailData.attachments.find(a => a.name === r.name);
      if (target && r.text) target.text = r.text;
    }
    // Compose the joined attachment-text block (only readable PDFs with text).
    emailData.attachmentText = emailData.attachments
      .map(a => ({ ...a, isPdf: window.AIAttachment.isPdfName(a.name) }))
      .filter(a => a.isPdf)
      .map(a => {
        if (a.text) return `── ${a.name} ──\n${a.text}`;
        return `── ${a.name} ──\n（未能提取文本：${a.url ? '解析失败' : '未找到下载链接'}）`;
      })
      .join('\n\n');
    emailData.attachmentTextReady = true;
    console.log('[AI Mail Reply] attachmentText final length:', emailData.attachmentText.length, 'chars');
    console.log('[AI Mail Reply] attachmentText preview:', emailData.attachmentText.slice(0, 300));
    if (statusCb) statusCb(null);
  }

  async function analyzeEmail() {
    readEmail();
    const skills = getAllAnalyzeSkills();
    if (!currentAnalyzeSkillId && skills.length) currentAnalyzeSkillId = skills[0].id;
    const skill = skills.find(s => s.id === currentAnalyzeSkillId) || skills[0];
    const extraCheck = document.getElementById('ai-mail-analyze-instruction').value.trim();
    if (!skill && !extraCheck) {
      showAnalyzeError('请选择分析 Skill，或填写补充要求');
      return;
    }

    // Reload settings from storage
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const stored = await chrome.storage.local.get(['settings']);
      if (stored.settings) settings = stored.settings;
    }

    const apiKey = settings[KEY_MAP[currentProvider]];
    if (!apiKey) {
      const anyConfigured = Object.values(KEY_MAP).some(k => !!settings[k]);
      if (!anyConfigured) {
        showAnalyzeErrorWithAction(
          '尚未配置任何 AI 服务商，请先前往「设置」填写 API Key',
          '去设置',
          () => { document.querySelector('.ai-mail-tab[data-tab="settings"]').click(); }
        );
      } else {
        showAnalyzeError(`请先在「设置」中填写 ${PROVIDER_NAMES[currentProvider] || currentProvider} 的 API Key`);
      }
      return;
    }

    if (!emailData.body && !emailData.subject) {
      showAnalyzeError('未能读取到邮件内容，请确认已打开一封邮件');
      return;
    }

    setAnalyzeLoading(true);
    clearAnalyzeError();
    document.getElementById('ai-mail-analyze-area').classList.remove('visible');

    // Extract attachment text (PDF) on demand. Updates the analyze button text
    // while downloading. Failures are isolated per-attachment (see ensureAttachmentTexts).
    try {
      await ensureAttachmentTexts(status => {
        const txt = document.getElementById('analyze-btn-text');
        if (status) txt.innerHTML = status; else txt.innerHTML = '<div class="ai-mail-spinner"></div>';
      });
    } catch (_) { /* attachment extraction is best-effort; continue with body only */ }

    // Build context — include full body (history) + attachment filenames + extracted PDF text
    const emailContext = [
      emailData.from    ? `发件人：${emailData.from}` : '',
      emailData.subject ? `主题：${emailData.subject}` : '',
      emailData.attachments.length ? `附件列表：${emailData.attachments.map(a => a.name).join('、')}` : '',
      emailData.attachmentText ? `\n附件内容（已从 PDF 提取文本）：\n${emailData.attachmentText}` : '',
      '',
      '邮件正文及历史往来：',
      emailData.body
    ].filter(l => l !== undefined).join('\n').trim();

    const extra = document.getElementById('ai-mail-analyze-instruction').value.trim();

    const OUTPUT_RULE = `\n\n【输出规则】只输出分析结果本身，不要前言或"以下是分析结果"之类的说明，直接从分析内容开始。`;
    // 没有补充要求时才使用 skill。
    const basePrompt = extra ? `请按以下要求分析邮件：${extra}` : (skill ? skill.prompt : '');
    const systemPrompt = basePrompt + OUTPUT_RULE;
    const userMessage = `请分析以下邮件内容（包含历史往来和附件信息），只输出分析结果：\n\n${emailContext}`;

    const model = settings[MODEL_MAP[currentProvider]] || undefined;

    if (!isExtensionAlive()) {
      setAnalyzeLoading(false);
      showAnalyzeError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试');
      return;
    }

    let result;
    console.log('[AI Mail Reply] sending analyze request, attachmentText length:', emailData.attachmentText.length, 'attachments:', emailData.attachments.map(a => a.name + (a.text ? '(text)' : '(no text)')));

    let _aElapsed = 0;
    const _aTimer = setInterval(() => {
      _aElapsed++;
      const txt = document.getElementById('analyze-btn-text');
      if (txt) txt.innerHTML = `<div class="ai-mail-spinner"></div> 分析中… ${_aElapsed}s`;
    }, 1000);

    try {
      result = await chrome.runtime.sendMessage({
        type: 'CALL_AI',
        payload: { provider: currentProvider, apiKey, model, systemPrompt, messages: [{ role: 'user', content: userMessage }] }
      });
    } catch (e) {
      clearInterval(_aTimer);
      setAnalyzeLoading(false);
      const msg = e && e.message ? e.message : '';
      if (msg.includes('Extension context invalidated') || msg.includes('context invalidated')) {
        showAnalyzeError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试');
      } else {
        showAnalyzeError('插件通信失败，请刷新页面后重试（F5）');
      }
      return;
    }

    clearInterval(_aTimer);
    setAnalyzeLoading(false);

    if (!result || result.error) {
      showAnalyzeError('API 错误：' + (result?.error || '未知错误'));
      return;
    }

    document.getElementById('ai-mail-analyze-text').textContent = result.text;
    document.getElementById('ai-mail-analyze-area').classList.add('visible');
    // Hide reply result to avoid confusion
    document.getElementById('ai-mail-result-area').classList.remove('visible');
  }

  document.getElementById('ai-mail-analyze-copy-btn').addEventListener('click', () => {
    const text = document.getElementById('ai-mail-analyze-text').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('✅ 已复制分析结果'));
  });

  async function generateReply() {
    readEmail();
    const skill = getAllSkills().find(s => s.id === currentSkillId) || DEFAULT_SKILLS[0];
    const extra = document.getElementById('ai-mail-instruction').value.trim();

    if (typeof chrome !== 'undefined' && chrome.storage) {
      const stored = await chrome.storage.local.get(['settings']);
      if (stored.settings) settings = stored.settings;
    }

    const apiKey = settings[KEY_MAP[currentProvider]];
    if (!apiKey) {
      const anyConfigured = Object.values(KEY_MAP).some(k => !!settings[k]);
      if (!anyConfigured) {
        showErrorWithAction(
          '尚未配置任何 AI 服务商，请先前往「设置」填写 API Key',
          '去设置',
          () => {
            document.querySelector('.ai-mail-tab[data-tab="settings"]').click();
          }
        );
      } else {
        const providerName = PROVIDER_NAMES[currentProvider] || currentProvider;
        showError(`请先在「设置」中填写 ${providerName} 的 API Key`);
      }
      return;
    }

    if (!emailData.body && !emailData.subject) {
      showError('未能读取到邮件内容，请确认已打开一封邮件');
      return;
    }

    setLoading(true);
    clearError();
    document.getElementById('ai-mail-result-area').classList.remove('visible');

    // Extract attachment text (PDF) on demand for reply context (PO/order replies
    // need attachment details too). Best-effort, isolated failures.
    try {
      await ensureAttachmentTexts(status => {
        const txt = document.getElementById('generate-btn-text');
        if (status) txt.innerHTML = status; else txt.innerHTML = '<div class="ai-mail-spinner"></div> 生成中...';
      });
    } catch (_) { /* continue with body only */ }

    const emailContext = [
      emailData.from ? `发件人：${emailData.from}` : '',
      emailData.subject ? `主题：${emailData.subject}` : '',
      emailData.attachments.length ? `附件：${emailData.attachments.map(a => a.name).join('、')}` : '',
      emailData.attachmentText ? `\n附件内容（已从 PDF 提取文本）：\n${emailData.attachmentText}` : '',
      '',
      '邮件正文：',
      emailData.body
    ].filter(l => l !== undefined).join('\n').trim();

    // Strict output constraint — appended to every skill prompt
    const OUTPUT_RULE = `

【重要输出规则】
- 只输出邮件正文本身，不要输出任何其他内容
- 不要输出分析、假设、匹配场景、补充说明、模板编号、破折号分隔线等
- 不要输出"以下是为您生成的邮件："之类的前缀
- 不要在邮件后面添加任何注释或"补充说明"
- 回复邮件正文必须使用英文（English）回复，无论原邮件是什么语言；下面如果有"补充要求"，那通常是用中文写的修改说明，本身不代表要把回复语言换成中文——除非补充要求里明确要求切换语言（如"翻译成中文"），否则一律使用英文回复
- 直接以邮件称呼（如 Hi Brunel,）开头；结尾不要带任何签名、署名、名字、联系方式或客套结束语（邮箱软件会自动补全签名）`;

    const systemPrompt = skill.prompt + OUTPUT_RULE + (extra
      ? `\n\n【补充要求（优先级最高）】\n${extra}\n如果以上补充要求与前面的风格设定存在冲突，请优先满足补充要求，风格设定服从于补充要求。`
      : '');

    const userMessage = `请帮我回复以下邮件，只输出邮件正文，不要任何额外说明：\n\n${emailContext}`
      + (extra ? `\n\n【补充要求，请务必满足】：${extra}` : '');

    const model = settings[MODEL_MAP[currentProvider]] || undefined;

    // Guard: check context is still alive before sending (SPA nav can invalidate it).
    if (!isExtensionAlive()) {
      setLoading(false);
      showError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试');
      return;
    }

    let result;
    console.log('[AI Mail Reply] sending generate request, attachmentText length:', emailData.attachmentText.length, 'attachments:', emailData.attachments.map(a => a.name + (a.text ? '(text)' : '(no text)')));
    try {
      result = await chrome.runtime.sendMessage({
        type: 'CALL_AI',
        payload: {
          provider: currentProvider,
          apiKey,
          model,
          systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        }
      });
    } catch (e) {
      setLoading(false);
      const msg = e && e.message ? e.message : '';
      if (msg.includes('Extension context invalidated') || msg.includes('context invalidated')) {
        showError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试');
      } else {
        showError('插件通信失败，请刷新页面后重试（F5）');
      }
      return;
    }

    setLoading(false);

    if (!result) {
      showError('未收到 AI 响应，请刷新页面后重试（F5）');
      return;
    }

    if (result.error) {
      showError('API 错误：' + result.error);
      return;
    }

    document.getElementById('ai-mail-result-text').textContent = result.text;
    document.getElementById('ai-mail-result-area').classList.add('visible');
    // Reset selection state when new result arrives
    clearResultSelection();
  }

  // ─── Result text selection tracking ─────────────────────────────────────────
  let _selectedTextInResult = '';

  function clearResultSelection() {
    _selectedTextInResult = '';
    document.getElementById('ai-mail-selection-hint').style.display = 'none';
    document.getElementById('ai-mail-refine-btn').style.display = 'none';
    // Remove any highlight marks, restore plain text
    const el = document.getElementById('ai-mail-result-text');
    const marks = el.querySelectorAll('mark.ai-refine-highlight');
    marks.forEach(mark => {
      const text = document.createTextNode(mark.textContent);
      mark.parentNode.replaceChild(text, mark);
    });
    // Normalize adjacent text nodes
    el.normalize();
  }

  document.getElementById('ai-mail-result-text').addEventListener('mouseup', updateResultSelection);
  document.getElementById('ai-mail-result-text').addEventListener('keyup', updateResultSelection);

  function updateResultSelection() {
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text || text.length === 0) {
      // Only clear if we don't already have a pinned selection
      if (!_selectedTextInResult) clearResultSelection();
      return;
    }

    // Check that the selection is inside #ai-mail-result-text
    const resultEl = document.getElementById('ai-mail-result-text');
    if (!resultEl.contains(sel.anchorNode)) return;

    _selectedTextInResult = text;

    // Pin the highlight: wrap selected range in <mark>
    try {
      // Remove any previous highlight first
      clearResultSelection();
      // Re-read selection after DOM change (clearResultSelection calls normalize)
      const sel2 = window.getSelection();
      // If selection was lost during DOM manipulation, re-highlight by text match
      if (!sel2 || !sel2.toString().trim()) {
        highlightByText(resultEl, text);
      } else {
        const range = sel2.getRangeAt(0);
        const mark = document.createElement('mark');
        mark.className = 'ai-refine-highlight';
        range.surroundContents(mark);
        sel2.removeAllRanges(); // clear blue selection, keep mark visible
      }
    } catch (_) {
      // surroundContents fails for multi-element ranges; fall back to text search
      highlightByText(resultEl, text);
    }

    _selectedTextInResult = text;
    document.getElementById('ai-mail-selection-hint').style.display = 'inline';
    document.getElementById('ai-mail-refine-btn').style.display = '';
  }

  function highlightByText(container, text) {
    // Walk text nodes and wrap the first occurrence of `text`
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(text);
      if (idx === -1) continue;
      const before = node.splitText(idx);
      const inside = before.splitText(text.length);
      const mark = document.createElement('mark');
      mark.className = 'ai-refine-highlight';
      before.parentNode.insertBefore(mark, inside);
      mark.appendChild(before);
      break;
    }
    container.normalize(); // clean up only unfragmented nodes outside mark
  }

  // ─── Refine selected text ────────────────────────────────────────────────────
  document.getElementById('ai-mail-refine-btn').addEventListener('click', async () => {
    const selected = _selectedTextInResult;
    const extra = document.getElementById('ai-mail-instruction').value.trim();
    const fullText = document.getElementById('ai-mail-result-text').textContent;

    if (!selected) { showError('请先在生成的邮件中选中要修改的文字'); return; }
    if (!extra) { showError('请在补充要求里描述如何修改选中的文字'); return; }

    if (!isExtensionAlive()) { showError('⚠️ 插件上下文已失效，请按 F5 刷新页面后重试'); return; }

    const apiKey = settings[KEY_MAP[currentProvider]];
    if (!apiKey) { showError('请先配置 AI 服务商 API Key'); return; }

    setLoading(true);
    clearError();

    const model = settings[MODEL_MAP[currentProvider]] || undefined;

    // Carry the current skill so tone/language stays consistent with the original reply.
    const currentSkill = getAllSkills().find(s => s.id === currentSkillId) || DEFAULT_SKILLS[0];
    const OUTPUT_RULE = `\n\n【重要输出规则】\n- 只输出修改后的完整邮件正文，不要任何说明或前缀\n- 输出语言必须使用英文（English）\n- 下面的"修改要求"只是修改说明，通常是用中文写的，这不代表要把邮件正文换成中文——除非修改要求里明确写了"翻译成中文"之类的语言切换指令，否则邮件正文必须保持英文\n- 直接以邮件称呼开头；结尾不要带任何签名、署名、名字、联系方式或客套结束语（邮箱软件会自动补全签名）`;

    const systemPrompt = `${currentSkill.prompt}\n\n你现在的任务是对一封已生成的邮件草稿进行局部修改。只修改用户指定的那段文字，其他部分原样保留，输出完整修改后的邮件。${OUTPUT_RULE}`;

    const userMessage = `完整邮件草稿：\n${fullText}\n\n需要修改的片段：\n"${selected}"\n\n修改要求：${extra}\n\n请输出修改后的完整邮件：`;

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'CALL_AI',
        payload: { provider: currentProvider, apiKey, model, systemPrompt, messages: [{ role: 'user', content: userMessage }] }
      });
    } catch (e) {
      setLoading(false);
      showError('插件通信失败，请刷新页面后重试（F5）');
      return;
    }

    setLoading(false);
    if (!result || result.error) { showError('API 错误：' + (result?.error || '未知错误')); return; }

    document.getElementById('ai-mail-result-text').textContent = result.text;
    clearResultSelection();
    showToast('✅ 已优化选中内容');
  });

  // ─── Copy & Insert ────────────────────────────────────────────────────────────
  document.getElementById('ai-mail-copy-btn').addEventListener('click', () => {
    const text = document.getElementById('ai-mail-result-text').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('✅ 已复制到剪贴板'));
  });

  document.getElementById('ai-mail-insert-btn').addEventListener('click', () => {
    const text = document.getElementById('ai-mail-result-text').textContent;
    // Convert plain text to HTML, preserving line breaks (use Arial font, 14px)
    const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const textHtml = text.split('\n').map(l => `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px;">${l ? escapeHtml(l) : '<br>'}</div>`).join('');
    // Separator line between new reply and quoted history
    const SEPARATOR = '<div><br></div><div>--------------------------------------------------</div><div><br></div>';

    // ── Strategy 1: TinyMCE API (网易企业邮箱) ────────────────────────────────
    // Prepend new reply above existing content (quoted history), don't overwrite.
    try {
      const tinymce = window.tinymce || window.top?.tinymce;
      const editor = tinymce?.activeEditor || tinymce?.editors?.[tinymce.editors.length - 1];
      if (editor) {
        editor.focus();
        const existing = editor.getContent(); // preserve quoted history
        const hasHistory = existing && existing.trim().length > 0;
        editor.setContent(textHtml + (hasHistory ? SEPARATOR + existing : ''));
        // Move cursor to top
        editor.selection.setCursorLocation(editor.getBody().firstChild, 0);
        editor.fire('change');
        showToast('✅ 已插入编辑框（历史记录已保留）');
        return;
      }
    } catch (_) {}

    // ── Strategy 2: TinyMCE iframe body ──────────────────────────────────────
    try {
      const tinyFrames = document.querySelectorAll('iframe[id*="mce"], iframe[id*="tinymce"], .tox-edit-area iframe');
      for (const frame of tinyFrames) {
        const doc = frame.contentDocument || frame.contentWindow?.document;
        if (doc && doc.body && doc.body.isContentEditable) {
          doc.body.focus();
          const existing = doc.body.innerHTML;
          const hasHistory = existing && doc.body.innerText.trim().length > 0;
          doc.body.innerHTML = textHtml + (hasHistory ? SEPARATOR + existing : '');
          showToast('✅ 已插入编辑框（历史记录已保留）');
          return;
        }
      }
    } catch (_) {}

    // ── Strategy 3: Gmail compose box ────────────────────────────────────────
    try {
      const gmailBox = document.querySelector(
        'div[aria-label*="邮件正文"], div[aria-label*="Message Body"], div[g_editable="true"], div[contenteditable="true"][role="textbox"]'
      );
      if (gmailBox) {
        gmailBox.focus();
        const existing = gmailBox.innerHTML;
        const hasHistory = existing && gmailBox.innerText.trim().length > 0;
        if (hasHistory) {
          // Insert at top: move cursor to beginning then insert
          const sel = window.getSelection();
          const range = document.createRange();
          range.setStart(gmailBox, 0);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertHTML', false, textHtml + SEPARATOR);
        } else {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertHTML', false, textHtml);
        }
        showToast('✅ 已插入编辑框（历史记录已保留）');
        return;
      }
    } catch (_) {}

    // ── Strategy 4: Generic textarea / contenteditable ────────────────────────
    try {
      const panelIds = ['ai-mail-panel', 'ai-mail-instruction', 'ai-mail-result-text'];
      const allEditable = [
        ...document.querySelectorAll('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]')
      ].filter(el => {
        if (el.readOnly || el.disabled) return false;
        if (panelIds.some(id => el.closest('#' + id))) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 100 && rect.height > 40;
      });

      const focused = allEditable.find(el => el === document.activeElement);
      const target = focused || allEditable.sort((a, b) =>
        b.getBoundingClientRect().height - a.getBoundingClientRect().height
      )[0];

      if (target) {
        target.focus();
        if (target.tagName === 'TEXTAREA') {
          // For plain textarea: prepend new reply, keep existing content below
          const existing = target.value;
          const sep = existing.trim() ? '\n\n--------------------------------------------------\n\n' : '';
          target.value = text + sep + existing;
          target.setSelectionRange(0, 0); // cursor to top
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          // contenteditable: insert at top
          const existing = target.innerHTML;
          const hasHistory = target.innerText.trim().length > 0;
          target.innerHTML = textHtml + (hasHistory ? SEPARATOR + existing : '');
        }
        showToast('✅ 已插入编辑框（历史记录已保留）');
        return;
      }
    } catch (_) {}

    // ── Fallback: copy to clipboard ───────────────────────────────────────────
    navigator.clipboard.writeText(text).then(() =>
      showToast('📋 未找到编辑框，已复制到剪贴板，请手动粘贴')
    );
  });

  // ─── Settings ────────────────────────────────────────────────────────────────
  function loadSettings() {
    if (!isExtensionAlive()) return;
    chrome.storage.local.get(['settings', 'customSkills', 'customAnalyzeSkills'], data => {
      settings = data.settings || {};
      customSkills = data.customSkills || [];
      customAnalyzeSkills = data.customAnalyzeSkills || [];
      // Populate settings fields
      if (settings.claudeKey) document.getElementById('setting-claude-key').value = settings.claudeKey;
      document.getElementById('setting-claude-model').value = settings.claudeModel || 'claude-sonnet-4-6';
      if (settings.openaiKey) document.getElementById('setting-openai-key').value = settings.openaiKey;
      document.getElementById('setting-openai-model').value = settings.openaiModel || 'gpt-4o';
      if (settings.deepseekKey) document.getElementById('setting-deepseek-key').value = settings.deepseekKey;
      document.getElementById('setting-deepseek-model').value = settings.deepseekModel || 'deepseek-flash';
      if (settings.geminiKey) document.getElementById('setting-gemini-key').value = settings.geminiKey;
      document.getElementById('setting-gemini-model').value = settings.geminiModel || 'gemini-1.5-pro';
      if (settings.glmKey) document.getElementById('setting-glm-key').value = settings.glmKey;
      document.getElementById('setting-glm-model').value = settings.glmModel || 'glm-4-flash';
      renderSkillList();
      renderAnalyzeSkillList();
      renderSavedSkills();
      renderProviderButtons();
    });
  }

  // ─── Provider button visibility ───────────────────────────────────────────
  const PROVIDER_KEY_MAP = {
    claude:   'claudeKey',
    openai:   'openaiKey',
    deepseek: 'deepseekKey',
    gemini:   'geminiKey',
    glm:      'glmKey',
  };

  function renderProviderButtons() {
    const btns = document.querySelectorAll('.ai-mail-provider-btn');
    let firstConfigured = null;
    let currentStillVisible = false;

    btns.forEach(btn => {
      const provider = btn.dataset.provider;
      const hasKey = !!(settings[PROVIDER_KEY_MAP[provider]]);
      btn.style.display = hasKey ? '' : 'none';
      if (hasKey) {
        if (!firstConfigured) firstConfigured = provider;
        if (provider === currentProvider) currentStillVisible = true;
      }
    });

    // If current provider lost its key, switch to first configured one.
    if (!currentStillVisible && firstConfigured) {
      currentProvider = firstConfigured;
      btns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.provider === currentProvider);
      });
    }
  }

  document.getElementById('save-settings-btn').addEventListener('click', () => {
    settings = {
      claudeKey: document.getElementById('setting-claude-key').value.trim(),
      claudeModel: document.getElementById('setting-claude-model').value.trim(),
      openaiKey: document.getElementById('setting-openai-key').value.trim(),
      openaiModel: document.getElementById('setting-openai-model').value.trim(),
      deepseekKey: document.getElementById('setting-deepseek-key').value.trim(),
      deepseekModel: document.getElementById('setting-deepseek-model').value.trim(),
      geminiKey: document.getElementById('setting-gemini-key').value.trim(),
      geminiModel: document.getElementById('setting-gemini-model').value.trim(),
      glmKey: document.getElementById('setting-glm-key').value.trim(),
      glmModel: document.getElementById('setting-glm-model').value.trim(),
    };
    if (!isExtensionAlive()) { showToast('❌ 插件上下文失效，请刷新页面'); return; }
    chrome.storage.local.set({ settings }, () => {
      showToast('✅ 设置已保存');
      renderProviderButtons();
    });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function showError(msg) {
    const el = document.getElementById('ai-mail-error');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function showErrorWithAction(msg, btnLabel, onClick) {
    const el = document.getElementById('ai-mail-error');
    el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg + ' ';
    const btn = document.createElement('button');
    btn.textContent = btnLabel;
    btn.style.cssText = 'margin-left:6px;padding:2px 10px;font-size:12px;cursor:pointer;border-radius:4px;border:1px solid currentColor;background:transparent;color:inherit;';
    btn.addEventListener('click', onClick);
    el.appendChild(span);
    el.appendChild(btn);
    el.style.display = 'block';
  }

  function clearError() {
    const el = document.getElementById('ai-mail-error');
    el.textContent = '';
    el.style.display = 'none';
  }

  function showAnalyzeError(msg) {
    const el = document.getElementById('ai-mail-analyze-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function clearAnalyzeError() {
    const el = document.getElementById('ai-mail-analyze-error');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
  }

  function setLoading(loading) {
    const btn = document.getElementById('ai-mail-generate-btn');
    const text = document.getElementById('generate-btn-text');
    btn.disabled = loading;
    if (loading) {
      text.innerHTML = '<div class="ai-mail-spinner"></div> 生成中...';
    } else {
      text.innerHTML = '✦ 生成回复';
    }

    const regenBtn = document.getElementById('ai-mail-regen-btn');
    const copyBtn = document.getElementById('ai-mail-copy-btn');
    const insertBtn = document.getElementById('ai-mail-insert-btn');
    const refineBtn = document.getElementById('ai-mail-refine-btn');
    regenBtn.disabled = loading;
    copyBtn.disabled = loading;
    insertBtn.disabled = loading;
    refineBtn.disabled = loading;
    regenBtn.innerHTML = loading
      ? '<div class="ai-mail-spinner"></div> 生成中...'
      : '↺ 重新生成';
  }

  function setAnalyzeLoading(loading) {
    const btn = document.getElementById('ai-mail-analyze-btn');
    const text = document.getElementById('analyze-btn-text');
    btn.disabled = loading;
    if (loading) {
      text.innerHTML = '<div class="ai-mail-spinner"></div>';
    } else {
      text.innerHTML = '🔍 分析';
    }
  }

  function showError(msg) {
    const el = document.getElementById('ai-mail-error');
    el.textContent = msg;
    el.classList.add('visible');
  }

  function clearError() {
    document.getElementById('ai-mail-error').classList.remove('visible');
  }

  function showToast(msg) {
    const old = document.querySelector('.ai-mail-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'ai-mail-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  loadSettings();
  } // end init()
})();
