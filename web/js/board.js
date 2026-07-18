/**
 * Open-Chessable — SVG Chessboard Renderer
 * Pure vanilla JS + SVG — no external dependencies.
 */

const Board = {
  size: 480,
  squareSize: 60,
  selectedSquare: null,
  legalTargets: new Set(),
  lastMoveFrom: null,
  lastMoveTo: null,
  orientation: 'white', // 'white' or 'black'
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  onSquareClick: null, // callback(from, to) when a valid move is made

  // Piece Unicode characters
  pieces: {
    'K': '♔', 'Q': '♕', 'R': '♖', 'B': '♗', 'N': '♘', 'P': '♙',
    'k': '♚', 'q': '♛', 'r': '♜', 'b': '♝', 'n': '♞', 'p': '♟',
  },

  // Colors
  lightColor: '#d0d6e0',
  darkColor: '#4a4f5a',

  setFEN(newFen) {
    this.fen = newFen;
    this.selectedSquare = null;
    this.legalTargets.clear();
    this.render();
  },

  getPosition() {
    const parts = this.fen.split(' ');
    return parts[0];
  },

  getActiveColor() {
    const parts = this.fen.split(' ');
    return parts[1] || 'w';
  },

  /**
   * Parse FEN board portion into a 64-element array.
   * Row 0 = rank 8 (top of board when white is at bottom).
   */
  parseBoard() {
    const position = this.getPosition();
    const board = new Array(64).fill(null);
    const ranks = position.split('/');
    
    for (let rank = 0; rank < 8; rank++) {
      let file = 0;
      for (const char of ranks[rank]) {
        if (char >= '1' && char <= '8') {
          file += parseInt(char);
        } else {
          board[rank * 8 + file] = char;
          file++;
        }
      }
    }
    return board;
  },

  /**
   * Convert algebraic notation (e.g. 'e4') to board index.
   */
  algebraicToIndex(alg) {
    const file = alg.charCodeAt(0) - 97; // 'a' = 0
    const rank = 8 - parseInt(alg[1]);    // '1' = 7, '8' = 0
    return rank * 8 + file;
  },

  indexToAlgebraic(index) {
    const file = String.fromCharCode(97 + (index % 8));
    const rank = 8 - Math.floor(index / 8);
    return file + rank;
  },

  /**
   * Apply a UCI move to the current FEN, WITHOUT legality checking.
   * Used to replay comment fragments (which may be illegal in context)
   * purely for visualisation.  Handles captures, castling, promotion,
   * and en-passant removal.  The move counters / side-to-move are
   * flipped at the end.
   */
  applyUCI(uci) {
    if (!uci || uci.length < 4) return;
    const from = this.algebraicToIndex(uci.slice(0, 2));
    const to = this.algebraicToIndex(uci.slice(2, 4));
    const promo = uci[4] || null;

    const parts = this.fen.split(' ');
    const board = this.parseBoard();
    let piece = board[from];
    if (!piece) return;

    const isWhite = piece === piece.toUpperCase();
    const fromRank = Math.floor(from / 8);
    const fromFile = from % 8;
    const toRank = Math.floor(to / 8);
    const toFile = to % 8;

    // En-passant capture: pawn moves diagonally to an empty square
    if (piece.toLowerCase() === 'p' && fromFile !== toFile && !board[to]) {
      const capSq = toRank * 8 + fromFile;
      board[capSq] = null;
    }

    // Castling: king moves two squares → move the rook too
    if (piece.toLowerCase() === 'k' && Math.abs(toFile - fromFile) === 2) {
      if (toFile === 6) { // king side
        board[fromRank * 8 + 5] = board[fromRank * 8 + 7];
        board[fromRank * 8 + 7] = null;
      } else if (toFile === 2) { // queen side
        board[fromRank * 8 + 3] = board[fromRank * 8 + 0];
        board[fromRank * 8 + 0] = null;
      }
    }

    // Promotion
    if (promo && piece.toLowerCase() === 'p') {
      piece = isWhite ? promo.toUpperCase() : promo.toLowerCase();
    }

    board[to] = piece;
    board[from] = null;

    // Rebuild FEN board portion
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
    const moveNum = parseInt(parts[5] || '1', 10);
    const nextMoveNum = nextSide === 'w' ? moveNum + 1 : moveNum;

    this.fen = `${fenBoard} ${nextSide} ${parts[2] || '-'} ${parts[3] || '-'} 0 ${nextMoveNum}`;
  },

  /**
   * Generate a simple list of legal moves from FEN.
   * This is NOT a full legal-move generator — it renders pseudo-legal
   * moves for the clicked piece so the user can click a target.
   * The actual validation happens server-side.
   */
  getMovesForSquare(index) {
    const board = this.parseBoard();
    const piece = board[index];
    if (!piece) return [];

    const isWhitePiece = piece === piece.toUpperCase();
    const activeColor = this.getActiveColor();
    
    // Only allow moving pieces of the active color
    if ((isWhitePiece && activeColor !== 'w') || (!isWhitePiece && activeColor !== 'b')) {
      return [];
    }

    const file = index % 8;
    const rank = Math.floor(index / 8);
    const moves = [];
    const type = piece.toLowerCase();

    const inBounds = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
    const canCapture = (targetIdx) => {
      const target = board[targetIdx];
      if (!target) return true; // empty
      return isWhitePiece ? target === target.toLowerCase() : target === target.toUpperCase();
    };

    const addSlide = (df, dr) => {
      let f = file + df, r = rank + dr;
      while (inBounds(f, r)) {
        const idx = r * 8 + f;
        const target = board[idx];
        if (!target) {
          moves.push(idx);
        } else {
          if (canCapture(idx)) moves.push(idx);
          break;
        }
        f += df;
        r += dr;
      }
    };

    if (type === 'p') {
      const dir = isWhitePiece ? -1 : 1;
      const startRank = isWhitePiece ? 6 : 1;
      
      // Forward one
      const fwd = (rank + dir) * 8 + file;
      if (inBounds(file, rank + dir) && !board[fwd]) {
        moves.push(fwd);
        // Forward two from start
        const fwd2 = (rank + 2 * dir) * 8 + file;
        if (rank === startRank && !board[fwd2]) {
          moves.push(fwd2);
        }
      }
      // Captures
      for (const df of [-1, 1]) {
        const capIdx = (rank + dir) * 8 + (file + df);
        if (inBounds(file + df, rank + dir)) {
          const target = board[capIdx];
          if (target && canCapture(capIdx)) moves.push(capIdx);
        }
      }
    } else if (type === 'n') {
      for (const [df, dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
        const idx = (rank + dr) * 8 + (file + df);
        if (inBounds(file + df, rank + dr) && canCapture(idx)) moves.push(idx);
      }
    } else if (type === 'b') {
      for (const [df, dr] of [[1,1],[1,-1],[-1,1],[-1,-1]]) addSlide(df, dr);
    } else if (type === 'r') {
      for (const [df, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) addSlide(df, dr);
    } else if (type === 'q') {
      for (const [df, dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        addSlide(df, dr);
      }
    } else if (type === 'k') {
      for (const [df, dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const idx = (rank + dr) * 8 + (file + df);
        if (inBounds(file + df, rank + dr) && canCapture(idx)) moves.push(idx);
      }
    }

    return moves;
  },

  handleSquareClick(index) {
    const board = this.parseBoard();
    const piece = board[index];
    const activeColor = this.getActiveColor();

    // If we have a selected square and this is a legal target, make the move
    if (this.selectedSquare !== null && this.legalTargets.has(index)) {
      const from = this.selectedSquare;
      const to = index;
      if (this.onSquareClick) {
        this.onSquareClick(from, to);
      }
      this.selectedSquare = null;
      this.legalTargets.clear();
      this.render();
      return;
    }

    // Select a piece if it matches the active color
    if (piece) {
      const isWhitePiece = piece === piece.toUpperCase();
      if ((isWhitePiece && activeColor === 'w') || (!isWhitePiece && activeColor === 'b')) {
        this.selectedSquare = index;
        this.legalTargets = new Set(this.getMovesForSquare(index));
        this.render();
        return;
      }
    }

    // Deselect
    this.selectedSquare = null;
    this.legalTargets.clear();
    this.render();
  },

  render(containerId = 'board') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const board = this.parseBoard();
    const isFlipped = this.orientation === 'black';
    
    let svg = `<svg class="board-svg" viewBox="0 0 ${this.size} ${this.size}" width="${this.size}" height="${this.size}">`;
    
    // Draw squares
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const displayRank = isFlipped ? 7 - rank : rank;
        const displayFile = isFlipped ? 7 - file : file;
        const idx = displayRank * 8 + displayFile;
        const isLight = (rank + file) % 2 === 0;
        let fill = isLight ? this.lightColor : this.darkColor;
        const x = file * this.squareSize;
        const y = rank * this.squareSize;

        // Highlight
        let cls = 'board-square';
        if (idx === this.selectedSquare) cls += ' selected';
        if (this.legalTargets.has(idx)) cls += ' legal-target';
        if (idx === this.lastMoveFrom || idx === this.lastMoveTo) cls += ' last-move';

        svg += `<rect class="${cls}" x="${x}" y="${y}" width="${this.squareSize}" 
                     height="${this.squareSize}" fill="${fill}" 
                     data-index="${idx}" rx="2" />`;
      }
    }

    // Draw pieces
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const displayRank = isFlipped ? 7 - rank : rank;
        const displayFile = isFlipped ? 7 - file : file;
        const idx = displayRank * 8 + displayFile;
        const piece = board[idx];
        if (piece) {
          const x = file * this.squareSize + this.squareSize / 2;
          const y = rank * this.squareSize + this.squareSize / 2;
          const isWhitePiece = piece === piece.toUpperCase();
          const color = isWhitePiece ? '#f7f8f8' : '#1a1a1a';
          const strokeColor = isWhitePiece ? '#8a8f98' : '#0a0a0a';
          svg += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" 
                       font-size="38" fill="${color}" stroke="${strokeColor}" stroke-width="0.5"
                       style="pointer-events:none; user-select:none; font-family:serif;">${this.pieces[piece]}</text>`;
        }
      }
    }

    // Coordinate labels
    const labelColor = this.textSubtle || '#62666d';
    for (let i = 0; i < 8; i++) {
      const displayIdx = isFlipped ? 7 - i : i;
      // File labels (bottom)
      svg += `<text x="${i * this.squareSize + this.squareSize - 4}" y="${this.size - 4}" 
                   text-anchor="end" font-size="10" fill="${this.darkColor}" 
                   font-family="var(--font)" opacity="0.6">${String.fromCharCode(97 + displayIdx)}</text>`;
      // Rank labels (left)
      svg += `<text x="4" y="${i * this.squareSize + 12}" text-anchor="start" font-size="10" 
                   fill="${this.darkColor}" font-family="var(--font)" opacity="0.6">${displayIdx + 1}</text>`;
    }

    svg += '</svg>';
    container.innerHTML = svg;

    // Attach click handlers
    container.querySelectorAll('.board-square').forEach(rect => {
      rect.addEventListener('click', () => {
        const idx = parseInt(rect.dataset.index);
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
