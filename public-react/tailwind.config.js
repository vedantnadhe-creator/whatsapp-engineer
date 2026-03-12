/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--c-bg)',
        surface: 'var(--c-surface)',
        'surface-2': 'var(--c-surface-2)',
        'surface-3': 'var(--c-surface-3)',
        border: 'var(--c-border)',
        'border-hover': 'var(--c-border-hover)',
        accent: 'var(--c-accent)',
        'accent-hover': 'var(--c-accent-hover)',
        success: 'var(--c-success)',
        danger: 'var(--c-danger)',
        warning: 'var(--c-warning)',
        'text-primary': 'var(--c-text)',
        'text-secondary': 'var(--c-text-secondary)',
        'text-muted': 'var(--c-text-muted)',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
