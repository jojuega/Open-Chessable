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
  state: 'IDLE',        // IDLE | EVAL | CORRECT | WRONG_ATTEMPT | RETRY | REVEAL | ADVANCE
  attempts: 0,
  retryCount: 0,
  gaveUp: false,
  replayVerified: false,
  advanceTimer: null,
  failedThisMove: false,

  // ─── Settings (Chessable MT2 defaults) ──────────
  settings: {
    enableRetry: true,
    maxRetries: 1,
    autoAdvanceMs: 900,
  },

  // ─── Session stats ──────────────────────────────
  sessionStats: { correct: 0, wrong: 0, xpEarned: 0, firstTry: 0 },

  // ══════════════════════════════════════════════════
  //  ENTRY POINT
  // ══════════════════════════════════════════════════

  async start(container, courseId = null, side = null, mode = 'review') {
    this.courseFilter = courseId;
    this.sideFilter = side;
    this.mode = mode;
    this.moves = [];
    this.currentIndex = 0;
    this.sessionStats = { correct: 0, wrong: 0, xpEarned: 0, firstTry: 0 };

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

  switchMode() {
    const m = document.getElementById('trainer-mode-select')?.value || 'review';
    this.mode = m;
    this.restart();
  },

  async restart() {
    const side = document.getElementById('trainer-side-filter')?.value || null;
    this.sideFilter = side || null;
    this.sessionStats = { correct: 0, wrong: 0, xpEarned: 0, firstTry: 0 };
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
      this.showMove();
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

    this.setFeedback(`
      <div class="feedback-comment-line">
        <div class="feedback-icon">💬</div>
        <div class="feedback-msg">Viewing comment line — trainer paused</div>
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
    this._savedState = null;

    this.setFeedback('');
    this.setActions('');
  },

  // ══════════════════════════════════════════════════
  //  STATE MACHINE — onUserMove
  // ══════════════════════════════════════════════════

  onUserMove(from, to) {
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
    this.currentIndex++;
    this.showMove();
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
