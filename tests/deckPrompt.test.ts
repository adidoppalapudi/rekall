import { describe, expect, it } from 'vitest';
import { DECK_PROMPT } from '../src/io/deckPrompt';
import { parseDeckFile } from '../src/io/deckFile';
import { LIMITS } from '../src/models/validation';

describe('the deck creation prompt', () => {
  it('shows an example that imports as a deck once its blanks are filled in', () => {
    const example = DECK_PROMPT.slice(DECK_PROMPT.indexOf('\n{\n') + 1, DECK_PROMPT.indexOf('\n}\n') + 2);
    let blank = 0;
    const parsed = parseDeckFile(example.replace(/"\.\.\."/g, () => `"text ${++blank}"`));

    expect(parsed.ok && parsed.value.questions.map((question) => question.type)).toEqual([
      'multiple_choice',
      'true_false',
      'flashcard',
    ]);
  });

  it('asks for the limits that import checks', () => {
    expect(DECK_PROMPT).toContain(`deck name up to ${LIMITS.deckName} characters`);
    expect(DECK_PROMPT).toContain(`each choice up to ${LIMITS.choice}`);
  });
});
