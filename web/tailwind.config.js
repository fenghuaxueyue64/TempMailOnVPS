/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{svelte,js,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Roboto', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        // Material 3 色板（紫色主调）
        primary: {
          DEFAULT: '#6750A4',
          on: '#FFFFFF',
          container: '#EADDFF',
          onContainer: '#21005D',
          hover: '#7965B0',
        },
        secondary: {
          DEFAULT: '#625B71',
          container: '#E8DEF8',
          onContainer: '#1D192B',
        },
        tertiary: {
          DEFAULT: '#7D5260',
          container: '#FFD8E4',
          onContainer: '#31111D',
        },
        error: {
          DEFAULT: '#B3261A',
          on: '#FFFFFF',
          container: '#F9DEDC',
          onContainer: '#410E0B',
        },
        surface: {
          DEFAULT: '#FEF7FF',
          on: '#1D1B20',
          'on-variant': '#49454F',
          variant: '#E7E0EC',
          container: '#FFFFFF',
          'container-low': '#F7F2FA',
          'container-high': '#F3EDF7',
          'container-highest': '#ECE6F0',
        },
        success: {
          DEFAULT: '#2E7D32',
          container: '#E6F4EA',
        },
        outline: '#79747E',
      },
      borderRadius: {
        m3: '16px',
        m3sm: '12px',
        m3lg: '28px',
        m3xl: '32px',
      },
      boxShadow: {
        // M3 elevation 分级
        m1: '0 1px 2px 0 rgba(0,0,0,0.08), 0 1px 3px 1px rgba(0,0,0,0.04)',
        m2: '0 1px 2px 0 rgba(0,0,0,0.10), 0 2px 6px 2px rgba(0,0,0,0.06)',
        m3: '0 4px 8px 3px rgba(0,0,0,0.10), 0 1px 3px 0 rgba(0,0,0,0.12)',
      },
      transitionTimingFunction: {
        m3: 'cubic-bezier(0.2, 0, 0, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 0.25s cubic-bezier(0.2, 0, 0, 1)',
        'slide-up': 'slideUp 0.3s cubic-bezier(0.2, 0, 0, 1)',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
  plugins: [],
};
