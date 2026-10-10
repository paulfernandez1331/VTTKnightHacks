const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const { GRID, insideRoom } = require('./public/rules.js');
const { resolveAttack } = require('./combat/attack.js');
const init = require('./combat/initiative.js');
const { runMonsterTurn } = require('./combat/monsterTurn.js');

const PORT = process.env.PORT || 3000;
const DM_CODE = process.env.DM_CODE || 'dm';

// Set AUTO_MONSTERS=false to run monster turns by hand as the DM instead.
const AUTO_MONSTERS = process.env.AUTO_MONSTERS !== 'false';

const monsters = require('./data/monsters.json');
const characters = require('./data/characters.json');

// Every creature we know about, keyed by id.
const catalog = {};
[...monsters, ...characters].forEach((c) => {
  catalog[c.id] = c;
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/konva', express.static(path.join(__dirname, 'node_modules/konva')));
app.use('/tokens', express.static(path.join(__dirname, '../dnd5e/tokens')));

// The one source of truth. Clients only ever send intents.
const board = { tokens: [], nextId: 1, log: [], nextLogId: 1, tracker: init.createTracker() };
const MAX_LOG_ENTRIES = 100;

// Build the view a given role is allowed to see.
// Players get full sheets for characters but only a name for monsters,
// and monster HP is hidden. This is where the DM-only rule lives.
function buildState(isDM) {
  const creatures = {};

  const tokens = board.tokens.map((t) => {
    const c = catalog[t.creatureId];
    const canSeeAll = isDM || c.team === 'player';
    creatures[c.id] = canSeeAll ? c : { id: c.id, name: c.name, team: c.team, token: c.token };
    return canSeeAll ? t : { ...t, hp: null, maxHp: null };
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

  return { tokens, creatures, roster, log, tracker: init.publicView(board.tracker), isDM };
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

  if (!free) {
    // Cost is how far the token's corner travels, with 5e diagonals.
    const steps = Math.max(Math.abs(x - token.x), Math.abs(y - token.y));
    const spent = init.spendMovement(board.tracker, token.id, steps * GRID.feetPerSquare);
    if (!spent.ok) return spent;
  }

  token.x = x;
  token.y = y;
  broadcast();
  return { ok: true };
}

// Players and monsters both attack through here too.
function performAttack(attacker, target, actionName) {
  const creature = catalog[attacker.creatureId];

  // Is it this token's turn, and does it still have an action or attack left?
  const turnCheck = init.checkAttack(board.tracker, attacker.id);
  if (!turnCheck.ok) return turnCheck;

  const result = resolveAttack({ attacker, target, actionName, tokens: board.tokens, catalog });
  if (!result.ok) return { ok: false, error: result.error };

  // Only spend the action once the attack really happened, so a rules error
  // like "out of range" never costs anyone their turn.
  init.spendAttack(board.tracker, attacker.id, creature);

  target.hp = result.hpAfter;
  target.defeated = result.defeated;
  addLog(result.outcome, result.dm, result.pub);
  broadcast();
  checkForVictory();
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
  if (!AUTO_MONSTERS || !tracker.active || monsterTurnRunning) return;

  const token = board.tokens.find((t) => t.id === init.currentTokenId(tracker));
  if (!token || token.team !== 'monster') return;

  monsterTurnRunning = true;
  try {
    await runMonsterTurn({
      token,
      getTokens: () => board.tokens,
      catalog,
      tracker,
      performMove: (t, step) => performMove(t, step.x, step.y, false),
      performAttack: (t, step) => {
        const target = board.tokens.find((x) => x.id === step.targetId);
        return performAttack(t, target, step.actionName);
      },
      pause: () => new Promise((resolve) => setTimeout(resolve, 800)),
    });
  } catch (err) {
    // A bug in one monster's turn should skip that turn, not crash the table.
    console.error('Monster turn failed:', err);
  } finally {
    monsterTurnRunning = false;
  }

  if (tracker.active) advanceTurn();
}

function advanceTurn() {
  init.endTurn(board.tracker, board.tokens, catalog);
  broadcast();
  maybeRunMonsterTurn(); // chains straight into the next monster, if there is one
}

io.on('connection', (socket) => {
  socket.data.isDM = socket.handshake.auth.dmCode === DM_CODE;
  socket.emit('state', buildState(socket.data.isDM));

  socket.on('token:add', ({ creatureId }) => {
    const c = catalog[creatureId];
    if (!c) return;
    // Players can only place characters, and each character only once.
    if (!socket.data.isDM && c.team !== 'player') return;
    if (c.team === 'player' && board.tokens.some((t) => t.creatureId === c.id)) return;

    const w = c.width || 1;
    const h = c.height || 1;
    const spot = findFreeSpot(w, h);
    if (!spot) return;

    // Monsters get numbered so "Goblin 1" and "Goblin 2" are easy to tell apart.
    let name = c.name;
    if (c.team === 'monster') {
      const count = board.tokens.filter((t) => t.creatureId === c.id).length;
      name = `${c.name} ${count + 1}`;
    }

    const newToken = {
      id: board.nextId++,
      creatureId: c.id,
      name,
      team: c.team,
      x: spot.x,
      y: spot.y,
      w,
      h,
      hp: c.hp,
      maxHp: c.hp,
      defeated: false,
    };
    board.tokens.push(newToken);

    // A token placed mid-fight rolls initiative and joins the order.
    init.addToCombat(board.tracker, newToken, catalog);
    broadcast();
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

  socket.on('attack:declare', ({ attackerId, targetId, actionName }) => {
    const attacker = board.tokens.find((t) => t.id === attackerId);
    const target = board.tokens.find((t) => t.id === targetId);
    if (!attacker || !target || attacker.id === target.id) return;

    // Players can only attack with their own side's tokens.
    if (!socket.data.isDM && attacker.team !== 'player') return;

    // Rule problems (not your turn, out of range) go back to the sender only.
    const result = performAttack(attacker, target, actionName);
    if (!result.ok) socket.emit('attack:error', { message: result.error });
  });

  // Handy for demos: put a token back to full health.
  socket.on('token:restore', ({ id }) => {
    if (!socket.data.isDM) return;
    const token = board.tokens.find((t) => t.id === id);
    if (!token) return;
    token.hp = token.maxHp;
    token.defeated = false;
    broadcast();
  });

  socket.on('token:remove', ({ id }) => {
    if (!socket.data.isDM) return;
    board.tokens = board.tokens.filter((t) => t.id !== id);
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
    broadcast();
    maybeRunMonsterTurn();
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
