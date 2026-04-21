/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        display: ['"Young Serif"', '"LXGW WenKai"', 'ui-serif', 'Georgia', 'serif'],
        sans: ['"Commissioner"', '"LXGW WenKai"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // shadcn/ui token passthroughs (driven by CSS variables in index.css)
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: 'hsl(var(--card))',
        'card-foreground': 'hsl(var(--card-foreground))',
        popover: 'hsl(var(--popover))',
        'popover-foreground': 'hsl(var(--popover-foreground))',
        primaryToken: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondaryToken: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        mutedToken: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accentToken: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructiveToken: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        borderToken: 'hsl(var(--border))',
        inputToken: 'hsl(var(--input))',
        ringToken: 'hsl(var(--ring))',

        // Letterpress palette — named semantically, not by shade.
        // Values live in index.css :root as OKLCH; Tailwind just references them.
        paper: 'var(--paper)',
        page: 'var(--page)',
        ink: 'var(--ink)',
        pencil: 'var(--pencil)',
        rule: 'var(--rule)',
        'rule-strong': 'var(--rule-strong)',
        accent: 'var(--accent-ink)',
        'accent-soft': 'var(--accent-soft)',
        marginalia: 'var(--marginalia)',

        // Ramps kept for backward compatibility with components still using `primary-500`, etc.
        // All retuned toward letterpress hues — muted, paper-friendly, never neon.
        // `/ <alpha-value>` enables Tailwind's `/40` opacity modifier on every shade.
        gray: {
          50:  'oklch(0.985 0.003 310 / <alpha-value>)',
          100: 'oklch(0.965 0.004 310 / <alpha-value>)',
          200: 'oklch(0.925 0.006 310 / <alpha-value>)',
          300: 'oklch(0.870 0.008 310 / <alpha-value>)',
          400: 'oklch(0.720 0.010 310 / <alpha-value>)',
          500: 'oklch(0.570 0.012 310 / <alpha-value>)',
          600: 'oklch(0.450 0.014 310 / <alpha-value>)',
          700: 'oklch(0.330 0.016 310 / <alpha-value>)',
          800: 'oklch(0.240 0.018 310 / <alpha-value>)',
          900: 'oklch(0.180 0.018 310 / <alpha-value>)',
          950: 'oklch(0.130 0.016 310 / <alpha-value>)',
        },
        // primary → aubergine ink (was indigo/purple neon)
        primary: {
          50:  'oklch(0.975 0.008 310 / <alpha-value>)',
          100: 'oklch(0.955 0.016 310 / <alpha-value>)',
          200: 'oklch(0.910 0.030 310 / <alpha-value>)',
          300: 'oklch(0.820 0.055 310 / <alpha-value>)',
          400: 'oklch(0.660 0.090 310 / <alpha-value>)',
          500: 'oklch(0.500 0.115 310 / <alpha-value>)',
          600: 'oklch(0.400 0.120 310 / <alpha-value>)',
          700: 'oklch(0.330 0.120 310 / <alpha-value>)',
          800: 'oklch(0.260 0.110 310 / <alpha-value>)',
          900: 'oklch(0.200 0.090 310 / <alpha-value>)',
          950: 'oklch(0.160 0.070 310 / <alpha-value>)',
        },
        // success → muted sage (was kelly green)
        success: {
          50:  'oklch(0.975 0.015 155 / <alpha-value>)',
          100: 'oklch(0.950 0.028 155 / <alpha-value>)',
          200: 'oklch(0.900 0.045 155 / <alpha-value>)',
          300: 'oklch(0.820 0.065 155 / <alpha-value>)',
          400: 'oklch(0.700 0.080 155 / <alpha-value>)',
          500: 'oklch(0.570 0.090 155 / <alpha-value>)',
          600: 'oklch(0.480 0.085 155 / <alpha-value>)',
          700: 'oklch(0.400 0.075 155 / <alpha-value>)',
          800: 'oklch(0.320 0.060 155 / <alpha-value>)',
          900: 'oklch(0.250 0.045 155 / <alpha-value>)',
          950: 'oklch(0.180 0.030 155 / <alpha-value>)',
        },
        // warning → ochre (was saturated amber)
        warning: {
          50:  'oklch(0.980 0.015 75 / <alpha-value>)',
          100: 'oklch(0.955 0.035 75 / <alpha-value>)',
          200: 'oklch(0.910 0.065 75 / <alpha-value>)',
          300: 'oklch(0.840 0.100 75 / <alpha-value>)',
          400: 'oklch(0.740 0.120 75 / <alpha-value>)',
          500: 'oklch(0.640 0.120 75 / <alpha-value>)',
          600: 'oklch(0.540 0.110 75 / <alpha-value>)',
          700: 'oklch(0.450 0.095 75 / <alpha-value>)',
          800: 'oklch(0.360 0.075 75 / <alpha-value>)',
          900: 'oklch(0.280 0.060 75 / <alpha-value>)',
          950: 'oklch(0.200 0.040 75 / <alpha-value>)',
        },
        // error → muted brick (was fire-engine red)
        error: {
          50:  'oklch(0.975 0.012 25 / <alpha-value>)',
          100: 'oklch(0.950 0.028 25 / <alpha-value>)',
          200: 'oklch(0.900 0.055 25 / <alpha-value>)',
          300: 'oklch(0.820 0.090 25 / <alpha-value>)',
          400: 'oklch(0.700 0.130 25 / <alpha-value>)',
          500: 'oklch(0.580 0.150 25 / <alpha-value>)',
          600: 'oklch(0.480 0.135 25 / <alpha-value>)',
          700: 'oklch(0.400 0.115 25 / <alpha-value>)',
          800: 'oklch(0.320 0.090 25 / <alpha-value>)',
          900: 'oklch(0.250 0.070 25 / <alpha-value>)',
          950: 'oklch(0.180 0.050 25 / <alpha-value>)',
        },
        // info → pencil blue-gray (was sky)
        info: {
          50:  'oklch(0.975 0.010 245 / <alpha-value>)',
          100: 'oklch(0.950 0.020 245 / <alpha-value>)',
          200: 'oklch(0.905 0.035 245 / <alpha-value>)',
          300: 'oklch(0.820 0.055 245 / <alpha-value>)',
          400: 'oklch(0.700 0.075 245 / <alpha-value>)',
          500: 'oklch(0.560 0.090 245 / <alpha-value>)',
          600: 'oklch(0.470 0.085 245 / <alpha-value>)',
          700: 'oklch(0.390 0.075 245 / <alpha-value>)',
          800: 'oklch(0.310 0.060 245 / <alpha-value>)',
          900: 'oklch(0.240 0.045 245 / <alpha-value>)',
          950: 'oklch(0.170 0.030 245 / <alpha-value>)',
        },
        // neon (legacy alias) — now quietly collapsed to the sage scale. Use sparingly.
        neon: {
          50:  'oklch(0.975 0.015 155 / <alpha-value>)',
          100: 'oklch(0.950 0.028 155 / <alpha-value>)',
          200: 'oklch(0.900 0.045 155 / <alpha-value>)',
          300: 'oklch(0.820 0.065 155 / <alpha-value>)',
          400: 'oklch(0.700 0.080 155 / <alpha-value>)',
          500: 'oklch(0.570 0.090 155 / <alpha-value>)',
          600: 'oklch(0.480 0.085 155 / <alpha-value>)',
          700: 'oklch(0.400 0.075 155 / <alpha-value>)',
          800: 'oklch(0.320 0.060 155 / <alpha-value>)',
          900: 'oklch(0.250 0.045 155 / <alpha-value>)',
          950: 'oklch(0.180 0.030 155 / <alpha-value>)',
        },
      },
      spacing: {
        // 4pt scale, semantic sizes are set via CSS vars but these aliases help in Tailwind classes.
        'gutter': 'var(--space-gutter)',
        'column': 'var(--space-column)',
      },
      borderRadius: {
        'nib': '2px',   // pen-nib corners — barely rounded
        'leaf': '10px', // default rounded surface
        'sheet': '18px',
      },
      boxShadow: {
        // Letterpress-style depth. No glows, no heavy drops.
        'press': '0 1px 0 0 var(--rule) inset',
        'sheet': '0 1px 2px oklch(0.18 0.02 310 / 0.06), 0 1px 0 0 var(--rule) inset',
        'lift':  '0 2px 4px oklch(0.18 0.02 310 / 0.06), 0 8px 24px oklch(0.18 0.02 310 / 0.04)',
      },
      transitionTimingFunction: {
        // Only ease-out curves. No bounce, no elastic.
        'quart': 'cubic-bezier(0.22, 1, 0.36, 1)',
        'quint': 'cubic-bezier(0.23, 1, 0.32, 1)',
        'expo':  'cubic-bezier(0.19, 1, 0.22, 1)',
      },
      transitionDuration: {
        'settle': '220ms',
        'drift':  '360ms',
      },
      animation: {
        'settle-in': 'settleIn 220ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'rise-in':   'riseIn 260ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'ink-pulse': 'inkPulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        settleIn: {
          from: { opacity: '0', transform: 'translateY(3px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        riseIn: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        inkPulse: {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.72' },
        },
      },
    },
  },
  plugins: [],
}
