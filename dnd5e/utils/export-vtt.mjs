import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "js-yaml";

/**
 * Write the battlemat's characters.json and monsters.json from the 2024 actor packs.
 * The battlemat still loads those two files. This replaces the hand-written party.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTORS = path.join(ROOT, "packs/_source/actors24");
const VTT_DATA = path.resolve(ROOT, "../data");
const DICE = /^(\d+)d(\d+)([+-]\d+)?$/;

const SIZES = {
  tiny: "tiny",
  sm: "small",
  med: "medium",
  lg: "large",
  huge: "huge",
  grg: "gargantuan"
};

const PROPERTIES = {
  fin: "finesse",
  thr: "thrown",
  lgt: "light",
  two: "two-handed",
  lod: "loading",
  ver: "versatile",
  amm: "ammunition",
  hvy: "heavy",
  rch: "reach"
};

const ARMOR = new Set(["light", "medium", "heavy"]);

const CREATURE_TYPES = [
  "aberration", "beast", "celestial", "construct", "dragon", "elemental",
  "fey", "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"
];
const CREATURE_TYPE_SET = new Set(CREATURE_TYPES);
const TARGET_FILLER = new Set(["of", "your", "choice", "or", "and", "a", "an", "the", "that", "target", "is"]);
const SCALES = loadScales();

/**
 * Class scale tables, keyed as "fighter:second-wind". The title is used when
 * the advancement left its identifier blank.
 * @returns {Map<string, { level: number, value: number|null, faces: number|null }[]>}
 */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function loadScales() {
  const map = new Map();
  const root = path.join(ROOT, "packs/_source/classes24");
  if (!fs.existsSync(root)) return map;
  for (const className of fs.readdirSync(root)) {
    const file = path.join(root, className, `${className}.yml`);
    if (!fs.existsSync(file)) continue;
    const doc = YAML.load(fs.readFileSync(file, "utf8"));
    // Some class files store advancement as a list, others as an id-keyed map.
    for (const adv of asList(doc?.system?.advancement)) {
      if (adv.type !== "ScaleValue") continue;
      const rows = Object.entries(adv.configuration?.scale ?? {}).map(([level, entry]) => ({
        level: Number(level),
        value: typeof entry?.value === "number" ? entry.value : null,
        faces: typeof entry?.faces === "number" ? entry.faces : null
      })).filter(row => Number.isFinite(row.level));
      rows.sort((a, b) => a.level - b.level);
      const keys = [adv.configuration?.identifier, slug(adv.title)].filter(Boolean);
      for (const key of keys) map.set(`${className}:${key}`, rows);
    }
  }
  return map;
}

/**
 * @param {string} text
 * @returns {string}
 */
function slug(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Highest scale row at or below a level.
 * @param {string} className
 * @param {string} key
 * @param {number} level
 * @returns {{ value: number|null, faces: number|null }|null}
 */
function scaleAt(className, key, level) {
  const rows = SCALES.get(`${className}:${key}`);
  if (!rows) return null;
  let found = null;
  for (const row of rows) {
    if (row.level <= level) found = row;
  }
  return found;
}

/**
 * @param {object} doc
 * @returns {Record<string, number>}
 */
function classLevels(doc) {
  const levels = {};
  for (const item of doc.items ?? []) {
    if (item.type === "class" && item.name) levels[item.name.toLowerCase()] = Number(item.system?.levels) || 0;
  }
  return levels;
}

/**
 * @param {object} item
 * @param {object} activity
 * @returns {"action"|"bonus"|"reaction"|"special"}
 */
function activationOf(item, activity) {
  const raw = activity.activation?.type || item.system?.activation?.type || "";
  if (raw === "bonus" || raw === "reaction" || raw === "special") return raw;
  return "action";
}

/**
 * @param {string|number|null|undefined} text
 * @param {{ abilities: Record<string, number>, levels: Record<string, number>, level: number }} ctx
 * @returns {number|null}
 */
function evalUses(text, ctx) {
  if (text == null || text === "") return null;
  const raw = String(text).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const scale = /^@scale\.([a-z]+)\.([a-z0-9.-]+)$/.exec(raw);
  if (scale) {
    const row = scaleAt(scale[1], scale[2], ctx.level);
    return row && typeof row.value === "number" ? row.value : null;
  }
  if (/^max\(1,\s*@abilities\.cha\.mod\)$/.test(raw)) return Math.max(1, abilityMod(ctx.abilities.cha));
  if (/^5 \* @classes\.paladin\.levels$/.test(raw)) return 5 * (ctx.levels.paladin || 0);
  return null;
}

/**
 * @param {object} item
 * @param {object} doc
 * @param {Record<string, number>} abilities
 * @param {number} level
 * @returns {number|null}
 */
function itemUses(item, doc, abilities, level) {
  const ctx = { abilities, levels: classLevels(doc), level };
  const fromMax = evalUses(item.system?.uses?.max, ctx);
  if (item.type === "consumable") {
    const qty = Number(item.system?.quantity) || 1;
    return (fromMax || 1) * qty;
  }
  return fromMax;
}

/**
 * @param {object} activity
 * @param {Record<string, number>} levels
 * @returns {string|null}
 */
function healDice(activity, levels) {
  const heal = activity.healing;
  if (!heal) return null;
  const entry = damageEntry(heal, 0, false);
  if (!entry) return null;
  const bonus = String(heal.bonus ?? "");
  const classBonus = /^@classes\.([a-z]+)\.levels$/.exec(bonus);
  if (!classBonus) return entry.dice;
  const extra = levels[classBonus[1]] || 0;
  if (!extra) return entry.dice;
  return /[+-]/.test(entry.dice) ? entry.dice : `${entry.dice}+${extra}`;
}

/**
 * @param {object} item
 * @param {object} activity
 * @returns {string}
 */
function profileFor(item, activity) {
  const itemName = item.name || "";
  const activityName = activity.name || "";
  const both = `${itemName} ${activityName}`.toLowerCase();
  if (activityName === "Dash" || /adrenaline rush: dash/.test(both)) return "dash";
  if (activityName === "Disengage") return "disengage";
  if (activityName === "Hide") return "hide";
  if (/steady aim/.test(both)) return "steady-aim";
  if (itemName === "Rage" || activityName === "Expend Rage") return "rage";
  if (/patient defense/.test(both)) return "patient-defense";
  if (/flurry of blows/.test(both)) return "flurry";
  if (/step of the wind/.test(both)) return "step";
  if (itemName === "Bardic Inspiration") return "bardic";
  if (/remove poison/.test(both)) return "remove-poison";
  if (itemName === "Lay on Hands") return "lay-on-hands";
  if (itemName === "Action Surge") return "action-surge";
  if (itemName === "Second Wind") return "second-wind";
  return "log";
}

/**
 * @param {object} item
 * @param {object} activity
 * @param {boolean} monster
 * @returns {boolean}
 */
function exportFeature(item, activity, monster) {
  if (monster) return false;
  const kind = activity.type;
  if (kind !== "heal" && kind !== "utility" && kind !== "check" && kind !== "cast") return false;
  if (item.type !== "feat" && item.type !== "consumable" && item.type !== "spell") return false;
  const activityName = activity.name || "";
  const itemName = item.name || "";
  if (/tinderbox/i.test(itemName) && /^light$/i.test(activityName || "Light")) return false;
  if (/wall of (stone|force)/i.test(itemName) || /wall of (stone|force)/i.test(activityName)) return false;
  if (kind === "cast" && item.type === "spell" && (activityName || itemName) === itemName) return false;
  return true;
}

/**
 * Spell-specific fields the activity data does not store on its own.
 * @param {object} action
 * @param {object} item
 * @param {{ doc: object, abilities: Record<string, number>, prof: number }|undefined} [ctx]
 * @returns {object}
 */
function applySpellShape(action, item, ctx) {
  const props = item.system?.properties ?? [];
  if (props.includes("concentration")) action.concentration = true;
  const duration = item.system?.duration;
  const amount = Number(duration?.value);
  if (Number.isFinite(amount) && amount > 0) {
    if (duration.units === "round" || duration.units === "rounds") action.durationRounds = amount;
    else if (duration.units === "minute") action.durationRounds = amount * 10;
  }
  if (item.type !== "spell") return action;
  const name = item.name || "";
  const ident = item.system?.identifier || "";
  const level = Number(item.system?.level) || 0;
  if (name === "Web" || ident === "web") {
    action.zone = "web";
    action.damage = [];
    action.onSave = "none";
    action.conditions = ["restrained"];
    action.concentration = true;
    action.burn = { dice: "2d4", type: "fire" };
  } else if (name === "Grease" || ident === "grease") {
    action.zone = "grease";
    action.damage = [];
    action.onSave = "none";
    action.conditions = ["prone"];
    action.concentration = true;
  } else if (name === "Slow" || ident === "slow") {
    action.conditions = ["slowed"];
    action.onSave = "none";
    action.concentration = true;
    action.repeatSave = true;
    action.limit = 6;
  } else if (name === "Command" || ident === "command") {
    action.command = true;
    action.onSave = "none";
    action.damage = [];
  } else if (name === "Spirit Guardians" || ident === "spirit-guardians") {
    // The Cast activity has no save of its own. The ring is the whole spell.
    action.kind = "spell";
    delete action.profile;
    delete action.useKey;
    action.area = { type: "radius", size: 15, origin: "self" };
    action.zone = "spirit";
    action.saveAbility = "wis";
    action.onSave = "half";
    action.damage = [{ dice: "3d8", type: "radiant" }];
    action.damageChoice = ["Radiant", "Necrotic"];
    action.concentration = true;
    if (ctx) action.saveDc = spellSaveDc(ctx);
  }
  if (name === "Scorching Ray" || ident === "scorching-ray") action.rays = (level || 2) + 1;
  return action;
}

const tokenMap = JSON.parse(
  fs.readFileSync(path.join(ROOT, "json/fa-token-mapping.json"), "utf8")
)["dnd5e.actors24"] ?? {};

const tokenByName = indexTokenFiles(path.join(ROOT, "tokens"));

/**
 * Index token artwork by a normalized filename. Exact matches only.
 * @param {string} dir
 * @returns {Map<string, string>}
 */
function indexTokenFiles(dir) {
  /** @type {Map<string, string[]>} */
  const grouped = new Map();
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      // Category folders are symlinks while the portraits live beside the repo.
      let directory = entry.isDirectory();
      if (!directory && entry.isSymbolicLink()) {
        try {
          directory = fs.statSync(full).isDirectory();
        } catch {
          directory = false;
        }
      }
      if (directory) {
        if (entry.name === "thumbs") continue;
        walk(full);
      } else if (entry.name.endsWith(".webp")) {
        const key = entry.name.slice(0, -5).toLowerCase().replace(/[^a-z0-9]/g, "");
        const rel = path.relative(ROOT, full).split(path.sep).join("/");
        const list = grouped.get(key) ?? [];
        list.push(rel);
        grouped.set(key, list);
      }
    }
  };
  walk(dir);
  const unique = new Map();
  for (const [key, files] of grouped) {
    if (files.length === 1) unique.set(key, files[0]);
  }
  return unique;
}

/**
 * Turn a Foundry asset path into a repo-relative path when that file exists.
 * @param {string} foundryPath
 * @returns {string|null}
 */
function localAsset(foundryPath) {
  if (typeof foundryPath !== "string" || foundryPath.length === 0) return null;
  const rel = foundryPath.replace(/^systems\/dnd5e\//, "");
  if (rel.startsWith("modules/") || rel.startsWith("http")) return null;
  if (!fs.existsSync(path.join(ROOT, rel))) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Resolve a creature token from the Forgotten Adventures mapping, then by filename.
 * @param {object} doc
 * @returns {string|null}
 */
function tokenSrc(doc) {
  const mapped = tokenMap[doc._id];
  let src = null;
  const token = mapped?.token;
  if (typeof token === "string") src = token;
  else if (token && typeof token === "object") src = token.texture?.src ?? null;
  if (!src) src = doc.prototypeToken?.texture?.src ?? null;
  let file = localAsset(src);
  if (!file && doc.name) {
    const key = doc.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    file = tokenByName.get(key) ?? null;
  }
  return file;
}

/**
 * Collect YAML files under a directory.
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function walkYml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkYml(full, out);
    else if (entry.name.endsWith(".yml")) out.push(full);
  }
  return out;
}

/**
 * Ability modifier for a score.
 * @param {number|undefined} score
 * @returns {number}
 */
function abilityMod(score) {
  return Math.floor(((Number(score) || 10) - 10) / 2);
}

/**
 * Foundry's proficiency bonus from a level or a CR already raised to at least 1.
 * @param {number} level
 * @returns {number}
 */
function proficiencyBonus(level) {
  return Math.floor((level + 7) / 4);
}

/**
 * Collapse a Foundry description into a short plain sentence.
 * @param {string|undefined} html
 * @returns {string}
 */
function plainText(html) {
  if (typeof html !== "string" || html.length === 0) return "";
  return html
    .replace(/<\/?(?:span|em|strong|a|i|b|u)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;|&ldquo;|&rdquo;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&Reference\[([^\]}]+)[\]}]/g, (_, body) => body.split(/\s+/)[0])
    .replace(/@UUID\[[^\]]+\]\{([^}]*)\}/g, "$1")
    .replace(/@UUID\[[^\]]+\]/g, "")
    .replace(/@Embed\[[^\]]*\]/g, "")
    .replace(/\s*Foundry Note\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ABILITY_NAMES = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma"
};

const SKILLS = {
  acr: ["Acrobatics", "dex"],
  ani: ["Animal Handling", "wis"],
  arc: ["Arcana", "int"],
  ath: ["Athletics", "str"],
  dec: ["Deception", "cha"],
  his: ["History", "int"],
  ins: ["Insight", "wis"],
  itm: ["Intimidation", "cha"],
  inv: ["Investigation", "int"],
  med: ["Medicine", "wis"],
  nat: ["Nature", "int"],
  prc: ["Perception", "wis"],
  prf: ["Performance", "cha"],
  per: ["Persuasion", "cha"],
  rel: ["Religion", "int"],
  slt: ["Sleight of Hand", "dex"],
  ste: ["Stealth", "dex"],
  sur: ["Survival", "wis"]
};

const COUNT_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const TARGET_NOUNS = {
  ally: ["ally", "allies"],
  enemy: ["enemy", "enemies"],
  creature: ["creature", "creatures"],
  object: ["object", "objects"],
  space: ["space", "spaces"],
  creatureOrObject: ["creature or object", "creatures or objects"],
  willing: ["willing creature", "willing creatures"],
  any: ["target", "targets"],
  self: ["self", "self"]
};

/**
 * Format a modifier with its sign.
 * @param {number} n
 * @returns {string}
 */
function signed(n) {
  return n >= 0 ? `+${n}` : String(n);
}

/**
 * Read a dotted path, such as target.template.size.
 * @param {object|undefined} root
 * @param {string} path
 * @returns {unknown}
 */
function dig(root, path) {
  let cur = root;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Find an activity on this item, or on another embedded item when the id says so.
 * @param {object} ctx
 * @param {string|undefined} id
 * @returns {{ item: object, activity: object }|null}
 */
function locateActivity(ctx, id) {
  if (!id) return null;
  const local = activityList(ctx.item?.system?.activities);
  const here = local.find(activity => activity._id === id);
  if (here) return { item: ctx.item, activity: here };
  for (const item of ctx.itemsById.values()) {
    const found = activityList(item.system?.activities).find(activity => activity._id === id);
    if (found) return { item, activity: found };
  }
  return null;
}

/**
 * Slug used as a class or scale identifier when the source leaves it blank.
 * @param {string|undefined} input
 * @returns {string}
 */
function slugIdentifier(input) {
  return String(input ?? "")
    .replace(/(\w+)[\\|/](\w+)/g, "$1-$3")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Ability that Foundry exposes as @mod for this activity.
 * @param {object|undefined} activity
 * @param {object} ctx
 * @returns {string}
 */
function activityAbility(activity, ctx) {
  const spell = ctx.doc.system?.attributes?.spellcasting || "int";
  const calc = activity?.save?.dc?.calculation || activity?.check?.dc?.calculation || "";
  if (calc === "spellcasting") return spell;
  if (calc && ctx.abilities[calc] != null) return calc;
  const stated = activity?.attack?.ability;
  if (stated === "spellcasting") return spell;
  if (stated && stated !== "none" && ctx.abilities[stated] != null) return stated;
  const listed = activity?.save?.ability || activity?.check?.ability;
  const first = Array.isArray(listed) ? listed[0] : listed;
  if (first && ctx.abilities[first] != null) return first;
  return spell;
}

/**
 * Class level for an embedded class item, matched by identifier.
 * @param {object} ctx
 * @param {string} id
 * @returns {number|null}
 */
function levelsInClass(ctx, id) {
  if (!ctx.itemsById) return null;
  for (const item of ctx.itemsById.values()) {
    if (item.type !== "class") continue;
    const ident = item.system?.identifier || slugIdentifier(item.name);
    if (ident === id) return Number(item.system?.levels) || 0;
  }
  return null;
}

/**
 * Passive skill score, 10 plus the ability modifier plus proficiency.
 * @param {string} skill
 * @param {object} ctx
 * @returns {number|null}
 */
function skillPassive(skill, ctx) {
  const data = ctx.doc.system?.skills?.[skill];
  if (!data) return null;
  const ability = data.ability || SKILLS[skill]?.[1] || "str";
  const multiplier = Number(data.value) || 0;
  const bonus = Number(data.bonuses?.passive);
  return 10 + abilityMod(ctx.abilities[ability]) + (ctx.prof * multiplier) + (Number.isFinite(bonus) ? bonus : 0);
}

/**
 * Highest scale row at this level. Later rows fill only the fields they set.
 * @param {object} advancement
 * @param {number} level
 * @returns {object|null}
 */
function scaleRow(advancement, level) {
  const table = advancement.configuration?.scale ?? {};
  const keys = Object.keys(table)
    .map(Number)
    .filter(key => Number.isFinite(key) && key <= level)
    .sort((left, right) => right - left);
  if (!keys.length) return null;
  const data = {};
  for (const key of keys) {
    const row = table[String(key)] ?? table[key];
    if (!row || typeof row !== "object") continue;
    for (const [field, value] of Object.entries(row)) {
      if (data[field] == null) data[field] = value;
    }
  }
  return data;
}

/**
 * Text for one @scale.class.identifier lookup, including a trailing .die or .value.
 * @param {object} ctx
 * @param {string} classId
 * @param {string} scaleId
 * @param {string} prop
 * @returns {string}
 */
function scaleText(ctx, classId, scaleId, prop) {
  if (!ctx.itemsById) return "";
  const items = [...ctx.itemsById.values()];
  const owner = items.find(item => {
    if (item.type !== "class" && item.type !== "subclass") return false;
    return (item.system?.identifier || slugIdentifier(item.name)) === classId;
  });
  if (!owner) return "";
  let level = Number(owner.system?.levels) || 0;
  if (owner.type === "subclass") {
    const parentId = owner.system?.classIdentifier;
    const parent = items.find(item => {
      return item.type === "class" && (item.system?.identifier || slugIdentifier(item.name)) === parentId;
    });
    level = Number(parent?.system?.levels) || level;
  }
  const advancements = Object.values(owner.system?.advancement ?? {});
  const advancement = advancements.find(entry => {
    if (entry?.type !== "ScaleValue") return false;
    const ident = entry.configuration?.identifier || slugIdentifier(entry.title || entry.name || "");
    return ident === scaleId;
  });
  if (!advancement) return "";
  const data = scaleRow(advancement, level);
  if (!data) return "";
  const type = advancement.configuration?.type;
  if (type === "dice") {
    const faces = data.faces;
    const die = faces ? `d${faces}` : "";
    const formula = faces ? `${data.number ?? ""}${die}` : "";
    if (prop === "die") return die;
    if (prop === "number") return data.number == null ? "" : String(data.number);
    if (prop === "faces") return faces == null ? "" : String(faces);
    return formula;
  }
  if (type === "distance") {
    const units = advancement.configuration?.distance?.units || "ft";
    if (data.value == null) return "";
    if (prop === "value") return String(data.value);
    if (units === "ft") return Number(data.value) === 1 ? "1 foot" : `${data.value} feet`;
    if (units === "mi") return Number(data.value) === 1 ? "1 mile" : `${data.value} miles`;
    return units ? `${data.value} ${units}` : String(data.value);
  }
  if (data.value == null || typeof data.value === "object") return "";
  if (type === "cr" && data.value === 0.125) return "1/8";
  if (type === "cr" && data.value === 0.25) return "1/4";
  if (type === "cr" && data.value === 0.5) return "1/2";
  return String(data.value);
}

/**
 * "one creature" from an activity target, the phrase Foundry builds for a stat block.
 * @param {object|undefined} activity
 * @param {object} ctx
 * @returns {string}
 */
function statblockLabel(activity, ctx) {
  const affects = activity?.target?.affects;
  if (!affects) return "";
  const raw = affects.count == null || affects.count === "" ? "1" : String(affects.count);
  const substituted = substituteFormula(raw, ctx, activity);
  const count = Number(substituted);
  const total = Number.isFinite(count) && count > 0 ? count : 1;
  const noun = (TARGET_NOUNS[affects.type] || TARGET_NOUNS.any)[total === 1 ? 0 : 1];
  return `${COUNT_WORDS[total] || String(total)} ${noun}`;
}

/**
 * Healing formula with @mod and class levels filled in.
 * @param {object|undefined} activity
 * @param {object} ctx
 * @returns {string}
 */
function healingFormula(activity, ctx) {
  const healing = activity?.healing;
  if (!healing) return "";
  if (healing.custom?.enabled && healing.custom.formula) {
    return substituteFormula(String(healing.custom.formula), ctx, activity);
  }
  const number = Number(healing.number) || 0;
  const faces = Number(healing.denomination) || 0;
  let formula = number && faces ? `${number}d${faces}` : "";
  if (healing.bonus != null && healing.bonus !== "") {
    const bonus = substituteFormula(String(healing.bonus), ctx, activity);
    formula = formula ? `${formula} + ${bonus}` : bonus;
  }
  return formula;
}

/**
 * Replace @prof, @mod, @abilities, @scale, and the other roll terms with numbers or dice.
 * @param {string} formula
 * @param {object} ctx
 * @param {object|undefined} activity
 * @returns {string}
 */
function substituteFormula(formula, ctx, activity) {
  const mod = abilityMod(ctx.abilities[activityAbility(activity, ctx)]);
  return String(formula ?? "")
    .replace(/@abilities\.([a-z]{3})\.mod/g, (_, key) => String(abilityMod(ctx.abilities[key])))
    .replace(/@abilities\.([a-z]{3})\.dc/g, (_, key) => String(8 + ctx.prof + abilityMod(ctx.abilities[key])))
    .replace(/@abilities\.([a-z]{3})\.value/g, (_, key) => String(ctx.abilities[key] ?? 10))
    .replace(/@skills\.([a-z]{3})\.passive/g, (_, key) => {
      const passive = skillPassive(key, ctx);
      return passive == null ? `@skills.${key}.passive` : String(passive);
    })
    .replace(/@classes\.([a-z0-9-]+)\.levels/g, (_, id) => {
      const levels = levelsInClass(ctx, id);
      return levels == null ? `@classes.${id}.levels` : String(levels);
    })
    .replace(/@scale\.([a-z0-9-]+)\.([a-z0-9-]+)(?:\.([a-z0-9-]+))?/g, (match, classId, scaleId, prop) => {
      const text = scaleText(ctx, classId, scaleId, prop || "");
      return text === "" ? match : text;
    })
    .replace(/@item\.uses\.spent/g, String(Number(ctx.item?.system?.uses?.spent) || 0))
    .replace(/@item\.level/g, String(Number(ctx.item?.system?.level) || 0))
    .replace(/@prof/g, String(ctx.prof))
    .replace(/@mod/g, String(mod));
}

/**
 * Evaluate a deterministic bonus such as "8 + @prof" or "10 + (@item.uses.spent * 5)".
 * @param {string} formula
 * @param {object} ctx
 * @param {object|undefined} activity
 * @returns {number|null}
 */
function formulaTotal(formula, ctx, activity) {
  const replaced = substituteFormula(formula, ctx, activity).replace(/\s/g, "");
  if (!replaced || !/^[\d.+*/()-]+$/.test(replaced)) return null;
  return arithmetic(replaced);
}

/**
 * Integer or decimal arithmetic. Returns null when the expression is not fully consumed.
 * @param {string} input
 * @returns {number|null}
 */
function arithmetic(input) {
  let index = 0;
  const parseExpr = () => {
    let value = parseTerm();
    while (input[index] === "+" || input[index] === "-") {
      const op = input[index];
      index += 1;
      const right = parseTerm();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = () => {
    let value = parseFactor();
    while (input[index] === "*" || input[index] === "/") {
      const op = input[index];
      index += 1;
      const right = parseFactor();
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };
  const parseFactor = () => {
    if (input[index] === "+") {
      index += 1;
      return parseFactor();
    }
    if (input[index] === "-") {
      index += 1;
      return -parseFactor();
    }
    if (input[index] === "(") {
      index += 1;
      const value = parseExpr();
      if (input[index] !== ")") return NaN;
      index += 1;
      return value;
    }
    const match = /^(\d+(?:\.\d+)?)/.exec(input.slice(index));
    if (!match) return NaN;
    index += match[1].length;
    return Number(match[1]);
  };
  const value = parseExpr();
  if (index !== input.length || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Saving throw or check DC. A chosen ability is 8 plus that modifier plus proficiency.
 * An empty calculation uses the stored formula, so "8 + @prof" does not add a modifier.
 * @param {object|undefined} activity
 * @param {object} ctx
 * @returns {number|null}
 */
function saveDcValue(activity, ctx) {
  const dc = activity?.save?.dc || activity?.check?.dc;
  if (!dc) return null;
  const calc = dc.calculation;
  if (calc) {
    const spell = ctx.doc.system?.attributes?.spellcasting || "int";
    const ability = calc !== "spellcasting" && ctx.abilities[calc] != null ? calc : spell;
    return 8 + ctx.prof + abilityMod(ctx.abilities[ability]);
  }
  const formula = String(dc.formula ?? "").trim();
  if (!formula) return null;
  const total = formulaTotal(formula, ctx, activity);
  return total == null ? null : total;
}

/**
 * Spell save DC, 8 plus the spellcasting modifier plus proficiency.
 * @param {object} ctx
 * @returns {number}
 */
function spellSaveDc(ctx) {
  const ability = ctx.doc.system?.attributes?.spellcasting || "int";
  return 8 + ctx.prof + abilityMod(ctx.abilities[ability]);
}

/**
 * Resolve one [[lookup]] path against the activity or the actor.
 * @param {string} path
 * @param {object|null} located
 * @param {object} ctx
 * @returns {string}
 */
function lookupValue(path, located, ctx) {
  if (path === "name") return ctx.doc.name ?? "";
  if (path === "attributes.spell.dc") return String(spellSaveDc(ctx));
  const activity = located?.activity;
  if (path === "save.dc.value" || path === "check.dc.value") {
    const dc = saveDcValue(activity, ctx);
    return dc == null ? "" : String(dc);
  }
  if (path === "roll.formula") return substituteFormula(activity?.roll?.formula ?? "", ctx, activity);
  if (path === "healing.formula") return healingFormula(activity, ctx);
  if (path === "target.affects.labels.statblock") return statblockLabel(activity, ctx);
  if (path === "target.affects.special") {
    const special = activity?.target?.affects?.special;
    if (typeof special === "string" && special.trim()) return special;
    const rangeSpecial = activity?.range?.special;
    if (typeof rangeSpecial === "string" && rangeSpecial.trim()) return rangeSpecial;
    return "";
  }
  const ability = /^abilities\.([a-z]{3})\.(mod|dc)$/.exec(path);
  if (ability) {
    const score = ctx.abilities[ability[1]];
    if (score == null) return "";
    const modifier = abilityMod(score);
    return ability[2] === "dc" ? String(8 + ctx.prof + modifier) : String(modifier);
  }
  const levels = /^classes\.([a-z0-9-]+)\.levels$/.exec(path);
  if (levels) {
    const value = levelsInClass(ctx, levels[1]);
    return value == null ? "" : String(value);
  }
  const scale = /^scale\.([a-z0-9-]+)\.([a-z0-9-]+)(?:\.([a-z0-9-]+))?$/.exec(path);
  if (scale) return scaleText(ctx, scale[1], scale[2], scale[3] || "");
  const passive = /^skills\.([a-z]{3})\.passive$/.exec(path);
  if (passive) {
    const value = skillPassive(passive[1], ctx);
    return value == null ? "" : String(value);
  }
  if (path.startsWith("item.")) {
    const fromItem = dig(located?.item?.system ?? ctx.item?.system, path.slice("item.".length));
    if (fromItem != null && typeof fromItem !== "object") return String(fromItem);
  }
  const value = dig(activity, path);
  if (value != null && typeof value !== "object") return String(value);
  const fromActor = dig(ctx.doc.system, path);
  if (fromActor != null && typeof fromActor !== "object") return String(fromActor);
  return "";
}

/**
 * Replace [[lookup]] tags with the creature name, a DC, a distance, or the brace fallback.
 * @param {string} html
 * @param {object} ctx
 * @returns {string}
 */
function replaceLookups(html, ctx) {
  return html.replace(/\[\[lookup\s+([^[\]]+?)\]\](?:\{([^{}]*)\})?/g, (match, body, fallback) => {
    let path = "";
    let activityId = "";
    let style = "";
    for (const token of body.trim().split(/\s+/)) {
      if (token.startsWith("@")) path = token.slice(1);
      else if (token.startsWith("activity=")) activityId = token.slice("activity=".length);
      else if (!style && (token === "lowercase" || token === "capitalize" || token === "uppercase")) style = token;
    }
    let text = lookupValue(path, locateActivity(ctx, activityId), ctx);
    if (style === "lowercase") text = text.toLowerCase();
    else if (style === "uppercase") text = text.toUpperCase();
    else if (style === "capitalize" && text) text = text.charAt(0).toUpperCase() + text.slice(1);
    if (text !== "") return text;
    if (fallback) return fallback;
    return match;
  });
}

/**
 * Split an enricher argument string into key=value pairs and bare words.
 * @param {string} rest
 * @returns {{ values: string[], [key: string]: string }}
 */
function parseEnricherArgs(rest) {
  const args = { values: [] };
  for (const token of rest.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq > 0) args[token.slice(0, eq)] = token.slice(eq + 1);
    else args.values.push(token);
  }
  return args;
}

/**
 * Ability names named by a save or check enricher.
 * @param {{ values: string[], ability?: string }} args
 * @returns {string[]}
 */
function namedAbilities(args) {
  const words = [];
  if (args.ability) words.push(...args.ability.split(/[/|]/));
  for (const value of args.values) {
    if (ABILITY_NAMES[value] || Object.values(ABILITY_NAMES).some(name => name.toLowerCase() === value)) {
      words.push(value);
    }
  }
  return words.map(word => {
    const lower = word.toLowerCase();
    if (ABILITY_NAMES[lower]) return ABILITY_NAMES[lower];
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

/**
 * Attack bonus, including proficiency, for the activity Foundry would roll.
 * @param {object} located
 * @param {object} ctx
 * @returns {number|null}
 */
function attackBonus(located, ctx) {
  const action = toAction(ctx.doc, located.item, located.activity, ctx.abilities, ctx.prof, ctx.monster);
  if (!action) return null;
  if (action.toHit != null) return action.toHit;
  if (action.attackAbility) return abilityMod(ctx.abilities[action.attackAbility]) + ctx.prof;
  const props = action.properties ?? [];
  const key = props.includes("finesse")
    ? (abilityMod(ctx.abilities.dex) >= abilityMod(ctx.abilities.str) ? "dex" : "str")
    : props.includes("ranged") ? "dex" : "str";
  return abilityMod(ctx.abilities[key]) + ctx.prof;
}

/**
 * "Melee Attack Roll: +8, reach 10 ft." or a bare bonus.
 * @param {object} args
 * @param {object} ctx
 * @returns {string}
 */
function attackText(args, ctx) {
  const extended = args.values.includes("extended") || args.format === "extended";
  const fixed = args.formula || args.values.find(value => /^[+-]?\d+$/.test(value));
  const attack = activityList(ctx.item?.system?.activities).find(entry => entry.type === "attack");
  const located = locateActivity(ctx, args.activity) ?? (attack ? { item: ctx.item, activity: attack } : null);
  if (!located?.activity) return fixed != null ? signed(Number(fixed)) : "";
  const bonus = fixed != null && !extended ? Number(fixed) : attackBonus(located, ctx);
  if (bonus == null) return "";
  const sign = signed(bonus);
  if (!extended) return sign;
  const action = toAction(ctx.doc, located.item, located.activity, ctx.abilities, ctx.prof, ctx.monster);
  let kind = "Melee Attack Roll";
  if (action?.range && action.reach) kind = "Melee or Ranged Attack Roll";
  else if (action?.range) kind = "Ranged Attack Roll";
  let where = "";
  if (action?.reach && action.range) {
    where = `, reach ${action.reach} ft. or range ${action.range.normal}/${action.range.long} ft.`;
  } else if (action?.range) where = `, range ${action.range.normal}/${action.range.long} ft.`;
  else if (action?.reach) where = `, reach ${action.reach} ft.`;
  return `${kind}: ${sign}${where}`;
}

/**
 * Average of NdM+B, rounded down the way Foundry does.
 * @param {string} dice
 * @returns {number|null}
 */
function diceAverage(dice) {
  const match = /^(\d+)d(\d+)([+-]\d+)?$/.exec(String(dice).replace(/\s/g, ""));
  if (!match) return null;
  const count = Number(match[1]);
  const faces = Number(match[2]);
  const bonus = match[3] ? Number(match[3]) : 0;
  return Math.floor((count + bonus + (count * faces) + bonus) / 2);
}

/**
 * "Hit: 18 (3d8+5) bludgeoning damage" from explicit dice or the item's activity.
 * @param {object} args
 * @param {object} ctx
 * @param {boolean} heal
 * @returns {string}
 */
/**
 * A damage type word. Temporary hit points keep their own name.
 * @param {string|undefined} type
 * @returns {string}
 */
function typeLabel(type) {
  if (!type || type === "untyped") return "";
  if (type === "temphp") return "temporary hit points";
  return type;
}

/**
 * "Hit: 18 (3d8+5) bludgeoning damage" from explicit dice or the item's activity.
 * @param {object} args
 * @param {object} ctx
 * @param {boolean} heal
 * @returns {string}
 */
function damageText(args, ctx, heal) {
  const extended = args.values.includes("extended") || args.format === "extended";
  const average = args.values.includes("average") || args.average === "true";
  const explicit = args.formula || args.values.find(value => /^\d+d\d+/.test(value) || value.startsWith("@"));
  let entries = [];
  if (explicit) {
    const located = locateActivity(ctx, args.activity);
    const dice = substituteFormula(explicit, ctx, located?.activity).replace(/\s/g, "");
    let type = (args.type || "").split(/[/|]/)[0];
    if (!type && args.values.includes("temp")) type = "temphp";
    entries = [{ dice, type }];
  } else if (heal) {
    const local = activityList(ctx.item?.system?.activities);
    const located = args.activity ? locateActivity(ctx, args.activity) : null;
    const activity = located?.activity ?? local.find(entry => entry.type === "heal");
    if (!activity) return "";
    const dice = healingFormula(activity, ctx).replace(/\s/g, "");
    if (!dice) return "";
    entries = [{ dice, type: args.values.includes("temp") ? "temphp" : "healing" }];
  } else {
    const types = ["attack", "damage", "save"];
    const local = activityList(ctx.item?.system?.activities);
    const located = args.activity ? locateActivity(ctx, args.activity) : null;
    const candidates = located?.activity
      ? [{ item: located.item ?? ctx.item, activity: located.activity }]
      : local.filter(entry => types.includes(entry.type)).map(activity => ({ item: ctx.item, activity }));
    for (const candidate of candidates) {
      const action = toAction(ctx.doc, candidate.item, candidate.activity, ctx.abilities, ctx.prof, ctx.monster);
      const damage = action?.damage ?? [];
      if (damage.length) {
        entries = damage.map(entry => ({ ...entry }));
        break;
      }
    }
  }
  if (!entries.length) return "";
  const bits = entries.map(entry => {
    const rolled = average ? diceAverage(entry.dice) : null;
    const avg = rolled == null && average && /^\d+$/.test(entry.dice) ? Number(entry.dice) : rolled;
    const formula = avg == null || String(avg) === entry.dice ? entry.dice : `${avg} (${entry.dice})`;
    const type = typeLabel(entry.type);
    return type ? `${formula} ${type}` : formula;
  });
  const body = bits.length === 2 ? `${bits[0]} plus ${bits[1]}` : bits.join(", ");
  const restored = heal || entries.every(entry => entry.type === "temphp" || entry.type === "healing");
  if (extended) return restored ? `Hit: ${body}` : `Hit: ${body} damage`;
  if (heal && !/healing|temporary hit points/.test(body)) return `${body} healing`;
  return body;
}

/**
 * "DC 16 Constitution saving throw" or the same shape for a check.
 * @param {object} args
 * @param {object} ctx
 * @param {string} noun
 * @returns {string}
 */
function checkOrSaveText(args, ctx, noun) {
  let names = namedAbilities(args);
  const number = args.dc || args.values.find(value => /^\d+$/.test(value));
  const located = locateActivity(ctx, args.activity)
    ?? { activity: activityList(ctx.item?.system?.activities).find(entry => entry.type === (noun === "check" ? "check" : "save")) };
  let dc = null;
  if (number != null && number !== "") {
    dc = /^\d+$/.test(String(number)) ? Number(number) : formulaTotal(String(number), ctx, located?.activity);
  }
  if (!names.length && located?.activity?.save?.ability) {
    const listed = Array.isArray(located.activity.save.ability)
      ? located.activity.save.ability
      : [located.activity.save.ability];
    names = listed.map(ability => ABILITY_NAMES[ability] || ability);
  }
  if (dc == null && noun === "saving throw") dc = saveDcValue(located?.activity, ctx);
  const who = names.length ? names.join(" or ") : "";
  const roll = who ? `${who} ${noun}` : noun;
  return dc == null ? roll : `DC ${dc} ${roll}`;
}

let spellNames = null;

/**
 * Spell name from a 2024 spell id, loaded once from the spell packs.
 * @param {string} id
 * @returns {string}
 */
function spellNameById(id) {
  if (!spellNames) {
    spellNames = new Map();
    const dir = path.join(ROOT, "packs/_source/spells24");
    if (fs.existsSync(dir)) {
      for (const file of walkYml(dir)) {
        const doc = YAML.load(fs.readFileSync(file, "utf8"));
        if (doc?._id && doc.name) spellNames.set(doc._id, doc.name);
      }
    }
  }
  return spellNames.get(id) || "";
}

/**
 * Name of the spell a cast activity points at.
 * @param {object|undefined} activity
 * @param {object} ctx
 * @returns {string}
 */
function castSpellName(activity, ctx) {
  const uuid = activity?.spell?.uuid;
  if (typeof uuid !== "string" || uuid.length === 0) return "";
  const id = uuid.split(".").pop();
  for (const item of ctx.itemsById.values()) {
    if (item._id === id) return item.name || "";
    const source = item._stats?.compendiumSource || item.flags?.dnd5e?.sourceId || "";
    if (source.endsWith(id)) return item.name || "";
  }
  return spellNameById(id);
}

/**
 * Item name from an id such as ".mmTreeClub000000" or a multi-word name such as "Force Bolt".
 * An activity link such as ".mmSpellcasting00.Activity.abc" uses the spell name.
 * @param {{ values: string[] }} args
 * @param {object} ctx
 * @returns {string}
 */
function itemText(args, ctx) {
  const given = args.values.join(" ").trim();
  if (!given) return ctx.item?.name || "";
  const activityRef = /^\.([^.]+)\.Activity\.(.+)$/.exec(given);
  if (activityRef) {
    const item = ctx.itemsById.get(activityRef[1]);
    const activity = activityList(item?.system?.activities).find(entry => entry._id === activityRef[2]);
    if (activity?.name) return activity.name;
    const spell = castSpellName(activity, ctx);
    if (spell) return spell;
    return item?.name || "";
  }
  if (given.startsWith(".")) return ctx.itemsById.get(given.slice(1))?.name || "";
  const byId = ctx.itemsById.get(given);
  if (byId?.name) return byId.name;
  const lower = given.toLowerCase();
  for (const item of ctx.itemsById.values()) {
    if (item.name?.toLowerCase() === lower) return item.name;
  }
  return given;
}

/**
 * "DC 10 Strength (Athletics)" from a skill enricher.
 * @param {{ values: string[], skill?: string, dc?: string }} args
 * @returns {string}
 */
function skillText(args) {
  const code = (args.skill || args.values.find(value => SKILLS[value] || skillKey(value)) || "").toLowerCase();
  const key = SKILLS[code] ? code : skillKey(code);
  if (!key) return "";
  const [label, ability] = SKILLS[key];
  const check = `${ABILITY_NAMES[ability]} (${label})`;
  const dc = args.dc || args.values.find(value => /^\d+$/.test(value));
  return dc ? `DC ${dc} ${check}` : check;
}

/**
 * Skill abbreviation for a full name such as "athletics".
 * @param {string} name
 * @returns {string}
 */
function skillKey(name) {
  const lower = name.toLowerCase();
  for (const [key, [label]] of Object.entries(SKILLS)) {
    if (label.toLowerCase() === lower) return key;
  }
  return "";
}

/**
 * Replace [[/attack]], [[/damage]], [[/save]], [[/item]], and the other roll tags.
 * @param {string} html
 * @param {object} ctx
 * @returns {string}
 */
function replaceRolls(html, ctx) {
  return html.replace(/\[\[\/([a-z]+)([^[\]]*?)\]\](?:\{([^{}]*)\})?/gi, (match, command, rest, label) => {
    if (label) return label;
    const args = parseEnricherArgs(rest);
    const kind = command.toLowerCase();
    if (kind === "item") return itemText(args, ctx) || match;
    if (kind === "r") return substituteFormula(args.formula || args.values.join(" "), ctx, null) || match;
    if (kind === "heal" || kind === "healing") return damageText(args, ctx, true) || match;
    if (kind === "attack") return attackText(args, ctx) || match;
    if (kind === "damage") return damageText(args, ctx, false) || match;
    if (kind === "save") return checkOrSaveText(args, ctx, "saving throw") || match;
    if (kind === "check") return checkOrSaveText(args, ctx, "check") || match;
    if (kind === "skill") return skillText(args) || match;
    if (kind === "concentration") {
      const dc = args.values.find(value => /^\d+$/.test(value)) || args.dc;
      return dc ? `DC ${dc} concentration` : "concentration";
    }
    return match;
  });
}

/**
 * [[ceil(@prof/2)]] and [[floor(...)]] become the number, or the brace label when it cannot be computed.
 * @param {string} html
 * @param {object} ctx
 * @returns {string}
 */
function replaceFormulas(html, ctx) {
  return html.replace(/\[\[(ceil|floor|round)\(([^[\]]+)\)\]\](?:\{([^{}]*)\})?/g, (match, fn, body, label) => {
    const total = formulaTotal(body, ctx, null);
    if (total == null) return label || match;
    if (fn === "ceil") return String(Math.ceil(total));
    if (fn === "floor") return String(Math.floor(total));
    return String(Math.round(total));
  });
}

/**
 * Turn Foundry enrichers into ordinary words, then strip the HTML.
 * @param {string|undefined} html
 * @param {object} ctx
 * @returns {string}
 */
function resolvedText(html, ctx) {
  if (typeof html !== "string" || html.length === 0) return "";
  const flat = html.replace(/\s+/g, " ");
  return plainText(replaceRolls(replaceFormulas(replaceLookups(flat, ctx), ctx), ctx));
}

/**
 * Players get at most four sentences, without a numberless introductory sentence.
 * @param {string} text
 * @returns {string}
 */
function shortenForPlayer(text) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const start = sentences.length > 1 && !/\d/.test(sentences[0]) ? 1 : 0;
  return sentences.slice(start, start + 4).join(" ");
}

/**
 * Full text for a monster, or a shorter cut for a character.
 * @param {string|undefined} html
 * @param {object} ctx
 * @returns {string}
 */
function featureSummary(html, ctx) {
  const text = resolvedText(html, ctx);
  if (!text) return "";
  return ctx.monster ? text : shortenForPlayer(text);
}

/**
 * Grid squares the token occupies. Foundry's token size wins over the size category.
 * @param {object} doc
 * @returns {{ w: number, h: number }}
 */
function footprint(doc) {
  const width = Number(doc.prototypeToken?.width);
  const height = Number(doc.prototypeToken?.height);
  if (width > 0 && height > 0) {
    return { w: Math.max(1, Math.round(width)), h: Math.max(1, Math.round(height)) };
  }
  const size = SIZES[doc.system?.traits?.size];
  const span = size === "large" ? 2 : size === "huge" ? 3 : size === "gargantuan" ? 4 : 1;
  return { w: span, h: span };
}

/**
 * The six ability scores, defaulting a missing score to 10.
 * @param {object} doc
 * @returns {Record<string, number>}
 */
function abilityScores(doc) {
  const scores = {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
    scores[key] = doc.system?.abilities?.[key]?.value ?? 10;
  }
  return scores;
}

/**
 * Which saves add proficiency. A missing flag counts as not proficient.
 * @param {object} doc
 * @returns {Record<string, boolean>}
 */
function saveProficiencies(doc) {
  const saves = {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
    saves[key] = Number(doc.system?.abilities?.[key]?.proficient) > 0;
  }
  return saves;
}

/**
 * An activity template with a type and a size wins, even when override is false.
 * Breath weapons store the cone or line only on the activity. Fireball leaves the
 * activity empty and keeps the 20-foot sphere on the item.
 * @param {object} item
 * @param {object} activity
 * @returns {object|undefined}
 */
function templateSource(item, activity) {
  const act = activity.target?.template;
  const itemTemplate = item.system?.target?.template;
  const actSize = Number(act?.size);
  const actHas = act && act.type && Number.isFinite(actSize) && actSize > 0;
  if (actHas) return act;
  return itemTemplate;
}

/**
 * An overridden activity range wins, including self with no number.
 * Otherwise a filled activity distance wins, then the item range.
 * @param {object} item
 * @param {object} activity
 * @returns {object}
 */
function rangeSource(item, activity) {
  const act = activity.range ?? {};
  const itemRange = item.system?.range ?? {};
  if (act.override === true) return act;
  const actValue = Number(act.value);
  if (Number.isFinite(actValue) && actValue > 0) return act;
  if (itemRange.units || itemRange.value != null || itemRange.reach != null) return itemRange;
  return act;
}

/**
 * Feet from a template width. Fractions such as 1/2 stay as feet.
 * @param {unknown} value
 * @returns {number}
 */
function feetAmount(value) {
  if (value == null || value === "") return 0;
  const text = String(value).trim();
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator ? Number(fraction[1]) / denominator : 0;
  }
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * Save, Attack, and "1st Save" are placeholders. A specific name is not.
 * @param {unknown} name
 * @returns {boolean}
 */
function isPlaceholder(name) {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) return false;
  if (/^(save|attack|cast|damage|heal|check)$/i.test(text)) return true;
  return /^\d+(st|nd|rd|th)\s+save$/i.test(text);
}

/**
 * The creature type stored on an actor. Premade characters with none are humanoid.
 * @param {object} doc
 * @param {boolean} monster
 * @returns {string|null}
 */
function creatureKind(doc, monster) {
  const raw = doc.system?.details?.type;
  const value = raw && typeof raw === "object" ? raw.value : raw;
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (CREATURE_TYPE_SET.has(slug)) return slug;
  if (monster) return slug || null;
  return "humanoid";
}

/**
 * First sentence of a plain description.
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const match = /^.*?[.!?](?:\s|$)/.exec(text);
  return (match ? match[0] : text).trim();
}

/**
 * A plain list of creature types, or an empty list when the text is not one.
 * A description only counts when its first sentence is a targeting sentence.
 * @param {string} text
 * @param {boolean} fromDescription
 * @returns {string[]}
 */
function parsedTargets(text, fromDescription) {
  const normalized = String(text).replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (fromDescription && !/^(choose|one|each|target)\b/i.test(normalized)) return [];
  const lower = normalized.toLowerCase();
  if (/\b(corpse|dead|willing|tiny|small|medium|large|huge|gargantuan|isn't|isnt|not|except)\b/.test(lower)) {
    return [];
  }
  if (/\bcreatures?\b/.test(lower)) return [];
  const words = lower.replace(/[^a-z'\s]/g, " ").split(/\s+/).filter(Boolean);
  const types = [];
  for (const word of words) {
    if (CREATURE_TYPE_SET.has(word)) {
      if (!types.includes(word)) types.push(word);
      continue;
    }
    if (fromDescription || TARGET_FILLER.has(word)) continue;
    return [];
  }
  return types;
}

/**
 * Activity special, else the item special, else the description's first sentence.
 * @param {object} item
 * @param {object} activity
 * @returns {string[]}
 */
function targetTypes(item, activity) {
  const act = activity.target?.affects?.special;
  if (typeof act === "string" && act.trim()) return parsedTargets(act, false);
  const itemSpecial = item.system?.target?.affects?.special;
  if (typeof itemSpecial === "string" && itemSpecial.trim()) return parsedTargets(itemSpecial, false);
  const sentence = firstSentence(plainText(item.system?.description?.value));
  if (!sentence) return [];
  return parsedTargets(sentence, true);
}

/**
 * Attach an area, a creature-type limit, and, for a save, the conditions a failed save applies.
 * @param {object} action
 * @param {object} item
 * @param {object} activity
 * @returns {object}
 */
function finish(action, item, activity) {
  const source = templateSource(item, activity);
  const size = Number(source?.size);
  if (source?.type && Number.isFinite(size) && size > 0) {
    const units = rangeSource(item, activity).units;
    const width = feetAmount(source.width);
    action.area = { type: source.type, size, origin: units === "self" ? "self" : "point" };
    if ((source.type === "line" || source.type === "wall") && width > 0) action.area.width = width;
    if (action.area.origin === "self") delete action.reach;
  }
  const targets = targetTypes(item, activity);
  if (targets.length) action.targets = targets;
  if (activity.type === "save") {
    const names = [];
    for (const effect of item.effects || []) {
      for (const status of effect.statuses || []) {
        if (status && !names.includes(status)) names.push(status);
      }
    }
    if (names.length) action.conditions = names;
  }
  if (!action.activation) action.activation = activationOf(item, activity);
  attachRecharge(action, item, activity);
  return applySpellShape(action, item);
}

/**
 * A breath or other recharge power spends the item's uses and returns on a d6.
 * The formula is the lowest success, and a missing formula is a 6, matching dnd5e.
 * @param {object} action
 * @param {object} item
 * @param {object} activity
 */
function attachRecharge(action, item, activity) {
  const targets = activity.consumption?.targets ?? [];
  const spends = targets.some(target => target?.type === "itemUses");
  if (!spends) return;
  const recovery = item.system?.uses?.recovery;
  if (!Array.isArray(recovery)) return;
  const row = recovery.find(entry => entry?.period === "recharge");
  if (!row) return;
  const raw = item.system?.uses?.max;
  const max = typeof raw === "number" && Number.isInteger(raw)
    ? raw
    : (/^\d+$/.test(String(raw ?? "").trim()) ? Number(raw) : null);
  if (max == null || max < 1) return;
  const parsed = Number.parseInt(row.formula, 10);
  action.uses = max;
  action.recharge = Number.isFinite(parsed) && parsed >= 1 && parsed <= 6 ? parsed : 6;
  action.useKey = item.name || action.name;
}

/**
 * Use a stored flat AC, otherwise armor plus Dex, otherwise 10 plus Dex.
 * @param {object} doc
 * @param {Record<string, number>} abilities
 * @returns {number}
 */
function armorClass(doc, abilities) {
  const flat = doc.system?.attributes?.ac?.flat;
  if (typeof flat === "number") return flat;

  let armor = null;
  let shield = 0;
  for (const item of doc.items ?? []) {
    if (item.type !== "equipment" || !item.system?.equipped) continue;
    const kind = item.system.type?.value;
    if (kind === "shield") shield += Number(item.system.armor?.value) || 0;
    else if (ARMOR.has(kind) && armor === null) armor = item;
  }

  const dex = abilityMod(abilities.dex);
  if (!armor) return 10 + dex + shield;
  const base = Number(armor.system.armor?.value) || 10;
  const cap = armor.system.type?.value === "heavy" ? 0 : armor.system.armor?.dex;
  const used = cap == null || cap === "" ? dex : Math.min(dex, Number(cap));
  return base + used + shield;
}

/**
 * Hit points from max, then from the current value.
 * @param {object} doc
 * @returns {number}
 */
function hitPoints(doc) {
  const hp = doc.system?.attributes?.hp ?? {};
  if (typeof hp.max === "number") return hp.max;
  if (typeof hp.value === "number") return hp.value;
  return 0;
}

/**
 * A damage or condition trait list from the actor.
 * @param {object} doc
 * @param {string} key
 * @returns {string[]}
 */
function traitList(doc, key) {
  const value = doc.system?.traits?.[key]?.value;
  return Array.isArray(value) ? value : [];
}

/**
 * Normalize an activities map or array into a list.
 * @param {object|undefined} activities
 * @returns {object[]}
 */
function activityList(activities) {
  if (!activities) return [];
  const values = Array.isArray(activities) ? activities : Object.values(activities);
  return values.filter(activity => activity && typeof activity === "object" && activity.type);
}

/**
 * Build one damage entry. An @mod bonus, or bakeModifier on a weapon's base die, adds the ability modifier.
 * @param {object} part
 * @param {number} abilityModifier
 * @param {boolean} bakeModifier
 * @returns {{ dice: string, type: string }|null}
 */
function damageEntry(part, abilityModifier, bakeModifier) {
  if (!part || typeof part !== "object") return null;
  const raw = part.bonus;
  let extra = 0;
  if (bakeModifier || raw === "@mod") extra += abilityModifier;
  if (raw != null && raw !== "" && raw !== "@mod" && Number.isFinite(Number(raw))) extra += Number(raw);
  if (part.custom?.enabled && part.custom.formula) {
    const custom = String(part.custom.formula).replace(/\s/g, "").replace("@mod", String(abilityModifier));
    if (!DICE.test(custom)) return null;
    return { dice: custom, type: part.types?.[0] || "untyped" };
  }
  const number = Number(part.number) || 0;
  const denomination = Number(part.denomination) || 0;
  if (!number || !denomination) return null;
  const dice = `${number}d${denomination}${extra ? (extra > 0 ? `+${extra}` : String(extra)) : ""}`;
  if (!DICE.test(dice)) return null;
  return { dice, type: part.types?.[0] || "untyped" };
}

/**
 * Melee reach and ranged distance, preferring the item when the activity does not override it.
 * @param {object} item
 * @param {object} activity
 * @param {boolean} ranged
 * @returns {{ reach?: number, range?: { normal: number, long: number } }}
 */
function reachAndRange(item, activity, ranged) {
  const act = activity.range ?? {};
  const itemRange = item.system?.range ?? {};
  const source = rangeSource(item, activity);
  const value = Number(source.value);
  const far = Number(source.long ?? itemRange.long);
  const units = source.units || itemRange.units || "";
  const props = item.system?.properties ?? [];
  const thrown = props.includes("thr");
  const result = {};
  const distance = Number.isFinite(value) && value > 0 ? value : null;
  const usingActivity = source === act;

  if (ranged || thrown || (units === "ft" && distance && distance > 5)) {
    const normal = distance ?? (Number.isFinite(far) && far > 0 ? far : null);
    if (normal) result.range = { normal, long: Number.isFinite(far) && far > 0 ? far : normal };
  }
  if (!ranged || thrown) {
    const reach = Number(usingActivity ? act.value : (itemRange.reach ?? (distance && distance <= 5 ? distance : null)));
    if (!result.range || thrown) result.reach = Number.isFinite(reach) && reach > 0 ? reach : 5;
  }
  if (!result.range && !result.reach) result.reach = 5;
  return result;
}

/**
 * How many darts or targets a damage activity produces at the item's spell level.
 * @param {string|undefined} count
 * @param {number} level
 * @returns {number}
 */
function dartCount(count, level) {
  if (count == null || count === "") return 1;
  const text = String(count).replace(/\s/g, "");
  if (/^\d+$/.test(text)) return Number(text);
  const sum = /^(\d+)\+@item\.level$/.exec(text);
  if (sum) return Number(sum[1]) + level;
  return 1;
}

/**
 * Convert one attack, save, or damage activity into a battlemat action.
 * @param {object} doc
 * @param {object} item
 * @param {object} activity
 * @param {Record<string, number>} abilities
 * @param {number} prof
 * @param {boolean} monster
 * @returns {object|null}
 */
/**
 * A class feature, potion, or other activity that is not an attack or a save.
 * @param {object} doc
 * @param {object} item
 * @param {object} activity
 * @param {Record<string, number>} abilities
 * @param {number} prof
 * @param {boolean} monster
 * @param {number} level
 * @returns {object|null}
 */
function toFeature(doc, item, activity, abilities, prof, monster, level) {
  if (!exportFeature(item, activity, monster)) return null;
  const levels = classLevels(doc);
  const profile = profileFor(item, activity);
  const name = activity.name && !/^consume$/i.test(activity.name) ? activity.name : (item.name || "Feature");
  const action = {
    name,
    img: typeof item.img === "string" && item.img.length > 0 ? item.img : null,
    kind: activity.type === "heal" && profile !== "lay-on-hands" && profile !== "remove-poison" ? "heal" : "feature",
    activation: activationOf(item, activity),
    profile,
    useKey: item.name || name
  };
  const uses = itemUses(item, doc, abilities, level);
  const spends = (activity.consumption?.targets ?? []).some(target => target?.type === "itemUses")
    || item.type === "consumable";
  if (spends && uses != null) action.uses = uses;
  if (profile === "lay-on-hands") {
    action.pool = 5 * (levels.paladin || 0);
    action.uses = action.pool;
  }
  if (activity.type === "heal" && profile !== "lay-on-hands") {
    const dice = healDice(activity, levels);
    if (dice) action.heal = dice;
  }
  if (profile === "rage") {
    const row = scaleAt("barbarian", "rage-damage", level);
    action.rageDamage = row?.value ?? 2;
  }
  if (profile === "bardic") {
    const row = scaleAt("bard", "inspiration", level);
    action.bardic = `1d${row?.faces || 6}`;
  }
  if (profile === "flurry") {
    const row = scaleAt("monk", "die", level);
    const mod = Math.max(abilityMod(abilities.str), abilityMod(abilities.dex));
    action.strike = `1d${row?.faces || 6}${mod ? (mod > 0 ? `+${mod}` : String(mod)) : ""}`;
    action.rays = 2;
  }
  const sentence = firstSentence(plainText(item.system?.description?.value));
  if (sentence) action.logText = sentence.slice(0, 240);
  return applySpellShape(action, item, { doc, abilities, prof });
}

function toAction(doc, item, activity, abilities, prof, monster, level) {
  const kind = activity.type;
  if (/^attack (at|with) advantage$/i.test(activity.name || "")) return null;
  const ident = item.system?.identifier || "";
  if ((item.name === "Spirit Guardians" || ident === "spirit-guardians") && kind === "save") return null;
  if (kind !== "attack" && kind !== "save" && kind !== "damage") {
    return toFeature(doc, item, activity, abilities, prof, monster, level);
  }

  const classification = activity.attack?.type?.classification;
  const isSpell = item.type === "spell" || classification === "spell";
  const ranged = activity.attack?.type?.value === "ranged";
  const spellAbility = doc.system?.attributes?.spellcasting || "int";
  const stated = activity.attack?.ability;
  let ability = stated && stated !== "none" && stated !== "spellcasting" && abilities[stated] != null
    ? stated
    : null;
  if (!ability) {
    const props = item.system?.properties ?? [];
    if (isSpell || stated === "spellcasting") ability = spellAbility;
    else if (props.includes("fin")) {
      ability = abilityMod(abilities.dex) > abilityMod(abilities.str) ? "dex" : "str";
    } else if (ranged) ability = "dex";
    else ability = "str";
  }
  const modifier = abilityMod(abilities[ability]);
  const attackBonus = Number(activity.attack?.bonus);
  const flatBonus = Number.isFinite(attackBonus) ? attackBonus : 0;

  const action = {
    name: activity.name || item.name || "Action",
    img: typeof item.img === "string" && item.img.length > 0 ? item.img : null
  };
  Object.assign(action, reachAndRange(item, activity, ranged));

  if (kind === "save") {
    const saveAbility = Array.isArray(activity.save?.ability)
      ? activity.save.ability[0]
      : activity.save?.ability;
    const calc = activity.save?.dc?.calculation;
    const dcAbility = calc && calc !== "spellcasting" && abilities[calc] != null ? calc : spellAbility;
    action.kind = isSpell ? "spell" : "attack";
    action.saveAbility = saveAbility || dcAbility;
    const computed = saveDcValue(activity, { doc, item, abilities, prof });
    action.saveDc = computed == null ? 8 + prof + abilityMod(abilities[dcAbility]) : computed;
    action.onSave = activity.damage?.onSave || "half";
    action.damage = damageParts(item, activity, modifier, false);
    return finish(action, item, activity);
  }

  if (kind === "damage") {
    const level = Number(item.system?.level) || 0;
    const count = activity.target?.override === false || activity.target?.affects?.count == null
      ? item.system?.target?.affects?.count
      : activity.target?.affects?.count;
    action.kind = "spell";
    action.autoHit = true;
    action.damage = damageParts(item, activity, modifier, true).map((entry, index) => {
      if (index === 0) entry.darts = dartCount(count, level);
      return entry;
    });
    return finish(action, item, activity);
  }

  action.damage = damageParts(item, activity, modifier, monster);
  if (monster) {
    action.kind = isSpell ? "spell" : "attack";
    action.toHit = activity.attack?.flat ? flatBonus : modifier + prof + flatBonus;
    return finish(action, item, activity);
  }

  if (isSpell) {
    action.kind = "spell";
    action.attackAbility = ability;
    return finish(action, item, activity);
  }

  action.kind = "weapon";
  action.properties = weaponProperties(item, ranged);
  return finish(action, item, activity);
}

/**
 * Damage entries for an activity. Monster weapon dice include the ability modifier.
 * @param {object} item
 * @param {object} activity
 * @param {number} modifier
 * @param {boolean} bakeModifier
 * @returns {{ dice: string, type: string }[]}
 */
function damageParts(item, activity, modifier, bakeModifier) {
  const parts = [];
  const offersBase = item.type === "weapon"
    || (item.type === "consumable" && item.system?.type?.value === "ammo");
  if (activity.type === "attack" && activity.damage?.includeBase !== false && offersBase) {
    const base = item.system?.damage?.base;
    const entry = damageEntry(base, modifier, bakeModifier);
    if (entry) parts.push(entry);
  }
  const source = activity.type === "heal" ? [activity.healing] : (activity.damage?.parts ?? []);
  for (const part of source) {
    const entry = damageEntry(part, modifier, false);
    if (entry) parts.push(entry);
  }
  return parts;
}

/**
 * Weapon property names the battlemat already understands.
 * @param {object} item
 * @param {boolean} ranged
 * @returns {string[]}
 */
function weaponProperties(item, ranged) {
  const props = [];
  for (const code of item.system?.properties ?? []) {
    if (PROPERTIES[code]) props.push(PROPERTIES[code]);
  }
  if (ranged && !props.includes("ranged")) props.push("ranged");
  return props;
}

/**
 * One battlemat creature from a Foundry actor.
 * @param {object} doc
 * @param {string} sourcePath
 * @param {boolean} monster
 * @returns {object}
 */
function toCreature(doc, sourcePath, monster) {
  const abilities = abilityScores(doc);
  const items = (doc.items ?? []).filter(item => item?.system?.source?.rules !== "2014");
  const classes = items.filter(item => item.type === "class");
  const classLevels = classes.reduce((sum, item) => sum + (Number(item.system?.levels) || 0), 0);
  const pathLevel = /premades\/level-(\d+)\//.exec(sourcePath);
  const level = classLevels || (pathLevel ? Number(pathLevel[1]) : 1);
  const cr = Number(doc.system?.details?.cr);
  const prof = proficiencyBonus(monster ? Math.max(Number.isFinite(cr) ? cr : 1, 1) : level);
  const names = new Map();
  const actions = [];

  const sorted = items.slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  for (const item of sorted) {
    const activities = activityList(item.system?.activities)
      .slice()
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const built = [];
    const riders = activities.filter(activity => /^attack (at|with) advantage$/i.test(activity.name || ""));
    for (const activity of activities) {
      const action = toAction(doc, item, activity, abilities, prof, monster, level);
      if (!action) continue;
      built.push({ action, raw: typeof activity.name === "string" ? activity.name.trim() : "" });
    }
    for (const rider of riders) {
      const extra = (rider.damage?.parts ?? []).map(part => damageEntry(part, 0, false)).find(Boolean);
      const host = built.find(entry => (
        entry.action.kind === "weapon" || entry.action.kind === "attack" || entry.action.toHit !== undefined
      ) && !entry.action.advantageRider);
      if (host && extra) host.action.advantageRider = extra;
    }
    const placeholders = built.filter(entry => isPlaceholder(entry.raw));
    if (placeholders.length === 1 && item.name) placeholders[0].action.name = item.name;
    else if (placeholders.length > 1 && item.name) {
      for (const entry of placeholders) entry.action.name = `${item.name} (${entry.raw})`;
    }
    for (const entry of built) {
      const count = names.get(entry.action.name) ?? 0;
      names.set(entry.action.name, count + 1);
      if (count > 0) entry.action.name = `${entry.action.name} (${count + 1})`;
      actions.push(entry.action);
    }
  }

  const itemsById = new Map(items.filter(item => item._id).map(item => [item._id, item]));
  const features = items
    .filter(item => item.type === "feat" && item.name)
    .map(item => ({
      name: item.name,
      summary: featureSummary(item.system?.description?.value, {
        doc, item, abilities, prof, monster, itemsById
      }) || item.name
    }));

  const race = items.find(item => item.type === "race");
  const subclasses = items.filter(item => item.type === "subclass").map(item => item.name);
  const classLabel = classes.map(item => `${item.name} ${item.system?.levels ?? ""}`.trim()).join(" / ");
  const space = footprint(doc);

  const creature = {
    id: doc._id,
    foundryId: doc._id,
    name: monster || !level ? doc.name : `${doc.name} (${level})`,
    team: monster ? "monster" : "player",
    type: creatureKind(doc, monster),
    rules: "2024",
    sourcePath,
    size: SIZES[doc.system?.traits?.size] ?? doc.system?.traits?.size ?? null,
    width: space.w,
    height: space.h,
    ac: armorClass(doc, abilities),
    hp: hitPoints(doc),
    speed: Number(doc.system?.attributes?.movement?.walk) || 0,
    proficiency: prof,
    abilities,
    saves: saveProficiencies(doc),
    resist: traitList(doc, "dr"),
    immune: traitList(doc, "di"),
    vuln: traitList(doc, "dv"),
    conditionImmune: traitList(doc, "ci"),
    token: tokenSrc(doc),
    img: typeof doc.img === "string" && doc.img.length > 0 ? doc.img : null,
    actions
  };

  if (monster) creature.traits = features;
  else {
    creature.class = subclasses.length ? `${classLabel} (${subclasses.join(", ")})` : classLabel;
    creature.race = race?.name ?? null;
    creature.features = features;
  }
  return creature;
}

const characters = [];
const monsters = [];

for (const file of walkYml(ACTORS)) {
  const sourcePath = path.relative(ROOT, file).split(path.sep).join("/");
  const doc = YAML.load(fs.readFileSync(file, "utf8"));
  if (!doc || typeof doc !== "object") continue;
  if (doc.system?.source?.rules === "2014") continue;
  if (doc.type === "character" && sourcePath.includes("/premades/")) {
    characters.push(toCreature(doc, sourcePath, false));
  } else if (doc.type === "npc") {
    monsters.push(toCreature(doc, sourcePath, true));
  }
}

characters.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
monsters.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

fs.mkdirSync(VTT_DATA, { recursive: true });
fs.writeFileSync(path.join(VTT_DATA, "characters.json"), `${JSON.stringify(characters, null, 2)}\n`);
fs.writeFileSync(path.join(VTT_DATA, "monsters.json"), `${JSON.stringify(monsters, null, 2)}\n`);

const goblin = monsters.find(monster => monster.id === "mmGoblinWarrior0");
const zanna = characters.find(character => character.id === "ZannaLv050000000");
const failures = [];
if (characters.length !== 48) failures.push(`expected 48 premades, got ${characters.length}`);
if (!goblin) failures.push("Goblin Warrior was not exported");
else {
  if (goblin.ac !== 15) failures.push(`Goblin AC is ${goblin.ac}`);
  if (goblin.token !== "tokens/humanoid/Goblin.webp") failures.push(`Goblin token is ${goblin.token}`);
  const scimitar = goblin.actions.find(action => action.name === "Scimitar");
  if (!scimitar || scimitar.toHit !== 4 || scimitar.damage?.[0]?.dice !== "1d6+2") {
    failures.push(`Goblin Scimitar is ${JSON.stringify(scimitar)}`);
  }
}
if (!zanna) failures.push("level 5 Zanna was not exported");
else {
  const missile = zanna.actions.find(action => action.name === "Magic Missile");
  if (!missile?.autoHit || missile.img !== "icons/magic/light/projectiles-pink-purple.webp") {
    failures.push(`Zanna Magic Missile is ${JSON.stringify(missile)}`);
  }
  if (missile?.damage?.[0]?.darts !== 3) failures.push(`Magic Missile darts are ${missile?.damage?.[0]?.darts}`);
  if (missile?.area) failures.push("Magic Missile should not cover an area");
  if (!zanna.saves || zanna.saves.int !== true || zanna.saves.wis !== true || zanna.saves.str !== false) {
    failures.push(`Zanna saves are ${JSON.stringify(zanna.saves)}`);
  }
}
const nimble = goblin?.traits?.find(trait => trait.name === "Nimble Escape");
if (nimble?.summary !== "The goblin warrior takes the Disengage or Hide action.") {
  failures.push(`Nimble Escape is ${JSON.stringify(nimble)}`);
}
const hezrou = monsters.find(monster => monster.id === "mmHezrou00000000");
const stench = hezrou?.traits?.find(trait => trait.name === "Stench");
const leap = hezrou?.traits?.find(trait => trait.name === "Leap");
if (!stench?.summary.includes("DC 16") || !stench.summary.includes("10-foot")) {
  failures.push(`Hezrou Stench is ${JSON.stringify(stench)}`);
}
if (!leap?.summary.includes("30 feet") || !leap.summary.includes("spending 10 feet")) {
  failures.push(`Hezrou Leap is ${JSON.stringify(leap)}`);
}
const dragon = monsters.find(monster => monster.id === "mmAncientRedDrag");
const giant = monsters.find(monster => monster.id === "mmHillGiant00000");
const randal = characters.find(character => character.id === "RandalLv05000000");
const sefris = characters.find(character => character.id === "SefrisLv05000000");
if (goblin && (goblin.width !== 1 || goblin.height !== 1)) {
  failures.push(`Goblin footprint is ${goblin?.width}x${goblin?.height}`);
}
if (!dragon || dragon.width !== 4 || dragon.height !== 4) {
  failures.push(`Ancient Red Dragon footprint is ${dragon?.width}x${dragon?.height}`);
}
if (!giant || giant.width !== 3 || giant.height !== 3) {
  failures.push(`Hill Giant footprint is ${giant?.width}x${giant?.height}`);
}
const multi = giant?.traits?.find(trait => trait.name === "Multiattack");
if (!multi?.summary.includes("Tree Club") || !multi.summary.includes("Trash Lob")) {
  failures.push(`Hill Giant Multiattack is ${JSON.stringify(multi)}`);
}
const iron = monsters.find(monster => monster.id === "mmIronGolem00000");
const ironMulti = iron?.traits?.find(trait => trait.name === "Multiattack");
if (!ironMulti?.summary.includes("Bladed Arm") || !ironMulti.summary.includes("Fiery Bolt")) {
  failures.push(`Iron Golem Multiattack is ${JSON.stringify(ironMulti)}`);
}
const stone = monsters.find(monster => monster.id === "mmStoneGolem0000");
const stoneMulti = stone?.traits?.find(trait => trait.name === "Multiattack");
if (!stoneMulti?.summary.includes("Slam") || !stoneMulti.summary.includes("Force Bolt")) {
  failures.push(`Stone Golem Multiattack is ${JSON.stringify(stoneMulti)}`);
}
const ravens = monsters.find(monster => monster.id === "mmSwarmOfRavens0");
const cacophony = ravens?.traits?.find(trait => trait.name === "Cacophony");
if (!cacophony?.summary.includes("DC 10")) {
  failures.push(`Cacophony is ${JSON.stringify(cacophony)}`);
}
const secondWind = randal?.features?.find(feature => feature.name === "Second Wind");
if (!secondWind?.summary.includes("1d10") || !secondWind.summary.includes("Long Rest") || /stamina/.test(secondWind.summary)) {
  failures.push(`Second Wind is ${JSON.stringify(secondWind)}`);
}
const surge = randal?.features?.find(feature => feature.name === "Action Surge");
if (!surge?.summary.includes("additional action") || !surge.summary.includes("level 17")) {
  failures.push(`Action Surge is ${JSON.stringify(surge)}`);
}
const mage = monsters.find(monster => monster.id === "mmMage0000000000");
const fireball = mage?.actions.find(action => action.name === "Fireball");
if (!fireball?.area || fireball.area.type !== "sphere" || fireball.area.size !== 20 || fireball.area.origin !== "point") {
  failures.push(`Mage Fireball area is ${JSON.stringify(fireball && fireball.area)}`);
}
const hold = sefris?.actions.find(action => action.name === "Hold Person");
if (!hold || hold.area || !hold.conditions || hold.conditions[0] !== "paralyzed") {
  failures.push(`Hold Person is ${JSON.stringify(hold)}`);
}
const morthos = characters.find(character => character.id === "MorthosLv0100000");
const hands = morthos?.actions.find(action => action.name === "Burning Hands");
if (!hands?.area || hands.area.type !== "cone" || hands.area.size !== 15 || hands.area.origin !== "self" || hands.reach) {
  failures.push(`Burning Hands is ${JSON.stringify(hands)}`);
}
const zanna1 = characters.find(character => character.id === "ZannaLv010000000");
const wave = zanna1?.actions.find(action => action.name === "Thunderwave");
if (!wave?.area || wave.area.type !== "cube" || wave.area.size !== 15 || wave.area.origin !== "self" || wave.reach) {
  failures.push(`Thunderwave is ${JSON.stringify(wave)}`);
}
const redDragon = monsters.find(monster => monster.id === "mmAdultRedDragon");
const redBreath = redDragon?.actions.find(action => action.name === "Fire Breath");
if (!redBreath?.area || redBreath.area.type !== "cone" || redBreath.area.size !== 60 || redBreath.area.origin !== "self") {
  failures.push(`Adult Red Fire Breath is ${JSON.stringify(redBreath && redBreath.area)}`);
}
if (redBreath?.uses !== 1 || redBreath?.recharge !== 5 || redBreath?.useKey !== "Fire Breath") {
  failures.push(`Adult Red Fire Breath recharge is ${JSON.stringify(redBreath && { uses: redBreath.uses, recharge: redBreath.recharge, useKey: redBreath.useKey })}`);
}
const redRend = redDragon?.actions.find(action => action.name === "Rend");
if (redRend?.uses != null || redRend?.recharge != null) {
  failures.push(`Adult Red Rend picked up a recharge: ${JSON.stringify(redRend && { uses: redRend.uses, recharge: redRend.recharge })}`);
}
const youngRed = monsters.find(monster => monster.id === "mmYoungRedDragon");
const youngBreath = youngRed?.actions.find(action => action.name === "Fire Breath");
if (youngBreath?.uses !== 1 || youngBreath?.recharge !== 6 || youngBreath?.useKey !== "Fire Breath") {
  failures.push(`Young Red Fire Breath recharge is ${JSON.stringify(youngBreath && { uses: youngBreath.uses, recharge: youngBreath.recharge, useKey: youngBreath.useKey })}`);
}
const goldDragon = monsters.find(monster => monster.id === "mmAdultGoldDrago");
const banish = goldDragon?.actions.find(action => action.name === "Banish");
if (!banish || banish.area || banish.range?.normal !== 120 || banish.reach) {
  failures.push(`Banish is ${JSON.stringify(banish)}`);
}
const goldBreath = goldDragon?.actions.find(action => action.name === "Fire Breath");
if (!goldBreath?.area || goldBreath.area.type !== "line" || goldBreath.area.size !== 15 || goldBreath.area.width !== 5 || goldBreath.area.origin !== "self") {
  failures.push(`Adult Gold Fire Breath is ${JSON.stringify(goldBreath && goldBreath.area)}`);
}
const green = monsters.find(monster => monster.id === "mmAdultGreenDrag");
const greenBreath = green?.actions.find(action => action.name === "Poison Breath");
if (green?.type !== "dragon") failures.push(`Adult Green type is ${green?.type}`);
if (!greenBreath?.area || greenBreath.area.type !== "cone" || greenBreath.area.size !== 60 || greenBreath.area.origin !== "self") {
  failures.push(`Adult Green Poison Breath is ${JSON.stringify(greenBreath)}`);
}
if (green?.actions.some(action => action.name === "Save")) {
  failures.push("Adult Green still has an action named Save");
}
const ancientGreen = monsters.find(monster => monster.id === "mmAncientGreenDr");
const ancientBreath = ancientGreen?.actions.find(action => action.name === "Poison Breath");
if (!ancientBreath?.area || ancientBreath.area.type !== "cone" || ancientBreath.area.size !== 15 || ancientBreath.area.origin !== "self") {
  failures.push(`Ancient Green Poison Breath is ${JSON.stringify(ancientBreath && ancientBreath.area)}`);
}
const brass = monsters.find(monster => monster.id === "mmAdultBrassDrag");
const firstSleep = brass?.actions.find(action => action.name === "Sleep Breath (1st Save)");
const secondSleep = brass?.actions.find(action => action.name === "Sleep Breath (2nd Save)");
if (!firstSleep?.area || firstSleep.area.type !== "cone" || firstSleep.area.size !== 60 || firstSleep.area.origin !== "self" || !secondSleep) {
  failures.push(`Sleep Breath names are ${firstSleep?.name} / ${secondSleep?.name}`);
}
const morthos5 = characters.find(character => character.id === "MorthosLv0500000");
const exhale = morthos5?.actions.find(action => action.name === "Exhale");
if (!exhale?.area || exhale.area.type !== "cone" || exhale.area.size !== 15 || exhale.area.origin !== "self" || exhale.reach) {
  failures.push(`Exhale is ${JSON.stringify(exhale && { area: exhale.area, reach: exhale.reach, range: exhale.range })}`);
}
const krusk = characters.find(character => character.id === "KruskLv110000000");
const bolt = krusk?.actions.find(action => action.name === "Lightning Bolt");
if (!bolt?.area || bolt.area.type !== "line" || bolt.area.origin !== "point" || bolt.area.size !== 120 || bolt.range?.normal !== 120) {
  failures.push(`Krusk Lightning Bolt is ${JSON.stringify(bolt && { area: bolt.area, range: bolt.range, reach: bolt.reach })}`);
}
if (!hold?.targets || hold.targets.length !== 1 || hold.targets[0] !== "humanoid") {
  failures.push(`Hold Person targets are ${JSON.stringify(hold?.targets)}`);
}
const akra = characters.find(character => character.id === "AkraLv0500000000");
const turn = akra?.actions.find(action => action.name === "Turn Undead");
const sear = akra?.actions.find(action => action.name === "Channel Divinity: Turn Undead");
if (!turn || turn.area || !turn.targets || turn.targets.length !== 1 || turn.targets[0] !== "undead" || turn.range?.normal !== 30) {
  failures.push(`Turn Undead is ${JSON.stringify(turn && { area: turn.area, targets: turn.targets, range: turn.range })}`);
}
if (!sear?.area || sear.area.type !== "radius" || sear.area.size !== 30 || sear.area.origin !== "self" || !sear.targets || sear.targets[0] !== "undead") {
  failures.push(`Sear Undead is ${JSON.stringify(sear && { name: sear.name, area: sear.area, targets: sear.targets })}`);
}
if (fireball?.targets) failures.push(`Fireball targets are ${JSON.stringify(fireball.targets)}`);
if (zanna && zanna.type !== "humanoid") failures.push(`Zanna type is ${zanna.type}`);
if (goblin && goblin.type !== "fey") failures.push(`Goblin type is ${goblin.type}`);
const zombie = monsters.find(monster => monster.id === "mmZombie00000000");
if (zombie?.type !== "undead") failures.push(`Zombie type is ${zombie?.type}`);
const harpy = monsters.find(monster => monster.id === "mmHarpy000000000");
const song = harpy?.actions.find(action => action.name === "Luring Song");
if (!song?.targets || song.targets.join(",") !== "humanoid,giant" || song.area?.type !== "radius" || song.area.size !== 300 || song.area.origin !== "self") {
  failures.push(`Luring Song is ${JSON.stringify(song && { area: song.area, targets: song.targets })}`);
}
const hag = monsters.find(monster => monster.id === "mmSeaHag00000000");
const vile = hag?.actions.find(action => action.name === "Vile Appearance");
if (!vile?.targets || vile.targets.join(",") !== "beast,humanoid" || vile.area) {
  failures.push(`Vile Appearance is ${JSON.stringify(vile && { area: vile.area, targets: vile.targets })}`);
}
const unicorn = monsters.find(monster => monster.id === "mmUnicorn0000000");
const dismissal = unicorn?.actions.find(action => action.name === "Dismissal");
if (!dismissal?.targets || dismissal.targets.join(",") !== "celestial,elemental,fey,fiend,undead") {
  failures.push(`Dismissal targets are ${JSON.stringify(dismissal?.targets)}`);
}
const ghoul = monsters.find(monster => monster.id === "mmGhoul000000000");
if (ghoul?.actions.some(action => action.name.startsWith("Claw") && action.targets)) {
  failures.push(`Ghoul Claw gained targets ${JSON.stringify(ghoul.actions.filter(action => action.name.startsWith("Claw")))}`);
}
const efreeti = monsters.find(monster => monster.id === "mmEfreeti0000000");
const wall = efreeti?.actions.find(action => action.name === "Create Wall");
if (!wall?.area || wall.area.type !== "wall" || wall.area.size !== 60 || wall.area.width !== 1 || wall.area.origin !== "point" || wall.range?.normal !== 120) {
  failures.push(`Create Wall is ${JSON.stringify(wall && { area: wall.area, range: wall.range, reach: wall.reach })}`);
}
const ice = monsters.find(monster => monster.id === "mmIceDevil000000");
const panels = ice?.actions.find(action => action.name === "Create Panels");
if (!panels?.area || panels.area.type !== "wall" || panels.area.size !== 10 || panels.area.origin !== "point" || panels.range?.normal !== 120) {
  failures.push(`Create Panels is ${JSON.stringify(panels && { area: panels.area, range: panels.range })}`);
}
const agonizing = sefris?.features?.find(feature => feature.name === "Agonizing Blast");
if (!agonizing?.summary.includes("Charisma") || !agonizing.summary.includes("more than once")) {
  failures.push(`Agonizing Blast is ${JSON.stringify(agonizing)}`);
}
const boss = monsters.find(monster => monster.id === "mmGoblinBoss0000");
const bossBow = boss?.actions.find(action => action.name === "Shortbow");
if (boss?.actions.some(action => /advantage/i.test(action.name))) {
  failures.push("Goblin Boss still has an advantage button");
}
if (!bossBow?.advantageRider || bossBow.advantageRider.dice !== "1d4" || bossBow.advantageRider.type !== "piercing") {
  failures.push(`Goblin Boss Shortbow rider is ${JSON.stringify(bossBow && bossBow.advantageRider)}`);
}
const web = zanna?.actions.find(action => action.name === "Web");
if (!web?.zone || web.zone !== "web" || (web.damage || []).length || web.conditions?.[0] !== "restrained" || !web.concentration) {
  failures.push(`Web is ${JSON.stringify(web && { zone: web.zone, damage: web.damage, conditions: web.conditions, concentration: web.concentration })}`);
}
const slow = zanna?.actions.find(action => action.name === "Slow");
if (!slow?.repeatSave || slow.conditions?.[0] !== "slowed" || !slow.concentration || slow.limit !== 6) {
  failures.push(`Slow is ${JSON.stringify(slow && { conditions: slow.conditions, repeatSave: slow.repeatSave, limit: slow.limit })}`);
}
const command = sefris?.actions.find(action => action.name === "Command");
if (!command?.command) failures.push("Command does not ask for a word");
const rays = zanna?.actions.find(action => action.name === "Scorching Ray");
if (rays?.rays !== 3) failures.push(`Scorching Ray rays are ${rays?.rays}`);
const wind = randal?.actions.find(action => action.name === "Second Wind");
if (!wind || wind.activation !== "bonus" || wind.heal !== "1d10+5" || wind.uses !== 3) {
  failures.push(`Second Wind action is ${JSON.stringify(wind && { activation: wind.activation, heal: wind.heal, uses: wind.uses, kind: wind.kind })}`);
}
const surgeAction = randal?.actions.find(action => action.name === "Action Surge");
if (!surgeAction || surgeAction.profile !== "action-surge" || surgeAction.uses !== 1) {
  failures.push(`Action Surge action is ${JSON.stringify(surgeAction && { profile: surgeAction.profile, uses: surgeAction.uses, activation: surgeAction.activation })}`);
}
const potion = randal?.actions.find(action => action.name === "Potion of Healing");
if (!potion || potion.heal !== "2d4+2" || potion.activation !== "bonus" || potion.uses !== 2) {
  failures.push(`Potion is ${JSON.stringify(potion && { heal: potion.heal, activation: potion.activation, uses: potion.uses })}`);
}
const merric = characters.find(character => character.id === "MerricLv05000000");
const rage = merric?.actions.find(action => action.profile === "rage");
if (!rage || rage.activation !== "bonus" || rage.rageDamage !== 2 || rage.uses !== 3) {
  failures.push(`Rage is ${JSON.stringify(rage && { activation: rage.activation, rageDamage: rage.rageDamage, uses: rage.uses })}`);
}
const riswynn = characters.find(character => character.id === "RiswynnLv0500000");
const dash = riswynn?.actions.find(action => action.name === "Dash");
if (!dash || dash.profile !== "dash" || dash.activation !== "bonus") {
  failures.push(`Cunning Action Dash is ${JSON.stringify(dash)}`);
}
if ([...characters, ...monsters].some(creature => (creature.actions || []).some(action => /wall of force/i.test(action.name)))) {
  failures.push("Wall of Force became a button");
}
const grease = morthos5?.actions.find(action => action.name === "Grease");
if (!grease?.zone || grease.zone !== "grease" || grease.conditions?.[0] !== "prone") {
  failures.push(`Grease is ${JSON.stringify(grease && { zone: grease.zone, conditions: grease.conditions })}`);
}
const guardians = (akra?.actions || []).filter(action => action.name === "Spirit Guardians");
const spirit = guardians[0];
if (
  (akra?.actions || []).some(action => action.name === "Emanation Save")
  || guardians.length !== 1
  || spirit?.kind !== "spell"
  || spirit?.zone !== "spirit"
  || spirit?.profile
  || spirit?.area?.type !== "radius"
  || spirit?.area?.size !== 15
  || spirit?.area?.origin !== "self"
  || spirit?.saveAbility !== "wis"
  || spirit?.saveDc !== 15
  || spirit?.onSave !== "half"
  || spirit?.damage?.[0]?.dice !== "3d8"
  || spirit?.damage?.[0]?.type !== "radiant"
  || spirit?.damageChoice?.join(",") !== "Radiant,Necrotic"
  || !spirit?.concentration
  || spirit?.durationRounds !== 100
) {
  failures.push(`Spirit Guardians is ${JSON.stringify(spirit && {
    kind: spirit.kind,
    zone: spirit.zone,
    profile: spirit.profile,
    area: spirit.area,
    saveAbility: spirit.saveAbility,
    saveDc: spirit.saveDc,
    onSave: spirit.onSave,
    damage: spirit.damage,
    damageChoice: spirit.damageChoice,
    concentration: spirit.concentration,
    durationRounds: spirit.durationRounds
  })}`);
}
const leftover = [...characters, ...monsters].flatMap(creature => creature.traits || creature.features || [])
  .filter(trait => /\[\[|&Reference|Foundry Note|@Embed/.test(trait.summary));
if (leftover.length) {
  const sample = leftover.slice(0, 8).map(trait => `${trait.name}: ${trait.summary.slice(0, 160)}`).join("\n");
  failures.push(`${leftover.length} traits still contain Foundry markup\n${sample}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  characters: characters.length,
  monsters: monsters.length,
  goblin: { ac: goblin.ac, token: goblin.token, scimitar: goblin.actions.find(action => action.name === "Scimitar") },
  zanna: {
    class: zanna.class,
    ac: zanna.ac,
    hp: zanna.hp,
    missile: zanna.actions.find(action => action.name === "Magic Missile")
  }
}, null, 2));
