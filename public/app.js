const { GRID, feetBetween, squareDistance, insideRoom, areaSquares, coversSquare } = window.Rules;

// Colors for the battlemat itself. The page chrome lives in style.css.
const COLORS = {
  mat: '#cfd6c8',
  gridLine: '#8f9b88',
  player: '#2f6f73',
  monster: '#a2402f',
  edge: '#1b2128',
  select: '#fff3b8',
  measure: '#c79a3b',
};

// Pass ?dm=CODE in the URL to join as the DM.
const params = new URLSearchParams(window.location.search);
const socket = io({ auth: { dmCode: params.get('dm') || '' } });

const NO_COMBAT = { active: false, round: 0, currentTokenId: null, order: [], turn: null };
let state = { tokens: [], creatures: {}, roster: [], log: [], tracker: NO_COMBAT, isDM: false };
let openFeatures = new Set();
let openFeatureToken = null;
let selected = []; // token ids, the first is the "from" token for measuring
let armed = null; // { actionName } while an area spell is waiting for a square
let swallowClick = false;
let tokenNodes = {}; // token id -> Konva group

// ---------- Stage and layers ----------

const stage = new Konva.Stage({
  container: 'board',
  width: GRID.cols * GRID.size,
  height: GRID.rows * GRID.size,
});
const gridLayer = new Konva.Layer();
const areaLayer = new Konva.Layer({ listening: false });
const tokenLayer = new Konva.Layer();
const measureLayer = new Konva.Layer({ listening: false });
stage.add(gridLayer, areaLayer, tokenLayer, measureLayer);

function drawGrid() {
  const width = GRID.cols * GRID.size;
  const height = GRID.rows * GRID.size;

  gridLayer.add(new Konva.Rect({ x: 0, y: 0, width, height, fill: COLORS.mat }));

  for (let c = 0; c <= GRID.cols; c++) {
    const x = c * GRID.size;
    gridLayer.add(new Konva.Line({ points: [x, 0, x, height], stroke: COLORS.gridLine, strokeWidth: 1 }));
  }
  for (let r = 0; r <= GRID.rows; r++) {
    const y = r * GRID.size;
    gridLayer.add(new Konva.Line({ points: [0, y, width, y], stroke: COLORS.gridLine, strokeWidth: 1 }));
  }
  gridLayer.batchDraw();
}

// An armed area spell casts at the square under the pointer. Otherwise, empty mat clears the selection.
stage.on('click tap', () => {
  if (armed || swallowClick) {
    if (armed) castArmed();
    return;
  }
});

stage.on('click tap', (e) => {
  if (armed || swallowClick) return;
  if (e.target.getLayer() !== tokenLayer) {
    selected = [];
    renderTokens();
    renderPanel();
  }
});

stage.on('mousemove mouseleave', () => {
  if (armed) drawMask();
});

// ---------- Tokens ----------

function initials(name) {
  return name
    .split(' ')
    .map((word) => word[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

function canMove(token) {
  return state.isDM || token.team === 'player';
}

function tokenSpan(token) {
  return { w: token.w || 1, h: token.h || 1 };
}

// While dragging, keep the whole footprint locked to grid squares and inside the room.
function snapPixels(pos, token) {
  const { w, h } = tokenSpan(token);
  const col = Math.min(GRID.cols - w, Math.max(0, Math.round(pos.x / GRID.size)));
  const row = Math.min(GRID.rows - h, Math.max(0, Math.round(pos.y / GRID.size)));
  return { x: col * GRID.size, y: row * GRID.size };
}

function hpColor(pct) {
  if (pct > 0.5) return '#6aa84f';
  if (pct > 0.25) return '#d6a032';
  return '#c0432f';
}

// Selected wins over the turn highlight, which wins over the plain edge.
function ringColor(isSelected, isActing) {
  if (isSelected) return COLORS.select;
  if (isActing) return COLORS.measure;
  return COLORS.edge;
}

const tokenImages = {};

function imageAddress(src) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  return `/${src}`;
}

function tokenPortrait(src) {
  if (!src) return null;
  if (!tokenImages[src]) {
    const image = new Image();
    image.src = imageAddress(src);
    image.onload = () => renderTokens();
    tokenImages[src] = image;
  }
  return tokenImages[src];
}

function makeToken(token) {
  const cell = GRID.size;
  const { w, h } = tokenSpan(token);
  const width = w * cell;
  const height = h * cell;
  const isSelected = selected.includes(token.id);
  const isActing = token.id === state.tracker.currentTokenId;
  const creature = state.creatures[token.creatureId];
  const portrait = tokenPortrait(creature?.token);

  const group = new Konva.Group({
    x: token.x * cell,
    y: token.y * cell,
    draggable: canMove(token),
    dragBoundFunc: (pos) => snapPixels(pos, token),
    opacity: token.defeated ? 0.35 : 1,
  });

  group.add(new Konva.Ellipse({
    x: width / 2,
    y: height / 2,
    radiusX: width / 2 - 4,
    radiusY: height / 2 - 4,
    fill: token.team === 'monster' ? COLORS.monster : COLORS.player,
    stroke: ringColor(isSelected, isActing),
    strokeWidth: isSelected || isActing ? 4 : 2,
  }));

  if (portrait && portrait.complete && portrait.naturalWidth) {
    const face = new Konva.Group({
      listening: false,
      clipFunc: (ctx) => {
        ctx.ellipse(width / 2, height / 2, width / 2 - 4, height / 2 - 4, 0, 0, Math.PI * 2);
      },
    });
    face.add(new Konva.Image({
      x: 4,
      y: 4,
      width: width - 8,
      height: height - 8,
      image: portrait,
    }));
    group.add(face);
  } else {
    group.add(new Konva.Text({
      x: 0,
      y: 0,
      width,
      height,
      text: initials(token.name),
      align: 'center',
      verticalAlign: 'middle',
      fontSize: 16 * Math.min(w, h),
      fontStyle: 'bold',
      fill: '#ffffff',
      listening: false,
    }));
  }

  // Small HP bar along the bottom. Hidden when the viewer is not allowed to see HP.
  if (token.hp !== null && token.maxHp) {
    const pct = Math.max(0, token.hp / token.maxHp);
    group.add(new Konva.Rect({ x: 6, y: height - 9, width: width - 12, height: 5, fill: '#3b4450', listening: false }));
    group.add(new Konva.Rect({ x: 6, y: height - 9, width: (width - 12) * pct, height: 5, fill: hpColor(pct), listening: false }));
  }

  group.name('battle-token');
  group.setAttr('tokenId', token.id);
  group.on('click tap', (e) => {
    if (armed || swallowClick) {
      e.cancelBubble = true;
      if (armed) castArmed();
      return;
    }
    selectToken(token.id, e.evt.shiftKey);
  });
  group.on('dragmove', updateMeasure);
  group.on('dragend', () => {
    const x = Math.round(group.x() / cell);
    const y = Math.round(group.y() / cell);
    socket.emit('token:move', { id: token.id, x, y });
  });

  return group;
}

function renderTokens() {
  tokenLayer.destroyChildren();
  tokenNodes = {};

  state.tokens.forEach((token) => {
    const node = makeToken(token);
    tokenNodes[token.id] = node;
    tokenLayer.add(node);
  });

  tokenLayer.batchDraw();
  updateMeasure();
}

function selectToken(id, additive) {
  if (additive && selected.length > 0 && selected[0] !== id) {
    selected = [selected[0], id];
  } else {
    selected = [id];
  }
  renderTokens();
  renderPanel();
}

// ---------- Distance ----------

function currentSquare(id) {
  const node = tokenNodes[id];
  const token = state.tokens.find((t) => t.id === id);
  if (!node || !token) return null;
  const { w, h } = tokenSpan(token);
  return {
    x: Math.round(node.x() / GRID.size),
    y: Math.round(node.y() / GRID.size),
    w,
    h,
  };
}

function nameOf(id) {
  const token = state.tokens.find((t) => t.id === id);
  return token ? token.name : '?';
}

function updateMeasure() {
  measureLayer.destroyChildren();
  if (armed) {
    drawMask();
    measureLayer.batchDraw();
    return;
  }
  areaLayer.destroyChildren();
  areaLayer.batchDraw();
  const readout = document.getElementById('distance');

  const a = selected.length === 2 ? currentSquare(selected[0]) : null;
  const b = selected.length === 2 ? currentSquare(selected[1]) : null;

  if (!a || !b) {
    readout.textContent = 'Click a token, then shift-click a second one to measure.';
    measureLayer.batchDraw();
    return;
  }

  const ax = a.x * GRID.size + (a.w * GRID.size) / 2;
  const ay = a.y * GRID.size + (a.h * GRID.size) / 2;
  const bx = b.x * GRID.size + (b.w * GRID.size) / 2;
  const by = b.y * GRID.size + (b.h * GRID.size) / 2;

  measureLayer.add(new Konva.Line({
    points: [ax, ay, bx, by],
    stroke: COLORS.measure,
    strokeWidth: 3,
    dash: [10, 6],
  }));

  const feet = feetBetween(a, b);
  const label = new Konva.Label({ x: (ax + bx) / 2, y: (ay + by) / 2 });
  label.add(new Konva.Tag({ fill: COLORS.edge, cornerRadius: 3 }));
  label.add(new Konva.Text({ text: `${feet} ft`, padding: 4, fontSize: 14, fill: '#ffffff' }));
  measureLayer.add(label);
  measureLayer.batchDraw();

  readout.textContent =
    `${nameOf(selected[0])} to ${nameOf(selected[1])}: ${feet} ft (${squareDistance(a, b)} squares)`;
}

// ---------- Side panel ----------

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const ROSTER_LIMIT = 24;

function rosterLabel(creature) {
  return creature.class ? `${creature.name} · ${creature.class}` : creature.name;
}

function renderRoster() {
  const box = document.getElementById('roster');
  box.replaceChildren();

  const query = document.getElementById('roster-search').value.trim().toLowerCase();
  if (!query) {
    box.appendChild(el('p', 'Type to search.', 'detail-sub'));
    return;
  }

  const words = query.split(/\s+/);
  const matches = state.roster
    .filter((creature) => {
      const haystack = `${creature.name} ${creature.class || ''}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => rosterLabel(a).localeCompare(rosterLabel(b)));

  matches.slice(0, ROSTER_LIMIT).forEach((creature) => {
    const button = el('button', rosterLabel(creature), creature.team);
    button.addEventListener('click', () => socket.emit('token:add', { creatureId: creature.id }));
    box.appendChild(button);
  });

  if (matches.length === 0) {
    box.appendChild(el('p', 'No matches.', 'detail-sub'));
  } else if (matches.length > ROSTER_LIMIT) {
    box.appendChild(el('p', 'Keep typing to narrow this.', 'detail-sub'));
  }
}

function statBox(label, value) {
  const box = el('div', undefined, 'stat');
  box.appendChild(el('b', String(value)));
  box.appendChild(document.createTextNode(label));
  return box;
}

function renderDetail() {
  const box = document.getElementById('detail');
  box.replaceChildren();

  const token = state.tokens.find((t) => t.id === selected[0]);
  if (!token) {
    openFeatures = new Set();
    openFeatureToken = null;
    box.appendChild(el('p', 'Nothing selected.', 'detail-sub'));
    return;
  }
  if (token.id !== openFeatureToken) {
    openFeatures = new Set();
    openFeatureToken = token.id;
  }

  const c = state.creatures[token.creatureId];
  if (c.token) {
    const portrait = document.createElement('img');
    portrait.className = 'portrait';
    portrait.alt = '';
    portrait.src = imageAddress(c.token);
    box.appendChild(portrait);
  }
  box.appendChild(el('p', token.name, 'detail-name'));
  box.appendChild(el('p', c.class || c.size || '', 'detail-sub'));

  // Monster stats stay hidden from players, so only show what we were sent.
  const stats = el('div', undefined, 'stats');
  if (token.hp !== null) stats.appendChild(statBox('HP', `${token.hp}/${token.maxHp}`));
  if (c.ac !== undefined) stats.appendChild(statBox('AC', c.ac));
  if (c.speed !== undefined) stats.appendChild(statBox('Speed', `${c.speed} ft`));
  if (c.abilities) {
    Object.entries(c.abilities).forEach(([name, score]) => {
      stats.appendChild(statBox(name.toUpperCase(), score));
    });
  }
  box.appendChild(stats);

  if (c.resist || c.immune || c.vuln) {
    const lines = [
      ['Resists', c.resist],
      ['Immune', c.immune],
      ['Vulnerable', c.vuln],
    ];
    lines.forEach(([label, list]) => {
      if (list && list.length > 0) {
        box.appendChild(el('p', `${label}: ${list.join(', ')}`, 'defenses'));
      }
    });
  }

  const conditions = token.conditions || [];
  if (conditions.length > 0) {
    box.appendChild(el('p', 'Conditions', 'defenses'));
    conditions.forEach((name) => {
      const row = el('div', undefined, 'condition-row');
      row.appendChild(el('span', conditionLabel(name)));
      if (state.isDM) {
        const remove = el('button', 'Remove');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          socket.emit('condition:remove', { id: token.id, name });
        });
        row.appendChild(remove);
      }
      box.appendChild(row);
    });
  }

  // Monsters call these traits, characters call them features.
  // Each one starts collapsed. Opening one leaves the others as they are.
  const features = c.features || c.traits || [];
  features.forEach((feature, index) => {
    const key = `${index}:${feature.name}`;
    const open = openFeatures.has(key);
    const row = el('div', undefined, 'feature');
    const toggle = el('button', feature.name, 'feature-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.addEventListener('click', () => {
      if (openFeatures.has(key)) openFeatures.delete(key);
      else openFeatures.add(key);
      renderDetail();
    });
    row.appendChild(toggle);
    if (open) row.appendChild(el('p', feature.summary, 'feature-body'));
    box.appendChild(row);
  });

  if (state.isDM) {
    const restore = el('button', 'Restore HP');
    restore.addEventListener('click', () => socket.emit('token:restore', { id: token.id }));
    box.appendChild(restore);

    const remove = el('button', 'Remove token', 'danger');
    remove.addEventListener('click', () => {
      socket.emit('token:remove', { id: token.id });
      selected = selected.filter((id) => id !== token.id);
    });
    box.appendChild(remove);
  }
}

function tokenById(id) {
  return state.tokens.find((t) => t.id === id);
}

const ABILITY_LABELS = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

function conditionLabel(name) {
  const text = String(name).replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function abilityLabel(ability) {
  return ABILITY_LABELS[ability] || ability;
}

// The farthest an action can reach, counting both melee reach and ranged distance.
function maxReach(action) {
  const reach = action.reach || 0;
  const range = action.range ? action.range.long : 0;
  return Math.max(reach, range);
}

function armedAction() {
  if (!armed) return null;
  const attacker = tokenById(selected[0]);
  if (!attacker || attacker.defeated) return null;
  const creature = state.creatures[attacker.creatureId];
  const actions = (creature && creature.actions) || [];
  const action = actions.find((entry) => entry.name === armed.actionName);
  if (!action || !action.area) return null;
  return { attacker, action };
}

function pointerSquare() {
  const pos = stage.getPointerPosition();
  if (!pos) return null;
  const x = Math.floor(pos.x / GRID.size);
  const y = Math.floor(pos.y / GRID.size);
  if (!insideRoom(x, y)) return null;
  return { x, y, w: 1, h: 1 };
}

function selfAimed(action) {
  const type = action.area && action.area.type;
  return action.area && action.area.origin === 'self' && (type === 'cone' || type === 'line' || type === 'cube' || type === 'square' || type === 'wall');
}

function typeListText(types) {
  if (types.length === 1) return types[0];
  if (types.length === 2) return `${types[0]} or ${types[1]}`;
  return `${types.slice(0, -1).join(', ')}, or ${types[types.length - 1]}`;
}

function creatureKind(token) {
  const creature = token && state.creatures[token.creatureId];
  if (creature && creature.type) return String(creature.type).toLowerCase();
  if (token && token.team === 'player') return 'humanoid';
  return '';
}

function selfDisk(action) {
  const type = action.area && action.area.type;
  return action.area && action.area.origin === 'self' && (type === 'sphere' || type === 'circle' || type === 'radius' || type === 'cylinder');
}

// The mask uses the same square list the server resolves, drawn from the token's stored position.
function drawMask() {
  areaLayer.destroyChildren();
  const current = armedAction();
  const square = pointerSquare();
  const readout = document.getElementById('distance');

  const disk = current && selfDisk(current.action);
  if (!current || (!disk && !square)) {
    if (armed) readout.textContent = 'Point at a square on the mat.';
    areaLayer.batchDraw();
    return;
  }

  const aimed = selfAimed(current.action);
  const onSelf = Boolean(square && coversSquare(current.attacker, square.x, square.y));
  const feet = square ? feetBetween(current.attacker, square) : 0;
  const inRange = disk || (aimed ? !onSelf : feet <= maxReach(current.action));
  const fill = inRange ? 'rgba(199, 154, 59, 0.45)' : 'rgba(162, 64, 47, 0.35)';
  const stroke = inRange ? '#c79a3b' : '#a2402f';
  const show = disk || (square && !(aimed && onSelf));
  const squares = show ? areaSquares(current.attacker, disk ? current.attacker : square, current.action.area) : [];

  squares.forEach((cell) => {
    const isCenter = square && cell.x === square.x && cell.y === square.y;
    areaLayer.add(new Konva.Rect({
      name: 'area-mask',
      x: cell.x * GRID.size,
      y: cell.y * GRID.size,
      width: GRID.size,
      height: GRID.size,
      fill,
      stroke: isCenter ? stroke : null,
      strokeWidth: isCenter ? 3 : 0,
      listening: false,
    }));
  });

  areaLayer.batchDraw();
  if (disk) {
    readout.textContent = `${current.attacker.name}: ${current.action.area.size}-foot ${current.action.area.type} around them`;
  } else if (aimed && onSelf) {
    readout.textContent = 'Point away from yourself.';
  } else if (aimed) {
    readout.textContent = `${current.attacker.name} toward square (${square.x}, ${square.y})`;
  } else {
    readout.textContent = `${current.attacker.name} to square (${square.x}, ${square.y}): ${feet} ft${inRange ? '' : ' (out of range)'}`;
  }
}

function disarm() {
  armed = null;
  updateMeasure();
  renderAttack();
}

function arm(actionName) {
  if (armed && armed.actionName === actionName) {
    disarm();
    return;
  }
  armed = { actionName };
  renderAttack();
  updateMeasure();
}

function castArmed() {
  if (swallowClick) return;
  swallowClick = true;
  setTimeout(() => {
    swallowClick = false;
  }, 250);

  const current = armedAction();
  const square = pointerSquare();
  const message = document.getElementById('attack-msg');
  if (!current || !square) {
    message.textContent = 'Point at a square on the mat.';
    return;
  }
  const aimed = selfAimed(current.action);
  const disk = selfDisk(current.action);
  if (aimed && coversSquare(current.attacker, square.x, square.y)) {
    message.textContent = 'Point away from yourself.';
    return;
  }
  const feet = feetBetween(current.attacker, square);
  const reach = maxReach(current.action);
  if (!aimed && !disk && feet > reach) {
    message.textContent = `That square is ${feet} ft away, but ${current.action.name} only reaches ${reach} ft.`;
    return;
  }

  const attackerId = current.attacker.id;
  const actionName = current.action.name;
  disarm();
  socket.emit('attack:declare', {
    attackerId,
    actionName,
    square: { x: square.x, y: square.y },
  });
}

// Shows one button per action the attacker has. An area spell is aimed at a square.
// Anything else still needs a shift-clicked creature.
function renderAttack() {
  const box = document.getElementById('attack-actions');
  box.replaceChildren();
  document.getElementById('attack-msg').textContent = '';

  const attacker = tokenById(selected[0]);
  const target = tokenById(selected[1]);

  if (!attacker) {
    box.appendChild(el('p', 'Select an attacker, then shift-click a target.', 'detail-sub'));
    return;
  }

  const creature = state.creatures[attacker.creatureId];
  const actions = (creature && creature.actions) || [];
  const allowed = state.isDM || attacker.team === 'player';

  if (actions.length === 0 || !allowed) {
    box.appendChild(el('p', 'Pick one of your own characters as the attacker.', 'detail-sub'));
    return;
  }

  const feet = target ? feetBetween(attacker, target) : null;

  actions.forEach((action) => {
    const button = el('button', action.name);
    const notes = [];
    if (action.saveAbility) notes.push(`DC ${action.saveDc} ${abilityLabel(action.saveAbility)}`);
    if (action.area) notes.push(`${action.area.size}-foot ${action.area.type}`);
    if (action.targets && action.targets.length) notes.push(typeListText(action.targets));

    const turn = state.tracker;
    let reason = '';
    if (attacker.defeated || (!action.area && target && target.defeated)) {
      reason = 'a defeated token is involved';
    } else if (turn.active && turn.currentTokenId !== attacker.id) {
      reason = 'not this token\'s turn';
    } else if (turn.active && turn.turn && turn.turn.actionUsed && turn.turn.attacksLeft === 0) {
      reason = 'no actions left this turn';
    } else if (!action.area && !target) {
      reason = 'shift-click a target';
    } else if (!action.area && action.targets && action.targets.length && !action.targets.includes(creatureKind(target))) {
      reason = `only a ${typeListText(action.targets)}`;
    } else if (!action.area && feet > maxReach(action)) {
      reason = `out of range (${feet} ft away)`;
    }

    const hint = [reason, notes.join(', ')].filter(Boolean).join(' · ');
    if (hint) button.appendChild(el('span', hint, 'hint'));
    if (reason) button.disabled = true;
    if (armed && armed.actionName === action.name && action.area) button.classList.add('armed');

    button.addEventListener('click', () => {
      if (action.area) {
        arm(action.name);
        return;
      }
      socket.emit('attack:declare', {
        attackerId: attacker.id,
        targetId: target.id,
        actionName: action.name,
      });
    });
    box.appendChild(button);
  });
}

// Turn order, what the acting token has left, and the buttons to run combat.
function renderInitiative() {
  const box = document.getElementById('initiative');
  box.replaceChildren();
  const tracker = state.tracker;

  if (!tracker.active) {
    if (state.isDM) {
      const start = el('button', 'Start combat');
      start.addEventListener('click', () => socket.emit('combat:start'));
      box.appendChild(start);
    } else {
      box.appendChild(el('p', 'No combat running.', 'detail-sub'));
    }
    return;
  }

  box.appendChild(el('p', `Round ${tracker.round}`, 'detail-name'));

  tracker.order.forEach((entry) => {
    const isActing = entry.tokenId === tracker.currentTokenId;
    box.appendChild(el('p', `${entry.name}: ${entry.total}`, isActing ? 'turn acting' : 'turn'));
  });

  if (tracker.turn) {
    const actionLeft = !tracker.turn.actionUsed || tracker.turn.attacksLeft > 0;
    const status = `Action: ${actionLeft ? 'ready' : 'used'}. Movement left: ${tracker.turn.movementLeft} ft.`;
    box.appendChild(el('p', status, 'detail-sub'));
  }

  // The DM can end any turn. Players can end a player's turn.
  const acting = tokenById(tracker.currentTokenId);
  if (acting && (state.isDM || acting.team === 'player')) {
    const next = el('button', 'End turn');
    next.addEventListener('click', () => socket.emit('combat:next'));
    box.appendChild(next);
  }

  if (state.isDM) {
    const end = el('button', 'End combat', 'danger');
    end.addEventListener('click', () => socket.emit('combat:end'));
    box.appendChild(end);
  }
}

// Newest entry first, so there is no scrolling needed to see the latest attack.
function renderLog() {
  const box = document.getElementById('log');
  box.replaceChildren();

  if (state.log.length === 0) {
    box.appendChild(el('p', 'No attacks yet.', 'detail-sub'));
    return;
  }

  state.log.slice().reverse().forEach((entry) => {
    const item = el('div', undefined, `log-entry ${entry.outcome}`);
    entry.lines.forEach((line, index) => {
      item.appendChild(el('p', line, index === 0 ? 'log-head' : 'log-line'));
    });
    box.appendChild(item);
  });
}

function renderPanel() {
  document.getElementById('role').textContent = state.isDM ? 'Dungeon Master view' : 'Player view';
  renderRoster();
  renderInitiative();
  renderAttack();
  renderLog();
  renderDetail();
}

// ---------- Wiring ----------

socket.on('state', (newState) => {
  state = newState;
  // Drop any selected tokens that no longer exist.
  selected = selected.filter((id) => state.tokens.some((t) => t.id === id));
  if (armed && !armedAction()) armed = null;
  renderTokens();
  renderPanel();
});

// Rule errors such as "out of range" come back only to the player who asked.
socket.on('attack:error', ({ message }) => {
  document.getElementById('attack-msg').textContent = message;
});

const importForm = document.getElementById('import-form');
const importUrl = document.getElementById('import-url');
const importMsg = document.getElementById('import-msg');
const importButton = importForm.querySelector('button');

importForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = importUrl.value.trim();
  importMsg.textContent = '';
  if (!url) {
    importMsg.textContent = 'Invalid input: No character ID or URL was entered.';
    return;
  }
  importButton.disabled = true;
  socket.emit('character:import', { url });
});

socket.on('character:import:error', ({ message }) => {
  importButton.disabled = false;
  importMsg.textContent = message;
});

socket.on('character:import:ok', ({ tokenId }) => {
  importButton.disabled = false;
  importUrl.value = '';
  importMsg.textContent = '';
  if (!tokenId) return;
  selected = [tokenId];
  renderTokens();
  renderPanel();
});

const rosterSearch = document.getElementById('roster-search');
rosterSearch.addEventListener('input', renderRoster);
rosterSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const first = document.querySelector('#roster button');
  if (!first) return;
  event.preventDefault();
  first.click();
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !armed) return;
  event.preventDefault();
  disarm();
});

drawGrid();
