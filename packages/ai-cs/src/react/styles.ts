export const AI_CS_STYLE_ID = "ventora-ai-cs-styles";

export const AI_CS_STYLES = `
[data-aics-root]{position:fixed;z-index:2147483646;color:var(--aics-text,#0f172a);--aics-error-bg:#fef2f2;--aics-error-text:#991b1b;--aics-success-bg:#ecfdf5;--aics-success-text:#065f46;--aics-warning-bg:rgba(245,158,11,.15);--aics-warning-text:#92400e;--aics-muted-text:color-mix(in srgb,var(--aics-text,#0f172a) 60%,transparent);--aics-focus-ring:var(--aics-accent,#0f172a);--aics-border:color-mix(in srgb,var(--aics-text,#0f172a) 10%,transparent);--aics-border-soft:color-mix(in srgb,var(--aics-text,#0f172a) 7%,transparent);--aics-online:#4ade80;--aics-composer-max-height:120px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif,'Apple Color Emoji','Segoe UI Emoji';}
[data-aics-root][data-aics-position="bottom-right"]{inset-inline-end:24px;bottom:24px;}
[data-aics-root][data-aics-position="bottom-left"]{inset-inline-start:24px;bottom:24px;}
[data-aics-launcher]{appearance:none;border:0;border-radius:9999px;padding:0 20px 0 16px;height:52px;background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);font:inherit;font-weight:600;font-size:14px;cursor:pointer;box-shadow:0 6px 16px color-mix(in srgb,var(--aics-accent,#0f172a) 32%,transparent),0 2px 6px color-mix(in srgb,var(--aics-text,#0f172a) 16%,transparent);display:inline-flex;align-items:center;gap:9px;min-height:44px;transition:transform 160ms cubic-bezier(.18,.95,.32,1),box-shadow 160ms ease;}
[data-aics-launcher]:hover{transform:translateY(-2px);box-shadow:0 12px 28px color-mix(in srgb,var(--aics-accent,#0f172a) 40%,transparent),0 3px 8px color-mix(in srgb,var(--aics-text,#0f172a) 20%,transparent);}
[data-aics-launcher]:active{transform:translateY(0);}
[data-aics-launcher] [data-aics-launcher-icon]{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:0 0 auto;}
[data-aics-launcher] svg{width:20px;height:20px;display:block;}
[data-aics-launcher]:focus-visible{outline:3px solid var(--aics-focus-ring,var(--aics-accent,#0f172a));outline-offset:3px;}
[data-aics-panel]{position:absolute;bottom:66px;width:384px;max-height:min(620px,calc(100vh - 96px));background:var(--aics-surface,#fff);border-radius:18px;box-shadow:0 1px 1px color-mix(in srgb,var(--aics-text,#0f172a) 6%,transparent),0 20px 48px color-mix(in srgb,var(--aics-text,#0f172a) 18%,transparent);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--aics-border-soft);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif,'Apple Color Emoji','Segoe UI Emoji';}
[data-aics-root][data-aics-position="bottom-right"] [data-aics-panel]{inset-inline-end:0;}
[data-aics-root][data-aics-position="bottom-left"] [data-aics-panel]{inset-inline-start:0;}
/* Header gradient darkens toward black for depth; assumes a dark accent paired with light accent-text (every shipping brand). A light accent needs a matching dark accent-text. */
[data-aics-header]{display:flex;align-items:center;gap:12px;padding:16px 16px 14px;background:linear-gradient(135deg,var(--aics-accent,#0f172a),color-mix(in srgb,var(--aics-accent,#0f172a) 82%,#000));color:var(--aics-accent-text,#fff);}
[data-aics-header-avatar]{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;flex:0 0 auto;border-radius:9999px;background:color-mix(in srgb,#fff 20%,transparent);}
[data-aics-header-avatar] svg{width:20px;height:20px;display:block;}
[data-aics-header-text]{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;}
[data-aics-title]{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;}
[data-aics-subtitle]{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-aics-subtitle]::before{content:"";flex:0 0 auto;width:7px;height:7px;border-radius:9999px;background:var(--aics-online,#4ade80);box-shadow:0 0 0 3px color-mix(in srgb,var(--aics-online,#4ade80) 30%,transparent);}
[data-aics-new-chat]{appearance:none;border:1px solid color-mix(in srgb,#fff 36%,transparent);background:color-mix(in srgb,#fff 12%,transparent);color:inherit;font:inherit;font-size:12px;font-weight:600;border-radius:9999px;padding:6px 12px;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;transition:background 140ms ease;}
[data-aics-new-chat]:hover{background:color-mix(in srgb,#fff 22%,transparent);}
[data-aics-new-chat]:focus-visible{outline:2px solid var(--aics-accent-text,#fff);outline-offset:2px;}
[data-aics-close]{background:color-mix(in srgb,#fff 10%,transparent);border:0;color:inherit;cursor:pointer;font-size:18px;line-height:1;padding:0;border-radius:9999px;min-width:44px;min-height:44px;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;transition:background 140ms ease;}
[data-aics-close]:hover{background:color-mix(in srgb,#fff 22%,transparent);}
[data-aics-close] svg{width:16px;height:16px;display:block;}
[data-aics-close]:focus-visible{outline:2px solid var(--aics-accent-text,#fff);outline-offset:1px;}
[data-aics-transcript]{flex:1 1 auto;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth;}
[data-aics-loading]{display:flex;align-items:center;justify-content:center;padding:24px 12px;color:var(--aics-muted-text,color-mix(in srgb,var(--aics-text,#0f172a) 60%,transparent));font-size:13px;}
[data-aics-bubble]{max-width:min(88%,34rem);overflow-wrap:anywhere;padding:10px 13px;border-radius:16px;font-size:14px;line-height:1.5;box-shadow:0 1px 2px color-mix(in srgb,var(--aics-text,#0f172a) 6%,transparent);}
[data-aics-bubble][data-aics-role="user"]{align-self:flex-end;background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);white-space:pre-wrap;border-end-end-radius:6px;}
[data-aics-bubble][data-aics-role="assistant"]{--aics-assistant-bubble-bg:color-mix(in srgb,var(--aics-accent,#0f172a) 5%,var(--aics-surface,#fff));align-self:flex-start;background:var(--aics-assistant-bubble-bg);border:1px solid var(--aics-border-soft);border-end-start-radius:6px;}
[data-aics-bubble][data-aics-role="assistant"] p{margin:0 0 6px;overflow-wrap:anywhere;}
[data-aics-bubble][data-aics-role="assistant"] p:last-child{margin-bottom:0;}
[data-aics-bubble][data-aics-role="assistant"] strong{font-weight:700;}
[data-aics-bubble][data-aics-role="assistant"] em{font-style:italic;}
[data-aics-bubble][data-aics-role="assistant"] code{font-family:ui-monospace,monospace;font-size:.9em;background:color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);padding:1px 4px;border-radius:4px;}
[data-aics-bubble][data-aics-role="assistant"] pre{margin:6px 0;overflow:auto;background:color-mix(in srgb,var(--aics-text,#0f172a) 6%,transparent);border-radius:6px;padding:8px 10px;}
[data-aics-bubble][data-aics-role="assistant"] pre code{background:none;padding:0;font-size:.875em;}
[data-aics-bubble][data-aics-role="assistant"] ul,[data-aics-bubble][data-aics-role="assistant"] ol{margin:4px 0 6px;padding-inline-start:1.4em;}
[data-aics-bubble][data-aics-role="assistant"] li{margin:2px 0;}
[data-aics-bubble][data-aics-role="assistant"] a{color:var(--aics-accent,#0f172a);text-decoration:underline;}
[data-aics-bubble][data-aics-role="assistant"] a:hover{opacity:.8;}
[data-aics-bubble][data-aics-role="assistant"] [data-aics-table-wrap]{display:block;overflow-x:auto;margin:6px 0;}
[data-aics-bubble][data-aics-role="assistant"] [data-aics-table]{border-collapse:collapse;width:100%;font-size:.875em;}
[data-aics-bubble][data-aics-role="assistant"] [data-aics-table] th,[data-aics-bubble][data-aics-role="assistant"] [data-aics-table] td{padding:6px 10px;border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 12%,transparent);text-align:left;}
[data-aics-bubble][data-aics-role="assistant"] [data-aics-table] th{font-weight:600;background:color-mix(in srgb,var(--aics-text,#0f172a) 5%,var(--aics-surface,#fff));}
[data-aics-bubble][data-aics-failed]{outline:2px solid var(--aics-warning-bg,rgba(245,158,11,.15));outline-offset:2px;}
[data-aics-retry-row]{display:flex;gap:8px;padding:2px 0;align-self:flex-start;}
[data-aics-retry-btn]{background:transparent;border:1px solid var(--aics-warning-text,#92400e);color:var(--aics-warning-text,#92400e);border-radius:9999px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;min-height:44px;}
[data-aics-retry-btn]:focus-visible{outline:2px solid var(--aics-warning-text,#92400e);outline-offset:2px;}
[data-aics-stop-host]{display:flex;justify-content:center;padding:0 16px 8px;transition:opacity 140ms ease;}
[data-aics-stop-host][hidden]{opacity:0;}
[data-aics-stop]{appearance:none;border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 18%,transparent);border-radius:9999px;padding:6px 14px;background:transparent;color:var(--aics-text,#0f172a);font-weight:600;font-size:13px;cursor:pointer;min-height:44px;font:inherit;display:inline-flex;align-items:center;justify-content:center;transition:background 140ms ease;}
[data-aics-stop]:hover{background:color-mix(in srgb,var(--aics-text,#0f172a) 8%,transparent);}
[data-aics-stop]:focus-visible{outline:2px solid var(--aics-focus-ring,var(--aics-accent,#0f172a));outline-offset:2px;}
[data-aics-jump]{position:absolute;inset-inline-start:50%;transform:translateX(-50%);bottom:84px;background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);border:0;border-radius:9999px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 8px 20px color-mix(in srgb,var(--aics-accent,#0f172a) 36%,transparent);min-height:44px;min-width:44px;transition:transform 140ms cubic-bezier(.18,.95,.32,1);}
[data-aics-jump]:hover{transform:translateX(-50%) translateY(-1px);}
[data-aics-jump]:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:2px;}
[dir="rtl"] [data-aics-jump]{transform:translateX(50%);}
[dir="rtl"] [data-aics-jump]:hover{transform:translateX(50%) translateY(-1px);}
[data-aics-navigation]{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-top:1px solid var(--aics-border-soft);background:var(--aics-surface,#fff);}
[data-aics-navigation] button{appearance:none;border:1px solid color-mix(in srgb,var(--aics-accent,#0f172a) 40%,transparent);background:color-mix(in srgb,var(--aics-accent,#0f172a) 4%,transparent);color:var(--aics-accent,#0f172a);border-radius:9999px;padding:6px 13px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;min-height:44px;transition:background 140ms ease;}
[data-aics-navigation] button:hover{background:color-mix(in srgb,var(--aics-accent,#0f172a) 12%,transparent);}
[data-aics-navigation] button:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:2px;}
[data-aics-workflow]{margin:10px 0;padding:12px;background:color-mix(in srgb,var(--aics-text,#0f172a) 4%,transparent);border:1px solid var(--aics-border-soft);border-radius:12px;font-size:13px;}
[data-aics-workflow] summary{cursor:pointer;font-weight:600;}
[data-aics-workflow] ol{margin:8px 0 0;padding-inline-start:1.3em;display:flex;flex-direction:column;gap:4px;}
[data-aics-sources]{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 16px;border-top:1px solid var(--aics-border-soft);}
[data-aics-source],[data-aics-source-plain]{border:1px solid color-mix(in srgb,var(--aics-accent,#0f172a) 35%,transparent);border-radius:9999px;padding:5px 12px;font-size:12px;text-decoration:none;color:var(--aics-accent,#0f172a);background:transparent;display:inline-flex;line-height:1.2;transition:background 140ms ease;}
[data-aics-source]:hover{background:color-mix(in srgb,var(--aics-accent,#0f172a) 8%,transparent);}
[data-aics-source]:focus-visible{outline:2px solid var(--aics-accent,#0f172a);outline-offset:2px;}
[data-aics-composer]{display:flex;gap:8px;align-items:flex-end;padding:12px 14px 14px;border-top:1px solid var(--aics-border-soft);background:var(--aics-surface,#fff);}
[data-aics-composer][hidden]{display:none;}
[data-aics-composer] textarea{flex:1 1 auto;resize:none;border:1px solid color-mix(in srgb,var(--aics-text,#0f172a) 16%,transparent);border-radius:14px;padding:11px 13px;font:inherit;font-size:14px;line-height:1.4;color:inherit;background:color-mix(in srgb,var(--aics-text,#0f172a) 4%,var(--aics-surface,#fff));min-height:44px;max-height:var(--aics-composer-max-height,120px);transition:border-color 140ms ease,box-shadow 140ms ease;}
[data-aics-composer] textarea::placeholder{color:var(--aics-muted-text,color-mix(in srgb,var(--aics-text,#0f172a) 60%,transparent));}
[data-aics-composer] textarea:focus-visible{outline:none;border-color:var(--aics-accent,#0f172a);box-shadow:0 0 0 3px color-mix(in srgb,var(--aics-accent,#0f172a) 18%,transparent);}
[data-aics-send]{appearance:none;border:0;border-radius:9999px;padding:0;background:var(--aics-accent,#0f172a);color:var(--aics-accent-text,#fff);font:inherit;font-weight:600;cursor:pointer;width:44px;height:44px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;transition:transform 140ms cubic-bezier(.18,.95,.32,1),background 140ms ease,opacity 140ms ease;}
[data-aics-send] svg{width:19px;height:19px;display:block;}
[data-aics-send]:not(:disabled):hover{transform:scale(1.06);}
[data-aics-send]:focus-visible{outline:2px solid var(--aics-focus-ring,var(--aics-accent,#0f172a));outline-offset:2px;}
[data-aics-send]:disabled{opacity:.45;cursor:not-allowed;}
[data-aics-banner]{padding:10px 12px;border-radius:12px;background:var(--aics-success-bg,#ecfdf5);color:var(--aics-success-text,#065f46);font-size:13px;line-height:1.4;margin:10px 16px 0;}
[data-aics-banner][data-aics-status="error"]{background:var(--aics-error-bg,#fef2f2);color:var(--aics-error-text,#991b1b);}
[data-aics-banner-close]{background:transparent;border:0;color:inherit;cursor:pointer;font-size:16px;padding:4px 8px;border-radius:9999px;float:inline-end;min-height:44px;min-width:44px;}
[data-aics-banner-close]:focus-visible{outline:2px solid currentColor;outline-offset:2px;}
[data-aics-escalate-host]{padding:0 16px 12px;}
[data-aics-escalate]{background:transparent;color:var(--aics-accent,#0f172a);border:1px solid color-mix(in srgb,var(--aics-accent,#0f172a) 45%,transparent);font:inherit;font-weight:600;font-size:13px;padding:8px 16px;border-radius:9999px;display:inline-flex;align-items:center;gap:7px;min-height:44px;cursor:pointer;transition:background 140ms ease;}
[data-aics-escalate]:hover{background:color-mix(in srgb,var(--aics-accent,#0f172a) 7%,transparent);}
[data-aics-escalate] svg{width:15px;height:15px;display:block;}
[data-aics-escalate]:focus-visible{outline:2px solid var(--aics-focus-ring,var(--aics-accent,#0f172a));outline-offset:2px;}
[data-aics-empty]{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:32px 16px 24px;margin:auto 0;}
[data-aics-empty-icon]{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;margin-bottom:4px;border-radius:9999px;background:color-mix(in srgb,var(--aics-accent,#0f172a) 12%,var(--aics-surface,#fff));color:var(--aics-accent,#0f172a);}
[data-aics-empty-icon] svg{width:26px;height:26px;display:block;}
[data-aics-empty-title]{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em;color:var(--aics-text,#0f172a);}
[data-aics-empty-body]{margin:0;font-size:13px;line-height:1.5;max-width:30ch;color:var(--aics-muted-text,color-mix(in srgb,var(--aics-text,#0f172a) 60%,transparent));}
[data-aics-suggestions]{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:8px;}
[data-aics-suggestion]{appearance:none;border:1px solid color-mix(in srgb,var(--aics-accent,#0f172a) 22%,transparent);border-radius:9999px;padding:9px 15px;font-size:13px;font-weight:500;background:color-mix(in srgb,var(--aics-accent,#0f172a) 3%,transparent);color:var(--aics-accent,#0f172a);cursor:pointer;min-height:44px;font:inherit;transition:background 140ms ease,border-color 140ms ease;}
[data-aics-suggestion]:hover{background:color-mix(in srgb,var(--aics-accent,#0f172a) 9%,transparent);border-color:color-mix(in srgb,var(--aics-accent,#0f172a) 40%,transparent);}
[data-aics-suggestion]:focus-visible{outline:2px solid var(--aics-focus-ring,var(--aics-accent,#0f172a));outline-offset:2px;}
@media (max-width:380px){[data-aics-suggestion]{min-height:44px;}}
[dir="rtl"] [data-aics-bubble][data-aics-role="user"]{align-self:flex-start;}
[dir="rtl"] [data-aics-bubble][data-aics-role="assistant"]{align-self:flex-end;}
[dir="rtl"] [data-aics-panel]{transform-origin:bottom left;}
[dir="rtl"] [data-aics-root][data-aics-position="bottom-right"] [data-aics-panel]{inset-inline-end:0;inset-inline-start:auto;}
[dir="rtl"] [data-aics-root][data-aics-position="bottom-left"] [data-aics-panel]{inset-inline-start:0;inset-inline-end:auto;}
@media (prefers-reduced-motion: no-preference){
  [data-aics-panel]{animation:aics-pop 200ms cubic-bezier(.18,.95,.32,1);}
  [data-aics-bubble]{animation:aics-bubble-in 170ms ease-out;}
  [data-aics-loading]{animation:aics-fade-in 170ms ease-out;}
}
@keyframes aics-pop{from{opacity:0;transform:translateY(8px) scale(.96);}to{opacity:1;transform:none;}}
@keyframes aics-bubble-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
@keyframes aics-fade-in{from{opacity:0;}to{opacity:1;}}
@media (prefers-reduced-motion: reduce){[data-aics-root] *{transition:none!important;animation:none!important;}[data-aics-root] [data-aics-transcript]{scroll-behavior:auto!important;}}
[data-aics-root][data-aics-reduced-motion] *,[data-aics-root][data-aics-reduced-motion] *::before,[data-aics-root][data-aics-reduced-motion] *::after{animation:none!important;transition:none!important;}
[data-aics-root][data-aics-reduced-motion] [data-aics-transcript]{scroll-behavior:auto!important;}
@media (prefers-color-scheme: dark){
  [data-aics-root]:not([data-aics-theme]){--aics-surface:#0f172a;--aics-text:#f1f5f9;--aics-focus-ring:#94a3b8;--aics-muted-text:rgba(241,245,249,.65);--aics-border:rgba(255,255,255,.12);--aics-border-soft:rgba(255,255,255,.08);--aics-error-bg:#3b0a0a;--aics-error-text:#fca5a5;--aics-success-bg:#052e16;--aics-success-text:#86efac;}
  [data-aics-root]:not([data-aics-theme]) [data-aics-panel]{box-shadow:0 1px 1px rgba(0,0,0,.4),0 24px 56px rgba(0,0,0,.55);}
  [data-aics-root]:not([data-aics-theme]) [data-aics-bubble][data-aics-role="assistant"]{background:#1e293b;border-color:rgba(255,255,255,.08);}
  [data-aics-root]:not([data-aics-theme]) [data-aics-bubble]{box-shadow:none;}
  [data-aics-root]:not([data-aics-theme]) [data-aics-composer] textarea{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.14);}
  [data-aics-root]:not([data-aics-theme]) [data-aics-suggestion],
  [data-aics-root]:not([data-aics-theme]) [data-aics-navigation] button{color:var(--aics-text);border-color:color-mix(in srgb,var(--aics-text) 30%,transparent);background:rgba(255,255,255,.05);}
  [data-aics-root]:not([data-aics-theme]) [data-aics-source],
  [data-aics-root]:not([data-aics-theme]) [data-aics-source-plain]{color:var(--aics-text);border-color:color-mix(in srgb,var(--aics-text) 30%,transparent);}
  [data-aics-root]:not([data-aics-theme]) [data-aics-escalate]{color:var(--aics-text);border-color:color-mix(in srgb,var(--aics-text) 30%,transparent);}
}
@media (forced-colors: active){
  [data-aics-panel],[data-aics-bubble]{border:1px solid CanvasText;}
  [data-aics-launcher],[data-aics-send]{border:2px solid ButtonText;}
  [data-aics-launcher]:focus-visible,[data-aics-send]:focus-visible{outline:3px solid Highlight;}
}
@media (max-width:640px){
  [data-aics-panel]{position:fixed;inset:0;width:100vw;height:100vh;max-height:none;border-radius:0;}
  [data-aics-close]{min-width:44px;min-height:44px;}
  [data-aics-navigation] button{min-height:44px;}
  [data-aics-escalate]{min-height:44px;}
  [data-aics-jump]{min-height:44px;min-width:44px;}
  [data-aics-retry-btn]{min-height:44px;}
}
`;

export function ensureAiCsStyles(doc: Document): void {
  if (doc.getElementById(AI_CS_STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = AI_CS_STYLE_ID;
  style.textContent = AI_CS_STYLES;
  doc.head.append(style);
}

export interface AiCsBrand {
  id?: string;
  accentColor?: string;
  accentTextColor?: string;
  surfaceColor?: string;
  textColor?: string;
}

const productBrands: Record<string, Required<Omit<AiCsBrand, "id">> & { id: string }> = {
  camaudit: {
    id: "camaudit",
    accentColor: "#1f5a52",
    accentTextColor: "#ffffff",
    surfaceColor: "#fbfefd",
    textColor: "#071426",
  },
  capveri: {
    id: "capveri",
    accentColor: "#4f46e5",
    accentTextColor: "#ffffff",
    surfaceColor: "#fbfbff",
    textColor: "#141528",
  },
  grantpipe: {
    id: "grantpipe",
    accentColor: "#15803d",
    accentTextColor: "#ffffff",
    surfaceColor: "#fbfdf8",
    textColor: "#102015",
  },
  lextract: {
    id: "lextract",
    accentColor: "#b45309",
    accentTextColor: "#ffffff",
    surfaceColor: "#fffdfa",
    textColor: "#1d1712",
  },
};

export interface ResolvedAiCsBrand {
  id: string;
  accentColor: string;
  accentTextColor: string;
  surfaceColor: string;
  textColor: string;
}

export function resolveAiCsBrand(brand: AiCsBrand | undefined): ResolvedAiCsBrand {
  const override = brand ?? {};
  const key = (override.id ?? "").trim().toLowerCase();
  const fallback: ResolvedAiCsBrand = {
    id: key === "" ? "ventora" : key,
    accentColor: "#0f172a",
    accentTextColor: "#ffffff",
    surfaceColor: "#f8fafc",
    textColor: "#0f172a",
  };
  const base = productBrands[key] ?? fallback;
  return {
    id: override.id ?? base.id,
    accentColor: override.accentColor ?? base.accentColor,
    accentTextColor: override.accentTextColor ?? base.accentTextColor,
    surfaceColor: override.surfaceColor ?? base.surfaceColor,
    textColor: override.textColor ?? base.textColor,
  };
}
