/**
 * Mastery levels. How each answer moves a question's level and draw weight,
 * and how a deck's quiz picks its questions from them.
 *
 * Everything here is a pure function of the saved progress, the local day and
 * the deck's round count, so nothing runs in the background. src/db keeps the
 * records, and the results screen records each quiz once.
 */
import { shuffle, type Random } from '../lib/random';
import type { DeckProgress, MasteryLevel, QuestionProgress } from '../models/types';

const DAY_MS = 86_400_000;
const NEW_WEIGHT = 5;
const RIGHT_WEIGHT = 0.2;
const MISS_WEIGHT = 3;
/** Each day an answered question's weight keeps 85% of its distance from 1. */
const DRIFT = 0.85;
const SIT_OUT_ROUNDS = 2;
/** Days a level waits before a right answer can move it up, by level. */
const WAIT_DAYS = [0, 1, 2, 4, 8, 16] as const;
const MASTERED_LEVEL = 5;
/** Self-graded flashcards stop here, because "yes, got it" is less reliable than a checked answer. */
const SELF_GRADED_TOP_LEVEL = 3;

type ProgressIdentity = Pick<QuestionProgress, 'questionId' | 'deckId'>;

/** A stable number for the local calendar day, so clock changes don't shift it. */
export function dayNumber(time: number): number {
  const date = new Date(time);
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** The question's draw weight today. A question never answered weighs the most. */
export function weightOf(progress: QuestionProgress | undefined, today: number): number {
  if (!progress) return NEW_WEIGHT;
  // A clock set back shouldn't push a weight past its just-answered value.
  const elapsedDays = Math.max(0, today - progress.answeredDay);
  return 1 + (progress.weightAfter - 1) * DRIFT ** elapsedDays;
}

/**
 * True while a right answer rests, which lasts the deck's next two rounds.
 * `completedRounds` is the deck's count before this quiz.
 */
function isSittingOut(progress: QuestionProgress | undefined, completedRounds: number): boolean {
  return progress?.rightRound != null && completedRounds - progress.rightRound < SIT_OUT_ROUNDS;
}

function nextLevel(level: MasteryLevel, top: MasteryLevel): MasteryLevel {
  return level >= top ? level : ((level + 1) as MasteryLevel);
}

function previousLevel(level: MasteryLevel): MasteryLevel {
  return Math.max(level - 1, 1) as MasteryLevel;
}

/**
 * The new progress after one answer. A first right answer starts at level 2.
 * Later, a right answer moves up one level once the level's wait is over, and
 * a miss drops one level, never below 1 and at most once a day. A self-graded
 * answer, from a flashcard, counts like any other but never climbs past level 3.
 */
export function applyAnswer(
  progress: QuestionProgress | undefined,
  identity: ProgressIdentity,
  correct: boolean,
  today: number,
  round: number,
  selfGraded = false,
): QuestionProgress {
  const top: MasteryLevel = selfGraded ? SELF_GRADED_TOP_LEVEL : MASTERED_LEVEL;
  let level: MasteryLevel;
  let promotionDay: number;
  let dropDay = progress?.dropDay ?? null;

  if (!progress) {
    level = correct ? 2 : 1;
    promotionDay = today + WAIT_DAYS[level];
  } else if (correct) {
    if (today >= progress.promotionDay) {
      level = nextLevel(progress.level, top);
      promotionDay = today + WAIT_DAYS[level];
    } else {
      level = progress.level;
      promotionDay = progress.promotionDay;
    }
  } else {
    level = progress.dropDay === today ? progress.level : previousLevel(progress.level);
    dropDay = today;
    promotionDay = today + WAIT_DAYS[level];
  }

  return {
    ...identity,
    level,
    promotionDay,
    weightAfter: correct ? RIGHT_WEIGHT : MISS_WEIGHT,
    answeredDay: today,
    rightRound: correct ? round : null,
    dropDay,
    seen: (progress?.seen ?? 0) + 1,
    right: (progress?.right ?? 0) + (correct ? 1 : 0),
  };
}

/**
 * Picks up to `count` of a deck's questions for a quiz, in random order.
 * Questions answered right in the deck's last two rounds sit out. The rest are
 * drawn by weight without replacement, so new and missed questions come up
 * more often. When too few are left, as in a small deck or a narrow filter,
 * the resting questions answered right longest ago fill the quiz.
 */
export function pickQuestions<T extends { id: string }>(
  questions: readonly T[],
  count: number,
  progress: DeckProgress,
  today: number,
  random: Random,
): T[] {
  const records = new Map(progress.records.map((record) => [record.questionId, record]));
  const drawn: { question: T; key: number }[] = [];
  const resting: T[] = [];
  for (const question of questions) {
    const record = records.get(question.id);
    if (isSittingOut(record, progress.rounds)) resting.push(question);
    // Taking the highest keys is a weighted draw without replacement, the method of Efraimidis and Spirakis.
    else drawn.push({ question, key: random() ** (1 / weightOf(record, today)) });
  }
  drawn.sort((a, b) => b.key - a.key);
  const rightRound = (question: T) => records.get(question.id)?.rightRound ?? 0;
  resting.sort((a, b) => rightRound(a) - rightRound(b));
  return shuffle([...drawn.map(({ question }) => question), ...resting].slice(0, count), random);
}

/** How many of these records are at the top level. */
export function countMastered(records: readonly QuestionProgress[]): number {
  return records.filter((record) => record.level === MASTERED_LEVEL).length;
}

/** What a question is matched on when its deck is replaced: its type and wording. */
interface Matchable {
  id: string;
  type: string;
  prompt: string;
}

function matchKey(question: Matchable): string {
  return `${question.type}\n${question.prompt.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/**
 * Moves progress to a replaced deck's new questions. Old and new questions
 * match one to one, in order, by type plus wording (case and spacing aside),
 * so duplicates pair up in turn. Unmatched questions start fresh.
 */
export function carryProgress(
  oldQuestions: readonly Matchable[],
  oldProgress: readonly QuestionProgress[],
  newQuestions: readonly Matchable[],
): QuestionProgress[] {
  const progressById = new Map(oldProgress.map((record) => [record.questionId, record]));
  const oldIdsByKey = new Map<string, string[]>();
  for (const question of oldQuestions) {
    const key = matchKey(question);
    oldIdsByKey.set(key, [...(oldIdsByKey.get(key) ?? []), question.id]);
  }
  const carried: QuestionProgress[] = [];
  for (const question of newQuestions) {
    const oldId = oldIdsByKey.get(matchKey(question))?.shift();
    const record = oldId === undefined ? undefined : progressById.get(oldId);
    if (record) carried.push({ ...record, questionId: question.id });
  }
  return carried;
}
