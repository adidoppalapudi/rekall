import { describe, expect, it } from 'vitest';
import { deckCategory, filterDecks, isFeaturedDeck } from '../src/lib/deckCatalog';

const decks = [
  { id: 'deck-nature', name: 'Nature', description: 'Animals and habitats' },
  { id: 'deck-oceans-water-bodies', name: 'Oceans & Water Bodies', description: 'Seas, rivers and lakes' },
  { id: 'deck-nba', name: 'NBA', description: 'Basketball history' },
  { id: 'custom-deck', name: 'My study notes', description: 'Things to remember' },
];

describe('deck browsing', () => {
  it('searches names, descriptions and categories without case or surrounding spaces mattering', () => {
    expect(filterDecks(decks, ' NBA ', '').map((deck) => deck.id)).toEqual(['deck-nba']);
    expect(filterDecks(decks, 'HABITATS', '').map((deck) => deck.id)).toEqual(['deck-nature']);
    expect(filterDecks(decks, 'science', '')).toHaveLength(2);
  });

  it('combines the search and category, including an empty result', () => {
    expect(filterDecks(decks, 'rivers', 'Science').map((deck) => deck.id)).toEqual(['deck-oceans-water-bodies']);
    expect(filterDecks(decks, 'rivers', 'Sports')).toEqual([]);
    expect(filterDecks(decks, '', '')).toHaveLength(4);
  });

  it('keeps custom decks discoverable in Other', () => {
    expect(filterDecks(decks, '', 'Other').map((deck) => deck.id)).toEqual(['custom-deck']);
    expect(deckCategory('deck-world-geography')).toBe('Places');
    expect(deckCategory('deck-ap-environmental-science')).toBe('Science');
    expect(deckCategory()).toBe('Other');
  });

  it('uses a fixed selection for Start here, including the easy mixed round', () => {
    expect(isFeaturedDeck('deck-trivia-easy')).toBe(true);
    expect(isFeaturedDeck('deck-fun-chemistry-for-kids')).toBe(true);
    expect(isFeaturedDeck('custom-deck')).toBe(false);
    expect(isFeaturedDeck()).toBe(false);
  });
});
