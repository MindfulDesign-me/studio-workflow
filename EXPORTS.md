# PDF and PowerPoint downloads: what to add to the shared workflow

The shared workflow YAML lives in `MindfulDesign-me/studio-workflow` (`.github/workflows/upload.yml`), not here.
This repo's `workflow/` folder is what becomes that repo's `scripts/` and `package.json`. Copy it over first
(`scripts/exports.mjs`, `scripts/assemble.mjs`, `scripts/pdf-clean.mjs`, the changed `scripts/lib.mjs` and
`scripts/upload.mjs`, `package.json`, `package-lock.json`). Job names below are roles; use the names the YAML already has.

## The three steps

Trust rule: `exports.mjs` runs the designs' code, so it goes in the job that already runs `shots.mjs` (no
`id-token: write`, no secrets). `assemble.mjs` and `upload.mjs` go in the job that uploads (has `id-token: write`,
never runs design code). Check this holds before anything else: the job with `id-token: write` must not run
`shots.mjs` or any build command.

1. **Shots job**, after the `shots.mjs` step (Chromium is already installed there:
   `npx playwright install --with-deps chromium`, which also brings the basic fonts):

   ```yaml
   - name: Downloads, pages
     continue-on-error: true
     run: node scripts/exports.mjs studio.json dist exports-src
   ```

   Add `exports-src` to the paths of the artifact this job already hands over, or give it its own:

   ```yaml
   - uses: actions/upload-artifact@v4      # pin by commit like the other actions
     with: { name: exports-src, path: exports-src, retention-days: 1, if-no-files-found: ignore }
   ```

   Raise this job's `timeout-minutes` by 10 (the script stops itself after 6 minutes of printing). It prints
   the NEWEST rounds first (highest number of each project, then the next, ...), so when the time runs out it
   is the oldest rounds that wait. Each one it did not reach gets a manifest with `"skipped": true`, and the
   assembler names them in the save's checks; Studio keeps the downloads it already has for older rounds.

2. **Upload job**, before the upload step, with the other downloads of artifacts:

   ```yaml
   - uses: actions/download-artifact@v4
     continue-on-error: true
     with: { name: exports-src, path: exports-src }
   - name: Downloads, files
     continue-on-error: true
     run: |
       npm ci --ignore-scripts          # in the folder with package-lock.json; the versions are pinned
       node scripts/assemble.mjs studio.json exports-src exports
   ```

   Give the step `timeout-minutes: 8`. `assemble.mjs` holds itself to 4 minutes (the newest rounds first; the
   rest are named in the checks as not made), 600 MB read in all, and each PDF is checked in a worker with a
   1 GB memory limit and at most 90 seconds, so one bad round ends as a problem, never as a failed job. The
   `npm ci` must run in this repo's `workflow/` folder (the shared repo's, not a client repo's), so nothing a
   client repo holds can shadow `node_modules`. If the YAML allows it, run this step in a job without
   `id-token: write` and hand `exports/` to the upload job as an artifact.

3. **The upload step** gets one more, optional, last argument. Nothing else about it changes:

   ```
   node scripts/upload.mjs studio.json dist checks.json shots/screenshots.json exports/exports.json
   ```

   If `exports/exports.json` does not exist (the steps above failed or were skipped) the save goes up without
   downloads. A problem making any file shows in the save's checks as a "should fix" under `downloads`; it never
   fails the job.

Nothing is needed for fonts beyond what the screenshots already get: pages that load web fonts (Google Fonts)
print with them, since the exports job has network access. A design that relies on a system font such as
Helvetica Neue or Georgia prints in the runner's fallback font; if that matters, put the font in the repo.

## Rollout order

1. Deploy the Studio server from this branch first. It only accepts `exports`; saves from the old workflow
   are unchanged.
2. Commit the workflow change to `studio-workflow` and create the tag `v2` (admins only; `v1` stays as it is).
3. On the server, set `WORKFLOW_REFS` to both tags and restart:
   `MindfulDesign-me/studio-workflow/.github/workflows/upload.yml@refs/tags/v1,MindfulDesign-me/studio-workflow/.github/workflows/upload.yml@refs/tags/v2`
4. Point one test client repo's `.github/workflows/studio.yml` (`uses: ...upload.yml@v1`) at `@v2`, save a
   proposal and a deck, and check the Download menu has the files. Then change `template/.github/workflows/studio.yml`
   to `@v2` and the other client repos.
5. Backfill: run each client repo's workflow once with `workflow_dispatch` (Actions, MindfulStudio, Run workflow).
   Every round of a proposal, document or presentation gets its files; rounds whose pages did not change keep
   what they had.
6. When every repo is on `@v2`, remove the `v1` entry from `WORKFLOW_REFS`.

The shortcut, if you accept that every client repo changes at once: move `v1` to the new commit instead of
steps 2 to 4 and 6. `WORKFLOW_REFS` is then untouched.

## What the files are

- PDF: documents and proposals as A4 pages (the page laid out about 1024 px wide, then scaled onto A4); each deck
  slide as one 1920 x 1080 px page. Dated with the round's `date` (else 2026-01-01); the assembler gives the
  same file for the same printed pages. (Chrome's own output can differ a little between runs, which is why the
  server skips rounds whose files have not changed.)
  The PDF is **rebuilt from an allow-list** (`scripts/pdf-clean.mjs`), not copied: per page only the size,
  rotation, drawing (`Contents`) and `Resources` (fonts, images and forms, ExtGState, color spaces, patterns,
  shadings), and under those only the keys a printed page uses (a font keeps its descriptor and font program,
  an image its size, color space and mask, ...). Every other key is left behind at every level, so links,
  actions, scripts, forms, attachments, optional-content and file-spec keys can not come along, nor can an
  unknown key. Streams are copied as they are, and only Flate and DCT (JPEG) compression is accepted; a file
  that uses anything else, compressed object streams, an encrypted file, a page tree that lists a page twice
  or more than 200 pages (80 slides) is refused with a plain problem. A scan of the finished file for the
  forbidden keys is a second check. What was left behind is named in a notice in the job log
  ("left out of the PDF"); real Chrome output leaves nothing behind but links (annotations).
  Residual risk: font programs and JPEG data are passed through unread, so a flaw in a viewer's own font or
  JPEG code is not something this step can see.
- PowerPoint (presentations only): every slide a full-slide 16:9 picture, the page name as the slide's notes.
- At most 80 pages per option, 25 MB per file. A bigger or broken file is left out and named in the checks.
- Only projects whose `type` in `studio.json` is `proposal`, `document` or `presentation` get files.
- Nothing from `studio.json` reaches a path unchecked (`exportPlan` in `scripts/lib.mjs`, used by both steps):
  slugs must match the server's rule (lowercase letters, numbers, hyphens), the round number is a whole number
  from 1 to 999, the round's folder and each page's path are plain relative paths, and the lists are real
  lists. Anything else is left out with a note (a bad page leaves out its whole round).
- Sizes are read from the file system before a file is read: 20 MB per printed page file, 4 MB per slide
  picture, 150 MB per file made, 600 MB per run (`STUDIO_ASSEMBLE_MAX_BYTES`); the manifest's own list of
  pages is never trusted to size anything (more pages than `studio.json` has, or than 80, refuses it).
  Time: printing 6 minutes (`STUDIO_EXPORTS_BUDGET_MS`), assembling 4 minutes (`STUDIO_ASSEMBLE_BUDGET_MS`);
  in both the first page or round is always done, and what runs out is the oldest rounds.
