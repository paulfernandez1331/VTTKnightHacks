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
        "proficiency": proficiency_bonus(total_level),
        "abilities": abilities,
        "resist": [],
        "immune": [],
        "vuln": [],
        "conditionImmune": [],
        "token": character.get("decorations", {}).get("avatarUrl"),
        "img": character.get("decorations", {}).get("avatarUrl"),
        "actions": extract_weapon_actions(character),
        "class": class_text,
        "race": race_name,
        "features": extract_features(character, total_level),
    }

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