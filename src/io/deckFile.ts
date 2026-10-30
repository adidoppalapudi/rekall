/**
 * The deck file format used for export and import.
 *
 * Example:
 * {
 *   "format": "enyalie-deck",
 *   "version": 1,
 *   "exportedAt": "2026-10-16T09:30:00.000Z",
 *   "deck": { "id": "…", "name": "PostgreSQL Fundamentals", "description": "" },
 *   "questions": [
 *     { "type": "multiple_choice", "prompt": "…", "choices": ["…", "…"], "correctIndex": 1 },
 *     { "type": "true_false", "prompt": "…", "answer": true },
 *     { "type": "flashcard", "prompt": "…", "answer": "…", "tags": ["mvcc"] }
 *   ]
 * }
 *
 * "Export all decks" writes several decks to one file instead. It is also the
 * backup, so it keeps mastery. A played deck has "rounds", and each answered
 * question has "progress", which is QuestionProgress from src/models/types.ts
 * without the ids.
 * { "format": "enyalie-decks", "version": 1, "exportedAt": "…",
 *   "decks": [{ "deck": { … }, "rounds": 4, "questions": [
 *     { "type": "true_false", "prompt": "…", "answer": true,
 *       "progress": { "level": 2, "promotionDay": 20757, … } }, … ] }, …] }
 * Older versions of Enyalië ignore "rounds" and "progress", so the version stays 1.
 *
 * Import is deliberately forgiving so decks can be written by hand:
 * "format", "version", "exportedAt" and the deck id are optional, the deck's
 * name may sit at the top level instead of inside "deck", and a multiple
 * choice question may name its correct choice with "answer" instead of
 * "correctIndex".
 */
import { slugify } from '../lib/format';
import {
  toContent,
  type Deck,
  type DeckProgress,
  type ImportedDeck,
  type Question,
  type QuestionContent,
  type SavedProgress,
} from '../models/types';
import {
  isRecord,
  readSavedProgress,
  validateDeckInput,
  validateQuestionList,
  type FieldError,
  type ValidationResult,
} from '../models/validation';

const DECK_FILE_FORMAT = 'enyalie-deck';
const DECKS_FILE_FORMAT = 'enyalie-decks';
const DECK_FILE_VERSION = 1;

interface DeckEntry {
  deck: { id: string; name: string; description: string };
  questions: QuestionContent[];
}

/** A deck in a backup, with its mastery when it has been played. */
interface BackupEntry extends DeckEntry {
  rounds?: number;
  questions: (QuestionContent & { progress?: SavedProgress })[];
}

export interface DeckFile extends DeckEntry {
  format: typeof DECK_FILE_FORMAT;
  version: number;
  exportedAt: string;
}

/** Several decks in one file, written by "export all decks". */
export interface DecksFile {
  format: typeof DECKS_FILE_FORMAT;
  version: number;
  exportedAt: string;
  decks: BackupEntry[];
}

function toEntry(deck: Deck, questions: readonly Question[]): DeckEntry {
  return {
    deck: { id: deck.id, name: deck.name, description: deck.description },
    questions: questions.map(toContent),
  };
}

function toBackupEntry(deck: Deck, questions: readonly Question[], progress?: DeckProgress): BackupEntry {
  if (!progress || (progress.rounds === 0 && progress.records.length === 0)) return toEntry(deck, questions);
  const records = new Map(progress.records.map(({ questionId, deckId: _, ...saved }) => [questionId, saved]));
  return {
    deck: { id: deck.id, name: deck.name, description: deck.description },
    rounds: progress.rounds,
    questions: questions.map((question) => {
      const saved = records.get(question.id);
      return saved ? { ...toContent(question), progress: saved } : toContent(question);
    }),
  };
}

export function createDeckFile(deck: Deck, questions: readonly Question[], exportedAt = new Date()): DeckFile {
  return {
    format: DECK_FILE_FORMAT,
    version: DECK_FILE_VERSION,
    exportedAt: exportedAt.toISOString(),
    ...toEntry(deck, questions),
  };
}

/** The "export all decks" backup. Each deck's progress goes in when given. */
export function createDecksFile(
  decks: readonly { deck: Deck; questions: readonly Question[]; progress?: DeckProgress }[],
  exportedAt = new Date(),
): DecksFile {
  return {
    format: DECKS_FILE_FORMAT,
    version: DECK_FILE_VERSION,
    exportedAt: exportedAt.toISOString(),
    decks: decks.map(({ deck, questions, progress }) => toBackupEntry(deck, questions, progress)),
  };
}

export function serializeDeckFile(file: DeckFile | DecksFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** "PostgreSQL Fundamentals" → "postgresql-fundamentals.enyalie.json" */
export function deckFileName(deckName: string): string {
  return `${slugify(deckName) || 'deck'}.enyalie.json`;
}

/** The "export all decks" file for a day, e.g. "enyalie-decks-2026-10-21.enyalie.json". */
export function decksFileName(date = new Date()): string {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  return `enyalie-decks-${day}.enyalie.json`;
}

type Failure = { ok: false; errors: FieldError[] };

function failure(field: string, message: string): Failure {
  return { ok: false, errors: [{ field, message }] };
}

const NOT_A_DECK = "This doesn't look like an Enyalië deck file.";

/** Parses the JSON and checks the parts every deck file shares. */
function readJson(text: string): { ok: true; data: Record<string, unknown> } | Failure {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, '')); // tolerate a byte-order mark
  } catch {
    return failure('file', "This file isn't valid JSON, so it can't be imported.");
  }
  if (!isRecord(data)) return failure('file', NOT_A_DECK);
  if (data.version !== undefined) {
    if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1) {
      return failure('version', '"version" must be a whole number.');
    }
    if (data.version > DECK_FILE_VERSION) {
      return failure(
        'version',
        `This file was exported by a newer version of Enyalië (file version ${data.version}). Update Enyalië to import it.`,
      );
    }
  }
  return { ok: true, data };
}

/** Reads a file holding one deck and checks every question in it. */
export function parseDeckFile(text: string): ValidationResult<ImportedDeck> {
  const json = readJson(text);
  return json.ok ? parseOneDeck(json.data) : json;
}

/**
 * Reads a file holding one deck, or several from "export all decks". A file
 * with several decks is only accepted when every deck in it is valid.
 */
export function parseDecks(text: string): ValidationResult<ImportedDeck[]> {
  const json = readJson(text);
  if (!json.ok) return json;
  if (json.data.format !== DECKS_FILE_FORMAT) {
    const one = parseOneDeck(json.data);
    return one.ok ? { ok: true, value: [one.value] } : one;
  }

  const entries = json.data.decks;
  if (!Array.isArray(entries)) return failure('decks', `${NOT_A_DECK} It needs a "decks" list.`);
  if (entries.length === 0) return failure('decks', 'This file has no decks in it.');
  const decks: ImportedDeck[] = [];
  const errors: FieldError[] = [];
  entries.forEach((entry, index) => {
    const result = isRecord(entry) ? checkBackupDeck(entry) : failure('deck', NOT_A_DECK);
    if (result.ok) decks.push(result.value);
    else {
      errors.push(
        ...result.errors.map((error) => ({
          field: `decks.${index}.${error.field}`,
          message: `Deck ${index + 1}: ${error.message}`,
        })),
      );
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: decks };
}

/**
 * Checks one deck of an "export all decks" file and keeps its mastery, if it
 * has any. Progress that doesn't fit is dropped, so those questions start fresh.
 */
function checkBackupDeck(entry: Record<string, unknown>): ValidationResult<ImportedDeck> {
  const result = checkDeck(entry);
  const { rounds, questions } = entry;
  if (!result.ok || typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 0) return result;
  const byQuestion = (questions as unknown[]).map((question) =>
    isRecord(question) ? readSavedProgress(question.progress, rounds) : undefined,
  );
  return { ok: true, value: { ...result.value, progress: { rounds, byQuestion } } };
}

function parseOneDeck(data: Record<string, unknown>): ValidationResult<ImportedDeck> {
  if (data.format !== undefined && data.format !== DECK_FILE_FORMAT) {
    return failure('format', `${NOT_A_DECK} (Its format is "${String(data.format)}".)`);
  }
  return checkDeck(data);
}

/** Checks one deck's details and questions. */
function checkDeck(data: Record<string, unknown>): ValidationResult<ImportedDeck> {
  if (!Array.isArray(data.questions)) {
    return failure('questions', `${NOT_A_DECK} It needs a "questions" list.`);
  }

  // The deck's details normally live under "deck", but a hand-written file may
  // put "name" and "description" at the top level.
  const deckData = isRecord(data.deck) ? data.deck : data;
  const errors: FieldError[] = [];
  const details = validateDeckInput({ name: deckData.name, description: deckData.description });
  if (!details.ok) {
    errors.push(...details.errors.map((error) => ({ field: `deck.${error.field}`, message: error.message })));
  }

  const questions = validateQuestionList(data.questions);
  if (!questions.ok) errors.push(...questions.errors);

  if (!details.ok || !questions.ok) return { ok: false, errors };

  const id = typeof deckData.id === 'string' && /^[\w-]{1,64}$/.test(deckData.id) ? deckData.id : undefined;
  return { ok: true, value: { id, ...details.value, questions: questions.value } };
}
