/** @type {import('tailwindcss').Config} */

const config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'still-bg': '#F8F9FA',
        'still-surface': '#FFFFFF',
        'still-text': '#1A2530',
        'still-muted': '#606F7B',
        'still-accent': '#2B5A8F',
        'still-success': '#3E7B61',
        'still-highlight': '#DCE5EE',
      },
      transitionDuration: {
        '300': '300ms',
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        'still': '0 4px 20px rgb(0 0 0 / 0.04)',
        'still-hover': '0 10px 40px rgb(0 0 0 / 0.06)',
      },
    },
  },
  plugins: [],
}

export default config