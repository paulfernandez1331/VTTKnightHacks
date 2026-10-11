const { feetBetween, insideRoom, areaSquares, tokenCaught, coversSquare } = require('../public/rules.js');
const { rollDice, rollD20 } = require('./dice.js');
const { collectMods } = require('./mods.js');

const ABILITIES = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

// These four make Strength and Dexterity saves fail, and they grant advantage to attackers.
const HELPLESS = ['paralyzed', 'stunned', 'unconscious', 'petrified'];
// The creature's own attack rolls fail. The helpless list counts as incapacitated too.
const CANNOT_ACT = HELPLESS.concat(['incapacitated']);
const ATTACK_DISADVANTAGE = ['poisoned', 'frightened', 'restrained'];

function abilityMod(creature, ability) {
  const score = creature.abilities && creature.abilities[ability];
  return Math.floor(((score == null ? 10 : score) - 10) / 2);
}

function abilityName(ability) {
  return ABILITIES[ability] || ability;
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

function fail(error) {
  return { ok: false, error };
}

function matching(token, names) {
  const present = token.conditions || [];
  return names.filter((name) => present.includes(name));
}

function saveBonus(creature, ability) {
  const mod = abilityMod(creature, ability);
  const proficient = creature.saves && creature.saves[ability];
  return mod + (proficient ? creature.proficiency || 0 : 0);
}

// Monk, Rogue, and Assassin all store this under the name Evasion.
function hasEvasion(creature) {
  const listed = [].concat(creature.features || [], creature.traits || []);
  return listed.some((entry) => entry && entry.name === 'Evasion');
}

// Dexterity save for half only. Incapacitated creatures cannot use the feature.
function evasionApplies(token, creature, ability, onSave) {
  if (ability !== 'dex' || onSave !== 'half') return false;
  if (matching(token, CANNOT_ACT).length > 0) return false;
  return hasEvasion(creature);
}

function reachLimit(action) {
  const reach = action.reach || 0;
  const range = action.range ? action.range.long : 0;
  return Math.max(reach, range);
}

// Finesse takes the better of STR or DEX, ranged weapons use DEX,
// and everything else uses STR.
function weaponAbility(creature, action) {
  const props = action.properties || [];
  if (props.includes('finesse')) {
    return abilityMod(creature, 'dex') > abilityMod(creature, 'str') ? 'dex' : 'str';
  }
  if (props.includes('ranged')) return 'dex';
  return 'str';
}

// Works out the attack bonus and the flat damage bonus for an action.
function attackStats(creature, action) {
  // Monster stat blocks already have the bonus worked out, damage included.
  if (action.toHit !== undefined) {
    return { toHit: action.toHit, damageMod: 0 };
  }

  // Spell attacks use the spellcasting ability and add no damage modifier.
  if (action.attackAbility) {
    const mod = abilityMod(creature, action.attackAbility);
    return { toHit: mod + creature.proficiency, damageMod: 0 };
  }

  // Weapons: assumes the character is proficient with everything they carry.
  const mod = abilityMod(creature, weaponAbility(creature, action));
  return { toHit: mod + creature.proficiency, damageMod: mod };
}

// Applies resistance, immunity, and vulnerability to damage grouped by type.
function applyDefenses(byType, targetCreature) {
  const resist = targetCreature.resist || [];
  const immune = targetCreature.immune || [];
  const vuln = targetCreature.vuln || [];

  return Object.entries(byType).map(([type, amount]) => {
    let final = amount;
    let note = '';

    if (immune.includes(type)) {
      final = 0;
      note = 'immune';
    } else {
      if (resist.includes(type)) {
        final = Math.floor(final / 2);
        note = 'resistant';
      }
      if (vuln.includes(type)) {
        final = final * 2;
        note = note ? 'resistant and vulnerable' : 'vulnerable';
      }
    }

    return { type, amount, final, note };
  });
}

// One roll of the action's damage. Saves never double the dice.
function rollRawDamage(action) {
  const rolled = [];
  const byType = {};
  (action.damage || []).forEach((entry) => {
    const result = rollDice(entry.dice, false);
    const amount = Math.max(0, result.total);
    rolled.push({
      type: entry.type,
      amount,
      text: `${entry.dice} [${result.dice.join(', ')}] = ${amount} ${entry.type}`,
    });
    byType[entry.type] = (byType[entry.type] || 0) + amount;
  });
  return { rolled, byType };
}

// Half (rounded down) or no damage is applied before resistance.
// Evasion on a success skips the damage. Evasion on a failure halves it first.
function resolveSaveDamage(byType, saved, onSave, creature, evasion) {
  const lines = [];
  const adjusted = {};
  const negate = saved && onSave === 'none';

  Object.entries(byType).forEach(([type, amount]) => {
    if (negate) {
      lines.push(`${type}: ${amount} becomes 0 (save negates it).`);
      return;
    }
    if (saved && evasion) {
      lines.push(`${type}: ${amount} becomes 0 (evasion).`);
      return;
    }
    const halve = saved || evasion;
    adjusted[type] = halve ? Math.floor(amount / 2) : amount;
  });

  const parts = applyDefenses(adjusted, creature);
  parts.forEach((part) => {
    const original = byType[part.type];
    const notes = [];
    if (part.amount !== original) notes.push('halved');
    if (evasion && !saved) notes.push('evasion');
    if (part.note) notes.push(part.note);
    const suffix = notes.length ? ` (${notes.join(', ')})` : '';
    lines.push(`${part.type}: ${original} becomes ${part.final}${suffix}.`);
  });

  const total = parts.reduce((sum, part) => sum + part.final, 0);
  return { lines, total };
}

function conditionsFromSave(action, token, creature, failed) {
  if (!failed) return { applied: [], immune: [] };
  const immuneList = creature.conditionImmune || [];
  const have = token.conditions || [];
  const applied = [];
  const immune = [];
  (action.conditions || []).forEach((name) => {
    if (immuneList.includes(name)) immune.push(name);
    else if (!have.includes(name) && !applied.includes(name)) applied.push(name);
  });
  return { applied, immune };
}

function targetEntry(token, hpAfter, damage, conditions) {
  return {
    id: token.id,
    hpBefore: token.hp,
    hpAfter,
    defeated: hpAfter === 0,
    damage,
    conditions,
  };
}

function saveSentence(attacker, target, action, damage, failed, applied, defeated) {
  let sentence;
  if (damage > 0) {
    sentence = `${attacker.name} hits ${target.name} with ${action.name} for ${damage} damage.`;
  } else if (failed && applied.length > 0) {
    sentence = `${target.name} fails the save against ${action.name} and is ${applied.join(', ')}.`;
  } else if (!failed) {
    sentence = `${target.name} saves against ${action.name}.`;
  } else {
    sentence = `${attacker.name} hits ${target.name} with ${action.name}, but it does no damage.`;
  }
  if (defeated) sentence += ` ${target.name} is defeated.`;
  return sentence;
}

// One creature's save. raw is the spell's single damage roll, shared by an area.
function resolveSaveTarget(attacker, target, action, targetCreature, raw) {
  const ability = action.saveAbility;
  const bonus = saveBonus(targetCreature, ability);
  const dc = action.saveDc;
  const lines = [];
  let failed = false;

  const helpless = matching(target, HELPLESS);
  const autoFail = (ability === 'str' || ability === 'dex') && helpless.length > 0;
  if (autoFail) {
    failed = true;
    lines.push(`${target.name} is ${helpless[0]}, so the ${abilityName(ability)} save fails.`);
  } else {
    const die = rollD20('normal');
    const total = die.roll + bonus;
    failed = total < dc;
    const verdict = failed ? 'failure' : 'success';
    lines.push(
      `${target.name} ${abilityName(ability)} save: rolled ${die.roll}. ${die.roll} ${signed(bonus)} = ${total} vs DC ${dc}: ${verdict}.`
    );
  }

  const onSave = action.onSave || 'half';
  const evasion = evasionApplies(target, targetCreature, ability, onSave);
  const damage = resolveSaveDamage(raw.byType, !failed, onSave, targetCreature, evasion);
  damage.lines.forEach((line) => lines.push(line));

  const hpBefore = target.hp;
  const hpAfter = Math.max(0, hpBefore - damage.total);
  const gained = conditionsFromSave(action, target, targetCreature, failed);
  if (gained.immune.length > 0) lines.push(`${target.name} is immune to ${gained.immune.join(', ')}.`);
  if (gained.applied.length > 0) lines.push(`${target.name} is ${gained.applied.join(', ')}.`);
  if (raw.rolled.length > 0 || damage.total > 0) {
    lines.push(`${target.name}: ${hpBefore} to ${hpAfter} HP.${hpAfter === 0 ? ' Defeated.' : ''}`);
  }

  const entry = targetEntry(target, hpAfter, damage.total, gained.applied);
  const sentence = saveSentence(attacker, target, action, damage.total, failed, gained.applied, entry.defeated);
  return { lines, sentence, entry };
}

function blockedAttack(attacker, target, action, distance) {
  const blocked = matching(attacker, CANNOT_ACT);
  if (blocked.length === 0) return null;
  const dm = [
    `${attacker.name} attacks ${target.name} with ${action.name} (${distance} ft).`,
    `${blocked[0]}: the attack fails.`,
  ];
  const pub = `${attacker.name} misses ${target.name}.`;
  return {
    ok: true,
    outcome: 'miss',
    hit: false,
    crit: false,
    totalDamage: 0,
    hpBefore: target.hp,
    hpAfter: target.hp,
    defeated: false,
    dm,
    pub,
    targets: [targetEntry(target, target.hp, 0, [])],
  };
}

// One attack roll against one creature. skipRange is for a creature already inside an area.
function resolveStrike({ attacker, attackerCreature, target, targetCreature, action, tokens, skipRange }) {
  if (!allowedTarget(action, targetCreature, target)) return rejectType(action, target, targetCreature);
  const distance = feetBetween(attacker, target);
  const hasReach = action.reach !== undefined;
  const hasRange = action.range !== undefined;
  let usesRange = false;

  if (!skipRange) {
    if (hasReach && distance <= action.reach) {
      usesRange = false;
    } else if (hasRange && distance <= action.range.long) {
      usesRange = true;
    } else {
      const farthest = hasRange ? action.range.long : action.reach;
      return fail(`${target.name} is ${distance} ft away, but ${action.name} only reaches ${farthest} ft.`);
    }
  } else if (hasRange && !(hasReach && distance <= action.reach)) {
    usesRange = true;
  }

  const blocked = blockedAttack(attacker, target, action, distance);
  if (blocked) return blocked;

  const props = action.properties || [];
  const alliesAdjacentToTarget = tokens.filter((token) => {
    return token.team === attacker.team && token.id !== attacker.id && !token.defeated && feetBetween(token, target) <= 5;
  }).length;

  const hostileAdjacentToAttacker = tokens.some((token) => {
    return token.team !== attacker.team && !token.defeated && feetBetween(token, attacker) <= 5;
  });

  const ctx = {
    mode: 'normal',
    alliesAdjacentToTarget,
    finesseOrRanged: props.includes('finesse') || usesRange,
  };

  const advantageFrom = [];
  const disadvantageFrom = [];

  collectMods(attackerCreature, 'attack.roll', ctx).forEach((mod) => {
    if (mod.mode === 'advantage') advantageFrom.push(mod.source);
    if (mod.mode === 'disadvantage') disadvantageFrom.push(mod.source);
  });

  if (usesRange && action.range && distance > action.range.normal) disadvantageFrom.push('long range');
  if (usesRange && hostileAdjacentToAttacker) disadvantageFrom.push('hostile within 5 ft');

  const shaky = matching(attacker, ATTACK_DISADVANTAGE);
  if (shaky.length > 0) disadvantageFrom.push(shaky.join(', '));
  if ((target.conditions || []).includes('prone')) {
    if (distance <= 5) advantageFrom.push('prone');
    else disadvantageFrom.push('prone');
  }
  const helpless = matching(target, HELPLESS);
  if (helpless.length > 0) advantageFrom.push(helpless.join(', '));

  let mode = 'normal';
  if (advantageFrom.length > 0 && disadvantageFrom.length === 0) mode = 'advantage';
  if (disadvantageFrom.length > 0 && advantageFrom.length === 0) mode = 'disadvantage';
  ctx.mode = mode;

  const stats = attackStats(attackerCreature, action);
  const critMods = collectMods(attackerCreature, 'attack.critRange', ctx);
  const critRange = Math.min(20, ...critMods.map((mod) => mod.value));

  let hit = false;
  let crit = false;
  let natural = null;
  let attackTotal = null;
  let d20 = null;

  if (action.autoHit) {
    hit = true;
  } else {
    d20 = rollD20(mode);
    natural = d20.roll;
    attackTotal = natural + stats.toHit;

    if (natural === 1) {
      hit = false;
    } else if (natural >= critRange) {
      hit = true;
      crit = true;
    } else {
      hit = attackTotal >= targetCreature.ac;
    }
  }

  let critFromCondition = false;
  if (hit && helpless.length > 0 && distance <= 5) {
    critFromCondition = !crit;
    crit = true;
  }

  const rolled = [];
  let parts = [];
  let totalDamage = 0;

  if (hit) {
    action.damage.forEach((entry, index) => {
      const darts = entry.darts || 1;
      for (let i = 0; i < darts; i++) {
        let dice = entry.dice;
        if (index === 0 && stats.damageMod !== 0) dice += signed(stats.damageMod);

        const result = rollDice(dice, crit);
        const amount = Math.max(0, result.total);
        rolled.push({
          type: entry.type,
          amount,
          text: `${dice}${crit ? ' (dice doubled)' : ''} [${result.dice.join(', ')}] = ${amount} ${entry.type}`,
        });
      }
    });

    collectMods(attackerCreature, 'damage.bonus', ctx).forEach((mod) => {
      if (mod.mode !== 'add') return;
      const type = action.damage[0].type;
      const result = rollDice(mod.value, crit);
      rolled.push({
        type,
        amount: result.total,
        text: `${mod.source} ${mod.value}${crit ? ' (dice doubled)' : ''} [${result.dice.join(', ')}] = ${result.total} ${type}`,
      });
    });

    const byType = {};
    rolled.forEach((result) => {
      byType[result.type] = (byType[result.type] || 0) + result.amount;
    });

    parts = applyDefenses(byType, targetCreature);
    totalDamage = parts.reduce((sum, part) => sum + part.final, 0);
  }

  const hpBefore = target.hp;
  const hpAfter = Math.max(0, hpBefore - totalDamage);
  const defeated = hpAfter === 0;

  const dm = [];
  dm.push(`${attacker.name} attacks ${target.name} with ${action.name} (${distance} ft).`);

  if (advantageFrom.length > 0) dm.push(`Advantage from: ${advantageFrom.join(', ')}.`);
  if (disadvantageFrom.length > 0) dm.push(`Disadvantage from: ${disadvantageFrom.join(', ')}.`);
  if (advantageFrom.length > 0 && disadvantageFrom.length > 0) dm.push('They cancel out, so a normal roll.');

  if (action.autoHit) {
    dm.push('Automatic hit, no attack roll.');
  } else {
    const rollsText = d20.rolls.length > 1 ? `Rolled ${d20.rolls.join(' and ')}, took ${natural}.` : `Rolled ${natural}.`;
    let verdict = hit ? 'hit' : 'miss';
    if (natural === 1) verdict = 'natural 1, miss';
    else if (natural >= critRange) {
      verdict = natural === 20 ? 'natural 20, critical hit' : `${natural} is in crit range, critical hit`;
    }
    dm.push(`${rollsText} ${natural} ${signed(stats.toHit)} = ${attackTotal} vs AC ${targetCreature.ac}: ${verdict}.`);
  }
  if (critFromCondition) dm.push(`Critical hit: ${helpless.join(', ')} and within 5 ft.`);

  if (hit) {
    rolled.forEach((result) => dm.push(result.text));
    parts.forEach((part) => {
      const note = part.note ? ` (${part.note})` : '';
      dm.push(`${part.type}: ${part.amount} becomes ${part.final}${note}.`);
    });
    dm.push(`${target.name}: ${hpBefore} to ${hpAfter} HP.${defeated ? ' Defeated.' : ''}`);
  }

  let pub;
  if (!hit) {
    pub = `${attacker.name} misses ${target.name}.`;
  } else if (totalDamage === 0) {
    pub = `${attacker.name} hits ${target.name}, but it does no damage.`;
  } else {
    const verb = crit ? 'critically hits' : 'hits';
    pub = `${attacker.name} ${verb} ${target.name} for ${totalDamage} damage${crit ? '!' : '.'}`;
  }
  if (defeated) pub += ` ${target.name} is defeated.`;

  let outcome = 'miss';
  if (hit) outcome = crit ? 'crit' : 'hit';

  return {
    ok: true,
    outcome,
    hit,
    crit,
    totalDamage,
    hpBefore,
    hpAfter,
    defeated,
    dm,
    pub,
    targets: [targetEntry(target, hpAfter, totalDamage, [])],
  };
}

function combine(header, pieces) {
  const dm = header.slice();
  const sentences = [];
  const targets = [];
  let totalDamage = 0;
  let crit = false;

  pieces.forEach((piece) => {
    piece.lines.forEach((line) => dm.push(line));
    sentences.push(piece.sentence);
    targets.push(piece.entry);
    totalDamage += piece.entry.damage;
    if (piece.crit) crit = true;
  });

  const first = targets[0];
  const hit = totalDamage > 0;
  let outcome = 'miss';
  if (crit) outcome = 'crit';
  else if (hit) outcome = 'hit';

  return {
    ok: true,
    outcome,
    hit,
    crit,
    totalDamage,
    hpBefore: first ? first.hpBefore : 0,
    hpAfter: first ? first.hpAfter : 0,
    defeated: first ? first.defeated : false,
    dm,
    pub: sentences.join(' '),
    targets,
  };
}

function selfAimed(area) {
  const type = area && area.type;
  return area && area.origin === 'self' && (type === 'cone' || type === 'line' || type === 'cube' || type === 'square' || type === 'wall');
}

function typeListText(types) {
  if (types.length === 1) return types[0];
  if (types.length === 2) return `${types[0]} or ${types[1]}`;
  return `${types.slice(0, -1).join(', ')}, or ${types[types.length - 1]}`;
}

function creatureKind(creature, token) {
  if (creature && creature.type) return String(creature.type).toLowerCase();
  if (token && token.team === 'player') return 'humanoid';
  return '';
}

function allowedTarget(action, creature, token) {
  const targets = action.targets;
  if (!targets || !targets.length) return true;
  return targets.includes(creatureKind(creature, token));
}

function rejectType(action, target, creature) {
  const kind = creatureKind(creature, target) || 'different kind of creature';
  return fail(`${action.name} can only target a ${typeListText(action.targets)}. ${target.name} is a ${kind}.`);
}

function selfDisk(area) {
  const type = area && area.type;
  return area && area.origin === 'self' && (type === 'sphere' || type === 'circle' || type === 'radius' || type === 'cylinder');
}

function resolveArea({ attacker, attackerCreature, action, tokens, catalog, square }) {
  const aimed = selfAimed(action.area);
  const disk = selfDisk(action.area);

  if (!disk && (!square || !insideRoom(square.x, square.y))) {
    return fail(`${action.name} needs a square inside the room.`);
  }
  if (aimed && coversSquare(attacker, square.x, square.y)) {
    return fail(`${action.name} needs a direction away from ${attacker.name}.`);
  }
  if (!aimed && !disk) {
    const center = { x: square.x, y: square.y, w: 1, h: 1 };
    const distance = feetBetween(attacker, center);
    const farthest = reachLimit(action);
    if (distance > farthest) {
      return fail(`That square is ${distance} ft away, but ${action.name} only reaches ${farthest} ft.`);
    }
  }

  const aim = square || attacker;
  const covered = areaSquares(attacker, aim, action.area);
  const limited = action.targets && action.targets.length;
  const caught = tokens.filter((token) => {
    if (token.defeated || !tokenCaught(token, covered)) return false;
    if (!limited) return true;
    return allowedTarget(action, catalog[token.creatureId], token);
  });
  const shape = `${action.area.size}-foot ${action.area.type}`;
  const where = disk ? 'around itself' : `at square (${square.x}, ${square.y})`;
  const header = [`${attacker.name} casts ${action.name} (${shape}) ${where}.`];
  if (limited) header.push(`Only ${typeListText(action.targets)} creatures are affected.`);

  if (caught.length === 0) {
    header.push('Nobody is caught.');
    return {
      ok: true,
      outcome: 'miss',
      hit: false,
      crit: false,
      totalDamage: 0,
      hpBefore: attacker.hp,
      hpAfter: attacker.hp,
      defeated: false,
      dm: header,
      pub: `${attacker.name} casts ${action.name}, but nobody is caught.`,
      targets: [],
    };
  }

  if (action.saveAbility) {
    const raw = rollRawDamage(action);
    raw.rolled.forEach((result) => header.push(result.text));
    const pieces = caught.map((token) => {
      const creature = catalog[token.creatureId];
      const saved = resolveSaveTarget(attacker, token, action, creature, raw);
      return { lines: saved.lines, sentence: saved.sentence, entry: saved.entry };
    });
    return combine(header, pieces);
  }

  const blocked = matching(attacker, CANNOT_ACT);
  if (blocked.length > 0) {
    header.push(`${blocked[0]}: the attack fails.`);
    return {
      ok: true,
      outcome: 'miss',
      hit: false,
      crit: false,
      totalDamage: 0,
      hpBefore: attacker.hp,
      hpAfter: attacker.hp,
      defeated: false,
      dm: header,
      pub: `${attacker.name} misses.`,
      targets: [],
    };
  }

  const pieces = [];
  caught.forEach((token) => {
    const result = resolveStrike({
      attacker,
      attackerCreature,
      target: token,
      targetCreature: catalog[token.creatureId],
      action,
      tokens,
      skipRange: true,
    });
    if (!result.ok) {
      header.push(result.error);
      return;
    }
    pieces.push({
      lines: result.dm,
      sentence: result.pub,
      entry: result.targets[0],
      crit: result.crit,
    });
  });
  return combine(header, pieces);
}

function resolveSingleSave({ attacker, target, action, catalog }) {
  const targetCreature = catalog[target.creatureId];
  if (!allowedTarget(action, targetCreature, target)) return rejectType(action, target, targetCreature);
  const distance = feetBetween(attacker, target);
  const farthest = reachLimit(action);
  if (distance > farthest) {
    return fail(`${target.name} is ${distance} ft away, but ${action.name} only reaches ${farthest} ft.`);
  }

  const raw = rollRawDamage(action);
  const saved = resolveSaveTarget(attacker, target, action, targetCreature, raw);
  const header = [`${attacker.name} casts ${action.name} at ${target.name} (${distance} ft).`].concat(
    raw.rolled.map((result) => result.text)
  );
  return combine(header, [{ lines: saved.lines, sentence: saved.sentence, entry: saved.entry }]);
}

// attacker and target are board tokens. tokens is every token on the board
// (used to find allies and enemies nearby). catalog maps creature ids to data.
// square is the aim square of an area. This function only calculates.
function resolveAttack({ attacker, target, actionName, tokens, catalog, square }) {
  const attackerCreature = catalog[attacker.creatureId];
  if (!attackerCreature) return fail(`${attacker.name} is not in the roster.`);
  const action = (attackerCreature.actions || []).find((entry) => entry.name === actionName);

  if (!action) return fail(`${attacker.name} does not have ${actionName}.`);
  if (attacker.defeated) return fail(`${attacker.name} is defeated.`);

  if (action.area) {
    return resolveArea({ attacker, attackerCreature, action, tokens, catalog, square });
  }

  if (!target) return fail(`${action.name} needs a target.`);
  if (target.defeated) return fail(`${target.name} is already defeated.`);

  if (action.saveAbility) return resolveSingleSave({ attacker, target, action, catalog });

  return resolveStrike({
    attacker,
    attackerCreature,
    target,
    targetCreature: catalog[target.creatureId],
    action,
    tokens,
    skipRange: false,
  });
}

module.exports = { resolveAttack };
