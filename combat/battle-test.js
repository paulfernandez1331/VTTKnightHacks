// Conditions, zones, concentration, bonus actions, and the DM undo stack.
const assert = require('assert');
const { resolveAttack, applyIncoming } = require('./attack.js');
const init = require('./initiative.js');
const table = require('./table.js');

let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

function withRolls(values, fn) {
  const original = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[index] === undefined ? 0 : values[index];
    index += 1;
    return value;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function creature(id, extra) {
  return Object.assign({
    id,
    name: id,
    team: 'monster',
    ac: 10,
    hp: 40,
    speed: 30,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiency: 2,
    saves: {},
    actions: [],
    features: [],
    traits: [],
    resist: [],
    immune: [],
    vuln: [],
    conditionImmune: [],
  }, extra || {});
}

function token(id, creatureId, name, x, y, team, extra) {
  return Object.assign({
    id, creatureId, name, team, x, y, w: 1, h: 1, hp: 40, maxHp: 40,
    defeated: false, conditions: [], marks: [], uses: {},
  }, extra || {});
}

function boardOf(tokens, catalog) {
  const board = {
    tokens,
    nextId: 10,
    log: [],
    nextLogId: 1,
    tracker: init.createTracker(),
    zones: [],
    nextZoneId: 1,
    history: [],
  };
  board.tracker.active = true;
  board.tracker.turn = {
    tokenId: tokens[0].id,
    actionUsed: false,
    attacksLeft: 0,
    bonusUsed: false,
    extraAction: false,
    dashed: false,
    moved: false,
    movementLeft: 30,
  };
  board.catalog = catalog;
  return board;
}

check('advantage rider is added only when the attack had advantage', () => {
  const boss = creature('boss', {
    actions: [{
      name: 'Shortbow',
      kind: 'attack',
      toHit: 4,
      range: { normal: 80, long: 320 },
      damage: [{ dice: '1d6', type: 'piercing' }],
      advantageRider: { dice: '1d4', type: 'piercing' },
    }],
  });
  const hero = creature('hero', { team: 'player' });
  const catalog = { boss, hero };
  const attacker = token(1, 'boss', 'Boss', 1, 1, 'monster');
  const plain = token(2, 'hero', 'Hero', 3, 1, 'player');
  const held = token(3, 'hero', 'Held', 3, 1, 'player', { conditions: ['restrained'] });
  const normal = withRolls([0.5, 0], () => resolveAttack({
    attacker, target: plain, actionName: 'Shortbow', tokens: [attacker, plain], catalog,
  }));
  const advantage = withRolls([0.5, 0.5, 0, 0], () => resolveAttack({
    attacker, target: held, actionName: 'Shortbow', tokens: [attacker, held], catalog,
  }));
  assert.strictEqual(normal.targets[0].damage, 1);
  assert.ok(!normal.dm.some((line) => line.startsWith('Advantage ')));
  assert.strictEqual(advantage.targets[0].damage, 2);
  assert.ok(advantage.dm.some((line) => line.startsWith('Advantage 1d4')));
});

check('magic resistance rolls a spell save with advantage', () => {
  const golem = creature('golem', { traits: [{ name: 'Magic Resistance', summary: '' }] });
  const caster = creature('wiz', {
    team: 'player',
    actions: [{
      name: 'Bolt', kind: 'spell', saveAbility: 'dex', saveDc: 15, onSave: 'none', reach: 30,
      damage: [{ dice: '1d6', type: 'fire' }],
    }],
  });
  const catalog = { golem, wiz: caster };
  const attacker = token(1, 'wiz', 'Wizard', 1, 1, 'player');
  const target = token(2, 'golem', 'Golem', 2, 1, 'monster');
  const result = withRolls([0, 0, 0], () => resolveAttack({
    attacker, target, actionName: 'Bolt', tokens: [attacker, target], catalog,
  }));
  assert.ok(result.dm.some((line) => line.includes('(advantage)')));
  assert.strictEqual(result.targets[0].failed, true);
});

check('greater magic resistance succeeds and takes no damage', () => {
  const rakshasa = creature('rak', { traits: [{ name: 'Greater Magic Resistance', summary: '' }] });
  const caster = creature('wiz', {
    team: 'player',
    actions: [{
      name: 'Bolt', kind: 'spell', saveAbility: 'dex', saveDc: 15, onSave: 'half', reach: 30,
      damage: [{ dice: '1d8', type: 'fire' }],
    }],
  });
  const catalog = { rak: rakshasa, wiz: caster };
  const attacker = token(1, 'wiz', 'Wizard', 1, 1, 'player');
  const target = token(2, 'rak', 'Rakshasa', 2, 1, 'monster');
  let rolls = 0;
  const original = Math.random;
  Math.random = () => {
    rolls += 1;
    return 0;
  };
  let result;
  try {
    result = resolveAttack({
      attacker, target, actionName: 'Bolt', tokens: [attacker, target], catalog,
    });
  } finally {
    Math.random = original;
  }
  assert.strictEqual(rolls, 1);
  assert.strictEqual(result.targets[0].damage, 0);
  assert.ok(result.dm.some((line) => line.includes('Greater Magic Resistance')));
});

check('acid absorption heals the amount immunity would have removed', () => {
  const golem = creature('golem', {
    hp: 20,
    immune: ['acid'],
    traits: [{ name: 'Acid Absorption', summary: '' }],
  });
  const caster = creature('wiz', {
    team: 'player',
    actions: [{
      name: 'Splash', kind: 'spell', saveAbility: 'dex', saveDc: 20, onSave: 'half', reach: 30,
      damage: [{ dice: '1d6', type: 'acid' }],
    }],
  });
  const catalog = { golem, wiz: caster };
  const attacker = token(1, 'wiz', 'Wizard', 1, 1, 'player');
  const target = token(2, 'golem', 'Golem', 2, 1, 'monster', { hp: 20, maxHp: 40 });
  const failed = withRolls([0.7, 0], () => resolveAttack({
    attacker, target, actionName: 'Splash', tokens: [attacker, target], catalog,
  }));
  const saved = withRolls([0.7, 0.95], () => resolveAttack({
    attacker, target, actionName: 'Splash', tokens: [attacker, target], catalog,
  }));
  assert.strictEqual(failed.targets[0].damage, 0);
  assert.strictEqual(failed.targets[0].heal, 5);
  assert.strictEqual(failed.targets[0].hpAfter, 25);
  assert.strictEqual(saved.targets[0].heal, 2);
  assert.strictEqual(saved.targets[0].hpAfter, 22);
});

check('a failed slow save halves movement and limits the creature to one attack', () => {
  const golem = creature('golem', { speed: 30 });
  const caster = creature('wiz', {
    team: 'player',
    actions: [{
      name: 'Slow', kind: 'spell', saveAbility: 'wis', saveDc: 15, onSave: 'none', reach: 30,
      damage: [], conditions: ['slowed'], concentration: true, repeatSave: true,
    }],
  });
  const catalog = { golem, wiz: caster };
  const wizard = token(1, 'wiz', 'Wizard', 1, 1, 'player');
  const target = token(2, 'golem', 'Golem', 2, 1, 'monster');
  const board = boardOf([wizard, target], catalog);
  const result = withRolls([0], () => resolveAttack({
    attacker: wizard, target, actionName: 'Slow', tokens: board.tokens, catalog,
  }));
  assert.strictEqual(result.targets[0].conditions[0], 'slowed');
  table.applyAttack(board, catalog, wizard, caster.actions[0], result);
  assert.ok(target.conditions.includes('slowed'));
  assert.ok(wizard.marks.some((mark) => mark.name === 'concentration' && mark.spell === 'Slow'));
  board.tracker.turn = {
    tokenId: target.id, actionUsed: false, attacksLeft: 0, bonusUsed: false,
    extraAction: false, movementLeft: 30, moved: false, dashed: false,
  };
  table.onTurnStart(board, catalog, target);
  assert.strictEqual(board.tracker.turn.movementLeft, 15);
  assert.strictEqual(init.attacksThisAction(golem, target), 1);

  // Casting Slow again ends the first concentration. The failed save has to
  // put slowed back, or the golem walks away at full speed.
  const again = withRolls([0], () => resolveAttack({
    attacker: wizard, target, actionName: 'Slow', tokens: board.tokens, catalog,
  }));
  assert.ok(again.targets[0].conditions.includes('slowed'));
  table.applyAttack(board, catalog, wizard, caster.actions[0], again);
  const slowed = board.tokens.find((entry) => entry.id === target.id);
  assert.ok(slowed.conditions.includes('slowed'));
  assert.strictEqual(slowed.marks.filter((mark) => mark.name === 'slowed').length, 1);
  assert.ok(wizard.marks.some((mark) => mark.name === 'concentration' && mark.spell === 'Slow'));
});

check('a failed command halt ends the target turn', () => {
  const golem = creature('golem');
  const caster = creature('wiz', {
    team: 'player',
    actions: [{
      name: 'Command', kind: 'spell', saveAbility: 'wis', saveDc: 15, onSave: 'none', reach: 60,
      damage: [], command: true,
    }],
  });
  const catalog = { golem, wiz: caster };
  const wizard = token(1, 'wiz', 'Wizard', 1, 1, 'player');
  const target = token(2, 'golem', 'Golem', 4, 1, 'monster');
  const board = boardOf([wizard, target], catalog);
  const result = withRolls([0], () => resolveAttack({
    attacker: wizard, target, actionName: 'Command', tokens: board.tokens, catalog, commandWord: 'Halt',
  }));
  assert.strictEqual(result.targets[0].command, 'Halt');
  table.applyAttack(board, catalog, wizard, caster.actions[0], result);
  board.tracker.turn.tokenId = target.id;
  const started = table.onTurnStart(board, catalog, target);
  assert.strictEqual(started.ended, true);
  assert.ok(!target.marks.some((mark) => mark.name === 'command'));
});

check('web stays on the ground, restrains on a failed save, and burns later', () => {
  const golem = creature('golem');
  const caster = creature('wiz', {
    team: 'player',
    actions: [{
      name: 'Web', kind: 'spell', saveAbility: 'dex', saveDc: 15, onSave: 'none',
      damage: [], conditions: ['restrained'], concentration: true, zone: 'web',
      area: { type: 'cube', size: 20, origin: 'point' },
      range: { normal: 60, long: 60 },
      burn: { dice: '2d4', type: 'fire' },
    }, {
      name: 'Fire', kind: 'spell', saveAbility: 'dex', saveDc: 10, onSave: 'none',
      damage: [{ dice: '1d4', type: 'fire' }], reach: 30,
    }],
  });
  const catalog = { golem, wiz: caster };
  const wizard = token(1, 'wiz', 'Wizard', 1, 1, 'player');
  const target = token(2, 'golem', 'Golem', 4, 1, 'monster', { hp: 30, maxHp: 30 });
  const board = boardOf([wizard, target], catalog);
  const cast = withRolls([0], () => resolveAttack({
    attacker: wizard, actionName: 'Web', tokens: board.tokens, catalog, square: { x: 4, y: 1 },
  }));
  assert.strictEqual(cast.totalDamage, 0);
  assert.ok(cast.squares.length > 0);
  assert.strictEqual(cast.targets[0].conditions[0], 'restrained');
  table.applyAttack(board, catalog, wizard, caster.actions[0], cast);
  assert.strictEqual(board.zones.length, 1);
  assert.strictEqual(board.zones[0].kind, 'web');
  assert.ok(target.conditions.includes('restrained'));

  const fire = withRolls([0, 0], () => resolveAttack({
    attacker: wizard, target, actionName: 'Fire', tokens: board.tokens, catalog,
  }));
  table.applyAttack(board, catalog, wizard, caster.actions[1], fire);
  assert.ok(board.zones[0].burning.length > 0);

  board.tracker.turn.tokenId = target.id;
  withRolls([0, 0], () => table.onTurnStart(board, catalog, target));
  assert.ok(target.hp < 30);
  assert.ok(!board.zones.some((zone) => zone.squares.some((square) => square.x === 4 && square.y === 1)));
});

check('concentration ends when the save fails, and Eldritch Mind rolls twice', () => {
  const ally = creature('ally', { team: 'player' });
  const sefris = creature('sefris', {
    team: 'player',
    features: [{ name: 'Eldritch Mind', summary: '' }],
    saves: { con: true },
    abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
  });
  const catalog = { ally, sefris };
  const caster = token(1, 'sefris', 'Sefris', 1, 1, 'player', {
    marks: [{ name: 'concentration', spell: 'Web', zoneId: 1 }],
  });
  const other = token(2, 'ally', 'Ally', 2, 1, 'player', {
    conditions: ['restrained'],
    marks: [{ name: 'restrained', concentration: true, casterId: 1, spell: 'Web', zoneId: 1 }],
  });
  const board = boardOf([caster, other], catalog);
  board.zones.push({
    id: 1, kind: 'web', squares: [{ x: 2, y: 1 }], casterId: 1, spell: 'Web',
    concentration: true, burning: [], saveDc: 13, saveAbility: 'dex',
  });
  board.nextZoneId = 2;
  const lines = [];
  withRolls([0, 0], () => {
    const applied = {
      ok: true,
      dm: ['hit'],
      pub: 'hit',
      targets: [{ id: caster.id, hpBefore: 10, hpAfter: 4, damage: 6, defeated: false, conditions: [] }],
    };
    const out = table.applyAttack(board, catalog, other, { name: 'Slam', damage: [] }, applied);
    lines.push.apply(lines, out.lines);
  });
  assert.ok(lines.some((line) => line.includes('(advantage)')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('concentration on Web ends')), lines.join('\n'));
  assert.ok(!other.conditions.includes('restrained'));
  assert.strictEqual(board.zones.length, 0);
});

check('scorching ray makes one attack per ray', () => {
  const zanna = creature('zanna', {
    team: 'player',
    abilities: { str: 10, dex: 10, con: 10, int: 18, wis: 10, cha: 10 },
    proficiency: 3,
    actions: [{
      name: 'Scorching Ray', kind: 'spell', attackAbility: 'int', rays: 3,
      range: { normal: 120, long: 120 },
      damage: [{ dice: '2d6', type: 'fire' }],
    }],
  });
  const dummy = creature('dummy', { ac: 5, hp: 80 });
  const catalog = { zanna, dummy };
  const attacker = token(1, 'zanna', 'Zanna', 1, 1, 'player');
  const target = token(2, 'dummy', 'Dummy', 6, 1, 'monster', { hp: 80, maxHp: 80 });
  const result = withRolls([0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0], () => resolveAttack({
    attacker, target, actionName: 'Scorching Ray', tokens: [attacker, target], catalog,
  }));
  assert.strictEqual(result.targets.length, 3);
  assert.ok(result.targets.every((entry) => entry.damage > 0));
});

check('second wind spends the bonus action and not the action', () => {
  const fighter = creature('fighter', {
    team: 'player',
    actions: [{
      name: 'Second Wind', kind: 'heal', activation: 'bonus', profile: 'second-wind',
      useKey: 'Second Wind', uses: 3, heal: '1d10+5',
    }],
  });
  const catalog = { fighter };
  const randal = token(1, 'fighter', 'Randal', 1, 1, 'player', { hp: 10, maxHp: 40 });
  table.initUses(randal, fighter);
  const board = boardOf([randal], catalog);
  const used = withRolls([0], () => table.useFeature(board, catalog, randal, fighter.actions[0], {}));
  assert.strictEqual(used.ok, true);
  assert.strictEqual(board.tracker.turn.actionUsed, false);
  assert.strictEqual(board.tracker.turn.bonusUsed, true);
  assert.strictEqual(randal.uses['Second Wind'].left, 2);
  assert.ok(randal.hp > 10);
});

check('action surge grants another weapon attack and not a spell', () => {
  const fighter = creature('fighter', {
    team: 'player',
    actions: [{
      name: 'Action Surge', kind: 'feature', activation: 'special', profile: 'action-surge',
      useKey: 'Action Surge', uses: 1,
    }, {
      name: 'Greatsword', kind: 'weapon', activation: 'action', damage: [{ dice: '2d6', type: 'slashing' }], reach: 5,
    }, {
      name: 'Fireball', kind: 'spell', activation: 'action', saveAbility: 'dex', saveDc: 13,
    }],
  });
  const catalog = { fighter };
  const randal = token(1, 'fighter', 'Randal', 1, 1, 'player');
  table.initUses(randal, fighter);
  const board = boardOf([randal], catalog);
  board.tracker.turn.actionUsed = true;
  const used = table.useFeature(board, catalog, randal, fighter.actions[0], {});
  assert.strictEqual(used.ok, true);
  assert.strictEqual(board.tracker.turn.extraAction, true);
  assert.strictEqual(init.checkAttack(board.tracker, randal.id, fighter.actions[1], randal).ok, true);
  assert.strictEqual(init.checkAttack(board.tracker, randal.id, fighter.actions[2], randal).ok, false);
});

check('rage resists ordinary weapon damage', () => {
  const hero = token(1, 'barb', 'Merric', 1, 1, 'player', { conditions: ['raging'] });
  const barb = creature('barb', { resist: [] });
  const dealt = applyIncoming(hero, barb, { bludgeoning: 10, fire: 4 });
  assert.strictEqual(dealt.total, 9);
});

check('cunning action dash does not spend the action', () => {
  const rogue = creature('rogue', {
    team: 'player',
    speed: 30,
    actions: [{ name: 'Dash', kind: 'feature', activation: 'bonus', profile: 'dash' }],
  });
  const catalog = { rogue };
  const ris = token(1, 'rogue', 'Riswynn', 1, 1, 'player');
  const board = boardOf([ris], catalog);
  const used = table.useFeature(board, catalog, ris, rogue.actions[0], {});
  assert.strictEqual(used.ok, true);
  assert.strictEqual(board.tracker.turn.actionUsed, false);
  assert.strictEqual(board.tracker.turn.bonusUsed, true);
  assert.strictEqual(board.tracker.turn.movementLeft, 60);
});

check('bardic inspiration can save a failed roll and is then spent', () => {
  const ally = creature('ally', { team: 'player' });
  const caster = creature('wiz', {
    team: 'monster',
    actions: [{
      name: 'Hold', kind: 'spell', saveAbility: 'wis', saveDc: 15, onSave: 'none', reach: 30,
      damage: [], conditions: ['paralyzed'],
    }],
  });
  const catalog = { ally, wiz: caster };
  const attacker = token(1, 'wiz', 'Mage', 1, 1, 'monster');
  const target = token(2, 'ally', 'Ally', 2, 1, 'player', { marks: [{ name: 'bardic', die: '1d8' }] });
  const result = withRolls([0.45, 0.95], () => resolveAttack({
    attacker, target, actionName: 'Hold', tokens: [attacker, target], catalog,
  }));
  assert.strictEqual(result.targets[0].failed, false);
  assert.strictEqual(result.targets[0].bardicSpent, true);
  assert.strictEqual((result.targets[0].conditions || []).length, 0);
});

check('lay on hands spends the pool and leaves the action free', () => {
  const paladin = creature('paladin', {
    team: 'player',
    actions: [{
      name: 'Lay on Hands', kind: 'feature', activation: 'bonus', profile: 'lay-on-hands',
      useKey: 'Lay on Hands', pool: 25,
    }],
  });
  const ally = creature('ally', { team: 'player' });
  const catalog = { paladin, ally };
  const krusk = token(1, 'paladin', 'Krusk', 1, 1, 'player');
  const friend = token(2, 'ally', 'Ally', 2, 1, 'player', { hp: 10, maxHp: 40 });
  table.initUses(krusk, paladin);
  const board = boardOf([krusk, friend], catalog);
  const used = table.useFeature(board, catalog, krusk, paladin.actions[0], { target: friend, amount: 7 });
  assert.strictEqual(used.ok, true);
  assert.strictEqual(friend.hp, 17);
  assert.strictEqual(krusk.uses['Lay on Hands'].left, 18);
  assert.strictEqual(board.tracker.turn.actionUsed, false);
  assert.strictEqual(board.tracker.turn.bonusUsed, true);
});

check('the DM can set hit points and undo the change', () => {
  const hero = creature('hero', { team: 'player' });
  const catalog = { hero };
  const tokenHero = token(1, 'hero', 'Hero', 1, 1, 'player', { hp: 22, maxHp: 40 });
  const board = boardOf([tokenHero], catalog);
  const set = table.setHp(board, tokenHero, 0);
  assert.strictEqual(set.ok, true);
  assert.strictEqual(board.tokens[0].hp, 0);
  assert.strictEqual(board.tokens[0].defeated, true);
  const raised = table.setHp(board, board.tokens[0], 9);
  assert.strictEqual(raised.ok, true);
  assert.strictEqual(board.tokens[0].defeated, false);
  assert.strictEqual(table.undo(board).ok, true);
  assert.strictEqual(board.tokens[0].hp, 0);
  assert.strictEqual(board.tokens[0].defeated, true);
  assert.strictEqual(table.undo(board).ok, true);
  assert.strictEqual(board.tokens[0].hp, 22);
  assert.strictEqual(board.tokens[0].defeated, false);
});

check('a step into a web square costs 10 feet', () => {
  const mover = token(1, 'hero', 'Hero', 1, 1, 'player');
  const zones = [{ kind: 'web', squares: [{ x: 2, y: 1 }, { x: 3, y: 1 }] }];
  assert.strictEqual(table.movementCost(mover, 3, 1, zones), 20);
  assert.strictEqual(table.movementCost(mover, 3, 1, []), 10);
});

check('spirit guardians follows the caster, saves once a turn, and ends with concentration', () => {
  const action = {
    name: 'Spirit Guardians', kind: 'spell', activation: 'action',
    saveAbility: 'wis', saveDc: 15, onSave: 'half',
    damage: [{ dice: '3d8', type: 'radiant' }],
    damageChoice: ['Radiant', 'Necrotic'],
    area: { type: 'radius', size: 15, origin: 'self' },
    zone: 'spirit', concentration: true, durationRounds: 100,
  };
  const casterCreature = creature('wiz', { team: 'player', actions: [action] });
  const foe = creature('foe');
  const friend = creature('ally', { team: 'player' });
  const catalog = { wiz: casterCreature, foe, ally: friend };
  const caster = token(1, 'wiz', 'Akra', 2, 2, 'player');
  const near = token(2, 'foe', 'Near', 3, 2, 'monster');
  const ally = token(3, 'ally', 'Ally', 2, 3, 'player');
  const far = token(4, 'foe', 'Far', 6, 2, 'monster');
  const board = boardOf([caster, near, ally, far], catalog);
  const castOf = (extra) => resolveAttack(Object.assign({
    attacker: caster, actionName: 'Spirit Guardians', tokens: board.tokens, catalog,
  }, extra || {}));

  const necrotic = withRolls([0, 0, 0, 0], () => castOf({ damageType: 'Necrotic' }));
  assert.ok(necrotic.dm.some((line) => line.includes('necrotic')), necrotic.dm.join('\n'));
  assert.ok(!necrotic.targets.some((entry) => entry.id === ally.id));

  const cast = withRolls([0, 0, 0, 0], () => castOf());
  assert.ok(cast.dm.some((line) => line.includes('radiant')), cast.dm.join('\n'));
  assert.strictEqual(cast.targets.length, 1);
  assert.strictEqual(cast.targets[0].id, near.id);
  table.applyAttack(board, catalog, caster, action, cast);
  assert.strictEqual(near.hp, 37);
  assert.strictEqual(ally.hp, 40);
  assert.strictEqual(far.hp, 40);
  assert.strictEqual(board.zones.length, 1);
  const zone = board.zones[0];
  assert.strictEqual(zone.kind, 'spirit');
  assert.strictEqual(zone.anchor, caster.id);
  assert.strictEqual(zone.damageType, 'radiant');
  assert.deepStrictEqual(zone.squares, []);
  assert.deepStrictEqual(zone.saved, [near.id]);
  const ring = () => table.zoneSquares(board.zones[0], board.tokens);
  const has = (x, y) => ring().some((square) => square.x === x && square.y === y);
  assert.ok(has(3, 2));
  assert.ok(has(5, 2));
  assert.ok(!has(2, 2));
  assert.ok(!has(6, 2));
  assert.deepStrictEqual(board.zones[0].squares, []);

  const before = ring();
  table.snapshot(board);
  caster.x = 8;
  assert.ok(!ring().some((square) => square.x === 3 && square.y === 2));
  assert.strictEqual(table.undo(board).ok, true);
  const live = () => ({
    caster: board.tokens.find((entry) => entry.id === 1),
    near: board.tokens.find((entry) => entry.id === 2),
    ally: board.tokens.find((entry) => entry.id === 3),
    far: board.tokens.find((entry) => entry.id === 4),
  });
  assert.strictEqual(live().caster.x, 2);
  assert.deepStrictEqual(ring(), before);

  const step = (token, x, y, rolls) => {
    const from = { x: token.x, y: token.y };
    token.x = x;
    token.y = y;
    return withRolls(rolls, () => table.enterZones(board, catalog, token, from));
  };
  step(live().caster, 3, 3, [0, 0, 0, 0]);
  assert.strictEqual(live().far.hp, 37);
  assert.strictEqual(live().near.hp, 37);
  assert.strictEqual(live().ally.hp, 40);
  step(live().caster, 2, 2, []);
  step(live().caster, 3, 3, [0, 0, 0, 0]);
  assert.strictEqual(live().far.hp, 37, 'a creature already saved against this ring this turn');
  step(live().caster, 2, 2, []);

  table.onTurnStart(board, catalog, live().near);
  assert.strictEqual(live().near.hp, 37);
  withRolls([0, 0, 0, 0], () => table.onTurnEnd(board, catalog, live().ally));
  assert.strictEqual(live().ally.hp, 40);
  withRolls([0, 0, 0, 0], () => table.onTurnEnd(board, catalog, live().near));
  assert.strictEqual(live().near.hp, 34);
  withRolls([0, 0, 0, 0], () => table.onTurnEnd(board, catalog, live().near));
  assert.strictEqual(live().near.hp, 34);

  table.onTurnStart(board, catalog, live().far);
  step(live().far, 5, 2, [0, 0, 0, 0]);
  assert.strictEqual(live().far.hp, 34);
  withRolls([0, 0, 0, 0], () => table.onTurnEnd(board, catalog, live().far));
  assert.strictEqual(live().far.hp, 34);

  const lines = [];
  table.removeZone(board, board.zones[0].id, lines);
  assert.strictEqual(board.zones.length, 0);
  assert.ok(lines.some((line) => line.includes('concentration on Spirit Guardians ends')), lines.join('\n'));
  assert.ok(!live().caster.marks.some((mark) => mark.name === 'concentration'));
});

check('an enemy pays 10 feet to step into spirit guardians', () => {
  const caster = token(1, 'wiz', 'Akra', 2, 2, 'player');
  const enemy = token(2, 'foe', 'Foe', 6, 2, 'monster');
  const ally = token(3, 'ally', 'Ally', 6, 3, 'player');
  const zone = {
    kind: 'spirit', anchor: 1, casterId: 1, team: 'player', radius: 15, squares: [],
  };
  const web = { kind: 'web', squares: [{ x: 5, y: 2 }] };
  const tokens = [caster, enemy, ally];
  assert.strictEqual(table.movementCost(enemy, 5, 2, [zone], tokens), 10);
  assert.strictEqual(table.movementCost(ally, 5, 3, [zone], tokens), 5);
  assert.strictEqual(table.movementCost(caster, 3, 2, [zone], tokens), 5);
  assert.strictEqual(table.movementCost(enemy, 7, 2, [zone], tokens), 5);
  assert.strictEqual(table.movementCost(enemy, 5, 2, [zone, web], tokens), 10);
});

console.log(`\nAll ${passed} checks passed.`);
