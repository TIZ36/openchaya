/* ------------------------------------------------------------------ *
 * 登录终端浮层 —— 给 claude/copilot/gemini 这类需交互式 OAuth/设备码的 CLI
 * 一个主题化的内嵌「终端」。后端用系统 `script` 给命令分配真 pty（见 localAgent.cjs
 * loginStart），这里只负责：流式渲染输出、转发键入(stdin)、捕获 URL 方便点开浏览器。
 * 用户完成授权后点「完成」→ 回调重探模型。门控：fixed 浮层 portal 进 body，避开
 * backdrop-filter 容器嵌套坑（见 memory chaya_fixed_modal_in_glass_box）。
 * ------------------------------------------------------------------ */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { localAgent, type ProviderId, type LoginEvent } from './services/localAgent';
import { ProviderLogo, PROVIDER_LABELS } from './LocalAgentView';

/** pty 原始输出 → 可读纯文本：剥掉 ANSI 转义/OSC/控制字符，并按行处理裸 \r 的「回到行首覆盖」
 *  语义（spinner 常用 \r 重画同一行）——取每行最后一个 \r 之后的内容，避免一堆残影堆叠。
 *  不追求完整终端仿真：登录类输出（URL/设备码/进度）足够清晰即可。 */
function renderTerminal(raw: string): string {
  const noAnsi = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ... BEL/ST
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')           // CSI（颜色/光标移动等）
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => (c === '\r' ? '\r' : ''));
  return noAnsi.split('\n').map((line) => {
    const i = line.lastIndexOf('\r');
    return i >= 0 ? line.slice(i + 1) : line;
  }).join('\n');
}

const URL_RE = /https?:\/\/[^\s'"]+/g;

export function LoginTerminal({ provider, onClose, onDone }: {
  provider: ProviderId;
  onClose: () => void;
  onDone: () => void;   // 登录完成 → 让上层重探模型
}) {
  const { t: tr } = useI18n();
  const [buf, setBuf] = useState('');
  const [exited, setExited] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const outRef = useRef<HTMLPreElement | null>(null);
  const label = PROVIDER_LABELS[provider] || provider;

  // 起 pty + 订阅输出。
  useEffect(() => {
    let alive = true;
    let off = () => {};
    void localAgent.loginStart(provider, 100, 30).then((r) => {
      if (!alive) { if (r.ok && r.id) void localAgent.loginKill(r.id); return; }
      if (!r.ok || !r.id) { setErr(r.error || tr('local.login.startFailed')); return; }
      idRef.current = r.id;
      off = localAgent.onLogin((ev: LoginEvent) => {
        if (ev.id !== r.id) return;
        if (ev.type === 'data' && ev.data) setBuf((b) => (b + ev.data!).slice(-20000));   // 留近 20K
        if (ev.type === 'exit') { setExited(ev.code ?? 0); if (ev.error) setErr(ev.error); }
      });
    });
    return () => { alive = false; off(); const id = idRef.current; if (id) void localAgent.loginKill(id); };
  }, [provider, tr]);

  // 自动滚到底。
  useEffect(() => { const el = outRef.current; if (el) el.scrollTop = el.scrollHeight; }, [buf]);

  const text = renderTerminal(buf);
  const urls = Array.from(new Set(text.match(URL_RE) || []));

  // 键入转发 stdin（pty 同款字节）。
  const send = useCallback((data: string) => { const id = idRef.current; if (id) void localAgent.loginInput(id, data); }, []);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (exited != null) return;
    if (e.metaKey || (e.ctrlKey && e.key.toLowerCase() === 'v')) return;   // 放行复制粘贴
    let bytes: string | null = null;
    if (e.key === 'Enter') bytes = '\r';
    else if (e.key === 'Backspace') bytes = '\x7f';
    else if (e.key === 'Tab') bytes = '\t';
    else if (e.key === 'Escape') bytes = '\x1b';
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') bytes = '\x03';
    else if (e.key.length === 1 && !e.ctrlKey) bytes = e.key;
    if (bytes != null) { e.preventDefault(); send(bytes); }
  }, [exited, send]);

  const cancel = useCallback(() => { const id = idRef.current; if (id) void localAgent.loginKill(id); onClose(); }, [onClose]);
  const done = useCallback(() => { const id = idRef.current; if (id) void localAgent.loginKill(id); onDone(); onClose(); }, [onClose, onDone]);

  // portal 进 .chaya-v2 根（而非 document.body）—— 样式都挂在 .chaya-v2 作用域下，
  // 挂到 body 会让弹框失去全部样式、裸着掉到页面底部。
  const host: Element = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  return createPortal(
    <div className="v2-login-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className="v2-login" role="dialog" aria-modal="true">
        <div className="v2-login-hd">
          <ProviderLogo id={provider} />
          <span className="ttl">{tr('local.login.title', { provider: label })}</span>
          <button className="x" onClick={cancel} aria-label={tr('common.close')}>✕</button>
        </div>
        <div className="v2-login-sub">{tr('local.login.hint')}</div>

        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <pre ref={outRef} className="v2-login-out" tabIndex={0} onKeyDown={onKeyDown}>
          {text || (err ? '' : tr('local.login.connecting'))}
          {exited == null && <span className="v2-caret">▋</span>}
        </pre>

        {urls.length > 0 && (
          <div className="v2-login-urls">
            {urls.slice(0, 3).map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="v2-login-url">{tr('local.login.openUrl')} ↗</a>
            ))}
          </div>
        )}

        {err && <div className="v2-login-err">{err}</div>}
        {exited != null && <div className="v2-login-exited">{tr('local.login.exited', { code: String(exited) })}</div>}

        <div className="v2-login-ft">
          <button className="v2-set-btn" onClick={() => send('\r')} disabled={exited != null}>↵ {tr('local.login.enter')}</button>
          <span style={{ flex: 1 }} />
          <button className="v2-set-btn" onClick={cancel}>{tr('common.cancel')}</button>
          <button className="v2-set-btn primary" onClick={done}>{tr('local.login.done')}</button>
        </div>
      </div>
    </div>,
    host,
  );
}
