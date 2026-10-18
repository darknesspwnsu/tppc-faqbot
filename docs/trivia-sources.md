# Pokémon trivia sources

The bundled Pokémon bank contains 496 reviewed multiple-choice questions: 424
general questions (including 108 hard questions) and 72 National Pokédex landmarks.
Runtime selection gives dex questions a 15% chance, then selects other topics evenly. The bank is local;
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
- [Pokémon Showdown](https://github.com/smogon/pokemon-showdown), by Guangcong
  Luo and contributors, supplies the mechanics references for 70 new hard
  questions. Battle data and generation-specific overrides were read at commit
  `f0e61e58ad297885578231746036438e1b42f40a`. Each question links to the relevant
  file and line at that revision. The MIT notice is retained in
  [PokemonShowdown-MIT.txt](../data/licenses/PokemonShowdown-MIT.txt).
- [Bulbapedia](https://bulbapedia.bulbagarden.net/wiki/Main_Page) supplies
  factual references for 30 new hard questions covering unusual evolution
  conditions, Regi puzzles, Battle Frontier rules, and spin-offs. Each links to
  its reference article and records a review date of 2026-10-18. These questions
  and distractors use original wording; article prose and existing quizzes are
  not reproduced. Their metadata uses `referenceOnly: true` to distinguish a
  factual citation from adapted licensed question text.

The 100 new hard questions are bundled separately in
[pokemon_hard_trivia_questions.json](../data/pokemon_hard_trivia_questions.json).
They use the repository's license for original wording. Upstream license notices
are retained for the referenced code/data, while Open Trivia DB adaptations keep
their own separate share-alike licensing.

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
- **Hard:** generation-specific battle quirks, non-obvious move/Ability/item
  interactions, precise evolution conditions, challenge rules, and spin-off
  details, alongside the existing obscure world and history questions.
  Dex landmarks keep their separately configured recognition/distractor tiers.

Hard questions name the game or generation whenever a rule changed. The review
checks exceptions (for example, Ring Target versus Levitate, and Punching Glove
versus Unseen Fist), plausible distractors, and exactly one correct choice.
Basic pre-evolutions, Gym specialities, and ordinary type recall stay in their
existing easier tiers. The 15% dex draw is made before recent-question filtering,
so exhausting the general bank cannot force additional dex rounds.

Excluded source entries include an incorrect claim that Rhyhorn was the first
Pokémon designed, ambiguous anime counts, outdated publishing information,
unqualified move-availability questions, and Kukui/Hau described as reigning
Alola Champions. Team Plasma's leadership is omitted rather than treating one
name as correct across versions. The existing TPPC questions are unchanged.

## Editing and refreshing

General questions and dex landmarks live in
[pokemon_trivia_questions.json](../data/pokemon_trivia_questions.json), with
the expanded hard bank in
[pokemon_hard_trivia_questions.json](../data/pokemon_hard_trivia_questions.json).
Open Trivia DB adaptations remain in their separate file so provenance and
share-alike licensing stay explicit. No bulk online refresh runs automatically.

Each entry needs a stable unique `id`, `category: "pokemon"`, `difficulty`
(`easy`, `medium`, or `hard`), a `topic`, a question, four distinct choices,
`answerIndex` (zero-based), and `source` metadata (`name`, `url`, plus `license`
for adapted code/data or `referenceOnly: true` and `reviewedOn` for original
questions based on factual references).
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
