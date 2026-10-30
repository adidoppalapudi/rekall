# Enyalië

**A simple, local-first app for making flashcards and playing quick quizzes.**

[Open Enyalië](https://adidoppalapudi.github.io/enyalie/) · No account needed.

## Get started

1. Open Enyalië and choose **browse starter decks** to find a deck, or create your own.
2. Open a deck and choose the question types, difficulty, quiz length, and timer.
3. Answer questions, see your score, and retry the ones you missed.

Each deck remembers how you did. A question you miss comes back sooner, and one you get right sits out the deck's next two quizzes. Right answers spread over about two weeks master a question, and the deck screen counts how many you've mastered. Flashcards you grade yourself never count as mastered. Quick play stays random.

## Your decks stay yours

Decks are saved in this browser on this device. Enyalië needs no account or server, and works offline after you have opened it once. To back up your decks and progress or move them to another device, choose **export all decks** at the bottom of the library, then import that file on the other device. A deck that is already there can be replaced, kept alongside the new copy, or skipped. A kept copy starts with no progress. To export a single deck without your progress, use its **more** menu.

## Make or import a deck

Create decks and questions in the app, or import one or more `.enyalie.json` deck files. You can also write a deck file yourself or have an AI draft one. Each imported file can be up to 20 MB.

Enyalië supports multiple-choice, true/false, and flashcard questions. Multiple-choice questions have 2–4 choices and a zero-based `correctIndex`; true/false and flashcards use an `answer` field.

```json
{
  "format": "enyalie-deck",
  "version": 1,
  "deck": { "name": "AWS Basics", "description": "Core services" },
  "questions": [
    {
      "type": "multiple_choice",
      "prompt": "Which service stores objects?",
      "choices": ["EC2", "S3", "RDS", "Lambda"],
      "correctIndex": 1,
      "tags": ["storage"],
      "explanation": "S3 is object storage."
    },
    { "type": "true_false", "prompt": "S3 stores objects.", "answer": true },
    { "type": "flashcard", "prompt": "What does IAM stand for?", "answer": "Identity and Access Management" }
  ]
}
```

Deck files in [`src/starter-decks/`](src/starter-decks/) are ready-to-use examples.

## Run Enyalië on your computer

Install [Node.js 20.19+ or 22.12+](https://nodejs.org/), then:

```bash
npm install
npm run dev
```

To build and check the app:

```bash
npm run typecheck
npm test
npm run build
```

## More

- On a phone, use **Add to Home Screen** (iPhone) or **Install app** (Android) from the live site.
- On a computer, the bottom action bar shows keyboard shortcuts; on a phone, it shows touch buttons.
- See [`src/`](src/) for the app and [`tests/`](tests/) for its tests.
- Enyalië is licensed under the [MIT License](LICENSE).
