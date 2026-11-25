// Tiny IndexedDB wrapper storing captures (image tiles are Blobs).
const DB_NAME = 'pagetopdf';
const STORE = 'captures';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result, failure;
    Promise.resolve(fn(store)).then(r => { result = r; }, e => { failure = e; try { t.abort(); } catch { /* already finished */ } });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(failure || t.error);
    t.onabort = () => reject(failure || t.error);
  }));
}

const req2p = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const putCapture = rec => tx('readwrite', s => req2p(s.put(rec)));
export const getCapture = id => tx('readonly', s => req2p(s.get(id)));
export const deleteCapture = id => tx('readwrite', s => req2p(s.delete(id)));
// Read-modify-write in one transaction, so concurrent updates (edits being saved while the
// thumbnail is redrawn) never overwrite each other's fields.
export const updateCapture = (id, patch) => tx('readwrite', s => new Promise((resolve, reject) => {
  const get = s.get(id);
  get.onsuccess = () => {
    const rec = get.result;
    if (!rec) return reject(new Error('Capture not found'));
    Object.assign(rec, patch);
    s.put(rec);
    resolve(rec);
  };
  get.onerror = () => reject(get.error);
}));

// Lightweight listing without the big tile blobs.
export const listCaptures = () => tx('readonly', s => new Promise((resolve, reject) => {
  const out = [];
  const req = s.index('createdAt').openCursor(null, 'prev');
  req.onsuccess = () => {
    const c = req.result;
    if (!c) return resolve(out);
    const { id, url, title, createdAt, width, height, thumb, scale, cssWidth, cssHeight } = c.value;
    out.push({ id, url, title, createdAt, width, height, thumb, scale, cssWidth, cssHeight });
    c.continue();
  };
  req.onerror = () => reject(req.error);
}));
