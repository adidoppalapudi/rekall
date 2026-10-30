import { useState } from 'react';
import { useQuiz } from '../app/QuizContext';
import { navigate } from '../app/router';
import { useStatus } from '../app/StatusContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { KeyAction } from '../components/KeyBar';
import { Link } from '../components/Link';
import { Meter } from '../components/Meter';
import { Notice } from '../components/Notice';
import { Screen } from '../components/Screen';
import { store } from '../db';
import { useAsync } from '../hooks/useAsync';
import { errorMessage } from '../lib/errors';
import { formatDate, plural, slugify } from '../lib/format';
import type { Question } from '../models/types';
import { DEFAULT_SETTINGS, buildQuizItems, createSession, filterQuestions, type QuizSettings } from '../quiz/engine';
import { countMastered } from '../quiz/mastery';
import { bestsFor, describeBest } from '../quiz/personalBests';
import { loadPreferences, savePreferences } from '../quiz/persistence';
import { QuestionList } from './parts/QuestionList';
import { QuizSetup } from './parts/QuizSetup';
import { useDeckActions } from './parts/useDeckActions';

async function loadDeck(deckId: string) {
  const [deck, questions, progress] = await Promise.all([
    store.getDeck(deckId),
    store.listQuestions(deckId),
    store.loadProgress(deckId),
  ]);
  return { deck, questions, progress };
}

export function DeckView({ deckId }: { deckId: string }) {
  const quiz = useQuiz();
  const { notify } = useStatus();
  const { data, error, reload } = useAsync(() => loadDeck(deckId), [deckId]);
  const [settings, setSettings] = useState<QuizSettings>(() => ({ ...DEFAULT_SETTINGS, ...loadPreferences() }));
  const [deleting, setDeleting] = useState<{ question: Question; number: number } | null>(null);

  const deckActions = useDeckActions({
    onEdited: reload,
    onDuplicated: (copy) => navigate({ name: 'deck', deckId: copy.id }),
    onDeleted: () => navigate({ name: 'library' }, { replace: true }),
  });

  const deck = data?.deck;
  const questions = data?.questions ?? [];
  const canStart = filterQuestions(questions, settings).length > 0;

  function changeSettings(next: QuizSettings) {
    setSettings(next);
    savePreferences(next);
  }

  function startQuiz() {
    if (!deck) return;
    const items = buildQuizItems(questions, settings, { progress: data?.progress });
    if (items.length === 0) return;
    quiz.start(
      createSession({
        title: deck.name,
        source: { kind: 'deck', deckId: deck.id },
        settings,
        items,
        deckNames: { [deck.id]: deck.name },
      }),
    );
    navigate({ name: 'quiz' });
  }

  const actions: KeyAction[] = deck
    ? [
        { label: 'start quiz', hotkey: 's', onAction: startQuiz, disabled: !canStart, primary: true },
        { label: 'add question', hotkey: 'a', onAction: () => navigate({ name: 'newQuestion', deckId }) },
        { label: 'library', hotkey: 'escape', keyLabel: 'Esc', onAction: () => navigate({ name: 'library' }) },
      ]
    : [];

  if (!data) {
    return (
      <Screen path={['decks', '…']} title="Deck">
        {error ? (
          <Notice title="Couldn't load this deck." tone="error">
            <p>{errorMessage(error)}</p>
            <button type="button" className="btn" onClick={reload}>
              try again
            </button>
          </Notice>
        ) : (
          <p className="dim">loading deck…</p>
        )}
      </Screen>
    );
  }

  if (!deck) {
    return (
      <Screen path={['decks', 'not-found']} title="Deck not found">
        <Notice title="This deck doesn't exist.">
          <p>It may have been deleted, or the link is from another device.</p>
          <Link to={{ name: 'library' }}>go to the library</Link>
        </Notice>
      </Screen>
    );
  }

  // One line per quiz length, so a short quiz is never compared with a long one.
  const bests = bestsFor({ kind: 'deck', deckId });
  const played = data.progress.records.length > 0;
  const mastered = countMastered(data.progress.records);

  return (
    <Screen path={['decks', slugify(deck.name) || 'deck']} title={deck.name} actions={actions}>
      <div className="view-head">
        <h1>{deck.name}</h1>
        {deck.description && <p className="deck-description-full">{deck.description}</p>}
        <p className="dim">
          {plural(questions.length, 'question')}, updated {formatDate(deck.updatedAt)}
        </p>
        {played && (
          <p className="dim">
            {mastered} of {questions.length} mastered{' '}
            <Meter value={mastered} max={questions.length} label={`${mastered} of ${questions.length} mastered`} />
          </p>
        )}
        {bests.map(({ count, best }) => (
          <p key={count} className="deck-best">
            Best at {count}: {describeBest(best)}
          </p>
        ))}
        <p className="button-row toolbar">
          <button type="button" className="btn" onClick={() => deckActions.editDeck(deck)}>
            edit
          </button>
          <button type="button" className="btn" onClick={() => deckActions.duplicateDeck(deck)}>
            duplicate
          </button>
          <button type="button" className="btn" onClick={() => deckActions.exportDeck(deck)}>
            export
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => deckActions.deleteDeck(deck, questions.length)}
          >
            delete
          </button>
        </p>
      </div>

      {questions.length === 0 ? (
        <Notice title="No questions yet.">
          <p>Add multiple choice, true/false or flashcard questions, then start a quiz.</p>
          <p className="button-row">
            <button type="button" className="btn btn-primary" onClick={() => navigate({ name: 'newQuestion', deckId })}>
              add the first question
            </button>
          </p>
        </Notice>
      ) : (
        <>
          <QuizSetup questions={questions} settings={settings} onChange={changeSettings} />
          <QuestionList
            deckId={deckId}
            questions={questions}
            onDelete={(question, number) => setDeleting({ question, number })}
          />
        </>
      )}

      {deleting && (
        <ConfirmDialog
          title="delete question"
          confirmLabel="delete question"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await store.deleteQuestion(deleting.question.id);
            setDeleting(null);
            notify(`Deleted question ${deleting.number}.`, 'ok');
            reload();
          }}
        >
          <p>Delete this question? This can't be undone.</p>
          <blockquote className="quoted-prompt">{deleting.question.prompt}</blockquote>
        </ConfirmDialog>
      )}
      {deckActions.dialogs}
    </Screen>
  );
}
