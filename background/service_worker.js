// Background service worker - handles AI API calls

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CALL_AI') {
    callAI(request.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async
  }
});

async function callAI({ provider, apiKey, model, systemPrompt, messages }) {
  try {
    if (provider === 'claude') {
      return await callClaude(apiKey, model, systemPrompt, messages);
    } else if (provider === 'openai') {
      return await callOpenAI(apiKey, model, systemPrompt, messages);
    } else if (provider === 'deepseek') {
      return await callDeepSeek(apiKey, model, systemPrompt, messages);
    } else if (provider === 'gemini') {
      return await callGemini(apiKey, model, systemPrompt, messages);
    } else if (provider === 'glm') {
      return await callGLM(apiKey, model, systemPrompt, messages);
    } else {
      throw new Error('未知的 AI 服务商');
    }
  } catch (e) {
    return { error: e.message };
  }
}

async function callClaude(apiKey, model, systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { text: data.content[0].text };
}

async function callOpenAI(apiKey, model, systemPrompt, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { text: data.choices[0].message.content };
}

async function callDeepSeek(apiKey, model, systemPrompt, messages) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'deepseek-flash',
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { text: data.choices[0].message.content };
}

async function callGLM(apiKey, model, systemPrompt, messages) {
  // 智谱 GLM 使用 JWT 鉴权：apiKey 格式为 "id.secret"
  const token = await generateGLMToken(apiKey);
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      model: model || 'glm-4-flash',
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { text: data.choices[0].message.content };
}

// GLM JWT token generator (HS256, browser-compatible via SubtleCrypto)
async function generateGLMToken(apiKey) {
  const parts = apiKey.split('.');
  if (parts.length !== 2) throw new Error('GLM API Key 格式错误，应为 id.secret');
  const [id, secret] = parts;
  const header = btoa(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify({ api_key: id, exp: Date.now() + 3600000, timestamp: Date.now() })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sigB64}`;
}

async function callGemini(apiKey, model, systemPrompt, messages) {
  const modelName = model || 'gemini-1.5-pro';
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { text: data.candidates[0].content.parts[0].text };
}
