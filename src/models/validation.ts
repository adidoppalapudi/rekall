/**
 * Validation shared by the editor, the data store and deck import.
 *
 * Every validator accepts `unknown` (so it can check JSON from a file), and on
 * success returns a cleaned-up value: text trimmed, empty optional fields
 * removed, tags normalised.
 */
import {
  DIFFICULTIES,
  MAX_CHOICES,
  MIN_CHOICES,
  QUESTION_TYPES,
  toContent,
  type DeckInput,
  type Difficulty,
  type MasteryLevel,
  type QuestionContent,
  type QuestionType,
  type SavedProgress,
} from './types';

export const LIMITS = {
  deckName: 80,
  deckDescription: 500,
  prompt: 1000,
  choice: 300,
  answer: 2000,
  explanation: 2000,
  tag: 40,
  tagCount: 20,
} as const;

export interface FieldError {
  /** Where the problem is, e.g. "prompt", "choices.2" or "questions.4.answer". */
  field: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail<T>(field: string, message: string): ValidationResult<T> {
  return { ok: false, errors: [{ field, message }] };
}

/** Accepts strings, and numbers written as text (handy in hand-written files). */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function requiredText(value: unknown, field: string, label: string, max: number, errors: FieldError[]): string {
  const text = asText(value);
  if (!text) {
    errors.push({ field, message: `${label} is required.` });
    return '';
  }
  if (text.length > max) errors.push({ field, message: `${label} is too long (max ${max} characters).` });
  return text;
}

function optionalText(
  value: unknown,
  field: string,
  label: string,
  max: number,
  errors: FieldError[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = asText(value);
  if (text === undefined) {
    errors.push({ field, message: `${label} must be text.` });
    return undefined;
  }
  if (text.length > max) errors.push({ field, message: `${label} is too long (max ${max} characters).` });
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Decks

export function validateDeckInput(input: unknown): ValidationResult<DeckInput> {
  if (!isRecord(input)) return fail('deck', 'Deck details are missing.');
  const errors: FieldError[] = [];
  const name = requiredText(input.name, 'name', 'Deck name', LIMITS.deckName, errors);
  const description =
    optionalText(input.description, 'description', 'Description', LIMITS.deckDescription, errors) ?? '';
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { name, description } };
}

/** Appends a suffix such as " (copy)", trimming the name so the result still fits. */
export function nameWithSuffix(name: string, suffix: string): string {
  return name.slice(0, LIMITS.deckName - suffix.length) + suffix;
}

// ---------------------------------------------------------------------------
// Tags

/** "#Query Planning " → "query-planning" */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().replace(/\s+/g, '-').toLowerCase();
}

/** Splits what someone typed in the tags field: commas and/or spaces separate tags. */
export function parseTagInput(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map(normalizeTag)
    .filter(Boolean);
}

function validateTags(value: unknown, errors: FieldError[]): string[] {
  if (value === undefined || value === null) return [];
  let raw: unknown[];
  if (typeof value === 'string') raw = parseTagInput(value);
  else if (Array.isArray(value)) raw = value;
  else {
    errors.push({ field: 'tags', message: 'Tags must be a list of words.' });
    return [];
  }

  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      errors.push({ field: 'tags', message: 'Tags must be a list of words.' });
      return [];
    }
    const tag = normalizeTag(item);
    if (!tag || tags.includes(tag)) continue;
    if (tag.length > LIMITS.tag) {
      errors.push({ field: 'tags', message: `Tag "${tag.slice(0, 20)}…" is too long (max ${LIMITS.tag} characters).` });
      continue;
    }
    tags.push(tag);
  }
  if (tags.length > LIMITS.tagCount) {
    errors.push({ field: 'tags', message: `Too many tags (max ${LIMITS.tagCount}).` });
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Questions

function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value);
}

function validateDifficulty(value: unknown, errors: FieldError[]): Difficulty | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (typeof text === 'string' && (DIFFICULTIES as readonly string[]).includes(text)) {
    return text as Difficulty;
  }
  errors.push({ field: 'difficulty', message: `Difficulty must be ${DIFFICULTIES.join(', ')} or left empty.` });
  return undefined;
}

function validateChoices(value: unknown, errors: FieldError[]): string[] {
  if (!Array.isArray(value)) {
    errors.push({ field: 'choices', message: `Add ${MIN_CHOICES} to ${MAX_CHOICES} choices.` });
    return [];
  }
  if (value.length < MIN_CHOICES || value.length > MAX_CHOICES) {
    errors.push({
      field: 'choices',
      message: `Multiple choice questions need ${MIN_CHOICES} to ${MAX_CHOICES} choices (this one has ${value.length}).`,
    });
  }
  const choices: string[] = [];
  const seen = new Map<string, number>();
  value.forEach((raw, i) => {
    const field = `choices.${i}`;
    const text = asText(raw);
    if (!text) {
      errors.push({ field, message: `Choice ${i + 1} is empty.` });
      choices.push('');
      return;
    }
    if (text.length > LIMITS.choice) {
      errors.push({ field, message: `Choice ${i + 1} is too long (max ${LIMITS.choice} characters).` });
    }
    const key = text.toLowerCase();
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      errors.push({ field, message: `Choice ${i + 1} is the same as choice ${firstIndex + 1}.` });
    } else {
      seen.set(key, i);
    }
    choices.push(text);
  });
  return choices;
}

/**
 * Finds the correct choice. Files may give `correctIndex` (0-based) or, as a
 * convenience for hand-written decks, `answer` holding the correct choice's text.
 */
function resolveCorrectIndex(input: Record<string, unknown>, choices: string[]): number | undefined {
  const index = input.correctIndex;
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < choices.length) {
    return index;
  }
  if (index === undefined) {
    const answer = asText(input.answer)?.toLowerCase();
    if (answer) {
      const match = choices.findIndex((choice) => choice.toLowerCase() === answer);
      if (match >= 0) return match;
    }
  }
  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return undefined;
}

export function validateQuestionContent(input: unknown): ValidationResult<QuestionContent> {
  if (!isRecord(input)) return fail('question', 'Question must be an object.');
  const type = input.type;
  if (!isQuestionType(type)) {
    return fail('type', `Type must be one of: ${QUESTION_TYPES.join(', ')}.`);
  }

  const errors: FieldError[] = [];
  const prompt = requiredText(input.prompt, 'prompt', 'Prompt', LIMITS.prompt, errors);
  const explanation = optionalText(input.explanation, 'explanation', 'Explanation', LIMITS.explanation, errors);
  const difficulty = validateDifficulty(input.difficulty, errors);
  const tags = validateTags(input.tags, errors);
  const common = { prompt, explanation, difficulty, tags };

  let content: QuestionContent | undefined;
  switch (type) {
    case 'multiple_choice': {
      const choices = validateChoices(input.choices, errors);
      const correctIndex = resolveCorrectIndex(input, choices);
      if (correctIndex === undefined) {
        errors.push({ field: 'correctIndex', message: 'Mark one choice as the correct answer.' });
      } else {
        content = { type, ...common, choices, correctIndex };
      }
      break;
    }
    case 'true_false': {
      const answer = parseBoolean(input.answer);
      if (answer === undefined) {
        errors.push({ field: 'answer', message: 'Choose whether the statement is true or false.' });
      } else {
        content = { type, ...common, answer };
      }
      break;
    }
    case 'flashcard': {
      const answer = requiredText(input.answer, 'answer', 'Answer', LIMITS.answer, errors);
      content = { type, ...common, answer };
      break;
    }
  }

  if (errors.length > 0 || !content) return { ok: false, errors };
  return { ok: true, value: toContent(content) };
}

/** Validates every question in a list. Errors say which question they belong to ("Question 3: ..."). */
export function validateQuestionList(questions: readonly unknown[]): ValidationResult<QuestionContent[]> {
  const values: QuestionContent[] = [];
  const errors: FieldError[] = [];
  questions.forEach((raw, i) => {
    const result = validateQuestionContent(raw);
    if (result.ok) values.push(result.value);
    else
      errors.push(
        ...result.errors.map((error) => ({
          field: `questions.${i}.${error.field}`,
          message: `Question ${i + 1}: ${error.message}`,
        })),
      );
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: values };
}

const isWhole = (value: unknown): value is number => Number.isInteger(value);

/**
 * Reads one question's progress from a backup. Unlike the validators above, it
 * reports no errors. Progress is optional, so a record that doesn't fit is
 * dropped and that question starts fresh. A right answer's round can't be past
 * the deck's `rounds`.
 */
export function readSavedProgress(value: unknown, rounds: number): SavedProgress | undefined {
  if (!isRecord(value)) return undefined;
  const { level, promotionDay, weightAfter, answeredDay, rightRound, dropDay, seen, right } = value;
  const fits =
    isWhole(level) &&
    level >= 1 &&
    level <= 5 &&
    isWhole(promotionDay) &&
    typeof weightAfter === 'number' &&
    Number.isFinite(weightAfter) &&
    weightAfter > 0 &&
    isWhole(answeredDay) &&
    (rightRound === null || (isWhole(rightRound) && rightRound >= 1 && rightRound <= rounds)) &&
    (dropDay === null || isWhole(dropDay)) &&
    isWhole(seen) &&
    seen >= 1 &&
    isWhole(right) &&
    right >= 0 &&
    right <= seen;
  if (!fits) return undefined;
  return { level: level as MasteryLevel, promotionDay, weightAfter, answeredDay, rightRound, dropDay, seen, right };
}
