// Initiative and turn tracking. This file is standalone: it only needs dice.js
// and plain token and creature objects, so it does not care how your server,
// UI, or importer are put together.

const { rollD20 } = require('./dice.js');

// ---------- Data accessors ----------
// If your importer stores these fields under different names, change them here.

const DEFAULT_SPEED = 30;

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function dexMod(creature) {
  return Math.floor((creature.abilities.dex - 10) / 2);
}

// The exported data has speed 0 for every character and for summoned creatures
// that only fly or swim, so zero falls back to a normal walking speed.
function speedOf(creature) {
  return creature.speed > 0 ? creature.speed : DEFAULT_SPEED;
}

// The exported data keeps Multiattack as rules text, not a number. So read the
// count out of a sentence like "The owlbear makes two Rend attacks."
// Anything we cannot read counts as a single attack.
function attacksPerAction(creature) {
  if (creature.attacksPerAction) return creature.attacksPerAction;

  const multi = (creature.traits || []).find((t) => t.name === 'Multiattack');
  if (multi) {
    const match = /\bmakes? (one|two|three|four|five|six|\d+)\b/i.exec(multi.summary || '');
    if (match) {
      const word = match[1].toLowerCase();
      return NUMBER_WORDS[word] || Number(word);
    }
  }

  // Player characters: "You can attack twice instead of once..."
  const extra = (creature.features || []).find((f) => f.name === 'Extra Attack');
  if (extra) {
    const text = (extra.summary || '').toLowerCase();
    if (text.includes('three times')) return 3;
    if (text.includes('four times')) return 4;
    return 2;
  }

  return 1;
}

// ---------- Tracker ----------

function createTracker() {
  return {
    active: false,
    round: 0,
    order: [], // [{ tokenId, name, roll, mod, total, tiebreak }]
    turnIndex: 0,
    turn: null, // resources for whoever is acting right now
    reactionUsed: {}, // tokenId -> true until that token's next turn starts
  };
}

// Resets in place so anything holding a reference to the tracker stays valid.
function endCombat(tracker) {
  Object.assign(tracker, createTracker());
}

function findToken(tokens, id) {
  return tokens.find((t) => t.id === id);
}

function currentTokenId(tracker) {
  return tracker.turn ? tracker.turn.tokenId : null;
}

// ---------- Rolling ----------

function rollOne(token, catalog) {
  const creature = catalog[token.creatureId];
  const mod = dexMod(creature);
  const roll = rollD20('normal').roll;
  return {
    tokenId: token.id,
    name: token.name,
    roll,
    mod,
    total: roll + mod,
    tiebreak: Math.random(), // last resort when total and DEX modifier both tie
  };
}

// Highest total first. Ties go to the higher DEX modifier, then a coin flip.
function compareEntries(a, b) {
  if (b.total !== a.total) return b.total - a.total;
  if (b.mod !== a.mod) return b.mod - a.mod;
  return b.tiebreak - a.tiebreak;
}

// ---------- Turn flow ----------

// Hands the current entry a fresh set of resources.
function beginTurn(tracker, tokens, catalog) {
  const entry = tracker.order[tracker.turnIndex];
  const token = entry ? findToken(tokens, entry.tokenId) : null;
  if (!token) {
    tracker.turn = null;
    return;
  }

  tracker.turn = {
    tokenId: token.id,
    actionUsed: false,
    attacksLeft: 0, // extra swings left from the Attack action
    movementLeft: speedOf(catalog[token.creatureId]),
  };
  delete tracker.reactionUsed[token.id]; // reactions come back on your own turn
}

// If the pointer sits on a defeated or removed token, walk forward to a live one.
function settleOnLiveEntry(tracker, tokens, catalog) {
  for (let i = 0; i < tracker.order.length; i++) {
    const token = findToken(tokens, tracker.order[tracker.turnIndex].tokenId);
    if (token && !token.defeated) break;

    tracker.turnIndex++;
    if (tracker.turnIndex >= tracker.order.length) {
      tracker.turnIndex = 0;
      tracker.round++;
    }
  }
  beginTurn(tracker, tokens, catalog);
}

// Rolls everyone who is still standing and starts round 1.
function startCombat(tracker, tokens, catalog) {
  const live = tokens.filter((t) => !t.defeated);
  tracker.order = live.map((t) => rollOne(t, catalog)).sort(compareEntries);
  tracker.active = tracker.order.length > 0;
  tracker.round = 1;
  tracker.turnIndex = 0;
  tracker.reactionUsed = {};

  if (tracker.active) settleOnLiveEntry(tracker, tokens, catalog);
  return tracker.order;
}

function endTurn(tracker, tokens, catalog) {
  tracker.turnIndex++;
  if (tracker.turnIndex >= tracker.order.length) {
    tracker.turnIndex = 0;
    tracker.round++;
  }
  settleOnLiveEntry(tracker, tokens, catalog);
}

// A token placed mid-fight rolls initiative and slots into the order.
// The pointer follows whoever is acting, so nobody loses or repeats a turn.
function addToCombat(tracker, token, catalog) {
  if (!tracker.active) return null;

  const activeId = currentTokenId(tracker);
  const entry = rollOne(token, catalog);
  tracker.order.push(entry);
  tracker.order.sort(compareEntries);
  tracker.turnIndex = tracker.order.findIndex((e) => e.tokenId === activeId);
  return entry;
}

// Call this when a token is deleted. If it was mid-turn, play moves on.
function removeFromCombat(tracker, tokenId, tokens, catalog) {
  if (!tracker.active) return;

  const index = tracker.order.findIndex((e) => e.tokenId === tokenId);
  if (index === -1) return;

  const wasActing = currentTokenId(tracker) === tokenId;
  tracker.order.splice(index, 1);

  if (tracker.order.length === 0) {
    endCombat(tracker);
    return;
  }

  if (index < tracker.turnIndex) tracker.turnIndex--;

  if (wasActing) {
    // The next entry has slid into this index already. Wrap if we ran off the end.
    if (tracker.turnIndex >= tracker.order.length) {
      tracker.turnIndex = 0;
      tracker.round++;
    }
    settleOnLiveEntry(tracker, tokens, catalog);
  }
}

// ---------- Action economy ----------

// Checks without changing anything. Call this before rolling the attack.
function checkAttack(tracker, tokenId) {
  if (!tracker.active) return { ok: true }; // free-form play outside combat

  if (tracker.turn.tokenId !== tokenId) {
    return { ok: false, error: 'It is not that token\'s turn.' };
  }
  if (tracker.turn.attacksLeft > 0 || !tracker.turn.actionUsed) {
    return { ok: true };
  }
  return { ok: false, error: 'No action or attacks left this turn.' };
}

// Call this after the attack resolved successfully, so a rules error
// (like out of range) never costs the player their action.
function spendAttack(tracker, tokenId, creature) {
  const check = checkAttack(tracker, tokenId);
  if (!check.ok || !tracker.active) return check;

  const turn = tracker.turn;
  if (turn.attacksLeft > 0) {
    turn.attacksLeft--;
  } else {
    // First attack uses the action and unlocks the rest of the Attack action.
    turn.actionUsed = true;
    turn.attacksLeft = attacksPerAction(creature) - 1;
  }
  return { ok: true };
}

function spendMovement(tracker, tokenId, feet) {
  if (!tracker.active) return { ok: true };

  if (tracker.turn.tokenId !== tokenId) {
    return { ok: false, error: 'It is not that token\'s turn.' };
  }
  if (feet > tracker.turn.movementLeft) {
    return { ok: false, error: `Only ${tracker.turn.movementLeft} ft of movement left.` };
  }
  tracker.turn.movementLeft -= feet;
  return { ok: true };
}

// ---------- Views and win check ----------

// Safe to send to every client. Initiative totals are not secret.
function publicView(tracker) {
  return {
    active: tracker.active,
    round: tracker.round,
    currentTokenId: currentTokenId(tracker),
    order: tracker.order.map((e) => ({ tokenId: e.tokenId, name: e.name, total: e.total })),
    turn: tracker.turn
      ? {
          actionUsed: tracker.turn.actionUsed,
          attacksLeft: tracker.turn.attacksLeft,
          movementLeft: tracker.turn.movementLeft,
        }
      : null,
  };
}

// Returns "players", "monsters", or null while both sides still have someone up.
function checkVictory(tokens) {
  const standing = (team) => tokens.filter((t) => t.team === team && !t.defeated).length;
  const present = (team) => tokens.some((t) => t.team === team);

  if (present('monster') && standing('monster') === 0) return 'players';
  if (present('player') && standing('player') === 0) return 'monsters';
  return null;
}

module.exports = {
  createTracker,
  startCombat,
  endTurn,
  endCombat,
  addToCombat,
  removeFromCombat,
  attacksPerAction,
  currentTokenId,
  checkAttack,
  spendAttack,
  spendMovement,
  publicView,
  checkVictory,
};
