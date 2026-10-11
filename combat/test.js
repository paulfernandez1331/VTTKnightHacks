// Checks the generated 2024 roster. Run with: npm test
const { resolveAttack } = require('./attack.js');
const { feetBetween } = require('../public/rules.js');
const monsters = require('../data/monsters.json');
const characters = require('../data/characters.json');

const catalog = {};
[...monsters, ...characters].forEach((c) => (catalog[c.id] = c));

function fail(message) {
  console.error(message);
  process.exit(1);
}

const goblin = catalog.mmGoblinWarrior0;
const zanna = catalog.ZannaLv050000000;
if (!goblin) fail('Goblin Warrior is missing from monsters.json');
if (!zanna) fail('Level 5 Zanna is missing from characters.json');
if (goblin.ac !== 15) fail(`Goblin AC is ${goblin.ac}`);
if (goblin.token !== 'tokens/humanoid/Goblin.webp') fail(`Goblin token is ${goblin.token}`);
if (goblin.width !== 1 || goblin.height !== 1) fail(`Goblin footprint is ${goblin.width}x${goblin.height}`);

const giant = catalog.mmHillGiant00000;
const dragon = catalog.mmAncientRedDrag;
if (!giant || giant.width !== 3 || giant.height !== 3) fail('Hill Giant is not 3 by 3');
if (!dragon || dragon.width !== 4 || dragon.height !== 4) fail('Ancient Red Dragon is not 4 by 4');
const besideGiant = feetBetween({ x: 1, y: 1, w: 3, h: 3 }, { x: 4, y: 1, w: 1, h: 1 });
if (besideGiant !== 5) fail(`A creature beside a Hill Giant is ${besideGiant} ft away`);

const missile = zanna.actions.find((action) => action.name === 'Magic Missile');
if (!missile || !missile.autoHit) fail('Zanna has no Magic Missile auto-hit');
if (missile.img !== 'icons/magic/light/projectiles-pink-purple.webp') {
  fail(`Magic Missile icon is ${missile.img}`);
}

function token(id, creatureId, name, x, y) {
  const c = catalog[creatureId];
  return { id, creatureId, name, team: c.team, x, y, hp: c.hp, maxHp: c.hp, defeated: false };
}

const attacker = token(1, goblin.id, 'Goblin Warrior 1', 1, 1);
const target = token(2, zanna.id, zanna.name, 2, 1);
const result = resolveAttack({
  attacker,
  target,
  actionName: 'Scimitar',
  tokens: [attacker, target],
  catalog,
});

if (!result.ok) fail(result.error);
if (result.dm[0].indexOf('Scimitar') === -1) fail('Scimitar was not the action that resolved');
if (!result.targets || result.targets.length !== 1) fail('Scimitar did not return its target');

if (!zanna.saves || zanna.saves.int !== true || zanna.saves.wis !== true || zanna.saves.str !== false) {
  fail(`Zanna saves are ${JSON.stringify(zanna.saves)}`);
}

const { areaSquares, tokenCaught } = require('../public/rules.js');

function hasSquare(squares, x, y) {
  return squares.some((square) => square.x === x && square.y === y);
}

const sphere = areaSquares({ x: 0, y: 0, w: 1, h: 1 }, { x: 10, y: 10 }, { type: 'sphere', size: 20 });
if (!hasSquare(sphere, 10, 10)) fail('A 20-foot sphere left out its empty center');
if (!tokenCaught({ x: 10, y: 7, w: 1, h: 1 }, sphere)) fail('A token 15 ft from the center was not caught');
if (tokenCaught({ x: 10, y: 5, w: 1, h: 1 }, sphere)) fail('A token 25 ft from the center was caught');
const closeBurst = areaSquares({ x: 0, y: 0, w: 1, h: 1 }, { x: 10, y: 10 }, { type: 'sphere', size: 5 });
if (!tokenCaught({ x: 11, y: 10, w: 3, h: 3 }, closeBurst)) fail('A large token was not caught by one covered square');
if (tokenCaught({ x: 12, y: 10, w: 3, h: 3 }, closeBurst)) fail('A large token outside the sphere was caught');

const cube = areaSquares({ x: 0, y: 0, w: 1, h: 1 }, { x: 10, y: 10 }, { type: 'cube', size: 20 });
if (!hasSquare(cube, 12, 10) || hasSquare(cube, 13, 10)) fail('A 20-foot cube does not reach 10 feet');

const cone = areaSquares({ x: 5, y: 5, w: 1, h: 1 }, { x: 8, y: 5 }, { type: 'cone', size: 15, origin: 'self' });
if (!hasSquare(cone, 6, 5) || !hasSquare(cone, 8, 5) || !hasSquare(cone, 7, 6) || !hasSquare(cone, 8, 6)) {
  fail('The 15-foot cone missed a square it should cover');
}
if (hasSquare(cone, 6, 6) || hasSquare(cone, 9, 5) || hasSquare(cone, 5, 5)) {
  fail('The 15-foot cone covered a square outside its width');
}
if (areaSquares({ x: 5, y: 5, w: 1, h: 1 }, { x: 5, y: 5 }, { type: 'cone', size: 15, origin: 'self' }).length !== 0) {
  fail('A cone aimed at the caster produced squares');
}

const wave = areaSquares({ x: 5, y: 5, w: 1, h: 1 }, { x: 8, y: 5 }, { type: 'cube', size: 15, origin: 'self' });
if (!hasSquare(wave, 6, 5) || !hasSquare(wave, 6, 4) || !hasSquare(wave, 6, 6) || !hasSquare(wave, 8, 5)) {
  fail('The 15-foot self cube missed a square in front of the caster');
}
if (hasSquare(wave, 5, 5) || hasSquare(wave, 5, 6) || hasSquare(wave, 9, 5) || wave.length !== 9) {
  fail(`The 15-foot self cube covered the caster or the wrong count (${wave.length})`);
}

const line = areaSquares({ x: 5, y: 5, w: 1, h: 1 }, { x: 9, y: 5 }, { type: 'line', size: 20, width: 5, origin: 'self' });
if (!hasSquare(line, 9, 5) || hasSquare(line, 6, 6)) fail('The 5-foot line covered the wrong squares');
const wideLine = areaSquares({ x: 5, y: 5, w: 1, h: 1 }, { x: 9, y: 5 }, { type: 'line', size: 20, width: 10, origin: 'self' });
if (!hasSquare(wideLine, 6, 6)) fail('The 10-foot line missed a square 5 feet off the ray');

const disk = areaSquares({ x: 5, y: 5, w: 1, h: 1 }, { x: 5, y: 5 }, { type: 'radius', size: 15, origin: 'self' });
if (hasSquare(disk, 5, 5) || !hasSquare(disk, 8, 5) || hasSquare(disk, 9, 5)) {
  fail('A self disk covered the caster or the wrong radius');
}

const hugeWave = areaSquares({ x: 5, y: 5, w: 3, h: 3 }, { x: 10, y: 6 }, { type: 'cube', size: 15, origin: 'self' });
if (!hasSquare(hugeWave, 8, 5) || !hasSquare(hugeWave, 8, 7) || !hasSquare(hugeWave, 10, 6) || hasSquare(hugeWave, 7, 6) || hugeWave.length !== 9) {
  fail(`A cube on a huge token did not sit on its face (${hugeWave.length})`);
}

function blank(id, extra) {
  return Object.assign({
    id,
    name: id,
    team: 'monster',
    hp: 30,
    ac: 12,
    proficiency: 2,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    resist: [],
    immune: [],
    vuln: [],
    conditionImmune: [],
    saves: {},
    actions: [],
  }, extra);
}

function withRolls(values, fn) {
  const original = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

const caster = blank('caster', {
  name: 'Caster',
  actions: [
    {
      name: 'Bolt',
      kind: 'spell',
      saveAbility: 'dex',
      saveDc: 12,
      onSave: 'none',
      damage: [{ dice: '1d6', type: 'fire' }],
      range: { normal: 30, long: 30 },
    },
    {
      name: 'Flame',
      kind: 'spell',
      saveAbility: 'dex',
      saveDc: 10,
      onSave: 'half',
      damage: [{ dice: '1d6', type: 'fire' }],
      range: { normal: 30, long: 30 },
    },
    {
      name: 'Hold',
      kind: 'spell',
      saveAbility: 'wis',
      saveDc: 15,
      onSave: 'none',
      damage: [],
      conditions: ['paralyzed'],
      range: { normal: 60, long: 60 },
    },
    {
      name: 'Shove',
      kind: 'attack',
      saveAbility: 'str',
      saveDc: 10,
      onSave: 'half',
      damage: [{ dice: '1d6', type: 'force' }],
      reach: 5,
    },
    {
      name: 'Burst',
      kind: 'spell',
      saveAbility: 'dex',
      saveDc: 10,
      onSave: 'half',
      damage: [{ dice: '1d6', type: 'fire' }],
      range: { normal: 30, long: 30 },
      area: { type: 'sphere', size: 5 },
    },
  ],
});
const tough = blank('tough', { name: 'Tough', resist: ['fire'] });
const plain = blank('plain', { name: 'Plain' });
const evasionFeature = [{ name: 'Evasion', summary: 'No damage on a success, half on a failure.' }];
const slip = blank('slip', { name: 'Slip', features: evasionFeature });
const slipTough = blank('slip-tough', { name: 'Slip Tough', features: evasionFeature, resist: ['fire'] });
const saveCatalog = Object.assign({}, catalog, {
  caster, tough, plain, slip, [slipTough.id]: slipTough, [zanna.id]: zanna,
});

function placed(id, creature, name, x, y, extra) {
  return Object.assign({
    id,
    creatureId: creature.id,
    name,
    team: creature.team,
    x,
    y,
    w: 1,
    h: 1,
    hp: creature.hp,
    maxHp: creature.hp,
    defeated: false,
    conditions: [],
  }, extra);
}

const casterToken = placed(10, caster, 'Caster', 1, 1);
const toughToken = placed(11, tough, 'Tough', 2, 1);
const plainToken = placed(12, plain, 'Plain', 2, 1);

const failedSave = withRolls([0, 0], () => resolveAttack({
  attacker: casterToken,
  target: plainToken,
  actionName: 'Bolt',
  tokens: [casterToken, plainToken],
  catalog: saveCatalog,
}));
if (!failedSave.ok) fail(failedSave.error);
if (JSON.stringify(failedSave).indexOf('needs save rules') !== -1) fail('A Dexterity save was still rejected');
if (failedSave.targets[0].damage <= 0) fail('A failed Dexterity save dealt no damage');

const savedNone = withRolls([0, 0.95], () => resolveAttack({
  attacker: casterToken,
  target: plainToken,
  actionName: 'Bolt',
  tokens: [casterToken, plainToken],
  catalog: saveCatalog,
}));
if (!savedNone.ok || savedNone.targets[0].damage !== 0 || savedNone.outcome !== 'miss') {
  fail(`A successful save still dealt ${savedNone.targets && savedNone.targets[0].damage} (${savedNone.outcome})`);
}

const halved = withRolls([0.7, 0.95], () => resolveAttack({
  attacker: casterToken,
  target: toughToken,
  actionName: 'Flame',
  tokens: [casterToken, toughToken],
  catalog: saveCatalog,
}));
if (!halved.ok || !halved.dm.some((line) => line.indexOf('becomes 1') !== -1)) {
  fail(`Half damage was not applied before resistance:\n${(halved.dm || []).join('\n')}`);
}

const wisMod = Math.floor((zanna.abilities.wis - 10) / 2);
const wisBonus = wisMod + zanna.proficiency;
if (!(zanna.proficiency > 0) || wisBonus === wisMod) fail('Wisdom proficiency did not increase the save');
const zannaToken = placed(13, zanna, 'Zanna', 2, 1);
const wisSave = withRolls([0.45, 0], () => resolveAttack({
  attacker: casterToken,
  target: zannaToken,
  actionName: 'Hold',
  tokens: [casterToken, zannaToken],
  catalog: saveCatalog,
}));
const wisLine = `10 ${wisBonus >= 0 ? '+' : ''}${wisBonus} = ${10 + wisBonus}`;
if (!wisSave.ok || !wisSave.dm.some((line) => line.indexOf(wisLine) !== -1)) {
  fail(`Proficient Wisdom save was not ${wisLine}:\n${(wisSave.dm || []).join('\n')}`);
}

const held = withRolls([0], () => resolveAttack({
  attacker: casterToken,
  target: plainToken,
  actionName: 'Hold',
  tokens: [casterToken, plainToken],
  catalog: saveCatalog,
}));
if (!held.ok || !held.targets[0].conditions || held.targets[0].conditions[0] !== 'paralyzed') {
  fail(`A failed save did not store paralyzed: ${JSON.stringify(held.targets && held.targets[0])}`);
}
const resistedHold = withRolls([0.95], () => resolveAttack({
  attacker: casterToken,
  target: plainToken,
  actionName: 'Hold',
  tokens: [casterToken, plainToken],
  catalog: saveCatalog,
}));
if (!resistedHold.ok || (resistedHold.targets[0].conditions || []).length !== 0) {
  fail(`A successful save stored paralyzed: ${JSON.stringify(resistedHold.targets && resistedHold.targets[0])}`);
}

let saveRolls = 0;
const paralyzed = placed(14, plain, 'Plain', 2, 1, { conditions: ['paralyzed'] });
const originalRandom = Math.random;
Math.random = () => {
  saveRolls += 1;
  return 0;
};
let autoFail;
try {
  autoFail = resolveAttack({
    attacker: casterToken,
    target: paralyzed,
    actionName: 'Shove',
    tokens: [casterToken, paralyzed],
    catalog: saveCatalog,
  });
} finally {
  Math.random = originalRandom;
}
if (!autoFail.ok || saveRolls !== 1 || !autoFail.dm.some((line) => line.indexOf('save fails') !== -1)) {
  fail(`Paralyzed did not auto-fail the Strength save (${saveRolls} rolls):\n${(autoFail && autoFail.dm || []).join('\n')}`);
}

const slipToken = placed(15, slip, 'Slip', 5, 5);
const slipToughToken = placed(16, slipTough, 'Slip Tough', 5, 5);

function castAt(actionName, target, rolls) {
  return withRolls(rolls, () => resolveAttack({
    attacker: casterToken,
    target,
    actionName,
    tokens: [casterToken, target],
    catalog: saveCatalog,
  }));
}

const evaded = castAt('Flame', slipToken, [0.7, 0.95]);
if (!evaded.ok || evaded.targets[0].damage !== 0 || !evaded.dm.some((line) => line === 'fire: 5 becomes 0 (evasion).')) {
  fail(`Evasion on a success was not zero:\n${(evaded.dm || []).join('\n')}`);
}
if (evaded.pub.indexOf('saves against Flame') === -1) fail(`Player line changed: ${evaded.pub}`);

const evadedFail = castAt('Flame', slipToken, [0.7, 0]);
if (!evadedFail.ok || evadedFail.targets[0].damage !== 2 || !evadedFail.dm.some((line) => line === 'fire: 5 becomes 2 (halved, evasion).')) {
  fail(`Evasion on a failure was not half:\n${(evadedFail.dm || []).join('\n')}`);
}
if (evadedFail.pub.indexOf('hits Slip with Flame for 2 damage') === -1) fail(`Player line changed: ${evadedFail.pub}`);

const evadedResist = castAt('Flame', slipToughToken, [0.7, 0]);
if (!evadedResist.ok || !evadedResist.dm.some((line) => line === 'fire: 5 becomes 1 (halved, evasion, resistant).')) {
  fail(`Evasion was not applied before resistance:\n${(evadedResist.dm || []).join('\n')}`);
}

const slipNear = placed(24, slip, 'Slip', 2, 1);
const shoveEvade = castAt('Shove', slipNear, [0.7, 0.95]);
if (!shoveEvade.ok || shoveEvade.targets[0].damage !== 2 || shoveEvade.dm.some((line) => line.indexOf('evasion') !== -1)) {
  fail(`Evasion changed a Strength save:\n${(shoveEvade.dm || []).join('\n')}`);
}

const boltEvade = castAt('Bolt', slipToken, [0.7, 0]);
if (!boltEvade.ok || boltEvade.targets[0].damage !== 5 || boltEvade.dm.some((line) => line.indexOf('evasion') !== -1)) {
  fail(`Evasion changed a save that negates damage:\n${(boltEvade.dm || []).join('\n')}`);
}

const frozenSlip = placed(17, slip, 'Slip', 5, 5, { conditions: ['paralyzed'] });
const frozen = castAt('Flame', frozenSlip, [0.7]);
if (!frozen.ok || frozen.targets[0].damage !== 5 || frozen.dm.some((line) => line.indexOf('evasion') !== -1)) {
  fail(`A paralyzed evader did not take full damage:\n${(frozen.dm || []).join('\n')}`);
}

const heldSlip = placed(18, slip, 'Slip', 5, 5, { conditions: ['incapacitated'] });
const heldBack = castAt('Flame', heldSlip, [0.7, 0.95]);
if (!heldBack.ok || heldBack.targets[0].damage !== 2 || heldBack.dm.some((line) => line.indexOf('evasion') !== -1)) {
  fail(`Incapacitated Evasion still negated the damage:\n${(heldBack.dm || []).join('\n')}`);
}

const plainBeside = placed(19, plain, 'Plain', 5, 6);
const burst = withRolls([0.7, 0.95], () => resolveAttack({
  attacker: casterToken,
  actionName: 'Burst',
  square: { x: 5, y: 5 },
  tokens: [casterToken, slipToken, plainBeside],
  catalog: saveCatalog,
}));
if (!burst.ok) fail(burst.error);
const burstSlip = burst.targets.find((entry) => entry.id === slipToken.id);
const burstPlain = burst.targets.find((entry) => entry.id === plainBeside.id);
if (!burstSlip || burstSlip.damage !== 0 || !burstPlain || burstPlain.damage !== 2) {
  fail(`Area Evasion did not split the roll: ${JSON.stringify(burst.targets)}`);
}
if (!burst.dm.some((line) => line === 'fire: 5 becomes 0 (evasion).') || !burst.dm.some((line) => line === 'fire: 5 becomes 2 (halved).')) {
  fail(`Area log did not separate Evasion from a normal save:\n${burst.dm.join('\n')}`);
}

const perrin = catalog.PerrinLv11000000;
const assassin = catalog.mmAssassin000000;
if (!(perrin.features || []).some((feature) => feature.name === 'Evasion')) fail('Perrin (11) has no Evasion feature');
if (!(assassin.traits || []).some((trait) => trait.name === 'Evasion')) fail('Assassin has no Evasion trait');

const zannaWave = catalog.ZannaLv010000000.actions.find((action) => action.name === 'Thunderwave');
if (!zannaWave || zannaWave.reach || !zannaWave.area || zannaWave.area.type !== 'cube' || zannaWave.area.size !== 15 || zannaWave.area.origin !== 'self') {
  fail(`Zanna Thunderwave is ${JSON.stringify(zannaWave && zannaWave.area)}`);
}
const burning = catalog.MorthosLv0100000.actions.find((action) => action.name === 'Burning Hands');
if (!burning || burning.reach || !burning.area || burning.area.origin !== 'self' || burning.area.type !== 'cone' || burning.area.size !== 15) {
  fail(`Burning Hands is ${JSON.stringify(burning && burning.area)}`);
}
const redBreath = catalog.mmAdultRedDragon.actions.find((action) => action.name === 'Fire Breath');
if (!redBreath || !redBreath.area || redBreath.area.type !== 'cone' || redBreath.area.size !== 60 || redBreath.area.origin !== 'self') {
  fail(`Adult Red Fire Breath is ${JSON.stringify(redBreath && redBreath.area)}`);
}
const banish = catalog.mmAdultGoldDrago.actions.find((action) => action.name === 'Banish');
if (!banish || banish.area || banish.reach || !banish.range || banish.range.normal !== 120) {
  fail(`Banish is ${JSON.stringify(banish && { area: banish.area, range: banish.range, reach: banish.reach })}`);
}
const goldToken = placed(50, catalog.mmAdultGoldDrago, 'Adult Gold Dragon', 0, 0, { w: 3, h: 3 });
const banished = placed(51, plain, 'Banished', 8, 0);
const tooFar = placed(52, plain, 'Too Far', 30, 0);
const goldCatalog = Object.assign({}, saveCatalog, { mmAdultGoldDrago: catalog.mmAdultGoldDrago });
if (feetBetween(goldToken, banished) !== 30) fail(`Banish fixture is ${feetBetween(goldToken, banished)} ft away`);
const nearBanish = withRolls([0, 0], () => resolveAttack({
  attacker: goldToken,
  target: banished,
  actionName: 'Banish',
  tokens: [goldToken, banished],
  catalog: goldCatalog,
}));
if (!nearBanish.ok) fail(nearBanish.error);
const farBanish = resolveAttack({
  attacker: goldToken,
  target: tooFar,
  actionName: 'Banish',
  tokens: [goldToken, tooFar],
  catalog: goldCatalog,
});
if (farBanish.ok) fail('Banish reached past 120 feet');

const breather = blank('breather', {
  name: 'Breather',
  actions: [{
    name: 'Puff',
    kind: 'spell',
    saveAbility: 'dex',
    saveDc: 10,
    onSave: 'none',
    damage: [{ dice: '1d6', type: 'fire' }],
    area: { type: 'cone', size: 15, origin: 'self' },
  }],
});
const breathCatalog = Object.assign({}, saveCatalog, { breather });
const breatherToken = placed(30, breather, 'Breather', 1, 1);
const puffTarget = placed(31, plain, 'Plain', 2, 1);
const puffFar = placed(32, plain, 'Far', 5, 1);
const puff = withRolls([0.7, 0], () => resolveAttack({
  attacker: breatherToken,
  actionName: 'Puff',
  square: { x: 4, y: 1 },
  tokens: [breatherToken, puffTarget, puffFar],
  catalog: breathCatalog,
}));
if (!puff.ok) fail(puff.error);
const puffIds = puff.targets.map((entry) => entry.id);
if (puffIds.length !== 1 || puffIds[0] !== puffTarget.id) {
  fail(`A self cone caught ${puffIds.join(', ')} instead of only the creature in front`);
}
const puffSelf = withRolls([0.7], () => resolveAttack({
  attacker: breatherToken,
  actionName: 'Puff',
  square: { x: 1, y: 1 },
  tokens: [breatherToken, puffTarget],
  catalog: breathCatalog,
}));
if (puffSelf.ok) fail('Aiming a cone at the caster was accepted');

const mage = catalog.mmMage0000000000;
const fireball = mage.actions.find((action) => action.name === 'Fireball');
if (!fireball || !fireball.area || fireball.area.type !== 'sphere' || fireball.area.size !== 20 || fireball.area.origin !== 'point' || fireball.targets) {
  fail(`Mage Fireball area is ${JSON.stringify(fireball && { area: fireball.area, targets: fireball.targets })}`);
}
const mageToken = token(20, mage.id, 'Mage', 0, 0);
const nearToken = token(21, goblin.id, 'Near', 10, 7);
const farToken = token(22, goblin.id, 'Far', 10, 5);
const blast = resolveAttack({
  attacker: mageToken,
  actionName: 'Fireball',
  square: { x: 10, y: 10 },
  tokens: [mageToken, nearToken, farToken],
  catalog,
});
if (!blast.ok) fail(blast.error);
const blasted = blast.targets.map((entry) => entry.id);
if (blasted.length !== 1 || blasted[0] !== nearToken.id) {
  fail(`Fireball on an empty square caught ${blasted.join(', ')}`);
}

const wall = areaSquares({ x: 0, y: 5, w: 1, h: 1 }, { x: 10, y: 5 }, { type: 'wall', size: 60, width: 5, origin: 'point' });
if (!wall.length) fail('A placed wall produced no squares');
if (!hasSquare(wall, 10, 5) || !hasSquare(wall, 4, 5) || !hasSquare(wall, 16, 5)) {
  fail('A 60-foot wall missed a square along its length');
}
if (hasSquare(wall, 3, 5) || hasSquare(wall, 17, 5) || hasSquare(wall, 10, 6)) {
  fail('A 60-foot wall covered a square outside it');
}
const thinWall = areaSquares({ x: 0, y: 5, w: 1, h: 1 }, { x: 10, y: 5 }, { type: 'wall', size: 60, width: 0.5, origin: 'point' });
if (!thinWall.length || !hasSquare(thinWall, 10, 5) || hasSquare(thinWall, 10, 6)) {
  fail('A wall thinner than 5 feet did not fill one row of squares');
}

const green = catalog.mmAdultGreenDrag;
const poison = green && green.actions.find((action) => action.name === 'Poison Breath');
if (green && green.type !== 'dragon') fail(`Adult Green type is ${green && green.type}`);
if (!poison || !poison.area || poison.area.type !== 'cone' || poison.area.size !== 60 || poison.area.origin !== 'self') {
  fail(`Adult Green Poison Breath is ${JSON.stringify(poison && poison.area)}`);
}
if (green && green.actions.some((action) => action.name === 'Save')) fail('Adult Green still has an action named Save');

const ancientBreath = catalog.mmAncientGreenDr && catalog.mmAncientGreenDr.actions.find((action) => action.name === 'Poison Breath');
if (!ancientBreath || !ancientBreath.area || ancientBreath.area.type !== 'cone' || ancientBreath.area.size !== 15 || ancientBreath.area.origin !== 'self') {
  fail(`Ancient Green Poison Breath is ${JSON.stringify(ancientBreath && ancientBreath.area)}`);
}

const morthos = catalog.MorthosLv0500000;
const exhale = morthos && morthos.actions.find((action) => action.name === 'Exhale');
if (!exhale || !exhale.area || exhale.area.type !== 'cone' || exhale.area.size !== 15 || exhale.area.origin !== 'self' || exhale.reach) {
  fail(`Exhale is ${JSON.stringify(exhale && { area: exhale.area, reach: exhale.reach })}`);
}

const sefris = catalog.SefrisLv05000000;
const holdPerson = sefris && sefris.actions.find((action) => action.name === 'Hold Person');
if (!holdPerson || holdPerson.area || !holdPerson.targets || holdPerson.targets[0] !== 'humanoid') {
  fail(`Hold Person targets are ${JSON.stringify(holdPerson && holdPerson.targets)}`);
}
const guard = catalog.mmGuard000000000;
if (!guard || guard.type !== 'humanoid') fail(`Guard type is ${guard && guard.type}`);
if (goblin.type !== 'fey') fail(`Goblin type is ${goblin.type}`);
const holder = placed(60, sefris, 'Sefris', 1, 1);
const heldGuard = placed(61, guard, 'Guard', 2, 1);
const heldGoblin = placed(64, goblin, 'Goblin', 3, 1);
const heldDragon = placed(62, green, 'Adult Green Dragon', 5, 1);
const holdCatalog = Object.assign({}, catalog);
const heldGuardResult = withRolls([0], () => resolveAttack({
  attacker: holder,
  target: heldGuard,
  actionName: 'Hold Person',
  tokens: [holder, heldGuard],
  catalog: holdCatalog,
}));
if (!heldGuardResult.ok) fail(heldGuardResult.error);
const refusedGoblin = resolveAttack({
  attacker: holder,
  target: heldGoblin,
  actionName: 'Hold Person',
  tokens: [holder, heldGoblin],
  catalog: holdCatalog,
});
if (refusedGoblin.ok || refusedGoblin.error.indexOf('humanoid') === -1 || refusedGoblin.error.indexOf('fey') === -1) {
  fail(`Hold Person against a goblin was ${refusedGoblin.ok ? 'accepted' : refusedGoblin.error}`);
}
const refusedHold = resolveAttack({
  attacker: holder,
  target: heldDragon,
  actionName: 'Hold Person',
  tokens: [holder, heldDragon],
  catalog: holdCatalog,
});
if (refusedHold.ok || refusedHold.error.indexOf('humanoid') === -1 || refusedHold.error.indexOf('dragon') === -1) {
  fail(`Hold Person against a dragon was ${refusedHold.ok ? 'accepted' : refusedHold.error}`);
}
const plainFolk = blank('folk', { team: 'player', type: null, actions: [] });
const folkToken = placed(63, plainFolk, 'Folk', 2, 1);
folkToken.team = 'player';
const folkCatalog = Object.assign({}, holdCatalog, { folk: plainFolk });
const heldFolk = withRolls([0.95], () => resolveAttack({
  attacker: holder,
  target: folkToken,
  actionName: 'Hold Person',
  tokens: [holder, folkToken],
  catalog: folkCatalog,
}));
if (!heldFolk.ok) fail(heldFolk.error || 'A player with no type was refused by Hold Person');

const akra = catalog.AkraLv0500000000;
const sear = akra && akra.actions.find((action) => action.name === 'Channel Divinity: Turn Undead');
const turn = akra && akra.actions.find((action) => action.name === 'Turn Undead');
if (!turn || turn.area || !turn.targets || turn.targets[0] !== 'undead') {
  fail(`Turn Undead is ${JSON.stringify(turn && { area: turn.area, targets: turn.targets })}`);
}
if (!sear || !sear.area || sear.area.type !== 'radius' || sear.area.size !== 30 || sear.area.origin !== 'self' || !sear.targets || sear.targets[0] !== 'undead') {
  fail(`Sear Undead is ${JSON.stringify(sear && { area: sear.area, targets: sear.targets })}`);
}
const zombie = catalog.mmZombie00000000;
if (!zombie || zombie.type !== 'undead') fail(`Zombie type is ${zombie && zombie.type}`);
const cleric = placed(70, akra, 'Akra', 1, 1);
const zombieToken = placed(71, zombie, 'Zombie 1', 2, 1);
const scoutToken = placed(72, goblin, 'Scout', 4, 1);
const searResult = withRolls([0, 0], () => resolveAttack({
  attacker: cleric,
  actionName: 'Channel Divinity: Turn Undead',
  square: { x: 2, y: 1 },
  tokens: [cleric, zombieToken, scoutToken],
  catalog,
}));
if (!searResult.ok) fail(searResult.error);
const searText = searResult.dm.join('\n');
const searIds = searResult.targets.map((entry) => entry.id);
if (searIds.length !== 1 || searIds[0] !== zombieToken.id || searText.indexOf('Zombie 1') === -1 || searText.indexOf('save') === -1) {
  fail(`Sear Undead caught ${searIds.join(', ')}:\n${searText}`);
}
if (searText.indexOf('Scout') !== -1 || searText.indexOf('Only undead') === -1) {
  fail(`Sear Undead did not limit the area to undead:\n${searText}`);
}
const turned = withRolls([0], () => resolveAttack({
  attacker: cleric,
  target: zombieToken,
  actionName: 'Turn Undead',
  tokens: [cleric, zombieToken],
  catalog,
}));
if (!turned.ok) fail(turned.error);
const refusedTurn = resolveAttack({
  attacker: cleric,
  target: scoutToken,
  actionName: 'Turn Undead',
  tokens: [cleric, scoutToken],
  catalog,
});
if (refusedTurn.ok || refusedTurn.error.indexOf('undead') === -1) {
  fail(`Turn Undead against a goblin was ${refusedTurn.ok ? 'accepted' : refusedTurn.error}`);
}

console.log(`${goblin.name} AC ${goblin.ac}, token ${goblin.token}`);
console.log(`${zanna.name} ${zanna.class}, Magic Missile ${missile.damage[0].dice} x${missile.damage[0].darts}`);
console.log(result.pub);
console.log(`Wisdom save bonus ${wisBonus}; sphere squares ${sphere.length}`);
