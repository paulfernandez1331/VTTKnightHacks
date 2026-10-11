"""A small D&D Beyond payload: one attack spell and one area save become buttons."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convert_character_format import convert_character


def spell(name, level, prepared, **definition):
    body = {
        "name": name,
        "level": level,
        "description": definition.pop("description", ""),
        "snippet": definition.pop("snippet", ""),
        "requiresAttackRoll": definition.pop("requiresAttackRoll", False),
        "requiresSavingThrow": definition.pop("requiresSavingThrow", False),
        "saveDcAbilityId": definition.pop("saveDcAbilityId", None),
        "attackType": definition.pop("attackType", None),
        "scaleType": definition.pop("scaleType", None),
        "modifiers": definition.pop("modifiers", []),
        "range": definition.pop("range", {}),
        "activation": definition.pop("activation", {"activationTime": 1, "activationType": 1}),
    }
    body.update(definition)
    return {
        "definition": body,
        "prepared": prepared,
        "alwaysPrepared": False,
        "range": body["range"],
        "activation": body["activation"],
    }


def payload():
    fire_bolt = spell(
        "Fire Bolt",
        0,
        False,
        requiresAttackRoll=True,
        attackType=2,
        scaleType="characterlevel",
        range={"origin": "Ranged", "rangeValue": 120, "aoeType": None, "aoeValue": None},
        modifiers=[{
            "type": "damage",
            "subType": "fire",
            "die": {"diceString": "1d10"},
            "atHigherLevels": {
                "higherLevelDefinitions": [
                    {"level": 5, "dice": {"diceString": "2d10"}},
                ],
            },
        }],
    )
    thunderwave = spell(
        "Thunderwave",
        1,
        True,
        requiresSavingThrow=True,
        saveDcAbilityId=2,
        description="<p>Each creature in a 15-foot cube takes 2d8 thunder damage on a failed save, or half as much damage on a successful one.</p>",
        range={"origin": "Self", "rangeValue": None, "aoeType": "Cube", "aoeValue": 15},
        modifiers=[{
            "type": "damage",
            "subType": "thunder",
            "die": {"diceString": "2d8"},
        }],
    )
    burning = spell(
        "Burning Hands",
        1,
        False,
        requiresSavingThrow=True,
        saveDcAbilityId=2,
        description="<p>Failure: 3d6 fire damage. Success: half as much damage.</p>",
        range={"origin": "Self", "rangeValue": None, "aoeType": "Cone", "aoeValue": 15},
        modifiers=[{
            "type": "damage",
            "subType": "fire",
            "die": {"diceString": "3d6"},
        }],
    )
    armor = spell(
        "Mage Armor",
        1,
        True,
        description="<p>The target's base AC becomes 13 + its Dexterity modifier.</p>",
        snippet="Base AC becomes 13 + Dexterity modifier.",
        range={"origin": "Touch", "rangeValue": None, "aoeType": None, "aoeValue": None},
    )
    familiar = spell(
        "Find Familiar",
        1,
        False,
        description="<p>You gain the service of a familiar.</p>",
        range={"origin": "Ranged", "rangeValue": 10, "aoeType": None, "aoeValue": None},
        activation={"activationTime": 1, "activationType": 7},
    )
    ray = spell(
        "Ray of Frost",
        0,
        False,
        requiresAttackRoll=True,
        attackType=2,
        range={"origin": "Ranged", "rangeValue": 60, "aoeType": None, "aoeValue": None},
        modifiers=[{
            "type": "damage",
            "subType": "cold",
            "die": {"diceString": "1d8"},
        }],
    )

    character = {
        "id": 75107594,
        "name": "Fixture Mage",
        "stats": [
            {"id": 1, "value": 8},
            {"id": 2, "value": 14},
            {"id": 3, "value": 14},
            {"id": 4, "value": 18},
            {"id": 5, "value": 10},
            {"id": 6, "value": 8},
        ],
        "classes": [{
            "id": 100,
            "level": 5,
            "definition": {"name": "Wizard", "spellCastingAbilityId": 4},
            "classFeatures": [],
        }],
        "race": {
            "fullName": "Human",
            "sizeId": 4,
            "weightSpeeds": {"normal": {"walk": 30}},
            "racialTraits": [],
        },
        "inventory": [],
        "decorations": {},
        "overrideHitPoints": 28,
        "modifiers": {
            "item": [
                {"type": "bonus", "subType": "wizard-spell-attacks", "fixedValue": 1},
                {"type": "bonus", "subType": "wizard-spell-save-dc", "fixedValue": 1},
            ],
        },
        "classSpells": [{
            "characterClassId": 100,
            "spells": [fire_bolt, thunderwave, burning, armor, familiar],
        }],
        "spells": {
            "class": [ray],
            "race": [],
            "item": [],
            "feat": [],
        },
        "actions": {
            "class": [{
                "name": "Tail",
                "dice": {"diceString": "1d8"},
                "damageTypeId": 3,
                "saveStatId": None,
                "fixedToHit": 6,
                "fixedSaveDc": None,
                "attackTypeRange": 1,
                "abilityModifierStatId": 1,
                "description": "",
                "range": {"range": 10, "longRange": None, "aoeType": None, "aoeSize": None},
                "activation": {"activationType": 1},
            }],
            "race": [],
            "feat": [],
        },
        "options": {},
        "feats": [],
    }
    return {"data": character}


def main():
    converted = convert_character(payload())
    actions = {action["name"]: action for action in converted["actions"]}
    feature_names = {feature["name"] for feature in converted["features"]}

    bolt = actions["Fire Bolt"]
    assert bolt["kind"] == "spell", bolt
    assert bolt["attackAbility"] == "int", bolt
    assert bolt["attackBonus"] == 1, bolt
    assert bolt["damage"] == [{"dice": "2d10", "type": "fire"}], bolt
    assert bolt["range"] == {"normal": 120, "long": 120}, bolt
    assert "area" not in bolt, bolt

    wave = actions["Thunderwave"]
    assert wave["kind"] == "spell", wave
    assert wave["saveAbility"] == "dex", wave
    assert wave["saveDc"] == 16, wave
    assert wave["onSave"] == "half", wave
    assert wave["damage"] == [{"dice": "2d8", "type": "thunder"}], wave
    assert wave["area"] == {"type": "cube", "size": 15, "origin": "self"}, wave
    assert "reach" not in wave, wave

    ray = actions["Ray of Frost"]
    assert ray["attackAbility"] == "int", ray
    assert ray["damage"] == [{"dice": "1d8", "type": "cold"}], ray

    tail = actions["Tail"]
    assert tail["toHit"] == 6, tail
    assert tail["damage"] == [{"dice": "1d8", "type": "slashing"}], tail
    assert tail["reach"] == 10, tail

    assert "Burning Hands" not in actions
    assert "Find Familiar" not in actions
    assert "Find Familiar" not in feature_names
    assert "Mage Armor" not in actions
    assert "Mage Armor" in feature_names

    print("spell import fixture passed")
    print(json.dumps({
        "Fire Bolt": bolt,
        "Thunderwave": wave,
    }, indent=2))


if __name__ == "__main__":
    main()
