const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const { GRID, insideRoom } = require('./public/rules.js');
const { resolveAttack } = require('./combat/attack.js');

const PORT = process.env.PORT || 3000;
const DM_CODE = process.env.DM_CODE || 'dm';

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
const board = { tokens: [], nextId: 1, log: [], nextLogId: 1 };
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

  return { tokens, creatures, roster, log, isDM };
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
  };
  board.tokens.push(token);
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

io.on('connection', (socket) => {
  socket.data.isDM = socket.handshake.auth.dmCode === DM_CODE;
  socket.emit('state', buildState(socket.data.isDM));

  socket.on('token:add', ({ creatureId }) => {
    const c = catalog[creatureId];
    if (!c) return;
    // Players can only place characters, and each character only once.
    if (!socket.data.isDM && c.team !== 'player') return;
    if (c.team === 'player' && board.tokens.some((t) => t.creatureId === c.id)) return;
    if (!placeCreature(c)) return;
    broadcast();
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

    // Reject moves that leave the room or land on another token.
    // Either way we broadcast, which snaps the dragged token back if rejected.
    const { w, h } = footprintOf(token);
    if (fits(x, y, w, h, id)) {
      token.x = x;
      token.y = y;
    }
    broadcast();
  });

  socket.on('attack:declare', ({ attackerId, targetId, actionName, square }) => {
    const attacker = board.tokens.find((t) => t.id === attackerId);
    if (!attacker) return;

    // Players can only attack with their own side's tokens.
    if (!socket.data.isDM && attacker.team !== 'player') return;

    const creature = catalog[attacker.creatureId];
    const action = creature && (creature.actions || []).find((entry) => entry.name === actionName);
    let target = null;
    let aim = null;

    if (action && action.area) {
      if (!square || !Number.isInteger(square.x) || !Number.isInteger(square.y)) {
        socket.emit('attack:error', { message: 'Choose a square for that spell.' });
        return;
      }
      aim = { x: square.x, y: square.y };
    } else {
      target = board.tokens.find((t) => t.id === targetId);
      if (!target || attacker.id === target.id) return;
    }

    const result = resolveAttack({
      attacker,
      target,
      actionName,
      tokens: board.tokens,
      catalog,
      square: aim,
    });

    // Rule problems (out of range, defeated) go back to the sender only.
    if (!result.ok) {
      socket.emit('attack:error', { message: result.error });
      return;
    }

    (result.targets || []).forEach((entry) => {
      const token = board.tokens.find((t) => t.id === entry.id);
      if (!token) return;
      token.hp = entry.hpAfter;
      token.defeated = entry.defeated;
      if (!Array.isArray(token.conditions)) token.conditions = [];
      const immune = (catalog[token.creatureId] && catalog[token.creatureId].conditionImmune) || [];
      (entry.conditions || []).forEach((name) => {
        if (immune.includes(name) || token.conditions.includes(name)) return;
        token.conditions.push(name);
      });
    });

    board.log.push({
      id: board.nextLogId++,
      outcome: result.outcome,
      dm: result.dm,
      pub: result.pub,
    });
    if (board.log.length > MAX_LOG_ENTRIES) board.log.shift();

    broadcast();
  });

  socket.on('condition:remove', ({ id, name }) => {
    if (!socket.data.isDM) return;
    const token = board.tokens.find((t) => t.id === id);
    if (!token || !Array.isArray(token.conditions)) return;
    token.conditions = token.conditions.filter((condition) => condition !== name);
    broadcast();
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
