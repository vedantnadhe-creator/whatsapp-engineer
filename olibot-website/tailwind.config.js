/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f8fafb',
        surface: '#ffffff',
        'surface-2': '#f1f5f9',
        border: '#e2e8f0',
        'border-strong': '#cbd5e1',
        primary: '#16a34a',
        'primary-hover': '#15803d',
        'primary-light': 'rgba(22, 163, 74, 0.08)',
        'text-bright': '#0f172a',
        'text-main': '#475569',
        'text-dim': '#94a3b8',
        'code-bg': '#0f172a',
      },
      fontFamily: {
        heading: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        body: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      maxWidth: {
        content: '1120px',
        narrow: '720px',
      },
    },
  },
  plugins: [],
}
