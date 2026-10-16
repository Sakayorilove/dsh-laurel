/** Published DSH ModuleLoader registration protocol; React comes from the host. */
window.__ModuleLoader__.load({
  id: 'dsh-claude-parchment',
  factory(require) {
    const React = require('react');
    const version = "1.3.1";
    const css = "/* Every override below is gated by our own attribute; removing the layer restores host appearance. */\nhtml[data-cp-active] body {\n  color: var(--cp-text);\n  background: var(--cp-canvas);\n  font-family: \"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif;\n  --dsw-font-family-brand: Georgia, \"Noto Serif SC\", \"Songti SC\", SimSun, serif;\n  --dsw-menu-backdrop-filter: none;\n  --dsw-radius-panel: 14px;\n  --dsw-radius-md: 8px;\n  --dsw-radius-sm: 6px;\n  --dsw-shadow-lv1: 0 2px 6px rgb(40 28 15 / 5%);\n  --dsw-shadow-lv2: 0 6px 18px rgb(40 28 15 / 9%);\n  --cp-font-reading: Georgia, \"Noto Serif SC\", \"Source Han Serif SC\", \"Songti SC\", SimSun, serif;\n  --cp-font-ui: \"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif;\n  --cp-prose-leading: 1.8;\n  --cp-paragraph-gap: 1em;\n  --cp-turn-gap: 28px;\n}\nhtml[data-cp-active] body[data-ds-dark-theme] { --cp-prose-leading: 1.85; }\nhtml[data-cp-active] ::selection { background: var(--cp-selection); color: var(--cp-text); }\nhtml[data-cp-active] :is(input, textarea, [contenteditable=\"true\"]) { caret-color: var(--cp-accent); }\nhtml[data-cp-active] :is(button, a, input, select, textarea, [tabindex]):focus-visible {\n  outline-color: var(--cp-accent);\n  outline-offset: 3px;\n}\nhtml[data-cp-active] :is(pre, code, kbd, samp) {\n  font-family: \"Cascadia Code\", \"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace;\n}\n/* This stylesheet only targets host structure. It never adapts to, nor reads from,\n   any other installed plugin: no third-party class names or attributes are referenced. */\nhtml[data-cp-active] [data-composer-card] {\n  background: var(--cp-surface);\n  border: 1px solid var(--cp-strongBorder);\n  border-radius: 14px;\n  box-shadow: none;\n}\nhtml[data-cp-active] [data-composer-card]:focus-within {\n  border-color: var(--cp-accent);\n  box-shadow: 0 0 0 1px var(--cp-accent);\n}\nhtml[data-cp-active] [data-composer-input] {\n  font-family: inherit;\n  color: var(--cp-text);\n  line-height: 1.7;\n}\nhtml[data-cp-active] [data-composer-placeholder] { color: var(--cp-muted); }\n/* One shared width axis keeps the transcript, composer and host width handles aligned.\n   An explicit user-dragged width still wins over our 720px default. */\nhtml[data-cp-active] [data-conversation-content] {\n  --dsh-chat-content-width: min(var(--dsh-chat-user-width, 720px), max(160px, calc(var(--dsh-conversation-column-width, 840px) - 64px)));\n  --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);\n}\nhtml[data-cp-active] :is([data-chat-flow-kind=\"user\"], [data-chat-flow-kind=\"steering\"], [data-chat-group-part=\"response\"]) {\n  --dsh-chat-flow-gap: var(--cp-turn-gap);\n}\nhtml[data-cp-active] :is([data-chat-flow-kind=\"user\"], [data-chat-flow-kind=\"steering\"]) + [data-chat-flow-kind]:not([hidden]) {\n  --dsh-chat-flow-gap: var(--cp-turn-gap);\n}\n/* Module-class suffixes mirror MessageItem's userStack/bubble without pinning its hash. */\nhtml[data-cp-active] :is([data-chat-flow-kind=\"user\"], [data-chat-flow-kind=\"steering\"]) [class*=\"_userStack\"] {\n  max-width: 88%;\n}\nhtml[data-cp-active] :is([data-chat-flow-kind=\"user\"], [data-chat-flow-kind=\"steering\"]) [class*=\"_bubble\"] {\n  padding: 12px 16px;\n  border-radius: 12px;\n  background: var(--cp-user);\n  color: var(--cp-text);\n  font-family: var(--cp-font-ui);\n  font-size: var(--dsh-content-font-size, 16px);\n  line-height: 1.65;\n}\n/* Markdown uses explicit font shorthands, so inheriting a font on the flow seat\n   does not style real answers. Override the prose roles locally, leaving compact\n   reasoning, tools, code and controls in their native reading/operation roles. */\nhtml[data-cp-active] :is([data-chat-flow-kind=\"assistant\"], [data-chat-flow-kind=\"assistant-step\"]):not([data-chat-group-part=\"reasoning\"]) {\n  --dsw-font-markdown-base: 400 var(--dsh-content-font-size, 16px)/var(--cp-prose-leading) var(--cp-font-reading);\n  --dsw-font-markdown-base-strong: 600 var(--dsh-content-font-size, 16px)/var(--cp-prose-leading) var(--cp-font-reading);\n  --dsw-font-markdown-h1: 600 calc(var(--dsh-content-font-size, 16px) * 1.5)/1.35 var(--cp-font-reading);\n  --dsw-font-markdown-h2: 600 calc(var(--dsh-content-font-size, 16px) * 1.25)/1.4 var(--cp-font-reading);\n  --dsw-font-markdown-h3: 600 calc(var(--dsh-content-font-size, 16px) * 1.125)/1.45 var(--cp-font-reading);\n  --dsw-font-markdown-h4: 600 var(--dsh-content-font-size, 16px)/1.5 var(--cp-font-reading);\n}\nhtml[data-cp-active] :is([data-chat-flow-kind=\"assistant\"], [data-chat-flow-kind=\"assistant-step\"]):not([data-chat-group-part=\"reasoning\"]) [class*=\"_markdown\"]:not([data-markdown-variant=\"compact\"]) {\n  font: var(--dsw-font-markdown-base);\n  color: var(--cp-text);\n  overflow-wrap: anywhere;\n}\nhtml[data-cp-active] :is([data-chat-flow-kind=\"assistant\"], [data-chat-flow-kind=\"assistant-step\"]):not([data-chat-group-part=\"reasoning\"]) [class*=\"_markdown\"]:not([data-markdown-variant=\"compact\"]) :is(p, ul, ol) {\n  margin-block: var(--cp-paragraph-gap);\n}\nhtml[data-cp-active] :is([data-chat-flow-kind=\"assistant\"], [data-chat-flow-kind=\"assistant-step\"]):not([data-chat-group-part=\"reasoning\"]) [class*=\"_markdown\"]:not([data-markdown-variant=\"compact\"]) :is(h1, h2, h3, h4, h5, h6) {\n  margin-block: 1.5em .6em;\n  letter-spacing: -0.015em;\n  text-wrap: pretty;\n}\nhtml[data-cp-active] [data-chat-flow-kind] :is(button, input, select, [data-disclosure-row], [data-code-block-banner]) {\n  font-family: var(--cp-font-ui);\n}\nhtml[data-cp-active] [data-chat-flow-kind] [data-markdown-variant=\"compact\"] { font-family: var(--cp-font-ui); }\nhtml[data-cp-active] [data-chat-flow-kind] .md-table-wide {\n  width: 100%;\n  max-width: 100%;\n  margin-inline: 0;\n  padding-inline: 0;\n}\n/* Host module classes that render the welcome headline, page header and primary buttons. */\nhtml[data-cp-active] :is(.pXSMma_headline, .pXSMma_titleText) {\n  font-family: var(--dsw-font-family-brand);\n  font-weight: 400;\n  letter-spacing: -0.02em;\n  line-height: 1.25;\n}\nhtml[data-cp-active] .pXSMma_headline { font-size: 34px; }\nhtml[data-cp-active] .wSkVaW_header { border-bottom-color: var(--cp-border); }\nhtml[data-cp-active] .uV2eYG_primary {\n  background: var(--cp-accent);\n  color: var(--cp-onAccent);\n}\nhtml[data-cp-active] .uV2eYG_primary:hover:not(:disabled) { background: var(--cp-accentHover); }\nhtml[data-cp-active] .YDXeBa_sessionRow.YDXeBa_selected { background: var(--cp-selected); }\nhtml[data-cp-active] .YDXeBa_sessionRow:hover { background: var(--cp-hover); }\nhtml[data-cp-active] [data-chat-flow-kind] a { color: var(--cp-link); text-underline-offset: 0.2em; }\n/* Trading variants: one accent, quiet surfaces, local light only on meaningful interaction. */\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) body {\n  --cp-font-reading: var(--cp-font-ui);\n  --dsw-font-family-brand: var(--cp-font-ui);\n  --cp-prose-leading: 1.75;\n  --dsw-radius-panel: var(--cp-panel-radius);\n  --dsw-radius-xs: var(--cp-control-radius);\n  --dsw-radius-sm: var(--cp-control-radius);\n  --dsw-radius-md: var(--cp-control-radius);\n  --dsw-radius-lg: var(--cp-panel-radius);\n  --dsw-radius-xl: var(--cp-panel-radius);\n  --cp-glow: color-mix(in srgb, var(--cp-accent) 16%, transparent);\n  --cp-shadow-ink: rgb(12 22 29 / 12%);\n  --cp-sidebar-shadow: 5px 0 18px rgb(12 22 29 / 13%);\n  --dsw-shadow-lv1: 0 3px 10px rgb(0 0 0 / 10%);\n  --dsw-shadow-lv2: 0 8px 24px rgb(0 0 0 / 16%);\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) body[data-ds-dark-theme] {\n  --cp-shadow-ink: rgb(0 0 0 / 32%);\n  --cp-sidebar-shadow: 6px 0 20px rgb(0 0 0 / 34%);\n}\n/* Shape is part of each theme's identity, not just a shared recolored shell. */\nhtml[data-cp-active][data-cp-theme=\"robinhood\"] body {\n  --cp-panel-radius: 0px;\n  --cp-control-radius: 0px;\n  --cp-nav-radius: 0px;\n  --cp-bubble-radius: 0px;\n  --cp-sidebar-radius: 0px;\n  --cp-bubble-shadow: 0 2px 7px var(--cp-shadow-ink);\n}\nhtml[data-cp-active][data-cp-theme=\"binance\"] body {\n  --cp-panel-radius: 4px;\n  --cp-control-radius: 4px;\n  --cp-nav-radius: 3px;\n  --cp-bubble-radius: 4px;\n  --cp-sidebar-radius: 4px;\n  --cp-bubble-shadow: 0 3px 10px var(--cp-shadow-ink);\n}\nhtml[data-cp-active][data-cp-theme=\"bitget\"] body {\n  --cp-panel-radius: 12px;\n  --cp-control-radius: 6px;\n  --cp-nav-radius: 8px;\n  --cp-bubble-radius: 12px 12px 3px 12px;\n  --cp-sidebar-radius: 12px;\n  --cp-bubble-shadow: 0 5px 16px var(--cp-shadow-ink);\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) :is(.pXSMma_headline, .pXSMma_titleText) {\n  font-weight: 600;\n  letter-spacing: -0.025em;\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) [data-composer-card] {\n  border-radius: var(--cp-panel-radius);\n  transition: border-color 160ms ease-out, box-shadow 160ms ease-out;\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) [data-composer-card]:focus-within {\n  box-shadow: 0 0 0 1px var(--cp-accent), 0 4px 18px var(--cp-glow);\n}\n/* The surrounding card supplies the visible focus indicator for the editable area. */\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) [data-composer-input]:focus-visible {\n  outline: none;\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) .uV2eYG_primary {\n  border-radius: var(--cp-control-radius);\n  transition: background-color 160ms ease-out, box-shadow 160ms ease-out;\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) .uV2eYG_primary:hover:not(:disabled) {\n  box-shadow: 0 3px 12px var(--cp-glow);\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) .YDXeBa_sessionRow.YDXeBa_selected {\n  box-shadow: inset 2px 0 var(--cp-accent);\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) .YDXeBa_sessionRow {\n  border-radius: var(--cp-nav-radius);\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) :is([data-chat-flow-kind=\"user\"], [data-chat-flow-kind=\"steering\"]) [class*=\"_bubble\"] {\n  border-radius: var(--cp-bubble-radius);\n  box-shadow: var(--cp-bubble-shadow);\n}\n/* AppFrame's sidebar column clips its children during collapse. Paint depth on\n   the column itself, so its own shadow can reach the conversation without\n   changing overflow, widths, resize handles or collapse geometry. */\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) :is([class*=\"_sidebarCol\"], .hHd-Xa_root) {\n  border-radius: 0 var(--cp-sidebar-radius) var(--cp-sidebar-radius) 0;\n  box-shadow: var(--cp-sidebar-shadow);\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) [class*=\"_sidebarCol\"] .hHd-Xa_root {\n  box-shadow: none;\n}\n@media (min-width: 601px) {\n  html[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) [class*=\"_sidebarCol\"] { z-index: 1; }\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) :is([data-code-block-banner], .md-code-block) {\n  border-radius: var(--cp-control-radius);\n}\nhtml[data-cp-active][data-cp-theme]:not([data-cp-theme=\"parchment\"]) [data-cp-settings] :is(button, input[type=\"text\"]) {\n  border-radius: var(--cp-control-radius);\n}\n/* The plugin's own settings stay readable in every state, including theme off. */\n[data-cp-settings] { color: var(--dsw-alias-label-primary); padding: 24px; max-width: 760px; box-sizing: border-box; }\n[data-cp-settings] h2 { font-size: 22px; margin: 0 0 10px; font-weight: 600; }\n[data-cp-settings] p { color: var(--dsw-alias-label-secondary); line-height: 1.7; margin: 0 0 20px; }\n[data-cp-settings] .cp-toggle { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 0; border-block: 1px solid var(--dsw-alias-border-l1); }\n[data-cp-settings] input[type=\"checkbox\"] { width: 20px; height: 20px; accent-color: var(--dsw-alias-brand-primary); flex-shrink: 0; }\n[data-cp-settings] .cp-status { margin: 18px 0; }\n[data-cp-settings] .cp-themes { min-width: 0; margin: 24px 0 20px; padding: 0; border: 0; }\n[data-cp-settings] .cp-themes legend { padding: 0 0 12px; font-weight: 600; }\n[data-cp-settings] .cp-theme-option { display: flex; align-items: center; gap: 12px; min-height: 72px; padding: 10px 4px; border-top: 1px solid var(--dsw-alias-border-l1); cursor: pointer; box-sizing: border-box; }\n[data-cp-settings] .cp-theme-option:hover { background: var(--dsw-alias-interactive-bg-hover); }\n[data-cp-settings] .cp-theme-option[data-selected] .cp-theme-name { color: var(--dsw-alias-brand-primary); }\n[data-cp-settings] .cp-theme-option input { width: 18px; height: 18px; margin: 0; flex-shrink: 0; accent-color: var(--dsw-alias-brand-primary); }\n[data-cp-settings] .cp-theme-option input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }\n[data-cp-settings] .cp-theme-copy { display: grid; gap: 4px; min-width: 0; }\n[data-cp-settings] .cp-theme-name { font-weight: 600; overflow-wrap: anywhere; }\n[data-cp-settings] .cp-theme-detail { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }\n[data-cp-settings] .cp-theme-colors { display: flex; margin-left: auto; padding-left: 8px; flex-shrink: 0; }\n[data-cp-settings] .cp-theme-colors span { width: 14px; height: 20px; }\n[data-cp-settings] .cp-theme-colors span:first-child { border-radius: 4px 0 0 4px; }\n[data-cp-settings] .cp-theme-colors span:last-child { border-radius: 0 4px 4px 0; }\n[data-cp-settings] .cp-themes .cp-theme-help { font-size: 13px; margin: 12px 0 0; }\n[data-cp-settings] .cp-help { padding: 16px; background: var(--dsw-alias-bg-layer-1); border-radius: 10px; }\n[data-cp-settings] .cp-palette { display: flex; align-items: center; gap: 10px; margin-top: 16px; }\n[data-cp-settings] .cp-swatch { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2); }\n[data-cp-settings] .cp-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 12px; }\n[data-cp-settings] .cp-version { color: var(--dsw-alias-label-secondary); font-size: 14px; font-variant-numeric: tabular-nums; }\n[data-cp-settings] .cp-update { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--dsw-alias-border-l1); }\n[data-cp-settings] .cp-versions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 16px; margin: 0 0 16px; }\n[data-cp-settings] .cp-versions dt { color: var(--dsw-alias-label-secondary); }\n[data-cp-settings] .cp-versions dd { margin: 0; text-align: end; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }\n[data-cp-settings] .cp-update-message { margin: 0 0 16px; overflow-wrap: anywhere; }\n[data-cp-settings] .cp-actions { display: flex; flex-wrap: wrap; gap: 10px; }\n[data-cp-settings] button { padding: 9px 14px; min-height: 40px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }\n[data-cp-settings] button:hover:enabled { background: var(--dsw-alias-interactive-bg-hover); }\n[data-cp-settings] button:disabled { opacity: .55; cursor: default; }\n[data-cp-settings] :is(button, input[type=\"text\"]):focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }\n[data-cp-settings] .cp-update-form { margin-top: 20px; }\n[data-cp-settings] .cp-update-form label { display: block; margin-bottom: 8px; font-weight: 600; }\n[data-cp-settings] input[type=\"text\"] { display: block; box-sizing: border-box; width: 100%; min-width: 0; padding: 10px 12px; min-height: 44px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 16px; caret-color: var(--dsw-alias-brand-primary); }\n[data-cp-settings] input::placeholder { color: var(--dsw-alias-label-secondary); }\n[data-cp-settings] .cp-update-help { margin: 10px 0 16px; font-size: 14px; }\n[data-cp-settings] .cp-install { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }\n[data-cp-settings] .cp-install:hover:enabled { background: var(--dsw-alias-brand-primary); filter: brightness(.94); }\n[data-cp-settings] .cp-update-error { margin: 0 0 16px; padding: 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }\n@media (max-width: 600px) {\n  html[data-cp-active] [data-conversation-content] { --cp-turn-gap: 24px; }\n  html[data-cp-active] :is([data-chat-flow-kind=\"user\"], [data-chat-flow-kind=\"steering\"]) [class*=\"_userStack\"] { max-width: 94%; }\n  html[data-cp-active] .pXSMma_headline { font-size: 28px; }\n  html[data-cp-active] [data-composer-input] { font-size: max(16px, var(--dsh-content-font-size, 14px)); }\n  [data-cp-settings] { padding: 18px; }\n}\n@media (prefers-reduced-motion: reduce) {\n  html[data-cp-active] :is([data-composer-card], [data-chat-flow-kind], button) { transition: none !important; }\n}\n";
    const tokens = {"parchment":{"--dsw-alias-bg-base":{"light":"#f5f0e4","dark":"#262421"},"--dsw-alias-bg-overlay":{"light":"#fffdf7","dark":"#302d29"},"--dsw-alias-bg-layer-1":{"light":"#fffdf7","dark":"#302d29"},"--dsw-alias-bg-layer-2":{"light":"#faf6ed","dark":"#36322d"},"--dsw-alias-bg-layer-3":{"light":"#faf6ed","dark":"#36322d"},"--dsw-alias-bg-document-preview":{"light":"#f5f0e4","dark":"#262421"},"--dsw-alias-label-document-preview":{"light":"#302b25","dark":"#eee7db"},"--dsw-alias-label-primary":{"light":"#302b25","dark":"#eee7db"},"--dsw-alias-label-primary-bluish":{"light":"#302b25","dark":"#eee7db"},"--dsw-alias-label-primary-dimmed":{"light":"#625a50","dark":"#bdb2a3"},"--dsw-alias-label-secondary":{"light":"#625a50","dark":"#bdb2a3"},"--dsw-alias-label-tertiary":{"light":"#63594d","dark":"#b9ae9e"},"--dsw-alias-label-caption":{"light":"#63594d","dark":"#b9ae9e"},"--dsw-alias-label-primary-foreground":{"light":"#fffdf7","dark":"#262421"},"--dsw-alias-label-link":{"light":"#795133","dark":"#d9b792"},"--dsw-alias-link":{"light":"#795133","dark":"#d9b792"},"--dsw-alias-brand-primary":{"light":"#a64f35","dark":"#df9b7e"},"--dsw-alias-brand-text":{"light":"#a64f35","dark":"#df9b7e"},"--dsw-alias-menu-icon":{"light":"#625a50","dark":"#bdb2a3"},"--dsw-alias-border-l1":{"light":"#d7cebf","dark":"#50483f"},"--dsw-alias-border-l2":{"light":"#9e9180","dark":"#8d7e6b"},"--dsw-alias-border-l3":{"light":"#d7cebf","dark":"#50483f"},"--dsw-alias-border-l4":{"light":"#9e9180","dark":"#8d7e6b"},"--dsw-alias-interactive-bg-hover":{"light":"#e7dfd1","dark":"#403930"},"--dsw-alias-interactive-bg-hover-solid":{"light":"#e7dfd1","dark":"#403930"},"--dsw-alias-interactive-bg-active":{"light":"#dfd4c3","dark":"#4b4033"},"--dsw-alias-interactive-bg-selected":{"light":"#dfd4c3","dark":"#4b4033"},"--dsw-alias-button-primary-fill":{"light":"#a64f35","dark":"#df9b7e"},"--dsw-alias-button-primary-hover":{"light":"#8e412a","dark":"#edb398"},"--dsw-alias-button-contrast-fill":{"light":"#a64f35","dark":"#df9b7e"},"--dsw-alias-button-floating-fill":{"light":"#fffdf7","dark":"#302d29"},"--dsw-alias-button-secondary-fill":{"light":"#eae3d6","dark":"#3b352e"},"--dsw-alias-markdown-code-block":{"light":"#eee7da","dark":"#211e1b"},"--dsw-alias-markdown-code-block-banner":{"light":"#faf6ed","dark":"#36322d"},"--dsw-alias-markdown-inline-code":{"light":"#eee7da","dark":"#211e1b"},"--dsw-alias-state-business-primary":{"light":"#a64f35","dark":"#df9b7e"},"--dsw-alias-state-business-secondary":{"light":"#dfd4c3","dark":"#4b4033"},"--dsw-alias-state-success-primary":{"light":"#3c6747","dark":"#aac19b"},"--dsw-alias-state-success-secondary":{"light":"#e5edde","dark":"#333c2e"},"--dsw-alias-state-warn-primary":{"light":"#865a17","dark":"#dcc087"},"--dsw-alias-state-warn-secondary":{"light":"#f2e6c9","dark":"#433923"},"--dsw-alias-state-error-primary":{"light":"#a33e37","dark":"#e7aaa0"},"--dsw-alias-state-error-secondary":{"light":"#f4e1da","dark":"#482f2b"},"--dsw-alias-state-idle-primary":{"light":"#625a50","dark":"#bdb2a3"},"--dsw-alias-toast-bg":{"light":"#fffdf7","dark":"#302d29"},"--dsw-alias-toast-label":{"light":"#302b25","dark":"#eee7db"},"--dsw-alias-tooltip-bg":{"light":"#3b332b","dark":"#e9dfce"},"--dsw-alias-tooltip-label":{"light":"#fff9ee","dark":"#302820"},"--dsw-alias-tooltip-key-bg":{"light":"#dfd4c3","dark":"#4b4033"},"--dsw-alias-bg-document-selection":{"light":"#e8ccb7","dark":"#675044"},"--dsw-alias-bg-selection":{"light":"#e8ccb7","dark":"#675044"},"--dsw-alias-scrollbar-thumb-l1":{"light":"#9e9180","dark":"#8d7e6b"},"--dsw-alias-scrollbar-thumb-l1-hover":{"light":"#625a50","dark":"#bdb2a3"},"--dsw-alias-scrollbar-thumb-l2":{"light":"#9e9180","dark":"#8d7e6b"},"--dsw-alias-scrollbar-thumb-l2-hover":{"light":"#625a50","dark":"#bdb2a3"},"--dsw-alias-label-deep-diving":{"light":"#a64f35","dark":"#df9b7e"},"--dsw-alias-label-deep-diving-shimmer":{"light":"#8e412a","dark":"#edb398"},"--dsw-alias-turn-trigger-bg":{"light":"#eae3d6","dark":"#3b352e"},"--dsw-alias-turn-trigger-bg-hover":{"light":"#e7dfd1","dark":"#403930"},"--dsw-alias-switch-thumb":{"light":"#fffdf7","dark":"#302d29"},"--dsw-specific-sidebar-fill":{"light":"#eee8db","dark":"#211f1d"},"--dsw-specific-sidebar-nav-item-active":{"light":"#dfd4c3","dark":"#4b4033"},"--dsw-specific-sidebar-nav-item-active-accent":{"light":"#dfd4c3","dark":"#4b4033"},"--dsw-specific-sidebar-nav-item-hover":{"light":"#e7dfd1","dark":"#403930"},"--dsw-specific-input-major":{"light":"#fffdf7","dark":"#302d29"},"--dsw-specific-login-input":{"light":"#fffdf7","dark":"#302d29"},"--dsw-specific-menu":{"light":"#fffdf7","dark":"#302d29"},"--dsw-specific-selector":{"light":"#faf6ed","dark":"#36322d"},"--dsw-specific-bubble":{"light":"#eae3d6","dark":"#3b352e"},"--dsw-specific-bubble-highlight":{"light":"#dfd4c3","dark":"#4b4033"},"--dsw-specific-tip":{"light":"#faf6ed","dark":"#36322d"},"--cp-canvas":{"light":"#f5f0e4","dark":"#262421"},"--cp-sidebar":{"light":"#eee8db","dark":"#211f1d"},"--cp-surface":{"light":"#fffdf7","dark":"#302d29"},"--cp-raised":{"light":"#faf6ed","dark":"#36322d"},"--cp-user":{"light":"#eae3d6","dark":"#3b352e"},"--cp-hover":{"light":"#e7dfd1","dark":"#403930"},"--cp-selected":{"light":"#dfd4c3","dark":"#4b4033"},"--cp-text":{"light":"#302b25","dark":"#eee7db"},"--cp-secondary":{"light":"#625a50","dark":"#bdb2a3"},"--cp-muted":{"light":"#63594d","dark":"#b9ae9e"},"--cp-border":{"light":"#d7cebf","dark":"#50483f"},"--cp-strongBorder":{"light":"#9e9180","dark":"#8d7e6b"},"--cp-accent":{"light":"#a64f35","dark":"#df9b7e"},"--cp-accentHover":{"light":"#8e412a","dark":"#edb398"},"--cp-onAccent":{"light":"#fffdf7","dark":"#262421"},"--cp-link":{"light":"#795133","dark":"#d9b792"},"--cp-success":{"light":"#3c6747","dark":"#aac19b"},"--cp-warning":{"light":"#865a17","dark":"#dcc087"},"--cp-danger":{"light":"#a33e37","dark":"#e7aaa0"},"--cp-successFill":{"light":"#e5edde","dark":"#333c2e"},"--cp-warningFill":{"light":"#f2e6c9","dark":"#433923"},"--cp-dangerFill":{"light":"#f4e1da","dark":"#482f2b"},"--cp-selection":{"light":"#e8ccb7","dark":"#675044"},"--cp-code":{"light":"#eee7da","dark":"#211e1b"},"--cp-tooltip":{"light":"#3b332b","dark":"#e9dfce"},"--cp-tooltipText":{"light":"#fff9ee","dark":"#302820"},"--cp-constant":{"light":"#366379","dark":"#a5c4d2"},"--cp-string":{"light":"#486442","dark":"#b4c89a"},"--cp-keyword":{"light":"#8c465b","dark":"#dcadb9"},"--cp-function":{"light":"#755181","dark":"#c9b4d6"},"--dsw-focus-ring-color":{"light":"#a64f35","dark":"#df9b7e"},"--dsw-menu-surface-fill":{"light":"#fffdf7","dark":"#302d29"},"--dsw-alias-menu-group-header-fill":{"light":"#fffdf7","dark":"#302d29"},"--shiki-token-constant":{"light":"#366379","dark":"#a5c4d2"},"--shiki-token-string":{"light":"#486442","dark":"#b4c89a"},"--shiki-token-string-expression":{"light":"#486442","dark":"#b4c89a"},"--shiki-token-keyword":{"light":"#8c465b","dark":"#dcadb9"},"--shiki-token-function":{"light":"#755181","dark":"#c9b4d6"},"--shiki-token-parameter":{"light":"#a64f35","dark":"#df9b7e"},"--shiki-token-comment":{"light":"#63594d","dark":"#b9ae9e"},"--shiki-token-punctuation":{"light":"#625a50","dark":"#bdb2a3"},"--shiki-token-link":{"light":"#795133","dark":"#d9b792"}},"robinhood":{"--dsw-alias-bg-base":{"light":"#f7f9f5","dark":"#0e110d"},"--dsw-alias-bg-overlay":{"light":"#ffffff","dark":"#171c15"},"--dsw-alias-bg-layer-1":{"light":"#ffffff","dark":"#171c15"},"--dsw-alias-bg-layer-2":{"light":"#f0f2f4","dark":"#1e251b"},"--dsw-alias-bg-layer-3":{"light":"#f0f2f4","dark":"#1e251b"},"--dsw-alias-bg-document-preview":{"light":"#f7f9f5","dark":"#0e110d"},"--dsw-alias-label-document-preview":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary-bluish":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary-dimmed":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-secondary":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-tertiary":{"light":"#4d5b62","dark":"#a6b4bd"},"--dsw-alias-label-caption":{"light":"#4d5b62","dark":"#a6b4bd"},"--dsw-alias-label-primary-foreground":{"light":"#ffffff","dark":"#131c08"},"--dsw-alias-label-link":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-link":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-brand-primary":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-brand-text":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-menu-icon":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-border-l1":{"light":"#cbd3d8","dark":"#323e2b"},"--dsw-alias-border-l2":{"light":"#7a878f","dark":"#74866a"},"--dsw-alias-border-l3":{"light":"#cbd3d8","dark":"#323e2b"},"--dsw-alias-border-l4":{"light":"#7a878f","dark":"#74866a"},"--dsw-alias-interactive-bg-hover":{"light":"#e4ecd8","dark":"#293323"},"--dsw-alias-interactive-bg-hover-solid":{"light":"#e4ecd8","dark":"#293323"},"--dsw-alias-interactive-bg-active":{"light":"#dce8cb","dark":"#2b3822"},"--dsw-alias-interactive-bg-selected":{"light":"#dce8cb","dark":"#2b3822"},"--dsw-alias-button-primary-fill":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-button-primary-hover":{"light":"#27560d","dark":"#c9ff63"},"--dsw-alias-button-contrast-fill":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-button-floating-fill":{"light":"#ffffff","dark":"#171c15"},"--dsw-alias-button-secondary-fill":{"light":"#e9efdf","dark":"#222b1e"},"--dsw-alias-markdown-code-block":{"light":"#edf1f3","dark":"#0b1009"},"--dsw-alias-markdown-code-block-banner":{"light":"#f0f2f4","dark":"#1e251b"},"--dsw-alias-markdown-inline-code":{"light":"#edf1f3","dark":"#0b1009"},"--dsw-alias-state-business-primary":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-state-business-secondary":{"light":"#dce8cb","dark":"#2b3822"},"--dsw-alias-state-success-primary":{"light":"#146747","dark":"#64d6a1"},"--dsw-alias-state-success-secondary":{"light":"#e1f2e9","dark":"#16382a"},"--dsw-alias-state-warn-primary":{"light":"#825900","dark":"#f4cb71"},"--dsw-alias-state-warn-secondary":{"light":"#faf0d4","dark":"#3c311b"},"--dsw-alias-state-error-primary":{"light":"#b33349","dark":"#ff8b9e"},"--dsw-alias-state-error-secondary":{"light":"#fbe8ec","dark":"#40242b"},"--dsw-alias-state-idle-primary":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-toast-bg":{"light":"#ffffff","dark":"#171c15"},"--dsw-alias-toast-label":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-tooltip-bg":{"light":"#172126","dark":"#e5edf1"},"--dsw-alias-tooltip-label":{"light":"#f5f8fa","dark":"#162026"},"--dsw-alias-tooltip-key-bg":{"light":"#dce8cb","dark":"#2b3822"},"--dsw-alias-bg-document-selection":{"light":"#d1e8b7","dark":"#354d1e"},"--dsw-alias-bg-selection":{"light":"#d1e8b7","dark":"#354d1e"},"--dsw-alias-scrollbar-thumb-l1":{"light":"#7a878f","dark":"#74866a"},"--dsw-alias-scrollbar-thumb-l1-hover":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-scrollbar-thumb-l2":{"light":"#7a878f","dark":"#74866a"},"--dsw-alias-scrollbar-thumb-l2-hover":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-deep-diving":{"light":"#326b12","dark":"#b6f337"},"--dsw-alias-label-deep-diving-shimmer":{"light":"#27560d","dark":"#c9ff63"},"--dsw-alias-turn-trigger-bg":{"light":"#e9efdf","dark":"#222b1e"},"--dsw-alias-turn-trigger-bg-hover":{"light":"#e4ecd8","dark":"#293323"},"--dsw-alias-switch-thumb":{"light":"#ffffff","dark":"#171c15"},"--dsw-specific-sidebar-fill":{"light":"#eef2e9","dark":"#0a0d09"},"--dsw-specific-sidebar-nav-item-active":{"light":"#dce8cb","dark":"#2b3822"},"--dsw-specific-sidebar-nav-item-active-accent":{"light":"#dce8cb","dark":"#2b3822"},"--dsw-specific-sidebar-nav-item-hover":{"light":"#e4ecd8","dark":"#293323"},"--dsw-specific-input-major":{"light":"#ffffff","dark":"#171c15"},"--dsw-specific-login-input":{"light":"#ffffff","dark":"#171c15"},"--dsw-specific-menu":{"light":"#ffffff","dark":"#171c15"},"--dsw-specific-selector":{"light":"#f0f2f4","dark":"#1e251b"},"--dsw-specific-bubble":{"light":"#e9efdf","dark":"#222b1e"},"--dsw-specific-bubble-highlight":{"light":"#dce8cb","dark":"#2b3822"},"--dsw-specific-tip":{"light":"#f0f2f4","dark":"#1e251b"},"--cp-canvas":{"light":"#f7f9f5","dark":"#0e110d"},"--cp-sidebar":{"light":"#eef2e9","dark":"#0a0d09"},"--cp-surface":{"light":"#ffffff","dark":"#171c15"},"--cp-raised":{"light":"#f0f2f4","dark":"#1e251b"},"--cp-user":{"light":"#e9efdf","dark":"#222b1e"},"--cp-hover":{"light":"#e4ecd8","dark":"#293323"},"--cp-selected":{"light":"#dce8cb","dark":"#2b3822"},"--cp-text":{"light":"#172126","dark":"#edf2f5"},"--cp-secondary":{"light":"#46535b","dark":"#b6c2ca"},"--cp-muted":{"light":"#4d5b62","dark":"#a6b4bd"},"--cp-border":{"light":"#cbd3d8","dark":"#323e2b"},"--cp-strongBorder":{"light":"#7a878f","dark":"#74866a"},"--cp-accent":{"light":"#326b12","dark":"#b6f337"},"--cp-accentHover":{"light":"#27560d","dark":"#c9ff63"},"--cp-onAccent":{"light":"#ffffff","dark":"#131c08"},"--cp-link":{"light":"#326b12","dark":"#b6f337"},"--cp-success":{"light":"#146747","dark":"#64d6a1"},"--cp-warning":{"light":"#825900","dark":"#f4cb71"},"--cp-danger":{"light":"#b33349","dark":"#ff8b9e"},"--cp-successFill":{"light":"#e1f2e9","dark":"#16382a"},"--cp-warningFill":{"light":"#faf0d4","dark":"#3c311b"},"--cp-dangerFill":{"light":"#fbe8ec","dark":"#40242b"},"--cp-selection":{"light":"#d1e8b7","dark":"#354d1e"},"--cp-code":{"light":"#edf1f3","dark":"#0b1009"},"--cp-tooltip":{"light":"#172126","dark":"#e5edf1"},"--cp-tooltipText":{"light":"#f5f8fa","dark":"#162026"},"--cp-constant":{"light":"#2a586f","dark":"#94c9e3"},"--cp-string":{"light":"#226244","dark":"#8dd9ac"},"--cp-keyword":{"light":"#865080","dark":"#e0a7cd"},"--cp-function":{"light":"#5354a0","dark":"#b4b9ff"},"--dsw-focus-ring-color":{"light":"#326b12","dark":"#b6f337"},"--dsw-menu-surface-fill":{"light":"#ffffff","dark":"#171c15"},"--dsw-alias-menu-group-header-fill":{"light":"#ffffff","dark":"#171c15"},"--shiki-token-constant":{"light":"#2a586f","dark":"#94c9e3"},"--shiki-token-string":{"light":"#226244","dark":"#8dd9ac"},"--shiki-token-string-expression":{"light":"#226244","dark":"#8dd9ac"},"--shiki-token-keyword":{"light":"#865080","dark":"#e0a7cd"},"--shiki-token-function":{"light":"#5354a0","dark":"#b4b9ff"},"--shiki-token-parameter":{"light":"#326b12","dark":"#b6f337"},"--shiki-token-comment":{"light":"#4d5b62","dark":"#a6b4bd"},"--shiki-token-punctuation":{"light":"#46535b","dark":"#b6c2ca"},"--shiki-token-link":{"light":"#326b12","dark":"#b6f337"}},"binance":{"--dsw-alias-bg-base":{"light":"#faf9f6","dark":"#181a20"},"--dsw-alias-bg-overlay":{"light":"#ffffff","dark":"#20232b"},"--dsw-alias-bg-layer-1":{"light":"#ffffff","dark":"#20232b"},"--dsw-alias-bg-layer-2":{"light":"#f0f2f4","dark":"#292d36"},"--dsw-alias-bg-layer-3":{"light":"#f0f2f4","dark":"#292d36"},"--dsw-alias-bg-document-preview":{"light":"#faf9f6","dark":"#181a20"},"--dsw-alias-label-document-preview":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary-bluish":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary-dimmed":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-secondary":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-tertiary":{"light":"#4d5b62","dark":"#a6b4bd"},"--dsw-alias-label-caption":{"light":"#4d5b62","dark":"#a6b4bd"},"--dsw-alias-label-primary-foreground":{"light":"#ffffff","dark":"#181a20"},"--dsw-alias-label-link":{"light":"#805c00","dark":"#f0c94d"},"--dsw-alias-link":{"light":"#805c00","dark":"#f0c94d"},"--dsw-alias-brand-primary":{"light":"#805c00","dark":"#f0b90b"},"--dsw-alias-brand-text":{"light":"#805c00","dark":"#f0b90b"},"--dsw-alias-menu-icon":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-border-l1":{"light":"#cbd3d8","dark":"#3a404b"},"--dsw-alias-border-l2":{"light":"#7a878f","dark":"#7b8596"},"--dsw-alias-border-l3":{"light":"#cbd3d8","dark":"#3a404b"},"--dsw-alias-border-l4":{"light":"#7a878f","dark":"#7b8596"},"--dsw-alias-interactive-bg-hover":{"light":"#eae6d9","dark":"#303640"},"--dsw-alias-interactive-bg-hover-solid":{"light":"#eae6d9","dark":"#303640"},"--dsw-alias-interactive-bg-active":{"light":"#e7e0cb","dark":"#35392f"},"--dsw-alias-interactive-bg-selected":{"light":"#e7e0cb","dark":"#35392f"},"--dsw-alias-button-primary-fill":{"light":"#805c00","dark":"#f0b90b"},"--dsw-alias-button-primary-hover":{"light":"#684b00","dark":"#ffd047"},"--dsw-alias-button-contrast-fill":{"light":"#805c00","dark":"#f0b90b"},"--dsw-alias-button-floating-fill":{"light":"#ffffff","dark":"#20232b"},"--dsw-alias-button-secondary-fill":{"light":"#eeeadf","dark":"#2b3039"},"--dsw-alias-markdown-code-block":{"light":"#edf1f3","dark":"#14171d"},"--dsw-alias-markdown-code-block-banner":{"light":"#f0f2f4","dark":"#292d36"},"--dsw-alias-markdown-inline-code":{"light":"#edf1f3","dark":"#14171d"},"--dsw-alias-state-business-primary":{"light":"#805c00","dark":"#f0b90b"},"--dsw-alias-state-business-secondary":{"light":"#e7e0cb","dark":"#35392f"},"--dsw-alias-state-success-primary":{"light":"#146747","dark":"#64d6a1"},"--dsw-alias-state-success-secondary":{"light":"#e1f2e9","dark":"#16382a"},"--dsw-alias-state-warn-primary":{"light":"#825900","dark":"#f4cb71"},"--dsw-alias-state-warn-secondary":{"light":"#faf0d4","dark":"#3c311b"},"--dsw-alias-state-error-primary":{"light":"#b33349","dark":"#ff8b9e"},"--dsw-alias-state-error-secondary":{"light":"#fbe8ec","dark":"#40242b"},"--dsw-alias-state-idle-primary":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-toast-bg":{"light":"#ffffff","dark":"#20232b"},"--dsw-alias-toast-label":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-tooltip-bg":{"light":"#172126","dark":"#e5edf1"},"--dsw-alias-tooltip-label":{"light":"#f5f8fa","dark":"#162026"},"--dsw-alias-tooltip-key-bg":{"light":"#e7e0cb","dark":"#35392f"},"--dsw-alias-bg-document-selection":{"light":"#f1dfa9","dark":"#514526"},"--dsw-alias-bg-selection":{"light":"#f1dfa9","dark":"#514526"},"--dsw-alias-scrollbar-thumb-l1":{"light":"#7a878f","dark":"#7b8596"},"--dsw-alias-scrollbar-thumb-l1-hover":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-scrollbar-thumb-l2":{"light":"#7a878f","dark":"#7b8596"},"--dsw-alias-scrollbar-thumb-l2-hover":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-deep-diving":{"light":"#805c00","dark":"#f0b90b"},"--dsw-alias-label-deep-diving-shimmer":{"light":"#684b00","dark":"#ffd047"},"--dsw-alias-turn-trigger-bg":{"light":"#eeeadf","dark":"#2b3039"},"--dsw-alias-turn-trigger-bg-hover":{"light":"#eae6d9","dark":"#303640"},"--dsw-alias-switch-thumb":{"light":"#ffffff","dark":"#20232b"},"--dsw-specific-sidebar-fill":{"light":"#f0eee7","dark":"#111318"},"--dsw-specific-sidebar-nav-item-active":{"light":"#e7e0cb","dark":"#35392f"},"--dsw-specific-sidebar-nav-item-active-accent":{"light":"#e7e0cb","dark":"#35392f"},"--dsw-specific-sidebar-nav-item-hover":{"light":"#eae6d9","dark":"#303640"},"--dsw-specific-input-major":{"light":"#ffffff","dark":"#20232b"},"--dsw-specific-login-input":{"light":"#ffffff","dark":"#20232b"},"--dsw-specific-menu":{"light":"#ffffff","dark":"#20232b"},"--dsw-specific-selector":{"light":"#f0f2f4","dark":"#292d36"},"--dsw-specific-bubble":{"light":"#eeeadf","dark":"#2b3039"},"--dsw-specific-bubble-highlight":{"light":"#e7e0cb","dark":"#35392f"},"--dsw-specific-tip":{"light":"#f0f2f4","dark":"#292d36"},"--cp-canvas":{"light":"#faf9f6","dark":"#181a20"},"--cp-sidebar":{"light":"#f0eee7","dark":"#111318"},"--cp-surface":{"light":"#ffffff","dark":"#20232b"},"--cp-raised":{"light":"#f0f2f4","dark":"#292d36"},"--cp-user":{"light":"#eeeadf","dark":"#2b3039"},"--cp-hover":{"light":"#eae6d9","dark":"#303640"},"--cp-selected":{"light":"#e7e0cb","dark":"#35392f"},"--cp-text":{"light":"#172126","dark":"#edf2f5"},"--cp-secondary":{"light":"#46535b","dark":"#b6c2ca"},"--cp-muted":{"light":"#4d5b62","dark":"#a6b4bd"},"--cp-border":{"light":"#cbd3d8","dark":"#3a404b"},"--cp-strongBorder":{"light":"#7a878f","dark":"#7b8596"},"--cp-accent":{"light":"#805c00","dark":"#f0b90b"},"--cp-accentHover":{"light":"#684b00","dark":"#ffd047"},"--cp-onAccent":{"light":"#ffffff","dark":"#181a20"},"--cp-link":{"light":"#805c00","dark":"#f0c94d"},"--cp-success":{"light":"#146747","dark":"#64d6a1"},"--cp-warning":{"light":"#825900","dark":"#f4cb71"},"--cp-danger":{"light":"#b33349","dark":"#ff8b9e"},"--cp-successFill":{"light":"#e1f2e9","dark":"#16382a"},"--cp-warningFill":{"light":"#faf0d4","dark":"#3c311b"},"--cp-dangerFill":{"light":"#fbe8ec","dark":"#40242b"},"--cp-selection":{"light":"#f1dfa9","dark":"#514526"},"--cp-code":{"light":"#edf1f3","dark":"#14171d"},"--cp-tooltip":{"light":"#172126","dark":"#e5edf1"},"--cp-tooltipText":{"light":"#f5f8fa","dark":"#162026"},"--cp-constant":{"light":"#2a586f","dark":"#94c9e3"},"--cp-string":{"light":"#226244","dark":"#8dd9ac"},"--cp-keyword":{"light":"#865080","dark":"#e0a7cd"},"--cp-function":{"light":"#5354a0","dark":"#b4b9ff"},"--dsw-focus-ring-color":{"light":"#805c00","dark":"#f0b90b"},"--dsw-menu-surface-fill":{"light":"#ffffff","dark":"#20232b"},"--dsw-alias-menu-group-header-fill":{"light":"#ffffff","dark":"#20232b"},"--shiki-token-constant":{"light":"#2a586f","dark":"#94c9e3"},"--shiki-token-string":{"light":"#226244","dark":"#8dd9ac"},"--shiki-token-string-expression":{"light":"#226244","dark":"#8dd9ac"},"--shiki-token-keyword":{"light":"#865080","dark":"#e0a7cd"},"--shiki-token-function":{"light":"#5354a0","dark":"#b4b9ff"},"--shiki-token-parameter":{"light":"#805c00","dark":"#f0b90b"},"--shiki-token-comment":{"light":"#4d5b62","dark":"#a6b4bd"},"--shiki-token-punctuation":{"light":"#46535b","dark":"#b6c2ca"},"--shiki-token-link":{"light":"#805c00","dark":"#f0c94d"}},"bitget":{"--dsw-alias-bg-base":{"light":"#f4f9fa","dark":"#0b1215"},"--dsw-alias-bg-overlay":{"light":"#ffffff","dark":"#131f24"},"--dsw-alias-bg-layer-1":{"light":"#ffffff","dark":"#131f24"},"--dsw-alias-bg-layer-2":{"light":"#f0f2f4","dark":"#1a2a30"},"--dsw-alias-bg-layer-3":{"light":"#f0f2f4","dark":"#1a2a30"},"--dsw-alias-bg-document-preview":{"light":"#f4f9fa","dark":"#0b1215"},"--dsw-alias-label-document-preview":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary-bluish":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-label-primary-dimmed":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-secondary":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-tertiary":{"light":"#4d5b62","dark":"#a6b4bd"},"--dsw-alias-label-caption":{"light":"#4d5b62","dark":"#a6b4bd"},"--dsw-alias-label-primary-foreground":{"light":"#ffffff","dark":"#092025"},"--dsw-alias-label-link":{"light":"#006873","dark":"#69e0e9"},"--dsw-alias-link":{"light":"#006873","dark":"#69e0e9"},"--dsw-alias-brand-primary":{"light":"#006873","dark":"#47dce6"},"--dsw-alias-brand-text":{"light":"#006873","dark":"#47dce6"},"--dsw-alias-menu-icon":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-border-l1":{"light":"#cbd3d8","dark":"#2d424b"},"--dsw-alias-border-l2":{"light":"#7a878f","dark":"#708d98"},"--dsw-alias-border-l3":{"light":"#cbd3d8","dark":"#2d424b"},"--dsw-alias-border-l4":{"light":"#7a878f","dark":"#708d98"},"--dsw-alias-interactive-bg-hover":{"light":"#daeaed","dark":"#23363e"},"--dsw-alias-interactive-bg-hover-solid":{"light":"#daeaed","dark":"#23363e"},"--dsw-alias-interactive-bg-active":{"light":"#d2e5e9","dark":"#233a42"},"--dsw-alias-interactive-bg-selected":{"light":"#d2e5e9","dark":"#233a42"},"--dsw-alias-button-primary-fill":{"light":"#006873","dark":"#47dce6"},"--dsw-alias-button-primary-hover":{"light":"#005560","dark":"#7aeaf1"},"--dsw-alias-button-contrast-fill":{"light":"#006873","dark":"#47dce6"},"--dsw-alias-button-floating-fill":{"light":"#ffffff","dark":"#131f24"},"--dsw-alias-button-secondary-fill":{"light":"#e1edef","dark":"#1d2e35"},"--dsw-alias-markdown-code-block":{"light":"#edf1f3","dark":"#080f13"},"--dsw-alias-markdown-code-block-banner":{"light":"#f0f2f4","dark":"#1a2a30"},"--dsw-alias-markdown-inline-code":{"light":"#edf1f3","dark":"#080f13"},"--dsw-alias-state-business-primary":{"light":"#006873","dark":"#47dce6"},"--dsw-alias-state-business-secondary":{"light":"#d2e5e9","dark":"#233a42"},"--dsw-alias-state-success-primary":{"light":"#146747","dark":"#64d6a1"},"--dsw-alias-state-success-secondary":{"light":"#e1f2e9","dark":"#16382a"},"--dsw-alias-state-warn-primary":{"light":"#825900","dark":"#f4cb71"},"--dsw-alias-state-warn-secondary":{"light":"#faf0d4","dark":"#3c311b"},"--dsw-alias-state-error-primary":{"light":"#b33349","dark":"#ff8b9e"},"--dsw-alias-state-error-secondary":{"light":"#fbe8ec","dark":"#40242b"},"--dsw-alias-state-idle-primary":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-toast-bg":{"light":"#ffffff","dark":"#131f24"},"--dsw-alias-toast-label":{"light":"#172126","dark":"#edf2f5"},"--dsw-alias-tooltip-bg":{"light":"#172126","dark":"#e5edf1"},"--dsw-alias-tooltip-label":{"light":"#f5f8fa","dark":"#162026"},"--dsw-alias-tooltip-key-bg":{"light":"#d2e5e9","dark":"#233a42"},"--dsw-alias-bg-document-selection":{"light":"#b9e7ec","dark":"#1b5059"},"--dsw-alias-bg-selection":{"light":"#b9e7ec","dark":"#1b5059"},"--dsw-alias-scrollbar-thumb-l1":{"light":"#7a878f","dark":"#708d98"},"--dsw-alias-scrollbar-thumb-l1-hover":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-scrollbar-thumb-l2":{"light":"#7a878f","dark":"#708d98"},"--dsw-alias-scrollbar-thumb-l2-hover":{"light":"#46535b","dark":"#b6c2ca"},"--dsw-alias-label-deep-diving":{"light":"#006873","dark":"#47dce6"},"--dsw-alias-label-deep-diving-shimmer":{"light":"#005560","dark":"#7aeaf1"},"--dsw-alias-turn-trigger-bg":{"light":"#e1edef","dark":"#1d2e35"},"--dsw-alias-turn-trigger-bg-hover":{"light":"#daeaed","dark":"#23363e"},"--dsw-alias-switch-thumb":{"light":"#ffffff","dark":"#131f24"},"--dsw-specific-sidebar-fill":{"light":"#e9f1f3","dark":"#080e11"},"--dsw-specific-sidebar-nav-item-active":{"light":"#d2e5e9","dark":"#233a42"},"--dsw-specific-sidebar-nav-item-active-accent":{"light":"#d2e5e9","dark":"#233a42"},"--dsw-specific-sidebar-nav-item-hover":{"light":"#daeaed","dark":"#23363e"},"--dsw-specific-input-major":{"light":"#ffffff","dark":"#131f24"},"--dsw-specific-login-input":{"light":"#ffffff","dark":"#131f24"},"--dsw-specific-menu":{"light":"#ffffff","dark":"#131f24"},"--dsw-specific-selector":{"light":"#f0f2f4","dark":"#1a2a30"},"--dsw-specific-bubble":{"light":"#e1edef","dark":"#1d2e35"},"--dsw-specific-bubble-highlight":{"light":"#d2e5e9","dark":"#233a42"},"--dsw-specific-tip":{"light":"#f0f2f4","dark":"#1a2a30"},"--cp-canvas":{"light":"#f4f9fa","dark":"#0b1215"},"--cp-sidebar":{"light":"#e9f1f3","dark":"#080e11"},"--cp-surface":{"light":"#ffffff","dark":"#131f24"},"--cp-raised":{"light":"#f0f2f4","dark":"#1a2a30"},"--cp-user":{"light":"#e1edef","dark":"#1d2e35"},"--cp-hover":{"light":"#daeaed","dark":"#23363e"},"--cp-selected":{"light":"#d2e5e9","dark":"#233a42"},"--cp-text":{"light":"#172126","dark":"#edf2f5"},"--cp-secondary":{"light":"#46535b","dark":"#b6c2ca"},"--cp-muted":{"light":"#4d5b62","dark":"#a6b4bd"},"--cp-border":{"light":"#cbd3d8","dark":"#2d424b"},"--cp-strongBorder":{"light":"#7a878f","dark":"#708d98"},"--cp-accent":{"light":"#006873","dark":"#47dce6"},"--cp-accentHover":{"light":"#005560","dark":"#7aeaf1"},"--cp-onAccent":{"light":"#ffffff","dark":"#092025"},"--cp-link":{"light":"#006873","dark":"#69e0e9"},"--cp-success":{"light":"#146747","dark":"#64d6a1"},"--cp-warning":{"light":"#825900","dark":"#f4cb71"},"--cp-danger":{"light":"#b33349","dark":"#ff8b9e"},"--cp-successFill":{"light":"#e1f2e9","dark":"#16382a"},"--cp-warningFill":{"light":"#faf0d4","dark":"#3c311b"},"--cp-dangerFill":{"light":"#fbe8ec","dark":"#40242b"},"--cp-selection":{"light":"#b9e7ec","dark":"#1b5059"},"--cp-code":{"light":"#edf1f3","dark":"#080f13"},"--cp-tooltip":{"light":"#172126","dark":"#e5edf1"},"--cp-tooltipText":{"light":"#f5f8fa","dark":"#162026"},"--cp-constant":{"light":"#2a586f","dark":"#94c9e3"},"--cp-string":{"light":"#226244","dark":"#8dd9ac"},"--cp-keyword":{"light":"#865080","dark":"#e0a7cd"},"--cp-function":{"light":"#5354a0","dark":"#b4b9ff"},"--dsw-focus-ring-color":{"light":"#006873","dark":"#47dce6"},"--dsw-menu-surface-fill":{"light":"#ffffff","dark":"#131f24"},"--dsw-alias-menu-group-header-fill":{"light":"#ffffff","dark":"#131f24"},"--shiki-token-constant":{"light":"#2a586f","dark":"#94c9e3"},"--shiki-token-string":{"light":"#226244","dark":"#8dd9ac"},"--shiki-token-string-expression":{"light":"#226244","dark":"#8dd9ac"},"--shiki-token-keyword":{"light":"#865080","dark":"#e0a7cd"},"--shiki-token-function":{"light":"#5354a0","dark":"#b4b9ff"},"--shiki-token-parameter":{"light":"#006873","dark":"#47dce6"},"--shiki-token-comment":{"light":"#4d5b62","dark":"#a6b4bd"},"--shiki-token-punctuation":{"light":"#46535b","dark":"#b6c2ca"},"--shiki-token-link":{"light":"#006873","dark":"#69e0e9"}}};
    const themeOptions = [{"id":"parchment","swatches":{"light":["#f5f0e4","#fffdf7","#a64f35","#302b25"],"dark":["#262421","#302d29","#df9b7e","#eee7db"]}},{"id":"robinhood","swatches":{"light":["#f7f9f5","#ffffff","#326b12","#172126"],"dark":["#0e110d","#171c15","#b6f337","#edf2f5"]}},{"id":"binance","swatches":{"light":["#faf9f6","#ffffff","#805c00","#172126"],"dark":["#181a20","#20232b","#f0b90b","#edf2f5"]}},{"id":"bitget","swatches":{"light":["#f4f9fa","#ffffff","#006873","#172126"],"dark":["#0b1215","#131f24","#47dce6","#edf2f5"]}}];
    const STORAGE_KEY = 'dsh.claude-parchment.v1';
/** Own one theme layer, a scoped stylesheet, and one local preference. */
function createRuntime(ctx, css, tokens) {
  const root = document.documentElement;
  const listeners = new Set();
  let disposed = false;
  let retract;
  let syncing = false;
  let enabled = false;
  let theme = 'parchment';
  let appliedTheme;
  const validTheme = value => typeof value === 'string' && Object.hasOwn(tokens, value) ? value : 'parchment';
  let error = '';
  const read = () => {
    try {
      const preference = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      enabled = preference?.enabled === true;
      theme = validTheme(preference?.theme);
      error = '';
    } catch (cause) {
      enabled = false;
      theme = 'parchment';
      error = 'storageRead';
    }
  };
  read();
  const style = document.createElement('style');
  style.dataset.claudeParchmentStyle = '';
  style.textContent = css;
  document.head.append(style);
  const snapshot = () => ({ enabled, theme, active: !!retract, error,
    mode: ctx.theme.getTheme().active.colorScheme });
  let state = snapshot();
  const notify = () => {
    state = snapshot();
    for (const listener of listeners) listener();
  };
  const sync = () => {
    if (disposed || syncing) return;
    syncing = true;
    try {
      const wanted = enabled;
      if (retract && (!wanted || appliedTheme !== theme)) {
        const remove = retract;
        retract = undefined;
        appliedTheme = undefined;
        remove();
      }
      if (wanted && !retract) {
        root.setAttribute('data-cp-active', '');
        root.setAttribute('data-cp-theme', theme);
        retract = ctx.theme.overrideTokens('dsh-claude-parchment', tokens[theme]);
        appliedTheme = theme;
      } else if (!wanted) {
        root.removeAttribute('data-cp-active');
        root.removeAttribute('data-cp-theme');
      }
      notify();
    } finally { syncing = false; }
  };
  const onStorage = event => {
    if (event.key === STORAGE_KEY || event.key === null) { read(); sync(); }
  };
  window.addEventListener('storage', onStorage);
  const offTheme = ctx.on('theme/change', sync);
  sync();
  const save = (nextEnabled, nextTheme) => {
    if (disposed) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: nextEnabled, theme: nextTheme })); }
    catch (cause) { error = 'storageWrite'; notify(); return; }
    enabled = nextEnabled;
    theme = nextTheme;
    error = '';
    sync();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled(value) {
      save(value === true, theme);
    },
    setTheme(value) { save(enabled, validTheme(value)); },
    dispose() {
      if (disposed) return;
      disposed = true;
      offTheme();
      window.removeEventListener('storage', onStorage);
      root.removeAttribute('data-cp-active');
      root.removeAttribute('data-cp-theme');
      const remove = retract;
      retract = undefined;
      remove?.();
      style.remove();
      listeners.clear();
    },
  };
}

    const PARCHMENT_PACKAGE = 'dsh-claude-parchment';

function releaseParts(version) {
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version || '') ? version.split('.').map(Number) : null;
}
function compareRelease(a, b) {
  const left = releaseParts(a), right = releaseParts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function unwrapAnswer(answer) {
  if (answer?.ok === true) return answer.value;
  throw new Error(answer?.error?.message || 'Invalid response from Harness');
}

/** Uses the official installer only; the compiled version describes this running bundle. */
function createUpdater(getManager, loadedVersion) {
  let disposed = false;
  let state = { loadedVersion, installedVersion: null, phase: 'idle', message: '', detail: '', failed: false, restart: false };
  const listeners = new Set();
  const publish = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const problem = (key, detail = '') => publish({ phase: 'idle', message: key, detail: String(detail).slice(-4000), failed: true });
  function manager() {
    const service = getManager();
    if (!service || typeof service.listBundles !== 'function' || typeof service.inspect !== 'function' || typeof service.installBundle !== 'function') return null;
    return service;
  }
  async function readInstalled(service) {
    const bundles = unwrapAnswer(await service.listBundles());
    if (!Array.isArray(bundles)) throw new Error('Invalid bundle list from Harness');
    const bundle = bundles.find(item => item.name === PARCHMENT_PACKAGE && item.installed);
    if (!bundle?.version || !releaseParts(bundle.version)) throw new Error('Harness did not report the installed plugin version');
    return bundle.version;
  }
  async function refresh() {
    if (disposed || state.phase !== 'idle') return;
    publish({ phase: 'checking', message: 'checking', detail: '', failed: false });
    try {
      const service = manager();
      if (!service) { publish({ installedVersion: null }); problem('updateUnavailable'); return; }
      const version = await readInstalled(service);
      publish({ installedVersion: version, phase: 'idle', restart: version !== loadedVersion,
        message: version === loadedVersion ? 'versionReady' : 'restartRequired', detail: '', failed: false });
    } catch (cause) { publish({ installedVersion: null }); problem('versionFailed', cause.message); }
  }
  async function install(input) {
    if (disposed || state.phase !== 'idle') return;
    const path = String(input || '').trim().replace(/^"(.*)"$/, '$1');
    const version = /(?:^|[\\/])dsh-claude-parchment-(\d{1,6}\.\d{1,6}\.\d{1,6})\.tgz$/.exec(path)?.[1];
    const absolute = /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(path) || path.startsWith('/');
    if (!absolute || !version || /[\r\n\0]/.test(path)) { problem('invalidPackage'); return; }
    publish({ phase: 'installing', message: 'installing', detail: '', failed: false });
    let installed = false;
    try {
      const service = manager();
      if (!service) { problem('updateUnavailable'); return; }
      // Re-read immediately before mutation, so another installation cannot leave a stale comparison.
      const current = await readInstalled(service);
      if (disposed) return;
      publish({ installedVersion: current, restart: current !== loadedVersion });
      if (compareRelease(version, current) === 0) { problem('alreadyInstalled'); return; }
      if (compareRelease(version, current) < 0 || compareRelease(version, loadedVersion) < 0) { problem('olderPackage'); return; }
      const inspection = unwrapAnswer(await service.inspect(path));
      if (disposed) return;
      if (inspection?.status !== 'accepted' || inspection.kind !== 'tarball') {
        problem('packageRefused', inspection?.reason || 'Invalid package inspection'); return;
      }
      const result = unwrapAnswer(await service.installBundle(path, { enabled: false }));
      if (!['applied', 'restart-required'].includes(result?.application) || result.packageResult?.exitCode || result.packageResult?.timedOut || result.pendingBuilds?.length || (result.bundle && result.bundle !== PARCHMENT_PACKAGE)) {
        problem('installFailed', result?.error?.diagnostic || result?.error?.message || result?.packageResult?.output || result?.application || 'Invalid install result'); return;
      }
      installed = true;
      // Existing bundles need a restart even when an installer reports a live application.
      publish({ restart: true, installedVersion: null });
      const actual = await readInstalled(service);
      if (actual !== version) { problem('installUnverified', `Expected ${version}; Harness reported ${actual}`); return; }
      publish({ installedVersion: actual, phase: 'idle', message: 'installComplete', detail: '', failed: false, restart: true });
    } catch (cause) { problem(installed ? 'installUnverified' : 'installFailed', cause.message); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, install,
    dispose() { disposed = true; listeners.clear(); },
  };
}

    const dictionaries = {
      zh: {
        title: '羊皮纸与交易主题', description: '温暖纸面，或简约交易终端。四套外观随通用设置切换明暗。',
        enable: '启用所选主题', disabled: '主题已关闭，保留当前外观。',
        chooseTheme: '选择主题', themeHelp: '切换后立即生效；关闭时只记住选择。',
        parchmentName: 'Claude 羊皮纸', parchmentDetail: '暖纸与陶土 · 衬线阅读',
        robinhoodName: 'Robinhood · 荧绿', robinhoodDetail: '直角与薄影 · 清爽直接',
        binanceName: '币安 · 石墨金', binanceDetail: '小圆角与短影 · 沉稳紧凑',
        bitgetName: 'Bitget · 冰青', bitgetDetail: '错角气泡与柔影 · 干净利落',
        activeTheme: '当前主题',
        activeLight: '日间 · 奶油羊皮纸', activeDark: '夜间 · 暖炭与旧纸',
        modeHelp: '切换日间 / 夜间：设置 → 通用 → 外观，选择浅色、深色或跟随系统。',
        storageRead: '无法读取本机主题偏好，已保持关闭。请检查浏览器存储权限。',
        storageWrite: '无法保存本机主题偏好，本次选择未生效。请检查浏览器存储权限后重试。',
        light: '日间', dark: '夜间',
        loadedVersion: '已加载版本', installedVersion: '已安装版本', versionUnknown: '尚未确认',
        checkVersion: '检查版本', manualUpdate: '手动更新', packagePath: '新版安装包路径',
        pathPlaceholder: '粘贴新版 tgz 安装包的完整路径', installUpdate: '安装更新', closeUpdate: '收起',
        updateHelp: '选择新版 dsh-claude-parchment-x.y.z.tgz 本地包。安装完成后，完全退出 Harness 并重新打开；“已加载版本”变为新版才表示生效。',
        checking: '正在读取已安装版本…', versionReady: '已加载与已安装版本一致。',
        restartRequired: '版本不一致：请完全退出 Harness 后重新打开，再检查已加载版本。',
        installing: '正在安装更新，请保持窗口打开。', installComplete: '新版已安装，请完全退出 Harness 后重新打开以生效。',
        updateUnavailable: '无法连接插件安装器。请在“设置 → 插件”中安装新版包，再重启 Harness；也可稍后检查版本。',
        versionFailed: '无法确认已安装版本。请重试“检查版本”，或到“设置 → 插件”查看。',
        invalidPackage: '请填写 dsh-claude-parchment-x.y.z.tgz 的完整绝对路径。',
        alreadyInstalled: '这个版本已经安装。若已加载版本不同，请完整重启 Harness。',
        olderPackage: '所选安装包版本较旧，请改用新版安装包。',
        packageRefused: '安装包无法使用。请检查文件是否存在、路径是否正确。',
        installFailed: '更新未完成。请查看下方原因；也可在“设置 → 插件”中重试。',
        installUnverified: '安装器已返回，但新版尚未确认。请检查版本，或在“设置 → 插件”核实后完整重启。',
      },
      en: {
        title: 'Parchment & Trading Themes', description: 'Warm paper or a minimal trading terminal. All four themes follow General appearance settings.',
        enable: 'Enable selected theme', disabled: 'Theme is off. Your current appearance is preserved.',
        chooseTheme: 'Choose a theme', themeHelp: 'Applies immediately when enabled; remembers your choice when off.',
        parchmentName: 'Claude Parchment', parchmentDetail: 'Warm paper & terracotta · Serif reading',
        robinhoodName: 'Robinhood · Lime', robinhoodDetail: 'Square corners & thin shadows · Direct',
        binanceName: 'Binance · Gold', binanceDetail: 'Small corners & short shadows · Compact',
        bitgetName: 'Bitget · Cyan', bitgetDetail: 'Asymmetric bubbles & soft shadows · Clean',
        activeTheme: 'Active theme',
        activeLight: 'Light · Cream parchment', activeDark: 'Dark · Warm charcoal and old paper',
        modeHelp: 'Switch modes in Settings → General → Appearance: Light, Dark, or System.',
        storageRead: 'Could not read the local preference. The theme is off. Check browser storage permissions.',
        storageWrite: 'Could not save the local preference. This change was not applied. Check browser storage permissions and retry.',
        light: 'Light', dark: 'Dark',
        loadedVersion: 'Loaded version', installedVersion: 'Installed version', versionUnknown: 'Not confirmed',
        checkVersion: 'Check version', manualUpdate: 'Manual update', packagePath: 'New package path',
        pathPlaceholder: 'Paste the full path to the new tgz package', installUpdate: 'Install update', closeUpdate: 'Close',
        updateHelp: 'Choose a local dsh-claude-parchment-x.y.z.tgz package. Fully quit and reopen Harness after installation. The loaded version confirms which release is active.',
        checking: 'Reading the installed version…', versionReady: 'Loaded and installed versions match.',
        restartRequired: 'Versions differ. Fully quit and reopen Harness, then check the loaded version.',
        installing: 'Installing the update. Keep this window open.', installComplete: 'New version installed. Fully quit and reopen Harness to activate it.',
        updateUnavailable: 'The plugin installer is unavailable. Install the package in Settings → Plugins and restart Harness, or check the version again later.',
        versionFailed: 'Could not confirm the installed version. Retry Check version or view Settings → Plugins.',
        invalidPackage: 'Enter the full absolute path to a dsh-claude-parchment-x.y.z.tgz package.',
        alreadyInstalled: 'This version is already installed. Restart Harness fully if the loaded version differs.',
        olderPackage: 'This package is older. Choose a newer release.',
        packageRefused: 'Cannot use this package. Check that the file exists and the path is correct.',
        installFailed: 'Update did not complete. See the reason below, or retry in Settings → Plugins.',
        installUnverified: 'The installer returned, but the new version is unconfirmed. Check the version or verify it in Settings → Plugins before restarting.',
      },
    };
    return {
      inject: ['theme', 'slots', 'locale'],
      apply(ctx) {
        let runtime, updater;
        ctx.effect(() => ctx.locale.register('claudeParchment', dictionaries));
        ctx.effect(() => { runtime = createRuntime(ctx, css, tokens); return () => runtime.dispose(); });
        ctx.effect(() => {
          // Cordis get() supports an optional service without suspending the theme when absent.
          updater = createUpdater(() => ctx.get('remote.pluginManager'), version);
          void updater.refresh();
          return () => updater.dispose();
        });
        function Settings({ t }) {
          const state = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
          const update = React.useSyncExternalStore(updater.subscribe, updater.getSnapshot);
          const [editingUpdate, setEditingUpdate] = React.useState(false);
          const [packagePath, setPackagePath] = React.useState('');
          const pathId = React.useId();
          const themeGroup = React.useId();
          const busy = update.phase !== 'idle';
          const status = !state.enabled ? 'disabled' : state.mode === 'dark' ? 'activeDark' : 'activeLight';
          return React.createElement('section', { 'data-cp-settings': '', 'aria-label': t('title') },
            React.createElement('div', { className: 'cp-heading' }, React.createElement('h2', null, t('title')),
              React.createElement('span', { className: 'cp-version', 'data-cp-loaded': '' }, `v${version}`)),
            React.createElement('p', { className: 'lc-embedded-description' }, t('description')),
            React.createElement('fieldset', { className: 'cp-themes', 'aria-describedby': `${themeGroup}-help` },
              React.createElement('legend', null, t('chooseTheme')),
              ...themeOptions.map(option => React.createElement('label', { key: option.id, className: 'cp-theme-option', 'data-selected': state.theme === option.id ? '' : undefined },
                React.createElement('input', { type: 'radio', name: themeGroup, value: option.id, checked: state.theme === option.id,
                  'aria-label': t(`${option.id}Name`), onChange: () => runtime.setTheme(option.id) }),
                React.createElement('span', { className: 'cp-theme-copy' },
                  React.createElement('span', { className: 'cp-theme-name' }, t(`${option.id}Name`)),
                  React.createElement('span', { className: 'cp-theme-detail' }, t(`${option.id}Detail`))),
                React.createElement('span', { className: 'cp-theme-colors', 'aria-hidden': true },
                  ...option.swatches[state.mode === 'dark' ? 'dark' : 'light'].map((color, index) =>
                    React.createElement('span', { key: index, style: { backgroundColor: color } }))))),
              React.createElement('p', { id: `${themeGroup}-help`, className: 'cp-theme-help' }, t('themeHelp'))),
            React.createElement('label', { className: 'cp-toggle' }, React.createElement('span', null, t('enable')),
              React.createElement('input', { type: 'checkbox', role: 'switch', checked: state.enabled, onChange: event => runtime.setEnabled(event.target.checked) })),
            React.createElement('p', { className: 'cp-status', role: 'status', 'aria-live': 'polite' },
              state.enabled && state.theme !== 'parchment' ? `${t('activeTheme')} · ${t(`${state.theme}Name`)} · ${t(state.mode === 'dark' ? 'dark' : 'light')}` : t(status)),
            state.error ? React.createElement('p', { role: 'alert' }, t(state.error)) : null,
            React.createElement('p', null, t('modeHelp')),
            React.createElement('div', { className: 'cp-update' },
              React.createElement('dl', { className: 'cp-versions' },
                React.createElement('dt', null, t('loadedVersion')), React.createElement('dd', null, `v${update.loadedVersion}`),
                React.createElement('dt', null, t('installedVersion')), React.createElement('dd', { 'data-cp-installed': '' }, update.installedVersion ? `v${update.installedVersion}` : t('versionUnknown'))),
              React.createElement('div', { 'aria-live': 'polite', 'aria-atomic': true, 'data-cp-update-status': '' },
                update.message ? React.createElement('p', { className: 'cp-update-message', role: update.failed ? 'alert' : undefined }, t(update.message)) : null,
                update.restart && update.message !== 'restartRequired' && update.message !== 'installComplete' ? React.createElement('p', { className: 'cp-update-message' }, t('restartRequired')) : null,
                update.detail ? React.createElement('pre', { className: 'cp-update-error' }, update.detail) : null),
              React.createElement('div', { className: 'cp-actions' },
                React.createElement('button', { type: 'button', disabled: busy, onClick: () => void updater.refresh() }, t('checkVersion')),
                React.createElement('button', { type: 'button', disabled: busy, 'aria-expanded': editingUpdate, onClick: () => setEditingUpdate(value => !value) }, t(editingUpdate ? 'closeUpdate' : 'manualUpdate'))),
              editingUpdate ? React.createElement('form', { className: 'cp-update-form', 'aria-busy': busy, onSubmit: event => { event.preventDefault(); void updater.install(packagePath); } },
                React.createElement('label', { htmlFor: pathId }, t('packagePath')),
                React.createElement('input', { id: pathId, type: 'text', value: packagePath, disabled: busy, placeholder: t('pathPlaceholder'), spellCheck: false, autoComplete: 'off', autoFocus: true,
                  onChange: event => setPackagePath(event.target.value) }),
                React.createElement('p', { className: 'cp-update-help' }, t('updateHelp')),
                React.createElement('button', { type: 'submit', className: 'cp-install', disabled: busy || !packagePath.trim() }, t(update.phase === 'installing' ? 'installing' : 'installUpdate'))) : null));
        }
        // 两路注册：装载机在就聚合进「Laurel总控」，不在就照旧单独占一条设置页。
        // 插槽系统「声明即独占渲染权」—— 聚合插槽是装载机声明的，所以只留聚合
        // 那条路的话，用户单独装 parchment 时设置页会整块消失。两个 inject 同时
        // 挂着，谁先成立谁生效；聚合成立就把独立那份撤掉，免得同时出现两处。
        const settingsSpec = {
          id: 'claude-parchment', order: 16,
          locale: 'claudeParchment', label: () => ctx.locale.bind('claudeParchment')('title'),
        };
        ctx.effect(() => {
          let grouped = null;
          let standalone = null;
          const put = name => ctx.slots.register({ ...settingsSpec, name }, Settings);
          const offGroup = ctx.slots.inject('laurel-center.module', () => {
            if (grouped) return () => {};
            if (standalone) { standalone(); standalone = null; }
            grouped = put('laurel-center.module');
            return () => { grouped?.(); grouped = null; };
          });
          const offStandalone = ctx.slots.inject('settings.section', () => {
            if (grouped) return () => {};
            if (standalone) return () => {};
            standalone = put('settings.section');
            return () => { standalone?.(); standalone = null; };
          });
          // `?.()`：inject 的契约是返回 disposer，但测试替身/更早的宿主未必给 ——
          // 卸载时抛「offGroup is not a function」会把整个卸载流程带塌。
          return () => { offGroup?.(); offStandalone?.(); };
        });
      },
    };
  },
});
