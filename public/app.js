const { GRID, feetBetween, squareDistance, insideRoom, areaSquares, coversSquare } = window.Rules;

// Colors for the battlemat itself. The page chrome lives in style.css.
const COLORS = {
  mat: '#252d27',
  gridLine: 'rgba(183, 199, 176, 0.18)',
  player: '#7fa58c',
  monster: '#ce8276',
  edge: '#0c1010',
  select: '#d0af70',
  measure: '#d0af70',
};

// Pass ?dm=CODE in the URL to join as the DM.
const params = new URLSearchParams(window.location.search);
const socket = io({ auth: { dmCode: params.get('dm') || '' } });

const NO_COMBAT = { active: false, round: 0, currentTokenId: null, order: [], turn: null };
let state = { tokens: [], creatures: {}, roster: [], log: [], zones: [], tracker: NO_COMBAT, isDM: false };
let openFeatures = new Set();
let openFeatureToken = null;
let selected = []; // token ids, the first is the "from" token for measuring
let armed = null; // { actionName } while an area spell is waiting for a square
let swallowClick = false;
let commandWord = 'Halt';
let spiritType = 'Radiant';
let layAmount = 1;
let tokenNodes = {}; // token id -> Konva group
let gridLines = [];
let gridVisible = true;
let measureMode = false;
let targetMode = false;
let mapZoom = 1;
let selectedProfileId = null;
let logFilter = 'all';
let panMode = false;

// ---------- Stage and layers ----------

const stage = new Konva.Stage({
  container: 'board',
  width: GRID.cols * GRID.size,
  height: GRID.rows * GRID.size,
});
const gridLayer = new Konva.Layer();
const zoneLayer = new Konva.Layer({ listening: false });
const areaLayer = new Konva.Layer({ listening: false });
const tokenLayer = new Konva.Layer();
const measureLayer = new Konva.Layer({ listening: false });
stage.add(gridLayer, zoneLayer, areaLayer, tokenLayer, measureLayer);

function drawGrid() {
  const width = GRID.cols * GRID.size;
  const height = GRID.rows * GRID.size;

  const terrain = new Image();
  terrain.onload = () => {
    const aspectRatio = width / height;
    const sourceRatio = terrain.naturalWidth / terrain.naturalHeight;
    const crop = sourceRatio > aspectRatio
      ? {
          x: (terrain.naturalWidth - terrain.naturalHeight * aspectRatio) / 2,
          y: 0,
          width: terrain.naturalHeight * aspectRatio,
          height: terrain.naturalHeight,
        }
      : {
          x: 0,
          y: (terrain.naturalHeight - terrain.naturalWidth / aspectRatio) / 2,
          width: terrain.naturalWidth,
          height: terrain.naturalWidth / aspectRatio,
        };
    gridLayer.add(new Konva.Image({ x: 0, y: 0, width, height, image: terrain, crop }));
    gridLayer.add(new Konva.Rect({
      x: 0,
      y: 0,
      width,
      height,
      fill: 'rgba(12, 20, 17, 0.52)',
      listening: false,
    }));
    gridLines.forEach((line) => gridLayer.add(line));
    gridLayer.batchDraw();
  };
  terrain.onerror = () => {
    console.error('Unable to load the BattleMat terrain image.');
    gridLayer.add(new Konva.Rect({ x: 0, y: 0, width, height, fill: COLORS.mat }));
    gridLines.forEach((line) => gridLayer.add(line));
    gridLayer.batchDraw();
  };
  terrain.src = '/assets/terrain.png';

  for (let c = 0; c <= GRID.cols; c++) {
    const x = c * GRID.size;
    gridLines.push(new Konva.Line({
      points: [x, 0, x, height],
      stroke: COLORS.gridLine,
      strokeWidth: 1,
      visible: gridVisible,
      listening: false,
    }));
  }
  for (let r = 0; r <= GRID.rows; r++) {
    const y = r * GRID.size;
    gridLines.push(new Konva.Line({
      points: [0, y, width, y],
      stroke: COLORS.gridLine,
      strokeWidth: 1,
      visible: gridVisible,
      listening: false,
    }));
  }
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
  if (pct > 0.5) return '#7fa58c';
  if (pct > 0.25) return '#d0af70';
  return '#ce8276';
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
    draggable: canMove(token) && !panMode,
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

  // HP is shown below the portrait and remains hidden from viewers without permission.
  if (token.hp !== null && token.maxHp) {
    const pct = Math.max(0, token.hp / token.maxHp);
    const barWidth = Math.max(28, width - 8);
    const barX = (width - barWidth) / 2;
    group.add(new Konva.Rect({
      x: barX,
      y: height + 2,
      width: barWidth,
      height: 4,
      fill: '#0c1010',
      cornerRadius: 3,
      listening: false,
    }));
    group.add(new Konva.Rect({
      x: barX,
      y: height + 2,
      width: barWidth * pct,
      height: 4,
      fill: hpColor(pct),
      cornerRadius: 3,
      listening: false,
    }));
  }

  const tagText = new Konva.Text({
    text: token.name,
    fontSize: 10,
    fontStyle: 'bold',
    fill: '#eeece5',
    padding: 6,
    align: 'center',
  });
  const labelWidth = Math.max(width + 20, tagText.width());
  const label = new Konva.Label({
    x: (width - labelWidth) / 2,
    y: height + 9,
    listening: true,
  });
  label.add(new Konva.Tag({ fill: '#0c1010', cornerRadius: 4 }));
  tagText.width(labelWidth);
  label.add(tagText);
  group.add(label);

  group.name('battle-token');
  group.setAttr('tokenId', token.id);
  group.on('click tap', (e) => {
    if (armed || swallowClick) {
      e.cancelBubble = true;
      if (armed) castArmed();
      return;
    }
    selectToken(token.id, e.evt.shiftKey || measureMode || targetMode);
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

function revealSelectionPanel() {
  const panel = document.querySelector('.panel');
  const card = document.querySelector('.selection-card');
  if (!panel || !card || !selected.length) return;
  const top = card.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 8;
  panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function selectToken(id, additive) {
  if (additive && selected.length > 0 && selected[0] !== id) {
    selected = [selected[0], id];
  } else {
    selected = [id];
  }
  if (selected.length === 2) targetMode = false;
  renderTokens();
  renderPanel();
  revealSelectionPanel();
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
let rosterMessageTimer = null;

function showRosterMessage(message, isError = false) {
  const box = document.getElementById('roster-msg');
  box.textContent = message;
  box.classList.toggle('error', isError);
  if (rosterMessageTimer) clearTimeout(rosterMessageTimer);
  if (message && !isError) {
    rosterMessageTimer = setTimeout(() => {
      box.textContent = '';
    }, 3500);
  }
}

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
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      showRosterMessage(`Adding ${creature.name}…`);
      socket.timeout(5000).emit('token:add', { creatureId: creature.id }, (error, result) => {
        button.disabled = false;
        if (error) {
          showRosterMessage('Could not reach the game server. Check the connection and try again.', true);
          return;
        }
        if (!result || !result.ok) {
          showRosterMessage(result?.error || 'The server did not confirm that the creature was added.', true);
          return;
        }
        selected = [result.tokenId];
        showRosterMessage(`${creature.name} added to the map.`);
        renderTokens();
        renderPanel();
        revealSelectionPanel();
      });
    });
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
  const summary = el('div', undefined, 'detail-summary');
  if (c.token) {
    const portrait = document.createElement('img');
    portrait.className = 'portrait';
    portrait.alt = '';
    portrait.src = imageAddress(c.token);
    summary.appendChild(portrait);
  }
  const identity = el('div', undefined, 'detail-identity');
  identity.appendChild(el('p', token.name, 'detail-name'));
  identity.appendChild(el('p', c.class || c.size || '', 'detail-sub'));
  summary.appendChild(identity);
  box.appendChild(summary);

  const health = el('div', undefined, 'selected-health');
  const healthSummary = el('div', undefined, 'health-summary');
  healthSummary.appendChild(el('span', 'Health'));
  healthSummary.appendChild(el('span', token.hp === null ? 'Not supplied' : `${token.hp} / ${token.maxHp}`));
  health.appendChild(healthSummary);
  if (token.hp !== null && token.maxHp) {
    const track = el('div', undefined, 'health-track');
    const fill = el('span', undefined, 'health-fill');
    fill.style.width = `${Math.max(0, Math.min(100, (token.hp / token.maxHp) * 100))}%`;
    track.appendChild(fill);
    health.appendChild(track);
  } else {
    health.appendChild(el('div', undefined, 'health-track'));
  }
  box.appendChild(health);

  const more = el('details', undefined, 'detail-more');
  const moreSummary = el('summary', 'Stats, features and token controls');
  more.appendChild(moreSummary);
  const advanced = el('div', undefined, 'detail-advanced');
  more.appendChild(advanced);
  box.appendChild(more);

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
  advanced.appendChild(stats);

  if (c.conditionImmune && c.conditionImmune.length && (state.isDM || token.team === 'player')) {
    advanced.appendChild(el('p', `Immune to conditions: ${c.conditionImmune.join(', ')}`, 'defenses'));
  }
  const concentration = (token.marks || []).find((mark) => mark.name === 'concentration');
  if (concentration) advanced.appendChild(el('p', `Concentrating on ${concentration.spell}`, 'defenses'));

  if (c.resist || c.immune || c.vuln) {
    const lines = [
      ['Resists', c.resist],
      ['Immune', c.immune],
      ['Vulnerable', c.vuln],
    ];
    lines.forEach(([label, list]) => {
      if (list && list.length > 0) {
        advanced.appendChild(el('p', `${label}: ${list.join(', ')}`, 'defenses'));
      }
    });
  }

  const conditions = token.conditions || [];
  if (conditions.length > 0) {
    advanced.appendChild(el('p', 'Conditions', 'defenses'));
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
      advanced.appendChild(row);
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
    advanced.appendChild(row);
  });

  if (state.isDM && token.hp !== null) {
    const hpRow = el('div', undefined, 'hp-row');
    const hpInput = document.createElement('input');
    hpInput.type = 'number';
    hpInput.min = '0';
    hpInput.max = String(token.maxHp);
    hpInput.value = String(token.hp);
    const setHp = el('button', 'Set HP');
    setHp.addEventListener('click', () => socket.emit('token:set-hp', { id: token.id, hp: Number(hpInput.value) }));
    hpRow.appendChild(hpInput);
    hpRow.appendChild(setHp);
    advanced.appendChild(hpRow);

    const restore = el('button', 'Restore HP');
    restore.addEventListener('click', () => socket.emit('token:restore', { id: token.id }));
    advanced.appendChild(restore);

    Object.entries(token.uses || {}).forEach(([key, bag]) => {
      const row = el('div', undefined, 'condition-row');
      row.appendChild(el('span', `${key}: ${bag.left}/${bag.max}`));
      const back = el('button', 'Give back');
      back.type = 'button';
      back.addEventListener('click', () => socket.emit('token:restore-use', { id: token.id, key }));
      row.appendChild(back);
      advanced.appendChild(row);
    });

    const remove = el('button', 'Remove token', 'danger');
    remove.addEventListener('click', () => {
      socket.emit('token:remove', { id: token.id });
      selected = selected.filter((id) => id !== token.id);
    });
    advanced.appendChild(remove);
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

function needsCreature(action) {
  if (action.area) return false;
  const profile = action.profile;
  if (profile === 'lay-on-hands' || profile === 'remove-poison' || profile === 'bardic' || profile === 'flurry') return true;
  if (action.kind === 'heal' || action.kind === 'feature') return false;
  return true;
}

function blockedReason(attacker, action, target, feet) {
  const turn = state.tracker;
  const t = turn.turn;
  const activation = action.activation || 'action';
  const slowed = (attacker.conditions || []).includes('slowed');
  const raging = (attacker.conditions || []).includes('raging');
  const bag = attacker.uses && attacker.uses[action.useKey || action.name];
  const attackAction = action.kind !== 'spell' && action.kind !== 'heal' && action.kind !== 'feature' && !action.profile && !action.saveAbility;

  if (attacker.defeated || (needsCreature(action) && target && target.defeated)) return 'a defeated token is involved';
  if (turn.active && turn.currentTokenId !== attacker.id) return 'not this token\'s turn';
  if (raging && action.kind === 'spell') return 'raging';
  if (bag && bag.left <= 0) return 'no uses left';
  if (turn.active && t) {
    if (activation === 'bonus') {
      if (t.bonusUsed) return 'bonus action used';
      if (slowed && t.actionUsed) return 'slowed';
    } else if (activation === 'reaction') {
      if (t.reactionUsed) return 'reaction used';
    } else if (activation !== 'special') {
      if (slowed && t.bonusUsed && t.attacksLeft === 0) return 'slowed';
      const extra = t.extraAction && action.kind !== 'spell' && action.kind !== 'heal';
      if (attackAction) {
        if (t.actionUsed && t.attacksLeft === 0 && !t.extraAction) return 'no actions left this turn';
      } else if (t.actionUsed && !extra) return 'no actions left this turn';
    }
  }
  if (needsCreature(action) && !target) return 'shift-click a target';
  if (needsCreature(action) && action.targets && action.targets.length && !action.targets.includes(creatureKind(target))) {
    return `only a ${typeListText(action.targets)}`;
  }
  if (needsCreature(action) && feet > maxReach(action)) return `out of range (${feet} ft away)`;
  return '';
}

function addActionButton(box, attacker, target, feet, action) {
  const button = el('button', action.name);
  const notes = [];
  if (action.activation && action.activation !== 'action') notes.push(action.activation);
  if (action.saveAbility) notes.push(`DC ${action.saveDc} ${abilityLabel(action.saveAbility)}`);
  if (action.area) notes.push(`${action.area.size}-foot ${action.area.type}`);
  if (action.targets && action.targets.length) notes.push(typeListText(action.targets));
  if (action.rays) notes.push(`${action.rays} attacks`);
  const bag = attacker.uses && attacker.uses[action.useKey || action.name];
  if (bag) notes.push(`${bag.left}/${bag.max} left`);

  const reason = blockedReason(attacker, action, target, feet);
  const hint = [reason, notes.join(', ')].filter(Boolean).join(' · ');
  if (hint) button.appendChild(el('span', hint, 'hint'));
  if (reason) button.disabled = true;
  if (armed && armed.actionName === action.name && action.area) button.classList.add('armed');

  button.addEventListener('click', () => {
    if (action.zone === 'spirit') {
      socket.emit('attack:declare', {
        attackerId: attacker.id,
        actionName: action.name,
        damageType: spiritType,
      });
      return;
    }
    if (action.area) {
      arm(action.name);
      return;
    }
    socket.emit('attack:declare', {
      attackerId: attacker.id,
      targetId: target ? target.id : null,
      actionName: action.name,
      commandWord: action.command ? commandWord : undefined,
      amount: action.profile === 'lay-on-hands' ? layAmount : undefined,
    });
  });
  box.appendChild(button);
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

  if (!allowed) {
    box.appendChild(el('p', 'Pick one of your own characters as the attacker.', 'detail-sub'));
    return;
  }

  const feet = target ? feetBetween(attacker, target) : null;
  const choiceAction = actions.find((action) => action.damageChoice && action.damageChoice.length);
  if (choiceAction) {
    const picker = document.createElement('select');
    choiceAction.damageChoice.forEach((word) => {
      const option = document.createElement('option');
      option.value = word;
      option.textContent = word;
      if (word === spiritType) option.selected = true;
      picker.appendChild(option);
    });
    picker.addEventListener('change', () => {
      spiritType = picker.value;
    });
    box.appendChild(picker);
  }
  if (actions.some((action) => action.command)) {
    const picker = document.createElement('select');
    ['Approach', 'Drop', 'Flee', 'Grovel', 'Halt'].forEach((word) => {
      const option = document.createElement('option');
      option.value = word;
      option.textContent = word;
      if (word === commandWord) option.selected = true;
      picker.appendChild(option);
    });
    picker.addEventListener('change', () => {
      commandWord = picker.value;
    });
    box.appendChild(picker);
  }
  if (actions.some((action) => action.profile === 'lay-on-hands')) {
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.value = String(layAmount);
    amount.addEventListener('change', () => {
      layAmount = Math.max(1, Math.floor(Number(amount.value) || 1));
    });
    box.appendChild(amount);
  }

  const held = (attacker.marks || []).some((mark) => mark.name === 'restrained' && mark.zoneId != null);
  if (held) {
    const button = el('button', 'Break free');
    const reason = blockedReason(attacker, { name: 'Break free', activation: 'action', kind: 'feature', profile: 'log' }, null, 0);
    if (reason) {
      button.appendChild(el('span', reason, 'hint'));
      button.disabled = true;
    }
    button.addEventListener('click', () => {
      socket.emit('attack:declare', { attackerId: attacker.id, actionName: 'Break free' });
    });
    box.appendChild(button);
  }

  const groups = [
    ['Action', (action) => (action.activation || 'action') === 'action'],
    ['Bonus', (action) => action.activation === 'bonus'],
    ['Reaction', (action) => action.activation === 'reaction'],
    ['Special', (action) => action.activation === 'special'],
  ];
  groups.forEach(([label, pred]) => {
    const list = actions.filter(pred);
    if (list.length === 0) return;
    box.appendChild(el('p', label, 'detail-sub'));
    list.forEach((action) => addActionButton(box, attacker, target, feet, action));
  });
}

// Turn order, what the acting token has left, and the buttons to run combat.
function appendMonsterControl(box) {
  const row = el('label', undefined, 'monster-control');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = 'dm-monster-control';
  input.checked = state.autoMonsters === false;
  input.addEventListener('change', () => {
    socket.emit('combat:autopilot', { on: !input.checked });
  });
  row.appendChild(input);
  row.appendChild(document.createTextNode('DM controls monsters'));
  box.appendChild(row);

  let note = 'Monsters take their own turns.';
  if (state.autoMonsters === false) {
    note = state.monsterBusy
      ? 'Finishing the monster turn already underway.'
      : 'You play each monster. End turn when it is done.';
  }
  box.appendChild(el('p', note, 'detail-sub'));
}

function renderInitiative() {
  const box = document.getElementById('initiative');
  box.replaceChildren();
  const tracker = state.tracker;

  if (state.isDM) appendMonsterControl(box);

  if (!tracker.active) {
    if (state.isDM) {
      const start = el('button', 'Start combat');
      start.addEventListener('click', () => socket.emit('combat:start'));
      box.appendChild(start);
      appendDmFixes(box);
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
    const actionLeft = !tracker.turn.actionUsed || tracker.turn.attacksLeft > 0 || tracker.turn.extraAction;
    const bonus = tracker.turn.bonusUsed ? 'used' : 'ready';
    const extra = tracker.turn.extraAction ? ' Extra action ready.' : '';
    const status = `Action: ${actionLeft ? 'ready' : 'used'}. Bonus: ${bonus}. Movement left: ${tracker.turn.movementLeft} ft.${extra}`;
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
    appendDmFixes(box);
    const end = el('button', 'End combat', 'danger');
    end.addEventListener('click', () => socket.emit('combat:end'));
    box.appendChild(end);
  }
}

function appendDmFixes(box) {
  const undo = el('button', 'Undo');
  undo.addEventListener('click', () => socket.emit('combat:undo'));
  box.appendChild(undo);
  (state.zones || []).forEach((zone) => {
    const row = el('div', undefined, 'condition-row');
    const extra = [
      zone.damageType || '',
      zone.burning && zone.burning.length ? 'burning' : '',
    ].filter(Boolean);
    const suffix = extra.length ? `, ${extra.join(', ')}` : '';
    row.appendChild(el('span', `${zone.spell || zone.kind} (${zone.squares.length} squares${suffix})`));
    const remove = el('button', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => socket.emit('zone:remove', { id: zone.id }));
    row.appendChild(remove);
    box.appendChild(row);
  });
}

function drawZones() {
  zoneLayer.destroyChildren();
  (state.zones || []).forEach((zone) => {
    const burning = new Set((zone.burning || []).map((square) => `${square.x},${square.y}`));
    (zone.squares || []).forEach((cell) => {
      const hot = burning.has(`${cell.x},${cell.y}`);
      let fill = 'rgba(186, 196, 214, 0.42)';
      if (zone.kind === 'grease') fill = 'rgba(90, 122, 62, 0.4)';
      if (zone.kind === 'spirit') fill = 'rgba(232, 220, 160, 0.45)';
      if (hot) fill = 'rgba(196, 92, 42, 0.5)';
      zoneLayer.add(new Konva.Rect({
        x: cell.x * GRID.size,
        y: cell.y * GRID.size,
        width: GRID.size,
        height: GRID.size,
        fill,
        listening: false,
      }));
    });
  });
  zoneLayer.batchDraw();
}

// Newest entry first, so there is no scrolling needed to see the latest attack.
function renderLog() {
  const box = document.getElementById('log');
  box.replaceChildren();
  const entries = state.log.slice().reverse();
  document.getElementById('log-count').textContent =
    `${state.log.length} ${state.log.length === 1 ? 'entry' : 'new entries'}`;
  const visible = entries.filter((entry) => {
    if (logFilter === 'attacks') return Boolean(entry.outcome);
    if (logFilter === 'damage') {
      return entry.lines.some((line) => /damage|hit point|\bhp\b/i.test(line));
    }
    return true;
  });

  if (visible.length === 0) {
    const message = state.log.length === 0
      ? 'Awaiting the next action. Attack results and damage will appear here.'
      : 'No entries match this filter.';
    box.appendChild(el('p', message, 'detail-sub'));
    return;
  }

  visible.forEach((entry) => {
    const item = el('div', undefined, `log-entry ${entry.outcome}`);
    entry.lines.forEach((line, index) => {
      item.appendChild(el('p', line, index === 0 ? 'log-head' : 'log-line'));
    });
    box.appendChild(item);
  });
}

function renderPlayerProfile() {
  const players = state.tokens.filter((token) => token.team === 'player');
  const tabs = document.getElementById('profile-player-tabs');
  const content = document.getElementById('profile-content');
  tabs.replaceChildren();
  content.replaceChildren();

  if (!players.some((token) => token.id === selectedProfileId)) {
    selectedProfileId = players.length ? players[0].id : null;
  }

  players.forEach((token, index) => {
    const button = el('button', token.name || `Player ${index + 1}`);
    button.type = 'button';
    button.className = token.id === selectedProfileId ? 'active' : '';
    button.setAttribute('aria-pressed', token.id === selectedProfileId ? 'true' : 'false');
    button.addEventListener('click', () => {
      selectedProfileId = token.id;
      renderPlayerProfile();
    });
    tabs.appendChild(button);
  });

  const token = players.find((entry) => entry.id === selectedProfileId);
  if (!token) {
    tabs.hidden = true;
    content.appendChild(el('p', 'Add a player token to view a profile.', 'detail-sub'));
    return;
  }

  tabs.hidden = false;
  const creature = state.creatures[token.creatureId] || {};
  const info = el('div', undefined, 'profile-information');
  info.appendChild(el('span', `${creature.size || 'Character'} · ${creature.class || 'Player'}`));
  const fullProfile = el('a', 'Full profile ↗');
  fullProfile.href = '#player-profile';
  info.appendChild(fullProfile);
  content.appendChild(info);

  const hpLabel = el('div', undefined, 'profile-health-label');
  hpLabel.appendChild(el('span', 'Hit points'));
  hpLabel.appendChild(el('strong', token.hp === null ? 'Not supplied' : `${token.hp} / ${token.maxHp}`));
  content.appendChild(hpLabel);

  const track = el('div', undefined, 'health-track profile-health-track');
  if (token.hp !== null && token.maxHp) {
    const fill = el('span', undefined, 'health-fill');
    fill.style.width = `${Math.max(0, Math.min(100, (token.hp / token.maxHp) * 100))}%`;
    track.appendChild(fill);
  }
  content.appendChild(track);

  const stats = el('div', undefined, 'profile-stats');
  [
    ['Armor class', creature.ac === undefined ? '—' : creature.ac],
    ['Speed', creature.speed === undefined ? '—' : `${creature.speed} ft`],
    ['Proficiency', creature.proficiency === undefined ? '—' : `+${creature.proficiency}`],
  ].forEach(([label, value]) => {
    const stat = el('div', undefined, 'profile-stat');
    stat.appendChild(el('strong', String(value)));
    stat.appendChild(el('span', label));
    stats.appendChild(stat);
  });
  content.appendChild(stats);
}

function renderPanel() {
  document.getElementById('role').textContent = state.isDM ? 'Dungeon Master view' : 'Player view';
  const attacker = tokenById(selected[0]);
  const target = tokenById(selected[1]);
  document.getElementById('selected-title').textContent = attacker ? attacker.name : 'Select a token';
  document.getElementById('selection-context').textContent =
    attacker ? `${attacker.name}  ·  Selected` : '';
  document.getElementById('target-label').textContent =
    target ? `Target: ${target.name}` : (targetMode ? 'Choose a target on the map' : 'No target selected');
  document.getElementById('choose-target').classList.toggle('is-active', targetMode);
  document.getElementById('choose-target').querySelector('span').textContent =
    targetMode ? 'Click a target on the map' : 'Choose target on map';
  renderRoster();
  renderAttack();
  renderLog();
  renderDetail();
  renderPlayerProfile();
  renderInitiative();
  drawZones();
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
  revealSelectionPanel();
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

const mapViewport = document.getElementById('map-viewport');
const boardScaler = document.getElementById('board-scaler');
function fitBoard() {
  const boardWidth = GRID.cols * GRID.size;
  const boardHeight = GRID.rows * GRID.size;
  const scale = Math.min(
    mapViewport.clientWidth / boardWidth,
    mapViewport.clientHeight / boardHeight,
  ) * mapZoom;
  boardScaler.style.transform = `translate(-50%, -50%) scale(${scale})`;
  document.getElementById('zoom-level').textContent = `${Math.round(mapZoom * 100)}%`;
}

document.getElementById('grid-toggle').addEventListener('click', (event) => {
  gridVisible = !gridVisible;
  gridLines.forEach((line) => line.visible(gridVisible));
  gridLayer.batchDraw();
  event.currentTarget.setAttribute('aria-pressed', String(gridVisible));
});

function setMeasureMode(enabled) {
  measureMode = enabled;
  document.getElementById('measure-toggle').setAttribute('aria-pressed', String(enabled));
  document.querySelector('[data-map-tool="measure"]').classList.toggle('active', enabled);
  document.getElementById('distance').classList.toggle('measure-active', enabled);
}

document.getElementById('measure-toggle').addEventListener('click', () => {
  setMeasureMode(!measureMode);
  if (!measureMode) {
    selected = selected.slice(0, 1);
    renderTokens();
    renderPanel();
  }
});

document.getElementById('center-map').addEventListener('click', () => {
  mapZoom = 1;
  stage.position({ x: 0, y: 0 });
  mapViewport.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  fitBoard();
});

document.getElementById('zoom-in').addEventListener('click', () => {
  mapZoom = Math.min(1.5, Math.round((mapZoom + 0.1) * 10) / 10);
  fitBoard();
});
document.getElementById('zoom-out').addEventListener('click', () => {
  mapZoom = Math.max(0.7, Math.round((mapZoom - 0.1) * 10) / 10);
  fitBoard();
});

document.querySelectorAll('[data-map-tool]').forEach((button) => {
  button.addEventListener('click', () => {
    const tool = button.dataset.mapTool;
    panMode = tool === 'pan';
    stage.draggable(panMode);
    document.querySelectorAll('[data-map-tool]').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    if (tool === 'measure') setMeasureMode(!measureMode);
    if (tool === 'select') {
      setMeasureMode(false);
      targetMode = false;
      renderPanel();
    }
    if (tool === 'pan') {
      setMeasureMode(false);
      targetMode = false;
      renderPanel();
    }
    renderTokens();
  });
});

document.getElementById('choose-target').addEventListener('click', () => {
  if (selected.length === 0) {
    document.getElementById('attack-msg').textContent = 'Select an attacker first.';
    return;
  }
  targetMode = !targetMode;
  renderPanel();
});

document.getElementById('clear-search').addEventListener('click', () => {
  rosterSearch.value = '';
  rosterSearch.focus();
  renderRoster();
});

document.getElementById('collapse-roster').addEventListener('click', (event) => {
  const card = event.currentTarget.closest('.add-map-card');
  const collapsed = card.classList.toggle('collapsed');
  event.currentTarget.textContent = collapsed ? '+' : '−';
  event.currentTarget.setAttribute('aria-label', collapsed ? 'Expand add to map' : 'Collapse add to map');
});

document.getElementById('token-menu').addEventListener('click', () => {
  const more = document.querySelector('#detail .detail-more');
  if (more) more.open = !more.open;
});

document.querySelectorAll('[data-log-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    logFilter = button.dataset.logFilter;
    document.querySelectorAll('[data-log-filter]').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    renderLog();
  });
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !armed) return;
  event.preventDefault();
  disarm();
});

window.addEventListener('resize', fitBoard);
drawGrid();
fitBoard();
