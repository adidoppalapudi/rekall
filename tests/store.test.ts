// Runs the real IndexedDB code against fake-indexeddb, an in-memory copy of
// the browser API, so these tests work in Node.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createIndexedDbStore } from '../src/db/indexedDbStore';
import { createId } from '../src/lib/id';
import { NotFoundError, ValidationError } from '../src/lib/errors';
import { createDecksFile, parseDecks, serializeDeckFile } from '../src/io/deckFile';
import type { Question } from '../src/models/types';
import {
  DEFAULT_SETTINGS,
  advance,
  answerCurrent,
  createSession,
  type QuizResponse,
  type QuizSession,
} from '../src/quiz/engine';
import { flashcard, multipleChoice, trueFalse } from './helpers';

function response(question: Question, right: boolean): QuizResponse {
  switch (question.type) {
    case 'multiple_choice':
      return { type: 'multiple_choice', choice: right ? question.correctIndex : (question.correctIndex + 1) % 2 };
    case 'true_false':
      return { type: 'true_false', answer: right ? question.answer : !question.answer };
    case 'flashcard':
      return { type: 'flashcard', recalled: right };
  }
}

/** A quiz over `questions`, finished with every answer right except the `missed` ones. */
function finishedQuiz(questions: readonly Question[], missed: readonly Question[] = []): QuizSession {
  let session = createSession({
    title: 'Test',
    source: { kind: 'quick' },
    settings: DEFAULT_SETTINGS,
    items: questions.map((question) => ({ question, choiceOrder: [] })),
  });
  for (const question of questions) {
    session = advance(answerCurrent(session, response(question, !missed.includes(question))));
  }
  return session;
}

/** A fresh, empty database for each test, with a clock that ticks once per call. */
function freshStore(name = `test-${createId()}`) {
  let time = 1000;
  return { store: createIndexedDbStore({ name, now: () => ++time }), name };
}

describe('IndexedDB store', () => {
  it('creates decks and lists them by name with question counts', async () => {
    const { store } = freshStore();
    const zoology = await store.createDeck({ name: 'zoology', description: '' });
    const aws = await store.createDeck({ name: 'AWS', description: 'cloud' });
    await store.addQuestion(aws.id, trueFalse('S3 is object storage.', true));

    const decks = await store.listDecks();
    expect(decks.map((d) => d.name)).toEqual(['AWS', 'zoology']);
    expect(decks.map((d) => d.questionCount)).toEqual([1, 0]);
    expect(await store.getDeck(zoology.id)).toEqual(zoology);
  });

  it('keeps data when the app is reopened', async () => {
    const { store, name } = freshStore();
    const deck = await store.createDeck({ name: 'PostgreSQL', description: '' });
    await store.addQuestion(deck.id, flashcard('MVCC?', 'Multiversion concurrency control'));

    const reopened = createIndexedDbStore({ name });
    expect((await reopened.listDecks())[0].questionCount).toBe(1);
    expect((await reopened.listQuestions(deck.id))[0].prompt).toBe('MVCC?');
  });

  it('adds, updates and deletes questions in order, touching the deck', async () => {
    const { store } = freshStore();
    const deck = await store.createDeck({ name: 'Deck', description: '' });
    const first = await store.addQuestion(deck.id, multipleChoice('One?', ['a', 'b'], 0));
    const second = await store.addQuestion(deck.id, trueFalse('Two.', true));
    expect((await store.listQuestions(deck.id)).map((q) => q.prompt)).toEqual(['One?', 'Two.']);
    expect((await store.getDeck(deck.id))!.updatedAt).toBe(second.updatedAt);

    // Changing the type must not leave the old type's fields behind.
    const updated = await store.updateQuestion(first.id, flashcard('One, now a card', 'back'));
    expect(updated).toEqual({
      type: 'flashcard',
      prompt: 'One, now a card',
      answer: 'back',
      tags: [],
      id: first.id,
      deckId: deck.id,
      createdAt: first.createdAt,
      updatedAt: updated.updatedAt,
    });
    expect('choices' in (await store.getQuestion(first.id))!).toBe(false);

    await store.deleteQuestion(second.id);
    expect((await store.listQuestions(deck.id)).map((q) => q.id)).toEqual([first.id]);
  });

  it('duplicates a deck with copies of its questions', async () => {
    const { store } = freshStore();
    const deck = await store.createDeck({ name: 'Original', description: 'd' });
    await store.addQuestion(deck.id, trueFalse('A.', true));
    await store.addQuestion(deck.id, trueFalse('B.', false));

    const copy = await store.duplicateDeck(deck.id);
    expect(copy.name).toBe('Original (copy)');
    expect(copy.id).not.toBe(deck.id);
    const [originals, copies] = await Promise.all([store.listQuestions(deck.id), store.listQuestions(copy.id)]);
    expect(copies.map((q) => q.prompt)).toEqual(['A.', 'B.']);
    expect(copies.every((q) => q.deckId === copy.id)).toBe(true);
    expect(copies.some((q) => originals.some((o) => o.id === q.id))).toBe(false);
  });

  it('deletes a deck together with its questions', async () => {
    const { store } = freshStore();
    const keep = await store.createDeck({ name: 'Keep', description: '' });
    const remove = await store.createDeck({ name: 'Remove', description: '' });
    await store.addQuestion(keep.id, trueFalse('k', true));
    await store.addQuestion(remove.id, trueFalse('r', true));

    await store.deleteDeck(remove.id);
    expect((await store.listDecks()).map((d) => d.name)).toEqual(['Keep']);
    expect((await store.listAllQuestions()).map((q) => q.prompt)).toEqual(['k']);
  });

  it('imports a deck, replacing an older copy with the same id', async () => {
    const { store } = freshStore();
    const imported = await store.importDeck(
      { id: 'deck-from-laptop', name: 'AWS', description: '', questions: [trueFalse('v1', true)] },
      { asNewDeck: false },
    );
    expect(imported.id).toBe('deck-from-laptop');

    await store.importDeck(
      {
        id: 'deck-from-laptop',
        name: 'AWS v2',
        description: '',
        questions: [trueFalse('a', true), trueFalse('b', false)],
      },
      { asNewDeck: false },
    );
    const decks = await store.listDecks();
    expect(decks).toHaveLength(1);
    expect(decks[0].name).toBe('AWS v2');
    expect((await store.listQuestions('deck-from-laptop')).map((q) => q.prompt)).toEqual(['a', 'b']);

    const copy = await store.importDeck(
      { id: 'deck-from-laptop', name: 'AWS v2 (imported)', description: '', questions: [] },
      { asNewDeck: true },
    );
    expect(copy.id).not.toBe('deck-from-laptop');
    expect(await store.listDecks()).toHaveLength(2);
  });

  it('rejects invalid data and missing decks', async () => {
    const { store } = freshStore();
    await expect(store.createDeck({ name: '  ', description: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(store.addQuestion('no-such-deck', trueFalse('x', true))).rejects.toBeInstanceOf(NotFoundError);

    const deck = await store.createDeck({ name: 'Deck', description: '' });
    await expect(
      store.addQuestion(deck.id, {
        type: 'multiple_choice',
        prompt: 'x',
        choices: ['only'],
        correctIndex: 0,
        tags: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A failed import changes nothing.
    await expect(
      store.importDeck(
        { name: 'Bad', description: '', questions: [trueFalse('ok', true), trueFalse('', true)] },
        { asNewDeck: true },
      ),
    ).rejects.toThrow('Question 2: Prompt is required.');
    expect(await store.listDecks()).toHaveLength(1);
  });
});

describe('mastery progress', () => {
  it('upgrades a version 3 database without touching its decks', async () => {
    const name = `test-${createId()}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('decks', { keyPath: 'id' });
        db.createObjectStore('questions', { keyPath: 'id' }).createIndex('byDeck', 'deckId');
        const tx = request.transaction!;
        tx.objectStore('decks').put({ id: 'd1', name: 'Old deck', description: '', createdAt: 1, updatedAt: 1 });
        const question = { ...trueFalse('Kept?', true), id: 'q1', deckId: 'd1', createdAt: 1, updatedAt: 1 };
        tx.objectStore('questions').put(question);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const store = createIndexedDbStore({ name });
    expect((await store.listDecks()).map((d) => [d.name, d.questionCount])).toEqual([['Old deck', 1]]);
    expect(await store.loadProgress('d1')).toEqual({ records: [], rounds: 0 });
  });

  it('records a finished quiz once, as one round of its deck', async () => {
    const { store } = freshStore();
    const deck = await store.createDeck({ name: 'Geo', description: '' });
    const right = await store.addQuestion(deck.id, trueFalse('Right', true));
    const wrong = await store.addQuestion(deck.id, trueFalse('Wrong', true));
    const card = await store.addQuestion(deck.id, flashcard('Card', 'Back'));

    const quiz = finishedQuiz([right, wrong, card], [wrong]);
    expect(await store.recordQuiz(quiz)).toBe(true);
    expect(await store.recordQuiz(quiz)).toBe(false);

    const { records, rounds } = await store.loadProgress(deck.id);
    expect(rounds).toBe(1);
    const byId = new Map(records.map((r) => [r.questionId, r]));
    expect(byId.get(right.id)).toMatchObject({ level: 2, rightRound: 1, seen: 1, right: 1 });
    expect(byId.get(wrong.id)).toMatchObject({ level: 1, rightRound: null, seen: 1, right: 0 });
    expect(byId.get(card.id)).toMatchObject({ level: 2, seen: 1 });
  });

  it("doesn't record a quiz that isn't finished", async () => {
    const { store } = freshStore();
    const deck = await store.createDeck({ name: 'Geo', description: '' });
    const question = await store.addQuestion(deck.id, trueFalse('Q', true));
    const quit = answerCurrent(
      createSession({
        title: 'Test',
        source: { kind: 'quick' },
        settings: DEFAULT_SETTINGS,
        items: [{ question, choiceOrder: [] }],
      }),
      response(question, true),
    );

    expect(await store.recordQuiz(quit)).toBe(false);
    expect(await store.loadProgress(deck.id)).toEqual({ records: [], rounds: 0 });
  });

  it('caps flashcards at level 3', async () => {
    let time = new Date(2026, 9, 1).getTime();
    const store = createIndexedDbStore({ name: `test-${createId()}`, now: () => (time += 86_400_000) });
    const deck = await store.createDeck({ name: 'Words', description: '' });
    const card = await store.addQuestion(deck.id, flashcard('Hund', 'dog'));
    const fact = await store.addQuestion(deck.id, trueFalse('Fact', true));
    for (let day = 0; day < 30; day++) await store.recordQuiz(finishedQuiz([card, fact]));

    const levels = new Map((await store.loadProgress(deck.id)).records.map((r) => [r.questionId, r.level]));
    expect(levels.get(card.id)).toBe(3);
    expect(levels.get(fact.id)).toBe(5);
  });

  it('skips answers to questions or decks deleted during the quiz', async () => {
    const { store } = freshStore();
    const kept = await store.createDeck({ name: 'Kept', description: '' });
    const gone = await store.createDeck({ name: 'Gone', description: '' });
    const keptQuestion = await store.addQuestion(kept.id, trueFalse('Stays', true));
    const deletedQuestion = await store.addQuestion(kept.id, trueFalse('Deleted', true));
    const goneQuestion = await store.addQuestion(gone.id, trueFalse('In a deleted deck', true));
    const quiz = finishedQuiz([keptQuestion, deletedQuestion, goneQuestion]);
    await store.deleteQuestion(deletedQuestion.id);
    await store.deleteDeck(gone.id);

    await store.recordQuiz(quiz);
    expect((await store.loadProgress(kept.id)).records.map((r) => r.questionId)).toEqual([keptQuestion.id]);
    expect(await store.loadProgress(gone.id)).toEqual({ records: [], rounds: 0 });
  });

  it('keeps only the latest 100 quiz ids', async () => {
    const { store } = freshStore();
    const deck = await store.createDeck({ name: 'Geo', description: '' });
    const question = await store.addQuestion(deck.id, trueFalse('Q', true));
    const quizzes = Array.from({ length: 101 }, () => finishedQuiz([question]));
    for (const quiz of quizzes) await store.recordQuiz(quiz);

    expect(await store.recordQuiz(quizzes[100])).toBe(false);
    expect(await store.recordQuiz(quizzes[0])).toBe(true);
    expect((await store.loadProgress(deck.id)).rounds).toBe(102);
  });

  it('deletes progress with its question or deck', async () => {
    const { store } = freshStore();
    const deck = await store.createDeck({ name: 'Geo', description: '' });
    const a = await store.addQuestion(deck.id, trueFalse('A', true));
    const b = await store.addQuestion(deck.id, trueFalse('B', true));
    await store.recordQuiz(finishedQuiz([a, b]));

    await store.deleteQuestion(a.id);
    expect((await store.loadProgress(deck.id)).records.map((r) => r.questionId)).toEqual([b.id]);
    await store.deleteDeck(deck.id);
    expect(await store.loadProgress(deck.id)).toEqual({ records: [], rounds: 0 });
  });

  it('carries progress when an import replaces a deck, and starts copies fresh', async () => {
    const { store } = freshStore();
    const file = (questions: ReturnType<typeof trueFalse>[]) => ({
      id: 'deck-geo',
      name: 'Geo',
      description: '',
      questions,
    });
    await store.importDeck(file([trueFalse('Kept', true), trueFalse('Reworded', true)]), { asNewDeck: false });
    await store.recordQuiz(finishedQuiz(await store.listQuestions('deck-geo')));

    await store.importDeck(file([trueFalse('Reworded better', true), trueFalse('Kept', true)]), { asNewDeck: false });
    const [, newKept] = await store.listQuestions('deck-geo');
    const { records, rounds } = await store.loadProgress('deck-geo');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ questionId: newKept.id, level: 2, seen: 1 });
    expect(rounds).toBe(1);

    const copy = await store.importDeck(file([trueFalse('Kept', true)]), { asNewDeck: true });
    expect(await store.loadProgress(copy.id)).toEqual({ records: [], rounds: 0 });
  });

  it('moves progress to another device in an "export all decks" backup', async () => {
    const { store: home } = freshStore();
    const deck = await home.createDeck({ name: 'Geo', description: '' });
    const a = await home.addQuestion(deck.id, trueFalse('A', true));
    const b = await home.addQuestion(deck.id, flashcard('B', 'Back'));
    await home.addQuestion(deck.id, trueFalse('Not played yet', true));
    await home.recordQuiz(finishedQuiz([a, b], [b]));
    const before = await home.loadProgress(deck.id);
    const backup = serializeDeckFile(
      createDecksFile([{ deck, questions: await home.listQuestions(deck.id), progress: before }]),
    );

    const parsed = parseDecks(backup);
    if (!parsed.ok) throw new Error('The backup should read back.');
    const { store: away } = freshStore();
    await away.importDeck(parsed.value[0], { asNewDeck: false });
    const [newA, newB] = await away.listQuestions(deck.id);
    const after = await away.loadProgress(deck.id);
    const byId = new Map(before.records.map((record) => [record.questionId, record]));
    expect(after.rounds).toBe(1);
    expect(after.records).toHaveLength(2);
    expect(after.records).toContainEqual({ ...byId.get(a.id), questionId: newA.id });
    expect(after.records).toContainEqual({ ...byId.get(b.id), questionId: newB.id });

    const copy = await away.importDeck(parsed.value[0], { asNewDeck: true });
    expect(await away.loadProgress(copy.id)).toEqual({ records: [], rounds: 0 });
  });
});
