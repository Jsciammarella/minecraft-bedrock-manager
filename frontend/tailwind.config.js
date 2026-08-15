/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        mc: {
          dark: '#1a1a2e',
          darker: '#16162a',
          accent: '#4ade80',
          accentHover: '#22c55e',
          danger: '#ef4444',
          warning: '#f59e0b',
          info: '#3b82f6',
          surface: '#252545',
          surfaceLight: '#2d2d50',
          text: '#e2e8f0',
          textMuted: '#94a3b8',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
