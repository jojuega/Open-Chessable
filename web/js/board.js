/**
 * Open-Chessable — Premium SVG Chessboard Renderer
 *
 * - Renders board as a single inline SVG (no external DOM nodes)
 * - Pieces are Cburnett-style SVGs loaded from /assets/pieces/{piece}.svg
 *   (the same set used by Wikipedia / Lichess)
 * - Solid filled paths, no transparency — pieces render crisply on any square
 * - Highlights: last-move, selected, legal-move dots, capture rings
 * - Coordinates (a–h, 1–8) rendered with proper contrast on both light/dark
 */

const Board = {
  size: 480,
  squareSize: 60,
  selectedSquare: null,
  legalTargets: new Set(),
  lastMoveFrom: null,
  lastMoveTo: null,
  orientation: 'white',          // 'white' or 'black'
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  onSquareClick: null,           // callback(from, to) when a valid move is made

  // Piece char → svg filename (Cburnett set, white & black outlines)
  pieces: {
    'K': 'wK', 'Q': 'wQ', 'R': 'wR', 'B': 'wB', 'N': 'wN', 'P': 'wP',
    'k': 'bK', 'q': 'bQ', 'r': 'bR', 'b': 'bB', 'n': 'bN', 'p': 'bP',
  },

  // Board square colors (modern, calm palette)
  lightColor: '#eaecd0',
  darkColor:  '#4b6577',

  // Cache loaded SVGs as raw text so we can inline them
  _pieceCache: {},
  _pieceLoadPromises: {},

  setFEN(newFen) {
    this.fen = newFen;
    this.selectedSquare = null;
    this.legalTargets.clear();
    this.render();
  },

  getPosition() {
    return this.fen.split(' ')[0];
  },

  getActiveColor() {
    return this.fen.split(' ')[1] || 'w';
  },

  /**
   * Parse FEN board portion into a 64-element array.
   * Index 0 = a8 (top-left when white is at bottom).
   */
  parseBoard() {
    const position = this.getPosition();
    const board = new Array(64).fill(null);
    const ranks = position.split('/');

    for (let rank = 0; rank < 8; rank++) {
      let file = 0;
      for (const ch of ranks[rank]) {
        if (ch >= '1' && ch <= '8') {
          file += parseInt(ch, 10);
        } else {
          board[rank * 8 + file] = ch;
          file++;
        }
      }
    }
    return board;
  },

  algebraicToIndex(alg) {
    return (8 - parseInt(alg[1], 10)) * 8 + (alg.charCodeAt(0) - 97);
  },

  indexToAlgebraic(index) {
    return String.fromCharCode(97 + (index % 8)) + (8 - Math.floor(index / 8));
  },

  /**
   * Apply a UCI move to the current FEN, WITHOUT legality checking.
   * Used to replay comment fragments for visualization.  Handles captures,
   * castling, promotion, and en-passant removal.  Side-to-move is flipped.
   */
  applyUCI(uci) {
    if (!uci || uci.length < 4) return;
    const from = this.algebraicToIndex(uci.slice(0, 2));
    const to   = this.algebraicToIndex(uci.slice(2, 4));
    const promo = uci[4] || null;

    const parts = this.fen.split(' ');
    const board = this.parseBoard();
    let piece = board[from];
    if (!piece) return;

    const isWhite = piece === piece.toUpperCase();
    const fromFile = from % 8, toFile = to % 8;
    const toRank = Math.floor(to / 8);

    // En-passant capture
    if (piece.toLowerCase() === 'p' && fromFile !== toFile && !board[to]) {
      board[toRank * 8 + fromFile] = null;
    }

    // Castling: also move the rook
    if (piece.toLowerCase() === 'k' && Math.abs(toFile - fromFile) === 2) {
      const rank = Math.floor(from / 8);
      if (toFile === 6) {
        board[rank * 8 + 5] = board[rank * 8 + 7];
        board[rank * 8 + 7] = null;
      } else if (toFile === 2) {
        board[rank * 8 + 3] = board[rank * 8 + 0];
        board[rank * 8 + 0] = null;
      }
    }

    if (promo && piece.toLowerCase() === 'p') {
      piece = isWhite ? promo.toUpperCase() : promo.toLowerCase();
    }

    board[to]   = piece;
    board[from] = null;

    let fenBoard = '';
    for (let rank = 0; rank < 8; rank++) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = board[rank * 8 + file];
        if (p) {
          if (empty) { fenBoard += empty; empty = 0; }
          fenBoard += p;
        } else {
          empty++;
        }
      }
      if (empty) fenBoard += empty;
      if (rank < 7) fenBoard += '/';
    }

    const nextSide = (parts[1] === 'w') ? 'b' : 'w';
    const moveNum  = parseInt(parts[5] || '1', 10);
    const nextMove = nextSide === 'w' ? moveNum + 1 : moveNum;

    this.fen = `${fenBoard} ${nextSide} ${parts[2] || '-'} ${parts[3] || '-'} 0 ${nextMove}`;
  },

  /**
   * Generate pseudo-legal moves for a piece (clicked square).
   * The trainer validates legality server-side; this only helps the UI
   * decide which squares to highlight as "you can move here".
   */
  getMovesForSquare(index) {
    const board = this.parseBoard();
    const piece = board[index];
    if (!piece) return [];

    const isWhitePiece = piece === piece.toUpperCase();
    const activeColor = this.getActiveColor();
    if ((isWhitePiece && activeColor !== 'w') || (!isWhitePiece && activeColor !== 'b')) {
      return [];
    }

    const file = index % 8;
    const rank = Math.floor(index / 8);
    const moves = [];
    const type = piece.toLowerCase();

    const inBounds = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
    const canCapture = (idx) => {
      const t = board[idx];
      if (!t) return true;
      return isWhitePiece ? t === t.toLowerCase() : t === t.toUpperCase();
    };

    const addSlide = (df, dr) => {
      let f = file + df, r = rank + dr;
      while (inBounds(f, r)) {
        const idx = r * 8 + f;
        if (!board[idx]) {
          moves.push(idx);
        } else {
          if (canCapture(idx)) moves.push(idx);
          break;
        }
        f += df; r += dr;
      }
    };

    if (type === 'p') {
      const dir = isWhitePiece ? -1 : 1;
      const startRank = isWhitePiece ? 6 : 1;
      const fwd = (rank + dir) * 8 + file;
      if (inBounds(file, rank + dir) && !board[fwd]) {
        moves.push(fwd);
        const fwd2 = (rank + 2 * dir) * 8 + file;
        if (rank === startRank && !board[fwd2]) moves.push(fwd2);
      }
      for (const df of [-1, 1]) {
        if (!inBounds(file + df, rank + dir)) continue;
        const cap = (rank + dir) * 8 + (file + df);
        if (board[cap] && canCapture(cap)) moves.push(cap);
      }
    } else if (type === 'n') {
      for (const [df, dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
        if (inBounds(file + df, rank + dr)) {
          const idx = (rank + dr) * 8 + (file + df);
          if (canCapture(idx)) moves.push(idx);
        }
      }
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const dirs = [];
      if (type === 'b' || type === 'q') dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
      if (type === 'r' || type === 'q') dirs.push([1,0],[-1,0],[0,1],[0,-1]);
      for (const [df, dr] of dirs) addSlide(df, dr);
    } else if (type === 'k') {
      for (const [df, dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        if (inBounds(file + df, rank + dr)) {
          const idx = (rank + dr) * 8 + (file + df);
          if (canCapture(idx)) moves.push(idx);
        }
      }
    }

    return moves;
  },

  handleSquareClick(index) {
    const board = this.parseBoard();
    const piece = board[index];
    const activeColor = this.getActiveColor();

    // If we have a selected piece and this is a legal target → make the move
    if (this.selectedSquare !== null && this.legalTargets.has(index)) {
      const from = this.selectedSquare;
      const to   = index;
      if (this.onSquareClick) this.onSquareClick(from, to);
      this.selectedSquare = null;
      this.legalTargets.clear();
      this.render();
      return;
    }

    // Otherwise: select a piece of the active color
    if (piece) {
      const isWhitePiece = piece === piece.toUpperCase();
      if ((isWhitePiece && activeColor === 'w') || (!isWhitePiece && activeColor === 'b')) {
        this.selectedSquare = index;
        this.legalTargets = new Set(this.getMovesForSquare(index));
        this.render();
        return;
      }
    }

    // Else: deselect
    this.selectedSquare = null;
    this.legalTargets.clear();
    this.render();
  },

  /** Load an SVG file and cache the inlined path group (without <svg> wrapper). */
  async _loadPieceInline(name) {
    if (this._pieceCache[name]) return this._pieceCache[name];
    if (this._pieceLoadPromises[name]) return this._pieceLoadPromises[name];

    this._pieceLoadPromises[name] = (async () => {
      try {
        const res = await fetch(`/assets/pieces/${name}.svg`);
        if (!res.ok) throw new Error(`Failed to load piece ${name}: ${res.status}`);
        const text = await res.text();

        // Pull the inner content of the <svg> element (everything between the
        // opening and closing tags).  Strip <?xml> and <!DOCTYPE> declarations.
        const cleaned = text
          .replace(/<\?xml[^?]*\?>/g, '')
          .replace(/<!DOCTYPE[^>]*>/g, '')
          .replace(/<svg[^>]*>/i, '')
          .replace(/<\/svg>\s*$/i, '')
          .trim();

        this._pieceCache[name] = cleaned;
        return cleaned;
      } catch (err) {
        console.error('Piece load failed:', err);
        return '';   // graceful fallback — piece just won't render
      } finally {
        delete this._pieceLoadPromises[name];
      }
    })();

    return this._pieceLoadPromises[name];
  },

  /** Preload all piece SVGs (call once at app boot). */
  async preloadPieces() {
    await Promise.all(Object.values(this.pieces).map(p => this._loadPieceInline(p)));
  },

  async render(containerId = 'board') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Ensure all piece SVGs are inlined before we paint.  If they were
    // preloaded at boot this resolves immediately; otherwise we wait
    // for the in-flight fetches.
    const names = [...new Set(Object.values(this.pieces))];
    await Promise.all(names.map(n => this._loadPieceInline(n)));

    const board = this.parseBoard();
    const isFlipped = this.orientation === 'black';
    const SS = this.squareSize;

    let svg = `<svg class="board-svg" viewBox="0 0 ${this.size} ${this.size}" `
           + `width="${this.size}" height="${this.size}" xmlns="http://www.w3.org/2000/svg">`;

    // ── 1. Squares ───────────────────────────────────
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const displayRank = isFlipped ? 7 - rank : rank;
        const displayFile = isFlipped ? 7 - file : file;
        const idx = displayRank * 8 + displayFile;
        const isLight = (rank + file) % 2 === 0;
        const fill = isLight ? this.lightColor : this.darkColor;

        let cls = 'board-square';
        if (idx === this.selectedSquare) cls += ' selected';
        if (this.legalTargets.has(idx))  cls += ' legal-target';
        if (idx === this.lastMoveFrom || idx === this.lastMoveTo) cls += ' last-move';

        const x = file * SS;
        const y = rank * SS;
        svg += `<rect class="${cls}" x="${x}" y="${y}" width="${SS}" height="${SS}" `
             + `fill="${fill}" data-index="${idx}" rx="2" ry="2"/>`;
      }
    }

    // ── 2. Legal-move dots / capture rings ───────────
    for (const idx of this.legalTargets) {
      const board2 = this.parseBoard();
      const targetHasPiece = !!board2[idx];
      const r = Math.floor(idx / 8);
      const f = idx % 8;
      const cx = (isFlipped ? 7 - f : f) * SS + SS / 2;
      const cy = (isFlipped ? 7 - r : r) * SS + SS / 2;

      if (targetHasPiece) {
        // capture: ring around the square
        svg += `<circle class="legal-ring" cx="${cx}" cy="${cy}" r="${SS * 0.42}"/>`;
      } else {
        // empty target: dot in the center
        svg += `<circle class="legal-dot" cx="${cx}" cy="${cy}" r="${SS * 0.13}"/>`;
      }
    }

    // ── 3. Pieces (inlined SVG groups) ───────────────
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const displayRank = isFlipped ? 7 - rank : rank;
        const displayFile = isFlipped ? 7 - file : file;
        const idx = displayRank * 8 + displayFile;
        const piece = board[idx];
        if (!piece) continue;

        const name = this.pieces[piece];
        const inline = this._pieceCache[name];
        if (!inline) continue;  // not loaded yet

        const x = file * SS;
        const y = rank * SS;
        // Original Cburnett SVGs are 45×45; scale to fit our 60×60 square.
        const scale = SS / 45;
        svg += `<g class="board-piece" transform="translate(${x},${y}) scale(${scale})">`
             + inline + `</g>`;
      }
    }

    // ── 4. Coordinate labels (a–h bottom, 1–8 left) ──
    // In standard chess orientation (white at bottom), rank "1" sits on the
    // BOTTOM row and rank "8" on the TOP row. When the board is flipped for
    // black's perspective, ranks invert (1 at top, 8 at bottom).
    for (let i = 0; i < 8; i++) {
      // i = visual column position (0 = leftmost, 7 = rightmost) for files
      // i = visual row position (0 = topmost, 7 = bottommost) for ranks
      const fileLetter = String.fromCharCode(97 + (isFlipped ? 7 - i : i));

      // Bottom-row file label, anchored to the right edge of each square
      svg += `<text class="board-coord ${i % 2 === 0 ? 'light' : 'dark'}" `
           + `x="${i * SS + SS - 5}" y="${this.size - 5}" text-anchor="end">`
           + `${fileLetter}</text>`;

      // Left-column rank label. For white orientation, the bottom row is rank
      // 1 → rank label 1 is on the bottom (i=7). For flipped, rank 1 is on
      // the top (i=0). The "dark" class picks white-ish text when the
      // adjacent square is dark, and vice versa — alternating by visual row.
      const rankNum = isFlipped ? (i + 1) : (8 - i);
      const isAdjacentDark = i % 2 === 1;
      svg += `<text class="board-coord ${isAdjacentDark ? 'dark' : 'light'}" `
           + `x="5" y="${i * SS + 11}" text-anchor="start">`
           + `${rankNum}</text>`;
    }

    svg += `</svg>`;
    container.innerHTML = svg;

    // ── 5. Click handlers ────────────────────────────
    container.querySelectorAll('.board-square').forEach(rect => {
      rect.addEventListener('click', () => {
        const idx = parseInt(rect.dataset.index, 10);
        this.handleSquareClick(idx);
      });
    });
  },

  setOnMove(callback) {
    this.onSquareClick = callback;
  },

  flip() {
    this.orientation = this.orientation === 'white' ? 'black' : 'white';
    this.render();
  },
};
