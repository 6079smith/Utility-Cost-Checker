// Stacked daily-cost bar chart (electricity + gas) as inline SVG, with a
// hover/tap tooltip and a table fallback.

const W = 600;
const H = 240;
const PAD = { top: 8, right: 4, bottom: 34, left: 58 };
const FUELS = [
  { key: 'electricity', label: 'Electricity' },
  { key: 'gas', label: 'Gas' },
];

const pounds = (p, dp = 2) => '£' + (p / 100).toFixed(dp);

function niceMax(v) {
  if (v <= 0) return 100;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

// Rounded top corners only; the bar stays square where it meets the baseline
// or the segment beneath it.
function topRoundedRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * @param {HTMLElement} el
 * @param {{key:string,label:string,electricity:number,gas:number,partial:boolean}[]} days  pence per fuel per day
 */
export function renderDailyChart(el, days) {
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...days.map((d) => d.electricity + d.gas), 0));
  const slot = plotW / days.length;
  const barW = Math.max(2, slot - Math.max(2, slot * 0.25));
  const y = (p) => PAD.top + plotH - (p / max) * plotH;

  const ticks = [0, max / 2, max];
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cost, last ${days.length} days">`;
  for (const t of ticks) {
    svg += `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text class="axis-label" x="${PAD.left - 6}" y="${y(t) + 4}" text-anchor="end">${pounds(t, t % 100 ? 2 : 0)}</text>`;
  }
  const labelIdx = new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]);
  days.forEach((d, i) => {
    const x = PAD.left + i * slot + (slot - barW) / 2;
    let base = 0;
    const present = FUELS.filter((f) => d[f.key] > 0);
    present.forEach((f, j) => {
      const top = base + d[f.key];
      const y0 = y(base);
      const y1 = y(top);
      // 2px surface gap between stacked segments.
      const gap = j > 0 ? 2 : 0;
      const h = Math.max(0, y0 - y1 - gap);
      const isTop = j === present.length - 1;
      svg += isTop
        ? `<path class="bar-${f.key}" d="${topRoundedRect(x, y1, barW, h, 4)}"/>`
        : `<rect class="bar-${f.key}" x="${x}" y="${y1}" width="${barW}" height="${h}"/>`;
      base = top;
    });
    if (labelIdx.has(i)) {
      const anchor = i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle';
      const lx = i === 0 ? PAD.left + i * slot : i === days.length - 1 ? PAD.left + (i + 1) * slot : x + barW / 2;
      svg += `<text class="axis-label" x="${lx}" y="${H - 8}" text-anchor="${anchor}">${d.label}</text>`;
    }
    svg += `<rect class="hit" data-i="${i}" x="${PAD.left + i * slot}" y="${PAD.top}" width="${slot}" height="${plotH}"/>`;
  });
  svg += '</svg>';

  el.innerHTML = `
    <div class="legend">${FUELS.map((f) => `<span><i class="swatch ${f.key}"></i>${f.label}</span>`).join('')}</div>
    <div class="chart-wrap"><div class="chart">${svg}</div><div class="tooltip"></div></div>`;

  const wrap = el.querySelector('.chart-wrap');
  const tip = el.querySelector('.tooltip');
  let active = null;
  const show = (target) => {
    const i = Number(target.dataset.i);
    active?.classList.remove('active');
    active = target;
    target.classList.add('active');
    const d = days[i];
    tip.innerHTML =
      `<strong>${d.longLabel}</strong>` +
      FUELS.map((f) => `<div class="t-row"><i class="swatch ${f.key}"></i>${f.label}: ${d[f.key] ? pounds(d[f.key]) : '—'}</div>`).join('') +
      `<div class="t-row">Total: <strong>${pounds(d.electricity + d.gas)}</strong></div>` +
      (d.partial ? '<div class="tiny">Part day (readings cover some of it)</div>' : '');
    tip.style.display = 'block';
    const box = wrap.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const cx = r.left - box.left + r.width / 2;
    const left = Math.min(Math.max(0, cx - tip.offsetWidth / 2), box.width - tip.offsetWidth);
    tip.style.left = left + 'px';
    tip.style.top = -tip.offsetHeight - 6 + 'px';
  };
  const hide = () => {
    active?.classList.remove('active');
    active = null;
    tip.style.display = 'none';
  };
  wrap.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('pointerenter', () => show(h));
    h.addEventListener('pointerdown', () => show(h));
  });
  wrap.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hide());
}
