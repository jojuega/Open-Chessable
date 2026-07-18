/**
 * Open-Chessable — Training UI (Chessable MoveTrainer-style)
 *
 * State machine (RESEARCH.md §13.4):
 *   IDLE → (user moves) → EVAL
 *     correct → CORRECT (auto-advance, XP toast)
 *     wrong   → WRONG_ATTEMPT (flash, retry if allowed) → RETRY → IDLE
 *             → (out of retries) → REVEAL (show answer, MUST replay) → ADVANCE
 *
 * Key rules:
 *   - Any wrong answer drops the move to level 1 IMMEDIATELY.
 *   - Retries do not stack penalty (already at 1).
 *   - After REVEAL, user must replay the correct move before advancing.
 *   - No self-rating. Performance is OBSERVED on the board.
 */

const Trainer = {
  // ─── Session state ──────────────────────────────
  moves: [],
  currentIndex: 0,
  currentMove: null,
  courseFilter: null,
  sideFilter: null,

  // ─── Per-move state machine ─────────────────────
  state: 'IDLE',        // IDLE | EVAL | CORRECT | WRONG_ATTEMPT | RETRY | REVEAL | ADVANCE
  attempts: 0,
  retryCount: 0,
  gaveUp: false,
  replayVerified: false,
  advanceTimer: null,
  failedThisMove: false,   // track if the move was ever failed (for SRS)

  // ─── Settings (Chessable MT2 defaults) ──────────
  settings: {
    enableRetry: true,
    maxRetries: 1,          // 0 = pure reveal mode, ∞ = unlimited
    autoAdvanceMs: 900,     // pause before auto-advance on correct
  },

  // ─── Session stats ──────────────────────────────
  sessionStats: { correct: 0, wrong: 0, xpEarned: 0 },

  // ══════════════════════════════════════════════════
  //  ENTRY POINT
  // ══════════════════════════════════════════════════

  async start(container, courseId = null, side = null) {
    this.courseFilter = courseId;
    this.sideFilter = side;
    this.moves = [];
    this.currentIndex = 0;
    this.sessionStats = { correct: 0, wrong: 0, xpEarned: 0 };

    container.innerHTML = `
      <div class="page page-trainer">
        <div class="section-header">
          <div>
            <h1 class="page-title">Train</h1>
            <p class="page-subtitle">Loading due moves…</p>
          </div>
          <div class="trainer-toolbar">
            <select class="form-select" id="trainer-side-filter" onchange="Trainer.restart()">
              <option value="">All Sides</option>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
            <button class="btn btn-secondary btn-sm" onclick="Board.flip()">🔄 Flip</button>
            <button class="btn btn-ghost btn-sm" onclick="App.navigate('dashboard')">✕ Exit</button>
          </div>
        </div>
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

  async restart() {
    const side = document.getElementById('trainer-side-filter')?.value || null;
    this.sideFilter = side || null;
    await this.loadMoves();
  },

  async loadMoves() {
    try {
      this.moves = await API.getDueMoves(this.courseFilter, this.sideFilter, 50);
      this.currentIndex = 0;

      if (this.moves.length === 0) {
        document.getElementById('trainer-content').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">✅</div>
            <div class="empty-state-title">All caught up!</div>
            <div class="empty-state-desc">No moves due for review right now.</div>
          </div>`;
        return;
      }
      this.showMove();
    } catch (err) {
      document.getElementById('trainer-content').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">Error loading moves</div>
          <div class="empty-state-desc">${err.message}</div>
        </div>`;
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
    const levelBadge = move.level >= 8 ? '⭐ L8' : move.level > 0 ? `L${move.level}` : '🆕';

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

        <div id="board" class="board-container"></div>

        <div id="trainer-feedback" class="trainer-feedback"></div>
        <div id="trainer-actions" class="trainer-actions"></div>
      </div>`;

    Board.setFEN(move.fen);
    Board.orientation = move.side === 'black' ? 'black' : 'white';
    Board.render('board');

    Board.setOnMove((from, to) => this.onUserMove(from, to));
  },

  esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  },

  // ══════════════════════════════════════════════════
  //  STATE MACHINE — onUserMove (RESEARCH.md §13.4)
  // ══════════════════════════════════════════════════

  onUserMove(from, to) {
    // Ignore input unless we're waiting for a move
    if (this.state === 'IDLE' || this.state === 'RETRY') {
      this.evaluateMove(from, to);
    } else if (this.state === 'REVEAL') {
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

    // SRS: if the move was failed earlier this session, it already went
    // to level 1. A correct replay still counts as correct outcome (level+1
    // from current), matching Chessable: replay is required, outcome = correct.
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

    // FIRST wrong on this move → drop to level 1 immediately (SRS)
    if (!this.failedThisMove) {
      this.failedThisMove = true;
      this.submitReview('wrong');
    }

    // Shake animation + red flash
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
    } else {
      // Out of retries → REVEAL
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

    // Highlight the correct move
    Board.lastMoveFrom = fromIdx;
    Board.lastMoveTo = toIdx;
    Board.render('board');

    this.setFeedback(`
      <div class="feedback-reveal">
        <div class="feedback-move-reveal">${this.esc(move.move_san)}</div>
        <div class="feedback-hint">Play this move on the board to continue</div>
      </div>`);
    this.setActions('');
  },

  checkReplay(from, to) {
    const attemptedUci = Board.indexToAlgebraic(from) + Board.indexToAlgebraic(to);
    const correctUci = this.currentMove.move_uci;

    if (attemptedUci === correctUci) {
      // Replayed correctly
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
      // Wrong replay — nudge
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
    this.currentIndex++;
    this.showMove();
  },

  showSessionComplete() {
    const s = this.sessionStats;
    const total = s.correct + s.wrong;
    const accuracy = total > 0 ? Math.round(s.correct / total * 100) : 0;

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
          <div class="recap-stat accent">
            <div class="recap-value">+${s.xpEarned}</div>
            <div class="recap-label">XP earned</div>
          </div>
        </div>
        <button class="btn btn-primary btn-lg" onclick="Trainer.restart()">Check for more</button>
        <button class="btn btn-secondary btn-lg" onclick="App.navigate('dashboard')">Back to Dashboard</button>
      </div>`;
  },
};
