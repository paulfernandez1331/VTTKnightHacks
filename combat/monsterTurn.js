// A simple script for monster turns. It only decides what to do, one step at
// a time, and never touches the board. Your server performs each step, which
// means monsters go through the exact same rules code as players do.
//
// The script is: pick the nearest enemy, attack with the action that does the
// most expected damage, and if nothing is in range, walk toward them.
// Only needs rules.js for grid math. Works with multi-square tokens (w and h).

const { GRID, feetBetween, insideRoom } = require('../public/rules.js');

const MAX_STEPS = 10; // safety net so a bug can never loop forever

// ---------- Small helpers ----------

// Average of a dice string like "2d4+2".
function averageDice(text) {
  const match = /^(\d+)d(\d+)([+-]\d+)?$/.exec(text.replace(/\s/g, ''));
  if (!match) return 0;
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;
  return (count * (sides + 1)) / 2 + modifier;
}

function abilityMod(creature, ability) {
  return Math.floor((creature.abilities[ability] - 10) / 2);
}

// Attack bonus for an action, mirroring how attack.js works it out.
function toHitFor(creature, action) {
  if (action.toHit !== undefined) return action.toHit;
  return abilityMod(creature, action.attackAbility) + creature.proficiency;
}

function hitChance(creature, action, targetCreature) {
  const needed = targetCreature.ac - toHitFor(creature, action);
  const chance = (21 - needed) / 20;
  return Math.min(0.95, Math.max(0.05, chance)); // nat 1 and nat 20 always matter
}

// Halves for resistance, zeroes for immunity, doubles for vulnerability.
function defenseFactor(type, targetCreature) {
  if ((targetCreature.immune || []).includes(type)) return 0;
  let factor = 1;
  if ((targetCreature.resist || []).includes(type)) factor = factor / 2;
  if ((targetCreature.vuln || []).includes(type)) factor = factor * 2;
  return factor;
}

function expectedDamage(creature, action, targetCreature) {
  let total = 0;
  action.damage.forEach((entry) => {
    const darts = entry.darts || 1;
    total += averageDice(entry.dice) * darts * defenseFactor(entry.type, targetCreature);
  });
  return total * hitChance(creature, action, targetCreature);
}

// Plain attack-roll actions only. The imported data also has save-based actions,
// area effects, auras ("Damage: Start of Turn"), and "Attack with Advantage"
// copies of a normal attack, none of which a simple script should pick.
function usableActions(creature) {
  return (creature.actions || []).filter((a) => {
    if (a.saveAbility || a.autoHit) return false;
    if (!a.damage || a.damage.length === 0) return false;
    if (a.name.startsWith('Attack with') || a.name.startsWith('Damage:')) return false;
    return a.toHit !== undefined || a.attackAbility !== undefined;
  });
}

function inRange(action, feet) {
  if (action.reach !== undefined && feet <= action.reach) return true;
  if (action.range && feet <= action.range.long) return true;
  return false;
}

function footprint(token) {
  return { w: token.w || 1, h: token.h || 1 };
}

// Does a token of this size fit with its top-left corner at x, y?
// Every square must be inside the room and free of other tokens.
function fitsAt(tokens, token, x, y) {
  const { w, h } = footprint(token);

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (!insideRoom(x + dx, y + dy)) return false;
    }
  }

  return !tokens.some((other) => {
    if (other.id === token.id) return false;
    const o = footprint(other);
    const overlapX = x < other.x + o.w && other.x < x + w;
    const overlapY = y < other.y + o.h && other.y < y + h;
    return overlapX && overlapY;
  });
}

// ---------- Decisions ----------

// Nearest living enemy. If two are equally close, go for the weaker one.
function chooseTarget(token, tokens) {
  const enemies = tokens.filter((t) => t.team !== token.team && !t.defeated);
  enemies.sort((a, b) => {
    const gap = feetBetween(token, a) - feetBetween(token, b);
    if (gap !== 0) return gap;
    return a.hp - b.hp;
  });
  return enemies[0] || null;
}

// Best action available for a token standing at "spot", or null if nothing reaches.
// spot is { x, y, w, h }, so it works for squares the token has not walked to yet.
function bestActionFrom(spot, target, creature, targetCreature) {
  const feet = feetBetween(spot, target);
  let best = null;
  let bestScore = -1;

  usableActions(creature).forEach((action) => {
    if (!inRange(action, feet)) return;
    const score = expectedDamage(creature, action, targetCreature);
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  });
  return best;
}

// Picks a square to walk to, or null if moving would not help.
// Cost is how far the token's corner travels, the same rule the server charges.
function findMove(token, target, tokens, creature, targetCreature, movementLeft) {
  const radius = Math.floor(movementLeft / GRID.feetPerSquare);
  if (radius < 1) return null;

  const { w, h } = footprint(token);
  const candidates = [];

  for (let x = token.x - radius; x <= token.x + radius; x++) {
    for (let y = token.y - radius; y <= token.y + radius; y++) {
      if (x === token.x && y === token.y) continue;
      if (!fitsAt(tokens, token, x, y)) continue;

      const spot = { x, y, w, h };
      candidates.push({
        x,
        y,
        steps: Math.max(Math.abs(x - token.x), Math.abs(y - token.y)),
        distanceToTarget: feetBetween(spot, target),
        canAttack: bestActionFrom(spot, target, creature, targetCreature) !== null,
      });
    }
  }

  // Preferred: a square where an attack is possible, using the least movement.
  // Ties favor staying farther back, which suits archers and costs melee nothing.
  const attackSpots = candidates.filter((c) => c.canAttack);
  if (attackSpots.length > 0) {
    attackSpots.sort((a, b) => {
      if (a.steps !== b.steps) return a.steps - b.steps;
      return b.distanceToTarget - a.distanceToTarget;
    });
    return attackSpots[0];
  }

  // Otherwise close the gap as much as we can, but only if it actually helps.
  candidates.sort((a, b) => {
    if (a.distanceToTarget !== b.distanceToTarget) return a.distanceToTarget - b.distanceToTarget;
    return a.steps - b.steps;
  });
  const closest = candidates[0];
  if (closest && closest.distanceToTarget < feetBetween(token, target)) return closest;
  return null;
}

// What should this monster do right now? Returns one of:
//   { type: 'attack', targetId, actionName }
//   { type: 'move', x, y, feet }
//   { type: 'end', reason }
// turn is the tracker's current turn state (actionUsed, attacksLeft, movementLeft).
function nextMonsterStep({ token, tokens, catalog, turn }) {
  const creature = catalog[token.creatureId];

  const canAttack = turn.attacksLeft > 0 || !turn.actionUsed;
  if (!canAttack) return { type: 'end', reason: 'no actions left' };

  const target = chooseTarget(token, tokens);
  if (!target) return { type: 'end', reason: 'no targets' };
  const targetCreature = catalog[target.creatureId];

  const action = bestActionFrom(token, target, creature, targetCreature);
  if (action) {
    return { type: 'attack', targetId: target.id, actionName: action.name };
  }

  const move = findMove(token, target, tokens, creature, targetCreature, turn.movementLeft);
  if (move) {
    return { type: 'move', x: move.x, y: move.y, feet: move.steps * GRID.feetPerSquare };
  }
  return { type: 'end', reason: 'cannot reach anyone' };
}

// Plays out a whole monster turn one step at a time, asking the board for fresh
// state before each step so deaths and moves are always accounted for.
//   getTokens()           returns the current token list
//   performMove(token, step)    and    performAttack(token, step)
//                         must return { ok, error? } and update the board
//   pause()               returns a promise, used to slow things down for viewers
async function runMonsterTurn({ token, getTokens, catalog, tracker, performMove, performAttack, pause }) {
  for (let i = 0; i < MAX_STEPS; i++) {
    // Stop if combat ended or the turn moved on while we were waiting.
    if (!tracker.active || !tracker.turn || tracker.turn.tokenId !== token.id) return;

    const tokens = getTokens();
    const self = tokens.find((t) => t.id === token.id);
    if (!self || self.defeated) return;

    const step = nextMonsterStep({ token: self, tokens, catalog, turn: tracker.turn });
    if (step.type === 'end') return;

    const result = step.type === 'move' ? performMove(self, step) : performAttack(self, step);
    if (!result.ok) return;

    await pause();
  }
}

module.exports = { nextMonsterStep, runMonsterTurn, usableActions };
