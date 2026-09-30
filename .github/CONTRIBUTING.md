# Contributing

Issues and pull requests are welcome, from a one-line typo fix to a new feature. This page starts
with what you need on your first day and ends with the rules that matter once you are changing code.

## Getting started

You need **Node.js 22.12+** and a C++ toolchain for `node-pty` (see
[Build from source](../README.md#build-from-source) for what that is on each platform).

```bash
git clone https://github.com/<you>/Astera.git
cd Astera
git checkout develop
npm ci
npm run dev
```

`npm run dev` starts a development build with its own profile (`astera-dev`, next to the installed
app's `astera`), so it never touches the accounts, sessions or settings of an Astera you have
installed, and the two can run side by side. Before opening a pull request, run what CI runs:

```bash
npm run typecheck
npm test
npm run build
```

## Where things live

| Folder | What it is |
|---|---|
| `src/core` | Logic with no Electron in it: sessions, rolling, orchestration, git, the Host protocol. Most of the tests are here. |
| `src/main` | The Electron main process: windows, IPC handlers, and the wiring that puts `src/core` together. |
| `src/renderer` | The React UI. It can import only the parts of `src/core` that need no `node:` module. |
| `src/preload` | The bridge between the two, `window.api`. |
| `src/host` | The Astera Host, the background process that runs sessions and Jobs while the app is closed. It runs on plain Node, so nothing it imports may reach `electron`, `src/main` or `src/renderer`; `src/host/importFence.test.ts` fails the build if it does. |
| `src/cli` | The `astera` command. |

Longer design notes and decisions live in `knowledge/`, and the published guides in `docs/`
(`docs/cli.md` for the command, `docs/jobs.md` for Jobs).

## Finding something to work on

Issues labelled [good first issue](https://github.com/parsingk/Astera/labels/good%20first%20issue)
are small and self-contained; [help wanted](https://github.com/parsingk/Astera/labels/help%20wanted)
ones are larger. Reviewing the Japanese or Spanish translations is always welcome, since neither had a
native speaker's review (see the i18n rule below). If you want to work on something bigger, open an
issue or a [discussion](https://github.com/parsingk/Astera/discussions) first, so we can agree on the
approach before you spend time on it. Questions are welcome in Discussions too.

## Reporting a bug

Use the bug report form in [Issues](https://github.com/parsingk/Astera/issues/new/choose). It asks for
the app version (Settings, Info), your OS, and the lines of the relevant log. The logs are in the
profile folder: `%APPDATA%\astera` on Windows, `~/Library/Application Support/astera` on macOS and
`~/.config/astera` on Linux. `host/host.log` there is the background Host, and `rolling.log` is
account rolling.

**A security problem is not a bug report.** Please report it privately instead, as
[SECURITY.md](SECURITY.md) describes.

## Rules worth knowing

A couple of things worth knowing before you change code:

- Run `npm run typecheck`, `npm test` and `npm run build` before opening a PR — that is what CI checks,
  in that order, after `npm ci`.
- `npm run typecheck` covers two TypeScript projects, and the split matters. `tsconfig.web.json` lists
  the node-free `src/core` files the renderer may import, one by one. Adding a core module and
  importing it from the renderer means adding it to that `include` array and keeping it free of `node:`
  imports — the renderer cannot load them. Anything needing `node:fs` or `node:child_process` belongs
  on the main side, with the shared types declared in `src/core/types.ts`.
- `docs/` is a whitelist: `docs/*` is ignored except for the pages explicitly un-ignored in
  `.gitignore`. A new file there defaults to "not published" and will not be committed, so
  documentation that ships has to extend one of the existing pages.
- `knowledge/` is the opposite and is committed by default: architecture notes, ADRs under
  `knowledge/decisions/`, and anything else meant to outlive the branch that produced it. Its
  `README.md` says what belongs in each part and, as importantly, what does not.
- **Write new prose in English:** commit messages, code comments, test titles and documentation. Much
  of what is already here is in Korean, most test titles included, because the project was written
  that way before it was published. That is history and is not being converted, so leave it where it
  is rather than translating it in passing. A change that touches a Korean file adds its new lines in
  English and leaves the rest alone.
- Tests live next to what they test as `*.test.ts` and run with `npm test` (Vitest). A change to
  behaviour is expected to come with one.
- **Do not join the usage-limit phrases back together.** Several tests in `src/core/rolling/` and
  `src/main/` build phrases like `"You've hit your " + 'weekly limit'` by concatenation instead of
  writing them as one literal. That is deliberate: Astera watches session output for exactly those
  phrases to decide when to switch accounts, so a file containing one whole would trigger a real
  account roll the moment an agent reads it — which has happened. Test *titles* are subject to the
  same rule, because Vitest prints them joined at runtime. Keep the concatenation, and keep the
  comment that explains it.
- The UI ships in Korean, English, Japanese, and Spanish, declared in one table in
  `src/core/i18n/index.ts`. Korean and English are maintained by the author; Japanese and Spanish
  were produced without a native speaker's review, so corrections there are welcome. To fix a
  translation, edit the matching catalog in `src/core/i18n/messages/<lang>.ts` — `ko.ts` is the
  source catalog and defines the key set, `en.ts` is complete. A key missing from `ja.ts` or `es.ts`
  falls back to English and then Korean, on purpose, so a partial translation PR is fine; you do not
  need to translate every string to contribute one. Two things any change must keep, checked by the
  invariant tests: a placeholder (`{name}`-style) identical to the Korean value, and product, tool
  and command names — `Claude`, `git`, `npm`, `Gradle` and the like — left untranslated. That list
  grows as the app names more tools, so take it from `LITERALS` in `src/core/i18n/catalog.test.ts`
  rather than from here.
- **Adding a run configuration kind touches more places than the kind itself, and the useful split is
  whether a miss fails the build.** These are exhaustive over the union, so forgetting one stops
  `npm run typecheck`: `src/core/run/types.ts` (the string in `RunConfigType`, the interface in
  `RunConfig`, and `optionalFieldsFor`), `buildCommand` in `run/build.ts`, the `REQUIRED` record in
  `run/migrate.ts`, `seedKeyOf` and `defaultConfigFor` in `run/config.ts`, and `runTypeIcon` in
  `run/typeIcon.ts` — plus the per-kind expectation tables the tests are driven from, each a
  `Record<RunConfigType, …>` for exactly this reason: `OPTIONAL` in `run/types.test.ts`, `ICONS` in
  `run/typeIcon.test.ts`, `COMPLETE` in `run/migrate.test.ts` and `START` in `run/config.test.ts`.
  These are hand-written lists no type covers, so a miss is silent: the `KNOWN` array in
  `run/migrate.ts` — `migrateRunConfigs` guards the save as well as the read (`run.saveConfigs` in
  `main/run/saveConfigs.ts` rejects what it drops), so the first symptom is that a configuration of
  the new kind cannot be saved at all, not that it vanishes on reload — the per-kind field blocks in
  `RunConfigForm.tsx`, which are `draft.type === …` guards, so the form just draws nothing;
  `BLANKABLE` in the same file, which every new optional text field has to join, or clearing the box
  stores `''` rather than removing the field and the row can never be dismissed again; `ALL_TYPES`
  in `RunTypePicker.tsx`, so the ＋ menu never offers the kind; and `LITERALS` in
  `i18n/catalog.test.ts`, whose invariant stops covering the kind's label while still passing.
  Beyond both groups, a kind needs its `run.type.<kind>` label in the four catalogs — and a
  `run.field.<name>` label for every name it adds to `REQUIRED`, since `run.start` builds the
  "required field is empty" message by looking one up (a test in `run/migrate.test.ts` pins that,
  because the key is assembled from a string and no type can check it). It only lands under
  "detected in this project" if something supplies the evidence — a seed configuration, a boolean
  derived from the project's root file list, or a scan. The four READMEs name the kinds one by one
  under **Run**, so a new one belongs in all four as well — nothing checks that list, and it is the
  first thing a reader sees.
- The README ships in the same four languages, as `README.md` (English, the source), `README.ko.md`,
  `README.ja.md` and `README.es.md`, each linking to the others under the badges. A change to the
  English README that alters what the app does or how it is installed belongs in the translations
  too; wording-only polish does not have to be mirrored. As with the catalogs, the Japanese and
  Spanish pages had no native review.
- The three README diagrams are generated, and both the source and the output are committed. The
  source is `assets/src/diagram.html`, one set of six states per diagram with a caption each, picked
  by a `?d=<set>` query; `npx electron scripts/gen-diagram.js` renders every set in `DIAGRAMS` and
  encodes `assets/rolling.gif`, `assets/schedule.gif` and `assets/jobs.gif`, which needs `ffmpeg` on
  `PATH`. Change the page rather than the GIFs, then commit both. The script carries comments on the
  parts of Electron's offscreen rendering that do not behave as they read.
- Commit subjects carry a type prefix, written as an instruction, with the body saying why rather
  than restating the diff. In use, most used first: `fix:`, `feat:`, `docs:`, `test:`, `chore:`,
  `refactor:`, `ci:`, and a handful of `style:`, `perf:` and `build:`. Most subjects also carry a
  scope, as in `feat(run):`, and the scope changes what the release notes do with the commit.
- **The release notes are generated, and branch names are the main input**
  (`scripts/build-release-notes.cjs`). The unit is the branch, not the commit: a branch merged into
  `develop` becomes one line with its commits collapsed underneath, so three things fixed at merge
  time decide what a reader sees. The branch prefix picks the section, `feat/` and `feature/` under
  New features, `fix/`, `bugfix/` and `hotfix/` under Fixes, and any other prefix (a personal one
  included) falls back to what the branch's commits say. The headline is the part of the branch name
  after the last `/` with its hyphens and underscores opened out into spaces, unless the merge
  message was written by hand, which wins over it and costs one line at merge time instead of a
  paragraph later. A commit pushed straight to `develop` has no branch and keeps a line of its own,
  and there the scope is what matters: a `fix(run):` in the same release as a `feat(run):` is read as
  a fix to code nobody has run yet and drops out of Fixes, while an unscoped `fix:` is never demoted.
  A release that needs to say something no branch name can carry gets `docs/release-notes/<tag>.md`,
  which replaces both generated sections.
- Open pull requests against `develop`. `main` is the release branch: a release is cut by tagging it
  `vX.Y.Z`, which is what publishes the installers and the update feed
  ([docs/releasing.md](../docs/releasing.md)).

See [Build from source](../README.md#build-from-source) in the README for the Node version, the native
toolchain `node-pty` needs, and the packaging scripts.
