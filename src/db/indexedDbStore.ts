import { NotFoundError, unwrap } from '../lib/errors';
import { createId } from '../lib/id';
import {
  sortByCreation,
  toContent,
  type Deck,
  type DeckInput,
  type DeckSummary,
  type ImportedDeck,
  type Question,
  type QuestionProgress,
} from '../models/types';
import { nameWithSuffix, validateDeckInput, validateQuestionContent, validateQuestionList } from '../models/validation';
import { applyAnswer, carryProgress, dayNumber } from '../quiz/mastery';
import type { DataStore } from './DataStore';
import {
  BY_DECK,
  DECKS,
  DECK_ROUNDS,
  PROGRESS,
  QUESTIONS,
  RECORDED_SESSIONS,
  openDatabase,
  promisifyRequest,
  transactionDone,
} from './idb';

interface DeckRounds {
  deckId: string;
  rounds: number;
}

/** Enough to stop a reload or a second render recording the same quiz again. */
const KEPT_QUIZ_IDS = 100;

export interface IndexedDbStoreOptions {
  /** Database name. Tests use a fresh name per test. */
  name?: string;
  /** Clock used for timestamps (injectable for tests). */
  now?: () => number;
}

const byName = (a: DeckSummary, b: DeckSummary) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

export function createIndexedDbStore(options: IndexedDbStoreOptions = {}): DataStore {
  const { name = 'enyalie', now = Date.now } = options;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      const opening = openDatabase(name).then((db) => {
        // Let another tab upgrade the schema; we reconnect on next use.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        return db;
      });
      opening.catch(() => {
        if (dbPromise === opening) dbPromise = null; // allow a retry after a failure
      });
      dbPromise = opening;
    }
    return dbPromise;
  }

  /** Runs `work` inside one transaction; any error rolls the whole thing back. */
  async function run<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => T | Promise<T>,
  ): Promise<T> {
    const db = await getDb();
    const tx = db.transaction(storeNames, mode);
    const done = transactionDone(tx);
    done.catch(() => {}); // still awaited below; this just avoids "unhandled rejection" noise
    try {
      const result = await work(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction has already finished or aborted.
      }
      throw error;
    }
  }

  async function getRecord<T>(tx: IDBTransaction, storeName: string, id: string): Promise<T | undefined> {
    return (await promisifyRequest(tx.objectStore(storeName).get(id))) as T | undefined;
  }

  async function deckQuestionKeys(tx: IDBTransaction, deckId: string): Promise<IDBValidKey[]> {
    const index = tx.objectStore(QUESTIONS).index(BY_DECK);
    return promisifyRequest(index.getAllKeys(IDBKeyRange.only(deckId)));
  }

  async function deckProgress(tx: IDBTransaction, deckId: string): Promise<QuestionProgress[]> {
    const index = tx.objectStore(PROGRESS).index(BY_DECK);
    return (await promisifyRequest(index.getAll(IDBKeyRange.only(deckId)))) as QuestionProgress[];
  }

  /** Keeps only the latest recorded quiz ids. */
  async function trimRecordedSessions(tx: IDBTransaction): Promise<void> {
    const store = tx.objectStore(RECORDED_SESSIONS);
    const rows = (await promisifyRequest(store.getAll())) as { id: string; at: number }[];
    rows
      .sort((a, b) => a.at - b.at)
      .slice(0, Math.max(rows.length - KEPT_QUIZ_IDS, 0))
      .forEach((row) => store.delete(row.id));
  }

  /** Marks a deck as changed when one of its questions changes. */
  function touchDeck(tx: IDBTransaction, deck: Deck, time: number): void {
    tx.objectStore(DECKS).put({ ...deck, updatedAt: time });
  }

  return {
    listDecks: () =>
      run([DECKS, QUESTIONS], 'readonly', async (tx) => {
        const decks = (await promisifyRequest(tx.objectStore(DECKS).getAll())) as Deck[];
        const index = tx.objectStore(QUESTIONS).index(BY_DECK);
        const counts = await Promise.all(decks.map((deck) => promisifyRequest(index.count(IDBKeyRange.only(deck.id)))));
        return decks.map((deck, i) => ({ ...deck, questionCount: counts[i] })).sort(byName);
      }),

    getDeck: (id) => run(DECKS, 'readonly', (tx) => getRecord<Deck>(tx, DECKS, id)),

    async createDeck(input: DeckInput) {
      const value = unwrap(validateDeckInput(input));
      const time = now();
      const deck: Deck = { id: createId(), ...value, createdAt: time, updatedAt: time };
      await run(DECKS, 'readwrite', (tx) => {
        tx.objectStore(DECKS).add(deck);
      });
      return deck;
    },

    async updateDeck(id, input) {
      const value = unwrap(validateDeckInput(input));
      return run(DECKS, 'readwrite', async (tx) => {
        const existing = await getRecord<Deck>(tx, DECKS, id);
        if (!existing) throw new NotFoundError('That deck no longer exists.');
        const updated: Deck = { ...existing, ...value, updatedAt: now() };
        tx.objectStore(DECKS).put(updated);
        return updated;
      });
    },

    duplicateDeck: (id) =>
      run([DECKS, QUESTIONS], 'readwrite', async (tx) => {
        const source = await getRecord<Deck>(tx, DECKS, id);
        if (!source) throw new NotFoundError('That deck no longer exists.');
        const index = tx.objectStore(QUESTIONS).index(BY_DECK);
        const questions = (await promisifyRequest(index.getAll(IDBKeyRange.only(id)))) as Question[];

        const time = now();
        const copy: Deck = {
          id: createId(),
          name: nameWithSuffix(source.name, ' (copy)'),
          description: source.description,
          createdAt: time,
          updatedAt: time,
        };
        tx.objectStore(DECKS).add(copy);
        sortByCreation(questions).forEach((question, i) => {
          const duplicate: Question = {
            ...toContent(question),
            id: createId(),
            deckId: copy.id,
            createdAt: time + i, // keeps the original order
            updatedAt: time,
          };
          tx.objectStore(QUESTIONS).add(duplicate);
        });
        return copy;
      }),

    deleteDeck: (id) =>
      run([DECKS, QUESTIONS, PROGRESS, DECK_ROUNDS], 'readwrite', async (tx) => {
        tx.objectStore(DECKS).delete(id);
        tx.objectStore(DECK_ROUNDS).delete(id);
        const keys = await deckQuestionKeys(tx, id);
        keys.forEach((key) => {
          tx.objectStore(QUESTIONS).delete(key);
          tx.objectStore(PROGRESS).delete(key);
        });
      }),

    listQuestions: (deckId) =>
      run(QUESTIONS, 'readonly', async (tx) => {
        const index = tx.objectStore(QUESTIONS).index(BY_DECK);
        return sortByCreation((await promisifyRequest(index.getAll(IDBKeyRange.only(deckId)))) as Question[]);
      }),

    listAllQuestions: () =>
      run(QUESTIONS, 'readonly', async (tx) =>
        sortByCreation((await promisifyRequest(tx.objectStore(QUESTIONS).getAll())) as Question[]),
      ),

    getQuestion: (id) => run(QUESTIONS, 'readonly', (tx) => getRecord<Question>(tx, QUESTIONS, id)),

    async addQuestion(deckId, content) {
      const value = unwrap(validateQuestionContent(content));
      return run([DECKS, QUESTIONS], 'readwrite', async (tx) => {
        const deck = await getRecord<Deck>(tx, DECKS, deckId);
        if (!deck) throw new NotFoundError('That deck no longer exists.');
        const time = now();
        const question: Question = { ...value, id: createId(), deckId, createdAt: time, updatedAt: time };
        tx.objectStore(QUESTIONS).add(question);
        touchDeck(tx, deck, time);
        return question;
      });
    },

    async updateQuestion(id, content) {
      const value = unwrap(validateQuestionContent(content));
      return run([DECKS, QUESTIONS], 'readwrite', async (tx) => {
        const existing = await getRecord<Question>(tx, QUESTIONS, id);
        if (!existing) throw new NotFoundError('That question no longer exists.');
        const time = now();
        // Built from the validated content (not spread from `existing`) so that
        // fields from an old question type don't linger after a type change.
        const updated: Question = {
          ...value,
          id,
          deckId: existing.deckId,
          createdAt: existing.createdAt,
          updatedAt: time,
        };
        tx.objectStore(QUESTIONS).put(updated);
        const deck = await getRecord<Deck>(tx, DECKS, existing.deckId);
        if (deck) touchDeck(tx, deck, time);
        return updated;
      });
    },

    deleteQuestion: (id) =>
      run([DECKS, QUESTIONS, PROGRESS], 'readwrite', async (tx) => {
        const existing = await getRecord<Question>(tx, QUESTIONS, id);
        if (!existing) return;
        tx.objectStore(QUESTIONS).delete(id);
        tx.objectStore(PROGRESS).delete(id);
        const deck = await getRecord<Deck>(tx, DECKS, existing.deckId);
        if (deck) touchDeck(tx, deck, now());
      }),

    async importDeck(input: ImportedDeck, { asNewDeck }) {
      const details = unwrap(validateDeckInput(input));
      const contents = unwrap(validateQuestionList(input.questions));
      return run([DECKS, QUESTIONS, PROGRESS, DECK_ROUNDS], 'readwrite', async (tx) => {
        const id = !asNewDeck && input.id ? input.id : createId();
        const existing = await getRecord<Deck>(tx, DECKS, id);
        let oldQuestions: Question[] = [];
        let oldProgress: QuestionProgress[] = [];
        if (existing) {
          const index = tx.objectStore(QUESTIONS).index(BY_DECK);
          oldQuestions = sortByCreation((await promisifyRequest(index.getAll(IDBKeyRange.only(id)))) as Question[]);
          oldProgress = await deckProgress(tx, id);
          oldQuestions.forEach((question) => tx.objectStore(QUESTIONS).delete(question.id));
          oldProgress.forEach((record) => tx.objectStore(PROGRESS).delete(record.questionId));
        }
        const time = now();
        const deck: Deck = { id, ...details, createdAt: existing?.createdAt ?? time, updatedAt: time };
        tx.objectStore(DECKS).put(deck);
        const questions = contents.map(
          (content, i): Question => ({ ...content, id: createId(), deckId: id, createdAt: time + i, updatedAt: time }),
        );
        questions.forEach((question) => tx.objectStore(QUESTIONS).add(question));

        // A backup brings its own progress. Otherwise progress carries over from the replaced deck.
        const saved = asNewDeck ? undefined : input.progress;
        const progress = saved
          ? questions.flatMap((question, i) => {
              const record = saved.byQuestion[i];
              return record ? [{ ...record, questionId: question.id, deckId: id }] : [];
            })
          : carryProgress(oldQuestions, oldProgress, questions);
        progress.forEach((record) => tx.objectStore(PROGRESS).put(record));
        if (saved) tx.objectStore(DECK_ROUNDS).put({ deckId: id, rounds: saved.rounds });
        return deck;
      });
    },

    loadProgress: (deckId) =>
      run([PROGRESS, DECK_ROUNDS], 'readonly', async (tx) => {
        const rounds = await getRecord<DeckRounds>(tx, DECK_ROUNDS, deckId);
        return { records: await deckProgress(tx, deckId), rounds: rounds?.rounds ?? 0 };
      }),

    recordQuiz: (session) =>
      run([DECKS, QUESTIONS, PROGRESS, DECK_ROUNDS, RECORDED_SESSIONS], 'readwrite', async (tx) => {
        if (session.finishedAt === null || (await getRecord(tx, RECORDED_SESSIONS, session.id))) return false;
        const time = now();
        const today = dayNumber(time);
        tx.objectStore(RECORDED_SESSIONS).put({ id: session.id, at: time });
        const answered = session.items.flatMap(({ question }, i) => {
          const answer = session.answers[i];
          return answer ? [{ question, correct: answer.correct }] : [];
        });

        // This quiz is one more round for every deck it used, and right answers remember that round.
        const rounds = new Map<string, number>();
        for (const deckId of new Set(answered.map(({ question }) => question.deckId))) {
          if (!(await getRecord<Deck>(tx, DECKS, deckId))) continue; // deleted since
          const round = ((await getRecord<DeckRounds>(tx, DECK_ROUNDS, deckId))?.rounds ?? 0) + 1;
          rounds.set(deckId, round);
          tx.objectStore(DECK_ROUNDS).put({ deckId, rounds: round });
        }
        for (const { question, correct } of answered) {
          const round = rounds.get(question.deckId);
          if (round === undefined || !(await getRecord<Question>(tx, QUESTIONS, question.id))) continue;
          const current = await getRecord<QuestionProgress>(tx, PROGRESS, question.id);
          const identity = { questionId: question.id, deckId: question.deckId };
          const selfGraded = question.type === 'flashcard';
          tx.objectStore(PROGRESS).put(applyAnswer(current, identity, correct, today, round, selfGraded));
        }
        await trimRecordedSessions(tx);
        return true;
      }),
  };
}
