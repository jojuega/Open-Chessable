/**
 * Open-Chessable — API Client
 * Communicates with the Flask backend REST API.
 */

const API = {
  // ─── Backend base URL ─────────────────────────────────────────────
  // Resolution order:
  //   1. ?api=https://backend.example.com   (URL param, persisted)
  //   2. localStorage 'oc_api_base'         (previously saved)
  //   3. window.OC_API_BASE                 (injected by host page)
  //   4. Same origin as the page            (backend serves frontend)
  //   5. http://localhost:5000/api          (static frontend on localhost)
  //
  // Key insight: if the page is served by the Flask backend itself
  // (through a tunnel, LAN IP, or direct localhost), the API lives on
  // the SAME origin.  We detect that by checking whether the page's
  // hostname is localhost/127.0.0.1 — if so we use localhost:5000,
  // otherwise we use the page's own origin.
  base: (() => {
    try {
      const url = new URL(window.location.href);
      const fromParam = url.searchParams.get('api');
      if (fromParam) {
        const clean = fromParam.replace(/\/$/, '') + '/api';
        localStorage.setItem('oc_api_base', clean);
        return clean;
      }
    } catch (e) { /* ignore */ }

    const stored = localStorage.getItem('oc_api_base');
    if (stored) return stored;
    if (window.OC_API_BASE) return window.OC_API_BASE.replace(/\/$/, '');

    const host = window.location.hostname;
    const isLocalPage = host === 'localhost' || host === '127.0.0.1' || host === '';
    if (isLocalPage) {
      // Static file opened from disk or a dev server — backend on :5000
      return 'http://localhost:5000/api';
    }
    // Page served by the Flask backend (direct or via tunnel) — same origin
    return window.location.origin + '/api';
  })(),

  /** Override the backend URL at runtime and persist it. */
  setBase(url) {
    const clean = url.replace(/\/$/, '') + (url.endsWith('/api') ? '' : '/api');
    this.base = clean;
    try { localStorage.setItem('oc_api_base', clean); } catch (e) { /* ignore */ }
  },

  async _fetch(url, options = {}) {
    const defaults = {
      headers: { 'Content-Type': 'application/json' },
    };
    const res = await fetch(url, { ...defaults, ...options });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },

  // ─── Courses ───────────────────────────────────

  getCourses() {
    return this._fetch(`${this.base}/courses`);
  },

  createCourse(name, description = '', videoUrl = '', colorSide = 'both') {
    return this._fetch(`${this.base}/courses`, {
      method: 'POST',
      body: JSON.stringify({ name, description, video_url: videoUrl, color_side: colorSide }),
    });
  },

  getCourse(courseId) {
    return this._fetch(`${this.base}/courses/${courseId}`);
  },

  deleteCourse(courseId) {
    return this._fetch(`${this.base}/courses/${courseId}`, { method: 'DELETE' });
  },

  // ─── Chapters ──────────────────────────────────

  getChapters(courseId) {
    return this._fetch(`${this.base}/courses/${courseId}/chapters`);
  },

  createChapter(courseId, name, description = '', videoUrl = '') {
    return this._fetch(`${this.base}/courses/${courseId}/chapters`, {
      method: 'POST',
      body: JSON.stringify({ name, description, video_url: videoUrl }),
    });
  },

  deleteChapter(chapterId) {
    return this._fetch(`${this.base}/chapters/${chapterId}`, { method: 'DELETE' });
  },

  // ─── PGN Import ────────────────────────────────

  async importPgn(chapterId, pgnText) {
    return this._fetch(`${this.base}/chapters/${chapterId}/import-pgn`, {
      method: 'POST',
      body: JSON.stringify({ pgn: pgnText }),
    });
  },

  async importPgnFile(chapterId, file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${this.base}/chapters/${chapterId}/import-pgn`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  // ─── Trainer ───────────────────────────────────

  getDueMoves(courseId = null, side = null, limit = 20) {
    const params = new URLSearchParams();
    if (courseId) params.set('course_id', courseId);
    if (side) params.set('side', side);
    if (limit) params.set('limit', limit);
    return this._fetch(`${this.base}/trainer/due?${params}`);
  },

  getLearnQueue(courseId = null, side = null, limit = 50) {
    const params = new URLSearchParams();
    if (courseId) params.set('course_id', courseId);
    if (side) params.set('side', side);
    if (limit) params.set('limit', limit);
    return this._fetch(`${this.base}/trainer/learn?${params}`);
  },

  getMove(moveId) {
    return this._fetch(`${this.base}/trainer/move/${moveId}`);
  },

  async reviewMove(moveId, outcome = 'correct', attempts = 1, gotRight = true) {
    return this._fetch(`${this.base}/trainer/review`, {
      method: 'POST',
      body: JSON.stringify({ 
        move_id: moveId, 
        outcome: outcome,
        attempts: attempts,
        got_right: gotRight,
      }),
    });
  },

  // ─── Stats ─────────────────────────────────────

  getStats() {
    return this._fetch(`${this.base}/stats`);
  },
};
