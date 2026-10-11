# Battlemat

This is the KnightHacks virtual tabletop. The 2024 creature data and the combat board are on `main`. Clone it:

```bash
git clone https://github.com/paulfernandez1331/VTTKnightHacks
cd VTTKnightHacks
npm install
npm start
```

The server listens on port 3000.

- Dungeon Master: http://localhost:3000/?dm=dm
- Player: http://localhost:3000/

`npm test` runs `node combat/test.js`. It checks a goblin attack against Zanna and does not start the server.

The DM code defaults to `dm`. Set `DM_CODE` and `PORT` in the environment to change them.

## Combat turns

The DM presses Start combat in the Initiative panel. Every token on the map rolls d20 plus its DEX modifier, and the order is shown to everyone. Ties go to the higher DEX modifier.

- The token whose turn it is has a gold ring. Only that token can attack or move.
- A turn gives one action and movement equal to speed. The first attack uses the action. A creature with Multiattack or Extra Attack gets its extra swings from the same action.
- Anyone can end a player's turn with End turn. The DM can end any turn.
- On a monster's turn the server plays it automatically. It scores weapons, saves, and areas, aims an area to catch more than one enemy, and walks to a square where that action is better. A recharge power is spent when it is used. At the start of a later turn the creature rolls 1d6 and gets it back only when the die meets the number from its stat block. Set `HF_TOKEN` to let a Hugging Face model pick the first step from that legal list. An illegal suggestion is ignored, and the table still rolls the dice. Set `AUTO_MONSTERS=false` to run monster turns by hand.
- Tokens placed mid-fight roll initiative and join the order. Combat ends when one side has no one standing, or when the DM presses End combat.

The monster script is in `combat/monsterTurn.js` and the turn tracker is in `combat/initiative.js`. Both are covered by `npm test`.

Some limits come from the exported data. The export has speed 0 for every character, so a speed of 0 is treated as 30 ft. Multiattack is read from its rules text. Auras and creatures whose attacks do flat damage with no dice (a Badger's bite) are skipped. Saves and areas are scored by the script. A recharge number missing from the source counts as a 6. `HF_MODEL` overrides the default Hugging Face model (`Qwen/Qwen2.5-7B-Instruct`).

## Creature data

The server reads two files when it starts:

- `data/characters.json` — 48 premade characters. There are 12 people, each saved at levels 1, 5, 11, and 17. A name looks like `Zanna (5)`.
- `data/monsters.json` — 380 SRD 2024 NPCs.

Add to map is a search box. A character matches on name, the level already in the name, and class. A result looks like `Zanna (5) · Wizard 5 (Evoker)`. A monster matches on its name.

The selected token lists one dropdown per feature. Every dropdown starts collapsed, and opening one leaves the others as they are. Monster traits keep the full rules text, including damage, DCs, ranges, and Failure / Success lines. Player features drop the first sentence only when that sentence contains no number, then keep at most four sentences.

Large creatures occupy their Foundry footprint. A Hill Giant is 3 by 3 squares. An Ancient Red Dragon is 4 by 4. A Goblin Warrior is 1 by 1. Distance is measured from the nearest squares.

## The dnd5e folder

`dnd5e/` inside this repository is a snapshot of the local Foundry dnd5e checkout plus the scripts that built the two JSON files. It is here so a teammate can regenerate that data without cloning Foundry first. It is not a contribution to the official Foundry project, and it must not be pushed to https://github.com/foundryvtt/dnd5e.

Files added for this project:

- `dnd5e/utils/export-vtt.mjs` reads the 2024 actor packs and writes `data/characters.json` and `data/monsters.json` in the Battlemat root.
- `dnd5e/utils/parse-2024.mjs` writes the 2024 catalog under `dnd5e/data/2024/`.
- `dnd5e/package.json` adds `parse:2024`, which runs parse and then export.
- `dnd5e/data/2024/` holds `actors.jsonl`, `activities.jsonl`, `catalog.jsonl`, and `index.json`.

The rest of `dnd5e/` is the system code, the SRD pack source in `packs/_source/`, the built LevelDB packs, fonts, and `dnd5e.css`. The exporter reads the YAML in `packs/_source`. Its output path is `../data`, which is the Battlemat `data/` directory next to `server.js`.

Regenerate from the `dnd5e` directory:

```bash
cd dnd5e
npm install
npm run parse:2024
```

`npm install` in that directory can take a while. It builds CSS and pack databases. Commit the updated `data/characters.json` and `data/monsters.json` if you want the board to serve the new export.

## Portraits

Creature records still store token paths such as `tokens/humanoid/Goblin.webp`. Those image files are not in this repository.

`server.js` serves `/tokens` from `../dnd5e/tokens`. That path is one directory above this repository, not `dnd5e/tokens` inside it. On a machine laid out like this, portraits load:

```
Knighthacks2026/
  dnd5e/                 <- Foundry checkout, including tokens/
  VTTKnightHacks/        <- this repo
    dnd5e/               <- system snapshot, licenses only under tokens/
    server.js
```

To get the same pictures, clone https://github.com/foundryvtt/dnd5e as a sibling folder named `dnd5e`, or copy the `tokens` folder from a Foundry dnd5e install to that sibling path. Restart the server after the folder is in place.

Without that folder, every creature still places on the grid. The ellipse is teal for a character and red for a monster, and the board draws the creature's initials until an image loads.

`dnd5e/tokens/` is omitted because `dnd5e/tokens/LICENSE` says the Forgotten Adventures images are for the dnd5e system and may not be redistributed or used outside Foundry Virtual Tabletop unless Forgotten Adventures grants a separate license. That covers every image in that folder. `dnd5e/tokens/composite/LICENSE` says the Caeora ring art may only be used to run the dnd5e system inside Foundry Virtual Tabletop. This GitHub repository is public, so those images stay out. The LICENSE files themselves are committed.

Three other art folders are omitted for the same kind of restriction. The LICENSE file in each folder is committed:

- `dnd5e/ui/official/LICENSE` — Wizards of the Coast artwork, only for running dnd5e inside Foundry Virtual Tabletop.
- `dnd5e/icons/spell-tiers/LICENSE` — Rexard icons, may not be redistributed.
- `dnd5e/icons/svg/schools/LICENSE` — Wizards of the Coast artwork, only for running dnd5e inside Foundry Virtual Tabletop.

`.gitignore` blocks image files if someone copies them into those folders later.

These are also not in git: `node_modules/` (run `npm install`), the Foundry `.git` history, and `.DS_Store` files.

## Licenses for what is included

The text from the System Reference Document 5.1 and System Reference Document 5.2 is under Creative Commons Attribution 4.0. The dnd5e system code is MIT. Full notices are in `dnd5e/README.md` and `dnd5e/LICENSE.txt`. Other assets that are included keep the license files that shipped with them.

## Do not

- Do not push the `dnd5e/` snapshot to https://github.com/foundryvtt/dnd5e.
- Do not add the token images, `ui/official` artwork, spell-tier icons, or school icons to this repository.
- Do not push this project back to https://github.com/AndrewASO/VTTKnightHacks. This copy lives at https://github.com/paulfernandez1331/VTTKnightHacks on `main`.
