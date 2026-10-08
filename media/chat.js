// @ts-nocheck
/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const queue = document.getElementById('queue');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const stop = document.getElementById('stop');
  let live = null;            // the assistant bubble currently being painted

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const scroll = (was) => { if (was) log.scrollTop = log.scrollHeight; };

  function bubble(cls, who) {
    const was = atBottom();
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    if (who) { const h = document.createElement('div'); h.className = 'who'; h.textContent = who; el.appendChild(h); }
    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    log.appendChild(el);
    scroll(was);
    return { el, body };
  }

  function flat(cls, text) {
    const was = atBottom();
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    scroll(was);
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
    input.style.height = 'auto';
    input.focus();
  }

  document.getElementById('bar').addEventListener('submit', e => { e.preventDefault(); submit(); });
  document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'new' }));
  stop.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  // Enter sends, Shift+Enter breaks the line. Typing while a reply streams is fine: it queues.
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 320) + 'px'; });

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'user') { bubble('user').body.textContent = m.text; }
    else if (m.type === 'queue') {
      queue.replaceChildren();
      (m.items || []).forEach(t => { const d = document.createElement('div'); d.className = 'qitem'; d.textContent = t; queue.appendChild(d); });
      queue.hidden = !(m.items || []).length;
    }
    else if (m.type === 'start') {
      live = bubble('assistant', m.worker);
      live.body.innerHTML = '<span class="dots"></span>';
      live.painted = '';
      if (m.replayed) flat('notice', `${m.worker} was given the conversation so far.`);
      stop.hidden = false; send.disabled = true;
    }
    else if (m.type === 'restart') {
      if (live) { live.painted = ''; live.body.innerHTML = '<span class="dots"></span>';
                  live.el.querySelector('.who').textContent = m.worker; }
    }
    else if (m.type === 'delta' && live) {
      const was = atBottom();
      live.painted = (live.painted || '') + m.text;
      live.body.innerHTML = renderMarkdown(live.painted);
      scroll(was);
    }
    else if (m.type === 'done') {
      if (!live) live = bubble('assistant', m.worker);
      live.el.querySelector('.who').textContent = m.worker;
      live.body.innerHTML = renderMarkdown(m.text || '(no answer)');
      if (m.tokens) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${m.tokens.input ?? '?'} in / ${m.tokens.output ?? '?'} out`;
        live.el.appendChild(meta);
      }
      live = null;
    }
    else if (m.type === 'notice') flat('notice', m.text);
    else if (m.type === 'error') { flat('error', m.text); live = null; }
    else if (m.type === 'idle') { stop.hidden = true; send.disabled = false; }
    else if (m.type === 'reset') { log.replaceChildren(); queue.replaceChildren(); queue.hidden = true; live = null; }
    else if (m.type === 'restore') {
      log.replaceChildren();
      (m.turns || []).forEach(t => {
        const b = bubble(t.role === 'user' ? 'user' : 'assistant', t.role === 'user' ? undefined : (t.worker || 'assistant'));
        if (t.role === 'user') {
          b.body.textContent = t.text;
        } else {
          b.body.innerHTML = renderMarkdown(t.text);
        }
      });
    }
  });

  function renderMarkdown(text) {
    if (!text) return '';
    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    escaped = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const languageLabel = lang ? `<span class="code-lang">${lang}</span>` : '';
      return `<div class="code-block">
        <div class="code-header">${languageLabel}<button class="copy-btn" data-code="${encodeURIComponent(code)}">Copy</button></div>
        <pre><code>${code}</code></pre>
      </div>`;
    });

    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    escaped = escaped.replace(/\n/g, '<br>');
    return escaped;
  }

  document.addEventListener('click', e => {
    if (e.target && e.target.classList.contains('copy-btn')) {
      const raw = decodeURIComponent(e.target.getAttribute('data-code') || '');
      navigator.clipboard.writeText(raw).then(() => {
        e.target.textContent = 'Copied!';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
      });
    }
  });

  vscode.postMessage({ type: 'ready' });
  input.focus();
})();
