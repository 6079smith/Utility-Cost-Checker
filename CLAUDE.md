# Notes for Claude

Installable iPhone web app (PWA) that estimates UK electricity and gas costs from meter readings. The owner is in England, on Octopus, with an old non-smart Economy 7 electricity meter and a gas meter. Family members install it on their own phones and track their own homes; the app does not track other people. README.md explains the features and maths; read it first.

## Working rules

- Run `npm test` and `npm run build` before every push. Tests run with `TZ=Europe/London`; keep that.
- Develop on the branch you are given, then fast-forward `main` (`git push origin HEAD:main`). Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`. The repo must stay public (free Pages).
- The owner uses the app on an iPhone, not a desktop. Check layouts at phone width and remember iOS Safari quirks.
- Write user-facing text in plain British English. The owner isn't a developer: explain steps simply, one command at a time.
- Keep `src/calc.js` pure and tested. Add a test for any cost-engine or tariff-date change.
- Never commit secrets: API keys, the helper's access code, or the owner's Worker address.
- Keep sessions short to save cost: each turn re-reads the whole conversation. Once a feature is finished and pushed, if the session has been long or the next request is unrelated, say in one line that starting a new session would be cheaper. Update this file first with any new decision worth keeping. A Stop hook (`.claude/hooks/session-size.mjs`) also shows this nudge automatically once the context passes ~150k tokens.

## Architecture

- Vite + vanilla JS, no framework. Data lives only in localStorage (key `ucc:v1`, `src/store.js`), with backup/restore. `public/sw.js` is network-first for pages.
- `src/calc.js`: cost engine. Splits usage between readings evenly over time, cut at UK midnights and tariff boundaries. Unit rate × kWh + standing charge p/day, then 5% VAT (levies are already in the rates). Gas: m³ × 1.02264 × CV (default 39.5) ÷ 3.6; imperial meters read hundreds of ft³ × 2.83168.
- `src/tariffPlan.js`: tariff history rules. No overlaps; at most one open-ended tariff, and it must be the latest. End dates are inclusive in the UI but stored as the next midnight. `SINCE_START` means "covers all readings".
- `src/octopus.js`: Octopus public API (region from postcode; E-1R / E-2R / G-1R tariff codes). Falls back to the Worker proxy if CORS fails.
- `src/meterPrompt.js`: prompts and JSON schemas for meter and bill reading, shared by the app and the Worker. Uses the Claude API with structured outputs and server-side refusal fallback, and retries without the beta on a 400.
- `src/meterReader.js`: calls the helper Worker (`/read-meter`, `/read-bill`) or, in own-key mode, the API directly from the browser.
- `worker/`: Cloudflare Worker that keeps the API key off phones (secrets ANTHROPIC_API_KEY and ACCESS_CODE). It imports `../../src/meterPrompt.js`, so prompt changes need `npx wrangler deploy` from `worker/`. The owner's local Worker copy was a ZIP download, not a git clone, so give them fresh-clone instructions. Anthropic API keys must be workspace-scoped.

## Decisions to keep (each fixed a real problem)

- Style "B": dark by default, with Dark/Light/Auto at the top of Settings. Azeret Mono font (bundled via @fontsource, no slashed zeros). Readings are shown as digit boxes. The ring gauge always shows once there are readings, with placeholders before rates are known.
- Meter digits are capped at electricity 5 and gas 4 (`METER_DIGITS`). Photo results with too many digits are rejected, never truncated.
- `MIN_RATE_HOURS = 6`: rates and projections stay hidden until readings span 6+ hours. Short gaps gave absurd extrapolations.
- Reading dates use separate date and time inputs (the iPhone datetime-local picker lost the date). History entries can have their date edited. Readings are checked against the next later reading, not just the latest one.
- "Read today/yesterday" labels work by calendar day. A "new or replaced meter" reading resets the series; the home screen only shows intervals from the current meter.
- Economy 7: readings are `{day, night}`. Which of "Rate 1"/"Rate 2" is night is a setting (`rate1Is`). Swapped day/night readings are flagged. The time switch runs on GMT all year, but the app doesn't need switching times: each register is costed at its own rate.
- The camera and shutter are hidden when Photo reading is Off. The bill-reading button needs photo reading set up; when it isn't, a note says so rather than silently hiding it.
- The Add tariff form doesn't prefill the tariff name or product code. A blank start date is only allowed for the first tariff.
- Colours: electricity #2a78d6/#3987e5, gas #eb6834/#d95926.

## Not supported (by choice)

Economy 10 and other multi-rate tariffs; smart-meter data; multi-household tracking.
