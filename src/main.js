import {
  FUELS,
  getState,
  update,
  uid,
  readingsFor,
  lastReading,
  tariffsFor,
  currentTariff,
  switchTariff,
  exportJson,
  importJson,
  requestPersistence,
} from './store.js';
import { analyseFuel, buildIntervals, toKwh, sumDays, recentDailyAverage, dayKey, tariffSegments, costInterval } from './calc.js';
import { REGIONS, regionForPostcode, listProducts, fetchRates } from './octopus.js';
import { prepareImage, readMeter, aiAvailable } from './meterReader.js';
import { renderDailyChart } from './chart.js';

const view = document.getElementById('view');
const title = document.getElementById('page-title');
const DAY = 86400e3;
const SINCE_START = '2000-01-01T00:00:00.000Z';
const RATE_REFRESH_MS = 12 * 3600e3;

// ---------- formatting ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gbp = (p) => '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pence = (p) => (p < 100 ? p.toFixed(1) + 'p' : gbp(p));
const num = (n, dp = 1) => n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtDate = (t, opts = { day: 'numeric', month: 'short' }) => new Date(t).toLocaleDateString('en-GB', opts);
const fmtDateTime = (t) =>
  new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fuelName = (f) => (f === 'gas' ? 'Gas' : 'Electricity');
const meterUnit = (f) => (f === 'gas' ? (getState().settings.gas.units === 'ft3' ? 'ft³' : 'm³') : 'kWh');

function ago(t) {
  const d = Math.floor((Date.now() - t) / DAY);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

function localInputValue(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- analysis ----------

function analyseAll() {
  const s = getState();
  const out = {};
  for (const fuel of FUELS) {
    out[fuel] = analyseFuel({ readings: s.readings, tariffs: s.tariffs, fuel, gas: s.settings.gas, vatRate: s.settings.vatRate });
  }
  return out;
}

// ---------- routing ----------

const routes = { home: renderHome, add: renderAdd, history: renderHistory, settings: renderSettings };
const titles = { home: 'Meter Costs', add: 'Add reading', history: 'History', settings: 'Settings' };

function route() {
  const name = location.hash.replace('#', '').split('?')[0] || 'home';
  const fn = routes[name] || renderHome;
  const key = routes[name] ? name : 'home';
  title.textContent = titles[key];
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  fn();
  window.scrollTo(0, 0);
}

// ---------- home ----------

function renderHome() {
  const s = getState();
  const a = analyseAll();
  const hasReadings = s.readings.length > 0;
  const hasTariffs = FUELS.some((f) => currentTariff(f));
  let html = '';

  if (!hasTariffs || !hasReadings) {
    html += `<div class="card">
      <h3>Get started</h3>
      <ol class="steps">
        <li>${hasTariffs ? '✓ ' : ''}<a href="#settings">Add your tariff</a>: pick your Octopus tariff, or type the prices from your bill.</li>
        <li>${hasReadings ? '✓ ' : ''}<a href="#add">Take a photo of each meter</a>.</li>
        <li>Take another photo in a day or two. You’ll then see what you’re spending per hour, day and week.</li>
      </ol>
    </div>`;
  }

  // Combined totals
  const today = dayKey(Date.now());
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const monthStart = new Date();
  monthStart.setHours(0, 0, 0, 0);
  monthStart.setDate(1);
  const week = FUELS.map((f) => sumDays(a[f].daily, dayKey(monday), today));
  const month = FUELS.map((f) => sumDays(a[f].daily, dayKey(monthStart), today));
  const avgs = FUELS.map((f) => recentDailyAverage(a[f].intervals, 30));
  const anyIntervals = FUELS.some((f) => a[f].intervals.length);

  if (anyIntervals) {
    const perDay = avgs.reduce((t, x) => t + (x?.costP || 0), 0);
    html += `<div class="card">
      <div class="hero-label">Typical monthly cost at your current rate</div>
      <div class="hero">${gbp(perDay * 30.44)}</div>
      <div class="muted small">≈ ${gbp(perDay)} a day · ${gbp(perDay * 7)} a week</div>
      <div class="tiles two">
        <div class="tile"><div class="label">This week so far</div><div class="value">${gbp(week.reduce((t, x) => t + x.costP, 0))}</div><div class="sub">${num(Math.max(...week.map((w) => w.coveredDays)), 1)} days measured</div></div>
        <div class="tile"><div class="label">This month so far</div><div class="value">${gbp(month.reduce((t, x) => t + x.costP, 0))}</div><div class="sub">${num(Math.max(...month.map((w) => w.coveredDays)), 1)} days measured</div></div>
      </div>
      <p class="tiny" style="margin-top:8px">“So far” only counts up to your latest reading. Includes standing charges and 5% VAT.</p>
    </div>`;
  }

  for (const fuel of FUELS) {
    const readings = readingsFor(fuel);
    if (!readings.length && !currentTariff(fuel)) continue;
    const an = a[fuel];
    const last = readings[readings.length - 1];
    const latest = an.intervals[an.intervals.length - 1];
    html += `<div class="card"><div class="card-head"><div class="fuel-title"><i class="swatch ${fuel}"></i>${fuelName(fuel)}</div>`;
    html += last ? `<span class="tiny">Read ${ago(Date.parse(last.at))}</span>` : '';
    html += '</div>';
    if (!currentTariff(fuel)) html += `<div class="notice">No ${fuel} tariff yet. <a href="#settings">Add one</a> to see costs.</div>`;
    if (!last) {
      html += `<p class="muted">No readings yet.</p><a class="btn secondary" href="#add?fuel=${fuel}">Add first reading</a>`;
    } else if (!latest) {
      html += `<p class="muted">Last reading ${num(last.value, 0)} ${meterUnit(fuel)} on ${fmtDate(last.at)}. Add another reading to see usage and cost.</p>
        <a class="btn secondary" href="#add?fuel=${fuel}">Add reading</a>`;
    } else {
      const r = latest.rates;
      html += `<div class="hero-label">Since ${fmtDateTime(latest.from)} (${num(r.days, 1)} days)</div>
        <div class="hero" style="font-size:34px">${gbp(latest.cost.totalP)}</div>
        <div class="muted small">${num(latest.kwh, 1)} kWh${fuel === 'gas' ? ` (${num(latest.units, 2)} ${meterUnit(fuel)})` : ''}</div>
        <div class="tiles">
          <div class="tile"><div class="label">Per hour</div><div class="value">${pence(r.perHour.costP)}</div><div class="sub">${num(r.perHour.kwh, 2)} kWh</div></div>
          <div class="tile"><div class="label">Per day</div><div class="value">${gbp(r.perDay.costP)}</div><div class="sub">${num(r.perDay.kwh, 1)} kWh</div></div>
          <div class="tile"><div class="label">Per week</div><div class="value">${gbp(r.perWeek.costP)}</div><div class="sub">${num(r.perWeek.kwh, 0)} kWh</div></div>
        </div>`;
      if (latest.cost.missingTariff) html += `<div class="notice">Part of this period has no tariff set, so the cost is too low. Check the tariff start date in Settings.</div>`;
    }
    html += '</div>';
  }

  if (anyIntervals) {
    html += `<h2>Daily cost</h2><div class="card"><div id="chart"></div>
      <details><summary>Show as table</summary><div id="chart-table"></div></details></div>`;
  }

  view.innerHTML = html;
  if (anyIntervals) drawChart(a);
}

function drawChart(a) {
  const days = [];
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end.getTime() - i * DAY);
    const key = dayKey(d);
    const e = a.electricity.daily[key];
    const g = a.gas.daily[key];
    days.push({
      key,
      label: fmtDate(d),
      longLabel: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
      electricity: e?.costP || 0,
      gas: g?.costP || 0,
      partial: [e, g].some((x) => x && x.ms < DAY - 3600e3),
    });
  }
  renderDailyChart(document.getElementById('chart'), days);
  const rows = days
    .filter((d) => d.electricity || d.gas)
    .reverse()
    .map((d) => `<tr><td>${esc(d.longLabel)}${d.partial ? '*' : ''}</td><td>${d.electricity ? gbp(d.electricity) : '—'}</td><td>${d.gas ? gbp(d.gas) : '—'}</td><td>${gbp(d.electricity + d.gas)}</td></tr>`)
    .join('');
  document.getElementById('chart-table').innerHTML =
    `<table><thead><tr><th>Day</th><th>Elec.</th><th>Gas</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
     <p class="tiny">* part day. Usage between two readings is spread evenly across the days in between.</p>`;
}

// ---------- add reading ----------

function renderAdd() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const s = getState();
  let fuel = FUELS.includes(params.get('fuel')) ? params.get('fuel') : 'electricity';
  const ai = s.settings.ai;
  const canAi = aiAvailable(ai);

  view.innerHTML = `
    <div class="segmented" role="group" aria-label="Meter">
      ${FUELS.map((f) => `<button type="button" data-fuel="${f}" aria-pressed="${f === fuel}">${fuelName(f)}</button>`).join('')}
    </div>
    <div class="card">
      <label class="btn" style="margin:0;color:var(--accent-ink)" for="photo">
        <svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>
        Take photo of meter
      </label>
      <input id="photo" type="file" accept="image/*" capture="environment" hidden />
      ${canAi ? '' : '<p class="tiny" style="margin-top:8px">Photo reading isn’t set up on this phone, so type the numbers in below. You can set it up in Settings.</p>'}
      <img id="preview" class="photo-preview" alt="Meter photo" hidden />
      <div id="ai-status" class="small" style="margin-top:8px"></div>
    </div>
    <form id="reading-form" class="card" novalidate>
      <label for="value">Meter reading (<span id="unit"></span>)</label>
      <input id="value" class="big-input" inputmode="decimal" autocomplete="off" placeholder="00000" required />
      <p id="prev" class="tiny" style="margin-top:6px"></p>
      <label for="at">Date and time of reading</label>
      <input id="at" type="datetime-local" value="${localInputValue(Date.now())}" required />
      <label class="check" style="margin-top:14px"><input type="checkbox" id="reset" /> New or replaced meter (start counting again)</label>
      <div id="estimate" class="small" style="margin-top:12px"></div>
      <div id="form-error" class="error"></div>
      <button class="btn" type="submit">Save reading</button>
    </form>`;

  const valueEl = view.querySelector('#value');
  const atEl = view.querySelector('#at');
  const resetEl = view.querySelector('#reset');
  const statusEl = view.querySelector('#ai-status');
  const estimateEl = view.querySelector('#estimate');
  const errEl = view.querySelector('#form-error');
  let source = 'manual';

  const parseValue = () => {
    const v = parseFloat(valueEl.value.replace(/[,\s]/g, ''));
    return Number.isFinite(v) ? v : null;
  };

  const refresh = () => {
    view.querySelectorAll('[data-fuel]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.fuel === fuel));
    view.querySelector('#unit').textContent = meterUnit(fuel);
    const at = Date.parse(atEl.value);
    const prev = lastReading(fuel, Number.isFinite(at) ? at : Infinity);
    view.querySelector('#prev').textContent = prev
      ? `Previous: ${num(prev.value, fuel === 'gas' ? 1 : 0)} ${meterUnit(fuel)} on ${fmtDateTime(prev.at)}`
      : 'This is your first reading for this meter.';
    const v = parseValue();
    errEl.textContent = '';
    estimateEl.innerHTML = '';
    if (v === null || !prev || resetEl.checked || !Number.isFinite(at)) return;
    if (v < prev.value) {
      estimateEl.innerHTML = `<div class="notice">That’s lower than the previous reading. Check the digits, or tick “New or replaced meter”.</div>`;
      return;
    }
    const st = getState();
    const [iv] = buildIntervals(
      [
        { ...prev, id: 'p' },
        { id: 'n', fuel, at: new Date(at).toISOString(), value: v },
      ],
      fuel,
      st.settings.gas,
    );
    if (!iv) return;
    const cost = costInterval(iv, tariffSegments(st.tariffs, fuel), st.settings.vatRate);
    const days = (iv.to - iv.from) / DAY;
    estimateEl.innerHTML = `<strong>${num(iv.kwh, 1)} kWh</strong> used in ${num(days, 1)} days ≈ <strong>${gbp(cost.totalP)}</strong>
      <span class="muted">(${gbp((cost.totalP / days) || 0)}/day)</span>
      ${cost.missingTariff ? '<div class="notice">No tariff covers all of this period yet. Add one in Settings.</div>' : ''}`;
  };

  view.querySelectorAll('[data-fuel]').forEach((b) =>
    b.addEventListener('click', () => {
      fuel = b.dataset.fuel;
      refresh();
    }),
  );
  [valueEl, atEl, resetEl].forEach((el) => el.addEventListener('input', () => { if (el === valueEl) source = 'manual'; refresh(); }));

  view.querySelector('#photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    atEl.value = localInputValue(file.lastModified && Date.now() - file.lastModified < 7 * DAY ? file.lastModified : Date.now());
    let image;
    try {
      image = await prepareImage(file);
    } catch {
      statusEl.innerHTML = '<span class="error">Couldn’t open that photo.</span>';
      return;
    }
    const img = view.querySelector('#preview');
    img.src = image.dataUrl;
    img.hidden = false;
    if (!aiAvailable(getState().settings.ai)) {
      statusEl.textContent = 'Type the reading from the photo below.';
      valueEl.focus();
      return;
    }
    statusEl.innerHTML = '<span class="spinner"></span> Reading the meter…';
    try {
      const prev = lastReading(fuel);
      const result = await readMeter({ image, fuel, previous: prev?.value ?? null, ai: getState().settings.ai });
      if (result.value == null) {
        statusEl.innerHTML = `<span class="error">Couldn’t read the numbers.</span> ${esc(result.notes)} Please type them in.`;
        valueEl.focus();
        return;
      }
      valueEl.value = String(result.value);
      source = 'photo';
      if (result.meter_kind !== 'unknown' && result.meter_kind !== fuel) {
        statusEl.innerHTML = `<div class="notice">This looks like a ${esc(result.meter_kind)} meter. Switch meter above if so.</div>`;
      } else {
        statusEl.innerHTML = '';
      }
      statusEl.innerHTML += `Read <strong>${esc(result.digits)}</strong> <span class="badge ${esc(result.confidence)}">${esc(result.confidence)} confidence</span>
        ${result.notes ? `<div class="tiny" style="margin-top:4px">${esc(result.notes)}</div>` : ''}
        <div class="tiny">Check it matches the black digits on your meter before saving.</div>`;
      if (fuel === 'gas' && ['m3', 'ft3'].includes(result.unit) && result.unit !== getState().settings.gas.units) {
        statusEl.innerHTML += `<div class="notice">Your meter looks like it reads in ${result.unit === 'ft3' ? 'hundreds of cubic feet' : 'cubic metres'}. Change “Gas meter units” in Settings if so.</div>`;
      }
      refresh();
    } catch (err) {
      statusEl.innerHTML = `<span class="error">${esc(err.message)}</span>`;
      valueEl.focus();
    }
  });

  view.querySelector('#reading-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = parseValue();
    const at = Date.parse(atEl.value);
    if (v === null || v < 0) return (errEl.textContent = 'Enter the reading shown on the meter.');
    if (!Number.isFinite(at)) return (errEl.textContent = 'Enter the date and time.');
    if (at > Date.now() + 5 * 60e3) return (errEl.textContent = 'That time is in the future.');
    const prev = lastReading(fuel, at);
    if (prev && v < prev.value && !resetEl.checked) {
      return (errEl.textContent = 'Lower than the previous reading. Check it, or tick “New or replaced meter”.');
    }
    update((st) => {
      st.readings.push({ id: uid(), fuel, at: new Date(at).toISOString(), value: v, source, reset: resetEl.checked || undefined });
    });
    requestPersistence();
    toast(`${fuelName(fuel)} reading saved`);
    await refreshOctopusIfNeeded(fuel).catch(() => {});
    location.hash = '#home';
  });

  refresh();
}

// ---------- history ----------

let historyFuel = 'electricity';
function renderHistory() {
  const a = analyseAll()[historyFuel];
  const readings = readingsFor(historyFuel).reverse();
  const intervals = [...a.intervals].reverse();
  const invalid = buildIntervals(getState().readings, historyFuel, getState().settings.gas).filter((i) => i.invalid);
  view.innerHTML = `
    <div class="segmented" role="group" aria-label="Meter">
      ${FUELS.map((f) => `<button type="button" data-fuel="${f}" aria-pressed="${f === historyFuel}">${fuelName(f)}</button>`).join('')}
    </div>
    ${invalid.length ? `<div class="notice">${invalid.length} reading${invalid.length > 1 ? 's are' : ' is'} lower than the one before, so ${invalid.length > 1 ? 'those periods are' : 'that period is'} skipped. Delete the wrong reading below.</div>` : ''}
    <h2>Usage between readings</h2>
    <div class="card">${
      intervals.length
        ? `<ul class="list">${intervals
            .map(
              (iv) => `<li><div class="main"><div>${fmtDate(iv.from)} – ${fmtDate(iv.to)}</div>
                <div class="tiny">${num(iv.kwh, 1)} kWh · ${num(iv.rates.days, 1)} days · ${gbp(iv.rates.perDay.costP)}/day</div></div>
                <div class="amount">${gbp(iv.cost.totalP)}${iv.cost.missingTariff ? '<div class="tiny">tariff missing</div>' : ''}</div></li>`,
            )
            .join('')}</ul>`
        : '<p class="muted">You need at least two readings.</p>'
    }</div>
    <h2>Readings</h2>
    <div class="card">${
      readings.length
        ? `<ul class="list">${readings
            .map(
              (r) => `<li><div class="main"><div><strong>${num(r.value, historyFuel === 'gas' ? 1 : 0)}</strong> ${meterUnit(historyFuel)}${r.reset ? ' <span class="badge">new meter</span>' : ''}</div>
                <div class="tiny">${fmtDateTime(r.at)} · ${r.source === 'photo' ? 'from photo' : 'typed'}</div></div>
                <button class="btn danger small" data-del="${esc(r.id)}" aria-label="Delete reading">Delete</button></li>`,
            )
            .join('')}</ul>`
        : '<p class="muted">No readings yet.</p>'
    }</div>`;
  view.querySelectorAll('[data-fuel]').forEach((b) =>
    b.addEventListener('click', () => {
      historyFuel = b.dataset.fuel;
      renderHistory();
    }),
  );
  view.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Delete this reading?')) return;
      update((s) => (s.readings = s.readings.filter((r) => r.id !== b.dataset.del)));
      renderHistory();
    }),
  );
}

// ---------- settings ----------

let productsCache = null;

function tariffSummary(t) {
  if (!t) return '<span class="muted">Not set</span>';
  const vat = 1 + getState().settings.vatRate;
  if (t.supplier === 'octopus') {
    const segs = tariffSegments([t], t.fuel);
    const cur = segs.find((s) => s.from <= Date.now() && (s.to === null || s.to > Date.now())) || segs[segs.length - 1];
    const prices = cur ? `${num(cur.unit * vat, 2)}p/kWh · ${num(cur.standing * vat, 2)}p/day` : 'prices not loaded';
    return `<strong>Octopus: ${esc(t.label || t.productCode)}</strong><div class="tiny">${esc(t.tariffCode || '')} · ${prices} inc. VAT${
      t.fetchedAt ? ` · updated ${ago(Date.parse(t.fetchedAt))}` : ''
    }</div>`;
  }
  return `<strong>${esc(t.label || 'Other supplier')}</strong><div class="tiny">${num(t.unitRate * vat, 2)}p/kWh · ${num(t.standingCharge * vat, 2)}p/day inc. VAT</div>`;
}

function renderSettings() {
  const s = getState();
  const ai = s.settings.ai;
  view.innerHTML = `
    <h2>Your home</h2>
    <div class="card">
      <label for="postcode">Postcode <span class="tiny">(sets your electricity region for Octopus prices)</span></label>
      <div class="row"><input id="postcode" autocomplete="postal-code" value="${esc(s.settings.postcode)}" placeholder="e.g. M1 1AE" />
        <button class="btn secondary small" id="find-region" type="button" style="flex:none">Find</button></div>
      <label for="region">Region</label>
      <select id="region"><option value="">Choose…</option>${Object.entries(REGIONS)
        .map(([k, v]) => `<option value="${k}" ${s.settings.region === k ? 'selected' : ''}>${k}: ${v}</option>`)
        .join('')}</select>
      <div id="region-msg" class="small"></div>
    </div>

    ${FUELS.map(
      (fuel) => `
      <h2>${fuelName(fuel)} tariff</h2>
      <div class="card" id="tariff-${fuel}">
        <div>${tariffSummary(currentTariff(fuel))}</div>
        <div class="row" style="margin-top:10px">
          ${currentTariff(fuel)?.supplier === 'octopus' ? `<button class="btn secondary small" data-refresh="${fuel}" type="button">Update prices</button>` : ''}
          <button class="btn secondary small" data-edit="${fuel}" type="button">${currentTariff(fuel) ? 'Change tariff or supplier' : 'Set tariff'}</button>
        </div>
        <div class="tariff-form"></div>
        ${
          tariffsFor(fuel).length > 1
            ? `<details><summary>Previous tariffs</summary><ul class="list">${tariffsFor(fuel)
                .filter((t) => t.to)
                .reverse()
                .map(
                  (t) => `<li><div class="main">${tariffSummary(t)}<div class="tiny">${t.from === SINCE_START ? 'Start' : fmtDate(t.from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(t.to, { day: 'numeric', month: 'short', year: 'numeric' })}</div></div>
                  <button class="btn danger small" data-del-tariff="${esc(t.id)}">Delete</button></li>`,
                )
                .join('')}</ul></details>`
            : ''
        }
      </div>`,
    ).join('')}

    <h2>Gas meter</h2>
    <div class="card">
      <label for="gas-units">Gas meter units</label>
      <select id="gas-units">
        <option value="m3" ${s.settings.gas.units === 'm3' ? 'selected' : ''}>Cubic metres (m³): most meters</option>
        <option value="ft3" ${s.settings.gas.units === 'ft3' ? 'selected' : ''}>Hundreds of cubic feet (ft³): older imperial meters</option>
      </select>
      <label for="cv">Calorific value (MJ/m³)</label>
      <input id="cv" inputmode="decimal" value="${esc(s.settings.gas.calorificValue)}" />
      <p class="tiny" style="margin-top:6px">It’s printed on your gas bill. Usually 38–40; 39.5 is a good default.</p>
    </div>

    <h2>Photo reading</h2>
    <div class="card">
      <label for="ai-mode">How photos are read</label>
      <select id="ai-mode">
        <option value="helper" ${ai.mode === 'helper' ? 'selected' : ''}>Family helper link (recommended)</option>
        <option value="own-key" ${ai.mode === 'own-key' ? 'selected' : ''}>My own Claude API key</option>
        <option value="off" ${ai.mode === 'off' ? 'selected' : ''}>Off: I’ll type readings</option>
      </select>
      <div id="ai-helper" ${ai.mode === 'helper' ? '' : 'hidden'}>
        <label for="helper-url">Helper address</label>
        <input id="helper-url" inputmode="url" autocapitalize="off" value="${esc(ai.helperUrl)}" placeholder="https://utility-cost-helper.you.workers.dev" />
        <label for="access-code">Access code</label>
        <input id="access-code" autocapitalize="off" value="${esc(ai.accessCode)}" />
        <p class="tiny" style="margin-top:6px">If someone sent you the app link, this is already filled in.</p>
      </div>
      <div id="ai-key" ${ai.mode === 'own-key' ? '' : 'hidden'}>
        <label for="api-key">Claude API key</label>
        <input id="api-key" type="password" autocapitalize="off" value="${esc(ai.apiKey)}" placeholder="sk-ant-…" />
        <p class="tiny" style="margin-top:6px">Stored only on this phone and sent only to Anthropic.</p>
      </div>
    </div>

    <h2>Share with family</h2>
    <div class="card">
      <p class="small">Send someone a link. They open it in Safari, tap <strong>Share</strong> then <strong>Add to Home Screen</strong>. Their readings stay on their own phone.</p>
      <label class="check"><input type="checkbox" id="share-ai" ${ai.mode === 'helper' && ai.helperUrl ? 'checked' : ''} ${ai.mode === 'helper' && ai.helperUrl ? '' : 'disabled'} /> Include photo reading (uses your helper)</label>
      <button class="btn" id="share" type="button">Share app link</button>
    </div>

    <h2>Install on this iPhone</h2>
    <div class="card small">
      <ol class="steps">
        <li>Open this page in <strong>Safari</strong>.</li>
        <li>Tap the <strong>Share</strong> button <svg class="share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>.</li>
        <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
      </ol>
    </div>

    <h2>Backup</h2>
    <div class="card">
      <p class="small muted">Your readings are stored only on this phone. Save a backup now and then, especially before changing phone.</p>
      <div class="row"><button class="btn secondary" id="export" type="button">Save backup</button>
        <label class="btn secondary" for="import-file">Restore</label></div>
      <input type="file" id="import-file" accept="application/json,.json" hidden />
    </div>
    <p class="tiny" style="text-align:center;margin-top:24px">Estimates only. Your supplier’s bill is based on its own readings and rounding.</p>`;

  // Region
  const setPostcode = () => update((st) => (st.settings.postcode = view.querySelector('#postcode').value.trim().toUpperCase()));
  view.querySelector('#postcode').addEventListener('change', setPostcode);
  view.querySelector('#find-region').addEventListener('click', async () => {
    setPostcode();
    const msg = view.querySelector('#region-msg');
    msg.innerHTML = '<span class="spinner"></span> Looking up…';
    try {
      const region = await regionForPostcode(getState().settings.postcode, getState().settings.ai.helperUrl);
      update((st) => (st.settings.region = region));
      view.querySelector('#region').value = region;
      msg.textContent = `Region ${region}: ${REGIONS[region] || ''}`;
    } catch (err) {
      msg.innerHTML = `<span class="error">${esc(err.message)}</span>`;
    }
  });
  view.querySelector('#region').addEventListener('change', (e) => update((st) => (st.settings.region = e.target.value)));

  // Tariffs
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openTariffForm(b.dataset.edit)));
  view.querySelectorAll('[data-refresh]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.innerHTML = '<span class="spinner"></span>';
      try {
        await refreshOctopus(currentTariff(b.dataset.refresh));
        toast('Prices updated');
      } catch (err) {
        toast(err.message);
      }
      renderSettings();
    }),
  );
  view.querySelectorAll('[data-del-tariff]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Delete this old tariff? Readings from that time will show no cost.')) return;
      update((st) => (st.tariffs = st.tariffs.filter((t) => t.id !== b.dataset.delTariff)));
      renderSettings();
    }),
  );

  // Gas
  view.querySelector('#gas-units').addEventListener('change', (e) => update((st) => (st.settings.gas.units = e.target.value)));
  view.querySelector('#cv').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 30 && v < 50) update((st) => (st.settings.gas.calorificValue = v));
    else {
      e.target.value = getState().settings.gas.calorificValue;
      toast('Calorific value should be between 30 and 50');
    }
  });

  // AI
  view.querySelector('#ai-mode').addEventListener('change', (e) => {
    update((st) => (st.settings.ai.mode = e.target.value));
    renderSettings();
  });
  const bindAi = (id, key, transform = (v) => v.trim()) =>
    view.querySelector(id)?.addEventListener('change', (e) => update((st) => (st.settings.ai[key] = transform(e.target.value))));
  bindAi('#helper-url', 'helperUrl', (v) => v.trim().replace(/\/$/, ''));
  bindAi('#access-code', 'accessCode');
  bindAi('#api-key', 'apiKey');

  // Share
  view.querySelector('#share').addEventListener('click', async () => {
    const base = location.href.split('#')[0];
    const cur = getState().settings.ai;
    let url = base;
    if (view.querySelector('#share-ai').checked && cur.helperUrl) {
      url += '#join=' + encodeJoin({ u: cur.helperUrl, c: cur.accessCode });
    }
    const data = { title: 'Meter Costs', text: 'Track what our gas and electricity cost. Open in Safari, then Share → Add to Home Screen.', url };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      }
    } catch (err) {
      if (err.name !== 'AbortError') prompt('Copy this link:', url);
    }
  });

  // Backup
  view.querySelector('#export').addEventListener('click', async () => {
    const name = `meter-costs-backup-${dayKey(Date.now())}.json`;
    const file = new File([exportJson()], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  view.querySelector('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm('Replace everything on this phone with the backup?')) return;
    try {
      importJson(await file.text());
      toast('Backup restored');
      renderSettings();
    } catch (err) {
      toast(err.message);
    }
  });
}

function openTariffForm(fuel) {
  const s = getState();
  const card = view.querySelector(`#tariff-${fuel}`);
  const holder = card.querySelector('.tariff-form');
  const cur = currentTariff(fuel);
  const today = new Date();
  holder.innerHTML = `
    <form class="t-form" novalidate>
      <label>Supplier</label>
      <div class="segmented" role="group">
        <button type="button" data-sup="octopus" aria-pressed="true">Octopus</button>
        <button type="button" data-sup="manual" aria-pressed="false">Other supplier</button>
      </div>
      <div data-part="octopus">
        ${s.settings.region ? '' : '<div class="notice">Set your postcode or region above first.</div>'}
        <label for="product-${fuel}">Octopus tariff</label>
        <select id="product-${fuel}"><option value="">Loading tariffs…</option></select>
        <label for="code-${fuel}">…or product code <span class="tiny">(from your Octopus account, e.g. VAR-22-11-01)</span></label>
        <input id="code-${fuel}" autocapitalize="characters" autocomplete="off" value="${cur?.supplier === 'octopus' ? esc(cur.productCode) : ''}" />
      </div>
      <div data-part="manual" hidden>
        <label for="label-${fuel}">Supplier / tariff name</label>
        <input id="label-${fuel}" placeholder="e.g. British Gas Standard Variable" value="${cur?.supplier === 'manual' ? esc(cur.label) : ''}" />
        <div class="row">
          <div><label for="unit-${fuel}">Unit rate (p/kWh)</label><input id="unit-${fuel}" inputmode="decimal" placeholder="24.50" /></div>
          <div><label for="stand-${fuel}">Standing charge (p/day)</label><input id="stand-${fuel}" inputmode="decimal" placeholder="60.12" /></div>
        </div>
        <label class="check" style="margin-top:12px"><input type="checkbox" id="incvat-${fuel}" checked /> These prices include VAT</label>
        <p class="tiny" style="margin-top:6px">Both are on your bill or in your supplier app. Environmental and social levies are already built into these two prices.</p>
      </div>
      ${
        cur
          ? `<label for="from-${fuel}">New tariff starts</label><input id="from-${fuel}" type="date" value="${dayKey(today)}" />
             <p class="tiny" style="margin-top:6px">Readings before this date keep the old prices.</p>`
          : ''
      }
      <div class="error" data-err></div>
      <button class="btn" type="submit">Save tariff</button>
      <button class="btn danger" type="button" data-cancel>Cancel</button>
    </form>`;

  let supplier = cur?.supplier === 'manual' ? 'manual' : 'octopus';
  const setSup = (v) => {
    supplier = v;
    holder.querySelectorAll('[data-sup]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.sup === v));
    holder.querySelector('[data-part="octopus"]').hidden = v !== 'octopus';
    holder.querySelector('[data-part="manual"]').hidden = v !== 'manual';
  };
  holder.querySelectorAll('[data-sup]').forEach((b) => b.addEventListener('click', () => setSup(b.dataset.sup)));
  setSup(supplier);
  holder.querySelector('[data-cancel]').addEventListener('click', () => (holder.innerHTML = ''));

  const select = holder.querySelector(`#product-${fuel}`);
  const codeEl = holder.querySelector(`#code-${fuel}`);
  (productsCache ? Promise.resolve(productsCache) : listProducts(s.settings.ai.helperUrl))
    .then((products) => {
      productsCache = products;
      select.innerHTML =
        '<option value="">Choose your tariff…</option>' +
        products.map((p) => `<option value="${esc(p.code)}" ${codeEl.value === p.code ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    })
    .catch(() => {
      select.innerHTML = '<option value="">Couldn’t load list: type the product code below</option>';
    });
  select.addEventListener('change', () => (codeEl.value = select.value));

  holder.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = holder.querySelector('[data-err]');
    err.textContent = '';
    const fromInput = holder.querySelector(`#from-${fuel}`)?.value;
    const from = fromInput ? new Date(fromInput + 'T00:00:00').toISOString() : SINCE_START;
    if (cur && Date.parse(from) <= Date.parse(cur.from) && cur.from !== SINCE_START) {
      if (!confirm('This starts on or before the current tariff, so it will replace it. Continue?')) return;
    }
    const submit = holder.querySelector('button[type=submit]');
    if (supplier === 'manual') {
      const unit = parseFloat(holder.querySelector(`#unit-${fuel}`).value);
      const stand = parseFloat(holder.querySelector(`#stand-${fuel}`).value);
      if (!(unit > 0 && unit < 200) || !(stand >= 0 && stand < 500)) return (err.textContent = 'Enter the unit rate and standing charge in pence.');
      const div = holder.querySelector(`#incvat-${fuel}`).checked ? 1 + getState().settings.vatRate : 1;
      switchTariff({
        fuel,
        supplier: 'manual',
        from,
        label: holder.querySelector(`#label-${fuel}`).value.trim() || 'Other supplier',
        unitRate: unit / div,
        standingCharge: stand / div,
      });
    } else {
      const code = codeEl.value.trim().toUpperCase();
      const region = getState().settings.region;
      if (!region) return (err.textContent = 'Set your region first (top of this page).');
      if (!code) return (err.textContent = 'Choose a tariff or type its product code.');
      submit.disabled = true;
      submit.innerHTML = '<span class="spinner"></span> Getting prices…';
      const draft = {
        id: uid(),
        fuel,
        supplier: 'octopus',
        from,
        productCode: code,
        label: productsCache?.find((p) => p.code === code)?.name || code,
      };
      try {
        await loadOctopusRates(draft);
      } catch (ex) {
        submit.disabled = false;
        submit.textContent = 'Save tariff';
        return (err.textContent = ex.message);
      }
      switchTariff(draft);
    }
    toast(`${fuelName(fuel)} tariff saved`);
    renderSettings();
  });
}

// ---------- Octopus rate refresh ----------

function rateWindowStart(t) {
  const first = readingsFor(t.fuel)[0];
  const earliest = first ? Date.parse(first.at) - DAY : Date.now() - DAY;
  return new Date(Math.max(Date.parse(t.from), earliest));
}

async function loadOctopusRates(t) {
  const since = rateWindowStart(t);
  const s = getState().settings;
  const r = await fetchRates({
    fuel: t.fuel,
    productCode: t.productCode,
    region: s.region,
    sinceIso: since.toISOString(),
    paymentMethod: s.paymentMethod,
    proxyUrl: s.ai.helperUrl,
  });
  t.tariffCode = r.tariffCode;
  t.rates = { unit: r.unit, standing: r.standing, since: since.toISOString() };
  t.fetchedAt = new Date().toISOString();
}

async function refreshOctopus(t) {
  if (!t || t.supplier !== 'octopus') return;
  const copy = structuredClone(t);
  await loadOctopusRates(copy);
  update((s) => {
    const target = s.tariffs.find((x) => x.id === t.id);
    if (target) Object.assign(target, { tariffCode: copy.tariffCode, rates: copy.rates, fetchedAt: copy.fetchedAt });
  });
}

/** Refresh Octopus prices when stale or when readings predate what we fetched. */
async function refreshOctopusIfNeeded(fuel) {
  for (const t of tariffsFor(fuel).filter((x) => x.supplier === 'octopus')) {
    const stale = !t.fetchedAt || Date.now() - Date.parse(t.fetchedAt) > RATE_REFRESH_MS;
    const tooShort = t.rates && rateWindowStart(t) < new Date(t.rates.since);
    if ((!t.to && stale) || tooShort) await refreshOctopus(t);
  }
}

// ---------- family join links ----------

function encodeJoin(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function handleJoinLink() {
  const m = location.hash.match(/^#join=([\w-]+)/);
  if (!m) return false;
  try {
    const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))));
    const { u, c } = JSON.parse(json);
    if (typeof u === 'string' && /^https:\/\//.test(u)) {
      update((s) => {
        s.settings.ai.mode = 'helper';
        s.settings.ai.helperUrl = u;
        s.settings.ai.accessCode = typeof c === 'string' ? c : '';
      });
      setTimeout(() => toast('Photo reading is set up'), 300);
    }
  } catch {
    /* ignore malformed links */
  }
  history.replaceState(null, '', location.pathname + location.search + '#home');
  return true;
}

// ---------- boot ----------

handleJoinLink();
window.addEventListener('hashchange', route);
route();

Promise.all(FUELS.map((f) => refreshOctopusIfNeeded(f)))
  .then(() => {
    if ((location.hash || '#home').startsWith('#home')) renderHome();
  })
  .catch(() => {});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
