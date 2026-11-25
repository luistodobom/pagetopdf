export const pad = n => String(n).padStart(2, '0');

export function formatDate(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function formatTime(d, sep = '_') {
  d = new Date(d);
  return `${pad(d.getHours())}${sep}${pad(d.getMinutes())}${sep}${pad(d.getSeconds())}`;
}
export function formatDateTime(d) {
  d = new Date(d);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function slug(s, max = 80) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/, '') || 'page';
}

export function buildFilename(template, rec, ext, directory = '') {
  let host = '', path = '';
  try { const u = new URL(rec.url); host = u.hostname; path = u.pathname; } catch { /* ignore */ }
  const vars = {
    url: slug(host + path),
    domain: slug(host),
    title: slug(rec.title),
    date: formatDate(rec.createdAt),
    time: formatTime(rec.createdAt),
    timestamp: String(Math.floor(rec.createdAt / 1000)),
  };
  let name = (template || 'screencapture-{url}-{date}-{time}').replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  name = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180) || 'screencapture';
  const dir = String(directory || '').replace(/\\/g, '/').replace(/[^A-Za-z0-9_\-\/ ]/g, '').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, '');
  return (dir ? dir + '/' : '') + name + '.' + ext;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
