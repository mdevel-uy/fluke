/** @type {import('tailwindcss').Config} */

const chatMaxWidth = '48rem';

module.exports = {
  darkMode: ['class'],
  important: false,
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    '../web-core/src/**/*.{ts,tsx}',
    '../remote-web/src/**/*.{ts,tsx}',
    '../ui/src/**/*.{ts,tsx}',
    'node_modules/@rjsf/shadcn/src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  safelist: [
    'xl:hidden',
    'xl:relative',
    'xl:inset-auto',
    'xl:z-auto',
    'xl:h-full',
    'xl:w-[800px]',
    'xl:flex',
    'xl:flex-1',
    'xl:min-w-0',
    'xl:overflow-y-auto',
    'xl:opacity-100',
    'xl:pointer-events-auto',
  ],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      height: { cta: '29px' },
      minHeight: { cta: '29px' },
      width: { chat: chatMaxWidth, sidebar: '240px' },
      containers: { chat: chatMaxWidth },

      /* ── Icon sizes (unchanged) ─────────────────────────────── */
      size: {
        'icon-2xs': '0.625rem',
        'icon-xs':  '0.9375rem',
        'icon-sm':  '1.09375rem',
        'icon-base': '1.25rem',
        'icon-lg':  '1.40625rem',
        'icon-xl':  '1.5625rem',
        dot: '0.3rem',
      },

      backgroundImage: {
        'diagonal-lines': `
          repeating-linear-gradient(-45deg, hsl(var(--md-outline) / 0.4) 0 2px, transparent 1px 12px),
          linear-gradient(hsl(var(--bg-primary)), hsl(var(--bg-primary)))
        `,
      },

      ringColor: {
        DEFAULT: 'hsl(var(--brand-on-surface))',
        brand:   'hsl(var(--brand-on-surface))',
      },

      /* ── Type roles — Workbench: 20/15/13/11, 2 weights ─────── */
      fontSize: {
        /* Legacy sizes remapped to the VSCode metric (13px base) */
        xs:   ['0.6875rem', { lineHeight: '1rem' }],       /* 11px */
        sm:   ['0.8125rem', { lineHeight: '1.125rem' }],   /* 13px */
        base: ['0.8125rem', { lineHeight: '1.25rem' }],    /* 13px */
        lg:   ['0.9375rem', { lineHeight: '1.375rem' }],   /* 15px */
        xl:   ['1.25rem',   { lineHeight: '1.625rem' }],   /* 20px */
        cta:  ['0.8125rem', { lineHeight: '1rem' }],

        /* Canonical roles */
        heading: ['1.25rem',   { lineHeight: '1.625rem', fontWeight: '600', letterSpacing: '-0.01em' }],
        title:   ['0.9375rem', { lineHeight: '1.375rem', fontWeight: '600' }],
        body:    ['0.8125rem', { lineHeight: '1.25rem',  fontWeight: '400' }],
        label:   ['0.6875rem', { lineHeight: '1rem',     fontWeight: '600', letterSpacing: '0.05em' }],
        code:    ['0.75rem',   { lineHeight: '1rem',     fontWeight: '400' }],

        /* Deprecated MD3 role aliases — resolve to the Workbench scale */
        'display-lg':  ['1.25rem',   { lineHeight: '1.625rem', fontWeight: '600', letterSpacing: '-0.01em' }],
        'headline-md': ['1.25rem',   { lineHeight: '1.625rem', fontWeight: '600', letterSpacing: '-0.01em' }],
        'title-sm':    ['0.9375rem', { lineHeight: '1.375rem', fontWeight: '600' }],
        'body-md':     ['0.8125rem', { lineHeight: '1.25rem',  fontWeight: '400' }],
        'body-sm':     ['0.75rem',   { lineHeight: '1.0625rem', fontWeight: '400' }],
        'label-caps':  ['0.6875rem', { lineHeight: '1rem',     fontWeight: '600', letterSpacing: '0.05em' }],
        'code-sm':     ['0.75rem',   { lineHeight: '1rem',     fontWeight: '400' }],
      },

      /* ── Spacing tokens ─────────────────────────────────────── */
      spacing: {
        /* `half` (2px) and `plusfifty` (6px) are DEPRECATED — off the
           8-pt scale (design/UI-SPEC.md). Do not use in new code; kept
           only for ~350 legacy call sites pending incremental migration. */
        half:       '0.125rem',
        base:       '0.25rem',
        plusfifty:  '0.375rem',
        double:     '0.5rem',
        'row-gap':  '0.5rem',
        gutter:     '1rem',
        'container-padding': '1.5rem',
        'sidebar-width': '240px',
        unit:       '0.25rem',
      },

      /* ── MD3 colour palette ─────────────────────────────────── */
      colors: {
        /* ── Text (legacy aliases) */
        high:   'hsl(var(--md-on-surface))',
        normal: 'hsl(var(--md-on-surface-variant))',
        low:    'hsl(var(--md-outline))',

        /* ── Background (legacy aliases) */
        primary:   'hsl(var(--bg-primary))',
        secondary: 'hsl(var(--bg-secondary))',
        panel:     'hsl(var(--md-surface-container))',

        /* ── MD3 primary */
        'md-primary':             'hsl(var(--md-primary))',
        'md-on-primary':          'hsl(var(--md-on-primary))',
        'md-primary-container':   'hsl(var(--md-primary-container))',
        'md-on-primary-container':'hsl(var(--md-on-primary-container))',
        'md-primary-fixed':       'hsl(var(--md-primary-fixed))',
        'md-primary-fixed-dim':   'hsl(var(--md-primary-fixed-dim))',
        'md-inverse-primary':     'hsl(var(--md-inverse-primary))',

        /* ── MD3 secondary */
        'md-secondary':             'hsl(var(--md-secondary))',
        'md-on-secondary':          'hsl(var(--md-on-secondary))',
        'md-secondary-container':   'hsl(var(--md-secondary-container))',
        'md-on-secondary-container':'hsl(var(--md-on-secondary-container))',
        'md-secondary-fixed':       'hsl(var(--md-secondary-fixed))',
        'md-secondary-fixed-dim':   'hsl(var(--md-secondary-fixed-dim))',

        /* ── MD3 tertiary */
        'md-tertiary':             'hsl(var(--md-tertiary))',
        'md-on-tertiary':          'hsl(var(--md-on-tertiary))',
        'md-tertiary-container':   'hsl(var(--md-tertiary-container))',
        'md-tertiary-fixed':       'hsl(var(--md-tertiary-fixed))',
        'md-tertiary-fixed-dim':   'hsl(var(--md-tertiary-fixed-dim))',

        /* ── MD3 error */
        'md-error':                'hsl(var(--md-error))',
        'md-on-error':             'hsl(var(--md-on-error))',
        'md-error-container':      'hsl(var(--md-error-container))',
        'md-on-error-container':   'hsl(var(--md-on-error-container))',

        /* ── MD3 surface scale */
        'md-background':                  'hsl(var(--md-background))',
        'md-surface':                     'hsl(var(--md-surface))',
        'md-surface-bright':              'hsl(var(--md-surface-bright))',
        'md-surface-dim':                 'hsl(var(--md-surface-dim))',
        'md-surface-container-lowest':    'hsl(var(--md-surface-container-lowest))',
        'md-surface-container-low':       'hsl(var(--md-surface-container-low))',
        'md-surface-container':           'hsl(var(--md-surface-container))',
        'md-surface-container-high':      'hsl(var(--md-surface-container-high))',
        'md-surface-container-highest':   'hsl(var(--md-surface-container-highest))',

        /* ── MD3 on-surface */
        'md-on-surface':         'hsl(var(--md-on-surface))',
        'md-on-surface-variant': 'hsl(var(--md-on-surface-variant))',
        'md-outline':            'hsl(var(--md-outline))',
        'md-outline-variant':    'hsl(var(--md-outline-variant))',

        /* ── MD3 inverse */
        'md-inverse-surface':     'hsl(var(--md-inverse-surface))',
        'md-inverse-on-surface':  'hsl(var(--md-inverse-on-surface))',

        /* ── Workbench surfaces */
        card:            'hsl(var(--card))',
        sel:             'hsl(var(--sel))',
        'border-strong': 'hsl(var(--outline-strong))',
        mod:             'hsl(var(--mod))',

        /* ── Brand / accent */
        brand:              'hsl(var(--brand))',
        'brand-hover':      'hsl(var(--brand-hover))',
        'brand-on-surface': 'hsl(var(--brand-on-surface))',
        'brand-secondary':  'hsl(var(--brand-secondary))',
        error:              'hsl(var(--error))',
        success:            'hsl(var(--success))',
        'success-foreground': 'hsl(var(--success-foreground))',
        warning:            'hsl(var(--_warning))',
        'warning-foreground': 'hsl(var(--_warning-foreground))',
        info:               'hsl(var(--_info))',
        'info-foreground':  'hsl(var(--_info-foreground))',
        neutral:            'hsl(var(--_neutral))',
        'neutral-foreground': 'hsl(var(--_neutral-foreground))',
        destructive:        'hsl(var(--_destructive))',
        'destructive-foreground': 'hsl(var(--_destructive-foreground))',
        merged:             'hsl(var(--merged))',
        'on-brand':         'hsl(var(--text-on-brand))',

        /* shadcn-style (used by @apply) */
        background: 'hsl(var(--md-background))',
        foreground: 'hsl(var(--md-on-surface))',
        border:     'hsl(var(--md-outline-variant))',
      },

      borderColor: {
        DEFAULT: 'hsl(var(--md-outline-variant))',
        border:  'hsl(var(--md-outline-variant))',
      },

      /* ── Radii — Workbench: 2 controles · 4 cards · 6 overlays ─ */
      borderRadius: {
        none:    '0',
        DEFAULT: '0.125rem',  /* 2px  */
        sm:      '0.125rem',  /* 2px  buttons, inputs, chips */
        md:      '0.125rem',  /* 2px  (alias) */
        lg:      '0.25rem',   /* 4px  cards, list rows, tabs-hover */
        xl:      '0.375rem',  /* 6px  menus, dialogs, toasts */
        '2xl':   '0.375rem',  /* clamped — scale tops out at 6px */
        '3xl':   '0.375rem',  /* clamped */
        full:    '9999px',    /* pills, badges, status dots */
      },

      borderWidth: {
        base: '0.25rem',
        half: '0.125rem',
      },

      /* ── Workbench elevation: borders, not shadows ──────────── */
      /* Surfaces (cards, bars, rows) carry NO shadow — legacy
         shadow-* utilities resolve to none. Shadow exists only on
         floating overlays (menus, dialogs, toasts). */
      boxShadow: {
        soft:       '0 0 #0000',
        card:       '0 0 #0000',
        'card-hover': '0 0 #0000',
        elevated:   '0 0 #0000',
        overlay:    '0 4px 18px rgb(0 0 0 / 0.28)',
        focus:      '0 0 0 1px hsl(var(--brand-on-surface))',
      },

      /* ── Font families — system stacks (VSCode metric) ──────── */
      fontFamily: {
        sans:            ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Ubuntu', 'sans-serif'],
        mono:            ['ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
        /* legacy aliases — resolve to the two canonical stacks */
        geist:           ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Ubuntu', 'sans-serif'],
        'geist-mono':    ['ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
        hanken:          ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Ubuntu', 'sans-serif'],
        'ibm-plex-sans': ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Ubuntu', 'sans-serif'],
        'ibm-plex-mono': ['ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
      },

      /* ── Keyframes (unchanged) ──────────────────────────────── */
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        pill: {
          '0%':   { opacity: '0' },
          '10%':  { opacity: '1' },
          '80%':  { opacity: '1' },
          '100%': { opacity: '0' },
        },
        'running-dot': {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' },
        },
        'border-flash': {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-2px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(2px)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up':   'accordion-up 0.2s ease-out',
        pill:             'pill 2s ease-in-out forwards',
        'running-dot-1':  'running-dot 1.4s ease-in-out infinite',
        'running-dot-2':  'running-dot 1.4s ease-in-out 0.2s infinite',
        'running-dot-3':  'running-dot 1.4s ease-in-out 0.4s infinite',
        'border-flash':   'border-flash 2s linear infinite',
        shake:            'shake 0.3s ease-in-out',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    require('@tailwindcss/container-queries'),
    require('tailwind-scrollbar')({ nocompatible: true }),
  ],
};
