// Checks initiative and the monster script. The first half uses tiny made-up
// creatures so the logic is tested on its own. The second half runs against the
// real exported data. Run: node combat/initiative-test.js
const assert = require('assert');
const init = require('./initiative.js');
const { nextMonsterStep, runMonsterTurn } = require('./monsterTurn.js');
const { resolveAttack } = require('./attack.js');

const abilities = (dex) => ({ str: 10, dex, con: 10, int: 10, wis: 10, cha: 10 });

const catalog = {
  hero: {
    id: 'hero', name: 'Hero', team: 'player', ac: 15, hp: 30, speed: 30, proficiency: 2,
    abilities: abilities(14), actions: [
      { name: 'Sword', kind: 'weapon', properties: [], reach: 5, damage: [{ dice: '1d8', type: 'slashing' }] },
    ],
  },
  zombie: {
    id: 'zombie', name: 'Zombie', team: 'monster', ac: 8, hp: 22, speed: 20,
    abilities: abilities(6), actions: [
      { name: 'Slam', kind: 'attack', toHit: 3, reach: 5, damage: [{ dice: '1d6+1', type: 'bludgeoning' }] },
    ],
  },
  goblin: {
    id: 'goblin', name: 'Goblin', team: 'monster', ac: 15, hp: 7, speed: 30,
    abilities: abilities(14), actions: [
      { name: 'Scimitar', kind: 'attack', toHit: 4, reach: 5, damage: [{ dice: '1d6+2', type: 'slashing' }] },
      { name: 'Shortbow', kind: 'attack', toHit: 4, range: { normal: 80, long: 320 }, damage: [{ dice: '1d6+2', type: 'piercing' }] },
    ],
  },
  twin: {
    id: 'twin', name: 'Twin Blade', team: 'monster', ac: 12, hp: 20, speed: 30, attacksPerAction: 2,
    abilities: abilities(10), actions: [
      { name: 'Blade', kind: 'attack', toHit: 4, reach: 5, damage: [{ dice: '1d6', type: 'slashing' }] },
    ],
  },
};

let nextId = 1;
function token(creatureId, name, x, y) {
  const c = catalog[creatureId];
  const w = c.width || 1;
  const h = c.height || 1;
  return { id: nextId++, creatureId, name, team: c.team, x, y, w, h, hp: c.hp, maxHp: c.hp, defeated: false };
}

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log('ok  ' + label);
}

// Advances turns until the given token is up, so tests can pick who acts.
function advanceTo(tracker, tokens, id) {
  for (let i = 0; i < 20 && init.currentTokenId(tracker) !== id; i++) {
    init.endTurn(tracker, tokens, catalog);
  }
}

// ---------- Initiative ----------

check('order is sorted high to low and starts at round 1', () => {
  const tokens = [token('hero', 'Hero', 1, 1), token('goblin', 'Goblin 1', 5, 5), token('zombie', 'Zombie 1', 8, 8)];
  const tracker = init.createTracker();
  init.startCombat(tracker, tokens, catalog);
  const totals = tracker.order.map((e) => e.total);
  assert.deepStrictEqual(totals, [...totals].sort((a, b) => b - a));
  assert.strictEqual(tracker.round, 1);
  assert.strictEqual(init.currentTokenId(tracker), tracker.order[0].tokenId);
});

check('rounds increase after everyone has gone, defeated tokens are skipped', () => {
  const tokens = [token('hero', 'Hero', 1, 1), token('goblin', 'Goblin 1', 5, 5), token('zombie', 'Zombie 1', 8, 8)];
  const tracker = init.createTracker();
  init.startCombat(tracker, tokens, catalog);
  tokens[1].defeated = true;
  const seen = [];
  for (let i = 0; i < 4; i++) {
    seen.push(init.currentTokenId(tracker));
    init.endTurn(tracker, tokens, catalog);
  }
  assert.ok(!seen.includes(tokens[1].id), 'defeated goblin got a turn');
  assert.strictEqual(tracker.round, 3);
});

check('joining mid-fight keeps the current turn where it was', () => {
  const tokens = [token('hero', 'Hero', 1, 1), token('goblin', 'Goblin 1', 5, 5)];
  const tracker = init.createTracker();
  init.startCombat(tracker, tokens, catalog);
  const before = init.currentTokenId(tracker);
  const late = token('zombie', 'Zombie 1', 8, 8);
  tokens.push(late);
  init.addToCombat(tracker, late, catalog);
  assert.strictEqual(init.currentTokenId(tracker), before);
  assert.strictEqual(tracker.order[tracker.turnIndex].tokenId, before);
  assert.strictEqual(tracker.order.length, 3);
});

check('removing the acting token passes the turn on', () => {
  const tokens = [token('hero', 'Hero', 1, 1), token('goblin', 'Goblin 1', 5, 5), token('zombie', 'Zombie 1', 8, 8)];
  const tracker = init.createTracker();
  init.startCombat(tracker, tokens, catalog);
  const acting = init.currentTokenId(tracker);
  const nextUp = tracker.order[1].tokenId;
  tokens.splice(tokens.findIndex((t) => t.id === acting), 1);
  init.removeFromCombat(tracker, acting, tokens, catalog);
  assert.strictEqual(init.currentTokenId(tracker), nextUp);
});

// ---------- Action economy ----------

check('only the acting token may attack, and one action means one attack', () => {
  const tokens = [token('hero', 'Hero', 1, 1), token('goblin', 'Goblin 1', 5, 5)];
  const tracker = init.createTracker();
  init.startCombat(tracker, tokens, catalog);
  const actor = tokens.find((t) => t.id === init.currentTokenId(tracker));
  const other = tokens.find((t) => t.id !== actor.id);
  assert.strictEqual(init.checkAttack(tracker, other.id).ok, false);
  assert.strictEqual(init.spendAttack(tracker, actor.id, catalog[actor.creatureId]).ok, true);
  assert.strictEqual(init.checkAttack(tracker, actor.id).ok, false);
});

check('attacksPerAction gives extra swings, and a new turn resets them', () => {
  const twin = token('twin', 'Twin Blade', 1, 1);
  const hero = token('hero', 'Hero', 5, 5);
  const tokens = [twin, hero];
  const tracker = init.createTracker();
  init.startCombat(tracker, tokens, catalog);
  advanceTo(tracker, tokens, twin.id);
  const creature = catalog.twin;
  assert.ok(init.spendAttack(tracker, twin.id, creature).ok);
  assert.ok(init.spendAttack(tracker, twin.id, creature).ok);
  assert.strictEqual(init.checkAttack(tracker, twin.id).ok, false);
  advanceTo(tracker, tokens, hero.id);
  advanceTo(tracker, tokens, twin.id);
  assert.ok(init.checkAttack(tracker, twin.id).ok);
});

check('movement is limited by speed', () => {
  const tokens = [token('hero', 'Hero', 1, 1), token('goblin', 'Goblin 1', 5, 5)];
  const tracker = init.createTracker();
  init.startCombat(tracker, tokens, catalog);
  const id = init.currentTokenId(tracker);
  const speed = catalog[tokens.find((t) => t.id === id).creatureId].speed;
  assert.ok(init.spendMovement(tracker, id, speed).ok);
  assert.strictEqual(init.spendMovement(tracker, id, 5).ok, false);
});

check('victory is detected', () => {
  const tokens = [token('hero', 'Hero', 1, 1), token('goblin', 'Goblin 1', 5, 5)];
  assert.strictEqual(init.checkVictory(tokens), null);
  tokens[1].defeated = true;
  assert.strictEqual(init.checkVictory(tokens), 'players');
});

// ---------- Monster script ----------

// A tiny stand-in for the server: same rules calls, no sockets.
function makeWorld(tokens) {
  const world = { tokens, tracker: init.createTracker(), attacks: [], moves: [] };

  world.performAttack = (attacker, step) => {
    const target = world.tokens.find((t) => t.id === step.targetId);
    const check = init.checkAttack(world.tracker, attacker.id);
    if (!check.ok) return check;
    const result = resolveAttack({ attacker, target, actionName: step.actionName, tokens: world.tokens, catalog });
    if (!result.ok) return result;
    init.spendAttack(world.tracker, attacker.id, catalog[attacker.creatureId]);
    target.hp = result.hpAfter;
    target.defeated = result.defeated;
    world.attacks.push(step.actionName);
    return { ok: true };
  };

  world.performMove = (mover, step) => {
    const spent = init.spendMovement(world.tracker, mover.id, step.feet);
    if (!spent.ok) return spent;
    mover.x = step.x;
    mover.y = step.y;
    world.moves.push({ x: step.x, y: step.y });
    return { ok: true };
  };

  world.run = async (mover) => {
    init.startCombat(world.tracker, world.tokens, catalog);
    advanceTo(world.tracker, world.tokens, mover.id);
    await runMonsterTurn({
      token: mover,
      getTokens: () => world.tokens,
      catalog,
      tracker: world.tracker,
      performMove: world.performMove,
      performAttack: world.performAttack,
      pause: async () => {},
    });
  };
  return world;
}

async function monsterTests() {
  // Far-off zombie can only walk. Speed 20 is 4 squares, so it ends 6 squares away.
  let hero = token('hero', 'Hero', 10, 5);
  let zombie = token('zombie', 'Zombie 1', 0, 5);
  let world = makeWorld([hero, zombie]);
  await world.run(zombie);
  assert.strictEqual(zombie.x, 4);
  assert.strictEqual(world.attacks.length, 0);
  passed++; console.log('ok  melee monster walks as far as its speed allows');

  // Zombie 5 squares away: walks 4 to become adjacent, then slams once.
  hero = token('hero', 'Hero', 10, 5);
  zombie = token('zombie', 'Zombie 1', 5, 5);
  world = makeWorld([hero, zombie]);
  await world.run(zombie);
  assert.strictEqual(world.attacks.length, 1);
  assert.ok(Math.max(Math.abs(zombie.x - hero.x), Math.abs(zombie.y - hero.y)) === 1);
  passed++; console.log('ok  monster closes in and attacks in the same turn');

  // Goblin has a bow, so at 25 ft it shoots without moving.
  hero = token('hero', 'Hero', 10, 5);
  let goblin = token('goblin', 'Goblin 1', 5, 5);
  world = makeWorld([hero, goblin]);
  await world.run(goblin);
  assert.deepStrictEqual(world.attacks, ['Shortbow']);
  assert.strictEqual(world.moves.length, 0);
  passed++; console.log('ok  ranged monster shoots instead of walking');

  // Multiattack monster swings twice, then stops.
  hero = token('hero', 'Hero', 5, 5);
  const twin = token('twin', 'Twin Blade', 4, 5);
  world = makeWorld([hero, twin]);
  await world.run(twin);
  assert.strictEqual(world.attacks.length, 2);
  passed++; console.log('ok  two-attack monster attacks twice');

  // Picks the nearer enemy.
  const near = token('hero', 'Near Hero', 6, 5);
  const far = token('hero', 'Far Hero', 12, 5);
  zombie = token('zombie', 'Zombie 1', 5, 5);
  const step = nextMonsterStep({
    token: zombie, tokens: [near, far, zombie], catalog,
    turn: { actionUsed: false, attacksLeft: 0, movementLeft: 20 },
  });
  assert.strictEqual(step.type, 'attack');
  assert.strictEqual(step.targetId, near.id);
  passed++; console.log('ok  targets the nearest enemy');

  // Nobody left to fight ends the turn.
  zombie = token('zombie', 'Zombie 1', 5, 5);
  const none = nextMonsterStep({
    token: zombie, tokens: [zombie], catalog,
    turn: { actionUsed: false, attacksLeft: 0, movementLeft: 20 },
  });
  assert.strictEqual(none.type, 'end');
  passed++; console.log('ok  ends turn when there are no targets');
}

// ---------- Real exported data ----------

async function realDataTests() {
  const monsters = require('../data/monsters.json');
  const characters = require('../data/characters.json');
  [...monsters, ...characters].forEach((c) => (catalog[c.id] = c));
  const named = (list, name) => list.find((c) => c.name === name);
  const feetGap = require('../public/rules.js').feetBetween;

  // Attack counts come out of the Multiattack and Extra Attack text.
  assert.strictEqual(init.attacksPerAction(named(monsters, 'Owlbear')), 2);
  assert.strictEqual(init.attacksPerAction(named(monsters, 'Adult Black Dragon')), 3);
  assert.strictEqual(init.attacksPerAction(named(monsters, 'Goblin Warrior')), 1);
  assert.strictEqual(init.attacksPerAction(named(characters, 'Krusk (11)')), 2);
  passed++; console.log('ok  attack counts are read from Multiattack and Extra Attack text');

  // Every exported character has speed 0, so a turn must still give them movement.
  const zanna = token(named(characters, 'Zanna (5)').id, 'Zanna (5)', 1, 1);
  const rat = token(named(monsters, 'Goblin Warrior').id, 'Goblin 1', 5, 5);
  const tracker = init.createTracker();
  init.startCombat(tracker, [zanna, rat], catalog);
  advanceTo(tracker, [zanna, rat], zanna.id);
  assert.strictEqual(tracker.turn.movementLeft, 30);
  passed++; console.log('ok  speed 0 in the data falls back to 30 ft of movement');

  // A 2x2 owlbear walks up to a hero 8 squares away, stays inside the room,
  // never overlaps anyone, and uses both Multiattack swings.
  const hero = token(named(characters, 'Krusk (5)').id, 'Krusk (5)', 10, 1);
  hero.hp = 999;
  const owlbear = token(named(monsters, 'Owlbear').id, 'Owlbear 1', 1, 1);
  const world = makeWorld([hero, owlbear]);
  await world.run(owlbear);
  assert.ok(feetGap(owlbear, hero) <= 5, 'owlbear did not reach the hero');
  assert.strictEqual(world.attacks.length, 2);
  assert.ok(owlbear.x + owlbear.w <= 20 && owlbear.y + owlbear.h <= 14, 'owlbear left the room');
  const overlaps = owlbear.x < hero.x + hero.w && hero.x < owlbear.x + owlbear.w
    && owlbear.y < hero.y + hero.h && hero.y < owlbear.y + owlbear.h;
  assert.ok(!overlaps, 'owlbear is standing on the hero');
  const moved = Math.max(Math.abs(owlbear.x - 1), Math.abs(owlbear.y - 1)) * 5;
  assert.ok(moved <= 40, 'owlbear moved farther than its speed');
  passed++; console.log('ok  large monster closes in, respects footprint, and uses Multiattack');

  // Smoke test: the script must give a valid answer for all 380 monsters.
  const standIn = token(named(characters, 'Zanna (5)').id, 'Zanna (5)', 15, 8);
  let counts = { attack: 0, move: 0, end: 0 };
  monsters.forEach((m) => {
    const t = token(m.id, m.name, 1, 1);
    const step = nextMonsterStep({
      token: t, tokens: [t, standIn], catalog,
      turn: { actionUsed: false, attacksLeft: 0, movementLeft: 30 },
    });
    assert.ok(['attack', 'move', 'end'].includes(step.type), m.name + ' gave a bad step');
    counts[step.type]++;
  });
  passed++; console.log(`ok  all ${monsters.length} monsters produce a valid step ` +
    `(attack ${counts.attack}, move ${counts.move}, end ${counts.end})`);
}

monsterTests().then(realDataTests).then(() => console.log(`\nAll ${passed} checks passed.`)).catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
