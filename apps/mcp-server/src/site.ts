// Public pages for the Claude directory listing: /docs, /privacy, /terms,
// /support (English, Vietnamese via ?lang=vi) and the icon. Page bodies live in
// apps/mcp-server/public/pages/<name>.<lang>.html; {{BASE_URL}}, {{MCP_URL}}
// and {{SUPPORT_EMAIL}} are filled in from configuration at startup.
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { esc, LOGO_SVG } from './oauth/pages.js';

const PAGES = ['docs', 'privacy', 'terms', 'support'] as const;
type PageName = (typeof PAGES)[number];
type Lang = 'en' | 'vi';

const NAV: Record<Lang, Record<PageName, string>> = {
  en: { docs: 'Docs', privacy: 'Privacy', terms: 'Terms', support: 'Support' },
  vi: { docs: 'Tài liệu', privacy: 'Quyền riêng tư', terms: 'Điều khoản', support: 'Hỗ trợ' }
};

const CSS = `
:root{--bg:#f6f7f5;--card:#fff;--ink:#17201d;--muted:#5b6661;--line:#dfe4e1;--brand:#0f766e;--code:#eef2f0}
@media (prefers-color-scheme:dark){:root{--bg:#101513;--card:#18201d;--ink:#e8eeeb;--muted:#a3b0aa;--line:#2c3733;--brand:#2bb3a3;--code:#202a26}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:16px}header{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;padding:8px 0 16px;border-bottom:1px solid var(--line)}
header .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;color:var(--ink);text-decoration:none}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:15px}nav a{color:var(--muted);text-decoration:none}nav a[aria-current=page]{color:var(--brand);font-weight:600}
.lang{margin-left:auto;font-size:14px}main{padding:8px 0 32px}h1{font-size:30px;line-height:1.2;margin:20px 0 8px}h2{font-size:22px;margin:32px 0 8px;padding-top:8px;border-top:1px solid var(--line)}
h3{font-size:18px;margin:22px 0 6px}a{color:var(--brand)}code{background:var(--code);padding:1px 5px;border-radius:5px;font-size:.92em;word-break:break-word}
pre{background:var(--code);padding:12px;border-radius:10px;overflow-x:auto}pre code{padding:0;background:none}
.lead{font-size:18px;color:var(--muted)}.note{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--brand);border-radius:10px;padding:12px 14px;margin:14px 0}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:15px;margin:10px 0}th,td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
footer{border-top:1px solid var(--line);padding:16px 0;color:var(--muted);font-size:14px}.muted{color:var(--muted)}
`;

export interface SiteConfig {
  readonly baseUrl: string;
  readonly mcpPath: string;
  readonly supportEmail: string;
}

export interface Site {
  /** Serves a public page or asset; returns false for other paths. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
}

function publicDir(): string {
  // dist/site.js -> ../public ; works for both src (ts-node) and dist layouts.
  return fileURLToPath(new URL('../public/', import.meta.url));
}

function layout(lang: Lang, page: PageName, title: string, body: string, cfg: SiteConfig): string {
  const nav = PAGES.map((p) => `<a href="/${p}${lang === 'vi' ? '?lang=vi' : ''}"${p === page ? ' aria-current="page"' : ''}>${NAV[lang][p]}</a>`).join('');
  const other = lang === 'vi' ? `<a href="/${page}">English</a>` : `<a href="/${page}?lang=vi">Tiếng Việt</a>`;
  const contact = cfg.supportEmail ? ` · <a href="mailto:${esc(cfg.supportEmail)}">${esc(cfg.supportEmail)}</a>` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ShopVoice Pay</title><meta name="description" content="ShopVoice Pay: a voice-first purchasing agent for independent grocers that pays suppliers through PayPal, only within the owner's rules."><link rel="icon" href="/icon.svg">
<style>${CSS}</style></head><body><div class="wrap"><header><a class="brand" href="/docs${lang === 'vi' ? '?lang=vi' : ''}">${LOGO_SVG}ShopVoice Pay</a><nav>${nav}</nav><span class="lang">${other}</span></header>
<main>${body}</main><footer>ShopVoice Pay · MIT · <a href="https://github.com/vansyson1308/shopvoice-pay">source</a>${contact}</footer></div></body></html>`;
}

export function createSite(cfg: SiteConfig): Site | null {
  const dir = publicDir();
  if (!existsSync(`${dir}pages/docs.en.html`)) return null;
  const fill = (text: string) => text
    .replaceAll('{{BASE_URL}}', esc(cfg.baseUrl || 'https://<your ShopVoice Pay host>'))
    .replaceAll('{{MCP_URL}}', esc(`${cfg.baseUrl || 'https://<your ShopVoice Pay host>'}${cfg.mcpPath}`))
    .replaceAll('{{SUPPORT_EMAIL}}', esc(cfg.supportEmail || 'the address on the support page'));
  const rendered = new Map<string, string>();
  for (const page of PAGES) {
    for (const lang of ['en', 'vi'] as const) {
      const raw = readFileSync(`${dir}pages/${page}.${lang}.html`, 'utf8');
      const title = /<!--\s*title:\s*(.*?)\s*-->/.exec(raw)?.[1] ?? page;
      rendered.set(`${page}.${lang}`, layout(lang, page, title, fill(raw), cfg));
    }
  }
  const svg = readFileSync(`${dir}icon.svg`);
  const png = existsSync(`${dir}icon-512.png`) ? readFileSync(`${dir}icon-512.png`) : null;
  const headers = {
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY'
  };

  return {
    handle(req, res, url) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/') {
        res.writeHead(302, { location: '/docs', 'cache-control': 'no-store' });
        res.end();
        return true;
      }
      if (path === '/icon.svg' || path === '/favicon.ico') {
        res.writeHead(200, { ...headers, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        res.end(req.method === 'HEAD' ? undefined : svg);
        return true;
      }
      if (path === '/icon-512.png' && png) {
        res.writeHead(200, { ...headers, 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        res.end(req.method === 'HEAD' ? undefined : png);
        return true;
      }
      const name = path.slice(1);
      if (!(PAGES as readonly string[]).includes(name)) return false;
      const lang: Lang = url.searchParams.get('lang') === 'vi' ? 'vi' : 'en';
      const html = rendered.get(`${name}.${lang}`) ?? '';
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      });
      res.end(req.method === 'HEAD' ? undefined : html);
      return true;
    }
  };
}
