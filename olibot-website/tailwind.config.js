/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0F172A',
        surface: '#1E293B',
        'surface-2': '#253449',
        border: '#334155',
        primary: '#22C55E',
        'primary-hover': '#16A34A',
        'text-bright': '#F8FAFC',
        'text-main': '#94A3B8',
        'text-dim': '#64748B',
        'code-bg': '#0B1120',
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
