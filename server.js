const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const { GRID, insideRoom } = require('./public/rules.js');
const { resolveAttack } = require('./combat/attack.js');
const init = require('./combat/initiative.js');
const { runMonsterTurn } = require('./combat/monsterTurn.js');
const { advise } = require('./combat/advisor.js');
const table = require('./combat/table.js');

const PORT = process.env.PORT || 3000;
const DM_CODE = process.env.DM_CODE || 'dm';

// AUTO_MONSTERS=false starts with the DM playing monster turns.
// The DM can switch this during the game. autoMonsters is the live switch.
const AUTO_MONSTERS = process.env.AUTO_MONSTERS !== 'false';
let autoMonsters = AUTO_MONSTERS;

const monsters = require('./data/monsters.json');
const characters = require('./data/characters.json');

// Every creature we know about, keyed by id.
const catalog = {};
[...monsters, ...characters].forEach((c) => {
  catalog[c.id] = c;
});

// Ids from the two shipped files. An import must not replace one of them.
const premadeIds = new Set(Object.keys(catalog));
const IMPORTS_DIR = path.join(__dirname, 'data/imports');

function loadImports() {
  if (!fs.existsSync(IMPORTS_DIR)) return;
  fs.readdirSync(IMPORTS_DIR).filter((name) => name.endsWith('.json') && !name.startsWith('.')).forEach((name) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(IMPORTS_DIR, name), 'utf8'));
    } catch (err) {
      console.warn(`Skipping ${name}: ${err.message}`);
      return;
    }
    const list = Array.isArray(data) ? data : [data];
    list.forEach((creature) => {
      if (!creature || !creature.id) return;
      if (premadeIds.has(creature.id)) {
        console.warn(`Skipping import ${creature.id}; a premade already uses that id.`);
        return;
      }
      catalog[creature.id] = creature;
    });
  });
}

loadImports();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/konva', express.static(path.join(__dirname, 'node_modules/konva')));
app.use('/tokens', express.static(path.join(__dirname, '../dnd5e/tokens')));

// The one source of truth. Clients only ever send intents.
const board = {
  tokens: [],
  nextId: 1,
  log: [],
  nextLogId: 1,
  tracker: init.createTracker(),
  zones: [],
  nextZoneId: 1,
  history: [],
};
const MAX_LOG_ENTRIES = 100;

// Build the view a given role is allowed to see.
// Players get full sheets for characters but only a name for monsters,
// and monster HP is hidden. This is where the DM-only rule lives.
function buildState(isDM) {
  const creatures = {};

  const tokens = board.tokens.map((t) => {
    const c = catalog[t.creatureId];
    const canSeeAll = isDM || c.team === 'player';
    creatures[c.id] = canSeeAll ? c : { id: c.id, name: c.name, team: c.team, token: c.token, type: c.type };
    if (canSeeAll) return t;
    const hidden = Object.assign({}, t, { hp: null, maxHp: null });
    delete hidden.marks;
    delete hidden.uses;
    return hidden;
  });

  const roster = Object.values(catalog)
    .filter((c) => isDM || c.team === 'player')
    .map((c) => {
      const entry = { id: c.id, name: c.name, team: c.team };
      if (c.class) entry.class = c.class;
      return entry;
    });

  // The DM sees every roll. Players only see the one-line outcome.
  const log = board.log.map((entry) => ({
    id: entry.id,
    outcome: entry.outcome,
    lines: isDM ? entry.dm : [entry.pub],
  }));

  const zones = (board.zones || []).map((zone) => ({
    id: zone.id,
    kind: zone.kind,
    spell: zone.spell,
    squares: table.zoneSquares(zone, board.tokens),
    burning: zone.burning || [],
    saveDc: zone.saveDc,
    damageType: zone.damageType || null,
  }));

  return {
    tokens,
    creatures,
    roster,
    log,
    zones,
    tracker: init.publicView(board.tracker),
    isDM,
    autoMonsters,
    monsterBusy: monsterTurnRunning,
  };
}

function broadcast() {
  io.sockets.sockets.forEach((s) => {
    s.emit('state', buildState(s.data.isDM));
  });
}

function footprintOf(token) {
  return { w: token.w || 1, h: token.h || 1 };
}

function isOccupied(x, y, ignoreId) {
  return board.tokens.some((t) => {
    if (t.id === ignoreId) return false;
    const { w, h } = footprintOf(t);
    return x >= t.x && x < t.x + w && y >= t.y && y < t.y + h;
  });
}

// Every square of the rectangle has to be inside the room and empty.
function fits(x, y, w, h, ignoreId) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const cx = x + dx;
      const cy = y + dy;
      if (!insideRoom(cx, cy) || isOccupied(cx, cy, ignoreId)) return false;
    }
  }
  return true;
}

// Scan the room left to right, top to bottom for the first open rectangle.
function findFreeSpot(w, h) {
  for (let y = 1; y < GRID.rows; y++) {
    for (let x = 1; x < GRID.cols; x++) {
      if (fits(x, y, w, h, null)) return { x, y };
    }
  }
  return null;
}

function canMove(socket, token) {
  return socket.data.isDM || token.team === 'player';
}

function placeCreature(creature) {
  const w = creature.width || 1;
  const h = creature.height || 1;
  const spot = findFreeSpot(w, h);
  if (!spot) return null;

  let name = creature.name;
  if (creature.team === 'monster') {
    const count = board.tokens.filter((t) => t.creatureId === creature.id).length;
    name = `${creature.name} ${count + 1}`;
  }

  const token = {
    id: board.nextId++,
    creatureId: creature.id,
    name,
    team: creature.team,
    x: spot.x,
    y: spot.y,
    w,
    h,
    hp: creature.hp,
    maxHp: creature.hp,
    defeated: false,
    conditions: [],
    marks: [],
    uses: {},
  };
  table.initUses(token, creature);
  board.tokens.push(token);
  init.addToCombat(board.tracker, token, catalog);
  return token;
}

// Run the teammate scripts. They request the character-service URL themselves.
function runConverter(url, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [
      path.join(__dirname, 'tools/get_character.py'),
      '--url',
      url,
      '--out',
      outPath,
    ], { cwd: path.join(__dirname, 'tools') });

    let stderr = '';
    child.stderr.on('data', (buf) => {
      stderr += buf;
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('The request timed out. Please try again.'));
    }, 35000);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') reject(new Error('python3 was not found.'));
      else reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error((stderr || '').trim() || `The converter exited with status ${code}.`));
    });
  });
}

function readConverted(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(data) ? data : [data];
  const creature = list.find((entry) => entry && entry.id);
  if (!creature) throw new Error('The converter did not return a character.');
  return creature;
}

function addLog(outcome, dmLines, pub) {
  board.log.push({ id: board.nextLogId++, outcome, dm: dmLines, pub });
  if (board.log.length > MAX_LOG_ENTRIES) board.log.shift();
}

// Players and monsters both move through here, so the rules are never duplicated.
// free = true skips the movement budget (used for the DM dragging tokens around).
function performMove(token, x, y, free) {
  const { w, h } = footprintOf(token);
  if (!fits(x, y, w, h, token.id)) {
    return { ok: false, error: 'That spot is blocked.' };
  }

  let cost = 0;
  if (!free && board.tracker.active) {
    if (!board.tracker.turn || board.tracker.turn.tokenId !== token.id) {
      return { ok: false, error: 'It is not that token\'s turn.' };
    }
    cost = table.movementCost(token, x, y, board.zones, board.tokens);
    if (cost > board.tracker.turn.movementLeft) {
      return { ok: false, error: `Only ${board.tracker.turn.movementLeft} ft of movement left.` };
    }
  }

  const from = { x: token.x, y: token.y };
  table.snapshot(board);
  if (!free && board.tracker.active) init.spendMovement(board.tracker, token.id, cost);
  token.x = x;
  token.y = y;
  const lines = free ? [] : table.enterZones(board, catalog, token, from);
  if (lines.length) addLog('hit', lines, lines[0]);
  broadcast();
  return { ok: true };
}

// Players and monsters both attack through here too.
// square is the aim of an area. A weapon attack leaves it empty.
function performAttack(attacker, target, actionName, square, options) {
  const creature = catalog[attacker.creatureId];
  const action = creature && (creature.actions || []).find((entry) => entry.name === actionName);
  options = options || {};

  if (action && (action.kind === 'heal' || action.kind === 'feature')) {
    const used = table.useFeature(board, catalog, attacker, action, {
      target,
      amount: options.amount,
    });
    if (!used.ok) return used;
    addLog('hit', used.lines, used.pub);
    broadcast();
    checkForVictory();
    return { ok: true };
  }

  // Is it this token's turn, and does it still have an action or attack left?
  const turnCheck = init.checkAttack(board.tracker, attacker.id, action, attacker);
  if (!turnCheck.ok) return turnCheck;
  const ready = table.hasUse(attacker, action);
  if (!ready.ok) return ready;

  const result = resolveAttack({
    attacker,
    target,
    actionName,
    tokens: board.tokens,
    catalog,
    square,
    commandWord: options.commandWord,
    damageType: options.damageType,
  });
  if (!result.ok) return { ok: false, error: result.error };

  // Only spend the action once the attack really happened, so a rules error
  // like "out of range" never costs anyone their turn.
  table.snapshot(board);
  init.spendAttack(board.tracker, attacker.id, creature, action, attacker);
  const spent = table.takeUse(attacker, action);
  if (!spent.ok) {
    table.undo(board);
    return spent;
  }
  const applied = table.applyAttack(board, catalog, attacker, action || { name: actionName }, result);
  addLog(result.outcome, applied.lines, applied.pub);
  broadcast();
  checkForVictory();
  flashArea(result);
  return { ok: true };
}

// Paint the squares an area just covered. The color follows the damage type.
function flashArea(result) {
  const squares = result && result.squares;
  if (!squares || !squares.length) return;
  io.emit('area:flash', {
    squares: squares.map((square) => ({ x: square.x, y: square.y })),
    damageType: result.damageType || null,
  });
}

function performDash(token) {
  const creature = catalog[token.creatureId];
  const action = { name: 'Dash', activation: 'action', kind: 'feature', profile: 'dash' };
  const turnCheck = init.checkAttack(board.tracker, token.id, action, token);
  if (!turnCheck.ok) return turnCheck;
  const speed = init.speedNow(creature, token);
  if (!board.tracker.turn || speed <= 0) return { ok: false, error: `${token.name} cannot dash.` };
  table.snapshot(board);
  init.spendAttack(board.tracker, token.id, creature, action, token);
  board.tracker.turn.movementLeft += speed;
  board.tracker.turn.dashed = true;
  const line = `${token.name} dashes and gains ${speed} ft of movement.`;
  addLog('hit', [line], `${token.name} dashes.`);
  broadcast();
  return { ok: true };
}

function checkForVictory() {
  if (!board.tracker.active) return;

  const winner = init.checkVictory(board.tokens);
  if (!winner) return;

  const text = winner === 'players' ? 'The party wins! Combat is over.' : 'The monsters win. Combat is over.';
  addLog('hit', [text], text);
  init.endCombat(board.tracker);
  broadcast();
}

let monsterTurnRunning = false;

// If the acting token is a monster, play its whole turn, then move on.
async function maybeRunMonsterTurn() {
  const tracker = board.tracker;
  if (!autoMonsters || !tracker.active || monsterTurnRunning) return;

  const token = board.tokens.find((t) => t.id === init.currentTokenId(tracker));
  if (!token || token.team !== 'monster') return;

  monsterTurnRunning = true;
  broadcast();
  try {
    await runMonsterTurn({
      token,
      getTokens: () => board.tokens,
      catalog,
      tracker,
      performMove: (t, step) => performMove(t, step.x, step.y, false),
      performDash: (t) => performDash(t),
      costOf: (t, x, y) => table.movementCost(t, x, y, board.zones, board.tokens),
      performAttack: (t, step) => {
        const target = board.tokens.find((x) => x.id === step.targetId);
        return performAttack(t, target, step.actionName, step.square);
      },
      advise,
      pause: (step) => new Promise((resolve) => {
        const area = step && step.type === 'attack' && step.square;
        setTimeout(resolve, area ? 1600 : 800);
      }),
    });
  } catch (err) {
    // A bug in one monster's turn should skip that turn, not crash the table.
    console.error('Monster turn failed:', err);
  } finally {
    monsterTurnRunning = false;
  }

  if (tracker.active) advanceTurn();
}

function beginActing() {
  if (!board.tracker.active) {
    broadcast();
    return;
  }
  const token = board.tokens.find((t) => t.id === init.currentTokenId(board.tracker));
  if (token) {
    const started = table.onTurnStart(board, catalog, token);
    if (started.lines.length) addLog('hit', started.lines, started.lines[0]);
    if (started.ended) {
      advanceTurn();
      return;
    }
  }
  broadcast();
  maybeRunMonsterTurn();
}

function advanceTurn() {
  const acting = board.tokens.find((t) => t.id === init.currentTokenId(board.tracker));
  const ending = acting ? table.onTurnEnd(board, catalog, acting) : [];
  if (ending.length) addLog('hit', ending, ending[0]);
  table.snapshot(board);
  init.endTurn(board.tracker, board.tokens, catalog);
  beginActing();
}

io.on('connection', (socket) => {
  socket.data.isDM = socket.handshake.auth.dmCode === DM_CODE;
  socket.emit('state', buildState(socket.data.isDM));

  socket.on('token:add', (payload = {}, acknowledge = () => {}) => {
    const { creatureId } = payload;
    const c = catalog[creatureId];
    const reply = (result) => {
      if (typeof acknowledge === 'function') acknowledge(result);
    };
    if (!c) {
      reply({ ok: false, error: 'That creature is no longer available. Refresh and try again.' });
      return;
    }
    // Players can only place characters, and each character only once.
    if (!socket.data.isDM && c.team !== 'player') {
      reply({ ok: false, error: 'Only the Dungeon Master can add creatures. Open the DM link to place enemies.' });
      return;
    }
    if (c.team === 'player' && board.tokens.some((t) => t.creatureId === c.id)) {
      reply({ ok: false, error: 'That character is already on the map.' });
      return;
    }
    const token = placeCreature(c);
    if (!token) {
      reply({ ok: false, error: 'The map has no open squares large enough for this creature.' });
      return;
    }
    broadcast();
    reply({ ok: true, tokenId: token.id });
  });

  socket.on('character:import', async ({ url }) => {
    const pasted = typeof url === 'string' ? url : '';
    const tempPath = path.join(IMPORTS_DIR, `.incoming-${process.pid}-${Date.now()}.json`);
    try {
      fs.mkdirSync(IMPORTS_DIR, { recursive: true });
      await runConverter(pasted, tempPath);
      const creature = readConverted(tempPath);
      const keptPath = path.join(IMPORTS_DIR, `${creature.id}.json`);
      fs.renameSync(tempPath, keptPath);

      if (premadeIds.has(creature.id)) {
        fs.unlinkSync(keptPath);
        socket.emit('character:import:error', {
          message: 'A premade character already uses that id.',
        });
        return;
      }

      catalog[creature.id] = creature;
      if (board.tokens.some((t) => t.creatureId === creature.id)) {
        socket.emit('character:import:error', {
          message: 'That character is already on the map.',
        });
        broadcast();
        return;
      }

      const token = placeCreature(creature);
      if (!token) {
        socket.emit('character:import:error', { message: 'The map has no open square.' });
        broadcast();
        return;
      }
      broadcast();
      socket.emit('character:import:ok', { tokenId: token.id });
    } catch (err) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      socket.emit('character:import:error', {
        message: err.message || 'The character could not be added.',
      });
    }
  });

  socket.on('token:move', ({ id, x, y }) => {
    const token = board.tokens.find((t) => t.id === id);
    if (!token || !canMove(socket, token)) return;

    const result = performMove(token, x, y, socket.data.isDM);
    if (!result.ok) {
      // Broadcast first, which snaps the dragged token back, then explain why.
      broadcast();
      socket.emit('attack:error', { message: result.error });
    }
  });

  socket.on('attack:declare', ({ attackerId, targetId, actionName, square, commandWord, amount, damageType }) => {
    const attacker = board.tokens.find((t) => t.id === attackerId);
    if (!attacker) return;

    // Players can only attack with their own side's tokens.
    if (!socket.data.isDM && attacker.team !== 'player') return;

    if (actionName === 'Break free') {
      const result = table.breakFree(board, catalog, attacker);
      if (!result.ok) {
        socket.emit('attack:error', { message: result.error });
        return;
      }
      addLog('hit', result.lines, result.pub);
      broadcast();
      return;
    }

    const creature = catalog[attacker.creatureId];
    const action = creature && (creature.actions || []).find((entry) => entry.name === actionName);
    let target = null;
    let aim = null;
    const optionalTarget = action && (action.kind === 'heal' || action.kind === 'feature');

    if (action && action.area) {
      if (action.zone === 'spirit') {
        aim = null;
      } else if (!square || !Number.isInteger(square.x) || !Number.isInteger(square.y)) {
        socket.emit('attack:error', { message: 'Choose a square for that spell.' });
        return;
      } else {
        aim = { x: square.x, y: square.y };
      }
    } else if (optionalTarget) {
      target = targetId ? board.tokens.find((t) => t.id === targetId) : null;
    } else {
      target = board.tokens.find((t) => t.id === targetId);
      if (!target || attacker.id === target.id) return;
    }

    // Rule problems (not your turn, out of range) go back to the sender only.
    const result = performAttack(attacker, target, actionName, aim, { commandWord, amount, damageType });
    if (!result.ok) socket.emit('attack:error', { message: result.error });
  });

  socket.on('condition:remove', ({ id, name }) => {
    if (!socket.data.isDM) return;
    const token = board.tokens.find((t) => t.id === id);
    if (!token || !Array.isArray(token.conditions)) return;
    table.snapshot(board);
    token.conditions = token.conditions.filter((condition) => condition !== name);
    if (Array.isArray(token.marks)) token.marks = token.marks.filter((mark) => mark.name !== name);
    broadcast();
  });

  // Handy for demos: put a token back to full health.
  socket.on('token:restore', ({ id }) => {
    if (!socket.data.isDM) return;
    const token = board.tokens.find((t) => t.id === id);
    if (!token) return;
    const result = table.setHp(board, token, token.maxHp);
    if (!result.ok) return;
    addLog('hit', result.lines, result.pub);
    broadcast();
  });

  socket.on('token:set-hp', ({ id, hp }) => {
    if (!socket.data.isDM) return;
    const token = board.tokens.find((t) => t.id === id);
    if (!token) return;
    const result = table.setHp(board, token, hp);
    if (!result.ok) {
      socket.emit('attack:error', { message: result.error });
      return;
    }
    addLog('hit', result.lines, result.pub);
    broadcast();
    checkForVictory();
  });

  socket.on('token:restore-use', ({ id, key }) => {
    if (!socket.data.isDM) return;
    const token = board.tokens.find((t) => t.id === id);
    if (!token) return;
    const result = table.restoreUse(board, token, key);
    if (!result.ok) {
      socket.emit('attack:error', { message: result.error });
      return;
    }
    addLog('hit', result.lines, result.pub);
    broadcast();
  });

  socket.on('zone:remove', ({ id }) => {
    if (!socket.data.isDM) return;
    table.snapshot(board);
    const lines = [];
    const result = table.removeZone(board, id, lines);
    if (!result.ok) {
      table.undo(board);
      return;
    }
    addLog('hit', lines.length ? lines : result.lines, result.pub);
    broadcast();
  });

  socket.on('combat:undo', () => {
    if (!socket.data.isDM) return;
    const result = table.undo(board);
    if (!result.ok) {
      socket.emit('attack:error', { message: result.error });
      return;
    }
    broadcast();
  });

  socket.on('token:remove', ({ id }) => {
    if (!socket.data.isDM) return;
    table.snapshot(board);
    const lines = [];
    table.releaseCaster(board, id, lines);
    board.tokens = board.tokens.filter((t) => t.id !== id);
    if (lines.length) addLog('hit', lines, lines[0]);
    init.removeFromCombat(board.tracker, id, board.tokens, catalog);
    broadcast();
    maybeRunMonsterTurn();
    checkForVictory();
  });

  socket.on('combat:start', () => {
    if (!socket.data.isDM || board.tracker.active) return;

    const order = init.startCombat(board.tracker, board.tokens, catalog);
    if (!board.tracker.active) return;

    const summary = order.map((e) => `${e.name} ${e.total}`).join(', ');
    const text = `Combat begins. Initiative: ${summary}.`;
    addLog('hit', [text], text);
    beginActing();
  });

  // The DM can end anyone's turn. A player can only end a player's turn.
  socket.on('combat:next', () => {
    const tracker = board.tracker;
    if (!tracker.active || monsterTurnRunning) return;

    const acting = board.tokens.find((t) => t.id === init.currentTokenId(tracker));
    if (!acting) return;
    if (!socket.data.isDM && acting.team !== 'player') return;

    advanceTurn();
  });

  socket.on('combat:end', () => {
    if (!socket.data.isDM) return;
    init.endCombat(board.tracker);
    broadcast();
  });

  // The DM can take monster turns by hand, or hand them back to the script.
  // A turn the script already started still finishes. The next monster waits.
  socket.on('combat:autopilot', (payload) => {
    if (!socket.data.isDM) return;
    const next = !!(payload && payload.on === true);
    if (autoMonsters === next) return;
    autoMonsters = next;
    broadcast();
    if (next) maybeRunMonsterTurn();
  });
});

function lanAddresses() {
  const found = [];
  Object.values(os.networkInterfaces()).forEach((list) => {
    list.forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) found.push(i.address);
    });
  });
  return found;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Battlemat running on port ${PORT}`);
  console.log(`  DM:      http://localhost:${PORT}/?dm=${DM_CODE}`);
  console.log(`  Players: http://localhost:${PORT}/`);
  lanAddresses().forEach((ip) => {
    console.log(`  LAN:     http://${ip}:${PORT}/`);
  });
});
