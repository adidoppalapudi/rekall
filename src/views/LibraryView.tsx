import { useRef, useState, type ReactNode } from 'react';
import { useQuiz } from '../app/QuizContext';
import { navigate } from '../app/router';
import { useStatus } from '../app/StatusContext';
import { DeckFormDialog } from '../components/DeckFormDialog';
import { DeckFilters } from '../components/DeckFilters';
import type { KeyAction } from '../components/KeyBar';
import { Link } from '../components/Link';
import { Notice } from '../components/Notice';
import { Screen } from '../components/Screen';
import { store } from '../db';
import { useAsync } from '../hooks/useAsync';
import { errorMessage } from '../lib/errors';
import { deckCategory, filterDecks } from '../lib/deckCatalog';
import { formatDate, plural } from '../lib/format';
import { cyclePalette } from '../lib/palette';
import { requestPersistentStorage } from '../lib/storage';
import { loadStarterDeck } from '../io/starterDecks';
import { DEFAULT_SETTINGS, QUICK_PLAY_SETTINGS, buildQuizItems, createSession } from '../quiz/engine';
import { StarterDecksDialog } from './parts/StarterDecksDialog';
import { useDeckActions } from './parts/useDeckActions';
import { useDeckImport } from './parts/useDeckImport';

/** One tap on an empty library adds one of these starter decks and starts a quiz from it. */
const STARTER_QUIZZES = [
  { file: 'world-geography', label: 'play world geography' },
  { file: 'trivia-easy', label: 'play anything goes' },
  { file: 'trivia-hard', label: 'play deep cuts' },
];

export function LibraryView() {
  const quiz = useQuiz();
  const { notify } = useStatus();
  const { data: decks, error, loading, reload } = useAsync(() => store.listDecks(), []);
  const [creating, setCreating] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [browsingStarters, setBrowsingStarters] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [startingStarter, setStartingStarter] = useState(false);
  const starting = useRef(false);

  const deckActions = useDeckActions({ onEdited: reload, onDuplicated: reload, onDeleted: reload });
  const importer = useDeckImport({
    onImported: (deck) => navigate({ name: 'deck', deckId: deck.id }),
    onLibraryChanged: reload,
  });

  const totalQuestions = decks?.reduce((sum, deck) => sum + deck.questionCount, 0) ?? 0;
  const shown = filterDecks(decks ?? [], query, category);

  async function startQuickPlay() {
    try {
      const questions = await store.listAllQuestions();
      if (questions.length === 0) {
        notify('Quick play needs at least one question in a deck.', 'info');
        return;
      }
      quiz.start(
        createSession({
          title: 'quick play',
          source: { kind: 'quick' },
          settings: QUICK_PLAY_SETTINGS,
          items: buildQuizItems(questions, QUICK_PLAY_SETTINGS),
          deckNames: Object.fromEntries((decks ?? []).map((deck) => [deck.id, deck.name])),
        }),
      );
      navigate({ name: 'quiz' });
    } catch (failure) {
      notify(`Couldn't start quick play: ${errorMessage(failure)}`, 'error');
    }
  }

  /** Adds a starter deck to the empty library and starts a 10-question quiz from it. */
  async function playStarter(file: string) {
    if (starting.current) return;
    starting.current = true;
    setStartingStarter(true);
    try {
      const deck = await store.importDeck(await loadStarterDeck(file), { asNewDeck: false });
      requestPersistentStorage();
      const questions = await store.listQuestions(deck.id);
      quiz.start(
        createSession({
          title: deck.name,
          source: { kind: 'deck', deckId: deck.id },
          settings: DEFAULT_SETTINGS,
          items: buildQuizItems(questions, DEFAULT_SETTINGS),
          deckNames: { [deck.id]: deck.name },
        }),
      );
      navigate({ name: 'quiz' });
    } catch (failure) {
      notify(`Couldn't start the quiz: ${errorMessage(failure)}`, 'error');
      reload();
    } finally {
      starting.current = false;
      setStartingStarter(false);
    }
  }

  // On an empty library, quick play starts the first starter quiz instead.
  const emptyLibrary = decks?.length === 0;

  const actions: KeyAction[] = [
    { label: 'new deck', hotkey: 'n', onAction: () => setCreating(true) },
    { label: 'import', hotkey: 'i', onAction: importer.chooseFile },
    { label: 'colors', hotkey: 'c', onAction: () => notify(`Switched to the ${cyclePalette()} palette.`, 'info') },
    {
      label: 'quick play',
      hotkey: 'q',
      onAction: emptyLibrary ? () => playStarter(STARTER_QUIZZES[0].file) : startQuickPlay,
      disabled: emptyLibrary ? startingStarter : totalQuestions === 0,
      primary: true,
    },
  ];

  let body: ReactNode;
  let footer: ReactNode = null;
  if (error && !decks) {
    body = (
      <Notice title="Couldn't open your decks." tone="error">
        <p>{errorMessage(error)}</p>
        <p>Enyalië stores decks in this browser. Private browsing or blocked site data can stop that from working.</p>
        <button type="button" className="btn" onClick={reload}>
          try again
        </button>
      </Notice>
    );
  } else if (!decks) {
    body = <p className="dim">{loading ? 'loading decks…' : ''}</p>;
  } else if (decks.length === 0) {
    body = (
      <Notice title="No decks yet.">
        <p>Try a few starter quizzes:</p>
        <p className="button-row">
          {STARTER_QUIZZES.map(({ file, label }) => (
            <button
              key={file}
              type="button"
              className="btn btn-primary"
              disabled={startingStarter}
              onClick={() => playStarter(file)}
            >
              {label}
            </button>
          ))}
        </p>
        <p>Browse the starter decks, or create or import your own.</p>
        <p className="button-row">
          <button type="button" className="btn" onClick={() => setBrowsingStarters(true)}>
            starter decks
          </button>
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            new deck
          </button>
          <button type="button" className="btn" onClick={importer.chooseFile}>
            import deck files
          </button>
        </p>
      </Notice>
    );
  } else {
    body = (
      <ul className="deck-list">
        {shown.map((deck) => {
          const menuOpen = openMenu === deck.id;
          return (
            <li key={deck.id} className="deck-row">
              <Link to={{ name: 'deck', deckId: deck.id }} className="deck-link">
                <span className="deck-name">{deck.name}</span>
                {deck.description && <span className="deck-description">{deck.description}</span>}
                <span className="deck-meta">
                  {deckCategory(deck.id)} · {plural(deck.questionCount, 'question')}, updated {formatDate(deck.updatedAt)}
                </span>
              </Link>
              <button
                type="button"
                className="btn btn-quiet more-button"
                aria-expanded={menuOpen}
                aria-label={`More actions for ${deck.name}`}
                onClick={() => setOpenMenu(menuOpen ? null : deck.id)}
              >
                {menuOpen ? 'close' : 'more'}
              </button>
              {menuOpen && (
                <div className="row-actions">
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
                    onClick={() => deckActions.deleteDeck(deck, deck.questionCount)}
                  >
                    delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
    footer = (
      <>
        <p className="library-foot button-row">
          <button type="button" className="btn btn-quiet" onClick={() => setBrowsingStarters(true)}>
            browse starter decks
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => deckActions.exportAllDecks(decks)}>
            export all decks
          </button>
        </p>
        <p className="library-definition dim">Enyalië n. “memory, (lit.) recalling”</p>
      </>
    );
  }

  return (
    <Screen path={['decks']} title="Library" actions={actions}>
      <div className="view-head">
        <h1>library</h1>
        {decks && decks.length > 0 && (
          <p className="dim">
            {plural(decks.length, 'deck')}, {plural(totalQuestions, 'question')}
          </p>
        )}
      </div>
      {decks && decks.length > 0 && (
        <>
          <DeckFilters query={query} category={category} onQueryChange={setQuery} onCategoryChange={setCategory} />
          {(query || category) && <p className="dim">{plural(shown.length, 'matching deck')}</p>}
          {shown.length === 0 && <p>No decks match. Try another search or category.</p>}
        </>
      )}
      {body}
      {footer}

      {creating && (
        <DeckFormDialog
          title="new deck"
          submitLabel="create deck"
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            const deck = await store.createDeck(input);
            requestPersistentStorage();
            setCreating(false);
            notify(`Created "${deck.name}". Add your first question.`, 'ok');
            navigate({ name: 'deck', deckId: deck.id });
          }}
        />
      )}
      {browsingStarters && (
        <StarterDecksDialog
          libraryIds={new Set(decks?.map((deck) => deck.id))}
          onClose={() => setBrowsingStarters(false)}
          onAdd={(files) => {
            setBrowsingStarters(false);
            void importer.importFiles(files);
          }}
        />
      )}
      {deckActions.dialogs}
      {importer.dialogs}
      {importer.fileInput}
    </Screen>
  );
}
