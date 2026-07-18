/**
 * Open-Chessable — Main App (SPA Router)
 * Hash-based routing: #dashboard, #courses, #train, #import, #course/:id
 */

const App = {
  currentRoute: 'dashboard',
  currentParams: {},

  async init() {
    // Set up navigation links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const route = link.dataset.route;
        this.navigate(route);
      });
    });

    // Handle hash changes
    window.addEventListener('hashchange', () => this.route());
    
    // Initial route
    this.route();

    // Close modal on overlay click
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });

    // Keyboard shortcut: Escape to close modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModal();
    });
  },

  route() {
    const hash = window.location.hash.slice(1) || 'dashboard';
    const parts = hash.split('/');
    const route = parts[0];
    
    // Extract params: #course/123, #train/123, #train/123/white
    const params = {};
    if (parts.length > 1) params.id = parseInt(parts[1]);
    if (parts.length > 2) params.side = parts[2];

    this.currentRoute = route;
    this.currentParams = params;

    // Update nav active state
    document.querySelectorAll('.nav-link').forEach(link => {
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

  refresh() {
    this.route();
  },

  async renderPage(route, params) {
    const main = document.getElementById('main-content');
    
    switch (route) {
      case 'dashboard':
        await this.renderDashboard(main);
        break;
      case 'courses':
        await Courses.renderList(main);
        break;
      case 'course':
        if (params.id) {
          await Courses.renderDetail(main, params.id);
        } else {
          await Courses.renderList(main);
        }
        break;
      case 'train':
        await Trainer.start(main, params.id || null, params.side || null);
        break;
      case 'import':
        this.renderImport(main);
        break;
      default:
        main.innerHTML = `<div class="page"><h1>404</h1><p>Page not found</p></div>`;
    }
  },

  async renderDashboard(container) {
    container.innerHTML = `
      <div class="page">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">Your SRS training overview</p>
        <div id="stats-grid" class="stats-grid">
          <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Courses</div></div>
          <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Total Moves</div></div>
          <div class="stat-card accent"><div class="stat-value">-</div><div class="stat-label">Due Today</div></div>
          <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Mastered</div></div>
          <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Reviewed Today</div></div>
        </div>
        
        <div class="section-header">
          <span class="section-title">Quick Actions</span>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-lg" onclick="App.navigate('train')">🎯 Start Training</button>
          <button class="btn btn-secondary btn-lg" onclick="App.navigate('courses')">📚 Browse Courses</button>
        </div>
        
        <div class="section-header" style="margin-top:24px;">
          <span class="section-title">Recent Courses</span>
        </div>
        <div id="recent-courses" class="card-grid">
          <div class="empty-state" style="grid-column:1/-1;">
            <div class="empty-state-title">Loading...</div>
          </div>
        </div>
      </div>
    `;

    try {
      const stats = await API.getStats();
      const courses = await API.getCourses();

      // Update stats
      document.getElementById('stats-grid').innerHTML = `
        <div class="stat-card">
          <div class="stat-value">${stats.total_courses}</div>
          <div class="stat-label">Courses</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.total_moves}</div>
          <div class="stat-label">Total Moves</div>
        </div>
        <div class="stat-card accent">
          <div class="stat-value">${stats.due_moves}</div>
          <div class="stat-label">Due Today</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.mastered_moves}</div>
          <div class="stat-label">Mastered</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.reviewed_today}</div>
          <div class="stat-label">Reviewed Today</div>
        </div>
      `;

      // Recent courses
      const recentEl = document.getElementById('recent-courses');
      if (!courses.length) {
        recentEl.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1;">
            <div class="empty-state-icon">📚</div>
            <div class="empty-state-title">No courses yet</div>
            <div class="empty-state-desc">Create your first course to start training</div>
            <button class="btn btn-primary" onclick="Courses.showCreateModal()">+ Create Course</button>
          </div>`;
      } else {
        recentEl.innerHTML = courses.slice(0, 4).map(c => {
          const dueBadge = c.due_moves > 0
            ? `<span class="badge yellow">${c.due_moves} due</span>`
            : '';
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

  renderImport(container) {
    container.innerHTML = `
      <div class="page">
        <h1 class="page-title">Import PGN</h1>
        <p class="page-subtitle">Import chess variations from PGN files into your courses</p>
        
        <div class="card" style="max-width:600px;">
          <div class="card-title">Bulk Import Guide</div>
          <div class="card-desc" style="margin-top:8px;">
            <p style="margin-bottom:8px;">
              To import a PGN file, go to a <strong>Course → Chapter</strong> and click 
              <strong>"Import PGN"</strong>. Each chapter can hold one or more PGN files.
            </p>
            <p style="margin-bottom:8px;">
              <strong>PGN format tips:</strong>
            </p>
            <ul style="padding-left:20px;color:var(--text-muted);font-size:14px;">
              <li>Use variations (parentheses) for side-lines</li>
              <li>Each leaf node becomes a learnable move</li>
              <li>Comments on moves are preserved</li>
              <li>Standard PGN notation (1. e4 e5 2. Nf3...)</li>
            </ul>
          </div>
          <div class="card-actions" style="margin-top:12px;">
            <button class="btn btn-primary" onclick="App.navigate('courses')">Go to Courses</button>
          </div>
        </div>
      </div>
    `;
  },

  // ─── Modal ────────────────────────────────────────

  closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-content').innerHTML = '';
  },

  // ─── Toast ────────────────────────────────────────

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
    }, 3000);
  },
};

// Boot the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
