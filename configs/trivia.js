// Dex questions are occasional landmarks, not arbitrary number memorization.
export const POKEMON_DEX_CHANCE = 0.15;
export const TRIVIA_RECENT_QUESTION_LIMIT = 20;

export const POKEMON_DEX_LANDMARKS = {
  // "Which Pokemon is #..." — memorable numbers and milestones.
  name: {
    easy: [1, 25, 69, 100, 150, 151],
    medium: [67, 200, 300, 420, 666, 700],
    hard: [400, 500, 600, 777, 800, 900, 1000],
  },
  // "What is ...'s number?" — familiar Pokemon, starters, and legendaries.
  number: {
    easy: [1, 4, 6, 7, 9, 25, 133, 143, 150, 151],
    medium: [94, 130, 144, 145, 146, 149, 196, 197, 249, 250, 251, 252, 255, 258, 282, 382, 383, 384, 385],
    hard: [386, 445, 448, 483, 484, 487, 491, 493, 643, 644, 646, 658, 716, 717, 718, 791, 792, 800, 888, 889, 890, 898, 1007, 1008],
  },
};
