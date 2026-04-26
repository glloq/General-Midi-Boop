# Contributing to Général Midi Boop

**Every contribution is welcome.** Bug reports, typo fixes, doc clarifications, translations, feature ideas, screenshots, hardware tests on a Pi you happen to have lying around — it all helps and it's all appreciated.

You don't need to be a Node.js expert, an embedded engineer, or a MIDI specialist to take part. If you have an idea to make the system better, a question that turned out to be a missing piece of documentation, or just a use case we haven't thought of, please open it up. We'd rather hear about it than not.

## Ways to Help

- **Try it and tell us how it went.** What worked, what didn't, what was confusing — that's already valuable feedback.
- **Open an issue** for bugs, ideas, or questions: [GitHub Issues](https://github.com/glloq/General-Midi-Boop/issues). No template required, just describe what you saw or what you'd like.
- **Suggest improvements** — UX, performance, hardware support, accessibility, anything. Half-formed ideas welcome; we can shape them together in the issue.
- **Translate the UI** into your language, or fix existing translations. The locale files live in [`public/locales/`](./public/locales) (28 languages and counting).
- **Improve the docs or the wiki**. The wiki sources are in [`wiki/`](./wiki) and auto-publish on merge to `main`.
- **Write code** — see the practical guide on the wiki below.

## Practical How-To

For setup, code style, tests, branching, commit conventions, and the workflow for adding commands or drivers, see the **[Contributing page on the wiki](https://github.com/glloq/General-Midi-Boop/wiki/Contributing)**. It's the maintained reference and stays in sync with the codebase.

A short pointer for the impatient:

```bash
git clone https://github.com/glloq/General-Midi-Boop.git
cd General-Midi-Boop
npm install
npm run dev
```

Then open `http://localhost:8080`.

## Where Help Is Especially Useful Right Now

Concrete pickup-able items — bugs, refactors, accessibility fixes, performance work — are tracked in [`TODO.md`](./TODO.md). Anything in there is fair game and you don't need to ask before tackling something. If you start on one, leaving a note in an issue helps avoid duplicate work.

## Code of Conduct

Be kind, be patient, assume good intent. We're all here to make this better. Disagreements about technical direction are normal and healthy; personal attacks are not.

## Questions?

Open an issue with the `question` label, or if you'd rather start a conversation than report a bug, the [GitHub Discussions](https://github.com/glloq/General-Midi-Boop/discussions) tab works too.

Thank you for being here.
