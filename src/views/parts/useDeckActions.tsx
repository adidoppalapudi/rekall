import { useState, type ReactNode } from 'react';
import { useStatus } from '../../app/StatusContext';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DeckFormDialog } from '../../components/DeckFormDialog';
import { store } from '../../db';
import { createDeckFile, createDecksFile, deckFileName, decksFileName, serializeDeckFile } from '../../io/deckFile';
import { downloadTextFile } from '../../io/files';
import { errorMessage } from '../../lib/errors';
import { plural } from '../../lib/format';
import type { Deck } from '../../models/types';

interface DeckActionCallbacks {
  onEdited?: (deck: Deck) => void;
  onDuplicated?: (copy: Deck) => void;
  onDeleted?: (deck: Deck) => void;
}

/**
 * Edit, duplicate, export and delete for a deck, shared by the library and
 * the deck screen. Also exports every deck with its progress to one file,
 * which is the backup. Render the returned `dialogs` somewhere in the screen.
 */
export function useDeckActions(callbacks: DeckActionCallbacks) {
  const { notify } = useStatus();
  const [editing, setEditing] = useState<Deck | null>(null);
  const [deleting, setDeleting] = useState<{ deck: Deck; questionCount: number } | null>(null);

  async function exportDeck(deck: Deck) {
    try {
      const questions = await store.listQuestions(deck.id);
      downloadTextFile(deckFileName(deck.name), serializeDeckFile(createDeckFile(deck, questions)));
      notify(`Exported "${deck.name}" (${plural(questions.length, 'question')}).`, 'ok');
    } catch (error) {
      notify(`Couldn't export: ${errorMessage(error)}`, 'error');
    }
  }

  async function exportAllDecks(decks: readonly Deck[]) {
    try {
      const entries = await Promise.all(
        decks.map(async (deck) => {
          const [questions, progress] = await Promise.all([store.listQuestions(deck.id), store.loadProgress(deck.id)]);
          return { deck, questions, progress };
        }),
      );
      downloadTextFile(decksFileName(), serializeDeckFile(createDecksFile(entries)));
      const questionCount = entries.reduce((sum, entry) => sum + entry.questions.length, 0);
      notify(`Exported ${plural(entries.length, 'deck')} (${plural(questionCount, 'question')}) to one file.`, 'ok');
    } catch (error) {
      notify(`Couldn't export: ${errorMessage(error)}`, 'error');
    }
  }

  async function duplicateDeck(deck: Deck) {
    try {
      const copy = await store.duplicateDeck(deck.id);
      notify(`Created "${copy.name}".`, 'ok');
      callbacks.onDuplicated?.(copy);
    } catch (error) {
      notify(`Couldn't duplicate: ${errorMessage(error)}`, 'error');
    }
  }

  const dialogs: ReactNode = (
    <>
      {editing && (
        <DeckFormDialog
          title="edit deck"
          submitLabel="save"
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={async (input) => {
            const updated = await store.updateDeck(editing.id, input);
            setEditing(null);
            notify('Saved deck details.', 'ok');
            callbacks.onEdited?.(updated);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="delete deck"
          confirmLabel="delete deck"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await store.deleteDeck(deleting.deck.id);
            setDeleting(null);
            notify(`Deleted "${deleting.deck.name}".`, 'ok');
            callbacks.onDeleted?.(deleting.deck);
          }}
        >
          <p>
            Delete "{deleting.deck.name}" and its {plural(deleting.questionCount, 'question')}? This can't be undone, so
            export the deck first if you might want it back.
          </p>
        </ConfirmDialog>
      )}
    </>
  );

  return {
    exportDeck,
    exportAllDecks,
    duplicateDeck,
    editDeck: (deck: Deck) => setEditing(deck),
    deleteDeck: (deck: Deck, questionCount: number) => setDeleting({ deck, questionCount }),
    dialogs,
  };
}
