// Zones, concentration, conditions, bonus features, and the DM's undo stack.
// The server owns the board. This file only mutates the objects it is given.

const { GRID, feetBetween, insideRoom, areaSquares } = require('../public/rules.js');
const { rollD20, rollDice, rollDie } = require('./dice.js');
const { resolveAttack, resolveStrike, resolveSaveTarget, applyIncoming } = require('./attack.js');
const init = require('./initiative.js');

const HISTORY_LIMIT = 40;

function ensureToken(token) {
  if (!Array.isArray(token.conditions)) token.conditions = [];
  if (!Array.isArray(token.marks)) token.marks = [];
  if (!token.uses || typeof token.uses !== 'object') token.uses = {};
  return token;
}

function initUses(token, creature) {
  ensureToken(token);
  (creature.actions || []).forEach((action) => {
    const key = action.useKey || action.name;
    const max = action.pool != null ? action.pool : action.uses;
    if (max == null) return;
    const prior = token.uses[key];
    const bag = { left: max, max };
    const recharge = action.recharge != null ? action.recharge : prior && prior.recharge;
    if (recharge != null) bag.recharge = recharge;
    token.uses[key] = bag;
  });
}

function limitedUse(action) {
  return !!(action && (action.uses != null || action.pool != null || action.recharge != null));
}

// Reject a breath that is still spent. Features spend themselves in useFeature.
function hasUse(token, action) {
  if (!limitedUse(action)) return { ok: true };
  ensureToken(token);
  const key = action.useKey || action.name;
  const bag = token.uses[key];
  if (!bag || bag.left < 1) return { ok: false, error: `No uses of ${key} left.` };
  return { ok: true };
}

function takeUse(token, action) {
  if (!limitedUse(action)) return { ok: true };
  return spendUse(token, action.useKey || action.name, 1);
}

function snapshot(board) {
  if (!Array.isArray(board.history)) board.history = [];
  board.history.push({
    tokens: JSON.parse(JSON.stringify(board.tokens)),
    tracker: JSON.parse(JSON.stringify(board.tracker)),
    zones: JSON.parse(JSON.stringify(board.zones || [])),
    log: JSON.parse(JSON.stringify(board.log)),
    nextId: board.nextId,
    nextLogId: board.nextLogId,
    nextZoneId: board.nextZoneId || 1,
  });
  if (board.history.length > HISTORY_LIMIT) board.history.shift();
}

function undo(board) {
  const prev = board.history && board.history.pop();
  if (!prev) return { ok: false, error: 'Nothing to undo.' };
  board.tokens.splice(0, board.tokens.length, ...prev.tokens);
  Object.keys(board.tracker).forEach((key) => {
    delete board.tracker[key];
  });
  Object.assign(board.tracker, prev.tracker);
  if (!Array.isArray(board.zones)) board.zones = [];
  board.zones.splice(0, board.zones.length, ...prev.zones);
  board.log.splice(0, board.log.length, ...prev.log);
  board.nextId = prev.nextId;
  board.nextLogId = prev.nextLogId;
  board.nextZoneId = prev.nextZoneId;
  return { ok: true };
}

function tokenSquares(token) {
  const squares = [];
  const w = token.w || 1;
  const h = token.h || 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) squares.push({ x: token.x + dx, y: token.y + dy });
  }
  return squares;
}

function sameSquare(a, b) {
  return a.x === b.x && a.y === b.y;
}

// Spirit squares follow the caster. A stored list is only a snapshot for other zones.
function spiritArea(zone) {
  return { type: 'radius', size: zone.radius || 15, origin: 'self' };
}

function spiritCaster(zone, tokens) {
  return (tokens || []).find((token) => token.id === (zone.anchor || zone.casterId)) || null;
}

function spiritSquares(zone, tokens) {
  const caster = spiritCaster(zone, tokens);
  if (!caster) return [];
  return areaSquares(caster, caster, spiritArea(zone));
}

function zoneSquares(zone, tokens) {
  if (!zone) return [];
  if (zone.kind === 'spirit') return spiritSquares(zone, tokens);
  return zone.squares || [];
}

function zoneHas(zone, square, tokens) {
  return zoneSquares(zone, tokens).some((cell) => sameSquare(cell, square));
}

function coversToken(zone, token, tokens) {
  return tokenSquares(token).some((square) => zoneHas(zone, square, tokens));
}

function spiritAffects(zone, token, tokens) {
  if (!zone || zone.kind !== 'spirit' || !token) return false;
  if (token.id === zone.casterId || token.id === zone.anchor) return false;
  const caster = spiritCaster(zone, tokens);
  const team = zone.team || (caster && caster.team);
  if (team && token.team === team) return false;
  return true;
}

function webSquare(zones, x, y) {
  return (zones || []).some((zone) => zone.kind === 'web' && zoneHas(zone, { x, y }));
}

function spiritSquare(zones, token, x, y, tokens) {
  return (zones || []).some((zone) => {
    return spiritAffects(zone, token, tokens) && zoneHas(zone, { x, y }, tokens);
  });
}

// Each step of the corner's path. Web and an enemy spirit ring each make that
// step cost 10 feet, and a square that is both still costs 10, not 20.
function movementCost(token, x, y, zones, tokens) {
  const steps = Math.max(Math.abs(x - token.x), Math.abs(y - token.y));
  let cost = 0;
  for (let i = 1; i <= steps; i++) {
    const sx = Math.round(token.x + ((x - token.x) * i) / steps);
    const sy = Math.round(token.y + ((y - token.y) * i) / steps);
    const difficult = webSquare(zones, sx, sy) || spiritSquare(zones, token, sx, sy, tokens);
    cost += difficult ? 10 : GRID.feetPerSquare;
  }
  return cost;
}

function named(creature, name) {
  const list = [].concat((creature && creature.features) || [], (creature && creature.traits) || []);
  return list.some((entry) => entry && entry.name === name);
}

function addCondition(token, name, meta) {
  ensureToken(token);
  token.marks.push(Object.assign({ name }, meta || {}));
  if (name && !token.conditions.includes(name)) token.conditions.push(name);
}

function dropMarks(token, pred) {
  ensureToken(token);
  const dropped = [];
  token.marks = token.marks.filter((mark) => {
    if (!pred(mark)) return true;
    dropped.push(mark);
    return false;
  });
  dropped.forEach((mark) => {
    if (!mark.name || mark.name === 'command' || mark.name === 'bardic' || mark.name === 'concentration') return;
    if (mark.name === 'dodging' || mark.name === 'disengaged' || mark.name === 'steady-aim') return;
    const still = token.marks.some((other) => other.name === mark.name);
    if (!still) token.conditions = token.conditions.filter((condition) => condition !== mark.name);
  });
}

function endConcentration(board, casterId, lines) {
  const caster = board.tokens.find((token) => token.id === casterId);
  if (!caster) return;
  ensureToken(caster);
  const mark = caster.marks.find((entry) => entry.name === 'concentration');
  if (!mark) return;
  const spell = mark.spell;
  dropMarks(caster, (entry) => entry.name === 'concentration');
  (board.zones || []).slice().forEach((zone) => {
    if (zone.casterId === casterId && zone.concentration) removeZone(board, zone.id, []);
  });
  board.tokens.forEach((token) => {
    dropMarks(token, (entry) => entry.concentration && entry.casterId === casterId);
  });
  if (lines) lines.push(`${caster.name}'s concentration on ${spell} ends.`);
}

function saveBonus(creature, ability) {
  const score = creature.abilities && creature.abilities[ability];
  const mod = Math.floor(((score == null ? 10 : score) - 10) / 2);
  const proficient = creature.saves && creature.saves[ability];
  return mod + (proficient ? creature.proficiency || 0 : 0);
}

function concentrationCheck(board, catalog, token, lost, lines) {
  if (lost <= 0) return;
  ensureToken(token);
  if (!token.marks.some((mark) => mark.name === 'concentration')) return;
  const creature = catalog[token.creatureId];
  const dc = Math.max(10, Math.floor(lost / 2));
  const mode = named(creature, 'War Caster') || named(creature, 'Eldritch Mind') ? 'advantage' : 'normal';
  const bonus = saveBonus(creature, 'con');
  const die = rollD20(mode);
  const total = die.roll + bonus;
  const rollsText = die.rolls.length > 1 ? `rolled ${die.rolls.join(' and ')}, took ${die.roll}` : `rolled ${die.roll}`;
  const how = mode === 'normal' ? '' : ` (${mode})`;
  let totalShown = total;
  const bardic = (token.marks || []).find((mark) => mark.name === 'bardic');
  let kept = total >= dc;
  if (!kept && die.roll !== 1 && bardic) {
    const inspiration = rollDice(bardic.die || '1d6', false);
    totalShown = total + Math.max(0, inspiration.total);
    kept = totalShown >= dc;
    const index = token.marks.findIndex((mark) => mark.name === 'bardic');
    if (index !== -1) token.marks.splice(index, 1);
    lines.push(`Bardic Inspiration ${bardic.die || '1d6'} [${inspiration.dice.join(', ')}] = ${inspiration.total}.`);
  }
  lines.push(
    `${token.name} Constitution save${how} to keep concentration: ${rollsText}. ${die.roll} ${bonus >= 0 ? '+' : ''}${bonus} = ${totalShown} vs DC ${dc}: ${kept ? 'success' : 'failure'}.`
  );
  if (!kept) endConcentration(board, token.id, lines);
}

function igniteSquares(board, squares) {
  (board.zones || []).forEach((zone) => {
    if (zone.kind !== 'web') return;
    squares.forEach((square) => {
      if (!zoneHas(zone, square)) return;
      if ((zone.burning || []).some((cell) => sameSquare(cell, square))) return;
      if (!zone.burning) zone.burning = [];
      zone.burning.push({ x: square.x, y: square.y });
    });
  });
}

function actionHasFire(action) {
  return (action.damage || []).some((entry) => entry.type === 'fire');
}

function extendRage(attacker) {
  ensureToken(attacker);
  const mark = attacker.marks.find((entry) => entry.name === 'raging');
  if (!mark) return;
  mark.hold = Math.max(mark.hold || 0, 2);
}

function placeZone(board, attacker, action, result) {
  const spirit = result.zone === 'spirit';
  if (!spirit && !(result.zone && result.squares && result.squares.length)) return null;
  const part = (action.damage || [])[0];
  const zone = {
    id: board.nextZoneId++,
    kind: result.zone,
    squares: spirit ? [] : result.squares.map((square) => ({ x: square.x, y: square.y })),
    casterId: attacker.id,
    spell: action.name,
    saveDc: action.saveDc,
    saveAbility: action.saveAbility || (spirit ? 'wis' : 'dex'),
    concentration: !!action.concentration,
    burn: action.burn || null,
    burning: [],
    roundsLeft: action.durationRounds || null,
  };
  if (spirit) {
    zone.anchor = attacker.id;
    zone.team = attacker.team;
    zone.radius = (action.area && action.area.size) || 15;
    zone.damage = (part && part.dice) || '3d8';
    zone.damageType = result.damageType || (part && part.type) || 'radiant';
    zone.saved = (result.targets || []).map((entry) => entry.id);
  }
  board.zones.push(zone);
  return zone;
}

function applyAttack(board, catalog, attacker, action, result) {
  const lines = (result.dm || []).slice();
  ensureToken(attacker);
  if (!board.nextZoneId) board.nextZoneId = 1;
  if (!Array.isArray(board.zones)) board.zones = [];

  if (action.concentration) {
    const previous = attacker.marks.find((mark) => mark.name === 'concentration');
    if (previous) endConcentration(board, attacker.id, lines);
    const zone = placeZone(board, attacker, action, result);
    attacker.marks.push({
      name: 'concentration',
      spell: action.name,
      zoneId: zone ? zone.id : null,
      saveDc: action.saveDc,
      saveAbility: action.saveAbility,
      roundsLeft: action.durationRounds || null,
    });
  } else if (result.zone) {
    placeZone(board, attacker, action, result);
  }

  const zone = (board.zones || []).filter((entry) => entry.casterId === attacker.id).slice(-1)[0];
  (result.targets || []).forEach((entry) => {
    const token = board.tokens.find((item) => item.id === entry.id);
    if (!token) return;
    ensureToken(token);
    const before = token.hp;
    token.hp = entry.hpAfter;
    token.defeated = entry.defeated;
    if (entry.bardicSpent) {
      const index = token.marks.findIndex((mark) => mark.name === 'bardic');
      if (index !== -1) token.marks.splice(index, 1);
    }
    if (entry.attackerBardic) {
      const index = attacker.marks.findIndex((mark) => mark.name === 'bardic');
      if (index !== -1) attacker.marks.splice(index, 1);
    }
    if (entry.steadySpent) dropMarks(attacker, (mark) => mark.name === 'steady-aim');
    (entry.conditions || []).forEach((name) => {
      addCondition(token, name, {
        casterId: attacker.id,
        spell: action.name,
        concentration: !!action.concentration,
        saveDc: action.saveDc,
        saveAbility: action.saveAbility,
        zoneId: zone && (name === 'restrained' || name === 'prone') ? zone.id : null,
      });
    });
    if (entry.command) {
      token.marks.push({ name: 'command', word: entry.command, casterId: attacker.id });
    }
    const lost = Math.max(0, before - token.hp);
    if (lost > 0) concentrationCheck(board, catalog, token, lost, lines);
    if ((entry.damageTypes || []).includes('fire')) igniteSquares(board, tokenSquares(token));
  });

  if (result.squares && actionHasFire(action) && !action.zone) igniteSquares(board, result.squares);

  const swung = (result.targets || []).some((entry) => {
    const token = board.tokens.find((item) => item.id === entry.id);
    return token && token.team !== attacker.team;
  });
  if (swung && result.ok && !result.error) extendRage(attacker);

  let pub = result.pub || '';
  if (lines.some((line) => line.indexOf('concentration on') !== -1 && line.indexOf('ends') !== -1)) {
    pub = `${pub} Concentration ends.`.trim();
  }
  return { lines, pub };
}

function abilityMod(creature, ability) {
  const score = creature.abilities && creature.abilities[ability];
  return Math.floor(((score == null ? 10 : score) - 10) / 2);
}

function fitsAt(tokens, token, x, y) {
  const w = token.w || 1;
  const h = token.h || 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (!insideRoom(x + dx, y + dy)) return false;
    }
  }
  return !tokens.some((other) => {
    if (other.id === token.id || other.defeated) return false;
    const ow = other.w || 1;
    const oh = other.h || 1;
    return x < other.x + ow && other.x < x + w && y < other.y + oh && other.y < y + h;
  });
}

function pickSquare(board, token, caster, toward, movementLeft) {
  const radius = Math.floor(movementLeft / GRID.feetPerSquare);
  let best = null;
  for (let x = token.x - radius; x <= token.x + radius; x++) {
    for (let y = token.y - radius; y <= token.y + radius; y++) {
      if (!fitsAt(board.tokens, token, x, y)) continue;
      const cost = movementCost(token, x, y, board.zones, board.tokens);
      if (cost > movementLeft) continue;
      const spot = { x, y, w: token.w || 1, h: token.h || 1 };
      const distance = caster ? feetBetween(spot, caster) : 0;
      const candidate = { x, y, cost, distance };
      if (!best) {
        best = candidate;
        continue;
      }
      if (toward) {
        const bestClose = best.distance <= 5;
        const nextClose = distance <= 5;
        if (nextClose && !bestClose) best = candidate;
        else if (nextClose === bestClose && (nextClose ? candidate.cost < best.cost : distance < best.distance)) {
          best = candidate;
        }
      } else if (distance > best.distance || (distance === best.distance && candidate.cost < best.cost)) {
        best = candidate;
      }
    }
  }
  return best;
}

function commandTurn(board, catalog, token) {
  ensureToken(token);
  const mark = token.marks.find((entry) => entry.name === 'command');
  if (!mark) return null;
  const word = mark.word;
  const caster = board.tokens.find((entry) => entry.id === mark.casterId);
  dropMarks(token, (entry) => entry.name === 'command' && entry.word === word);
  const lines = [`${token.name} must ${word}.`];
  const turn = board.tracker.turn;

  if (word === 'Halt') {
    lines.push(`${token.name} does nothing.`);
    return { ended: true, lines };
  }
  if (word === 'Grovel') {
    addCondition(token, 'prone', { source: 'grovel' });
    lines.push(`${token.name} falls prone.`);
    return { ended: true, lines };
  }
  if (word === 'Drop') {
    lines.push(`${token.name} drops whatever it is holding.`);
    return { ended: true, lines };
  }

  const creature = catalog[token.creatureId];
  const speed = init.speedNow(creature, token);
  if (turn && speed > 0 && !turn.actionUsed) {
    turn.actionUsed = true;
    turn.attacksLeft = 0;
    turn.movementLeft += speed;
    turn.dashed = true;
    lines.push(`${token.name} dashes.`);
  }
  const left = turn ? turn.movementLeft : 0;
  const spot = caster ? pickSquare(board, token, caster, word === 'Approach', left) : null;
  if (spot && (spot.x !== token.x || spot.y !== token.y)) {
    const from = { x: token.x, y: token.y };
    if (turn) turn.movementLeft -= spot.cost;
    token.x = spot.x;
    token.y = spot.y;
    lines.push.apply(lines, enterZones(board, catalog, token, from));
  }
  if (word === 'Flee') lines.push(`${token.name} flees.`);
  else lines.push(caster ? `${token.name} approaches ${caster.name}.` : `${token.name} has nowhere to go.`);
  return { ended: true, lines };
}

function spiritSave(board, catalog, token, zone, lines) {
  if (!token || token.defeated) return;
  if (!spiritAffects(zone, token, board.tokens)) return;
  if (!zone.saved) zone.saved = [];
  if (zone.saved.indexOf(token.id) !== -1) return;
  const creature = catalog[token.creatureId];
  if (!creature) return;
  zone.saved.push(token.id);

  const caster = board.tokens.find((entry) => entry.id === zone.casterId) || { name: zone.spell, id: zone.casterId };
  const type = zone.damageType || 'radiant';
  const dice = zone.damage || '3d8';
  const rolled = rollDice(dice, false);
  const amount = Math.max(0, rolled.total);
  const action = {
    name: zone.spell || 'Spirit Guardians',
    kind: 'spell',
    saveAbility: zone.saveAbility || 'wis',
    saveDc: zone.saveDc,
    onSave: 'half',
    damage: [{ dice, type }],
    conditions: [],
  };
  const raw = {
    rolled: [{ type, amount, text: `${dice} [${rolled.dice.join(', ')}] = ${amount} ${type}` }],
    byType: {},
  };
  raw.byType[type] = amount;
  lines.push(raw.rolled[0].text);
  const saved = resolveSaveTarget(caster, token, action, creature, raw);
  lines.push.apply(lines, saved.lines);
  if (saved.entry && saved.entry.bardicSpent) {
    const index = token.marks.findIndex((mark) => mark.name === 'bardic');
    if (index !== -1) token.marks.splice(index, 1);
  }
  const before = token.hp;
  token.hp = saved.entry.hpAfter;
  token.defeated = saved.entry.defeated;
  const lost = Math.max(0, before - token.hp);
  if (lost > 0) concentrationCheck(board, catalog, token, lost, lines);
}

function zoneSave(board, catalog, token, zone, lines) {
  const creature = catalog[token.creatureId];
  const caster = board.tokens.find((entry) => entry.id === zone.casterId);
  const action = {
    name: zone.spell,
    kind: 'spell',
    saveAbility: zone.saveAbility || 'dex',
    saveDc: zone.saveDc,
    onSave: 'none',
    damage: [],
    conditions: zone.kind === 'web' ? ['restrained'] : ['prone'],
  };
  const raw = { rolled: [], byType: {} };
  const saved = resolveSaveTarget(caster || { name: zone.spell, id: zone.casterId }, token, action, creature, raw);
  lines.push.apply(lines, saved.lines);
  if (saved.entry && saved.entry.bardicSpent) {
    const index = token.marks.findIndex((mark) => mark.name === 'bardic');
    if (index !== -1) token.marks.splice(index, 1);
  }
  if (saved.failed) {
    const name = zone.kind === 'web' ? 'restrained' : 'prone';
    if (zone.kind === 'web') {
      dropMarks(token, (mark) => mark.name === 'restrained' && mark.zoneId === zone.id);
    }
    addCondition(token, name, {
      casterId: zone.casterId,
      spell: zone.spell,
      concentration: !!zone.concentration,
      saveDc: zone.saveDc,
      saveAbility: zone.saveAbility,
      zoneId: zone.id,
    });
  } else if (zone.kind === 'web') {
    dropMarks(token, (mark) => mark.name === 'restrained' && mark.zoneId === zone.id);
  }
}

function burnTick(board, catalog, lines) {
  (board.zones || []).slice().forEach((zone) => {
    if (!zone.burning || zone.burning.length === 0) return;
    const dice = (zone.burn && zone.burn.dice) || '2d4';
    const type = (zone.burn && zone.burn.type) || 'fire';
    board.tokens.forEach((token) => {
      if (token.defeated) return;
      const inside = tokenSquares(token).some((square) => zone.burning.some((cell) => sameSquare(cell, square)));
      if (!inside) return;
      const rolled = rollDice(dice, false);
      const amount = Math.max(0, rolled.total);
      const creature = catalog[token.creatureId];
      const dealt = applyIncoming(token, creature, { [type]: amount });
      const before = token.hp;
      token.hp = dealt.hpAfter;
      token.defeated = token.hp === 0;
      lines.push(
        `The burning web deals ${dice} [${rolled.dice.join(', ')}] = ${amount} ${type} to ${token.name}. ${token.name}: ${before} to ${token.hp} HP.`
      );
      const lost = Math.max(0, before - token.hp);
      if (lost > 0) concentrationCheck(board, catalog, token, lost, lines);
    });
    zone.squares = zone.squares.filter((square) => !zone.burning.some((cell) => sameSquare(cell, square)));
    zone.burning = [];
    board.tokens.forEach((token) => {
      if (!coversToken(zone, token)) {
        dropMarks(token, (mark) => mark.zoneId === zone.id && mark.name === 'restrained');
      }
    });
    if (zone.squares.length === 0) removeZone(board, zone.id, lines);
  });
}

function onTurnEnd(board, catalog, token) {
  if (!token) return [];
  ensureToken(token);
  const lines = [];
  (board.zones || []).forEach((zone) => {
    if (zone.kind !== 'spirit') return;
    if (!coversToken(zone, token, board.tokens)) return;
    spiritSave(board, catalog, token, zone, lines);
  });
  const slowed = token.marks.filter((mark) => mark.name === 'slowed');
  slowed.forEach((mark) => {
    const creature = catalog[token.creatureId];
    const caster = board.tokens.find((entry) => entry.id === mark.casterId);
    const action = {
      name: mark.spell || 'Slow',
      kind: 'spell',
      saveAbility: mark.saveAbility || 'wis',
      saveDc: mark.saveDc,
      onSave: 'none',
      damage: [],
      conditions: [],
    };
    const saved = resolveSaveTarget(caster || token, token, action, creature, { rolled: [], byType: {} });
    lines.push.apply(lines, saved.lines);
    if (!saved.failed) {
      dropMarks(token, (entry) => entry.name === 'slowed' && entry.casterId === mark.casterId);
      lines.push(`${token.name} is no longer slowed.`);
    }
    if (saved.entry && saved.entry.bardicSpent) {
      const index = token.marks.findIndex((entry) => entry.name === 'bardic');
      if (index !== -1) token.marks.splice(index, 1);
    }
  });
  dropMarks(token, (mark) => mark.name === 'steady-aim' || mark.name === 'disengaged');
  const rage = token.marks.find((mark) => mark.name === 'raging');
  if (rage) {
    rage.hold = (rage.hold || 1) - 1;
    if (rage.hold <= 0) {
      dropMarks(token, (mark) => mark.name === 'raging');
      lines.push(`${token.name} is no longer raging.`);
    }
  }
  const concentration = token.marks.find((mark) => mark.name === 'concentration');
  if (concentration && concentration.roundsLeft != null) {
    concentration.roundsLeft -= 1;
    (board.zones || []).forEach((zone) => {
      if (zone.id === concentration.zoneId && zone.roundsLeft != null) zone.roundsLeft -= 1;
    });
    if (concentration.roundsLeft <= 0) endConcentration(board, token.id, lines);
  }
  return lines;
}

function onTurnStart(board, catalog, token) {
  if (!token) return { ended: false, lines: [] };
  ensureToken(token);
  const lines = [];
  (board.zones || []).forEach((zone) => {
    if (zone.kind === 'spirit') zone.saved = [];
  });
  dropMarks(token, (mark) => mark.name === 'dodging');
  burnTick(board, catalog, lines);
  (board.zones || []).slice().forEach((zone) => {
    if (zone.kind === 'web' && coversToken(zone, token)) zoneSave(board, catalog, token, zone, lines);
  });
  const creature = catalog[token.creatureId];
  if (board.tracker.turn && board.tracker.turn.tokenId === token.id) {
    board.tracker.turn.movementLeft = init.speedNow(creature, token);
  }
  rechargeUses(token, lines);
  const commanded = commandTurn(board, catalog, token);
  if (commanded) {
    lines.push.apply(lines, commanded.lines);
    return { ended: true, lines };
  }
  return { ended: false, lines };
}

function spiritFollow(board, catalog, mover, from, lines) {
  const oldCaster = Object.assign({}, mover, { x: from.x, y: from.y });
  (board.zones || []).forEach((zone) => {
    if (zone.kind !== 'spirit') return;
    if (zone.anchor !== mover.id && zone.casterId !== mover.id) return;
    const oldSquares = areaSquares(oldCaster, oldCaster, spiritArea(zone));
    const nextSquares = spiritSquares(zone, board.tokens);
    board.tokens.forEach((other) => {
      if (other.id === mover.id || other.defeated) return;
      if (!spiritAffects(zone, other, board.tokens)) return;
      const was = tokenSquares(other).some((square) => oldSquares.some((cell) => sameSquare(cell, square)));
      const now = tokenSquares(other).some((square) => nextSquares.some((cell) => sameSquare(cell, square)));
      if (!was && now) spiritSave(board, catalog, other, zone, lines);
    });
  });
}

function enterZones(board, catalog, token, from) {
  const lines = [];
  const before = Object.assign({}, token, from);
  (board.zones || []).slice().forEach((zone) => {
    const was = coversToken(zone, before, board.tokens);
    const now = coversToken(zone, token, board.tokens);
    if (was && !now && zone.kind === 'web') {
      const had = token.marks.some((mark) => mark.name === 'restrained' && mark.zoneId === zone.id);
      dropMarks(token, (mark) => mark.name === 'restrained' && mark.zoneId === zone.id);
      if (had) lines.push(`${token.name} leaves the web and is no longer restrained.`);
    }
    if (!was && now) {
      if (zone.kind === 'spirit') spiritSave(board, catalog, token, zone, lines);
      else zoneSave(board, catalog, token, zone, lines);
    }
  });
  spiritFollow(board, catalog, token, from, lines);
  return lines;
}

// A spent recharge comes back on a d6. A full pool does not roll.
function rechargeUses(token, lines) {
  ensureToken(token);
  Object.keys(token.uses).forEach((key) => {
    const bag = token.uses[key];
    if (!bag || bag.recharge == null || bag.left >= bag.max) return;
    const die = rollDie(6);
    if (die >= bag.recharge) {
      bag.left = bag.max;
      lines.push(`${token.name} recharges ${key} (${die} on the d6).`);
    } else {
      lines.push(`${token.name} does not recharge ${key} (${die} on the d6).`);
    }
  });
}

function spendUse(token, key, amount) {
  const bag = token.uses && token.uses[key];
  if (!bag) return { ok: false, error: `No uses of ${key} left.` };
  if (bag.left < amount) return { ok: false, error: `No uses of ${key} left.` };
  bag.left -= amount;
  return { ok: true };
}

function healToken(token, amount, lines, label) {
  const before = token.hp;
  const next = token.maxHp == null ? before + amount : Math.min(token.maxHp, before + amount);
  token.hp = Math.max(0, next);
  if (token.hp > 0) token.defeated = false;
  const lead = label ? `${label} ` : '';
  lines.push(`${lead}${token.name} regains ${token.hp - before} HP (${before} to ${token.hp}).`);
}

function useFeature(board, catalog, attacker, action, options) {
  options = options || {};
  ensureToken(attacker);
  const creature = catalog[attacker.creatureId];
  const target = options.target || null;
  const check = init.checkAttack(board.tracker, attacker.id, action, attacker);
  if (!check.ok) return check;
  if ((attacker.conditions || []).includes('raging') && action.kind === 'spell') {
    return { ok: false, error: `${attacker.name} is raging and cannot cast a spell.` };
  }

  const profile = action.profile || 'log';
  const key = action.useKey || action.name;
  const lines = [];
  const needs = {
    'lay-on-hands': true,
    'remove-poison': true,
    bardic: true,
    flurry: true,
  };

  if (needs[profile]) {
    if (!target || target.id === attacker.id) return { ok: false, error: `${action.name} needs another creature.` };
    if (target.defeated) return { ok: false, error: `${target.name} is already defeated.` };
    if (feetBetween(attacker, target) > (profile === 'bardic' ? 60 : 5)) {
      return { ok: false, error: `${target.name} is out of reach.` };
    }
  }
  if (profile === 'bardic' && target.team !== attacker.team) {
    return { ok: false, error: 'Bardic Inspiration goes to an ally.' };
  }
  if (profile === 'flurry' && target.team === attacker.team) {
    return { ok: false, error: 'Flurry of Blows needs an enemy.' };
  }
  if (profile === 'steady-aim' && board.tracker.active && board.tracker.turn && board.tracker.turn.moved) {
    return { ok: false, error: 'Steady Aim cannot be used after moving.' };
  }

  if (profile === 'bardic' && target.marks && target.marks.some((mark) => mark.name === 'bardic')) {
    return { ok: false, error: `${target.name} is already holding Bardic Inspiration.` };
  }
  let useCost = 0;
  if (profile === 'lay-on-hands') {
    const amount = Math.floor(Number(options.amount));
    if (!amount || amount < 1) return { ok: false, error: 'Choose how many hit points to restore.' };
    useCost = amount;
  } else if (profile === 'remove-poison') {
    useCost = 5;
  } else if (action.uses != null || action.pool != null) {
    useCost = 1;
  }
  if (useCost > 0) {
    const bag = attacker.uses && attacker.uses[key];
    if (!bag || bag.left < useCost) return { ok: false, error: `No uses of ${key} left.` };
  }

  snapshot(board);
  if (useCost > 0) spendUse(attacker, key, useCost);
  const spentTurn = init.spendAttack(board.tracker, attacker.id, creature, action, attacker);
  if (!spentTurn.ok) {
    undo(board);
    return spentTurn;
  }

  if (profile === 'dash' || profile === 'step') {
    const speed = init.speedNow(creature, attacker);
    if (board.tracker.turn && board.tracker.turn.tokenId === attacker.id) {
      board.tracker.turn.movementLeft += speed;
      if ((action.activation || 'action') === 'action') board.tracker.turn.dashed = true;
    }
    lines.push(`${attacker.name} dashes and gains ${speed} ft of movement.`);
  }
  if (profile === 'disengage' || profile === 'step') {
    attacker.marks.push({ name: 'disengaged' });
    lines.push(`${attacker.name} disengages.`);
  }
  if (profile === 'hide') {
    lines.push(`${attacker.name} looks for cover, but the open map has nowhere to hide.`);
  }
  if (profile === 'steady-aim') {
    if (board.tracker.turn && board.tracker.turn.tokenId === attacker.id) board.tracker.turn.movementLeft = 0;
    attacker.marks.push({ name: 'steady-aim' });
    lines.push(`${attacker.name} takes Steady Aim. The next attack this turn has advantage, and movement drops to 0.`);
  }
  if (profile === 'rage') {
    endConcentration(board, attacker.id, lines);
    dropMarks(attacker, (mark) => mark.name === 'raging');
    attacker.conditions = attacker.conditions.filter((condition) => condition !== 'raging');
    addCondition(attacker, 'raging', { damage: action.rageDamage || 2, hold: 2 });
    lines.push(`${attacker.name} rages. Bludgeoning, piercing, and slashing damage is halved, and Strength attacks deal +${action.rageDamage || 2}.`);
  }
  if (profile === 'patient-defense') {
    dropMarks(attacker, (mark) => mark.name === 'dodging');
    attacker.marks.push({ name: 'dodging' });
    lines.push(`Attacks against ${attacker.name} have disadvantage until ${attacker.name}'s next turn.`);
  }
  if (profile === 'flurry') {
    const mod = Math.max(abilityMod(creature, 'str'), abilityMod(creature, 'dex'));
    const strike = {
      name: 'Unarmed Strike',
      kind: 'attack',
      reach: 5,
      toHit: mod + (creature.proficiency || 0),
      damage: [{ dice: action.strike || '1d6', type: 'bludgeoning' }],
    };
    let hp = target.hp;
    for (let i = 0; i < (action.rays || 2); i++) {
      if (hp <= 0) break;
      const view = Object.assign({}, target, { hp });
      const result = resolveStrike({
        attacker,
        attackerCreature: creature,
        target: view,
        targetCreature: catalog[target.creatureId],
        action: strike,
        tokens: board.tokens,
        skipRange: false,
      });
      if (!result.ok) {
        lines.push(result.error);
        break;
      }
      lines.push.apply(lines, result.dm);
      target.hp = result.hpAfter;
      target.defeated = result.defeated;
      hp = result.hpAfter;
      if (result.hit) extendRage(attacker);
    }
  }
  if (profile === 'bardic') {
    ensureToken(target);
    target.marks.push({ name: 'bardic', die: action.bardic || '1d6' });
    lines.push(`${attacker.name} gives ${target.name} ${action.bardic || 'a die of'} Bardic Inspiration.`);
  }
  if (profile === 'remove-poison') {
    ensureToken(target);
    target.conditions = target.conditions.filter((condition) => condition !== 'poisoned');
    dropMarks(target, (mark) => mark.name === 'poisoned');
    lines.push(`${attacker.name} touches ${target.name} and ends the poisoned condition.`);
  }
  if (profile === 'lay-on-hands') {
    healToken(target, Math.floor(Number(options.amount)), lines, `${attacker.name} lays on hands.`);
  }
  if (profile === 'action-surge') {
    if (board.tracker.turn && board.tracker.turn.tokenId === attacker.id) board.tracker.turn.extraAction = true;
    lines.push(`${attacker.name} uses Action Surge and can take another action.`);
  }
  if (profile === 'second-wind' || (action.kind === 'heal' && action.heal && profile !== 'lay-on-hands')) {
    const rolled = rollDice(action.heal, false);
    lines.push(`${action.name} ${action.heal} [${rolled.dice.join(', ')}] = ${rolled.total}.`);
    healToken(attacker, Math.max(0, rolled.total), lines, '');
  }
  if (profile === 'log' && action.kind !== 'heal') {
    lines.push(`${attacker.name} uses ${action.name}. ${action.logText || ''}`.trim());
  }

  const pub = lines[0] || `${attacker.name} uses ${action.name}.`;
  return { ok: true, lines, pub };
}

function setHp(board, token, value) {
  const hp = Math.floor(Number(value));
  if (!Number.isFinite(hp)) return { ok: false, error: 'Enter a number of hit points.' };
  const max = token.maxHp == null ? hp : token.maxHp;
  if (hp < 0 || hp > max) return { ok: false, error: `Hit points must be from 0 to ${max}.` };
  snapshot(board);
  const before = token.hp;
  token.hp = hp;
  token.defeated = hp === 0;
  const line = `${token.name}: ${before} to ${hp} HP.`;
  return { ok: true, lines: [line], pub: line };
}

function breakFree(board, catalog, token) {
  ensureToken(token);
  const zones = (board.zones || []).filter((zone) => zone.kind === 'web' && coversToken(zone, token));
  const held = token.marks.some((mark) => mark.name === 'restrained' && zones.some((zone) => zone.id === mark.zoneId));
  if (!zones.length || !held) return { ok: false, error: `${token.name} is not restrained by a web.` };
  const creature = catalog[token.creatureId];
  const action = { name: 'Break free', activation: 'action', kind: 'feature', profile: 'log' };
  const check = init.checkAttack(board.tracker, token.id, action, token);
  if (!check.ok) return check;
  snapshot(board);
  init.spendAttack(board.tracker, token.id, creature, action, token);
  const bonus = abilityMod(creature, 'str');
  const die = rollD20('normal');
  const total = die.roll + bonus;
  const lines = [];
  zones.forEach((zone) => {
    const freed = total >= zone.saveDc;
    lines.push(
      `${token.name} tries to break free: rolled ${die.roll}. ${die.roll} ${bonus >= 0 ? '+' : ''}${bonus} = ${total} vs DC ${zone.saveDc}: ${freed ? 'success' : 'failure'}.`
    );
    if (freed) {
      dropMarks(token, (mark) => mark.name === 'restrained' && mark.zoneId === zone.id);
      lines.push(`${token.name} is no longer restrained.`);
    }
  });
  return { ok: true, lines, pub: lines[0] };
}

function restoreUse(board, token, key) {
  ensureToken(token);
  const bag = token.uses[key];
  if (!bag) return { ok: false, error: 'That does not have uses.' };
  if (bag.left >= bag.max) return { ok: false, error: 'Those uses are already full.' };
  snapshot(board);
  bag.left += 1;
  const line = `${token.name} regains one use of ${key} (${bag.left}/${bag.max}).`;
  return { ok: true, lines: [line], pub: line };
}

function releaseCaster(board, casterId, lines) {
  endConcentration(board, casterId, lines || []);
  (board.zones || []).slice().forEach((zone) => {
    if (zone.casterId === casterId || zone.anchor === casterId) removeZone(board, zone.id, lines || []);
  });
}

function removeZone(board, zoneId, lines) {
  const zone = (board.zones || []).find((entry) => entry.id === zoneId);
  if (!zone) return { ok: false, error: 'That zone is already gone.' };
  const caster = board.tokens.find((token) => token.id === zone.casterId);
  const ends = !!(caster && zone.concentration && (caster.marks || []).some((entry) => {
    return entry.name === 'concentration' && entry.zoneId === zoneId;
  }));
  board.zones = board.zones.filter((entry) => entry.id !== zoneId);
  // Leave the concentration mark. Ending the spell drops it, and dropping it
  // first would hide the fact that this zone was the spell.
  board.tokens.forEach((token) => {
    dropMarks(token, (mark) => mark.zoneId === zoneId && mark.name !== 'concentration');
  });
  if (ends) endConcentration(board, caster.id, lines || []);
  if (lines) lines.push(`${zone.spell} leaves the battlefield.`);
  return { ok: true, lines: [`${zone.spell} leaves the battlefield.`], pub: `${zone.spell} is gone.` };
}

module.exports = {
  initUses,
  hasUse,
  takeUse,
  snapshot,
  undo,
  movementCost,
  zoneSquares,
  applyAttack,
  onTurnStart,
  onTurnEnd,
  enterZones,
  useFeature,
  setHp,
  breakFree,
  restoreUse,
  removeZone,
  releaseCaster,
  endConcentration,
};
