/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Young Serif"', '"LXGW WenKai"', 'ui-serif', 'Georgia', 'serif'],
        sans: ['"Commissioner"', '"LXGW WenKai"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        paper: 'var(--paper)',
        page: 'var(--page)',
        ink: 'var(--ink)',
        pencil: 'var(--pencil)',
        rule: 'var(--rule)',
        'rule-strong': 'var(--rule-strong)',
        accent: 'var(--accent-ink)',
        marginalia: 'var(--marginalia)',
      },
    },
  },
  plugins: [],
};
