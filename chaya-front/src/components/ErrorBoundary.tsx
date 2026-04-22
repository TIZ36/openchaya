import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error?: Error; }

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={title}>出现错误</h1>
          <p style={msg}>{this.state.error?.message || '未知错误'}</p>
          <button
            type="button"
            style={btn}
            onClick={() => {
              this.setState({ hasError: false, error: undefined });
              window.location.reload();
            }}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

const wrap: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: '100vh', background: 'var(--paper)', color: 'var(--ink)',
  fontFamily: 'var(--font-sans)',
};
const card: React.CSSProperties = { textAlign: 'center', padding: 32, maxWidth: 520 };
const title: React.CSSProperties = {
  fontFamily: 'var(--font-display)', fontSize: 28, margin: '0 0 12px',
  color: 'var(--ink-strong)',
};
const msg: React.CSSProperties = { color: 'var(--pencil)', margin: '0 0 20px' };
const btn: React.CSSProperties = {
  padding: '10px 20px', fontFamily: 'var(--font-mono)', fontSize: 13,
  color: 'var(--paper)', background: 'var(--accent-ink)',
  border: '1px solid var(--accent-ink)', borderRadius: 2, cursor: 'pointer',
};

export default ErrorBoundary;
