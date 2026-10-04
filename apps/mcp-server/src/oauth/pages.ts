// Server-rendered HTML for sign-in, sign-up, consent and the account page.
// No framework, no scripts: plain forms, inline CSS, English and Vietnamese.
import type { GrantSummary, Locale, WebAccount } from './store.js';

export type { Locale };

const T = {
  en: {
    signinTitle: 'Sign in to ShopVoice Pay',
    signinLead: 'Sign in or create a free account to connect your shop.',
    connecting: 'is asking to connect to your ShopVoice Pay account.',
    email: 'Email',
    password: 'Password',
    passwordConfirm: 'Repeat password',
    signin: 'Sign in',
    signupTitle: 'New to ShopVoice Pay?',
    signupLead: 'Create a free account. You get a demo shop with sample data right away. Payments in it run in PayPal\'s sandbox or a labelled simulation; no real money moves.',
    passwordRule: 'At least 10 characters.',
    language: 'Language',
    acceptTerms: 'I accept the <a href="/terms">Terms</a> and the <a href="/privacy">Privacy Policy</a>.',
    signup: 'Create account',
    consentTitle: 'Allow access to your shop?',
    signedInAs: 'Signed in as',
    shop: 'Shop',
    sample: 'sample data',
    app: 'App',
    sendsTo: 'After you decide, you will be sent to',
    verifiedHost: 'identified by',
    unverified: 'Registered itself automatically; its name is not verified.',
    loopbackWarn: 'This app only accepts sign-in results on this computer (only loopback addresses). Continue only if you started this from an app on your own computer, such as Claude Code.',
    canRead: 'Read your stock, sales, suppliers and invoices',
    canWrite: 'Create and confirm purchase-order drafts (never moves money)',
    refresh: 'Stay connected until you revoke access',
    allow: 'Allow',
    deny: 'Deny',
    switchAccount: 'Use another account',
    revokeNote: 'You can revoke access at any time on your',
    accountPage: 'account page',
    accountTitle: 'Your ShopVoice Pay account',
    connectedApps: 'Connected apps',
    noApps: 'No apps are connected.',
    lastUsed: 'Last used',
    revoke: 'Revoke',
    linkTitle: 'Link your real shop',
    linkLead: 'Have an invite code from your shop owner? Enter it to switch from the demo shop to your real shop. Connected apps will need to sign in again.',
    inviteCode: 'Invite code',
    link: 'Link shop',
    signout: 'Sign out',
    errBadLogin: 'Email or password is incorrect.',
    errEmailTaken: 'An account with this email already exists. Sign in instead.',
    errEmail: 'Enter a valid email address.',
    errPassword: 'Use a password of at least 10 characters, typed the same way twice.',
    errTerms: 'Accept the Terms and Privacy Policy to create an account.',
    errCsrf: 'This form expired. Go back, reload the page and try again.',
    errRate: 'Too many attempts. Wait a minute and try again.',
    errInvite: 'That invite code did not work. Check it with your shop owner; codes expire and can be used once.',
    errInviteOff: 'Linking a real shop is not enabled on this server yet.',
    linked: 'Your account now uses your real shop.',
    revoked: 'Access revoked.',
    deleteTitle: 'Delete account',
    deleteLead: 'Deletes your ShopVoice Pay account, disconnects every app and erases your demo shop. A linked real shop keeps its own data. This cannot be undone.',
    deleteConfirm: 'Type your email to confirm',
    deleteButton: 'Delete my account',
    deleted: 'Your account was deleted.',
    errDeleteConfirm: 'The email you typed does not match this account, so nothing was deleted.',
    errorTitle: 'Cannot continue',
    help: 'Need help? Contact',
    docs: 'Docs',
    privacy: 'Privacy',
    terms: 'Terms',
    support: 'Support'
  },
  vi: {
    signinTitle: 'Đăng nhập ShopVoice Pay',
    signinLead: 'Đăng nhập hoặc tạo tài khoản miễn phí để kết nối cửa hàng.',
    connecting: 'muốn kết nối với tài khoản ShopVoice Pay của bạn.',
    email: 'Email',
    password: 'Mật khẩu',
    passwordConfirm: 'Nhập lại mật khẩu',
    signin: 'Đăng nhập',
    signupTitle: 'Lần đầu dùng ShopVoice Pay?',
    signupLead: 'Tạo tài khoản miễn phí. Bạn có ngay một cửa hàng mẫu với dữ liệu mẫu. Thanh toán trong đó chạy trên sandbox của PayPal hoặc một bản mô phỏng có ghi rõ; không có tiền thật nào được chuyển.',
    passwordRule: 'Tối thiểu 10 ký tự.',
    language: 'Ngôn ngữ',
    acceptTerms: 'Tôi đồng ý với <a href="/terms">Điều khoản</a> và <a href="/privacy">Chính sách quyền riêng tư</a>.',
    signup: 'Tạo tài khoản',
    consentTitle: 'Cho phép truy cập cửa hàng?',
    signedInAs: 'Đang đăng nhập:',
    shop: 'Cửa hàng',
    sample: 'dữ liệu mẫu',
    app: 'Ứng dụng',
    sendsTo: 'Sau khi bạn chọn, trình duyệt sẽ chuyển tới',
    verifiedHost: 'xác định bởi',
    unverified: 'Ứng dụng tự đăng ký; tên chưa được xác minh.',
    loopbackWarn: 'Ứng dụng này chỉ nhận kết quả đăng nhập trên chính máy tính này (chỉ loopback). Chỉ tiếp tục nếu bạn vừa mở từ một ứng dụng trên máy mình, ví dụ Claude Code.',
    canRead: 'Xem tồn kho, doanh số, nhà cung cấp và hóa đơn',
    canWrite: 'Tạo và xác nhận đơn đặt hàng nháp (không bao giờ chuyển tiền)',
    refresh: 'Duy trì kết nối cho tới khi bạn thu hồi',
    allow: 'Cho phép',
    deny: 'Từ chối',
    switchAccount: 'Dùng tài khoản khác',
    revokeNote: 'Bạn có thể thu hồi quyền bất cứ lúc nào tại',
    accountPage: 'trang tài khoản',
    accountTitle: 'Tài khoản ShopVoice Pay',
    connectedApps: 'Ứng dụng đã kết nối',
    noApps: 'Chưa có ứng dụng nào kết nối.',
    lastUsed: 'Dùng lần cuối',
    revoke: 'Thu hồi',
    linkTitle: 'Liên kết cửa hàng thật',
    linkLead: 'Bạn có mã mời từ chủ cửa hàng? Nhập mã để chuyển từ cửa hàng mẫu sang cửa hàng thật. Các ứng dụng đã kết nối sẽ phải đăng nhập lại.',
    inviteCode: 'Mã mời',
    link: 'Liên kết',
    signout: 'Đăng xuất',
    errBadLogin: 'Email hoặc mật khẩu không đúng.',
    errEmailTaken: 'Email này đã có tài khoản. Hãy đăng nhập.',
    errEmail: 'Nhập địa chỉ email hợp lệ.',
    errPassword: 'Dùng mật khẩu tối thiểu 10 ký tự và nhập giống nhau hai lần.',
    errTerms: 'Hãy đồng ý Điều khoản và Chính sách quyền riêng tư để tạo tài khoản.',
    errCsrf: 'Biểu mẫu đã hết hạn. Quay lại, tải lại trang rồi thử lại.',
    errRate: 'Thử quá nhiều lần. Đợi một phút rồi thử lại.',
    errInvite: 'Mã mời không dùng được. Hãy kiểm tra với chủ cửa hàng; mã có hạn dùng và chỉ dùng một lần.',
    errInviteOff: 'Máy chủ này chưa bật tính năng liên kết cửa hàng thật.',
    linked: 'Tài khoản đã chuyển sang cửa hàng thật.',
    revoked: 'Đã thu hồi quyền.',
    deleteTitle: 'Xóa tài khoản',
    deleteLead: 'Xóa tài khoản ShopVoice Pay, ngắt kết nối mọi ứng dụng và xóa cửa hàng mẫu. Cửa hàng thật đã liên kết vẫn giữ dữ liệu của mình. Không thể hoàn tác.',
    deleteConfirm: 'Nhập email để xác nhận',
    deleteButton: 'Xóa tài khoản của tôi',
    deleted: 'Tài khoản đã được xóa.',
    errDeleteConfirm: 'Email không khớp với tài khoản này nên chưa xóa gì.',
    errorTitle: 'Không thể tiếp tục',
    help: 'Cần hỗ trợ? Liên hệ',
    docs: 'Tài liệu',
    privacy: 'Quyền riêng tư',
    terms: 'Điều khoản',
    support: 'Hỗ trợ'
  }
} as const;

export type Strings = { readonly [K in keyof (typeof T)['en']]: string };
export type MessageKey = keyof (typeof T)['en'];

export function strings(locale: Locale): Strings {
  return T[locale];
}

export function pickLocale(uiLocales: string | null | undefined, acceptLanguage: string | undefined): Locale {
  const first = (uiLocales ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first.startsWith('vi')) return 'vi';
  if (first.startsWith('en')) return 'en';
  return /^\s*vi\b/i.test(acceptLanguage ?? '') ? 'vi' : 'en';
}

export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const LOGO_SVG = '<svg viewBox="0 0 512 512" width="36" height="36" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#0f766e"/><path d="M176 214l40-86M336 214l-40-86" stroke="#fff" stroke-width="30" stroke-linecap="round"/><path d="M104 206h304a14 14 0 0 1 13.8 16.3l-26 152A40 40 0 0 1 356.4 408H155.6a40 40 0 0 1-39.4-33.7l-26-152A14 14 0 0 1 104 206z" fill="#fff"/><path d="M196 268v76M236 250v112M276 276v60M316 262v88" stroke="#0f766e" stroke-width="24" stroke-linecap="round"/></svg>';

const CSS = `
:root{--bg:#f6f7f5;--card:#fff;--ink:#17201d;--muted:#5b6661;--line:#dfe4e1;--brand:#0f766e;--brand-ink:#fff;--warn-bg:#fff7e6;--warn:#8a5a00;--err-bg:#fdecec;--err:#9b1c1c;--ok-bg:#e8f6ef;--ok:#11643a}
@media (prefers-color-scheme:dark){:root{--bg:#101513;--card:#18201d;--ink:#e8eeeb;--muted:#a3b0aa;--line:#2c3733;--brand:#2bb3a3;--brand-ink:#06201d;--warn-bg:#2d2412;--warn:#f3c56b;--err-bg:#351a1a;--err:#f5a3a3;--ok-bg:#12291f;--ok:#8fe0b4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:460px;margin:0 auto;padding:24px 16px 40px}header{display:flex;align-items:center;gap:10px;margin-bottom:16px}
header b{font-size:20px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:18px;margin:0 0 6px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
label{display:block;font-weight:600;margin:12px 0 4px}input[type=email],input[type=password],input[type=text],select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font-size:16px}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:14px 0}.check input{margin-top:4px}
button{font:inherit;border-radius:10px;padding:11px 16px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink);font-weight:600}.row{display:flex;gap:10px;margin-top:16px}.row button{flex:1}
.facts{margin:12px 0;padding:0;list-style:none}.facts li{padding:8px 0;border-top:1px solid var(--line)}.facts li:first-child{border-top:0}
.host{font-weight:700;font-size:18px;word-break:break-all}.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--warn-bg);color:var(--warn)}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:10px 12px;margin:12px 0;font-size:14px}
.err{background:var(--err-bg);color:var(--err);border-radius:10px;padding:10px 12px;margin:0 0 12px}.ok{background:var(--ok-bg);color:var(--ok);border-radius:10px;padding:10px 12px;margin:0 0 12px}
.scopes{margin:8px 0;padding-left:0;list-style:none}.scopes li{margin:6px 0}a{color:var(--brand)}footer{text-align:center;font-size:13px;color:var(--muted)}footer a{margin:0 6px}
.app{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}.app:first-child{border-top:0}
`;

function footer(s: Strings, supportEmail: string): string {
  const help = supportEmail ? `<p>${s.help} <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a></p>` : '';
  return `<footer>${help}<a href="/docs">${s.docs}</a>·<a href="/privacy">${s.privacy}</a>·<a href="/terms">${s.terms}</a>·<a href="/support">${s.support}</a></footer>`;
}

export function layout(locale: Locale, title: string, body: string, supportEmail: string): string {
  const s = strings(locale);
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="icon" href="/icon.svg"><style>${CSS}</style></head><body><main><header>${LOGO_SVG}<b>ShopVoice Pay</b></header>${body}${footer(s, supportEmail)}</main></body></html>`;
}

export type HiddenFields = Readonly<Record<string, string>>;

function hiddenInputs(fields: HiddenFields): string {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
}

export interface AuthPageInput {
  readonly locale: Locale;
  readonly action: string;
  readonly hidden: HiddenFields;
  readonly clientLabel: string | null;
  readonly error: MessageKey | null;
  readonly email: string;
  readonly supportEmail: string;
  readonly langSwitchHref: string;
}

export function renderAuthPage(p: AuthPageInput): string {
  const s = strings(p.locale);
  const other: Locale = p.locale === 'vi' ? 'en' : 'vi';
  const intro = p.clientLabel ? `<p><b>${esc(p.clientLabel)}</b> ${s.connecting}</p>` : `<p>${s.signinLead}</p>`;
  const err = p.error === 'deleted' ? `<div class="ok" role="status">${s.deleted}</div>` : p.error ? `<div class="err" role="alert">${s[p.error]}</div>` : '';
  const body = `
<div class="card"><h1>${s.signinTitle}</h1>${intro}${err}
<form method="post" action="${esc(p.action)}">${hiddenInputs(p.hidden)}
<label for="li-email">${s.email}</label><input id="li-email" type="email" name="email" autocomplete="username" required value="${esc(p.email)}">
<label for="li-pw">${s.password}</label><input id="li-pw" type="password" name="password" autocomplete="current-password" required>
<div class="row"><button class="primary" type="submit" name="action" value="login">${s.signin}</button></div></form></div>
<div class="card"><h2>${s.signupTitle}</h2><p class="muted">${s.signupLead}</p>
<form method="post" action="${esc(p.action)}">${hiddenInputs(p.hidden)}
<label for="su-email">${s.email}</label><input id="su-email" type="email" name="email" autocomplete="email" required>
<label for="su-pw">${s.password}</label><input id="su-pw" type="password" name="password" autocomplete="new-password" minlength="10" required><div class="muted">${s.passwordRule}</div>
<label for="su-pw2">${s.passwordConfirm}</label><input id="su-pw2" type="password" name="password_confirm" autocomplete="new-password" minlength="10" required>
<label for="su-loc">${s.language}</label><select id="su-loc" name="locale"><option value="en"${p.locale === 'en' ? ' selected' : ''}>English</option><option value="vi"${p.locale === 'vi' ? ' selected' : ''}>Tiếng Việt</option></select>
<label class="check"><input type="checkbox" name="accept_terms" required> <span>${s.acceptTerms}</span></label>
<div class="row"><button type="submit" name="action" value="signup">${s.signup}</button></div></form></div>
<p class="muted" style="text-align:center"><a href="${esc(p.langSwitchHref)}">${other === 'vi' ? 'Tiếng Việt' : 'English'}</a></p>`;
  return layout(p.locale, s.signinTitle, body, p.supportEmail);
}

export interface ConsentPageInput {
  readonly locale: Locale;
  readonly hidden: HiddenFields;
  readonly account: WebAccount;
  readonly clientName: string;
  /** Host of a CIMD client_id URL; null for self-registered (DCR) clients. */
  readonly clientHost: string | null;
  readonly redirectHost: string;
  readonly loopbackOnly: boolean;
  readonly scopes: readonly string[];
  readonly supportEmail: string;
}

export function renderConsentPage(p: ConsentPageInput): string {
  const s = strings(p.locale);
  const name = p.clientName || p.clientHost || 'Unknown app';
  const identity = p.clientHost
    ? `<div class="host">${esc(p.clientHost)}</div><div class="muted">${esc(name)} · ${s.verifiedHost} ${esc(p.clientHost)}</div>`
    : `<div class="host">${esc(name)}</div><div class="muted"><span class="pill">DCR</span> ${s.unverified}</div>`;
  const writeRequested = p.scopes.includes('shop.write');
  const scopes = [
    `<li>✓ ${s.canRead}</li>`,
    writeRequested ? `<li><label class="check" style="margin:0"><input type="checkbox" name="grant_write" value="1" checked> <span>${s.canWrite}</span></label></li>` : '',
    p.scopes.includes('offline_access') ? `<li>✓ ${s.refresh}</li>` : ''
  ].join('');
  const shop = `${esc(p.account.shopName)}${p.account.isSandbox && !/sample|mẫu|demo/i.test(p.account.shopName) ? ` <span class="pill">${s.sample}</span>` : ''}`;
  const body = `
<div class="card"><h1>${s.consentTitle}</h1>
<ul class="facts"><li><div class="muted">${s.app}</div>${identity}</li>
<li><div class="muted">${s.sendsTo}</div><div class="host">${esc(p.redirectHost)}</div></li>
<li><div class="muted">${s.signedInAs}</div>${esc(p.account.email)}</li><li><div class="muted">${s.shop}</div>${shop}</li></ul>
${p.loopbackOnly ? `<div class="warn">${s.loopbackWarn}</div>` : ''}
<form method="post" action="/oauth/authorize">${hiddenInputs(p.hidden)}<ul class="scopes">${scopes}</ul>
<div class="row"><button type="submit" name="action" value="deny">${s.deny}</button><button class="primary" type="submit" name="action" value="allow">${s.allow}</button></div>
<p class="muted" style="margin-top:14px">${s.revokeNote} <a href="/account">${s.accountPage}</a>. <button type="submit" name="action" value="switch" style="padding:2px 8px;font-size:13px">${s.switchAccount}</button></p>
</form></div>`;
  return layout(p.locale, s.consentTitle, body, p.supportEmail);
}

export interface AccountPageInput {
  readonly locale: Locale;
  readonly account: WebAccount;
  readonly grants: readonly GrantSummary[];
  readonly csrf: string;
  readonly notice: MessageKey | null;
  readonly error: MessageKey | null;
  readonly supportEmail: string;
}

function appLabel(g: GrantSummary): string {
  if (g.registrationType === 'cimd') {
    try {
      return `${g.clientName || new URL(g.clientId).host} (${new URL(g.clientId).host})`;
    } catch {
      return g.clientName || g.clientId;
    }
  }
  const host = g.redirectUris[0] ? (() => { try { return new URL(g.redirectUris[0] ?? '').host; } catch { return ''; } })() : '';
  return `${g.clientName || 'App'}${host ? ` → ${host}` : ''}`;
}

export function renderAccountPage(p: AccountPageInput): string {
  const s = strings(p.locale);
  const csrf = `<input type="hidden" name="csrf" value="${esc(p.csrf)}">`;
  const apps = p.grants.length === 0
    ? `<p class="muted">${s.noApps}</p>`
    : p.grants.map((g) => `<div class="app"><div><b>${esc(appLabel(g))}</b><div class="muted">${esc(g.scopes.join(' '))} · ${s.lastUsed} ${esc(g.lastUsedAt.slice(0, 16).replace('T', ' '))} UTC</div></div>
<form method="post" action="/account">${csrf}<input type="hidden" name="client_id" value="${esc(g.clientId)}"><button type="submit" name="action" value="revoke">${s.revoke}</button></form></div>`).join('');
  const shop = `${esc(p.account.shopName)}${p.account.isSandbox && !/sample|mẫu|demo/i.test(p.account.shopName) ? ` <span class="pill">${s.sample}</span>` : ''}`;
  const body = `
<div class="card"><h1>${s.accountTitle}</h1>
${p.notice ? `<div class="ok" role="status">${s[p.notice]}</div>` : ''}${p.error ? `<div class="err" role="alert">${s[p.error]}</div>` : ''}
<ul class="facts"><li><div class="muted">${s.email}</div>${esc(p.account.email)}</li><li><div class="muted">${s.shop}</div>${shop}</li></ul>
<form method="post" action="/account">${csrf}<button type="submit" name="action" value="logout">${s.signout}</button></form></div>
<div class="card"><h2>${s.connectedApps}</h2>${apps}</div>
<div class="card"><h2>${s.linkTitle}</h2><p class="muted">${s.linkLead}</p>
<form method="post" action="/account">${csrf}<label for="inv">${s.inviteCode}</label><input id="inv" type="text" name="invite_code" autocomplete="off" required maxlength="40">
<div class="row"><button type="submit" name="action" value="link">${s.link}</button></div></form></div>
<div class="card"><h2>${s.deleteTitle}</h2><p class="muted">${s.deleteLead}</p>
<form method="post" action="/account">${csrf}<label for="del">${s.deleteConfirm}</label><input id="del" type="email" name="confirm_email" autocomplete="off" required>
<div class="row"><button type="submit" name="action" value="delete">${s.deleteButton}</button></div></form></div>`;
  return layout(p.locale, s.accountTitle, body, p.supportEmail);
}

export function renderErrorPage(locale: Locale, message: string, supportEmail: string): string {
  const s = strings(locale);
  return layout(locale, s.errorTitle, `<div class="card"><h1>${s.errorTitle}</h1><div class="err" role="alert">${esc(message)}</div></div>`, supportEmail);
}
