/**
 * Open-Chessable — Main App (SPA Router)
 * Hash-based routing: #dashboard, #courses, #course/:id, #train, #import
 */

const App = {
  currentRoute: 'dashboard',
  currentParams: {},

  async init() {
    // Nav links
    document.querySelectorAll('.nav-item').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigate(link.dataset.route);
      });
    });

    window.addEventListener('hashchange', () => this.route());

    // Preload pieces
    if (typeof Board !== 'undefined' && Board.preloadPieces) {
      Board.preloadPieces().catch(err => console.warn('Piece preload:', err));
    }

    // Modal close
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModal();
    });

    this.route();
    this.updateSidebarStats();
  },

  route() {
    const hash = (window.location.hash.slice(1) || 'dashboard').replace(/^\/+/, '');
    const parts = hash.split('/');
    const route = parts[0] || 'dashboard';
    const params = {};
    if (parts.length > 1) params.id = parseInt(parts[1]);
    if (parts.length > 2) params.side = parts[2];

    this.currentRoute = route;
    this.currentParams = params;

    document.querySelectorAll('.nav-item').forEach(link => {
      const linkRoute = link.dataset.route;
      link.classList.toggle('active',
        route === linkRoute || (route === 'course' && linkRoute === 'courses'));
    });

    this.renderPage(route, params);
  },

  navigate(route, ...args) {
    let hash = route;
    if (args.length > 0) hash += '/' + args.join('/');
    window.location.hash = hash;
  },

  refresh() { this.route(); },

  async renderPage(route, params) {
    const main = document.getElementById('main-content');
    switch (route) {
      case 'dashboard': await this.renderDashboard(main); break;
      case 'courses': await Courses.renderList(main); break;
      case 'course':
        if (params.id) await Courses.renderDetail(main, params.id);
        else await Courses.renderList(main);
        break;
      case 'train': await Trainer.start(main, params.id || null, params.side || null); break;
      case 'import': await this.renderImport(main); break;
      default:
        main.innerHTML = `<div class="page"><h1 class="page-title">404</h1><p class="page-subtitle">Page not found</p></div>`;
    }
  },

  // ─── Dashboard ─────────────────────────────────────────────

  async renderDashboard(container) {
    container.innerHTML = `
      <div class="page">
        <div class="page-header">
          <div>
            <h1 class="page-title">Dashboard</h1>
            <p class="page-subtitle">Your SRS training overview</p>
          </div>
          <div class="page-actions">
            <button class="btn btn-primary" onclick="App.navigate('train')">Start Training</button>
          </div>
        </div>

        <div class="stats-grid" id="stats-grid">
          <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Courses</div></div>
          <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Total Moves</div></div>
          <div class="stat-card accent"><div class="stat-value">—</div><div class="stat-label">Due Today</div></div>
          <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Mastered</div></div>
        </div>

        <div class="section-header">
          <span class="section-title">Recent Courses</span>
          <button class="btn btn-ghost btn-sm" onclick="App.navigate('courses')">View all</button>
        </div>
        <div id="recent-courses" class="card-grid">
          <div class="empty-state" style="grid-column:1/-1;">
            <div class="empty-state-title">Loading...</div>
          </div>
        </div>
      </div>
    `;

    try {
      const [stats, courses] = await Promise.all([API.getStats(), API.getCourses()]);

      document.getElementById('stats-grid').innerHTML = `
        <div class="stat-card"><div class="stat-value">${stats.total_courses}</div><div class="stat-label">Courses</div></div>
        <div class="stat-card"><div class="stat-value">${stats.total_moves}</div><div class="stat-label">Total Moves</div></div>
        <div class="stat-card accent"><div class="stat-value">${stats.due_moves}</div><div class="stat-label">Due Today</div></div>
        <div class="stat-card"><div class="stat-value">${stats.mastered_moves}</div><div class="stat-label">Mastered</div></div>
      `;

      const recentEl = document.getElementById('recent-courses');
      if (!courses.length) {
        recentEl.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1;">
            <div class="empty-state-icon">📚</div>
            <div class="empty-state-title">No courses yet</div>
            <div class="empty-state-desc">Create your first course or import a PGN to get started</div>
            <div class="flex gap-8">
              <button class="btn btn-primary" onclick="Courses.showCreateModal()">+ Create Course</button>
              <button class="btn btn-secondary" onclick="App.navigate('import')">Import PGN</button>
            </div>
          </div>`;
      } else {
        recentEl.innerHTML = courses.slice(0, 4).map(c => {
          const dueBadge = c.due_moves > 0
            ? `<span class="badge yellow">${c.due_moves} due</span>`
            : `<span class="badge green">Caught up</span>`;
          return `
            <div class="card" onclick="App.navigate('course', ${c.id})" style="cursor:pointer;">
              <div class="card-title">${Courses.escapeHtml(c.name)}</div>
              <div class="card-desc">${c.total_moves} moves · ${c.mastered_moves} mastered</div>
              <div class="card-actions">
                ${dueBadge}
                <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); App.navigate('train', ${c.id})">Train</button>
              </div>
            </div>`;
        }).join('');
      }
    } catch (err) {
      console.error('Dashboard load error:', err);
    }
  },

  // ─── Import page (FULL COURSE + single chapter) ─────────────

  async renderImport(container) {
    container.innerHTML = `
      <div class="page">
        <div class="page-header">
          <div>
            <h1 class="page-title">Import PGN</h1>
            <p class="page-subtitle">Import chess variations from PGN files</p>
          </div>
        </div>

        <div class="tabs">
          <button class="tab active" onclick="App.switchImportTab('course')">Full Course</button>
          <button class="tab" onclick="App.switchImportTab('chapter')">Single Chapter</button>
        </div>

        <!-- Full course import -->
        <div id="import-course-panel">
          <div class="card">
            <div class="card-title">Import Full Course</div>
            <div class="card-desc">
              Upload a PGN file where each game's <code>[White]</code> or <code>[Black]</code> tag
              becomes a chapter. All games are merged into one course with automatic
              deduplication of shared positions.
            </div>

            <div class="form-group mt-16">
              <label class="form-label">Course Name</label>
              <input class="form-input" id="import-course-name" placeholder="e.g. Modern Benoni Repertoire">
            </div>

            <div class="form-group">
              <label class="form-label">Chapter Tag</label>
              <select class="form-select" id="import-course-tag">
                <option value="White">White (chapter name in [White] tag)</option>
                <option value="Black">Black (chapter name in [Black] tag)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">PGN File</label>
              <div class="dropzone" id="course-dropzone" onclick="document.getElementById('import-course-file').click()">
                <div class="dropzone-icon">📄</div>
                <div class="dropzone-title">Drop PGN file here or click to browse</div>
                <div class="dropzone-desc">Supports multi-game PGN with variations and comments</div>
              </div>
              <input type="file" id="import-course-file" accept=".pgn" class="hidden">
            </div>

            <div class="form-group">
              <label class="form-label">Or paste PGN text</label>
              <textarea class="form-textarea" id="import-course-text" rows="6"
                placeholder='[Event "Chapter 1"]\n[White "Najdorf"]\n\n1. e4 c5 2. Nf3 d6 ...'></textarea>
            </div>

            <div class="flex gap-8 justify-between items-center">
              <div id="import-course-status" class="text-muted text-small"></div>
              <button class="btn btn-primary" onclick="App.doImportCourse()">Import Course</button>
            </div>
          </div>
        </div>

        <!-- Chapter import -->
        <div id="import-chapter-panel" class="hidden">
          <div class="card">
            <div class="card-title">Import to Chapter</div>
            <div class="card-desc">
              Add PGN variations to an existing chapter. Each leaf node becomes a learnable move.
            </div>

            <div class="form-group mt-16">
              <label class="form-label">Select Chapter</label>
              <select class="form-select" id="import-chapter-select">
                <option value="">Loading chapters...</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">PGN File</label>
              <input type="file" class="form-input" id="import-chapter-file" accept=".pgn">
            </div>

            <div class="form-group">
              <label class="form-label">Or paste PGN text</label>
              <textarea class="form-textarea" id="import-chapter-text" rows="6"
                placeholder="1. e4 e5 2. Nf3 Nc6 (2... Nf6 3. Nxe5 d6) 3. Bb5 a6 *"></textarea>
            </div>

            <div class="flex gap-8 justify-between items-center">
              <div id="import-chapter-status" class="text-muted text-small"></div>
              <button class="btn btn-primary" onclick="App.doImportChapter()">Import to Chapter</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Load chapters for the chapter tab
    this.loadChapterSelect();

    // Drag & drop for course dropzone
    const dz = document.getElementById('course-dropzone');
    const fileInput = document.getElementById('import-course-file');

    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        dz.querySelector('.dropzone-title').textContent = e.dataTransfer.files[0].name;
      }
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) {
        dz.querySelector('.dropzone-title').textContent = fileInput.files[0].name;
      }
    });
  },

  switchImportTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('import-course-panel').classList.toggle('hidden', tab !== 'course');
    document.getElementById('import-chapter-panel').classList.toggle('hidden', tab !== 'chapter');
  },

  async loadChapterSelect() {
    try {
      const courses = await API.getCourses();
      const select = document.getElementById('import-chapter-select');
      if (!courses.length) {
        select.innerHTML = '<option value="">No courses found</option>';
        return;
      }
      let html = '';
      for (const c of courses) {
        const chapters = await API.getChapters(c.id);
        if (chapters.length) {
          html += `<optgroup label="${Courses.escapeHtml(c.name)}">`;
          chapters.forEach(ch => {
            html += `<option value="${ch.id}">${Courses.escapeHtml(ch.name)} (${ch.total_moves} moves)</option>`;
          });
          html += '</optgroup>';
        }
      }
      select.innerHTML = html || '<option value="">No chapters found</option>';
    } catch (err) {
      console.error('Failed to load chapters:', err);
    }
  },

  async doImportCourse() {
    const name = document.getElementById('import-course-name').value.trim();
    const tag = document.getElementById('import-course-tag').value;
    const file = document.getElementById('import-course-file').files[0];
    const text = document.getElementById('import-course-text').value.trim();
    const status = document.getElementById('import-course-status');

    if (!name) { App.toast('Course name is required', 'error'); return; }
    if (!file && !text) { App.toast('Provide a PGN file or paste text', 'error'); return; }

    status.textContent = 'Creating course...';

    try {
      // Create course
      const course = await API.createCourse(name, '', '', 'both');
      const courseId = course.id || course;
      status.textContent = 'Importing PGN...';

      // Import full course PGN
      let result;
      if (file) {
        result = await API.importCoursePgnFile(courseId, file, tag);
      } else {
        result = await API.importCoursePgn(courseId, text, tag);
      }

      status.textContent = '';
      App.toast(`Imported ${result.imported} moves into ${result.chapters_total} chapters`, 'success');
      App.navigate('course', courseId);
    } catch (err) {
      status.textContent = '';
      App.toast(err.message, 'error');
    }
  },

  async doImportChapter() {
    const chapterId = document.getElementById('import-chapter-select').value;
    const file = document.getElementById('import-chapter-file').files[0];
    const text = document.getElementById('import-chapter-text').value.trim();
    const status = document.getElementById('import-chapter-status');

    if (!chapterId) { App.toast('Select a chapter', 'error'); return; }
    if (!file && !text) { App.toast('Provide a PGN file or paste text', 'error'); return; }

    status.textContent = 'Importing...';

    try {
      let result;
      if (file) {
        result = await API.importPgnFile(parseInt(chapterId), file);
      } else {
        result = await API.importPgn(parseInt(chapterId), text);
      }
      status.textContent = '';
      App.toast(`Imported ${result.imported} moves (${result.skipped_duplicates} duplicates)`, 'success');
      if (Courses.currentCourseId) App.navigate('course', Courses.currentCourseId);
    } catch (err) {
      status.textContent = '';
      App.toast(err.message, 'error');
    }
  },

  // ─── Sidebar stats ─────────────────────────────────────────

  async updateSidebarStats() {
    try {
      const stats = await API.getStats();
      document.getElementById('sidebar-stats').textContent =
        `${stats.total_courses} courses · ${stats.total_moves} moves`;
    } catch (e) { /* ignore */ }
  },

  // ─── Modal ─────────────────────────────────────────────────

  closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-content').innerHTML = '';
  },

  // ─── Toast ─────────────────────────────────────────────────

  toast(message, type = '') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
