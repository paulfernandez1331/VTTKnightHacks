// Shared grid math. The browser loads this as window.Rules and the server
// requires it, so both sides always agree on how far apart two squares are.
(function (root) {
  const GRID = { cols: 20, rows: 14, size: 48, feetPerSquare: 5 };

  // Squares between the near edges of two footprints. A missing size is one square.
  function axisGap(origin, span, otherOrigin, otherSpan) {
    const end = origin + span - 1;
    const otherEnd = otherOrigin + otherSpan - 1;
    if (end < otherOrigin) return otherOrigin - end;
    if (otherEnd < origin) return origin - otherEnd;
    return 0;
  }

  // Standard 5e diagonals: a diagonal step costs the same as a straight one.
  function squareDistance(a, b) {
    const dx = axisGap(a.x, a.w || a.width || 1, b.x, b.w || b.width || 1);
    const dy = axisGap(a.y, a.h || a.height || 1, b.y, b.h || b.height || 1);
    return Math.max(dx, dy);
  }

  function feetBetween(a, b) {
    return squareDistance(a, b) * GRID.feetPerSquare;
  }

  function insideRoom(x, y) {
    return x >= 0 && y >= 0 && x < GRID.cols && y < GRID.rows;
  }

  function spanOf(token) {
    return {
      x: token.x,
      y: token.y,
      w: token.w || token.width || 1,
      h: token.h || token.height || 1,
    };
  }

  // Center of a footprint, in feet. Cone and line angles use this, not a corner.
  function centerFeet(token) {
    const span = spanOf(token);
    return {
      x: (span.x + span.w / 2) * GRID.feetPerSquare,
      y: (span.y + span.h / 2) * GRID.feetPerSquare,
    };
  }

  // Unit vector from the attacker toward the aim square. A zero-length aim is unusable.
  function aimVector(attacker, center) {
    const from = centerFeet(attacker);
    const to = centerFeet({ x: center.x, y: center.y, w: 1, h: 1 });
    const x = to.x - from.x;
    const y = to.y - from.y;
    const length = Math.hypot(x, y);
    if (length < 0.001) return null;
    return { x: x / length, y: y / length };
  }

  function coversSquare(token, x, y) {
    const span = spanOf(token);
    return x >= span.x && x < span.x + span.w && y >= span.y && y < span.y + span.h;
  }

  // Distance along the aim and off to the side, measured from the caster's center.
  function rayOffset(attacker, center, cell) {
    const aim = aimVector(attacker, center);
    if (!aim) return null;
    const from = centerFeet(attacker);
    const at = centerFeet(cell);
    const x = at.x - from.x;
    const y = at.y - from.y;
    const projection = x * aim.x + y * aim.y;
    const sideX = x - projection * aim.x;
    const sideY = y - projection * aim.y;
    return { projection, perp: Math.hypot(sideX, sideY) };
  }

  // Eight directions. A shallow angle stays on the axis so the block does not twist.
  function facing(attacker, center) {
    const aim = aimVector(attacker, center);
    if (!aim || coversSquare(attacker, center.x, center.y)) return null;
    const ax = Math.abs(aim.x);
    const ay = Math.abs(aim.y);
    if (ax >= 2 * ay) return { x: Math.sign(aim.x), y: 0 };
    if (ay >= 2 * ax) return { x: 0, y: Math.sign(aim.y) };
    return { x: Math.sign(aim.x), y: Math.sign(aim.y) };
  }

  // A cube originating from the caster sits against one face and does not cover the caster.
  function selfCube(attacker, center, size) {
    const span = spanOf(attacker);
    const face = facing(attacker, center);
    const squares = [];
    if (!face) return squares;
    const wide = Math.max(1, Math.round(size / GRID.feetPerSquare));
    const before = Math.floor((wide - 1) / 2);

    if (face.x !== 0 && face.y !== 0) {
      const x0 = face.x > 0 ? span.x + span.w : span.x - wide;
      const y0 = face.y > 0 ? span.y + span.h : span.y - wide;
      for (let dy = 0; dy < wide; dy++) {
        for (let dx = 0; dx < wide; dx++) {
          const x = x0 + dx;
          const y = y0 + dy;
          if (insideRoom(x, y)) squares.push({ x, y });
        }
      }
      return squares;
    }

    if (face.x !== 0) {
      const near = face.x > 0 ? span.x + span.w : span.x - wide;
      const mid = span.y + (span.h - 1) / 2;
      const start = Math.round(mid - before);
      for (let dx = 0; dx < wide; dx++) {
        for (let y = start; y < start + wide; y++) {
          const x = near + dx;
          if (insideRoom(x, y)) squares.push({ x, y });
        }
      }
      return squares;
    }

    const near = face.y > 0 ? span.y + span.h : span.y - wide;
    const mid = span.x + (span.w - 1) / 2;
    const start = Math.round(mid - before);
    for (let dy = 0; dy < wide; dy++) {
      for (let x = start; x < start + wide; x++) {
        const y = near + dy;
        if (insideRoom(x, y)) squares.push({ x, y });
      }
    }
    return squares;
  }

  function pushRoom(squares, x, y) {
    if (insideRoom(x, y)) squares.push({ x, y });
  }

  // A line with no width is one square wide. A wall thinner than that still fills those squares.
  function lineFeet(area) {
    const listed = Number(area && area.width);
    return Number.isFinite(listed) && listed > 0 ? listed : GRID.feetPerSquare;
  }

  function wallFeet(area) {
    return Math.max(GRID.feetPerSquare, lineFeet(area));
  }

  // A placed wall is centered on the aim square and runs along the caster's aim.
  function placedWall(attacker, center, area) {
    const squares = [];
    const aim = aimVector(attacker, center);
    if (!aim) return squares;
    const origin = centerFeet({ x: center.x, y: center.y, w: 1, h: 1 });
    const half = Number(area.size) / 2;
    const thick = wallFeet(area) / 2;
    for (let y = 0; y < GRID.rows; y++) {
      for (let x = 0; x < GRID.cols; x++) {
        const at = centerFeet({ x, y, w: 1, h: 1 });
        const dx = at.x - origin.x;
        const dy = at.y - origin.y;
        const projection = dx * aim.x + dy * aim.y;
        const sideX = dx - projection * aim.x;
        const sideY = dy - projection * aim.y;
        if (Math.abs(projection) <= half + 1e-9 && Math.hypot(sideX, sideY) <= thick + 1e-9) {
          pushRoom(squares, x, y);
        }
      }
    }
    return squares;
  }

  // Squares a spell covers. center is the aim square, including an empty one.
  // The mask and the resolver both call this, so the preview cannot lie.
  function areaSquares(attacker, center, area) {
    const type = area && area.type;
    const size = Number(area && area.size) || 0;
    const squares = [];
    if (!type || size <= 0 || !center) return squares;

    const self = area.origin === 'self';
    const burst = type === 'sphere' || type === 'circle' || type === 'radius' || type === 'cylinder';
    const block = type === 'cube' || type === 'square';
    const span = spanOf(attacker);

    if (self && block) return selfCube(attacker, center, size);
    if (self && burst) {
      for (let y = 0; y < GRID.rows; y++) {
        for (let x = 0; x < GRID.cols; x++) {
          if (coversSquare(span, x, y)) continue;
          if (feetBetween(span, { x, y, w: 1, h: 1 }) <= size) pushRoom(squares, x, y);
        }
      }
      return squares;
    }

    if (burst || block) {
      // A placed cube's size is the full side. Reach is half of that, on a 5-foot step.
      const limit = block ? Math.round(size / 2 / GRID.feetPerSquare) * GRID.feetPerSquare : size;
      const centerCell = { x: center.x, y: center.y, w: 1, h: 1 };
      for (let y = 0; y < GRID.rows; y++) {
        for (let x = 0; x < GRID.cols; x++) {
          if (feetBetween(centerCell, { x, y, w: 1, h: 1 }) <= limit) pushRoom(squares, x, y);
        }
      }
      return squares;
    }

    if (type === 'wall' && !self) return placedWall(attacker, center, area);
    if (type !== 'cone' && type !== 'line' && type !== 'wall') return squares;
    const width = type === 'wall' ? wallFeet(area) : (type === 'line' ? lineFeet(area) : 0);
    for (let y = 0; y < GRID.rows; y++) {
      for (let x = 0; x < GRID.cols; x++) {
        if (coversSquare(span, x, y)) continue;
        const offset = rayOffset(attacker, center, { x, y, w: 1, h: 1 });
        if (!offset || offset.projection <= 1e-9 || offset.projection > size + 1e-9) continue;
        const limit = type === 'cone' ? offset.projection / 2 : width / 2;
        if (offset.perp <= limit + 1e-9) pushRoom(squares, x, y);
      }
    }
    return squares;
  }

  // A token is caught when any square of its footprint is in the list.
  function tokenCaught(token, squares) {
    const keys = new Set(squares.map((square) => `${square.x},${square.y}`));
    const span = spanOf(token);
    for (let dy = 0; dy < span.h; dy++) {
      for (let dx = 0; dx < span.w; dx++) {
        if (keys.has(`${span.x + dx},${span.y + dy}`)) return true;
      }
    }
    return false;
  }

  const Rules = { GRID, squareDistance, feetBetween, insideRoom, areaSquares, tokenCaught, coversSquare };

  if (typeof module !== 'undefined') {
    module.exports = Rules;
  } else {
    root.Rules = Rules;
  }
})(this);
