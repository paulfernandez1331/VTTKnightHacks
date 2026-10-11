// Decides a monster's turn one step at a time. The server performs each step,
// so dice, areas, and hit points stay in the same code players use.
//
// Weapons still prefer the nearest enemy. Saves and areas are scored too:
// an area is aimed to catch more than one enemy, and a monster walks to a
// square where that action is better than what it can do standing still.
// Auras and flat damage with no dice are skipped.

const { GRID, feetBetween, insideRoom, areaSquares, tokenCaught, coversSquare } = require('../public/rules.js');
const { speedNow } = require('./initiative.js');

const MAX_STEPS = 10; // safety net so a bug can never loop forever
const CONDITION_VALUE = 4; // enough for a hold to beat a dagger, not a real breath

// ---------- Small helpers ----------

// Average of a dice string like "2d4+2".
function averageDice(text) {
  if (!text) return 0;
  const match = /^(\d+)d(\d+)([+-]\d+)?$/.exec(String(text).replace(/\s/g, ''));
  if (!match) return 0;
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;
  return (count * (sides + 1)) / 2 + modifier;
}

function abilityMod(creature, ability) {
  const score = creature.abilities && creature.abilities[ability];
  return Math.floor(((score == null ? 10 : score) - 10) / 2);
}

// Attack bonus for an action, mirroring how attack.js works it out.
function toHitFor(creature, action) {
  if (action.toHit !== undefined) return action.toHit;
  return abilityMod(creature, action.attackAbility) + (creature.proficiency || 0);
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

function rawDamage(action, targetCreature) {
  let total = 0;
  (action.damage || []).forEach((entry) => {
    const darts = entry.darts || 1;
    total += averageDice(entry.dice) * darts * defenseFactor(entry.type, targetCreature);
  });
  return total;
}

function expectedDamage(creature, action, targetCreature) {
  return rawDamage(action, targetCreature) * hitChance(creature, action, targetCreature);
}

function saveSuccessChance(targetCreature, action) {
  const ability = action.saveAbility;
  const modifier = abilityMod(targetCreature, ability);
  const proficient = targetCreature.saves && targetCreature.saves[ability];
  const bonus = modifier + (proficient ? (targetCreature.proficiency || 0) : 0);
  const need = (action.saveDc || 10) - bonus;
  return Math.max(0.05, Math.min(0.95, (21 - need) / 20));
}

function conditionValue(action, targetCreature, target) {
  let sum = 0;
  (action.conditions || []).forEach((condition) => {
    if ((targetCreature.conditionImmune || []).includes(condition)) return;
    if ((target.conditions || []).includes(condition)) return;
    sum += CONDITION_VALUE;
  });
  return Math.min(sum, 8);
}

function expectedSaveValue(creature, action, targetCreature, target) {
  const success = saveSuccessChance(targetCreature, action);
  const onSave = action.onSave || 'half';
  const kept = onSave === 'none' ? 0 : onSave === 'half' ? 0.5 : 1;
  const damage = rawDamage(action, targetCreature) * ((1 - success) + success * kept);
  return damage + (1 - success) * conditionValue(action, targetCreature, target);
}

function singleValue(creature, action, targetCreature, target) {
  if (action.saveAbility) return expectedSaveValue(creature, action, targetCreature, target);
  if (!action.damage || action.damage.length === 0) return 0;
  return expectedDamage(creature, action, targetCreature);
}

function usesLeft(token, action) {
  if (!token || !token.uses) return true;
  const bag = token.uses[action.useKey || action.name];
  if (!bag) return true;
  return bag.left > 0;
}

// Attack rolls, saves, and areas. Auras, advantage copies, and Multiattack
// are descriptions, not buttons the script can press.
function usableActions(creature, token) {
  return (creature.actions || []).filter((action) => {
    if (!usesLeft(token, action)) return false;
    if (action.activation && action.activation !== 'action') return false;
    const name = action.name || '';
    if (name === 'Multiattack') return false;
    if (name.startsWith('Attack with') || name.startsWith('Damage:')) return false;
    if (/^attack (at|with) advantage$/i.test(name)) return false;
    const hasArea = !!action.area;
    const hasSave = !!action.saveAbility;
    const hasDamage = !!(action.damage && action.damage.length);
    const hasCondition = !!(action.conditions && action.conditions.length);
    if (!hasArea && !hasSave && !hasDamage) return false;
    if (action.autoHit && !hasArea) return false;
    if (!hasArea && !hasSave && !hasCondition && !hasDamage) return false;
    if (!hasArea && !hasSave) return action.toHit !== undefined || action.attackAbility !== undefined;
    return hasDamage || hasCondition;
  });
}

// The original weapon filter. Creatures with only these keep the old movement.
function weaponActions(creature, token) {
  return usableActions(creature, token).filter((action) => {
    if (action.saveAbility || action.area || action.autoHit) return false;
    return action.toHit !== undefined || action.attackAbility !== undefined;
  });
}

function tactical(creature, token) {
  return usableActions(creature, token).some((action) => action.area || action.saveAbility);
}

function inRange(action, feet) {
  if (action.reach !== undefined && feet <= action.reach) return true;
  if (action.range && feet <= action.range.long) return true;
  return false;
}

function footprint(token) {
  return { w: token.w || 1, h: token.h || 1 };
}

function standingAt(token, x, y) {
  return Object.assign({}, token, { x, y });
}

function withMover(tokens, token, x, y) {
  return tokens.map((entry) => (entry.id === token.id ? standingAt(entry, x, y) : entry));
}

function selfAimed(area) {
  const type = area && area.type;
  return area && area.origin === 'self' && (type === 'cone' || type === 'line' || type === 'cube' || type === 'square' || type === 'wall');
}

function selfDisk(area) {
  const type = area && area.type;
  return area && area.origin === 'self' && (type === 'sphere' || type === 'circle' || type === 'radius' || type === 'cylinder');
}

function livingEnemies(token, tokens) {
  return tokens.filter((entry) => entry.id !== token.id && entry.team !== token.team && !entry.defeated);
}

function canTarget(action, target, targetCreature) {
  if (!action.targets || !action.targets.length) return true;
  const kind = String((targetCreature && targetCreature.type) || (target.team === 'player' ? 'humanoid' : '')).toLowerCase();
  return action.targets.includes(kind);
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
    const otherSpan = footprint(other);
    const overlapX = x < other.x + otherSpan.w && other.x < x + w;
    const overlapY = y < other.y + otherSpan.h && other.y < y + h;
    return overlapX && overlapY;
  });
}

// ---------- Decisions ----------

// Nearest living enemy. If two are equally close, go for the weaker one.
function chooseTarget(token, tokens) {
  const enemies = livingEnemies(token, tokens);
  enemies.sort((a, b) => {
    const gap = feetBetween(token, a) - feetBetween(token, b);
    if (gap !== 0) return gap;
    return a.hp - b.hp;
  });
  return enemies[0] || null;
}

// Best weapon for a token standing at "spot", or null if nothing reaches.
// spot is { x, y, w, h }, so it works for squares the token has not walked to yet.
function bestActionFrom(spot, target, creature, targetCreature, token) {
  const feet = feetBetween(spot, target);
  let best = null;
  let bestScore = -1;

  weaponActions(creature, token).forEach((action) => {
    if (!inRange(action, feet)) return;
    const score = expectedDamage(creature, action, targetCreature);
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  });
  return best;
}

// Squares worth aiming at: each enemy, and the point between each pair.
function aimSquares(origin, tokens) {
  const foes = livingEnemies(origin, tokens);
  const seen = new Set();
  const aims = [];
  const add = (x, y) => {
    if (!insideRoom(x, y) || coversSquare(origin, x, y)) return;
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    aims.push({ x, y });
  };

  foes.forEach((foe) => add(foe.x, foe.y));
  for (let i = 0; i < foes.length; i++) {
    for (let j = i + 1; j < foes.length; j++) {
      const x = Math.round((foes[i].x + foes[j].x) / 2);
      const y = Math.round((foes[i].y + foes[j].y) / 2);
      add(x, y);
      const dx = Math.sign(x - origin.x);
      const dy = Math.sign(y - origin.y);
      add(x + dx * 2, y + dy * 2);
    }
  }
  return aims;
}

function scoreArea(origin, tokens, creature, catalog, action, square) {
  if (selfAimed(action.area) && square && coversSquare(origin, square.x, square.y)) return 0;
  if (!selfDisk(action.area) && !selfAimed(action.area)) {
    const farthest = Math.max(action.reach || 0, action.range ? action.range.long : 0);
    if (farthest <= 0) return 0;
    if (feetBetween(origin, { x: square.x, y: square.y, w: 1, h: 1 }) > farthest) return 0;
  }

  const aim = square || origin;
  const covered = areaSquares(origin, aim, action.area);
  let caught = tokens.filter((entry) => {
    if (entry.defeated || !tokenCaught(entry, covered)) return false;
    const creatureData = catalog[entry.creatureId];
    return canTarget(action, entry, creatureData);
  });
  if (action.zone === 'spirit') {
    caught = caught.filter((entry) => entry.team !== origin.team);
  }
  if (action.limit && caught.length > action.limit) {
    const from = { x: aim.x, y: aim.y, w: 1, h: 1 };
    caught.sort((a, b) => feetBetween(from, a) - feetBetween(from, b));
    caught = caught.slice(0, action.limit);
  }

  let score = 0;
  let enemies = 0;
  caught.forEach((entry) => {
    const creatureData = catalog[entry.creatureId];
    if (!creatureData) return;
    const value = singleValue(creature, action, creatureData, entry);
    if (!Number.isFinite(value) || value <= 0) return;
    if (entry.id === origin.id || entry.team === origin.team) {
      score -= value * 1.5;
    } else {
      score += value;
      enemies += 1;
    }
  });
  if (enemies === 0) return 0;
  return score;
}

// Every positive action from this square, best first.
function attackChoices(token, tokens, catalog) {
  const creature = catalog[token.creatureId];
  if (!creature) return [];
  const choices = [];
  const foes = livingEnemies(token, tokens);

  usableActions(creature, token).forEach((action) => {
    if (action.area) {
      const squares = selfDisk(action.area) ? [null] : aimSquares(token, tokens);
      squares.forEach((square) => {
        const score = scoreArea(token, tokens, creature, catalog, action, square);
        if (score > 0) {
          choices.push({
            type: 'attack',
            actionName: action.name,
            targetId: null,
            square: square || null,
            score,
            distance: 0,
          });
        }
      });
      return;
    }

    foes.forEach((target) => {
      const targetCreature = catalog[target.creatureId];
      if (!targetCreature || !canTarget(action, target, targetCreature)) return;
      if (!inRange(action, feetBetween(token, target))) return;
      const score = singleValue(creature, action, targetCreature, target);
      if (!Number.isFinite(score) || score <= 0) return;
      choices.push({
        type: 'attack',
        actionName: action.name,
        targetId: target.id,
        square: null,
        score,
        distance: feetBetween(token, target),
      });
    });
  });

  choices.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.distance - b.distance;
  });
  return choices;
}

function bestChoice(token, tokens, catalog) {
  return attackChoices(token, tokens, catalog)[0] || null;
}

function cellsWithin(token, tokens, movementLeft, costOf) {
  const radius = Math.floor(movementLeft / GRID.feetPerSquare);
  const cells = [];
  if (radius < 1) return cells;

  for (let x = token.x - radius; x <= token.x + radius; x++) {
    for (let y = token.y - radius; y <= token.y + radius; y++) {
      if (x === token.x && y === token.y) continue;
      if (!fitsAt(tokens, token, x, y)) continue;
      const steps = Math.max(Math.abs(x - token.x), Math.abs(y - token.y));
      const feet = costOf ? costOf(token, x, y) : steps * GRID.feetPerSquare;
      if (feet <= 0 || feet > movementLeft) continue;
      cells.push({ x, y, steps, feet });
    }
  }
  return cells;
}

// A reachable square whose best action beats what the monster can do now.
function bestRelocation(token, tokens, catalog, movementLeft, costOf, floorScore) {
  let best = null;
  cellsWithin(token, tokens, movementLeft, costOf).forEach((cell) => {
    const placed = withMover(tokens, token, cell.x, cell.y);
    const choice = bestChoice(standingAt(token, cell.x, cell.y), placed, catalog);
    if (!choice || choice.score <= floorScore) return;
    if (!best || choice.score > best.score || (choice.score === best.score && cell.steps < best.steps)) {
      best = Object.assign({}, cell, { score: choice.score });
    }
  });
  return best;
}

// Picks a square to walk to, or null if moving would not help.
// Cost is how far the token's corner travels, the same rule the server charges.
function findMove(token, target, tokens, creature, targetCreature, movementLeft, costOf) {
  const radius = Math.floor(movementLeft / GRID.feetPerSquare);
  if (radius < 1) return null;

  const { w, h } = footprint(token);
  const candidates = [];

  for (let x = token.x - radius; x <= token.x + radius; x++) {
    for (let y = token.y - radius; y <= token.y + radius; y++) {
      if (x === token.x && y === token.y) continue;
      if (!fitsAt(tokens, token, x, y)) continue;

      const steps = Math.max(Math.abs(x - token.x), Math.abs(y - token.y));
      const feet = costOf ? costOf(token, x, y) : steps * GRID.feetPerSquare;
      if (feet > movementLeft) continue;

      const spot = { x, y, w, h };
      candidates.push({
        x,
        y,
        steps,
        feet,
        distanceToTarget: feetBetween(spot, target),
        canAttack: bestActionFrom(spot, target, creature, targetCreature, token) !== null,
      });
    }
  }

  // Preferred: a square where an attack is possible, using the least movement.
  // Ties favor staying farther back, which suits archers and costs melee nothing.
  const attackSpots = candidates.filter((cell) => cell.canAttack);
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

function stepToward(token, tokens, goal, movementLeft, costOf) {
  let best = null;
  const goalSpot = { x: goal.x, y: goal.y, w: token.w || 1, h: token.h || 1 };
  const now = feetBetween(token, goalSpot);
  cellsWithin(token, tokens, movementLeft, costOf).forEach((cell) => {
    const dist = feetBetween(standingAt(token, cell.x, cell.y), goalSpot);
    if (dist >= now) return;
    if (!best || dist < best.dist || (dist === best.dist && cell.steps < best.steps)) {
      best = Object.assign({}, cell, { dist });
    }
  });
  return best;
}

function goalWithin(token, tokens, catalog, squares) {
  let best = null;
  for (let x = token.x - squares; x <= token.x + squares; x++) {
    for (let y = token.y - squares; y <= token.y + squares; y++) {
      if (!fitsAt(tokens, token, x, y)) continue;
      const placed = withMover(tokens, token, x, y);
      const choice = bestChoice(standingAt(token, x, y), placed, catalog);
      if (!choice) continue;
      const dist = Math.max(Math.abs(x - token.x), Math.abs(y - token.y));
      if (!best || choice.score > best.score || (choice.score === best.score && dist < best.dist)) {
        best = { x, y, score: choice.score, dist };
      }
    }
  }
  return best;
}

function attackStep(choice) {
  return {
    type: 'attack',
    targetId: choice.targetId,
    actionName: choice.actionName,
    square: choice.square || null,
  };
}

function weaponStep({ token, tokens, catalog, turn, costOf }) {
  const creature = catalog[token.creatureId];
  const target = chooseTarget(token, tokens);
  if (!target) return { type: 'end', reason: 'no targets' };
  const targetCreature = catalog[target.creatureId];

  const canAct = turn.attacksLeft > 0 || !turn.actionUsed;
  if (canAct) {
    const action = bestActionFrom(token, target, creature, targetCreature, token);
    if (action) return { type: 'attack', targetId: target.id, actionName: action.name };
  }

  const move = findMove(token, target, tokens, creature, targetCreature, turn.movementLeft, costOf);
  if (canAct && move && move.canAttack) {
    return { type: 'move', x: move.x, y: move.y, feet: move.feet };
  }

  // Dash only when no square the current movement can reach allows an attack,
  // and spending the action on Dash would actually get the monster closer.
  if (canAct && !turn.actionUsed && turn.attacksLeft === 0) {
    const speed = speedNow(creature, token);
    if (speed > 0) {
      const farther = findMove(
        token, target, tokens, creature, targetCreature, turn.movementLeft + speed, costOf
      );
      const improves = farther && (
        farther.canAttack || !move || farther.distanceToTarget < move.distanceToTarget
      );
      if (improves) return { type: 'dash' };
    }
  }

  if (move && (canAct || turn.dashed)) {
    return { type: 'move', x: move.x, y: move.y, feet: move.feet };
  }
  if (!canAct) return { type: 'end', reason: 'no actions left' };
  return { type: 'end', reason: 'cannot reach anyone' };
}

function tacticalStep({ token, tokens, catalog, turn, costOf }) {
  const creature = catalog[token.creatureId];
  if (!livingEnemies(token, tokens).length) return { type: 'end', reason: 'no targets' };

  const canAct = turn.attacksLeft > 0 || !turn.actionUsed;
  const here = canAct ? bestChoice(token, tokens, catalog) : null;
  const floorScore = here ? here.score : 0;

  if (canAct) {
    const relocation = bestRelocation(token, tokens, catalog, turn.movementLeft, costOf, floorScore);
    if (relocation) return { type: 'move', x: relocation.x, y: relocation.y, feet: relocation.feet };
    if (here) return attackStep(here);
  }

  const speed = speedNow(creature, token);
  const reach = Math.ceil((turn.movementLeft + speed) / GRID.feetPerSquare) + 2;
  const goal = canAct ? goalWithin(token, tokens, catalog, reach) : null;

  if (canAct && !turn.actionUsed && turn.attacksLeft === 0 && speed > 0) {
    const farther = bestRelocation(token, tokens, catalog, turn.movementLeft + speed, costOf, floorScore);
    const now = stepToward(token, tokens, goal || token, turn.movementLeft, costOf);
    const after = goal && stepToward(token, tokens, goal, turn.movementLeft + speed, costOf);
    const closer = !!(after && (!now || after.dist < now.dist));
    if (farther || closer) return { type: 'dash' };
  }

  if (goal && (canAct || turn.dashed)) {
    const toward = stepToward(token, tokens, goal, turn.movementLeft, costOf);
    if (toward) return { type: 'move', x: toward.x, y: toward.y, feet: toward.feet };
  }
  if (!canAct) return { type: 'end', reason: 'no actions left' };
  return { type: 'end', reason: 'cannot reach anyone' };
}

// What should this monster do right now? Returns one of:
//   { type: 'attack', targetId, actionName, square? }
//   { type: 'move', x, y, feet }
//   { type: 'dash' }
//   { type: 'end', reason }
// turn is the tracker's current turn state (actionUsed, attacksLeft, movementLeft).
function nextMonsterStep(ctx) {
  const creature = ctx.catalog[ctx.token.creatureId];
  if (!creature) return { type: 'end', reason: 'no targets' };
  if (tactical(creature, ctx.token)) return tacticalStep(ctx);
  return weaponStep(ctx);
}

// The steps a proposal is allowed to pick. Attacks are every positive choice
// from this square. Move, dash, and end are only the tactician's own step.
function legalOptions(ctx) {
  const step = nextMonsterStep(ctx);
  return {
    step,
    attacks: attackChoices(ctx.token, ctx.tokens, ctx.catalog),
    moves: step.type === 'move' ? [{ x: step.x, y: step.y, feet: step.feet }] : [],
    dash: step.type === 'dash',
    end: step.type === 'end',
  };
}

// Plays out a whole monster turn one step at a time, asking the board for fresh
// state before each step so deaths and moves are always accounted for.
//   getTokens()           returns the current token list
//   performMove(token, step)    and    performAttack(token, step)
//                         must return { ok, error? } and update the board
//   pause()               returns a promise, used to slow things down for viewers
//   advise(ctx)           optional. May replace the first step. Later steps
//                         always come from nextMonsterStep.
async function runMonsterTurn({ token, getTokens, catalog, tracker, performMove, performAttack, performDash, pause, costOf, advise }) {
  let pending = null;
  if (typeof advise === 'function') {
    const tokens = getTokens();
    const self = tokens.find((entry) => entry.id === token.id);
    if (!self || self.defeated) return;
    try {
      pending = await advise({ token: self, tokens, catalog, turn: tracker.turn, costOf });
    } catch (err) {
      pending = null;
    }
  }

  for (let i = 0; i < MAX_STEPS; i++) {
    // Stop if combat ended or the turn moved on while we were waiting.
    if (!tracker.active || !tracker.turn || tracker.turn.tokenId !== token.id) return;

    const tokens = getTokens();
    const self = tokens.find((entry) => entry.id === token.id);
    if (!self || self.defeated) return;

    const step = pending || nextMonsterStep({ token: self, tokens, catalog, turn: tracker.turn, costOf });
    pending = null;
    if (!step || step.type === 'end') return;

    let result;
    if (step.type === 'move') result = performMove(self, step);
    else if (step.type === 'dash') result = performDash(self, step);
    else result = performAttack(self, step);
    if (!result.ok) return;

    await pause();
  }
}

module.exports = { nextMonsterStep, runMonsterTurn, usableActions, legalOptions, attackChoices };
