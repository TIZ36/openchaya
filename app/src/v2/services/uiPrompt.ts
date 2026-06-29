/* uiPrompt —— 应用内输入弹框（替代 window.prompt）。
 *
 * Electron 渲染进程**不支持 window.prompt**（永远返回 null），导致所有用它取输入的动作
 * （修订/否决/升格短语…）静默失效。这里用纯 DOM 自建一个，返回 Promise<string|null>，
 * 不依赖 React root，随处可 await。window.alert/confirm 在 Electron 可用，无需替换。 */

export function uiPrompt(
  message: string,
  defaultValue = '',
  opts: { multiline?: boolean; placeholder?: string; okText?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'v2-uiprompt-scrim';
    const box = document.createElement('div');
    box.className = 'v2-uiprompt';
    const msg = document.createElement('div');
    msg.className = 'v2-uiprompt-msg';
    msg.textContent = message;
    const field = document.createElement(opts.multiline ? 'textarea' : 'input') as HTMLInputElement & HTMLTextAreaElement;
    field.className = 'v2-uiprompt-field';
    field.value = defaultValue;
    if (opts.placeholder) field.placeholder = opts.placeholder;
    if (opts.multiline) field.rows = 6;
    const foot = document.createElement('div');
    foot.className = 'v2-uiprompt-foot';
    const cancel = document.createElement('button');
    cancel.className = 'v2-uiprompt-btn';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'v2-uiprompt-btn primary';
    ok.textContent = opts.okText || '确定';
    foot.append(cancel, ok);
    box.append(msg, field, foot);
    scrim.append(box);
    document.body.append(scrim);

    const done = (v: string | null) => {
      window.removeEventListener('keydown', onKey, true);
      try { document.body.removeChild(scrim); } catch { /* */ }
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      // 单行：Enter 提交；多行：Cmd/Ctrl+Enter 提交。
      else if (e.key === 'Enter' && (!opts.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); done(field.value); }
    };
    cancel.onclick = () => done(null);
    ok.onclick = () => done(field.value);
    scrim.onmousedown = (e) => { if (e.target === scrim) done(null); };
    window.addEventListener('keydown', onKey, true);
    setTimeout(() => { field.focus(); if (!opts.multiline) field.select(); }, 30);
  });
}
