/**
 * Open-Chessable — Training UI (Chessable-style)
 * 
 * Real Chessable training flow:
 * 1. Show position → user plays the move on the board
 * 2. Correct on first try → SRS marks as perfect, auto-advance
 * 3. Wrong → show correct move, user must replay it correctly
 * 4. Track attempts per move → SRS adapts based on real performance
 * No self-rating. Performance is OBSERVED.
 */

const Trainer = {
  moves: [],
  currentIndex: 0,
  currentMove: null,
  attempts: 0,           // attempts on current move
  correctAnswered: false, // did user get it right (eventually)?
  revealed: false,        // was the correct move revealed?
  courseFilter: null,
  sideFilter: null,
  advanceTimer: null,     // auto-advance timeout

  async start(container, courseId = null, side = null) {
    this.courseFilter = courseId;
    this.sideFilter = side;
    this.moves = [];
    this.currentIndex = 0;

    container.innerHTML = `
      <div class="page">
        <div class="section-header">
          <div>
            <h1 class="page-title">Train</h1>
            <p class="page-subtitle">Loading due moves...</p>
          </div>
          <div style="display:flex;gap:8px;">
            <select class="form-select" id="trainer-side-filter" style="width:auto;" onchange="Trainer.restart()">
              <option value="">All Sides</option>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
            <button class="btn btn-secondary" onclick="Board.flip()">🔄 Flip Board</button>
          </div>
        </div>
        <div id="trainer-content">
          <div class="empty-state">
            <div class="empty-state-icon">🎯</div>
            <div class="empty-state-title">Loading moves...</div>
          </div>
        </div>
      </div>
    `;

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
            <p style="color:var(--text-subtle);font-size:13px;">
              Import a PGN from a course chapter to start training.
            </p>
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

  showMove() {
    // Clear any pending auto-advance
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }

    if (this.currentIndex >= this.moves.length) {
      this.showSessionComplete();
      return;
    }

    this.currentMove = this.moves[this.currentIndex];
    this.attempts = 0;
    this.correctAnswered = false;
    this.revealed = false;

    const move = this.currentMove;
    const sideIcon = move.side === 'white' ? '⬜' : '⬛';

    document.getElementById('trainer-content').innerHTML = `
      <div class="trainer-container">
        <div class="trainer-progress">
          <span>Move ${this.currentIndex + 1} of ${this.moves.length}</span>
          <span>·</span>
          <span>${move.course_name} → ${move.chapter_name}</span>
        </div>
        
        <div class="trainer-position-label">
          <span class="trainer-side-badge ${move.side}">${sideIcon} ${move.side.toUpperCase()} to move</span>
        </div>
        
        <div style="color:var(--text-muted);font-size:15px;text-align:center;">
          Play the correct move for <strong style="color:var(--text-primary);">${move.side.toUpperCase()}</strong>
        </div>
        
        <div id="board" class="board-container"></div>
        
        <div id="trainer-feedback" style="text-align:center;min-height:40px;"></div>
        
        <div id="trainer-actions" style="text-align:center;">
          <button class="btn btn-ghost btn-sm" onclick="Trainer.skipMove()">Skip → Show Answer</button>
        </div>
      </div>
    `;

    // Set up the board
    Board.setFEN(move.fen);
    Board.orientation = move.side === 'black' ? 'black' : 'white';
    Board.render('board');
    
    // Handle move attempts
    Board.setOnMove((from, to) => {
      if (this.revealed) {
        // Move already revealed — user must play the correct move
        this.handleRevealedMove(from, to);
        return;
      }
      this.handleMoveAttempt(from, to);
    });
  },

  handleMoveAttempt(from, to) {
    this.attempts++;
    const attemptedUci = Board.indexToAlgebraic(from) + Board.indexToAlgebraic(to);
    const correctUci = this.currentMove.move_uci;
    const feedbackEl = document.getElementById('trainer-feedback');
    const actionsEl = document.getElementById('trainer-actions');

    if (attemptedUci === correctUci) {
      // CORRECT!
      this.correctAnswered = true;
      
      // Highlight the move on the board
      Board.lastMoveFrom = from;
      Board.lastMoveTo = to;
      Board.render('board');

      const attemptText = this.attempts === 1 
        ? '✅ Perfect!'
        : `✅ Correct (attempt ${this.attempts})`;

      feedbackEl.innerHTML = `
        <div style="font-size:22px;font-weight:590;color:var(--green-bright);">
          ${attemptText}
        </div>
        <div style="color:var(--green);font-size:16px;margin-top:4px;">
          ${this.currentMove.move_san}
        </div>
      `;

      actionsEl.innerHTML = `
        <span style="color:var(--text-subtle);font-size:13px;">Advancing...</span>
      `;

      // Submit review and advance after a brief pause
      this.submitReview();
      this.advanceTimer = setTimeout(() => this.nextMove(), 800);

    } else {
      // WRONG
      feedbackEl.innerHTML = `
        <div style="color:var(--red);font-size:16px;font-weight:510;">
          ❌ Incorrect — try again
        </div>
      `;
      
      // Flash the board briefly
      const boardEl = document.getElementById('board');
      boardEl.style.opacity = '0.6';
      setTimeout(() => { boardEl.style.opacity = '1'; }, 200);
    }
  },

  handleRevealedMove(from, to) {
    // After revealing, user must play the CORRECT move
    const attemptedUci = Board.indexToAlgebraic(from) + Board.indexToAlgebraic(to);
    const correctUci = this.currentMove.move_uci;

    if (attemptedUci === correctUci) {
      // User replayed the correct move
      this.correctAnswered = true;
      
      Board.lastMoveFrom = from;
      Board.lastMoveTo = to;
      Board.render('board');

      document.getElementById('trainer-feedback').innerHTML = `
        <div style="font-size:22px;font-weight:590;color:var(--green-bright);">
          ✅ ${this.currentMove.move_san}
        </div>
      `;
      document.getElementById('trainer-actions').innerHTML = `
        <span style="color:var(--text-subtle);font-size:13px;">Advancing...</span>
      `;

      this.submitReview();
      this.advanceTimer = setTimeout(() => this.nextMove(), 800);
    } else {
      // Still wrong — flash hint
      document.getElementById('trainer-feedback').innerHTML = `
        <div style="color:var(--red);font-size:16px;font-weight:510;">
          ❌ Play <strong>${this.currentMove.move_san}</strong>
        </div>
      `;
    }
  },

  skipMove() {
    // User gives up — reveal the correct move
    this.revealed = true;
    const move = this.currentMove;
    const correctUci = move.move_uci;
    const fromIdx = Board.algebraicToIndex(correctUci.slice(0, 2));
    const toIdx = Board.algebraicToIndex(correctUci.slice(2, 4));

    // Highlight the correct move squares
    Board.lastMoveFrom = fromIdx;
    Board.lastMoveTo = toIdx;
    Board.selectedSquare = fromIdx;
    Board.legalTargets = new Set([toIdx]);
    Board.render('board');

    document.getElementById('trainer-feedback').innerHTML = `
      <div style="color:var(--yellow);font-size:18px;font-weight:590;">
        ${move.move_san}
      </div>
      <div style="color:var(--text-muted);font-size:14px;margin-top:4px;">
        Play this move to continue
      </div>
    `;

    document.getElementById('trainer-actions').innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="Trainer.giveUp()">
        Give up & advance
      </button>
    `;
  },

  giveUp() {
    // User couldn't get it even after seeing the answer
    this.correctAnswered = false;
    this.submitReview();
    this.nextMove();
  },

  async submitReview() {
    const move = this.currentMove;
    try {
      await API.reviewMove(move.id, null, this.attempts, this.correctAnswered);
    } catch (err) {
      console.error('Review API error:', err);
    }
  },

  nextMove() {
    this.currentIndex++;
    this.showMove();
  },

  showSessionComplete() {
    const reviewed = this.moves.length;
    document.getElementById('trainer-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎉</div>
        <div class="empty-state-title">Session complete!</div>
        <div class="empty-state-desc">You've reviewed all ${reviewed} due moves.</div>
        <button class="btn btn-primary" onclick="Trainer.restart()">Check for more</button>
      </div>`;
  },
};
