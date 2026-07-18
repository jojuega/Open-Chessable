/**
 * Open-Chessable — Course Management UI
 * Handles course list, detail, and chapter management views.
 */

const Courses = {
  currentCourseId: null,

  async renderList(container) {
    container.innerHTML = `
      <div class="page">
        <div class="section-header">
          <div>
            <h1 class="page-title">Courses</h1>
            <p class="page-subtitle">Your chess SRS training courses</p>
          </div>
          <button class="btn btn-primary" onclick="Courses.showCreateModal()">+ New Course</button>
        </div>
        <div id="courses-list" class="card-grid">
          <div class="empty-state">
            <div class="empty-state-icon">♟</div>
            <div class="empty-state-title">Loading courses...</div>
          </div>
        </div>
      </div>
    `;

    try {
      const courses = await API.getCourses();
      const listEl = document.getElementById('courses-list');
      
      if (!courses.length) {
        listEl.innerHTML = `
          <div class="empty-state" style="grid-column: 1/-1;">
            <div class="empty-state-icon">📚</div>
            <div class="empty-state-title">No courses yet</div>
            <div class="empty-state-desc">Create your first chess course to start SRS training</div>
            <button class="btn btn-primary" onclick="Courses.showCreateModal()">+ Create Course</button>
          </div>`;
        return;
      }

      listEl.innerHTML = courses.map(c => {
        const masteryPct = c.total_moves ? Math.round(c.mastered_moves / c.total_moves * 100) : 0;
        const dueBadge = c.due_moves > 0 
          ? `<span class="badge yellow">${c.due_moves} due</span>` 
          : `<span class="badge green">Caught up</span>`;
        
        return `
          <div class="card" onclick="App.navigate('course', ${c.id})" style="cursor:pointer;">
            <div class="card-title">${this.escapeHtml(c.name)}</div>
            <div class="card-desc">${this.escapeHtml(c.description || 'No description')}</div>
            <div class="card-meta">
              <span>📊 ${c.total_moves} moves</span>
              <span>⭐ ${c.mastered_moves} mastered (${masteryPct}%)</span>
              ${dueBadge}
            </div>
            <div class="card-actions">
              ${c.video_url ? `<span class="badge">📹 Video</span>` : ''}
              <span class="badge">${c.color_side === 'white' ? '⬜ White' : c.color_side === 'black' ? '⬛ Black' : '⬜⬛ Both'}</span>
              <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); Courses.deleteCourse(${c.id})">Delete</button>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      document.getElementById('courses-list').innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1;">
          <div class="empty-state-title">Error loading courses</div>
          <div class="empty-state-desc">${err.message}</div>
        </div>`;
    }
  },

  async renderDetail(container, courseId) {
    this.currentCourseId = courseId;
    
    try {
      const course = await API.getCourse(courseId);
      const chapters = await API.getChapters(courseId);

      container.innerHTML = `
        <div class="page">
          <div class="section-header">
            <div>
              <h1 class="page-title">${this.escapeHtml(course.name)}</h1>
              <p class="page-subtitle">${this.escapeHtml(course.description || '')}</p>
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-secondary" onclick="App.navigate('train', ${courseId})">🎯 Train</button>
              <button class="btn btn-primary" onclick="Courses.showAddChapterModal(${courseId})">+ Chapter</button>
            </div>
          </div>
          
          ${course.video_url ? Courses.videoEmbed(course.video_url) : ''}
          
          <div class="section-header" style="margin-top: 16px;">
            <span class="section-title">Chapters (${chapters.length})</span>
          </div>
          
          <div id="chapters-list" class="chapter-list">
            ${chapters.length === 0 ? `
              <div class="empty-state">
                <div class="empty-state-icon">📖</div>
                <div class="empty-state-title">No chapters yet</div>
                <div class="empty-state-desc">Add a chapter and import PGN variations to get started</div>
              </div>` 
            : chapters.map(ch => `
              <div class="chapter-item">
                <div>
                  <div class="chapter-name">${this.escapeHtml(ch.name)}</div>
                  <div class="chapter-meta">${ch.total_moves} moves · ${ch.due_moves} due</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                  ${ch.video_url ? `<span class="badge">📹</span>` : ''}
                  <button class="btn btn-danger btn-sm" onclick="Courses.deleteChapter(${ch.id}, ${courseId})">✕</button>
                </div>
              </div>`).join('')}
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="page"><p>Error: ${err.message}</p></div>`;
    }
  },

  // ─── Modals ───────────────────────────────────────

  showCreateModal() {
    const modal = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    
    content.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title">New Course</h2>
        <button class="modal-close" onclick="App.closeModal()">✕</button>
      </div>
      <div class="form-group">
        <label class="form-label">Course Name *</label>
        <input class="form-input" id="modal-course-name" placeholder="e.g. Sicilian Defense Repertoire" autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-textarea" id="modal-course-desc" placeholder="Brief description..." rows="2" style="min-height:60px;"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Video URL (YouTube embed)</label>
        <input class="form-input" id="modal-course-video" placeholder="https://www.youtube.com/watch?v=...">
      </div>
      <div class="form-group">
        <label class="form-label">Color Side</label>
        <select class="form-select" id="modal-course-side">
          <option value="both">Both (White & Black)</option>
          <option value="white">White only</option>
          <option value="black">Black only</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="modal-create-btn">Create Course</button>
      </div>
    `;
    modal.classList.remove('hidden');

    document.getElementById('modal-create-btn').onclick = async () => {
      const name = document.getElementById('modal-course-name').value.trim();
      if (!name) return App.toast('Course name is required', 'error');
      
      try {
        await API.createCourse(
          name,
          document.getElementById('modal-course-desc').value.trim(),
          document.getElementById('modal-course-video').value.trim(),
          document.getElementById('modal-course-side').value,
        );
        App.closeModal();
        App.toast('Course created!', 'success');
        App.refresh();
      } catch (err) {
        App.toast(err.message, 'error');
      }
    };
  },

  showAddChapterModal(courseId) {
    const modal = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    
    content.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title">Add Chapter</h2>
        <button class="modal-close" onclick="App.closeModal()">✕</button>
      </div>
      <div class="form-group">
        <label class="form-label">Chapter Name *</label>
        <input class="form-input" id="modal-chapter-name" placeholder="e.g. Najdorf Main Line" autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-textarea" id="modal-chapter-desc" placeholder="Brief description..." rows="2" style="min-height:60px;"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Video URL (optional)</label>
        <input class="form-input" id="modal-chapter-video" placeholder="https://www.youtube.com/watch?v=...">
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="modal-add-btn">Add Chapter</button>
      </div>
    `;
    modal.classList.remove('hidden');

    document.getElementById('modal-add-btn').onclick = async () => {
      const name = document.getElementById('modal-chapter-name').value.trim();
      if (!name) return App.toast('Chapter name is required', 'error');
      
      try {
        await API.createChapter(
          courseId,
          name,
          document.getElementById('modal-chapter-desc').value.trim(),
          document.getElementById('modal-chapter-video').value.trim(),
        );
        App.closeModal();
        App.toast('Chapter added!', 'success');
        App.navigate('course', courseId);
      } catch (err) {
        App.toast(err.message, 'error');
      }
    };
  },

  async deleteCourse(courseId) {
    if (!confirm('Delete this course and all its data? This cannot be undone.')) return;
    try {
      await API.deleteCourse(courseId);
      App.toast('Course deleted', 'success');
      App.refresh();
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async deleteChapter(chapterId, courseId) {
    if (!confirm('Delete this chapter and all its moves?')) return;
    try {
      await API.deleteChapter(chapterId);
      App.toast('Chapter deleted', 'success');
      App.navigate('course', courseId);
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  // ─── Helpers ──────────────────────────────────────

  videoEmbed(url) {
    let embedUrl = url;
    // Convert youtube watch URL to embed
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
    if (ytMatch) {
      embedUrl = `https://www.youtube.com/embed/${ytMatch[1]}`;
      return `<div class="video-embed"><iframe src="${embedUrl}" frameborder="0" allowfullscreen></iframe></div>`;
    }
    return '';
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
