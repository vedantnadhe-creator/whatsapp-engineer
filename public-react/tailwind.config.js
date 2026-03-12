/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#000000',
        surface: '#0a0a0a',
        'surface-2': '#111111',
        'surface-3': '#1a1a1a',
        border: '#222222',
        'border-hover': '#333333',
        accent: '#3b82f6',
        'accent-hover': '#2563eb',
        success: '#22c55e',
        danger: '#ef4444',
        warning: '#eab308',
        'text-primary': '#e5e5e5',
        'text-secondary': '#888888',
        'text-muted': '#555555',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
