import type {
  Deck,
  DeckInput,
  DeckProgress,
  DeckSummary,
  ImportedDeck,
  Question,
  QuestionContent,
} from '../models/types';
import type { QuizSession } from '../quiz/engine';

/**
 * Everything the app needs from storage.
 *
 * The UI only talks to this interface. indexedDbStore.ts implements it with
 * IndexedDB in the browser.
 *
 * Methods that save data validate it and throw a ValidationError when it is
 * invalid, or a NotFoundError when the deck or question no longer exists.
 */
export interface DataStore {
  /** All decks with their question counts, sorted by name. */
  listDecks(): Promise<DeckSummary[]>;
  getDeck(id: string): Promise<Deck | undefined>;
  createDeck(input: DeckInput): Promise<Deck>;
  /** Renames a deck or changes its description. */
  updateDeck(id: string, input: DeckInput): Promise<Deck>;
  /** Copies a deck and all its questions under a new name ("… (copy)"). */
  duplicateDeck(id: string): Promise<Deck>;
  /** Deletes a deck together with its questions and their progress. */
  deleteDeck(id: string): Promise<void>;

  /** A deck's questions in the order they were added. */
  listQuestions(deckId: string): Promise<Question[]>;
  /** Every question in every deck (used by Quick Play). */
  listAllQuestions(): Promise<Question[]>;
  getQuestion(id: string): Promise<Question | undefined>;
  addQuestion(deckId: string, content: QuestionContent): Promise<Question>;
  updateQuestion(id: string, content: QuestionContent): Promise<Question>;
  deleteQuestion(id: string): Promise<void>;

  /**
   * Saves a deck read from a file, with all its questions, in one step.
   * With `asNewDeck: false` the deck keeps the id from the file and replaces
   * any existing deck with that id. A backup brings its own progress. Other
   * files keep the old deck's progress for questions with the same type and
   * wording. With `asNewDeck: true` it gets a fresh id and no progress.
   */
  importDeck(deck: ImportedDeck, options: { asNewDeck: boolean }): Promise<Deck>;

  /** A deck's mastery: a record for each question answered at least once, and its round count. */
  loadProgress(deckId: string): Promise<DeckProgress>;
  /**
   * Records a finished quiz through the mastery rules: one more round for each
   * deck in it, and every answer. A quiz is recorded once, so this returns
   * false and changes nothing for a quiz recorded before or not finished.
   * Answers to questions deleted since are skipped.
   */
  recordQuiz(session: QuizSession): Promise<boolean>;
}
