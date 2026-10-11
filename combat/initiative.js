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

// Half speed after the zero-to-30 fallback. Restrained cannot move at all.
function speedNow(creature, token) {
  let speed = speedOf(creature);
  if (token && (token.conditions || []).includes('slowed')) speed = Math.floor(speed / 2);
  if (token && (token.conditions || []).includes('restrained')) return 0;
  return speed;
}

function attacksThisAction(creature, token) {
  if (token && (token.conditions || []).includes('slowed')) return 1;
  return attacksPerAction(creature);
}

// A weapon or monster attack can use Extra Attack. Spells, heals, and features cannot.
function isAttackAction(action) {
  if (!action) return true;
  if (action.kind === 'spell' || action.kind === 'heal' || action.kind === 'feature') return false;
  if (action.saveAbility || action.profile) return false;
  return true;
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
    bonusUsed: false,
    extraAction: false,
    dashed: false,
    moved: false,
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
// action is optional. Older callers that only pass the token still mean "an attack".
function checkAttack(tracker, tokenId, action, token) {
  if (!tracker.active) return { ok: true }; // free-form play outside combat

  if (!tracker.turn || tracker.turn.tokenId !== tokenId) {
    return { ok: false, error: 'It is not that token\'s turn.' };
  }

  const turn = tracker.turn;
  const activation = (action && action.activation) || 'action';
  const slowed = token && (token.conditions || []).includes('slowed');

  if (activation === 'bonus') {
    if (turn.bonusUsed) return { ok: false, error: 'Bonus action already used.' };
    if (slowed && turn.actionUsed) return { ok: false, error: 'Slowed: that used the action, so the bonus action is gone.' };
    return { ok: true };
  }
  if (activation === 'reaction') {
    if (tracker.reactionUsed[tokenId]) return { ok: false, error: 'Reaction already used.' };
    return { ok: true };
  }
  if (activation === 'special') return { ok: true };

  if (slowed && turn.bonusUsed && turn.attacksLeft === 0) {
    return { ok: false, error: 'Slowed: that used the bonus action, so the action is gone.' };
  }
  if (isAttackAction(action)) {
    if (turn.attacksLeft > 0 || !turn.actionUsed || turn.extraAction) return { ok: true };
    return { ok: false, error: 'No action or attacks left this turn.' };
  }
  if (!turn.actionUsed) return { ok: true };
  if (turn.extraAction && action && action.kind !== 'spell' && action.kind !== 'heal') return { ok: true };
  return { ok: false, error: 'No action left this turn.' };
}

// Call this after the attack resolved successfully, so a rules error
// (like out of range) never costs the player their action.
function spendAttack(tracker, tokenId, creature, action, token) {
  const check = checkAttack(tracker, tokenId, action, token);
  if (!check.ok || !tracker.active) return check;

  const turn = tracker.turn;
  const activation = (action && action.activation) || 'action';
  if (activation === 'bonus') {
    turn.bonusUsed = true;
    return { ok: true };
  }
  if (activation === 'reaction') {
    tracker.reactionUsed[tokenId] = true;
    return { ok: true };
  }
  if (activation === 'special') return { ok: true };

  if (isAttackAction(action)) {
    if (turn.attacksLeft > 0) {
      turn.attacksLeft--;
    } else if (!turn.actionUsed) {
      turn.actionUsed = true;
      turn.attacksLeft = attacksThisAction(creature, token) - 1;
    } else if (turn.extraAction) {
      turn.extraAction = false;
      turn.actionUsed = true;
      turn.attacksLeft = attacksThisAction(creature, token) - 1;
    }
    return { ok: true };
  }

  if (!turn.actionUsed) {
    turn.actionUsed = true;
    turn.attacksLeft = 0;
  } else if (turn.extraAction) {
    turn.extraAction = false;
    turn.actionUsed = true;
    turn.attacksLeft = 0;
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
  tracker.turn.moved = true;
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
          bonusUsed: !!tracker.turn.bonusUsed,
          extraAction: !!tracker.turn.extraAction,
          reactionUsed: !!tracker.reactionUsed[tracker.turn.tokenId],
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
  attacksThisAction,
  speedNow,
  currentTokenId,
  checkAttack,
  spendAttack,
  spendMovement,
  publicView,
  checkVictory,
};
