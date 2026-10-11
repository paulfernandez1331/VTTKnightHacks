import json
import math
import re
from html import unescape
from pathlib import Path


# --------------------------------------------------
# Small helper functions
# --------------------------------------------------

def ability_modifier(score):
    """
    Convert an ability score into its modifier.

    Examples:
    15 becomes +2
    12 becomes +1
    8 becomes -1
    """
    return math.floor((score - 10) / 2)


def proficiency_bonus(level):
    """
    Calculate proficiency bonus from total character level.

    Levels 1-4:   +2
    Levels 5-8:   +3
    Levels 9-12:  +4
    Levels 13-16: +5
    Levels 17-20: +6
    """
    return 2 + ((level - 1) // 4)


def remove_html(text):
    """
    Convert an HTML description into ordinary text.

    Example:
    "<p>You have <strong>Advantage</strong>.</p>"

    becomes:

    "You have Advantage."
    """
    if not text:
        return ""

    # Convert certain HTML tags into spaces or line breaks.
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"</p>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"</li>", " ", text, flags=re.IGNORECASE)

    # Remove all remaining HTML tags.
    text = re.sub(r"<[^>]+>", "", text)

    # Convert things like &amp; into &.
    text = unescape(text)

    # Replace repeated whitespace with one space.
    text = re.sub(r"\s+", " ", text)

    return text.strip()


def make_id(name, character_id):
    """
    Create a simple ID from the character's name and D&D Beyond ID.
    """
    clean_name = re.sub(r"[^A-Za-z0-9]", "", name)

    return f"{clean_name}{character_id}"


# --------------------------------------------------
# Ability scores
# --------------------------------------------------

def extract_abilities(character):
    """
    D&D Beyond identifies ability scores with numbers:

    1 = Strength
    2 = Dexterity
    3 = Constitution
    4 = Intelligence
    5 = Wisdom
    6 = Charisma
    """
    ability_names = {
        1: "str",
        2: "dex",
        3: "con",
        4: "int",
        5: "wis",
        6: "cha",
    }

    abilities = {
        "str": 10,
        "dex": 10,
        "con": 10,
        "int": 10,
        "wis": 10,
        "cha": 10,
    }

    for stat in character.get("stats", []):
        stat_id = stat.get("id")
        stat_name = ability_names.get(stat_id)

        if stat_name is not None:
            abilities[stat_name] = stat.get("value", 10)

    return abilities


# --------------------------------------------------
# Classes
# --------------------------------------------------

def extract_classes(character):
    """
    Convert the D&D Beyond class list into a target-format string.

    Example:
    "Barbarian 1"

    A multiclass character might become:
    "Barbarian 3 / Fighter 2"
    """
    class_parts = []
    total_level = 0

    for character_class in character.get("classes", []):
        level = character_class.get("level", 0)
        definition = character_class.get("definition", {})
        class_name = definition.get("name", "Unknown Class")

        class_parts.append(f"{class_name} {level}")
        total_level += level

    class_text = " / ".join(class_parts)

    return class_text, total_level


# --------------------------------------------------
# Hit points
# --------------------------------------------------

def calculate_hp(character, abilities, total_level):
    """
    Calculate the maximum HP.

    D&D Beyond's baseHitPoints generally excludes the Constitution
    modifier applied at each character level.

    Maximum HP =
        base hit points
        + Constitution modifier per level
        + bonus hit points

    An override value is used if one exists.
    """
    override_hp = character.get("overrideHitPoints")

    if override_hp is not None:
        maximum_hp = override_hp
    else:
        base_hp = character.get("baseHitPoints") or 0
        bonus_hp = character.get("bonusHitPoints") or 0
        constitution_modifier = ability_modifier(abilities["con"])

        maximum_hp = (
            base_hp
            + bonus_hp
            + constitution_modifier * total_level
        )

    removed_hp = character.get("removedHitPoints") or 0
    current_hp = max(0, maximum_hp - removed_hp)

    return {
        "maximum": maximum_hp,
        "current": current_hp,
    }


# --------------------------------------------------
# Armor Class
# --------------------------------------------------

def calculate_ac(character, abilities):
    """
    Calculate a basic Armor Class.

    This version handles:
    - equipped armor
    - equipped shield
    - Barbarian Unarmored Defense
    - ordinary unarmored AC

    More complicated magical modifiers can be added later.
    """
    dex_modifier = ability_modifier(abilities["dex"])
    con_modifier = ability_modifier(abilities["con"])

    equipped_armor = None
    shield_bonus = 0

    for item in character.get("inventory", []):
        if not item.get("equipped", False):
            continue

        definition = item.get("definition", {})
        armor_class = definition.get("armorClass")
        item_name = definition.get("name", "").lower()
        armor_type_id = definition.get("armorTypeId")

        if "shield" in item_name:
            shield_bonus += armor_class or 2
        elif armor_class is not None:
            equipped_armor = {
                "armor_class": armor_class,
                "armor_type_id": armor_type_id,
            }

    if equipped_armor is not None:
        base_ac = equipped_armor["armor_class"]
        armor_type_id = equipped_armor["armor_type_id"]

        # These IDs can vary, but commonly represent:
        # 1 = light armor
        # 2 = medium armor
        # 3 = heavy armor
        if armor_type_id == 1:
            ac = base_ac + dex_modifier
        elif armor_type_id == 2:
            ac = base_ac + min(dex_modifier, 2)
        else:
            ac = base_ac

        return ac + shield_bonus

    # Check whether the character has Barbarian Unarmored Defense.
    has_barbarian_unarmored_defense = False

    for character_class in character.get("classes", []):
        class_level = character_class.get("level", 0)

        for feature in character_class.get("classFeatures", []):
            definition = feature.get("definition", {})

            if (
                definition.get("name") == "Unarmored Defense"
                and definition.get("requiredLevel", 1) <= class_level
            ):
                has_barbarian_unarmored_defense = True

    if has_barbarian_unarmored_defense:
        return 10 + dex_modifier + con_modifier + shield_bonus

    return 10 + dex_modifier + shield_bonus


# --------------------------------------------------
# Weapons and actions
# --------------------------------------------------

def extract_weapon_actions(character):
    """
    Convert weapons in the D&D Beyond inventory into target actions.

    Duplicate weapons are included only once.
    """
    actions = []
    weapon_names_already_added = set()

    for item in character.get("inventory", []):
        definition = item.get("definition", {})

        if definition.get("filterType") != "Weapon":
            continue

        weapon_name = definition.get("name", "Unknown Weapon")

        # Do not add five separate Spear actions just because
        # the character owns five spears.
        name_key = weapon_name.lower()

        if name_key in weapon_names_already_added:
            continue

        weapon_names_already_added.add(name_key)

        action = {
            "name": weapon_name,
            "img": definition.get("avatarUrl"),
            "damage": [],
            "kind": "weapon",
            "properties": [],
        }

        attack_type = definition.get("attackType")

        # D&D Beyond commonly uses attackType 1 for melee weapons.
        if attack_type == 1:
            action["reach"] = definition.get("range") or 5

        normal_range = definition.get("range")
        long_range = definition.get("longRange")

        property_names = [
            prop.get("name", "").lower()
            for prop in definition.get("properties") or []
        ]

        if "thrown" in property_names or attack_type == 2:
            action["range"] = {
                "normal": normal_range or 5,
                "long": long_range or normal_range or 5,
            }

        damage = definition.get("damage")

        if damage and damage.get("diceString"):
            action["damage"].append({
                "dice": damage["diceString"],
                "type": (definition.get("damageType") or "unknown").lower(),
            })

        # Target format uses lowercase property names.
        action["properties"] = property_names

        actions.append(action)

    return actions


# --------------------------------------------------
# Features
# --------------------------------------------------

def add_feature(features, names_seen, name, summary):
    """
    Add a feature unless another feature with the same name
    was already added.
    """
    if not name:
        return

    name_key = name.lower()

    if name_key in names_seen:
        return

    names_seen.add(name_key)

    features.append({
        "name": name,
        "summary": remove_html(summary),
    })


def extract_features(character, total_level):
    """
    Collect:
    - class features available at the current level
    - racial traits available at the current level
    - selected racial options
    - feats
    """
    features = []
    names_seen = set()

    # Class features
    for character_class in character.get("classes", []):
        class_level = character_class.get("level", 0)

        for feature in character_class.get("classFeatures", []):
            definition = feature.get("definition", {})
            required_level = definition.get("requiredLevel") or 1

            if required_level <= class_level:
                add_feature(
                    features,
                    names_seen,
                    definition.get("name"),
                    definition.get("snippet")
                    or definition.get("description"),
                )

    # Racial traits
    race = character.get("race") or {}

    for trait in race.get("racialTraits", []):
        definition = trait.get("definition", {})
        required_level = definition.get("requiredLevel")

        if required_level is None or required_level <= total_level:
            # Skip technical entries that generally don't need
            # to appear as features.
            ignored_names = {
                "Creature Type",
                "Size",
                "Speed",
                "Languages",
                "Ability Score Increases",
            }

            if definition.get("name") not in ignored_names:
                add_feature(
                    features,
                    names_seen,
                    definition.get("name"),
                    definition.get("snippet")
                    or definition.get("description"),
                )

    # Selected racial options, such as Stone's Endurance
    options = character.get("options") or {}

    for racial_option in options.get("race") or []:
        definition = racial_option.get("definition", {})

        add_feature(
            features,
            names_seen,
            definition.get("name"),
            definition.get("snippet")
            or definition.get("description"),
        )

    # Feats
    for feat in character.get("feats", []):
        definition = feat.get("definition", {})
        feat_name = definition.get("name", "")

        # Skip technical/internal feats.
        if "ability score improvement" in feat_name.lower():
            continue

        add_feature(
            features,
            names_seen,
            feat_name,
            definition.get("snippet")
            or definition.get("description"),
        )

    return features


# --------------------------------------------------
# Spells and other sheet actions
# --------------------------------------------------

ABILITY_IDS = {
    1: "str",
    2: "dex",
    3: "con",
    4: "int",
    5: "wis",
    6: "cha",
}

# Ids from the character-service payload. Shield is 4. Fire Bolt is 1.
ACTIVATION_IDS = {
    1: "action",
    3: "bonus",
    4: "reaction",
}

# 1 bludgeoning, 2 piercing, and 3 slashing are the physical types on the sheet.
DAMAGE_TYPE_IDS = {
    1: "bludgeoning",
    2: "piercing",
    3: "slashing",
    4: "necrotic",
    5: "acid",
    6: "cold",
    7: "fire",
    8: "force",
    9: "lightning",
    10: "poison",
    11: "psychic",
    12: "radiant",
    13: "thunder",
}

AREA_TYPES = {
    "cone": "cone",
    "cube": "cube",
    "line": "line",
    "sphere": "sphere",
    "square": "square",
    "cylinder": "cylinder",
}


def activation_name(node):
    """
    Turn a D&D Beyond activationType into action, bonus, reaction, or special.
    """
    activation = node.get("activation") or {}
    return ACTIVATION_IDS.get(activation.get("activationType"), "special")


def spellcasting_ability(character, class_id):
    """
    The ability the owning class uses to cast spells.

    A spell with no class falls back to the first class that has one.
    """
    fallback = None

    for row in character.get("classes") or []:
        ability_id = (row.get("definition") or {}).get("spellCastingAbilityId")
        ability = ABILITY_IDS.get(ability_id)
        if ability is None:
            continue
        if fallback is None:
            fallback = ability
        if class_id is not None and row.get("id") == class_id:
            return ability

    return fallback or "int"


def flat_bonus(character, suffix):
    """
    Add equipped bonuses such as a +1 grimoire.

    suffix is "spell-attacks" or "spell-save-dc".
    """
    modifiers = character.get("modifiers") or {}
    if not isinstance(modifiers, dict):
        return 0

    total = 0
    for group in modifiers.values():
        if not isinstance(group, list):
            continue
        for modifier in group:
            if not isinstance(modifier, dict) or modifier.get("type") != "bonus":
                continue
            sub_type = str(modifier.get("subType") or "")
            if not sub_type.endswith(suffix):
                continue
            amount = modifier.get("fixedValue")
            if not isinstance(amount, (int, float)):
                amount = modifier.get("value")
            if isinstance(amount, (int, float)):
                total += int(amount)

    return total


def spell_is_available(spell):
    """
    Prepared spells, always-prepared spells, and cantrips can be clicked.

    An unprepared spellbook entry is left off the sheet.
    """
    definition = spell.get("definition") or {}
    if definition.get("level") == 0:
        return True
    if spell.get("alwaysPrepared") or spell.get("prepared"):
        return True
    return False


def each_spell(character):
    """
    Yield (spell, class id) from classSpells and from spells.class/race/item/feat.

    The downloaded sheet keeps the list under classSpells. spells.class is
    the same shape when that list is filled instead.
    """
    seen = set()

    def walk(entries, class_id):
        for spell in entries or []:
            if not isinstance(spell, dict):
                continue
            if spell.get("definition"):
                name = (spell["definition"].get("name") or "").strip().lower()
                if not name or name in seen:
                    continue
                seen.add(name)
                yield spell, class_id
                continue
            nested = spell.get("spells")
            if isinstance(nested, list):
                yield from walk(nested, spell.get("characterClassId", class_id))

    for group in character.get("classSpells") or []:
        if isinstance(group, dict):
            yield from walk(group.get("spells"), group.get("characterClassId"))

    spells = character.get("spells") or {}
    if isinstance(spells, dict):
        for key in ("class", "race", "item", "feat", "background"):
            yield from walk(spells.get(key), None)


def dice_at_level(modifier, level, scale_type):
    """
    Use a cantrip's character-level die. Slot-level extras stay off the button.
    """
    die = modifier.get("die") or {}
    base = die.get("diceString")
    if scale_type != "characterlevel":
        return base

    chosen = None
    higher = (modifier.get("atHigherLevels") or {}).get("higherLevelDefinitions") or []
    for row in higher:
        row_level = row.get("level")
        text = (row.get("dice") or {}).get("diceString")
        if not isinstance(row_level, int) or not text:
            continue
        if row_level <= level and (chosen is None or row_level >= chosen[0]):
            chosen = (row_level, text)

    return chosen[1] if chosen else base


def damage_parts(definition, level):
    """
    Damage dice live on definition.modifiers, type damage, die.diceString.
    """
    parts = []
    scale_type = definition.get("scaleType")

    for modifier in definition.get("modifiers") or []:
        if not isinstance(modifier, dict) or modifier.get("type") != "damage":
            continue
        dice = dice_at_level(modifier, level, scale_type)
        if not dice:
            continue
        parts.append({
            "dice": str(dice).replace(" ", ""),
            "type": str(modifier.get("subType") or "untyped").lower(),
        })

    return parts


def area_from_range(range_info):
    """
    Build an area when the sheet lists a cone, cube, line, sphere, or square.
    """
    if not isinstance(range_info, dict):
        return None

    kind = AREA_TYPES.get(str(range_info.get("aoeType") or "").lower())
    size = range_info.get("aoeValue")
    if size is None:
        size = range_info.get("aoeSize")
    if not kind or not isinstance(size, (int, float)) or size <= 0:
        return None

    origin = str(range_info.get("origin") or "").lower()
    area_origin = "self" if origin == "self" else "point"
    return {
        "type": kind,
        "size": int(size),
        "origin": area_origin,
    }


def range_value(range_info):
    if not isinstance(range_info, dict):
        return None
    value = range_info.get("rangeValue")
    if value is None:
        value = range_info.get("range")
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    return None


def save_result(description, has_damage):
    """
    A damaging save usually deals half. A success that deals nothing does not.
    """
    text = remove_html(description).lower()
    if "half as much" in text or "half damage" in text:
        return "half"
    if "no damage" in text:
        return "none"
    if has_damage:
        return "half"
    return "none"


def spell_to_action(spell, character, abilities, level, proficiency, class_id):
    """
    A spell with an attack, a save, or damage dice becomes a button.

    Anything else returns None and the caller keeps it as a feature.
    """
    definition = spell.get("definition") or {}
    name = (definition.get("name") or "").strip()
    if not name:
        return None

    outer_range = spell.get("range") if isinstance(spell.get("range"), dict) else {}
    inner_range = definition.get("range") if isinstance(definition.get("range"), dict) else {}
    chosen_range = outer_range if outer_range.get("aoeType") or outer_range.get("rangeValue") else inner_range
    if not chosen_range.get("aoeType") and inner_range.get("aoeType"):
        chosen_range = inner_range

    parts = damage_parts(definition, level)
    attacks = bool(definition.get("requiresAttackRoll") or definition.get("attackType"))
    saves = bool(definition.get("requiresSavingThrow") or definition.get("saveDcAbilityId"))
    area = area_from_range(chosen_range)
    if not attacks and not saves and not parts:
        return None

    ability = spellcasting_ability(character, class_id)
    action = {
        "name": name,
        "img": definition.get("avatarUrl") or spell.get("avatarUrl"),
        "kind": "spell",
        "activation": activation_name(spell if spell.get("activation") else definition),
        "damage": parts,
    }

    if area:
        action["area"] = area
        if area["origin"] == "point":
            distance = range_value(chosen_range) or range_value(inner_range)
            if distance:
                action["range"] = {"normal": distance, "long": distance}
    elif attacks or not area:
        distance = range_value(chosen_range) or range_value(inner_range)
        if distance:
            action["range"] = {"normal": distance, "long": distance}
        elif str((chosen_range or inner_range).get("origin") or "").lower() in ("touch", "self"):
            action["reach"] = 5

    if saves:
        save_ability = ABILITY_IDS.get(definition.get("saveDcAbilityId"), ability)
        modifier = ability_modifier(abilities.get(ability, 10))
        action["saveAbility"] = save_ability
        action["saveDc"] = 8 + proficiency + modifier + flat_bonus(character, "spell-save-dc")
        action["onSave"] = save_result(definition.get("description"), bool(parts))
    elif attacks:
        action["attackAbility"] = ability
        bonus = flat_bonus(character, "spell-attacks")
        if bonus:
            action["attackBonus"] = bonus
    elif parts:
        action["autoHit"] = True

    return action


def sheet_action_to_button(entry, character, abilities, level, proficiency):
    """
    A class, race, or feat action with an attack, a save, or damage dice.
    """
    if not isinstance(entry, dict):
        return None

    name = (entry.get("name") or "").strip()
    if not name:
        return None

    dice = entry.get("dice") if isinstance(entry.get("dice"), dict) else {}
    dice_string = dice.get("diceString")
    save_id = entry.get("saveStatId")
    fixed_hit = entry.get("fixedToHit")
    area = area_from_range(entry.get("range") or {})
    if not dice_string and save_id is None and fixed_hit is None and not area:
        return None

    damage_type = DAMAGE_TYPE_IDS.get(entry.get("damageTypeId"), "untyped")
    action = {
        "name": name,
        "kind": "attack",
        "activation": activation_name(entry),
        "damage": [],
    }
    if dice_string:
        action["damage"].append({
            "dice": str(dice_string).replace(" ", ""),
            "type": damage_type,
        })

    if area:
        action["area"] = area

    distance = range_value(entry.get("range") or {})
    long_distance = (entry.get("range") or {}).get("longRange")
    attack_type = entry.get("attackTypeRange")

    if save_id is not None or entry.get("fixedSaveDc") is not None:
        ability = spellcasting_ability(character, None)
        modifier = ability_modifier(abilities.get(ability, 10))
        action["kind"] = "spell"
        action["saveAbility"] = ABILITY_IDS.get(save_id, ability)
        if isinstance(entry.get("fixedSaveDc"), (int, float)):
            action["saveDc"] = int(entry["fixedSaveDc"])
        else:
            action["saveDc"] = 8 + proficiency + modifier + flat_bonus(character, "spell-save-dc")
        action["onSave"] = save_result(entry.get("description"), bool(dice_string))
    elif isinstance(fixed_hit, (int, float)):
        action["toHit"] = int(fixed_hit)
    else:
        ability_id = entry.get("abilityModifierStatId")
        if ability_id in ABILITY_IDS and (attack_type == 2 or area):
            action["kind"] = "spell"
            action["attackAbility"] = ABILITY_IDS[ability_id]
        else:
            action["kind"] = "weapon"
            action["properties"] = ["ranged"] if attack_type == 2 else []

    if attack_type == 2 or (isinstance(long_distance, (int, float)) and long_distance > 0):
        normal = distance or 5
        far = int(long_distance) if isinstance(long_distance, (int, float)) and long_distance > 0 else normal
        action["range"] = {"normal": normal, "long": far}
    elif distance and not (area and area["origin"] == "self"):
        action["reach"] = distance
    elif action["kind"] == "weapon":
        action["reach"] = 5

    return action


def extract_spell_actions(character, abilities, level, proficiency):
    """
    Split available spells into buttons and feature paragraphs.
    """
    actions = []
    features = []

    for spell, class_id in each_spell(character):
        if not spell_is_available(spell):
            continue
        definition = spell.get("definition") or {}
        action = spell_to_action(spell, character, abilities, level, proficiency, class_id)
        if action:
            actions.append(action)
            continue
        features.append({
            "name": definition.get("name"),
            "summary": remove_html(definition.get("snippet") or definition.get("description")),
        })

    return actions, features


def extract_sheet_actions(character, abilities, level, proficiency):
    """
    Buttons from data.actions that are attacks, saves, or damage.
    """
    actions = []
    root = character.get("actions") or {}
    if not isinstance(root, dict):
        return actions

    for key in ("race", "class", "feat", "item", "background"):
        for entry in root.get(key) or []:
            action = sheet_action_to_button(entry, character, abilities, level, proficiency)
            if action:
                actions.append(action)

    return actions


# --------------------------------------------------
# Main conversion
# --------------------------------------------------

def convert_character(ddb_json):
    """
    Convert the complete D&D Beyond response into one target character.
    """
    character = ddb_json["data"]

    abilities = extract_abilities(character)
    class_text, total_level = extract_classes(character)
    hp = calculate_hp(character, abilities, total_level)
    ac = calculate_ac(character, abilities)
    proficiency = proficiency_bonus(total_level)
    spell_actions, spell_features = extract_spell_actions(
        character, abilities, total_level, proficiency
    )
    sheet_actions = extract_sheet_actions(
        character, abilities, total_level, proficiency
    )

    character_id = str(character.get("id", "unknown"))
    name = character.get("name", "Unnamed Character")

    race = character.get("race") or {}
    race_name = race.get("fullName", "Unknown Race")

    speed_information = race.get("weightSpeeds") or {}
    normal_speeds = speed_information.get("normal") or {}
    walking_speed = normal_speeds.get("walk", 0)

    size_id = race.get("sizeId")

    # D&D Beyond size IDs commonly use 3 for Small and 4 for Medium.
    size_names = {
        2: "tiny",
        3: "small",
        4: "medium",
        5: "large",
        6: "huge",
        7: "gargantuan",
    }

    size = size_names.get(size_id, "medium")

    converted = {
        "id": make_id(name, character_id),
        "foundryId": make_id(name, character_id),
        "name": name,
        "team": "player",
        "rules": "2024",
        "sourcePath": None,
        "size": size,
        "width": 1,
        "height": 1,
        "ac": ac,
        "hp": hp["maximum"],
        "speed": walking_speed,
        "proficiency": proficiency,
        "abilities": abilities,
        "resist": [],
        "immune": [],
        "vuln": [],
        "conditionImmune": [],
        "token": character.get("decorations", {}).get("avatarUrl"),
        "img": character.get("decorations", {}).get("avatarUrl"),
        "actions": extract_weapon_actions(character) + spell_actions + sheet_actions,
        "class": class_text,
        "race": race_name,
        "features": extract_features(character, total_level),
    }

    seen_features = {
        feature["name"].lower()
        for feature in converted["features"]
        if feature.get("name")
    }
    for feature in spell_features:
        add_feature(
            converted["features"],
            seen_features,
            feature["name"],
            feature["summary"],
        )

    return converted


# # --------------------------------------------------
# # Open input, convert it, and save output
# # --------------------------------------------------

# print("\nEnter the full path to character.json:")
# character_location = Path(input().strip().strip('"'))

# with open(character_location, "r", encoding="utf-8") as input_file:
#     ddb_data = json.load(input_file)

# converted_character = convert_character(ddb_data)

# # The target format contains a list of characters.
# output_data = [converted_character]


# print("\nEnter the folder where you want to save the converted file:")
# output_folder = Path(input().strip().strip('"'))

# print("\nEnter the output filename:")
# output_filename = input().strip().strip('"')

# # Add .json if the user didn't include it.
# if not output_filename.lower().endswith(".json"):
#     output_filename += ".json"

# # Combine the folder and filename.
# output_location = output_folder / output_filename

# with open(output_location, "w", encoding="utf-8") as output_file:
#     json.dump(
#         output_data,
#         output_file,
#         indent=2,
#         ensure_ascii=False,
#     )

# print("\nConversion complete.")
# print(f"Saved to: {output_location}")



# --------------------------------------------------
# Standalone conversion
# --------------------------------------------------
def main():
    """
    Allow this file to continue working as a standalone converter.

    This section does not run when convert_character() is imported
    by another Python file.
    """
    print("\nEnter the full path to character.json:")
    character_location = Path(input().strip().strip('"'))

    with character_location.open("r", encoding="utf-8") as input_file:
        ddb_data = json.load(input_file)

    converted_character = convert_character(ddb_data)

    # The target format contains a list of characters.
    output_data = [converted_character]

    print("\nEnter the folder where you want to save the converted file:")
    output_folder = Path(input().strip().strip('"'))

    print("\nEnter the output filename:")
    output_filename = input().strip().strip('"')

    if not output_filename.lower().endswith(".json"):
        output_filename += ".json"

    output_folder.mkdir(parents=True, exist_ok=True)
    output_location = output_folder / output_filename

    with output_location.open("w", encoding="utf-8") as output_file:
        json.dump(
            output_data,
            output_file,
            indent=2,
            ensure_ascii=False,
        )

    print("\nConversion complete.")
    print(f"Saved to: {output_location.resolve()}")


if __name__ == "__main__":
    main()