/** Independently authored palettes; product references describe mood, not official tokens. */
export const palettes = {
  light: {
    canvas: '#f5f0e4', sidebar: '#eee8db', surface: '#fffdf7', raised: '#faf6ed',
    user: '#eae3d6', hover: '#e7dfd1', selected: '#dfd4c3',
    text: '#302b25', secondary: '#625a50', muted: '#63594d', border: '#d7cebf',
    strongBorder: '#9e9180', accent: '#a64f35', accentHover: '#8e412a', onAccent: '#fffdf7',
    link: '#795133', success: '#3c6747', warning: '#865a17', danger: '#a33e37',
    successFill: '#e5edde', warningFill: '#f2e6c9', dangerFill: '#f4e1da',
    selection: '#e8ccb7', code: '#eee7da', tooltip: '#3b332b', tooltipText: '#fff9ee',
    constant: '#366379', string: '#486442', keyword: '#8c465b', function: '#755181',
  },
  dark: {
    canvas: '#262421', sidebar: '#211f1d', surface: '#302d29', raised: '#36322d',
    user: '#3b352e', hover: '#403930', selected: '#4b4033',
    text: '#eee7db', secondary: '#bdb2a3', muted: '#b9ae9e', border: '#50483f',
    strongBorder: '#8d7e6b', accent: '#df9b7e', accentHover: '#edb398', onAccent: '#262421',
    link: '#d9b792', success: '#aac19b', warning: '#dcc087', danger: '#e7aaa0',
    successFill: '#333c2e', warningFill: '#433923', dangerFill: '#482f2b',
    selection: '#675044', code: '#211e1b', tooltip: '#e9dfce', tooltipText: '#302820',
    constant: '#a5c4d2', string: '#b4c89a', keyword: '#dcadb9', function: '#c9b4d6',
  },
};

// Light partners keep accent text readable; dark partners carry the trading-terminal character.
const terminalLight = {
  canvas: '#f6f7f8', sidebar: '#edf0f2', surface: '#ffffff', raised: '#f0f2f4',
  user: '#e8ecef', hover: '#e3e8ec', selected: '#dce4e8',
  text: '#172126', secondary: '#46535b', muted: '#4d5b62', border: '#cbd3d8', strongBorder: '#7a878f',
  success: '#146747', warning: '#825900', danger: '#b33349',
  successFill: '#e1f2e9', warningFill: '#faf0d4', dangerFill: '#fbe8ec',
  code: '#edf1f3', tooltip: '#172126', tooltipText: '#f5f8fa',
  constant: '#2a586f', string: '#226244', keyword: '#865080', function: '#5354a0',
};
const terminalDark = {
  canvas: '#101316', sidebar: '#0c0f12', surface: '#191e23', raised: '#20262c',
  user: '#222a30', hover: '#283138', selected: '#2a353c',
  text: '#edf2f5', secondary: '#b6c2ca', muted: '#a6b4bd', border: '#323e47', strongBorder: '#71818d',
  success: '#64d6a1', warning: '#f4cb71', danger: '#ff8b9e',
  successFill: '#16382a', warningFill: '#3c311b', dangerFill: '#40242b',
  code: '#0c1115', tooltip: '#e5edf1', tooltipText: '#162026',
  constant: '#94c9e3', string: '#8dd9ac', keyword: '#e0a7cd', function: '#b4b9ff',
};
export const themes = {
  parchment: palettes,
  robinhood: {
    light: { ...terminalLight, canvas: '#f7f9f5', sidebar: '#eef2e9', user: '#e9efdf',
      hover: '#e4ecd8', selected: '#dce8cb', accent: '#326b12', accentHover: '#27560d', onAccent: '#ffffff',
      link: '#326b12', selection: '#d1e8b7' },
    dark: { ...terminalDark, canvas: '#0e110d', sidebar: '#0a0d09', surface: '#171c15', raised: '#1e251b',
      user: '#222b1e', hover: '#293323', selected: '#2b3822', border: '#323e2b', strongBorder: '#74866a',
      accent: '#b6f337', accentHover: '#c9ff63', onAccent: '#131c08', link: '#b6f337',
      selection: '#354d1e', code: '#0b1009' },
  },
  binance: {
    light: { ...terminalLight, canvas: '#faf9f6', sidebar: '#f0eee7', user: '#eeeadf',
      hover: '#eae6d9', selected: '#e7e0cb', accent: '#805c00', accentHover: '#684b00', onAccent: '#ffffff',
      link: '#805c00', selection: '#f1dfa9' },
    dark: { ...terminalDark, canvas: '#181a20', sidebar: '#111318', surface: '#20232b', raised: '#292d36',
      user: '#2b3039', hover: '#303640', selected: '#35392f', border: '#3a404b', strongBorder: '#7b8596',
      accent: '#f0b90b', accentHover: '#ffd047', onAccent: '#181a20', link: '#f0c94d',
      selection: '#514526', code: '#14171d' },
  },
  bitget: {
    light: { ...terminalLight, canvas: '#f4f9fa', sidebar: '#e9f1f3', user: '#e1edef',
      hover: '#daeaed', selected: '#d2e5e9', accent: '#006873', accentHover: '#005560', onAccent: '#ffffff',
      link: '#006873', selection: '#b9e7ec' },
    dark: { ...terminalDark, canvas: '#0b1215', sidebar: '#080e11', surface: '#131f24', raised: '#1a2a30',
      user: '#1d2e35', hover: '#23363e', selected: '#233a42', border: '#2d424b', strongBorder: '#708d98',
      accent: '#47dce6', accentHover: '#7aeaf1', onAccent: '#092025', link: '#69e0e9',
      selection: '#1b5059', code: '#080f13' },
  },
};

const semantic = {
  'bg-base': 'canvas', 'bg-overlay': 'surface', 'bg-layer-1': 'surface', 'bg-layer-2': 'raised', 'bg-layer-3': 'raised',
  'bg-document-preview': 'canvas', 'label-document-preview': 'text',
  'label-primary': 'text', 'label-primary-bluish': 'text', 'label-primary-dimmed': 'secondary',
  'label-secondary': 'secondary', 'label-tertiary': 'muted', 'label-caption': 'muted',
  'label-primary-foreground': 'onAccent', 'label-link': 'link', link: 'link',
  'brand-primary': 'accent', 'brand-text': 'accent', 'menu-icon': 'secondary',
  'border-l1': 'border', 'border-l2': 'strongBorder', 'border-l3': 'border', 'border-l4': 'strongBorder',
  'interactive-bg-hover': 'hover', 'interactive-bg-hover-solid': 'hover', 'interactive-bg-active': 'selected',
  'interactive-bg-selected': 'selected', 'button-primary-fill': 'accent', 'button-primary-hover': 'accentHover',
  'button-contrast-fill': 'accent', 'button-floating-fill': 'surface', 'button-secondary-fill': 'user',
  'markdown-code-block': 'code', 'markdown-code-block-banner': 'raised', 'markdown-inline-code': 'code',
  'state-business-primary': 'accent', 'state-business-secondary': 'selected',
  'state-success-primary': 'success', 'state-success-secondary': 'successFill',
  'state-warn-primary': 'warning', 'state-warn-secondary': 'warningFill',
  'state-error-primary': 'danger', 'state-error-secondary': 'dangerFill', 'state-idle-primary': 'secondary',
  'toast-bg': 'surface', 'toast-label': 'text', 'tooltip-bg': 'tooltip', 'tooltip-label': 'tooltipText',
  'tooltip-key-bg': 'selected', 'bg-document-selection': 'selection', 'bg-selection': 'selection',
  'scrollbar-thumb-l1': 'strongBorder', 'scrollbar-thumb-l1-hover': 'secondary',
  'scrollbar-thumb-l2': 'strongBorder', 'scrollbar-thumb-l2-hover': 'secondary',
  'label-deep-diving': 'accent', 'label-deep-diving-shimmer': 'accentHover',
  'turn-trigger-bg': 'user', 'turn-trigger-bg-hover': 'hover', 'switch-thumb': 'surface',
};
const specific = {
  'sidebar-fill': 'sidebar', 'sidebar-nav-item-active': 'selected', 'sidebar-nav-item-active-accent': 'selected',
  'sidebar-nav-item-hover': 'hover', 'input-major': 'surface', 'login-input': 'surface',
  menu: 'surface', selector: 'raised', bubble: 'user', 'bubble-highlight': 'selected', tip: 'raised',
};

/** Complete pairs for the published theme override service. */
export function createOverrides(pair) { return Object.fromEntries([
  ...Object.entries(semantic).map(([key, value]) => [`--dsw-alias-${key}`, value]),
  ...Object.entries(specific).map(([key, value]) => [`--dsw-specific-${key}`, value]),
  ...Object.keys(palettes.light).map(key => [`--cp-${key}`, key]),
  ['--dsw-focus-ring-color', 'accent'], ['--dsw-menu-surface-fill', 'surface'],
  ['--dsw-alias-menu-group-header-fill', 'surface'],
  ['--shiki-token-constant', 'constant'], ['--shiki-token-string', 'string'],
  ['--shiki-token-string-expression', 'string'], ['--shiki-token-keyword', 'keyword'],
  ['--shiki-token-function', 'function'], ['--shiki-token-parameter', 'accent'],
  ['--shiki-token-comment', 'muted'], ['--shiki-token-punctuation', 'secondary'], ['--shiki-token-link', 'link'],
].map(([name, key]) => [name, { light: pair.light[key], dark: pair.dark[key] }])); }
export const themeOverrides = Object.fromEntries(Object.entries(themes).map(([id, pair]) => [id, createOverrides(pair)]));
export const overrides = themeOverrides.parchment;
export const themeOptions = Object.entries(themes).map(([id, pair]) => ({
  id, swatches: Object.fromEntries(Object.entries(pair).map(([mode, p]) => [mode, [p.canvas, p.surface, p.accent, p.text]])),
}));
