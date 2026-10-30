/**
 * The prompt behind "rules for deck creation": rules for a good deck that a
 * person can read and an AI chat can follow, ending in this app's deck file
 * format. The limits come from validation, so the prompt asks for exactly
 * what import accepts.
 */
import { MAX_CHOICES, MIN_CHOICES } from '../models/types';
import { LIMITS } from '../models/validation';

const thousands = (value: number) => value.toLocaleString('en-US');

export const DECK_PROMPT = `Write a quiz deck for the Enyalië app.

A good deck
- Uses only well-established facts. Anything uncertain is left out rather than guessed.
- Puts the year on facts that can change, like records, office holders, prices and populations, e.g. "As of 2025, ...".
- Gives every question exactly one right answer, with a one or two sentence explanation of why it is right.
- Is mostly multiple choice and about a quarter true/false. Flashcards are only for open recall, like a definition or a translation. Answers from a small fixed set, like der/die/das, are multiple choice.
- Gives multiple choice ${MAX_CHOICES} choices of similar length, style and kind, all plausible to someone who doesn't know the answer. The right one is the longest at most a quarter of the time, and right answers are spread evenly over positions 0 to ${MAX_CHOICES - 1}. No "all of the above", "none of the above" or "both A and B", since the app shuffles choices.
- Makes about half the true/false statements false, each by changing one specific detail, not by adding "always" or "never".
- Never lets a question's wording, or another question, give its answer away. No repeats.
- Mixes difficulty: about a third easy, a third medium, a quarter hard, a few expert.

For the AI
Write 40 questions, unless a different number is given below. Reply with only the JSON, nothing else, or with a file named [topic].enyalie.json if you can make files. Before replying, check every question against the list above and fix any that break it.

Limits: deck name up to ${LIMITS.deckName} characters, description up to ${LIMITS.deckDescription}, prompt up to ${thousands(LIMITS.prompt)}, each choice up to ${LIMITS.choice}, ${MIN_CHOICES} to ${MAX_CHOICES} choices, up to ${LIMITS.tagCount} lowercase tags per question. correctIndex counts from 0.

{
  "format": "enyalie-deck",
  "version": 1,
  "deck": { "name": "...", "description": "..." },
  "questions": [
    { "type": "multiple_choice", "prompt": "...", "choices": ["...", "...", "...", "..."],
      "correctIndex": 2, "difficulty": "medium", "tags": ["..."], "explanation": "..." },
    { "type": "true_false", "prompt": "...", "answer": false,
      "difficulty": "easy", "tags": ["..."], "explanation": "..." },
    { "type": "flashcard", "prompt": "...", "answer": "...",
      "difficulty": "hard", "tags": ["..."], "explanation": "..." }
  ]
}

Topic (e.g. AP World History: Modern, all nine units):
For (optional, e.g. high school students preparing for the AP exam):
Number of questions (optional, e.g. 50):`;
