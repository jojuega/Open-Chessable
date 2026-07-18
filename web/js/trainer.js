/**
 * Open-Chessable — Training UI
 * SRS move trainer with chessboard and quality rating.
 */

const Trainer = {
  moves: [],
  currentIndex: 0,
  currentMove: null,
  revealed: false,
  courseFilter: null,
  sideFilter: null,

  async start(container, courseId = null, side = null) {
    this.courseFilter = courseId;
    this.sideFilter = side;
    this.moves = [];
    this.currentIndex = 0;
    this.currentMove = null;
    this.revealed = false;

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

    // Set filter values if passed
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
      this.revealed = false;

      if (this.moves.length === 0) {
        document.getElementById('trainer-content').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">✅</div>
            <div class="empty-state-title">All caught up!</div>
            <div class="empty-state-desc">No moves due for review right now.</div>
            <p style="color:var(--text-subtle);font-size:13px;">
              Import a PGN to get started, or wait for existing moves to come due.
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
    if (this.currentIndex >= this.moves.length) {
      document.getElementById('trainer-content').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎉</div>
          <div class="empty-state-title">Session complete!</div>
          <div class="empty-state-desc">You've reviewed all ${this.moves.length} due moves.</div>
          <button class="btn btn-primary" onclick="Trainer.restart()">Check for more</button>
        </div>`;
      return;
    }

    this.currentMove = this.moves[this.currentIndex];
    this.revealed = false;

    const move = this.currentMove;
    const sideIcon = move.side === 'white' ? '⬜' : '⬛';
    const srsLabel = Trainer.srsLabel(move);

    document.getElementById('trainer-content').innerHTML = `
      <div class="trainer-container">
        <div class="trainer-progress">
          <span>Move ${this.currentIndex + 1} of ${this.moves.length}</span>
          <span>·</span>
          <span>${move.course_name} → ${move.chapter_name}</span>
        </div>
        
        <div class="trainer-position-label">
          <span class="trainer-side-badge ${move.side}">${sideIcon} ${move.side.toUpperCase()} to move</span>
          <span style="margin-left:8px;color:var(--text-subtle);">${srsLabel}</span>
        </div>
        
        <div id="board" class="board-container"></div>
        
        <div id="trainer-feedback" style="text-align:center;min-height:60px;"></div>
        
        <div class="quality-buttons" id="quality-buttons">
          <button class="quality-btn q0" onclick="Trainer.revealAnswer()">
            <span>❓</span> Reveal
          </button>
        </div>
      </div>
    `;

    // Set up the board
    Board.setFEN(move.fen);
    Board.orientation = move.side === 'black' ? 'black' : 'white';
    Board.render('board');
    
    // Allow clicking to attempt a move
    Board.setOnMove((from, to) => {
      if (this.revealed) return;
      
      const attemptedUci = Board.indexToAlgebraic(from) + Board.indexToAlgebraic(to);
      const correctUci = move.move_uci;
      
      if (attemptedUci === correctUci) {
        // Correct!
        this.revealed = true;
        this.showFeedback(true, correctUci);
      } else {
        // Wrong — show the attempted move briefly then revert
        this.showFeedback(false, correctUci, attemptedUci);
      }
    });
  },

  revealAnswer() {
    if (this.revealed) return;
    this.revealed = true;
    const move = this.currentMove;
    this.showFeedback(false, move.move_uci, null);
  },

  showFeedback(correct, correctUci, attemptedUci = null) {
    const feedbackEl = document.getElementById('trainer-feedback');
    const buttonsEl = document.getElementById('quality-buttons');

    if (correct) {
      feedbackEl.innerHTML = `
        <div class="trainer-move-display" style="color:var(--green-bright);">✅ ${this.currentMove.move_san}</div>
        <div style="color:var(--text-muted);font-size:13px;">Correct! How well did you recall it?</div>`;
    } else {
      feedbackEl.innerHTML = `
        <div style="color:var(--red);font-size:16px;font-weight:510;margin-bottom:4px;">
          ${attemptedUci ? `You played ${attemptedUci} — ` : ''}The correct move is:
        </div>
        <div class="trainer-move-display">${this.currentMove.move_san}</div>`;
    }

    // Show quality rating buttons
    buttonsEl.innerHTML = `
      <button class="quality-btn q0" onclick="Trainer.rateQuality(0)"><span class="ql-num">0</span>Blackout</button>
      <button class="quality-btn q1" onclick="Trainer.rateQuality(1)"><span class="ql-num">1</span>Wrong, familiar</button>
      <button class="quality-btn q2" onclick="Trainer.rateQuality(2)"><span class="ql-num">2</span>Wrong, easy</button>
      <button class="quality-btn q3" onclick="Trainer.rateQuality(3)"><span class="ql-num">3</span>Hard</button>
      <button class="quality-btn q4" onclick="Trainer.rateQuality(4)"><span class="ql-num">4</span>Hesitated</button>
      <button class="quality-btn q5" onclick="Trainer.rateQuality(5)"><span class="ql-num">5</span>Perfect</button>
    `;
  },

  async rateQuality(quality) {
    const move = this.currentMove;
    try {
      const result = await API.reviewMove(move.id, quality);
      App.toast(`Rated ${quality}: ${result.quality_label} — Next review in ${result.move.interval} day(s)`, 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }

    // Advance to next move
    this.currentIndex++;
    this.showMove();
  },

  srsLabel(move) {
    const reps = move.repetitions || 0;
    const interval = move.interval || 0;
    if (reps === 0) return '🆕 New';
    if (interval >= 112) return '⭐ Mastered';
    if (interval >= 28) return '📈 Consolidating';
    return '📖 Learning';
  },
};
