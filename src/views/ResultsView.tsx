import { useEffect, useMemo, useRef, useState } from 'react';
import { sourceRoute, useQuiz } from '../app/QuizContext';
import { navigate } from '../app/router';
import { useStatus } from '../app/StatusContext';
import { BlockNumber } from '../components/BlockNumber';
import { Box } from '../components/Box';
import type { KeyAction } from '../components/KeyBar';
import { Link } from '../components/Link';
import { Meter } from '../components/Meter';
import { Notice } from '../components/Notice';
import { QuestionMeta } from '../components/QuestionMeta';
import { Screen } from '../components/Screen';
import { store } from '../db';
import { errorMessage } from '../lib/errors';
import { formatScore, plural, slugify } from '../lib/format';
import { correctAnswerText, responseText, verdict } from '../quiz/describe';
import { buildQuizItems, createSession, isFinished, mistakesSession, replaySession, summarize } from '../quiz/engine';
import { recordResult } from '../quiz/personalBests';

export function ResultsView() {
  const quiz = useQuiz();
  const { session } = quiz;
  const { notify } = useStatus();
  const [starting, setStarting] = useState(false);
  const pending = useRef(false);
  // Recording is safe to repeat for the same quiz, so it can run while rendering.
  const newBests = useMemo(() => (session && isFinished(session) ? recordResult(session) : []), [session]);

  // Mastery counts each quiz once, so a reload or a second effect run changes nothing.
  useEffect(() => {
    if (!session || !isFinished(session)) return;
    store
      .recordQuiz(session)
      .catch((failure) => notify(`Couldn't save your progress: ${errorMessage(failure)}`, 'error'));
  }, [session, notify]);

  useEffect(
    () => () => {
      pending.current = false;
    },
    [],
  );

  if (!session || !isFinished(session)) {
    return (
      <Screen path={['quiz', 'results']} title="Results">
        <Notice title="No results to show.">
          <p>
            Finish a quiz to see your score here. <Link to={{ name: 'library' }}>Go to the library</Link>
          </p>
        </Notice>
      </Screen>
    );
  }

  const summary = summarize(session);
  const source = sourceRoute(session);
  const mistakeCount = summary.mistakes.length;

  const newQuiz = async () => {
    if (pending.current) return;
    pending.current = true;
    setStarting(true);
    try {
      const [questions, decks, progress] =
        session.source.kind === 'deck'
          ? await Promise.all([
              store.listQuestions(session.source.deckId),
              store.getDeck(session.source.deckId).then((deck) => (deck ? [deck] : [])),
              store.loadProgress(session.source.deckId),
            ])
          : await Promise.all([store.listAllQuestions(), store.listDecks(), undefined]);
      if (!pending.current) return;
      if (session.source.kind === 'deck' && decks.length === 0) {
        notify('This deck no longer exists.', 'info');
        return;
      }
      const items = buildQuizItems(questions, session.settings, { progress });
      if (items.length === 0) {
        notify('No questions match these quiz settings.', 'info');
        return;
      }
      quiz.start(
        createSession({
          title: session.source.kind === 'deck' ? decks[0].name : 'quick play',
          source: session.source,
          settings: session.settings,
          items,
          deckNames: Object.fromEntries(decks.map((deck) => [deck.id, deck.name])),
        }),
      );
      navigate({ name: 'quiz' }, { replace: true });
    } catch (failure) {
      if (pending.current) notify(`Couldn't start a new quiz: ${errorMessage(failure)}`, 'error');
    } finally {
      if (pending.current) {
        pending.current = false;
        setStarting(false);
      }
    }
  };

  const replay = () => {
    quiz.start(replaySession(session));
    navigate({ name: 'quiz' }, { replace: true });
  };
  const retryMistakes = () => {
    const retry = mistakesSession(session);
    if (!retry) return;
    quiz.start(retry);
    navigate({ name: 'quiz' }, { replace: true });
  };

  const actions: KeyAction[] = [
    { label: 'new quiz', hotkey: 'n', onAction: newQuiz, disabled: starting, primary: true },
    { label: 'retry as is', hotkey: 'r', onAction: replay, disabled: starting },
    ...(mistakeCount > 0
      ? [{ label: `retry ${plural(mistakeCount, 'mistake')}`, hotkey: 'm', onAction: retryMistakes, disabled: starting }]
      : []),
    {
      label: 'exit',
      hotkey: 'escape',
      keyLabel: 'Esc',
      onAction: () => navigate(source, { replace: true }),
      disabled: starting,
    },
  ];

  const score = formatScore(summary.score);

  return (
    <Screen
      path={['quiz', slugify(session.title) || 'quiz', 'results']}
      title={`Results – ${session.title}`}
      actions={actions}
    >
      <div className="view-head">
        <h1>results</h1>
        <p className="dim">
          {session.title}
          {session.retry ? ' (mistakes round)' : ''}
        </p>
      </div>

      <section className="scoreboard" aria-label="Score">
        <BlockNumber text={score} label={`${score} points`} />
        <p className="score-caption">points</p>
        {newBests.length > 0 && (
          <p className="new-best">
            new best at {session.settings.count}: {newBests.join(', ')}
          </p>
        )}
      </section>

      <dl className="stats">
        <dt>correct</dt>
        <dd>
          {summary.correct} of {summary.total}
        </dd>
        <dt>incorrect</dt>
        <dd>{summary.incorrect}</dd>
        <dt>accuracy</dt>
        <dd>
          {summary.accuracy}%{' '}
          <Meter
            value={summary.correct}
            max={summary.total}
            tone="accuracy"
            label={`${summary.accuracy} percent correct`}
          />
        </dd>
        <dt>best streak</dt>
        <dd>{summary.bestStreak}</dd>
      </dl>

      <p className="verdict-line">{verdict(summary.accuracy)}</p>

      {mistakeCount === 0 ? (
        <p className="dim">No mistakes to review.</p>
      ) : (
        <Box title={`review mistakes (${mistakeCount})`} className="mistakes">
          <ol className="mistake-list">
            {summary.mistakes.map(({ item, answer }) => {
              const { question } = item;
              return (
                <li key={question.id} className="mistake">
                  <p className="mistake-prompt">{question.prompt}</p>
                  <dl className="mistake-answers">
                    <dt>you said</dt>
                    <dd className="is-wrong">{responseText(question, answer.response)}</dd>
                    <dt>answer</dt>
                    <dd className="is-correct">{correctAnswerText(question)}</dd>
                  </dl>
                  {question.explanation && <p className="explanation">{question.explanation}</p>}
                  <div className="mistake-foot">
                    <QuestionMeta
                      question={question}
                      deckName={session.source.kind === 'quick' ? session.deckNames[question.deckId] : undefined}
                    />
                    <Link
                      to={{ name: 'editQuestion', deckId: question.deckId, questionId: question.id }}
                      className="edit-link"
                    >
                      edit question
                    </Link>
                  </div>
                </li>
              );
            })}
          </ol>
        </Box>
      )}
    </Screen>
  );
}
