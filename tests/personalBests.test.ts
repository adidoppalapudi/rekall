import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRandom } from '../src/lib/random';
import {
  DEFAULT_SETTINGS,
  advance,
  answerCurrent,
  buildQuizItems,
  createSession,
  mistakesSession,
  type QuestionCount,
  type QuizSession,
  type QuizSource,
} from '../src/quiz/engine';
import { bestFor, bestsFor, describeBest, recordResult } from '../src/quiz/personalBests';
import { saved, trueFalse } from './helpers';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const deck: QuizSource = { kind: 'deck', deckId: 'deck-1' };

/** A finished quiz of true/false questions, answered right (true) or wrong (false) in order. */
function finished(pattern: boolean[], count: QuestionCount = 10, source: QuizSource = deck): QuizSession {
  const questions = pattern.map((_, i) => saved(trueFalse(`Statement ${i + 1}`, true)));
  const settings = { ...DEFAULT_SETTINGS, count, shuffleQuestions: false };
  let session = createSession({
    title: 'test',
    source,
    settings,
    items: buildQuizItems(questions, settings, { random: seededRandom(1) }),
    now: 0,
  });
  for (const correct of pattern) {
    session = advance(answerCurrent(session, { type: 'true_false', answer: correct }, 1), 1);
  }
  return session;
}

describe('personal bests', () => {
  beforeEach(() => vi.stubGlobal('localStorage', new MemoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('records the first finished quiz at a length as the best', () => {
    expect(bestFor(deck, 10)).toBeNull();
    const quiz = finished([true, true, false, true]);
    expect(recordResult(quiz)).toEqual(['points', 'accuracy', 'streak']);
    const best = bestFor(deck, 10);
    expect(best && describeBest(best)).toBe('310\u00a0pts · 3/4 · Streak\u00a02');
  });

  it('keeps each record separately and reports only the ones a quiz beats', () => {
    recordResult(finished([true, false, true, false, true]));
    // Same accuracy, but more points and a longer streak.
    expect(recordResult(finished([false, false, true, true, true]))).toEqual(['points', 'streak']);
    // Lower points, but all right in a shorter quiz.
    expect(recordResult(finished([true, true]))).toEqual(['accuracy']);
    expect(recordResult(finished([false, false, false, false]))).toEqual([]);
    const best = bestFor(deck, 10);
    expect(best && [best.points, best.correct, best.total, best.streak]).toEqual([330, 2, 2, 3]);
  });

  it('keeps each quiz length, each deck and quick play apart', () => {
    recordResult(finished([true, true, true, true, true], 5));
    recordResult(finished([true], 10, { kind: 'quick' }));
    expect(bestFor(deck, 5)?.points).toBe(600);
    expect(bestFor(deck, 10)).toBeNull();
    expect(bestFor({ kind: 'deck', deckId: 'deck-2' }, 5)).toBeNull();
    expect(bestFor({ kind: 'quick' }, 10)?.points).toBe(100);
    recordResult(finished([true, false], 'all'));
    expect(bestsFor(deck).map(({ count, best }) => [count, best.points])).toEqual([
      [5, 600],
      ['all', 100],
    ]);
  });

  it('gives the same answer when one quiz is recorded twice', () => {
    const quiz = finished([true, false, true]);
    expect(recordResult(quiz)).toEqual(['points', 'accuracy', 'streak']);
    expect(recordResult(quiz)).toEqual(['points', 'accuracy', 'streak']);
    expect(recordResult(finished([false, true, false]))).toEqual([]);
  });

  it('ignores mistakes rounds, unfinished quizzes and zero scores', () => {
    const quiz = finished([true, false, false]);
    recordResult(quiz);
    const retry = mistakesSession(quiz, seededRandom(2), 0);
    let round = retry!;
    for (let i = 0; i < round.items.length; i++) {
      round = advance(answerCurrent(round, { type: 'true_false', answer: true }, 1), 1);
    }
    expect(recordResult(round)).toEqual([]);
    expect(bestFor(deck, 10)?.correct).toBe(1);
    expect(recordResult({ ...finished([true]), finishedAt: null })).toEqual([]);
    localStorage.removeItem('enyalie.personalBests');
    expect(recordResult(finished([false, false]))).toEqual([]);
  });

  it('survives storage that is broken or unavailable', () => {
    localStorage.setItem('enyalie.personalBests', '{ not json');
    expect(bestFor(deck, 10)).toBeNull();
    localStorage.setItem('enyalie.personalBests', JSON.stringify({ 'deck-1': { 10: { points: 'lots' } } }));
    expect(bestFor(deck, 10)).toBeNull();
    expect(recordResult(finished([true]))).toEqual(['points', 'accuracy', 'streak']);
    vi.stubGlobal('localStorage', undefined);
    expect(bestFor(deck, 10)).toBeNull();
    expect(recordResult(finished([true]))).toEqual(['points', 'accuracy', 'streak']);
  });
});
