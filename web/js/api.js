/**
 * Open-Chessable — API Client
 * Communicates with the Flask backend REST API.
 */

const API = {
  base: '/api',

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
