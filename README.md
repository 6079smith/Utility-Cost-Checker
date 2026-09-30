# Meter Costs: Utility Cost Checker

An iPhone-friendly web app for households in England, Scotland and Wales. Photograph your gas and electricity meters and it tells you what you're spending **per hour, per day and per week**. It also shows this week and month so far, a typical monthly cost, and a daily cost chart.

- **Installs like an app.** Open the link in Safari, tap **Share → Add to Home Screen**. No App Store.
- **AI meter reading.** Take a photo and Claude reads the digits. You check them, then save. Typing the reading is always an option.
- **Octopus prices fetched automatically.** It uses Octopus's public API and picks up price changes, such as each quarterly price-cap change.
- **Economy 7.** Day and night registers are read and charged at their own rates. That works with Octopus (fetched automatically) and with rates typed from any other supplier's bill.
- **Any other supplier.** Type the unit rate and standing charge from your bill. When you switch supplier, earlier readings keep the old prices.
- **Meter-style display.** Dark by default, with readings shown in digit boxes like the meter itself, a gauge of today's spend against a typical day, and 14-day trend lines. Switch between Dark, Light and Auto (follows the iPhone) at the top of Settings.
- **Private.** Readings live only on each phone. Family members each install it and track their own home.

## How the maths works

| Item | How it's handled |
|---|---|
| Electricity | Meter reads kWh directly |
| Economy 7 | Day register × day rate + night register × night rate (one standing charge) |
| Gas | `m³ × 1.02264 × calorific value ÷ 3.6 = kWh` (the calorific value is on your bill, default 39.5). Imperial meters: hundreds of ft³ × 2.83 = m³ |
| Unit rate | p/kWh × kWh used |
| Standing charge | p/day × days (pro-rata to the minute) |
| Environmental & social levies | Already included in the unit rate and standing charge; UK suppliers don't bill them separately |
| VAT | 5% on the total |

Usage between two readings is assumed to be spread evenly over that period. The period is split at midnight (UK time) and wherever the price changes, and each piece is costed at the price in force at that time.

## Setup

### 1. Publish the app (free, GitHub Pages)

1. In this repo on GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge to `main`. The workflow in `.github/workflows/deploy.yml` tests, builds and publishes the app.
3. Your app is at `https://<your-github-username>.github.io/<repo-name>/`.

### 2. Set up photo reading (free Cloudflare Worker, about 5 minutes)

The helper keeps your Claude API key on a server, so family members don't need one. Each photo costs a fraction of a penny.

```bash
cd worker
npm install
npx wrangler login                          # free Cloudflare account
npx wrangler secret put ANTHROPIC_API_KEY   # console.anthropic.com → API keys; pick a workspace when creating it
npx wrangler secret put ACCESS_CODE         # make up a passphrase
npx wrangler deploy                         # prints https://utility-cost-helper.<you>.workers.dev
```

Optionally, set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to your Pages origin (e.g. `https://you.github.io`) and redeploy.

In the app: **Settings → Photo reading → Family helper link**, paste the Worker address and access code.

The helper also relays Octopus price lookups if a phone can't reach Octopus directly.

### 3. Share with family

In **Settings → Share with family**, tap **Share app link** (tick "Include photo reading"). They open it in Safari, then **Share → Add to Home Screen**. Photo reading is already set up for them.

## First use

1. **Settings**: enter your postcode and tap **Find** to set your region. Under **Electricity meter**, choose *Single rate* or *Economy 7*. Set each tariff: pick your Octopus tariff from the list (or type the product code shown in your Octopus account), or choose **Other supplier** and type the prices from your bill.
2. **Add reading**: photograph each meter.
3. A day or more later, add another reading. You'll see the cost per hour, day and week.

**Economy 7 meters:**
- **Dial meters** show both rows, usually labelled *Low* (night) and *Normal* (day), and one photo reads both.
- **Digital meters** show one rate at a time: press the button on the meter to show the other rate and take a second photo.
- **"Rate 1" and "Rate 2" labels** don't mean the same thing on every meter. Set which one is night in Settings; your bill will tell you (the cheaper one is night).
- **Swapped readings** are flagged: if day and night look the wrong way round compared with your last reading, the app offers to swap them.

**Changing supplier:** Settings → *Change tariff or supplier* → set the date the new tariff started.

**Backups:** Settings → *Save backup* (share to Files/iCloud Drive). Use *Restore* on a new phone.

## Development

```bash
npm install
npm run dev     # local dev server
npm test        # cost-engine unit tests
npm run build   # production build in dist/
```

| Path | Purpose |
|---|---|
| `src/calc.js` | Pure cost engine: gas conversion, tariff segments, pro-rata costing, daily buckets |
| `src/octopus.js` | Octopus region lookup, product list, unit rates and standing charges |
| `src/registers.js` | Maps register labels (Low/Normal, Rate 1/2, 1.8.1/1.8.2) to Economy 7 day/night |
| `src/meterPrompt.js` | Claude prompt and JSON schema for meter reading (shared with the Worker) |
| `src/meterReader.js` | Photo resize and call to the helper (or directly with your own API key) |
| `src/store.js` | On-device storage, tariff switching, backup |
| `src/main.js` | Screens: Home, Add reading, History, Settings |
| `worker/` | Cloudflare Worker: `/read-meter` and `/octopus/*` relay |

## Limitations

- Economy 10, Economy 7 with a separate heating circuit, and other multi-rate tariffs aren't supported.
- Estimates only. Your bill uses your supplier's readings and rounding.
- With traditional meters, "per hour" is the average over the time between two readings, not a live hourly figure.
