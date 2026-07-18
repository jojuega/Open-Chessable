/**
 * Open-Chessable — Training UI (Chessable MoveTrainer-style)
 *
 * State machine (RESEARCH.md §13.4):
 *   IDLE → (user moves) → EVAL
 *     correct → CORRECT (auto-advance, XP toast)
 *     wrong   → WRONG_ATTEMPT (flash, retry if allowed) → RETRY → IDLE
 *             → (out of retries) → REVEAL (show answer, MUST replay) → ADVANCE
 *
 * Two modes:
 *   REVIEW — cards whose next_due <= now (level >= 1)
 *   LEARN  — brand-new cards (level = 0), shown in chapter/depth order
 *
 * Author comments attached to a move are rendered verbatim below the
 * board (RESEARCH.md §3.4).  Comment text may itself contain move
 * fragments (often pseudo-legal or flat-out illegal in the position) —
 * they are treated as plain text, never as moves.
 */

const Trainer = {
  // ─── Session state ──────────────────────────────
  moves: [],
  currentIndex: 0,
  currentMove: null,
  courseFilter: null,
  sideFilter: null,
  mode: 'review',           // 'review' | 'learn'

  // ─── Per-move state machine ─────────────────────
  state: 'IDLE',        // IDLE | EVAL | CORRECT | WRONG_ATTEMPT | RETRY | REVEAL | ADVANCE | LEARN_CARD | COMMENT_LINE
  attempts: 0,
  retryCount: 0,
  gaveUp: false,
  replayVerified: false,
  advanceTimer: null,
  failedThisMove: false,

  // ─── Learn-mode batch state (Chessable MT2) ──────
  // Learn mode is keyboard-driven: user navigates learnDepth cards with arrows,
  // then practice mode plays the same cards back via click.
  batch: {
    startIndex: 0,         // global index of first move in current batch
    size: 5,               // == settings.learnDepth
    learnStep: 0,          // 0..size-1 — index within batch currently shown
    practiceStep: -1,      // 0..size-1 during practice, -1 otherwise
    phase: 'learn',        // 'learn' | 'practice'
  },

  // ─── Practice-mode timer ────────────────────────
  timerInterval: null,
  timerRemaining: 0,        // seconds left
  timerTotal: 0,            // snapshot for ring math

  // ─── Comment-line mode visual state ──────────────
  commentLineMode: false,
  _savedState: null,        // { fen, state } — preserved when entering comment-line mode

  // ─── Keyboard handler (installed in start()) ────
  _keyHandler: null,

  // ─── Settings (Chessable MT2 defaults) ──────────
  settings: {
    enableRetry: true,
    maxRetries: 1,
    autoAdvanceMs: 900,
    learnDepth: 5,         // 3 | 5 | 10 | 15
    timeoutEnabled: true,
    timeoutSeconds: 5,     // 1..10
  },

  // ─── Session stats ──────────────────────────────
  sessionStats: { correct: 0, wrong: 0, xpEarned: 0, firstTry: 0 },

  // ══════════════════════════════════════════════════
  //  SETTINGS (persisted to localStorage)
  // ══════════════════════════════════════════════════

  SETTINGS_KEY: 'oc_trainer_settings',

  /** Load settings from localStorage, merging with defaults. */
  loadSettings() {
    const allowedDepths = [3, 5, 10, 15];
    try {
      const raw = window.localStorage?.getItem(this.SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (allowedDepths.includes(Number(parsed.learnDepth))) {
          this.settings.learnDepth = Number(parsed.learnDepth);
        }
        if (typeof parsed.timeoutEnabled === 'boolean') {
          this.settings.timeoutEnabled = parsed.timeoutEnabled;
        }
        const t = Number(parsed.timeoutSeconds);
        if (Number.isFinite(t) && t >= 0) {
          this.settings.timeoutSeconds = Math.max(1, Math.min(10, Math.round(t)));
        }
      }
    } catch (err) {
      console.warn('Failed to load trainer settings:', err);
    }
  },

  /** Persist current settings to localStorage. */
  saveSettings() {
    try {
      window.localStorage?.setItem(
        this.SETTINGS_KEY,
        JSON.stringify({
          learnDepth: this.settings.learnDepth,
          timeoutEnabled: this.settings.timeoutEnabled,
          timeoutSeconds: this.settings.timeoutSeconds,
        })
      );
    } catch (err) {
      console.warn('Failed to save trainer settings:', err);
    }
  },

  // ══════════════════════════════════════════════════
  //  ENTRY POINT
  // ══════════════════════════════════════════════════

  async start(container, courseId = null, side = null, mode = 'review') {
    // Always re-install fresh keyboard handler (idempotent)
    this.detachKeyboard();
    this._keyHandler = (e) => this.onKeyDown(e);
    document.addEventListener('keydown', this._keyHandler);

    this.loadSettings();

    this.courseFilter = courseId;
    this.sideFilter = side;
    this.mode = mode;
    this.moves = [];
    this.currentIndex = 0;
    this.sessionStats = { correct: 0, wrong: 0, xpEarned: 0, firstTry: 0 };
    this.batch = {
      startIndex: 0,
      size: this.settings.learnDepth,
      learnStep: 0,
      practiceStep: -1,
      phase: this.mode === 'learn' ? 'learn' : 'review',
    };
    this.stopPracticeTimer();

    const isLearn = mode === 'learn';
    container.innerHTML = `
      <div class="page page-trainer">
        <div class="section-header">
          <div>
            <h1 class="page-title">${isLearn ? '📖 Learn' : '🎯 Review'}</h1>
            <p class="page-subtitle">Loading ${isLearn ? 'new' : 'due'} moves…</p>
          </div>
          <div class="trainer-toolbar">
            <select class="form-select" id="trainer-mode-select" onchange="Trainer.switchMode()">
              <option value="review" ${!isLearn ? 'selected' : ''}>Review (due)</option>
              <option value="learn" ${isLearn ? 'selected' : ''}>Learn (new)</option>
            </select>
            <select class="form-select" id="trainer-side-filter" onchange="Trainer.restart()">
              <option value="">All Sides</option>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
            <button class="btn btn-secondary btn-sm" onclick="Board.flip()">🔄 Flip</button>
            <button class="btn btn-ghost btn-sm" id="trainer-settings-btn" onclick="Trainer.toggleSettingsPanel()" title="Settings">⚙</button>
            <button class="btn btn-ghost btn-sm" onclick="App.navigate('dashboard')" title="Exit (Esc)">✕ Exit</button>
          </div>
        </div>
        <div id="trainer-settings-panel" class="settings-panel hidden"></div>
        <div id="trainer-content">
          <div class="empty-state"><div class="empty-state-icon">🎯</div>
            <div class="empty-state-title">Loading moves…</div></div>
        </div>
      </div>`;

    if (side) {
      const sel = document.getElementById('trainer-side-filter');
      if (sel) sel.value = side;
    }
    await this.loadMoves();
  },

  /** Remove the keyboard listener. Idempotent. */
  detachKeyboard() {
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  },

  switchMode() {
    const m = document.getElementById('trainer-mode-select')?.value || 'review';
    this.mode = m;
    this.restart();
  },

  async restart() {
    const side = document.getElementById('trainer-side-filter')?.value || null;
    this.sideFilter = side || null;
    this.sessionStats = { correct: 0, wrong: 0, xpEarned: 0, firstTry: 0 };
    this.stopPracticeTimer();
    this.batch = {
      startIndex: 0,
      size: this.settings.learnDepth,
      learnStep: 0,
      practiceStep: -1,
      phase: this.mode === 'learn' ? 'learn' : 'review',
    };
    await this.loadMoves();
  },

  async loadMoves() {
    try {
      if (this.mode === 'learn') {
        this.moves = await API.getLearnQueue(this.courseFilter, this.sideFilter, 50);
      } else {
        this.moves = await API.getDueMoves(this.courseFilter, this.sideFilter, 50);
      }
      this.currentIndex = 0;
      this.batch.startIndex = 0;
      this.batch.learnStep = 0;
      this.batch.practiceStep = -1;
      this.batch.size = this.settings.learnDepth;
      this.batch.phase = this.mode === 'learn' ? 'learn' : 'review';

      if (this.moves.length === 0) {
        const isLearn = this.mode === 'learn';
        document.getElementById('trainer-content').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">${isLearn ? '📚' : '✅'}</div>
            <div class="empty-state-title">${isLearn ? 'Nothing new to learn' : 'All caught up!'}</div>
            <div class="empty-state-desc">${isLearn
              ? 'Every card in this course has been introduced. Try Review mode or pick a different course.'
              : 'No moves due for review right now. Switch to Learn mode to pick up new cards.'}</div>
            <button class="btn btn-primary" onclick="Trainer.switchTo('${isLearn ? 'review' : 'learn'}')">
              ${isLearn ? 'Go to Review' : 'Go to Learn'}
            </button>
          </div>`;
        return;
      }

      if (this.mode === 'learn') {
        this.enterLearnMode();
      } else {
        this.showMove();
      }
    } catch (err) {
      document.getElementById('trainer-content').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">Error loading moves</div>
          <div class="empty-state-desc">${this.esc(err.message)}</div>
        </div>`;
    }
  },

  switchTo(mode) {
    this.mode = mode;
    const sel = document.getElementById('trainer-mode-select');
    if (sel) sel.value = mode;
    this.restart();
  },

  // ══════════════════════════════════════════════════
  //  SETTINGS PANEL (gear icon → pop-down)
  // ══════════════════════════════════════════════════

  toggleSettingsPanel() {
    const el = document.getElementById('trainer-settings-panel');
    if (!el) return;
    if (el.classList.contains('hidden')) {
      this.renderSettingsPanel();
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  },

  renderSettingsPanel() {
    const el = document.getElementById('trainer-settings-panel');
    if (!el) return;
    const s = this.settings;
    const opts = [3, 5, 10, 15].map(d =>
      `<label class="settings-radio">
         <input type="radio" name="learnDepth" value="${d}" ${s.learnDepth === d ? 'checked' : ''}
                onchange="Trainer.onSettingChange('learnDepth', ${d})">
         <span>${d}</span>
       </label>`).join('');

    el.innerHTML = `
      <div class="settings-panel-inner">
        <div class="settings-row">
          <div class="settings-label">
            <div class="settings-title">Learn depth</div>
            <div class="settings-desc">How many moves to learn before practice (3/5/10/15)</div>
          </div>
          <div class="settings-control settings-radio-group">${opts}</div>
        </div>
        <div class="settings-row">
          <div class="settings-label">
            <div class="settings-title">Practice timer</div>
            <div class="settings-desc">Time limit per move during practice (1–10s)</div>
          </div>
          <div class="settings-control">
            <label class="settings-checkbox">
              <input type="checkbox" id="set-timeout-enabled" ${s.timeoutEnabled ? 'checked' : ''}
                     onchange="Trainer.onSettingChange('timeoutEnabled', this.checked)">
              <span>Enabled</span>
            </label>
            <input type="number" class="form-input settings-number" id="set-timeout-seconds"
                   min="1" max="10" step="1" value="${s.timeoutSeconds}"
                   onchange="Trainer.onSettingChange('timeoutSeconds', this.value)"
                   ${!s.timeoutEnabled ? 'disabled' : ''}>
            <span class="settings-suffix">s</span>
          </div>
        </div>
      </div>`;
  },

  /** Apply a settings change, persist, and reflect dependent UI. */
  onSettingChange(key, value) {
    if (key === 'learnDepth') {
      const n = Number(value);
      if (![3, 5, 10, 15].includes(n)) return;
      this.settings.learnDepth = n;
      this.batch.size = n;
    } else if (key === 'timeoutEnabled') {
      this.settings.timeoutEnabled = Boolean(value);
      // Reflect disabled state in the number input
      const num = document.getElementById('set-timeout-seconds');
      if (num) num.disabled = !this.settings.timeoutEnabled;
    } else if (key === 'timeoutSeconds') {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return;
      this.settings.timeoutSeconds = Math.max(1, Math.min(10, n));
      const num = document.getElementById('set-timeout-seconds');
      if (num) num.value = this.settings.timeoutSeconds;
    } else {
      return;
    }
    this.saveSettings();
  },

  // ══════════════════════════════════════════════════
  //  KEYBOARD NAVIGATION
  // ══════════════════════════════════════════════════

  onKeyDown(e) {
    // Ignore if the user is typing into a form field (text input, textarea, select)
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.commentLineMode) {
        this.backToPosition();
        return;
      }
      // Exit the trainer entirely
      if (typeof App !== 'undefined' && App.navigate) {
        App.navigate('dashboard');
      }
      return;
    }

    if (e.key === 'Backspace') {
      if (this.commentLineMode) {
        e.preventDefault();
        this.backToPosition();
        return;
      }
      // Otherwise let Backspace behave normally (e.g. browser back disabled in our app)
      return;
    }

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // Arrow navigation only meaningful in LEARN phase of LEARN mode
      if (this.mode === 'learn' && this.batch.phase === 'learn') {
        e.preventDefault();
        if (e.key === 'ArrowRight') this.nextLearnCard();
        else this.prevLearnCard();
      }
      return;
    }
  },

  // ══════════════════════════════════════════════════
  //  LEARN MODE (keyboard-driven) — Chessable MT2
  // ══════════════════════════════════════════════════

  enterLearnMode() {
    this.stopPracticeTimer();
    this.batch.startIndex = this.currentIndex;
    this.batch.learnStep = 0;
    this.batch.practiceStep = -1;
    this.batch.size = this.settings.learnDepth;
    this.batch.phase = 'learn';
    this.currentMove = this.moves[this.batch.startIndex];
    this.state = 'LEARN_CARD';
    this.attempts = 0;
    this.retryCount = 0;
    this.gaveUp = false;
    this.replayVerified = false;
    this.failedThisMove = false;
    this.renderLearnCard();
  },

  /** Compute the slice of moves that belong to the current learn batch. */
  getBatchMoves() {
    const start = this.batch.startIndex;
    const end = Math.min(this.moves.length, start + this.batch.size);
    return this.moves.slice(start, end);
  },

  /** Render the current learn card (read-only navigation). */
  renderLearnCard() {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
    this.stopPracticeTimer();

    const batchMoves = this.getBatchMoves();
    const step = Math.min(this.batch.learnStep, batchMoves.length - 1);
    const move = batchMoves[step];
    if (!move) {
      // No moves in this batch — skip to recap.
      this.currentIndex = this.batch.startIndex + this.batch.size;
      if (this.currentIndex >= this.moves.length) {
        this.showSessionComplete();
      } else {
        this.enterLearnMode();
      }
      return;
    }
    this.currentMove = move;
    this.state = 'LEARN_CARD';

    // The board shows the position BEFORE move 0 of the batch,
    // then plays the moves up to (and including) the current learn step.
    const baseMove = batchMoves[0];
    const movesToPlay = batchMoves.slice(0, step + 1).map(m => m.move_uci).filter(Boolean);
    this._replayBatchUcis(baseMove.fen, movesToPlay, move);

    const line = (move.variation_path || '').trim();
    const comment = (move.comment || '').trim();
    const sideIcon = move.side === 'white' ? '⬜' : '⬛';
    const levelBadge = move.level >= 8 ? '⭐ L8' : move.level > 0 ? `L${move.level}` : '🆕 NEW';
    const batchEnd = Math.min(this.batch.startIndex + this.batch.size, this.moves.length);
    const dots = [];
    for (let i = 0; i < this.batch.size; i++) {
      const globalIdx = this.batch.startIndex + i;
      const has = globalIdx < this.moves.length;
      let cls = 'learn-dot';
      if (!has) cls += ' empty';
      else if (i < step) cls += ' seen';
      else if (i === step) cls += ' current';
      dots.push(`<div class="${cls}"></div>`);
    }

    document.getElementById('trainer-content').innerHTML = `
      <div class="trainer-container">
        <div class="trainer-progress">
          <span class="trainer-counter">${this.batch.startIndex + step + 1} / ${this.moves.length}</span>
          <span class="trainer-divider">·</span>
          <span class="trainer-breadcrumb">${this.esc(move.course_name)} → ${this.esc(move.chapter_name)}</span>
          <span class="trainer-level">${levelBadge}</span>
          <span class="trainer-phase-badge learn">LEARN ${step + 1}/${this.batch.size}</span>
        </div>

        <div class="trainer-prompt">
          <span class="trainer-side-badge ${move.side}">${sideIcon} ${move.side.toUpperCase()}</span>
          <span class="trainer-prompt-text">watch · ← / → to navigate</span>
        </div>

        ${line ? `<div class="trainer-line" title="Line so far">${this.esc(line)}</div>` : ''}

        <div class="learn-batch-dots">${dots.join('')}</div>

        <div id="board" class="board-container"></div>

        <div id="trainer-feedback" class="trainer-feedback"></div>
        <div id="trainer-actions" class="trainer-actions">
          <div class="learn-hint">Read the position. Use <kbd>←</kbd> to go back, <kbd>→</kbd> to advance. After ${this.batch.size} cards you'll be tested.</div>
        </div>

        ${comment ? `
          <details class="trainer-comment" open>
            <summary>💬 Author comment</summary>
            <div class="trainer-comment-body">${this.renderComment(comment)}</div>
          </details>` : ''}
      </div>`;

    Board.orientation = move.side === 'black' ? 'black' : 'white';
    Board.render('board');

    // No click-to-move in learn mode — clicks are ignored.
    Board.setOnMove(() => { /* ignored */ });

    this.bindCommentLines();
  },

  /** Replay a series of UCIs from `startFen` so the board shows the position. */
  _replayBatchUcis(startFen, ucis, finalMove) {
    Board.setFEN(startFen);
    for (const u of ucis) {
      // mark last move highlight as we go
      Board.lastMoveFrom = Board.algebraicToIndex(u.slice(0, 2));
      Board.lastMoveTo = Board.algebraicToIndex(u.slice(2, 4));
      Board.applyUCI(u);
    }
    if (ucis.length === 0 && finalMove) {
      Board.lastMoveFrom = null;
      Board.lastMoveTo = null;
    }
  },

  /** Move one step forward within the current learn batch. */
  nextLearnCard() {
    if (this.mode !== 'learn' || this.batch.phase !== 'learn') return;
    const batchMoves = this.getBatchMoves();
    const nextStep = this.batch.learnStep + 1;
    if (nextStep < batchMoves.length && nextStep < this.batch.size) {
      this.batch.learnStep = nextStep;
      this.renderLearnCard();
    } else if (nextStep >= batchMoves.length) {
      // End of available moves in this batch — switch to practice.
      this.enterPracticeMode();
    } else {
      // Reached the configured learn depth — switch to practice.
      this.enterPracticeMode();
    }
  },

  /** Move one step backward within the current learn batch. */
  prevLearnCard() {
    if (this.mode !== 'learn' || this.batch.phase !== 'learn') return;
    if (this.batch.learnStep > 0) {
      this.batch.learnStep--;
      this.renderLearnCard();
    }
  },

  // ══════════════════════════════════════════════════
  //  PRACTICE MODE (click-to-move) with optional timer
  // ══════════════════════════════════════════════════

  enterPracticeMode() {
    this.batch.phase = 'practice';
    this.batch.practiceStep = 0;
    this.batch.learnStep = this.batch.size; // hide learn dots
    const batchMoves = this.getBatchMoves();
    if (batchMoves.length === 0) {
      // Nothing to practice — advance to next batch.
      this.advanceBatch();
      return;
    }
    this.renderPracticeCard();
  },

  renderPracticeCard() {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
    this.stopPracticeTimer();

    const batchMoves = this.getBatchMoves();
    const step = this.batch.practiceStep;
    const move = batchMoves[step];
    if (!move) {
      this.advanceBatch();
      return;
    }
    this.currentMove = move;
    this.state = 'IDLE';
    this.attempts = 0;
    this.retryCount = 0;
    this.gaveUp = false;
    this.replayVerified = false;
    this.failedThisMove = false;

    // Board resets to position BEFORE the first move of the batch.
    const baseMove = batchMoves[0];
    Board.setFEN(baseMove.fen);
    Board.orientation = move.side === 'black' ? 'black' : 'white';
    Board.lastMoveFrom = null;
    Board.lastMoveTo = null;
    Board.render('board');
    Board.setOnMove((from, to) => this.onUserMove(from, to));

    const line = (move.variation_path || '').trim();
    const comment = (move.comment || '').trim();
    const sideIcon = move.side === 'white' ? '⬜' : '⬛';
    const levelBadge = move.level >= 8 ? '⭐ L8' : move.level > 0 ? `L${move.level}` : '🆕 NEW';

    document.getElementById('trainer-content').innerHTML = `
      <div class="trainer-container">
        <div class="trainer-progress">
          <span class="trainer-counter">${this.batch.startIndex + step + 1} / ${this.moves.length}</span>
          <span class="trainer-divider">·</span>
          <span class="trainer-breadcrumb">${this.esc(move.course_name)} → ${this.esc(move.chapter_name)}</span>
          <span class="trainer-level">${levelBadge}</span>
          <span class="trainer-phase-badge practice">PRACTICE ${step + 1}/${batchMoves.length}</span>
        </div>

        <div class="trainer-prompt">
          <span class="trainer-side-badge ${move.side}">${sideIcon} ${move.side.toUpperCase()}</span>
          <span class="trainer-prompt-text">to move — click on the board</span>
        </div>

        ${line ? `<div class="trainer-line" title="Line so far">${this.esc(line)}</div>` : ''}

        <div id="board-wrap" class="board-wrap">
          <div id="practice-timer" class="practice-timer hidden">
            <svg viewBox="0 0 36 36" class="practice-timer-ring">
              <circle class="practice-timer-track" cx="18" cy="18" r="15.9" />
              <circle id="practice-timer-fill" class="practice-timer-fill" cx="18" cy="18" r="15.9"
                      stroke-dasharray="100 100" stroke-dashoffset="0" />
            </svg>
            <div id="practice-timer-text" class="practice-timer-text">5</div>
          </div>
          <div id="board" class="board-container"></div>
        </div>

        <div id="trainer-feedback" class="trainer-feedback"></div>
        <div id="trainer-actions" class="trainer-actions"></div>

        ${comment ? `
          <details class="trainer-comment" open>
            <summary>💬 Author comment</summary>
            <div class="trainer-comment-body">${this.renderComment(comment)}</div>
          </details>` : ''}
      </div>`;

    Board.render('board');
    this.bindCommentLines();

    if (this.settings.timeoutEnabled) {
      this.startPracticeTimer(this.settings.timeoutSeconds);
    } else {
      this.setFeedback(`
        <div class="feedback-prompt">
          <div class="feedback-hint">Play the learned move on the board.</div>
        </div>`);
    }
  },

  /** Advance the global batch pointer and either start the next learn batch or finish. */
  advanceBatch() {
    this.stopPracticeTimer();
    const nextStart = this.batch.startIndex + this.batch.size;
    if (nextStart >= this.moves.length) {
      this.currentIndex = nextStart;
      this.showSessionComplete();
      return;
    }
    this.currentIndex = nextStart;
    this.batch.startIndex = nextStart;
    this.batch.learnStep = 0;
    this.batch.practiceStep = -1;
    this.batch.phase = 'learn';
    this.enterLearnMode();
  },

  // ══════════════════════════════════════════════════
  //  PRACTICE TIMER
  // ══════════════════════════════════════════════════

  startPracticeTimer(seconds) {
    this.stopPracticeTimer();
    const total = Math.max(1, Math.min(10, Number(seconds) || 5));
    this.timerTotal = total;
    this.timerRemaining = total;

    const el = document.getElementById('practice-timer');
    const txt = document.getElementById('practice-timer-text');
    const fill = document.getElementById('practice-timer-fill');
    if (!el || !txt || !fill) return;

    el.classList.remove('hidden', 'practice-timer-warn', 'practice-timer-danger');
    el.classList.add('practice-timer-active');
    txt.textContent = Math.ceil(this.timerRemaining);
    fill.setAttribute('stroke-dasharray', '100 100');
    fill.setAttribute('stroke-dashoffset', '0');

    const startTime = Date.now();
    this.timerInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      this.timerRemaining = Math.max(0, total - elapsed);
      const left = Math.ceil(this.timerRemaining);
      const pct = (this.timerRemaining / total) * 100;
      fill.setAttribute('stroke-dashoffset', String(100 - pct));
      txt.textContent = left;

      if (left <= 1) el.classList.add('practice-timer-danger');
      else if (left <= 2) el.classList.add('practice-timer-warn');

      if (this.timerRemaining <= 0) {
        this.stopPracticeTimer();
        this.onPracticeTimerExpire();
      }
    }, 100);
  },

  stopPracticeTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.timerRemaining = 0;
    this.timerTotal = 0;
    const el = document.getElementById('practice-timer');
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('practice-timer-active', 'practice-timer-warn', 'practice-timer-danger');
    }
  },

  /** Timer ran out — count as a wrong attempt (no from/to specified). */
  onPracticeTimerExpire() {
    if (this.state !== 'IDLE' && this.state !== 'RETRY') return;
    this.state = 'WRONG_ATTEMPT';
    this.retryCount++;
    this.sessionStats.wrong++;
    if (!this.failedThisMove) {
      this.failedThisMove = true;
      this.submitReview('wrong');
    }
    const boardEl = document.getElementById('board');
    if (boardEl) {
      boardEl.classList.add('board-shake');
      setTimeout(() => boardEl.classList.remove('board-shake'), 500);
    }
    const canRetry = this.settings.enableRetry && this.retryCount <= this.settings.maxRetries;
    if (canRetry) {
      this.state = 'RETRY';
      this.setFeedback(`
        <div class="feedback-wrong">
          <div class="feedback-icon">⏱</div>
          <div class="feedback-msg">Time's up — try again</div>
          <div class="feedback-hint">${this.settings.maxRetries - this.retryCount + 1} attempt(s) left</div>
        </div>`);
      this.setActions(`<button class="btn btn-ghost btn-sm" onclick="Trainer.reveal()">Give up</button>`);
      // Re-arm timer for the retry
      if (this.settings.timeoutEnabled) this.startPracticeTimer(this.settings.timeoutSeconds);
    } else {
      this.reveal();
    }
  },

  // ══════════════════════════════════════════════════
  //  SHOW MOVE (IDLE state)
  // ══════════════════════════════════════════════════

  showMove() {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }

    if (this.currentIndex >= this.moves.length) {
      this.showSessionComplete();
      return;
    }

    this.currentMove = this.moves[this.currentIndex];
    this.state = 'IDLE';
    this.attempts = 0;
    this.retryCount = 0;
    this.gaveUp = false;
    this.replayVerified = false;
    this.failedThisMove = false;

    const move = this.currentMove;
    const sideIcon = move.side === 'white' ? '⬜' : '⬛';
    const levelBadge = move.level >= 8 ? '⭐ L8' : move.level > 0 ? `L${move.level}` : '🆕 NEW';
    const comment = (move.comment || '').trim();
    const line = (move.variation_path || '').trim();

    document.getElementById('trainer-content').innerHTML = `
      <div class="trainer-container">
        <div class="trainer-progress">
          <span class="trainer-counter">${this.currentIndex + 1} / ${this.moves.length}</span>
          <span class="trainer-divider">·</span>
          <span class="trainer-breadcrumb">${this.esc(move.course_name)} → ${this.esc(move.chapter_name)}</span>
          <span class="trainer-level">${levelBadge}</span>
        </div>

        <div class="trainer-prompt">
          <span class="trainer-side-badge ${move.side}">${sideIcon} ${move.side.toUpperCase()}</span>
          <span class="trainer-prompt-text">to move</span>
        </div>

        ${line ? `<div class="trainer-line" title="Line so far">${this.esc(line)}</div>` : ''}

        <div id="board" class="board-container"></div>

        <div id="trainer-feedback" class="trainer-feedback"></div>
        <div id="trainer-actions" class="trainer-actions"></div>

        ${comment ? `
          <details class="trainer-comment" open>
            <summary>💬 Author comment</summary>
            <div class="trainer-comment-body">${this.renderComment(comment)}</div>
          </details>` : ''}
      </div>`;

    Board.setFEN(move.fen);
    Board.orientation = move.side === 'black' ? 'black' : 'white';
    Board.render('board');

    Board.setOnMove((from, to) => this.onUserMove(from, to));

    // Wire up clickable comment fragments
    this.bindCommentLines();
  },

  esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  },

  /**
   * Render an author comment, linking embedded move fragments.
   *
   * Move sequences inside comments (e.g. "1. d4 d5 2. c4 e6") are
   * detected with a regex and wrapped in clickable spans.  Clicking
   * one plays the sequence on the MAIN board, pausing the trainer so
   * the user can explore.  A "Back to position" button restores the
   * card's FEN so the line can continue.  Fragments may be illegal
   * in the current position (the author is illustrating an idea) —
   * we replay them from the standard start position, and any move
   * that fails to parse is shown as bold text only.
   */
  renderComment(text) {
    const esc = this.esc(text);

    // SAN token: castling, or a normal move with optional piece / file /
    // rank disambiguation, capture, promotion, and check/mate suffix.
    const SAN_SRC = '(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)';
    // Optional move-number prefix: "1." or "1..." (with optional space)
    const NUM_SRC = '(?:\\d+\\.{1,3}\\s*)?';
    // One "half-move" = optional number + one SAN
    const HALF_SRC = NUM_SRC + SAN_SRC;
    // A sequence is ≥2 half-moves separated by whitespace
    const SEQ = new RegExp(`(${HALF_SRC}(?:\\s+${HALF_SRC})+)`, 'g');
    const SAN = new RegExp(SAN_SRC, 'g');

    let out = '';
    let last = 0;
    let m;
    while ((m = SEQ.exec(esc)) !== null) {
      const frag = m[0].trim();
      const sans = frag.match(SAN) || [];
      if (sans.length < 2) continue;

      out += esc.slice(last, m.index);
      out += `<span class="cm-line" data-line="${this.esc(frag)}" title="Play this line on the board">${this.esc(frag)}</span>`;
      last = m.index + m[0].length;
    }
    out += esc.slice(last);
    return out.replace(/\n/g, '<br>');
  },

  /** Bind click handlers on .cm-line spans inside the comment panel. */
  bindCommentLines() {
    document.querySelectorAll('.cm-line').forEach(el => {
      el.addEventListener('click', () => {
        const line = el.dataset.line || '';
        this.playCommentLine(line);
      });
    });
  },

  /**
   * Play a move sequence extracted from a comment on the main board.
   * Pauses the trainer state machine and shows a "Back" banner.
   */
  playCommentLine(lineText) {
    // Save state so we can return
    this._savedState = {
      fen: this.currentMove.fen,
      state: this.state,
    };
    this.state = 'COMMENT_LINE';
    this.stopPracticeTimer();
    this.commentLineMode = true;

    // Parse SAN tokens out of the fragment
    const SAN = /(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)/g;
    const sans = lineText.match(SAN) || [];

    // Build UCI list using chess.js if available, else try python-chess via API.
    // For now we use the browser-side fallback: try to push each SAN from the
    // standard start position; on failure, mark and stop.
    const ucis = [];
    if (typeof Chess === 'function') {
      const g = new Chess();
      for (const san of sans) {
        try {
          const mv = g.move(san, { sloppy: true });
          if (mv) ucis.push(mv.from + mv.to + (mv.promotion || ''));
          else break;
        } catch { break; }
      }
    }

    // Visual: tint the board + show banner
    const boardEl = document.getElementById('board');
    if (boardEl) boardEl.classList.add('board-comment-mode');
    this.setFeedback(`
      <div class="comment-line-banner">
        <span class="comment-line-banner-icon">💬</span>
        <span class="comment-line-banner-text">Viewing comment line — trainer paused</span>
        <span class="comment-line-banner-hint">press <kbd>Backspace</kbd> or click <button class="link-btn" onclick="Trainer.backToPosition()">⬅ Back to position</button> to return</span>
      </div>
      <div class="feedback-comment-line">
        <div class="feedback-hint">${this.esc(lineText)}</div>
      </div>`);
    this.setActions(`
      <button class="btn btn-primary btn-sm" onclick="Trainer.backToPosition()">⬅ Back to position</button>`);

    // Replay the sequence on the board with a small delay per move
    Board.setFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    Board.orientation = 'white';
    Board.render('board');
    let i = 0;
    const step = () => {
      if (i >= ucis.length) return;
      const u = ucis[i++];
      Board.lastMoveFrom = Board.algebraicToIndex(u.slice(0, 2));
      Board.lastMoveTo = Board.algebraicToIndex(u.slice(2, 4));
      // We don't validate legality here — the user just wants to SEE the moves
      Board.applyUCI(u);
      Board.render('board');
      setTimeout(step, 600);
    };
    setTimeout(step, 400);
  },

  /** Restore the card position after exploring a comment line. */
  backToPosition() {
    if (!this._savedState) return;
    this.state = this._savedState.state;
    Board.setFEN(this._savedState.fen);
    Board.orientation = this.currentMove.side === 'black' ? 'black' : 'white';
    Board.lastMoveFrom = null;
    Board.lastMoveTo = null;
    Board.render('board');
    const boardEl = document.getElementById('board');
    if (boardEl) boardEl.classList.remove('board-comment-mode');
    this.commentLineMode = false;
    this._savedState = null;

    this.setFeedback('');
    this.setActions('');

    // If we were in practice mode, re-arm the timer for the current move.
    if (this.state === 'IDLE' && this.mode === 'learn' && this.batch.phase === 'practice'
        && this.settings.timeoutEnabled) {
      this.startPracticeTimer(this.settings.timeoutSeconds);
    }
  },

  // ══════════════════════════════════════════════════
  //  STATE MACHINE — onUserMove
  // ══════════════════════════════════════════════════

  onUserMove(from, to) {
    // Block clicks while in learn-only mode
    if (this.state === 'LEARN_CARD') return;
    if (this.state === 'COMMENT_LINE') return;

    if (this.state === 'IDLE' || this.state === 'RETRY') {
      this.stopPracticeTimer();
      this.evaluateMove(from, to);
    } else if (this.state === 'REVEAL') {
      this.stopPracticeTimer();
      this.checkReplay(from, to);
    }
  },

  evaluateMove(from, to) {
    const move = this.currentMove;
    const attemptedUci = Board.indexToAlgebraic(from) + Board.indexToAlgebraic(to);
    const correctUci = move.move_uci;
    this.attempts++;

    if (attemptedUci === correctUci) {
      this.handleCorrect(from, to);
    } else {
      this.handleWrong(from, to);
    }
  },

  // ─── CORRECT ──────────────────────────────────────
  handleCorrect(from, to) {
    this.state = 'CORRECT';
    this.sessionStats.correct++;
    if (!this.failedThisMove) this.sessionStats.firstTry++;
    const xpGain = this.xpForLevel(Math.min(8, (this.currentMove.level || 0) + 1));
    this.sessionStats.xpEarned += xpGain;

    Board.lastMoveFrom = from;
    Board.lastMoveTo = to;
    Board.render('board');

    const wasRetry = this.failedThisMove;
    this.setFeedback(`
      <div class="feedback-correct">
        <div class="feedback-icon">✓</div>
        <div class="feedback-move">${this.esc(this.currentMove.move_san)}</div>
        <div class="feedback-xp">+${xpGain} XP${wasRetry ? ' · recovered' : ''}</div>
      </div>`);
    this.setActions(`<span class="advancing-hint">Advancing…</span>`);

    this.submitReview('correct');
    this.advanceTimer = setTimeout(() => this.advance(), this.settings.autoAdvanceMs);
  },

  xpForLevel(level) {
    const XP = {1:40, 2:50, 3:60, 4:70, 5:80, 6:90, 7:100, 8:110};
    return XP[Math.max(1, Math.min(8, level))] || 40;
  },

  // ─── WRONG ────────────────────────────────────────
  handleWrong(from, to) {
    this.state = 'WRONG_ATTEMPT';
    this.retryCount++;
    this.sessionStats.wrong++;

    if (!this.failedThisMove) {
      this.failedThisMove = true;
      this.submitReview('wrong');
    }

    Board.render('board');
    const boardEl = document.getElementById('board');
    boardEl.classList.add('board-shake');
    setTimeout(() => boardEl.classList.remove('board-shake'), 500);

    const canRetry = this.settings.enableRetry && this.retryCount <= this.settings.maxRetries;

    if (canRetry) {
      this.state = 'RETRY';
      this.setFeedback(`
        <div class="feedback-wrong">
          <div class="feedback-icon">✕</div>
          <div class="feedback-msg">Incorrect — try again</div>
          <div class="feedback-hint">${this.settings.maxRetries - this.retryCount + 1} attempt(s) left</div>
        </div>`);
      this.setActions(`
        <button class="btn btn-ghost btn-sm" onclick="Trainer.reveal()">Give up</button>`);
      // Re-arm practice timer for the retry if applicable
      if (this.mode === 'learn' && this.batch.phase === 'practice' && this.settings.timeoutEnabled) {
        this.startPracticeTimer(this.settings.timeoutSeconds);
      }
    } else {
      this.reveal();
    }
  },

  // ─── REVEAL ───────────────────────────────────────
  reveal() {
    this.state = 'REVEAL';
    const move = this.currentMove;
    const correctUci = move.move_uci;
    const fromIdx = Board.algebraicToIndex(correctUci.slice(0, 2));
    const toIdx = Board.algebraicToIndex(correctUci.slice(2, 4));

    Board.lastMoveFrom = fromIdx;
    Board.lastMoveTo = toIdx;
    Board.render('board');

    this.setFeedback(`
      <div class="feedback-reveal">
        <div class="feedback-move-reveal">${this.esc(move.move_san)}</div>
        <div class="feedback-hint">Play this move on the board to continue</div>
      </div>`);
    this.setActions('');
    // Re-arm practice timer for the replay (only in practice phase)
    if (this.mode === 'learn' && this.batch.phase === 'practice' && this.settings.timeoutEnabled) {
      this.startPracticeTimer(this.settings.timeoutSeconds);
    }
  },

  checkReplay(from, to) {
    const attemptedUci = Board.indexToAlgebraic(from) + Board.indexToAlgebraic(to);
    const correctUci = this.currentMove.move_uci;

    if (attemptedUci === correctUci) {
      this.replayVerified = true;
      Board.lastMoveFrom = from;
      Board.lastMoveTo = to;
      Board.render('board');

      this.setFeedback(`
        <div class="feedback-correct">
          <div class="feedback-icon">✓</div>
          <div class="feedback-move">${this.esc(this.currentMove.move_san)}</div>
        </div>`);
      this.setActions(`<span class="advancing-hint">Advancing…</span>`);
      this.advanceTimer = setTimeout(() => this.advance(), this.settings.autoAdvanceMs);
    } else {
      const boardEl = document.getElementById('board');
      boardEl.classList.add('board-shake');
      setTimeout(() => boardEl.classList.remove('board-shake'), 500);
      this.setFeedback(`
        <div class="feedback-wrong">
          <div class="feedback-icon">✕</div>
          <div class="feedback-msg">Play <strong>${this.esc(this.currentMove.move_san)}</strong></div>
        </div>`);
    }
  },

  // ══════════════════════════════════════════════════
  //  HELPERS & ADVANCE
  // ══════════════════════════════════════════════════

  setFeedback(html) {
    const el = document.getElementById('trainer-feedback');
    if (el) el.innerHTML = html;
  },

  setActions(html) {
    const el = document.getElementById('trainer-actions');
    if (el) el.innerHTML = html;
  },

  async submitReview(outcome) {
    const move = this.currentMove;
    try {
      await API.reviewMove(move.id, outcome, this.attempts, outcome === 'correct');
    } catch (err) {
      console.error('Review API error:', err);
    }
  },

  advance() {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
    this.stopPracticeTimer();

    if (this.mode === 'learn' && this.batch.phase === 'practice') {
      const batchMoves = this.getBatchMoves();
      const next = this.batch.practiceStep + 1;
      if (next < batchMoves.length) {
        this.batch.practiceStep = next;
        this.renderPracticeCard();
      } else {
        // Done with this batch's practice — start the next learn batch.
        this.advanceBatch();
      }
      return;
    }

    this.currentIndex++;
    if (this.mode === 'learn') {
      // In learn mode the index is advanced within the same batch by
      // re-anchoring the batch start.
      if (this.currentIndex >= this.moves.length) {
        this.showSessionComplete();
        return;
      }
      this.batch.startIndex = this.currentIndex;
      this.batch.learnStep = 0;
      this.batch.practiceStep = -1;
      this.batch.phase = 'learn';
      this.enterLearnMode();
    } else {
      this.showMove();
    }
  },

  // ══════════════════════════════════════════════════
  //  SESSION SUMMARY (RESEARCH.md §10)
  // ══════════════════════════════════════════════════

  showSessionComplete() {
    const s = this.sessionStats;
    const total = s.correct + s.wrong;
    const accuracy = total > 0 ? Math.round(s.correct / total * 100) : 0;
    const firstTryPct = s.correct > 0 ? Math.round(s.firstTry / s.correct * 100) : 0;

    document.getElementById('trainer-content').innerHTML = `
      <div class="empty-state session-recap">
        <div class="empty-state-icon">🎉</div>
        <div class="empty-state-title">Session complete!</div>
        <div class="recap-stats">
          <div class="recap-stat">
            <div class="recap-value">${s.correct}</div>
            <div class="recap-label">Correct</div>
          </div>
          <div class="recap-stat">
            <div class="recap-value">${s.wrong}</div>
            <div class="recap-label">Wrong</div>
          </div>
          <div class="recap-stat accent">
            <div class="recap-value">${accuracy}%</div>
            <div class="recap-label">Accuracy</div>
          </div>
          <div class="recap-stat">
            <div class="recap-value">${firstTryPct}%</div>
            <div class="recap-label">First-try</div>
          </div>
          <div class="recap-stat accent">
            <div class="recap-value">+${s.xpEarned}</div>
            <div class="recap-label">XP earned</div>
          </div>
        </div>
        <div class="recap-actions">
          <button class="btn btn-primary btn-lg" onclick="Trainer.restart()">Check for more</button>
          <button class="btn btn-secondary btn-lg" onclick="Trainer.switchTo('${this.mode === 'learn' ? 'review' : 'learn'}')">
            Switch to ${this.mode === 'learn' ? 'Review' : 'Learn'}
          </button>
          <button class="btn btn-ghost btn-lg" onclick="App.navigate('dashboard')">Dashboard</button>
        </div>
      </div>`;
  },
};
