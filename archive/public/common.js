// Shared header and helpers for the portal pages.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function header(active) {
  const el = document.createElement('header');
  el.className = 'topnav';
  el.innerHTML = `
    <a class="logo" href="/">
      <svg viewBox="0 0 40 40" fill="#fff" aria-hidden="true"><rect x="4" y="32" width="32" height="4"/><rect x="6" y="12" width="4" height="18"/><rect x="14" y="12" width="4" height="18"/><rect x="22" y="12" width="4" height="18"/><rect x="30" y="12" width="4" height="18"/><path d="M3 10 20 3l17 7z"/></svg>
      Virtual World Archive
    </a>
    <nav>
      <a href="https://archive.org/details/software">Software</a>
      <a href="https://archive.org/details/emulation">Emulation</a>
      <a href="/" class="${active === 'servers' ? 'active' : ''}">Server Library</a>
      <a href="/#upload" class="${active === 'upload' ? 'active' : ''}">Upload</a>
      <a href="/toolkit.html" class="${active === 'toolkit' ? 'active' : ''}">Toolkit</a>
    </nav>`;
  document.body.prepend(el);
}

export async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export function pill(state) {
  const s = state || 'unknown';
  return `<span class="pill ${esc(s)}">${esc(s)}</span>`;
}
