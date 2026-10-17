# Pokémon trivia sources

The bundled Pokémon bank contains 396 reviewed multiple-choice questions: 324
general questions and 72 National Pokédex landmarks. Runtime selection gives
dex questions a 15% chance, then selects other topics evenly. The bank is local;
rounds do not scrape websites or depend on a trivia API being available.

## Provenance and licenses

- [PokeQuiz](https://github.com/Dechrissen/PokeQuiz), by Derek Andersen
  (Dechrissen), supplies region, town, landmark, professor, team, Gym, badge,
  rival, and Champion facts. The SQLite database was read at commit
  `23389d617ebc176a7caaa13760160888d039b3fd`. Spectreon supplies the question
  wording, difficulty assignments, and distractors. Its MIT notice is retained
  in [PokeQuiz-MIT.txt](../data/licenses/PokeQuiz-MIT.txt).
- [PokéAPI](https://pokeapi.co/docs/v2), by Paul Hallett and contributors,
  supplies English names, types, evolution methods, items, abilities, moves,
  type effectiveness, and National Pokédex numbers. CSV data was read from
  [PokeAPI/pokeapi](https://github.com/PokeAPI/pokeapi) at commit
  `5ee47a9a9c1229632ec4b473a9c1c53026e005dd`. Questions are written from those
  facts; no Pokédex flavor text is copied. The BSD notice is retained in
  [PokeAPI-BSD-3-Clause.txt](../data/licenses/PokeAPI-BSD-3-Clause.txt).
- [Open Trivia DB](https://opentdb.com/), with its contributing question
  authors, supplies 29 adapted questions in the separate file
  [opentdb_pokemon_questions.json](../data/opentdb_pokemon_questions.json).
  These were selected from the
  [public 2024-12-27 snapshot](https://gist.github.com/jbaranski/a3c10856b750441663eec71739d49e43),
  accessed on 2026-10-17. HTML entities were decoded, difficulty and topic
  assigned, some wording clarified, and some distractors replaced. This adapted
  question collection is distributed under
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), as required by
  [Open Trivia DB's data terms](https://opentdb.com/api_config.php). Result
  messages credit Open Trivia DB, identify adaptations, and link that license.

Source metadata accompanies every Pokémon question and appears after the answer
window closes. Each PokeQuiz question links to the pinned database; PokéAPI
questions link to their relevant API resource. The commits above identify the
data reviewed even if live API values later change. Data licenses apply to their
respective source-derived content; the Open Trivia DB adaptations are kept
separate from the other bank and bot code.

## Content review

The imported databases are source material, not automatically trusted answers.
Version-dependent questions name the games or form when needed. Type matchups
use the modern 18-type chart without Abilities, weather, or other modifiers.
Standard, regional, Mega, and Primal forms are distinguished where relevant.
Reversed dual-type order cannot create two correct choices. Answer choices are
shuffled on every round.

Difficulty is stored on each question; it is never randomly assigned at runtime.
The picker can randomly select a difficulty when configured for `all`, but each
question retains its reviewed rating. Generation alone is not a difficulty rule:

- **Easy:** direct evolution recognition, Gym type specialities, common move and
  Pokémon types, basic characters and game regions, and familiar evolution stones.
- **Medium:** specific badges or locations, trade items, less familiar stones,
  regional or misleading types, Hidden Abilities, and type-effectiveness details.
- **Hard:** obscure details such as Goldenrod Gym's layout, Pokémon Conquest's
  kingdom count or perfect links, precise release history, and unusual stat trivia.
  Dex landmarks keep their separately configured recognition/distractor tiers.

The hard general bank is deliberately smaller than the easier banks. It cycles
older questions when exhausted rather than inflating easy questions to fill a
quota. The 15% dex draw is made before recent-question filtering, so exhausting
the general bank cannot force additional dex rounds.

Excluded source entries include an incorrect claim that Rhyhorn was the first
Pokémon designed, ambiguous anime counts, outdated publishing information,
unqualified move-availability questions, and Kukui/Hau described as reigning
Alola Champions. Team Plasma's leadership is omitted rather than treating one
name as correct across versions. The existing TPPC questions are unchanged.

## Editing and refreshing

General questions and dex landmarks live in
[pokemon_trivia_questions.json](../data/pokemon_trivia_questions.json).
Open Trivia DB adaptations remain in their separate file so provenance and
share-alike licensing stay explicit. No bulk online refresh runs automatically.

Each entry needs a stable unique `id`, `category: "pokemon"`, `difficulty`
(`easy`, `medium`, or `hard`), a `topic`, a question, four distinct choices,
`answerIndex` (zero-based), and `source` metadata (`name`, `url`, `license`).
Verify that exactly one choice is correct, including equivalent type orders or
alternate spellings. Updating an answer must also update its source and scope.

Dex entries additionally require `topic: "pokedex"`, `dexNumber`, and
`dexDirection`: `name` asks which Pokémon occupies a memorable number;
`number` asks a recognizable Pokémon's number. The direction and difficulty
must be explicitly allowed in [configs/trivia.js](../configs/trivia.js).
Arbitrary dex entries are rejected by the loader.

After editing, run:

```sh
npx vitest run tests/tools/trivia.test.js tests/tools/trivia.answers.test.js --maxWorkers=1
```

Restart the bot to load the changed bank. Recent-question memory is per server,
holds 20 successfully posted IDs, and lasts until restart. If a filtered pool is
exhausted (notably the small TPPC bank), selection reuses older entries while
avoiding the immediately preceding question whenever another is available.
