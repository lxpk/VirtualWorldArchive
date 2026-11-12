// Shared header and helpers for the portal pages.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let mePromise = null;
// The signed-in user and their site permissions: { user, permissions, google, registration }.
export function me() {
  mePromise ||= api('/api/me').catch(() => ({ user: null, permissions: [], google: false, registration: false }));
  return mePromise;
}
export const has = (m, perm) => m.permissions.includes(perm) || m.permissions.includes('site.admin');

// Internet Archive-style top bar: logo and sections on the left, then
// search box | SIGN UP | LOG IN | UPLOAD on the right.
const ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 6 9.5h4V16h4V9.5h4z" fill="currentColor"/><path d="M4 15v5h16v-5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4.2" fill="currentColor"/><path d="M3.5 21c.8-4.6 4.2-7 8.5-7s7.7 2.4 8.5 7z" fill="currentColor"/></svg>',
};

export function header(active) {
  const el = document.createElement('header');
  el.className = 'topnav';
  const here = encodeURIComponent(location.pathname + location.search + location.hash);
  const q = location.pathname === '/' ? new URLSearchParams(location.search).get('q') || '' : '';
  el.innerHTML = `
    <a class="logo" href="/" title="Virtual World Archive">
      <svg viewBox="0 0 40 40" fill="#fff" aria-hidden="true"><rect x="4" y="32" width="32" height="4"/><rect x="6" y="12" width="4" height="18"/><rect x="14" y="12" width="4" height="18"/><rect x="22" y="12" width="4" height="18"/><rect x="30" y="12" width="4" height="18"/><path d="M3 10 20 3l17 7z"/></svg>
      <span>Virtual World Archive</span>
    </a>
    <nav class="sections">
      <a class="ext" href="https://archive.org/details/software">Software</a>
      <a href="/" class="${active === 'servers' ? 'active' : ''}">Server Library</a>
      <a href="/toolkit.html" class="${active === 'toolkit' ? 'active' : ''}">Toolkit</a>
      <a href="/admin" class="${active === 'admin' ? 'active' : ''}" data-admin hidden>Access control</a>
    </nav>
    <div class="topright">
      <form class="search" action="/" method="get" role="search">
        <input type="search" name="q" placeholder="Search worlds" aria-label="Search worlds" value="${esc(q)}">
        <button aria-label="Search">${ICONS.search}</button>
      </form>
      <div class="account" data-account>
        <span class="usericon">${ICONS.user}</span>
        <a href="/login?mode=register&next=${here}">Sign up</a><span class="sep">|</span><a href="/login?next=${here}">Log in</a>
      </div>
      <a class="uploadbtn ${active === 'upload' ? 'active' : ''}" href="/#upload" data-upload>${ICONS.upload}<span>Upload</span></a>
    </div>`;
  document.body.prepend(el);
  me().then(m => {
    const box = el.querySelector('[data-account]');
    if (has(m, 'access.manage')) el.querySelector('[data-admin]').hidden = false;
    if (!m.registration) box.innerHTML = `<span class="usericon">${ICONS.user}</span><a href="/login?next=${here}">Log in</a>`;
    if (m.user) {
      box.innerHTML = `<span class="usericon">${ICONS.user}</span>
        <a href="/account" class="${active === 'account' ? 'active' : ''}">${esc(m.user.name)}</a><span class="sep">|</span>
        <button class="linkbtn" data-signout>Log out</button>`;
      box.querySelector('[data-signout]').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };
    } else {
      el.querySelector('[data-upload]').href = '/login?next=' + encodeURIComponent('/#upload');
    }
  });
}

// fetch wrapper: JSON in and out; plain objects are sent as JSON.
export async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData) && typeof o.body === 'object') {
    o.body = JSON.stringify(o.body); o.headers = { 'content-type': 'application/json', ...(o.headers || {}) };
  }
  const r = await fetch(path, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
  return j;
}

export function pill(state) {
  const s = state || 'unknown';
  return `<span class="pill ${esc(s)}">${esc(s)}</span>`;
}

// Policy badge for a server tile or page.
export function policyBadge(policy) {
  if (!policy) return '';
  const parts = [];
  if (policy.mode === 'managed') parts.push('<span class="badge managed" title="Managed Server Instance: only bound group roles administer it">Managed</span>');
  if (policy.access === 'members') parts.push('<span class="badge" title="Sign in to join">Members</span>');
  if (policy.access === 'restricted') parts.push('<span class="badge restricted" title="Only bound group roles can join">Restricted</span>');
  return parts.join(' ');
}
