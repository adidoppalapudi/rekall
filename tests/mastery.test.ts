import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/lib/random';
import type { QuestionProgress } from '../src/models/types';
import { applyAnswer, carryProgress, dayNumber, pickQuestions, weightOf } from '../src/quiz/mastery';

const identity = { questionId: 'question-1', deckId: 'deck-1' };

function progress(
  overrides: Partial<QuestionProgress> = {},
): QuestionProgress {
  return {
    ...identity,
    level: 3,
    promotionDay: 104,
    weightAfter: 0.2,
    answeredDay: 100,
    rightRound: 7,
    dropDay: null,
    seen: 4,
    right: 3,
    ...overrides,
  };
}

function roundedWeight(value: number): number {
  return Math.round(value * 100) / 100;
}

describe('dayNumber', () => {
  it('uses local calendar days across a daylight-saving date', () => {
    const early = dayNumber(new Date(2026, 2, 8, 0, 5).getTime());
    const late = dayNumber(new Date(2026, 2, 8, 23, 55).getTime());
    const nextDay = dayNumber(new Date(2026, 2, 9, 0, 5).getTime());

    expect(late).toBe(early);
    expect(nextDay).toBe(early + 1);
  });
});

describe('weightOf', () => {
  it('gives unanswered questions the new-question weight', () => {
    expect(weightOf(undefined, 100)).toBe(5);
  });

  it.each([
    [0, 0.2],
    [1, 0.32],
    [4, 0.58],
    [7, 0.74],
    [14, 0.92],
  ])('drifts a right-answer weight toward one after %i days', (days, expected) => {
    expect(
      roundedWeight(weightOf(progress({ answeredDay: 100, weightAfter: 0.2 }), 100 + days)),
    ).toBe(expected);
  });

  it.each([
    [0, 3],
    [1, 2.7],
    [4, 2.04],
    [7, 1.64],
    [14, 1.21],
  ])('drifts a missed-answer weight toward one after %i days', (days, expected) => {
    expect(
      roundedWeight(weightOf(progress({ answeredDay: 100, weightAfter: 3 }), 100 + days)),
    ).toBe(expected);
  });

  it('does not amplify a weight when the stored answer day is in the future', () => {
    expect(weightOf(progress({ answeredDay: 101, weightAfter: 3 }), 100)).toBe(3);
  });
});

describe('applyAnswer', () => {
  it('starts a correct question at level 2', () => {
    expect(applyAnswer(undefined, identity, true, 100, 1)).toEqual({
      ...identity,
      level: 2,
      promotionDay: 102,
      weightAfter: 0.2,
      answeredDay: 100,
      rightRound: 1,
      dropDay: null,
      seen: 1,
      right: 1,
    });
  });

  it('starts a missed question at level 1', () => {
    expect(applyAnswer(undefined, identity, false, 100, 1)).toEqual({
      ...identity,
      level: 1,
      promotionDay: 101,
      weightAfter: 3,
      answeredDay: 100,
      rightRound: null,
      dropDay: null,
      seen: 1,
      right: 0,
    });
  });

  it('treats an early correct answer as practice without raising the level', () => {
    const updated = applyAnswer(progress(), identity, true, 103, 8);

    expect(updated).toMatchObject({
      level: 3,
      promotionDay: 104,
      weightAfter: 0.2,
      answeredDay: 103,
      rightRound: 8,
      seen: 5,
      right: 4,
    });
  });

  it('raises the level after its wait and caps it at level 5', () => {
    const raised = applyAnswer(progress(), identity, true, 104, 8);
    const mastered = applyAnswer(
      progress({ level: 5, promotionDay: 100 }),
      identity,
      true,
      104,
      8,
    );

    expect(raised).toMatchObject({ level: 4, promotionDay: 112 });
    expect(mastered).toMatchObject({ level: 5, promotionDay: 120 });
  });

  it('drops one level after a miss and clears the right-answer rest', () => {
    const updated = applyAnswer(progress(), identity, false, 105, 8);

    expect(updated).toMatchObject({
      level: 2,
      promotionDay: 107,
      weightAfter: 3,
      answeredDay: 105,
      rightRound: null,
      dropDay: 105,
      seen: 5,
      right: 3,
    });
  });

  it('drops at most once per day and never below level 1', () => {
    const alreadyDropped = progress({ level: 2, dropDay: 105 });
    const sameDay = applyAnswer(alreadyDropped, identity, false, 105, 8);
    const floor = applyAnswer(
      progress({ level: 1, dropDay: 104 }),
      identity,
      false,
      105,
      8,
    );

    expect(sameDay.level).toBe(2);
    expect(floor.level).toBe(1);
  });
});

describe('self-graded flashcards', () => {
  it('count like any answer but stop at level 3', () => {
    const due = progress({ level: 3, promotionDay: 100 });

    expect(applyAnswer(due, identity, true, 100, 8, true).level).toBe(3);
    expect(applyAnswer(due, identity, true, 100, 8).level).toBe(4);
    expect(applyAnswer(undefined, identity, true, 100, 8, true).level).toBe(2);
    expect(applyAnswer(due, identity, false, 100, 8, true).level).toBe(2);
  });
});

describe('carryProgress', () => {
  const question = (id: string, type: string, prompt: string) => ({ id, type, prompt });
  const record = (questionId: string, level: QuestionProgress['level']) =>
    progress({ questionId, level });

  it('moves progress to new questions with the same type and wording', () => {
    const carried = carryProgress(
      [question('old-1', 'true_false', 'S3 stores objects.'), question('old-2', 'flashcard', 'IAM?')],
      [record('old-1', 4), record('old-2', 3)],
      [question('new-1', 'true_false', '  s3   stores objects. '), question('new-2', 'multiple_choice', 'IAM?')],
    );

    expect(carried).toEqual([{ ...record('old-1', 4), questionId: 'new-1' }]);
  });

  it('pairs repeated questions one to one, in order', () => {
    const carried = carryProgress(
      [question('a', 'flashcard', 'Same'), question('b', 'flashcard', 'Same')],
      [record('a', 2), record('b', 5)],
      [question('x', 'flashcard', 'Same'), question('y', 'flashcard', 'Same'), question('z', 'flashcard', 'Same')],
    );

    expect(carried.map((r) => [r.questionId, r.level])).toEqual([
      ['x', 2],
      ['y', 5],
    ]);
  });
});

describe('pickQuestions', () => {
  const deck = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
  const rightIn = (questionId: string, rightRound: number) =>
    progress({ questionId, rightRound, weightAfter: 0.2, answeredDay: 100 });
  const missed = (questionId: string) => progress({ questionId, rightRound: null, weightAfter: 3, answeredDay: 100 });
  const ids = (picked: { id: string }[]) => picked.map((question) => question.id).sort();
  const pick = (count: number, records: QuestionProgress[], rounds: number, seed = 1) =>
    ids(pickQuestions(deck, count, { records, rounds }, 100, seededRandom(seed)));

  it('rests a right answer for the next two rounds of its deck, then brings it back', () => {
    // All six weigh the same, so only resting keeps "a" out.
    const records = [rightIn('a', 5), ...['b', 'c', 'd', 'e', 'f'].map((id) => rightIn(id, 1))];
    const seeds = Array.from({ length: 100 }, (_, seed) => seed);
    const picksA = (rounds: number) => seeds.filter((seed) => pick(5, records, rounds, seed).includes('a')).length;

    expect(picksA(5)).toBe(0);
    expect(picksA(6)).toBe(0);
    expect(picksA(7)).toBeGreaterThan(50);
  });

  it('never rests a missed question', () => {
    const othersRest = ['b', 'c', 'd', 'e', 'f'].map((id) => rightIn(id, 5));

    expect(pick(1, [missed('a'), ...othersRest], 5)).toEqual(['a']);
  });

  it('fills up with the questions that have rested longest when too few are left', () => {
    const records = [...['a', 'b', 'c', 'd'].map((id) => rightIn(id, 5)), rightIn('e', 4)];

    expect(pick(2, records, 5)).toEqual(['e', 'f']);
  });

  it('picks a missed question more often than a right one', () => {
    const records = [missed('a'), rightIn('b', 1)];
    const counts = { a: 0, b: 0 };
    for (let seed = 0; seed < 500; seed++) {
      const [first] = pickQuestions(deck.slice(0, 2), 1, { records, rounds: 10 }, 101, seededRandom(seed));
      counts[first.id as 'a' | 'b']++;
    }

    expect(counts.a).toBeGreaterThan(counts.b * 3);
  });

  it('gives every question once when the quiz is as big as the deck', () => {
    expect(pick(6, [rightIn('a', 5), missed('b')], 5)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
