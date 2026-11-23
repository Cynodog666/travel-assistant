'use strict';

/**
 * 坤坤前端：令牌管理 + SSE 流式对话 + 导出。
 *
 * 说明：
 *   - 所有接口都走 /api 前缀，统一由 apiFetch() 带 Authorization 头；
 *   - 服务器开了访问保护时，首次进入会要求输入 ACCESS_TOKEN（存在 localStorage）；
 *   - 接口返回 401/403 时重新要一次令牌，只重试一遍，避免死循环。
 */

(function () {
  const API_BASE = '/api';
  const TOKEN_KEY = 'travelAccessToken';
  const SESSION_KEY = 'chatSessionId';

  // ---------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------
  let accessToken = localStorage.getItem(TOKEN_KEY) || '';
  let sessionId = localStorage.getItem(SESSION_KEY) || null;
  let gateResolver = null;

  let chatHistory = [];
  let htmlCodeHistory = [];
  let streaming = false;

  const els = {};

  // 欢迎语：HTML 版本用于气泡，纯文本版本用于导出 .txt。
  // 注意：单行拼接，不能有换行和缩进——气泡用了 pre-wrap，源码空白会被原样渲染。
  const WELCOME_HTML =
    '你好！我是坤坤，你的专属旅游管家！<br><br>我可以帮你：<br>' +
    '• 查询景点信息和旅游攻略<br>' +
    '• 地址转坐标：地址：北京市朝阳区天安门<br>' +
    '• 坐标转地址：坐标：116.403874,39.914885<br>' +
    '• 地点搜索：搜索：上海外滩附近酒店<br>' +
    '• 路线规划：从：天安门到：故宫<br>' +
    '• 实时天气：长沙今天天气怎么样';

  const WELCOME_TEXT = WELCOME_HTML.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '');

  // ---------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------
  function showToast(message) {
    const toast = els.toast;
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function showTokenError(message) {
    if (els.tokenError) els.tokenError.textContent = message || '';
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 极简 Markdown：粗体 + 列表符号，换行交给 CSS 的 pre-wrap。
  // 另外把裸链接变成可点的 <a>：路线工具会返回 amapuri:// 深链和 H5 链接，
  // 不 linkify 的话在手机上也点不动。
  function renderMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^[ \t]*[-*•][ \t]+/gm, '• ');
    html = html.replace(
      /(amapuri:\/\/[^\s<"）)]+|https?:\/\/[^\s<"）)]+)/g,
      (url) =>
        '<a class="inline-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
        (url.length > 56 ? url.slice(0, 56) + '…' : url) +
        '</a>'
    );

    // 地图图片：map_image 工具返回的是 /api/staticmap?...&sig=... 这种相对地址，
    // 上面 linkify 的正则只认 http(s)/amapuri，不会误伤它。
    html = html.replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (match, alt, src) => '<img class="chat-map" src="' + src + '" alt="' + alt + '" loading="lazy">'
    );

    return html;
  }

  // 提取模型输出的完整 HTML 规划表（从 <!DOCTYPE html> 到 </html>）
  function extractHtmlCode(text) {
    const startTag = '<!DOCTYPE html>';
    const endTag = '</html>';
    const startIndex = text.indexOf(startTag);
    const endIndex = text.lastIndexOf(endTag);
    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      return text.substring(startIndex, endIndex + endTag.length);
    }
    return null;
  }

  function timestampForFile() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 立刻 revoke 在部分浏览器上会打断下载，挪到下一轮事件循环
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------
  // 令牌
  // ---------------------------------------------------------------------
  function askAccessToken(reason) {
    return new Promise((resolve) => {
      gateResolver = resolve;
      els.tokenGate.style.display = 'flex';
      els.tokenInput.value = '';
      showTokenError(reason || '');
      setTimeout(() => els.tokenInput.focus(), 50);
    });
  }

  function submitAccessToken() {
    const value = els.tokenInput.value.trim();
    if (!value) {
      showTokenError('令牌不能为空');
      return;
    }
    accessToken = value;
    localStorage.setItem(TOKEN_KEY, value);
    els.tokenGate.style.display = 'none';
    showTokenError('');
    if (gateResolver) {
      const resolve = gateResolver;
      gateResolver = null;
      resolve();
    }
  }

  /** 统一请求入口：带令牌；401/403 时重新要令牌并只重试一次。 */
  async function apiFetch(path, options = {}, retried = false) {
    const headers = Object.assign({}, options.headers || {});
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;

    const response = await fetch(API_BASE + path, Object.assign({}, options, { headers }));

    if ((response.status === 401 || response.status === 403) && !retried) {
      localStorage.removeItem(TOKEN_KEY);
      accessToken = '';
      await askAccessToken(
        response.status === 403 ? '令牌不正确，请重新输入' : '这台服务器需要访问令牌'
      );
      return apiFetch(path, options, true);
    }
    return response;
  }

  /** 启动时问一次服务器：开没开访问保护。开了且本地没令牌就先让人填。 */
  async function ensureAuth() {
    try {
      const response = await fetch(API_BASE + '/health');
      const info = await response.json();
      if (info && info.authRequired && !accessToken) {
        await askAccessToken('这台服务器开启了访问保护，请输入部署时设置的 ACCESS_TOKEN');
      }
    } catch (error) {
      // 健康检查失败不影响使用，真正发消息时会再要令牌
    }
  }

  // ---------------------------------------------------------------------
  // 界面
  // ---------------------------------------------------------------------
  function appendBubble(text, isUser) {
    const div = document.createElement('div');
    div.className = isUser ? 'user-message message' : 'ai-message message';
    div.textContent = text;
    els.chatContainer.appendChild(div);
    els.chatContainer.scrollTop = els.chatContainer.scrollHeight;
    return div;
  }

  function resetWelcome() {
    els.chatContainer.innerHTML = '<div class="ai-message message" id="welcome-message"></div>';
    els.welcomeMessage = document.getElementById('welcome-message');
    els.welcomeMessage.innerHTML = WELCOME_HTML;
  }

  function setBusy(busy) {
    streaming = busy;
    els.sendButton.disabled = busy;
    els.clearButton.disabled = busy;
    els.sendButton.textContent = busy ? '思考中…' : '发送';
  }

  // ---------------------------------------------------------------------
  // 发送消息
  // ---------------------------------------------------------------------
  async function sendMessage() {
    if (streaming) return;

    const text = els.messageInput.value.trim();
    if (!text) return;

    appendBubble(text, true);
    chatHistory.push('用户: ' + text);
    els.messageInput.value = '';
    els.messageInput.style.height = 'auto';
    setBusy(true);

    // 占位气泡，收到第一个 delta 开始替换
    const bubble = appendBubble('正在思考…', false);
    let acc = '';
    let failed = false;

    try {
      const response = await apiFetch('/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId }),
      });

      if (!response.ok || !response.body) {
        throw new Error('HTTP ' + response.status);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();

        for (const chunk of chunks) {
          const eventLine = chunk.match(/^event:\s*(.+)$/m);
          const dataLine = chunk.match(/^data:\s*(.+)$/m);
          if (!eventLine || !dataLine) continue;

          const event = eventLine[1].trim();
          let payload;
          try {
            payload = JSON.parse(dataLine[1]);
          } catch {
            continue;
          }

          if (event === 'session') {
            if (payload.sessionId && !sessionId) {
              sessionId = payload.sessionId;
              localStorage.setItem(SESSION_KEY, sessionId);
            }
          } else if (event === 'delta') {
            acc += payload.content || '';
            bubble.innerHTML = renderMarkdown(acc);
            els.chatContainer.scrollTop = els.chatContainer.scrollHeight;
          } else if (event === 'done') {
            // 以 done 的完整内容为准：万一某些分片丢了，这里还能补回来
            if (!acc && payload.content) {
              acc = payload.content;
              bubble.innerHTML = renderMarkdown(acc);
            }
          } else if (event === 'error') {
            failed = true;
            bubble.textContent = '出错了：' + (payload.message || '未知错误');
          }
        }
      }
    } catch (error) {
      failed = true;
      bubble.textContent = '请求失败: ' + error.message;
    } finally {
      setBusy(false);
    }

    if (failed) return;
    if (!acc) {
      bubble.textContent = '（没有收到内容，稍后再试一次）';
      return;
    }

    // 若返回的是完整 HTML 规划表，气泡里换成提示，原文存进待导出队列
    const htmlCode = extractHtmlCode(acc);
    if (htmlCode) {
      htmlCodeHistory.push({
        code: htmlCode,
        timestamp: new Date().toLocaleString(),
        type: 'AI',
      });
      bubble.textContent = '已生成旅行规划表（HTML），点击「保存记录」下载。';
      chatHistory.push('AI: 已生成旅行规划表（HTML）');
    } else {
      chatHistory.push('AI: ' + acc);
    }
  }

  // ---------------------------------------------------------------------
  // 保存 / 清空
  // ---------------------------------------------------------------------
  function saveChatHistory() {
    if (htmlCodeHistory.length > 0) {
      const latest = htmlCodeHistory[htmlCodeHistory.length - 1].code;
      download(`坤坤-行程单-${timestampForFile()}.html`, latest, 'text/html;charset=utf-8');
      showToast('行程单已下载（.html）');
      return;
    }

    if (chatHistory.length === 0) {
      showToast('还没有可保存的聊天记录');
      return;
    }
    download(`坤坤-聊天记录-${timestampForFile()}.txt`, chatHistory.join('\n\n'), 'text/plain;charset=utf-8');
    showToast('聊天记录已下载（.txt）');
  }

  async function clearHistory() {
    // 关键：先记下自己的 id 再清空本地变量，否则会拿到 null 去请求
    const targetSessionId = sessionId;

    resetWelcome();
    chatHistory = ['AI: ' + WELCOME_TEXT];
    htmlCodeHistory = [];
    sessionId = null;
    localStorage.removeItem(SESSION_KEY);

    if (targetSessionId) {
      try {
        await apiFetch('/clear-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: targetSessionId }),
        });
      } catch (error) {
        // 清不掉服务器上的历史不影响本地使用，下一轮换个新会话即可
      }
    }
    showToast('对话已清空');
  }

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------
  function bindEvents() {
    els.sendButton.addEventListener('click', sendMessage);
    els.clearButton.addEventListener('click', clearHistory);
    els.saveButton.addEventListener('click', saveChatHistory);
    els.tokenSubmit.addEventListener('click', submitAccessToken);
    els.tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAccessToken();
    });

    els.messageInput.addEventListener('input', () => {
      els.messageInput.style.height = 'auto';
      els.messageInput.style.height = Math.min(els.messageInput.scrollHeight, 200) + 'px';
    });

    els.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  function boot() {
    els.toast = document.getElementById('toast');
    els.tokenGate = document.getElementById('token-gate');
    els.tokenInput = document.getElementById('token-input');
    els.tokenError = document.getElementById('token-error');
    els.tokenSubmit = document.getElementById('token-submit');

    els.splash = document.getElementById('splash-screen');
    els.main = document.getElementById('main-container');
    els.chatContainer = document.getElementById('chat-container');
    els.messageInput = document.getElementById('message-input');
    els.sendButton = document.getElementById('send-button');
    els.clearButton = document.getElementById('clear-button');
    els.saveButton = document.getElementById('save-button');

    els.welcomeMessage = document.getElementById('welcome-message');
    els.welcomeMessage.innerHTML = WELCOME_HTML;
    chatHistory.push('AI: ' + WELCOME_TEXT);

    bindEvents();
    ensureAuth();

    // 启动动画：1.2s 停留 + 0.8s 淡出
    setTimeout(() => {
      els.splash.style.opacity = '0';
      els.splash.style.transition = 'opacity 0.8s ease-out';
      setTimeout(() => {
        els.splash.style.display = 'none';
        els.main.style.display = 'flex';
      }, 600);
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
