import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { sourceRoute, useQuiz } from '../app/QuizContext';
import { goBack, navigate } from '../app/router';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { KeyAction } from '../components/KeyBar';
import { Link } from '../components/Link';
import { Meter } from '../components/Meter';
import { Notice } from '../components/Notice';
import { QuestionMeta } from '../components/QuestionMeta';
import { Screen, scrollScreenToTop } from '../components/Screen';
import { useHotkeys, type Hotkeys } from '../hooks/useHotkeys';
import { formatScore, slugify } from '../lib/format';
import type { Question } from '../models/types';
import { correctAnswerText } from '../quiz/describe';
import {
  currentAnswer,
  currentItem,
  deadline,
  isFinished,
  isLastItem,
  type AnswerRecord,
  type QuizItem,
  type QuizResponse,
} from '../quiz/engine';

type MultipleChoiceQuestion = Extract<Question, { type: 'multiple_choice' }>;
type TrueFalseQuestion = Extract<Question, { type: 'true_false' }>;
type FlashcardQuestion = Extract<Question, { type: 'flashcard' }>;

export function QuizView() {
  const quiz = useQuiz();
  const { session } = quiz;
  const [confirmQuit, setConfirmQuit] = useState(false);
  const finished = session !== null && isFinished(session);
  const { answer: submit } = quiz;
  const timeOut = useCallback(() => submit({ type: 'timeout' }), [submit]);

  // Finishing the last question lands here; swap the quiz screen for results.
  useEffect(() => {
    if (finished) navigate({ name: 'results' }, { replace: true });
  }, [finished]);

  // Quitting forgets the quiz only once we've left this screen, so it doesn't
  // flash "no quiz in progress" on the way out.
  const quitting = useRef(false);
  const endQuiz = quiz.end;
  useEffect(
    () => () => {
      if (quitting.current) endQuiz();
    },
    [endQuiz],
  );

  if (!session) {
    return (
      <Screen path={['quiz']} title="Quiz">
        <Notice title="No quiz in progress.">
          <p>
            Open a deck from the <Link to={{ name: 'library' }}>library</Link> and start a quiz, or use quick play.
          </p>
        </Notice>
      </Screen>
    );
  }
  if (finished) return null;

  const item = currentItem(session);
  const answer = currentAnswer(session);
  const total = session.items.length;
  const answeredCount = session.answers.filter((record) => record !== null).length;
  const timeUp = deadline(session);
  const revealed = session.revealedAt != null;

  const quit = () => {
    setConfirmQuit(false);
    quitting.current = true;
    goBack(sourceRoute(session));
  };
  const requestQuit = () => (answeredCount === 0 ? quit() : setConfirmQuit(true));

  const actions: KeyAction[] = [];
  if (answer) {
    actions.push({
      label: isLastItem(session) ? 'see results' : 'next question',
      hotkey: 'enter',
      alsoKeys: ['space'],
      keyLabel: 'Enter',
      onAction: quiz.next,
      primary: true,
    });
  }
  actions.push({ label: 'quit', hotkey: 'escape', keyLabel: 'Esc', onAction: requestQuit });

  return (
    <Screen path={['quiz', slugify(session.title) || 'quiz']} title={`Quiz – ${session.title}`} actions={actions}>
      <div className="quiz-layout">
        <div className="quiz-head">
          <h1 className="quiz-title">
            {session.title}
            {session.retry && <span className="dim"> (mistakes round)</span>}
          </h1>
          <p className="quiz-status">
            <span>
              question {session.current + 1} of {total}
            </span>
            <Meter value={answeredCount} max={total} label={`${answeredCount} of ${total} answered`} />
            <span>
              score <strong className="score-value">{formatScore(session.score)}</strong>
            </span>
            <span className={session.streak >= 2 ? 'streak is-hot' : 'streak'}>streak {session.streak}</span>
            {timeUp !== null && (
              <Countdown
                key={`${session.id}-${session.current}`}
                deadline={timeUp}
                seconds={session.settings.timer as number}
                running={!answer && !revealed}
                onTimeout={timeOut}
              />
            )}
          </p>
        </div>

        <QuestionCard
          key={`${session.id}-${session.current}`}
          item={item}
          answer={answer}
          revealed={revealed}
          deckName={session.source.kind === 'quick' ? session.deckNames[item.question.deckId] : undefined}
          onAnswer={quiz.answer}
          onReveal={quiz.reveal}
          onRate={quiz.answerAndNext}
        />
      </div>

      {confirmQuit && (
        <ConfirmDialog
          title="quit quiz"
          confirmLabel="quit quiz"
          onCancel={() => setConfirmQuit(false)}
          onConfirm={quit}
        >
          <p>
            Stop this quiz? You've answered {answeredCount} of {total} questions, and this round won't be kept.
          </p>
        </ConfirmDialog>
      )}
    </Screen>
  );
}

/** Time left on a timed question, as a draining bar. Calls `onTimeout` at zero. */
function Countdown({
  deadline,
  seconds,
  running,
  onTimeout,
}: {
  deadline: number;
  seconds: number;
  /** False once answered or revealed, which freezes the bar. */
  running: boolean;
  onTimeout: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= deadline) onTimeout();
    }, 250);
    return () => clearInterval(timer);
  }, [running, deadline, onTimeout]);

  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <span className={running && left <= 3 ? 'timer is-low' : 'timer'}>
      time <Meter value={deadline - now} max={seconds * 1000} label={`${left} seconds left`} tone="timer" />{' '}
      <strong className="timer-value">{left}s</strong>
    </span>
  );
}

interface QuestionCardProps {
  item: QuizItem;
  answer: AnswerRecord | null;
  revealed: boolean;
  deckName?: string;
  onAnswer: (response: QuizResponse) => void;
  onReveal: () => void;
  /** Flashcards: record how it went and move straight on. */
  onRate: (response: QuizResponse) => void;
}

function QuestionCard({ item, answer, revealed, deckName, onAnswer, onReveal, onRate }: QuestionCardProps) {
  const promptId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const { question } = item;

  // Each new question starts at the top of the page and takes focus, so
  // screen readers read it out and Tab starts from the answers.
  useEffect(() => {
    scrollScreenToTop();
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <article className="question-card" ref={cardRef} tabIndex={-1} aria-labelledby={promptId}>
      <QuestionMeta question={question} deckName={deckName} />
      <p className="prompt" id={promptId}>
        {question.prompt}
      </p>

      {question.type === 'multiple_choice' && (
        <MultipleChoiceAnswers item={item} question={question} answer={answer} onAnswer={onAnswer} />
      )}
      {question.type === 'true_false' && <TrueFalseAnswers question={question} answer={answer} onAnswer={onAnswer} />}
      {/* A flashcard only has an answer here if it ran out of time; ratings move straight on. */}
      {question.type === 'flashcard' && !answer && (
        <FlashcardAnswer question={question} revealed={revealed} onReveal={onReveal} onRate={onRate} />
      )}

      <div className="feedback" aria-live="polite">
        {answer && <Feedback question={question} answer={answer} />}
      </div>
    </article>
  );
}

function answerState(isCorrectOption: boolean, isChosen: boolean, answered: boolean): string {
  if (!answered) return 'answer';
  if (isCorrectOption) return 'answer is-correct';
  if (isChosen) return 'answer is-wrong';
  return 'answer is-muted';
}

function AnswerMark({
  isCorrectOption,
  isChosen,
  answered,
}: {
  isCorrectOption: boolean;
  isChosen: boolean;
  answered: boolean;
}) {
  if (!answered) return null;
  if (isCorrectOption)
    return (
      <span className="answer-mark">
        ✓<span className="sr-only"> correct answer</span>
      </span>
    );
  if (isChosen)
    return (
      <span className="answer-mark">
        ✗<span className="sr-only"> your answer</span>
      </span>
    );
  return null;
}

const LETTER_KEYS = ['a', 'b', 'c', 'd'];

function MultipleChoiceAnswers({
  item,
  question,
  answer,
  onAnswer,
}: {
  item: QuizItem;
  question: MultipleChoiceQuestion;
  answer: AnswerRecord | null;
  onAnswer: (response: QuizResponse) => void;
}) {
  const chosen = answer?.response.type === 'multiple_choice' ? answer.response.choice : null;
  const hotkeys: Hotkeys = {};
  if (!answer) {
    item.choiceOrder.forEach((choice, position) => {
      const pick = () => onAnswer({ type: 'multiple_choice', choice });
      hotkeys[String(position + 1)] = pick;
      hotkeys[LETTER_KEYS[position]] = pick;
    });
  }
  useHotkeys(hotkeys);

  return (
    <ol className="answers">
      {item.choiceOrder.map((choice, position) => {
        const isCorrectOption = choice === question.correctIndex;
        const isChosen = choice === chosen;
        return (
          <li key={choice}>
            <button
              type="button"
              className={answerState(isCorrectOption, isChosen, answer !== null)}
              disabled={answer !== null}
              onClick={() => onAnswer({ type: 'multiple_choice', choice })}
            >
              <kbd className="answer-key">{position + 1}</kbd>{' '}
              <span className="answer-text">{question.choices[choice]}</span>
              <AnswerMark isCorrectOption={isCorrectOption} isChosen={isChosen} answered={answer !== null} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function TrueFalseAnswers({
  question,
  answer,
  onAnswer,
}: {
  question: TrueFalseQuestion;
  answer: AnswerRecord | null;
  onAnswer: (response: QuizResponse) => void;
}) {
  const chosen = answer?.response.type === 'true_false' ? answer.response.answer : null;
  const pick = (value: boolean) => () => onAnswer({ type: 'true_false', answer: value });
  useHotkeys(answer ? {} : { t: pick(true), '1': pick(true), f: pick(false), '2': pick(false) });

  return (
    <ol className="answers answers-tf">
      {[true, false].map((value) => {
        const isCorrectOption = value === question.answer;
        const isChosen = value === chosen;
        return (
          <li key={String(value)}>
            <button
              type="button"
              className={answerState(isCorrectOption, isChosen, answer !== null)}
              disabled={answer !== null}
              onClick={pick(value)}
            >
              <kbd className="answer-key">{value ? 'T' : 'F'}</kbd>{' '}
              <span className="answer-text">{value ? 'true' : 'false'}</span>
              <AnswerMark isCorrectOption={isCorrectOption} isChosen={isChosen} answered={answer !== null} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function FlashcardAnswer({
  question,
  revealed,
  onReveal,
  onRate,
}: {
  question: FlashcardQuestion;
  revealed: boolean;
  onReveal: () => void;
  onRate: (response: QuizResponse) => void;
}) {
  const rate = (recalled: boolean) => () => onRate({ type: 'flashcard', recalled });
  useHotkeys(
    revealed
      ? { y: rate(true), '1': rate(true), n: rate(false), '2': rate(false) }
      : { space: onReveal, enter: onReveal },
  );

  if (!revealed) {
    return (
      <button type="button" className="answer reveal" onClick={onReveal}>
        <kbd className="answer-key">Space</kbd> <span className="answer-text">show the answer</span>
      </button>
    );
  }

  return (
    <div className="card-back">
      <p className="card-answer">{question.answer}</p>
      {question.explanation && <p className="explanation">{question.explanation}</p>}
      <p className="rate-prompt">Did you remember it?</p>
      <div className="answers answers-rate">
        <button type="button" className="answer rate-yes" onClick={rate(true)}>
          <kbd className="answer-key">Y</kbd> <span className="answer-text">yes, got it</span>
        </button>
        <button type="button" className="answer rate-no" onClick={rate(false)}>
          <kbd className="answer-key">N</kbd> <span className="answer-text">no, missed it</span>
        </button>
      </div>
    </div>
  );
}

function Feedback({ question, answer }: { question: Question; answer: AnswerRecord }) {
  const { parts } = answer;
  // Only show where the points came from when a bonus was earned.
  const showParts = parts !== undefined && (parts.streak > 0 || parts.speed > 0);
  return (
    <>
      {answer.correct ? (
        <>
          <p className="verdict is-correct">
            ✓ correct <span className="points">+{answer.points}</span>
          </p>
          {showParts && (
            <p className="chips">
              <span className="chip">+{parts.answer}</span>
              {parts.streak > 0 && <span className="chip chip-streak">streak +{parts.streak}</span>}
              {parts.speed > 0 && <span className="chip chip-speed">speed +{parts.speed}</span>}
            </p>
          )}
        </>
      ) : (
        <p className="verdict is-wrong">
          ✗ {answer.response.type === 'timeout' ? 'out of time' : 'incorrect'}. Answer:{' '}
          <strong>{correctAnswerText(question)}</strong>
        </p>
      )}
      {question.explanation && <p className="explanation">{question.explanation}</p>}
    </>
  );
}
