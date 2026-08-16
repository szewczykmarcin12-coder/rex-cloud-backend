// REX Cloud P5 — miesięczny Forecast + Cost of Labour.
//
// Założenia:
// - użytkownik podaje dokładną sprzedaż i liczbę transakcji dla miesiąca;
// - historia wyznacza wyłącznie proporcje między dniami (sumy miesiąca zawsze są zachowane);
// - godziny UOP są ograniczeniem twardym, a MGR muszą zmieścić się w etacie +/- tolerancja;
// - każda korekta jest wersjonowana, wymaga powodu i przelicza pozostałe dni;
// - zablokowany plan staje się limitem dla mutacji grafiku.
import crypto from 'crypto';
import { kv, cors, kvConfigured } from './_helpers.js';
import { requireRole } from './auth.js';
import { audit, aktor } from './audit.js';

export const FORECAST_CATEGORIES = ['crew', 'manager', 'functionalManager', 'training', 'managerTraining'];
export const CATEGORY_LABELS = {
  crew: 'Crew',
  manager: 'MGR',
  functionalManager: 'MGR funkcyjne',
  training: 'Szkoleniowe',
  managerTraining: 'MGR szkoleniowe',
};

const DEFAULT_RATES = { crew: 36, manager: 54, functionalManager: 47, training: 36, managerTraining: 50 };
const DEFAULTS = {
  historyWeeks: 8,
  targetSplh: 420,
  targetMpt: 4,
  indirectPct: 0.12,
  colTargetPct: 20,
  employerRate: 0.1948,
  managerToleranceHours: 10,
  fixedHours: { manager: 0, functionalManager: 0, training: 0, managerTraining: 0 },
  rates: DEFAULT_RATES,
  holidays: [],
};

const keyFor = (month) => `forecast:monthly:${month}`;
const lockKeyFor = (month) => `forecast:monthly:lock:${month}`;
const finite = (v) => Number.isFinite(Number(v));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const roundQ = (v) => Math.round((Number(v) || 0) * 4) / 4;
const sum = (xs, fn = (x) => x) => xs.reduce((a, x) => a + (Number(fn(x)) || 0), 0);

export const validMonth = (value) => {
  if (!/^\d{4}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m] = String(value).split('-').map(Number);
  return y >= 2020 && y <= 2100 && m >= 1 && m <= 12;
};

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  try { return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; } catch { return false; }
};

export function monthDates(month) {
  if (!validMonth(month)) return [];
  const [year, mon] = month.split('-').map(Number);
  const n = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

const dow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const addDays = (date, delta) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const median = (values) => {
  const a = values.map(Number).filter((v) => Number.isFinite(v) && v >= 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};

// Największe reszty: rozdziela wartość co do centa / transakcji / kwadransa.
// Gwarancja: suma wyniku jest dokładnie równa total (po kwantyzacji).
export function allocateExact(total, weights, quantum = 0.01) {
  const units = Math.max(0, Math.round(Number(total) / quantum));
  if (!weights.length) return [];
  const safe = weights.map((x) => Math.max(0, Number(x) || 0));
  const sw = sum(safe) || safe.length;
  const raw = safe.map((w) => units * (sw ? w / sw : 1 / safe.length));
  const base = raw.map(Math.floor);
  let left = units - sum(base);
  const order = raw.map((v, i) => ({ i, r: v - base[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let i = 0; i < left; i++) base[order[i % order.length].i]++;
  return base.map((v) => round2(v * quantum));
}

function allocateWithPins(total, dates, weights, pins, quantum, errors, fieldLabel) {
  const out = {};
  const pinned = [];
  const free = [];
  dates.forEach((date, i) => {
    if (pins[date] != null && pins[date] !== '') pinned.push({ date, value: Number(pins[date]) });
    else free.push({ date, weight: weights[i] });
  });
  const pinnedSum = sum(pinned, (x) => x.value);
  if (pinned.some((x) => !Number.isFinite(x.value) || x.value < 0)) errors.push(`${fieldLabel}: korekta zawiera wartość ujemną lub nieprawidłową.`);
  if (pinnedSum > Number(total) + quantum / 2) errors.push(`${fieldLabel}: suma przypiętych dni (${round2(pinnedSum)}) przekracza sumę miesiąca (${round2(total)}).`);
  pinned.forEach((x) => { out[x.date] = round2(x.value); });
  const remaining = Math.max(0, Number(total) - pinnedSum);
  const vals = allocateExact(remaining, free.map((x) => x.weight), quantum);
  free.forEach((x, i) => { out[x.date] = vals[i]; });
  return out;
}

function comparableScores(dates, history, weeks, fallbackMap = null) {
  const all = Object.values(history || {}).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
  const global = median(all) || 1;
  return dates.map((date) => {
    const values = [];
    for (let w = 1; w <= weeks; w++) {
      const d = addDays(date, -7 * w);
      if (d >= dates[0]) continue; // bez future leakage i bez używania dni miesiąca docelowego
      if (history && history[d] != null && finite(history[d])) values.push(Number(history[d]));
    }
    const own = median(values);
    if (own != null && own > 0) return own;
    if (fallbackMap) {
      const fallback = Number(fallbackMap[date]);
      if (Number.isFinite(fallback) && fallback > 0) return fallback;
    }
    return global;
  });
}

function normalizeSettings(raw = {}) {
  const fixed = { ...DEFAULTS.fixedHours, ...(raw.fixedHours || {}) };
  const rates = { ...DEFAULT_RATES, ...(raw.rates || {}) };
  return {
    historyWeeks: clamp(Math.round(Number(raw.historyWeeks) || DEFAULTS.historyWeeks), 2, 52),
    targetSplh: clamp(Number(raw.targetSplh) || DEFAULTS.targetSplh, 50, 5000),
    targetMpt: clamp(Number(raw.targetMpt) || DEFAULTS.targetMpt, 0.1, 60),
    indirectPct: clamp(Number(raw.indirectPct ?? DEFAULTS.indirectPct), 0, 1),
    colTargetPct: clamp(Number(raw.colTargetPct) || DEFAULTS.colTargetPct, 1, 100),
    employerRate: clamp(Number(raw.employerRate ?? DEFAULTS.employerRate), 0, 1),
    managerToleranceHours: clamp(Number(raw.managerToleranceHours ?? DEFAULTS.managerToleranceHours), 0, 50),
    fixedHours: Object.fromEntries(FORECAST_CATEGORIES.filter((x) => x !== 'crew').map((c) => [c, roundQ(Math.max(0, Number(fixed[c]) || 0))])),
    rates: Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, round2(clamp(Number(rates[c]) || DEFAULT_RATES[c], 1, 1000))])),
    holidays: Array.isArray(raw.holidays) ? [...new Set(raw.holidays.filter(validDate))].sort() : [],
  };
}

function accountCategory(account) {
  const role = String(account.funkcja || '').toUpperCase();
  if (['RGM', 'ASM', 'MANAGER'].includes(role)) return 'manager';
  if (['SM', 'JSM', 'MGR FUNKCYJNE'].includes(role)) return 'functionalManager';
  return 'crew';
}

function workingDays(month, holidays = []) {
  const off = new Set(holidays);
  return monthDates(month).filter((d) => { const w = dow(d); return w >= 1 && w <= 5 && !off.has(d); }).length;
}

function contractTarget(account, month, settings, employeeHours = {}) {
  if (finite(employeeHours[account.id]) && Number(employeeHours[account.id]) >= 0) return roundQ(Number(employeeHours[account.id]));
  const weekly = Number(account.wymiarTygH) || 40;
  return roundQ(workingDays(month, settings.holidays) * weekly / 5);
}

function buildContracts(accounts, month, settings, employeeHours = {}) {
  return (accounts || []).filter((a) => a.umowa === 'UOP' && accountCategory(a)).map((a) => {
    const category = accountCategory(a);
    const target = contractTarget(a, month, settings, employeeHours);
    const isManager = category === 'manager' || category === 'functionalManager';
    const tol = isManager ? settings.managerToleranceHours : 0;
    return {
      accountId: a.id,
      name: a.name,
      category,
      targetHours: target,
      minHours: roundQ(Math.max(0, target - tol)),
      maxHours: roundQ(target + tol),
      monthlySalary: round2(Number(a.stawka) || 0),
      plannedHours: target,
    };
  });
}

function distributeManagerContracts(contracts, categoryHours, errors) {
  for (const category of ['manager', 'functionalManager']) {
    const rows = contracts.filter((x) => x.category === category);
    if (!rows.length) continue;
    const min = sum(rows, (x) => x.minHours);
    const max = sum(rows, (x) => x.maxHours);
    const requested = Number(categoryHours[category]) || 0;
    if (requested < min - 0.01 || requested > max + 0.01) {
      errors.push(`${CATEGORY_LABELS[category]}: ${round2(requested)} h nie mieści się w zbiorczym przedziale etatów ${round2(min)}–${round2(max)} h.`);
    }
    const targetTotal = sum(rows, (x) => x.targetHours);
    let diff = roundQ(requested - targetTotal);
    const direction = diff >= 0 ? 1 : -1;
    let guard = 0;
    while (Math.abs(diff) >= 0.24 && guard++ < 100000) {
      let moved = false;
      for (const row of rows) {
        if (Math.abs(diff) < 0.24) break;
        const next = roundQ(row.plannedHours + direction * 0.25);
        if (next < row.minHours - 0.001 || next > row.maxHours + 0.001) continue;
        row.plannedHours = next;
        diff = roundQ(diff - direction * 0.25);
        moved = true;
      }
      if (!moved) break;
    }
  }
}

function derivedRates(accounts, contracts, settings) {
  const rates = { ...settings.rates };
  for (const category of ['crew', 'manager', 'functionalManager']) {
    const values = [];
    for (const account of (accounts || []).filter((a) => accountCategory(a) === category)) {
      if (account.umowa === 'UOP') {
        const c = contracts.find((x) => x.accountId === account.id);
        if (c && c.targetHours > 0 && Number(account.stawka) > 0) values.push(Number(account.stawka) * (1 + settings.employerRate) / c.targetHours);
      } else if (Number(account.stawka) > 0) values.push(Number(account.stawka) * (1 + (account.zus ? settings.employerRate : 0)) + 2);
    }
    // Jawnie wpisana stawka ma pierwszeństwo. Gdy w żądaniu jej nie było, bierzemy medianę kont.
    if ((!settings._ratesProvided || settings._ratesProvided[category] == null) && values.length) rates[category] = round2(median(values));
  }
  return rates;
}

function businessHour(slotIndex) { return (6 + Math.floor(slotIndex / 4)) % 24; }
function slotLabel(slotIndex) {
  const min = (6 * 60 + slotIndex * 15) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function daypartWeight(slotIndex, weekend) {
  const h = businessHour(slotIndex);
  let w = h < 6 ? 0.18 : h < 9 ? 0.35 : h < 11 ? 0.7 : h < 12 ? 1.25 : h < 15 ? 2.25 : h < 17 ? 1.25 : h < 20 ? 2.0 : h < 22 ? 1.45 : h < 24 ? 0.85 : 0.35;
  if (weekend && h >= 12 && h < 22) w *= 1.12;
  return w;
}

function buildSlots(day, settings) {
  const weekend = [0, 6].includes(dow(day.date));
  const weights = Array.from({ length: 96 }, (_, i) => daypartWeight(i, weekend));
  const sales = allocateExact(day.sales, weights, 0.01);
  const transactions = allocateExact(day.transactions, weights, 1);
  const plannedHours = allocateExact(day.hours.total, weights, 0.25);
  return weights.map((_, i) => {
    const directHours = Math.max(sales[i] / settings.targetSplh, transactions[i] * settings.targetMpt / 60);
    const indirectHours = directHours * settings.indirectPct;
    return {
      index: i,
      time: slotLabel(i),
      sales: sales[i],
      transactions: transactions[i],
      directHours: round2(directHours),
      indirectHours: round2(indirectHours),
      requiredPeople: round2((directHours + indirectHours) * 4),
      plannedPeople: round2(plannedHours[i] * 4),
    };
  });
}

function historyQuality(sales, checks, month, weeks) {
  const before = monthDates(month)[0];
  const from = addDays(before, -7 * weeks);
  const salesDates = Object.keys(sales || {}).filter((d) => validDate(d) && d >= from && d < before && finite(sales[d])).sort();
  const checkDates = Object.keys(checks || {}).filter((d) => validDate(d) && d >= from && d < before && finite(checks[d])).sort();
  const coverage = (arr) => Array.from({ length: 7 }, (_, w) => arr.filter((d) => dow(d) === w).length);
  return {
    from,
    to: addDays(before, -1),
    salesDays: salesDates.length,
    transactionDays: checkDates.length,
    salesCoverageByDow: coverage(salesDates),
    transactionCoverageByDow: coverage(checkDates),
    confidence: salesDates.length >= Math.min(28, weeks * 5) ? 'HIGH' : salesDates.length >= 14 ? 'MEDIUM' : 'LOW',
  };
}

function sanitizeOverrides(raw, month) {
  const out = {};
  for (const [date, ov] of Object.entries(raw || {})) {
    if (!validDate(date) || !date.startsWith(`${month}-`) || !ov || typeof ov !== 'object' || Array.isArray(ov)) continue;
    const hours = {};
    for (const c of FORECAST_CATEGORIES) if (ov.hours && ov.hours[c] != null && finite(ov.hours[c])) hours[c] = roundQ(Math.max(0, Number(ov.hours[c])));
    out[date] = {
      ...(ov.sales != null && finite(ov.sales) ? { sales: round2(Math.max(0, Number(ov.sales))) } : {}),
      ...(ov.transactions != null && finite(ov.transactions) ? { transactions: Math.round(Math.max(0, Number(ov.transactions))) } : {}),
      ...(Object.keys(hours).length ? { hours } : {}),
      reason: String(ov.reason || '').slice(0, 300),
      by: ov.by || null,
      at: ov.at || null,
    };
  }
  return out;
}

export function buildMonthlyForecast({ month, monthlySales, monthlyTransactions, settings: rawSettings = {}, history = {}, accounts = [], overrides = {}, employeeHours = {}, scenario = 'BASE' }) {
  const errors = [];
  const warnings = [];
  if (!validMonth(month)) errors.push('Nieprawidłowy miesiąc (wymagane YYYY-MM).');
  if (!finite(monthlySales) || Number(monthlySales) <= 0 || Number(monthlySales) > 100000000) errors.push('Sprzedaż miesiąca musi być liczbą 0–100 000 000 zł.');
  if (!finite(monthlyTransactions) || Number(monthlyTransactions) < 0 || Number(monthlyTransactions) > 10000000) errors.push('Transakcje miesiąca muszą być liczbą 0–10 000 000.');
  if (errors.length) return { valid: false, errors, warnings };

  const dates = monthDates(month);
  const settings = normalizeSettings(rawSettings);
  settings._ratesProvided = rawSettings.rates || {};
  const cleanOverrides = sanitizeOverrides(overrides, month);
  const salesHistory = history.sales || {};
  const checkHistory = history.checks || {};
  const salesWeights = comparableScores(dates, salesHistory, settings.historyWeeks);
  const salesPins = Object.fromEntries(Object.entries(cleanOverrides).filter(([, v]) => v.sales != null).map(([d, v]) => [d, v.sales]));
  const salesByDate = allocateWithPins(round2(monthlySales), dates, salesWeights, salesPins, 0.01, errors, 'Sprzedaż');
  const transactionFallback = Object.fromEntries(dates.map((d) => [d, salesByDate[d]]));
  const checkWeights = comparableScores(dates, checkHistory, settings.historyWeeks, transactionFallback);
  const checkPins = Object.fromEntries(Object.entries(cleanOverrides).filter(([, v]) => v.transactions != null).map(([d, v]) => [d, v.transactions]));
  const checksByDate = allocateWithPins(Math.round(monthlyTransactions), dates, checkWeights, checkPins, 1, errors, 'Transakcje');

  const contracts = buildContracts(accounts, month, settings, employeeHours);
  const contractByCategory = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, roundQ(sum(contracts.filter((x) => x.category === c), (x) => x.targetHours))]));
  const rawDemand = Object.fromEntries(dates.map((date) => {
    const direct = Math.max(salesByDate[date] / settings.targetSplh, checksByDate[date] * settings.targetMpt / 60);
    return [date, roundQ(direct * (1 + settings.indirectPct))];
  }));
  const demandTotal = roundQ(sum(Object.values(rawDemand)));

  const categoryHours = {
    crew: 0,
    manager: settings.fixedHours.manager,
    functionalManager: settings.fixedHours.functionalManager,
    training: settings.fixedHours.training,
    managerTraining: settings.fixedHours.managerTraining,
  };
  for (const c of ['manager', 'functionalManager']) {
    if (categoryHours[c] < contractByCategory[c]) {
      warnings.push(`${CATEGORY_LABELS[c]}: podniesiono plan z ${categoryHours[c]} do ${contractByCategory[c]} h, aby zapewnić godziny UOP.`);
      categoryHours[c] = contractByCategory[c];
    }
  }
  const nonCrew = sum(FORECAST_CATEGORIES.filter((c) => c !== 'crew'), (c) => categoryHours[c]);
  categoryHours.crew = roundQ(Math.max(contractByCategory.crew, demandTotal - nonCrew, 0));
  if (categoryHours.crew === contractByCategory.crew && contractByCategory.crew > Math.max(0, demandTotal - nonCrew) + 0.01) warnings.push('Godziny crew podniesiono do minimum wynikającego z umów UOP.');

  distributeManagerContracts(contracts, categoryHours, errors);
  const rates = derivedRates(accounts, contracts, settings);

  const hoursByCategoryByDate = {};
  for (const category of FORECAST_CATEGORIES) {
    const pins = {};
    for (const date of dates) if (cleanOverrides[date] && cleanOverrides[date].hours && cleanOverrides[date].hours[category] != null) pins[date] = cleanOverrides[date].hours[category];
    const weights = category === 'crew' ? dates.map((d) => rawDemand[d]) : category === 'training' || category === 'managerTraining' ? salesWeights : dates.map(() => 1);
    hoursByCategoryByDate[category] = allocateWithPins(categoryHours[category], dates, weights, pins, 0.25, errors, `Godziny ${CATEGORY_LABELS[category]}`);
  }

  const days = dates.map((date) => {
    const hours = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, roundQ(hoursByCategoryByDate[c][date] || 0)]));
    hours.total = roundQ(sum(FORECAST_CATEGORIES, (c) => hours[c]));
    const costByCategory = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, round2(hours[c] * rates[c])]));
    const cost = round2(sum(FORECAST_CATEGORIES, (c) => costByCategory[c]));
    const day = {
      date,
      dow: dow(date),
      source: cleanOverrides[date] ? 'MANAGER_OVERRIDE' : 'HISTORY_DISTRIBUTION',
      sales: salesByDate[date],
      transactions: checksByDate[date],
      averageCheck: checksByDate[date] ? round2(salesByDate[date] / checksByDate[date]) : 0,
      demandHours: rawDemand[date],
      hours,
      costByCategory,
      cost,
      colPct: salesByDate[date] ? round2(cost / salesByDate[date] * 100) : 0,
      splh: hours.total ? round2(salesByDate[date] / hours.total) : 0,
      mpt: checksByDate[date] ? round2(hours.total * 60 / checksByDate[date]) : 0,
      overrideReason: cleanOverrides[date] ? cleanOverrides[date].reason : null,
    };
    day.slots = buildSlots(day, settings);
    return day;
  });

  const hours = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, roundQ(sum(days, (d) => d.hours[c]))]));
  hours.total = roundQ(sum(FORECAST_CATEGORIES, (c) => hours[c]));
  const costByCategory = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, round2(sum(days, (d) => d.costByCategory[c]))]));
  const cost = round2(sum(FORECAST_CATEGORIES, (c) => costByCategory[c]));
  const targetCost = round2(Number(monthlySales) * settings.colTargetPct / 100);
  if (cost > targetCost + 0.01) errors.push(`Planowany COL ${cost.toFixed(2)} zł przekracza limit ${targetCost.toFixed(2)} zł o ${(cost - targetCost).toFixed(2)} zł.`);
  for (const c of ['crew', 'manager', 'functionalManager']) if (hours[c] + 0.01 < contractByCategory[c]) errors.push(`${CATEGORY_LABELS[c]}: plan nie zapewnia ${contractByCategory[c]} h wynikających z UOP.`);

  const quality = historyQuality(salesHistory, checkHistory, month, settings.historyWeeks);
  if (quality.confidence === 'LOW') warnings.push('Niska pewność rozkładu: mniej niż 14 porównywalnych dni sprzedaży w wybranym oknie.');
  if (quality.transactionDays < 14) warnings.push('Mało danych o transakcjach — część rozkładu trafficu oparto na profilu sprzedaży.');

  delete settings._ratesProvided;
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    month,
    scenario,
    input: { monthlySales: round2(monthlySales), monthlyTransactions: Math.round(monthlyTransactions), settings, employeeHours },
    overrides: cleanOverrides,
    rates,
    historyQuality: quality,
    contracts,
    days,
    totals: {
      sales: round2(sum(days, (d) => d.sales)),
      transactions: Math.round(sum(days, (d) => d.transactions)),
      demandHours: demandTotal,
      hours,
      costByCategory,
      cost,
      targetCost,
      headroom: round2(targetCost - cost),
      colPct: Number(monthlySales) ? round2(cost / Number(monthlySales) * 100) : 0,
      splh: hours.total ? round2(Number(monthlySales) / hours.total) : 0,
      mpt: Number(monthlyTransactions) ? round2(hours.total * 60 / Number(monthlyTransactions)) : 0,
      contractHoursByCategory: contractByCategory,
    },
  };
}

function shiftCategory(shift, account) {
  const trainingRole = String(shift.rola || '').toLowerCase();
  const station = String(shift.station || '').toUpperCase();
  if (trainingRole === 'instruktor' || station === 'INSTRUKTOR') return null; // techniczny duplikat zmiany pracy
  const manager = account && ['RGM', 'ASM', 'MANAGER'].includes(String(account.funkcja || '').toUpperCase());
  const functional = account && ['SM', 'JSM', 'MGR FUNKCYJNE'].includes(String(account.funkcja || '').toUpperCase());
  if (trainingRole === 'training' || station === 'SZKOLENIA' || station === 'TRAINING') return manager || functional ? 'managerTraining' : 'training';
  if (station === 'MANAGER') return 'manager';
  if (station === 'MGR FUNKCYJNE') return 'functionalManager';
  if (manager) return 'manager';
  if (functional) return 'functionalManager';
  return 'crew';
}

function shiftHours(shift) {
  if (finite(shift.hours) && Number(shift.hours) >= 0) return Number(shift.hours);
  const [sh, sm] = String(shift.start || '0:0').split(':').map(Number);
  const [eh, em] = String(shift.end || '0:0').split(':').map(Number);
  let a = sh * 60 + (sm || 0), b = eh * 60 + (em || 0);
  if (b <= a) b += 1440;
  return Math.max(0, (b - a) / 60);
}

export function scheduleCompliance(plan, shifts, accounts = [], { requireContracts = false } = {}) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const hours = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, 0]));
  const hoursByAccount = {};
  for (const shift of shifts || []) {
    const category = shiftCategory(shift, byId.get(shift.accountId));
    if (category) {
      const h = shiftHours(shift);
      hours[category] += h;
      if (shift.accountId) hoursByAccount[shift.accountId] = (hoursByAccount[shift.accountId] || 0) + h;
    }
  }
  for (const c of FORECAST_CATEGORIES) hours[c] = roundQ(hours[c]);
  hours.total = roundQ(sum(FORECAST_CATEGORIES, (c) => hours[c]));
  const costByCategory = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, round2(hours[c] * Number(plan.rates[c] || 0))]));
  const cost = round2(sum(FORECAST_CATEGORIES, (c) => costByCategory[c]));
  const category = Object.fromEntries(FORECAST_CATEGORIES.map((c) => [c, {
    planned: plan.totals.hours[c],
    scheduled: hours[c],
    remaining: roundQ(plan.totals.hours[c] - hours[c]),
  }]));
  const violations = [];
  for (const c of FORECAST_CATEGORIES) if (hours[c] > Number(plan.totals.hours[c]) + 0.01) violations.push(`${CATEGORY_LABELS[c]}: ${hours[c]} h > limit ${plan.totals.hours[c]} h`);
  if (hours.total > Number(plan.totals.hours.total) + 0.01) violations.push(`Godziny total: ${hours.total} h > limit ${plan.totals.hours.total} h`);
  if (cost > Number(plan.totals.targetCost) + 0.01) violations.push(`COL grafiku: ${cost.toFixed(2)} zł > limit ${Number(plan.totals.targetCost).toFixed(2)} zł`);
  const contracts = (plan.contracts || []).map((contract) => {
    const scheduled = roundQ(hoursByAccount[contract.accountId] || 0);
    const required = contract.category === 'crew' ? contract.targetHours : contract.minHours;
    const ok = scheduled + 0.01 >= required && scheduled <= contract.maxHours + 0.01;
    if (requireContracts && scheduled + 0.01 < required) violations.push(`${contract.name}: ${scheduled} h < wymagane ${required} h UOP`);
    if (requireContracts && scheduled > contract.maxHours + 0.01) violations.push(`${contract.name}: ${scheduled} h > maksimum ${contract.maxHours} h`);
    return { ...contract, scheduledHours: scheduled, requiredHours: required, remainingHours: roundQ(required - scheduled), ok };
  });
  return {
    ok: violations.length === 0,
    violations,
    category,
    hours,
    costByCategory,
    cost,
    costHeadroom: round2(Number(plan.totals.targetCost) - cost),
    hoursHeadroom: roundQ(Number(plan.totals.hours.total) - hours.total),
    contracts,
  };
}

export async function enforceLockedForecast(month, shifts, suppliedAccounts = null) {
  if (!validMonth(month)) return { ok: true, locked: false };
  const plan = await kv.get(keyFor(month));
  if (!plan || plan.status !== 'LOCKED') return { ok: true, locked: false };
  const accounts = suppliedAccounts || (await kv.get('accounts:list')) || [];
  const compliance = scheduleCompliance(plan, shifts, accounts);
  return { ...compliance, locked: true, planVersion: plan.version, error: compliance.ok ? null : `Zablokowany Forecast COL nie pozwala przekroczyć planu: ${compliance.violations.join('; ')}` };
}

export async function enforceLockedForecastForPublish(month, shifts, suppliedAccounts = null) {
  if (!validMonth(month)) return { ok: true, locked: false };
  const plan = await kv.get(keyFor(month));
  if (!plan || plan.status !== 'LOCKED') return { ok: true, locked: false };
  const accounts = suppliedAccounts || (await kv.get('accounts:list')) || [];
  const compliance = scheduleCompliance(plan, shifts, accounts, { requireContracts: true });
  return { ...compliance, locked: true, planVersion: plan.version, error: compliance.ok ? null : `Nie można opublikować grafiku niezgodnego z zablokowanym Forecast: ${compliance.violations.join('; ')}` };
}

async function acquireMonthLock(month) {
  const token = crypto.randomUUID();
  const result = await kv.set(lockKeyFor(month), token, { nx: true, ex: 10 });
  return result ? token : null;
}
async function releaseMonthLock(month, token) {
  try { if ((await kv.get(lockKeyFor(month))) === token) await kv.del(lockKeyFor(month)); } catch {}
}

function publicPlan(plan, compliance = null) {
  if (!plan) return null;
  return { ...plan, compliance };
}

function validateGenerateBody(body) {
  const errors = [];
  if (!validMonth(body.month)) errors.push('Miesiąc musi mieć format YYYY-MM.');
  if (!finite(body.monthlySales) || Number(body.monthlySales) <= 0) errors.push('Podaj planowaną sprzedaż miesiąca większą od 0.');
  if (!finite(body.monthlyTransactions) || Number(body.monthlyTransactions) < 0) errors.push('Podaj prawidłową liczbę transakcji.');
  return errors;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!kvConfigured) return res.status(503).json({ success: false, error: 'Baza Upstash nie jest podłączona.' });
  try {
    const session = await requireRole(req, res, ['asm']);
    if (!session) return;
    const action = String((req.query && req.query.action) || '');
    const month = String((req.query && req.query.month) || (req.body && req.body.month) || '');

    if (req.method === 'GET') {
      if (!validMonth(month)) return res.status(400).json({ success: false, error: 'Wskaż month=YYYY-MM.' });
      const plan = await kv.get(keyFor(month));
      const accounts = (await kv.get('accounts:list')) || [];
      const schedule = (await kv.get(`sched:${month}`)) || { shifts: [] };
      const compliance = plan ? scheduleCompliance(plan, schedule.shifts || [], accounts) : null;
      const defaults = normalizeSettings({});
      return res.json({ success: true, exists: !!plan, plan: publicPlan(plan, compliance), defaults });
    }

    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    if (!validMonth(month)) return res.status(400).json({ success: false, error: 'Miesiąc musi mieć format YYYY-MM.' });
    const token = await acquireMonthLock(month);
    if (!token) return res.status(409).json({ success: false, error: 'Forecast tego miesiąca jest właśnie edytowany. Odśwież i spróbuj ponownie.' });
    try {
      const current = await kv.get(keyFor(month));
      const expected = req.body && req.body.expectedVersion;
      if (expected != null && Number(expected) !== Number((current && current.version) || 0)) return res.status(409).json({ success: false, konflikt: true, version: (current && current.version) || 0, error: 'Konflikt wersji Forecast — odśwież dane.' });

      if (action === 'generate') {
        const validation = validateGenerateBody(req.body || {});
        if (validation.length) return res.status(400).json({ success: false, errors: validation, error: validation[0] });
        if (current && current.status === 'LOCKED') return res.status(423).json({ success: false, error: 'Plan jest zablokowany. Najpierw odblokuj go z podaniem powodu.' });
        const salesData = (await kv.get('sales:data')) || {};
        const accounts = (await kv.get('accounts:list')) || [];
        const built = buildMonthlyForecast({
          month,
          monthlySales: req.body.monthlySales,
          monthlyTransactions: req.body.monthlyTransactions,
          settings: req.body.settings || {},
          history: { sales: salesData.sales || {}, checks: salesData.checks || {} },
          accounts,
          overrides: current && req.body.keepOverrides !== false ? current.overrides : {},
          employeeHours: req.body.employeeHours || {},
          scenario: req.body.scenario || 'BASE',
        });
        const now = new Date().toISOString();
        const plan = { ...built, version: Number((current && current.version) || 0) + 1, status: 'DRAFT', createdAt: (current && current.createdAt) || now, updatedAt: now, updatedBy: session.name || session.login };
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(session), action: 'forecast.month.generate', target: `${month}/v${plan.version}`, before: current ? { version: current.version, status: current.status } : null, after: { sales: plan.totals.sales, transactions: plan.totals.transactions, hours: plan.totals.hours.total, cost: plan.totals.cost, valid: plan.valid } });
        const schedule = (await kv.get(`sched:${month}`)) || { shifts: [] };
        return res.json({ success: true, plan: publicPlan(plan, scheduleCompliance(plan, schedule.shifts || [], accounts)) });
      }

      if (!current) return res.status(404).json({ success: false, error: 'Najpierw wygeneruj Forecast dla tego miesiąca.' });

      if (action === 'adjust') {
        if (current.status === 'LOCKED') return res.status(423).json({ success: false, error: 'Plan jest zablokowany. Najpierw go odblokuj.' });
        const { date, patch, reason } = req.body || {};
        if (!validDate(date) || !date.startsWith(`${month}-`)) return res.status(400).json({ success: false, error: 'Korekta musi dotyczyć dnia z wybranego miesiąca.' });
        const why = String(reason || '').trim();
        if (why.length < 3 || why.length > 300) return res.status(400).json({ success: false, error: 'Korekta wymaga uzasadnienia (3–300 znaków).' });
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ success: false, error: 'Brak danych korekty.' });
        const nextOverrides = { ...(current.overrides || {}), [date]: { ...(current.overrides && current.overrides[date] || {}), ...patch, hours: { ...((current.overrides && current.overrides[date] && current.overrides[date].hours) || {}), ...((patch && patch.hours) || {}) }, reason: why, by: session.name || session.login, at: new Date().toISOString() } };
        const salesData = (await kv.get('sales:data')) || {};
        const accounts = (await kv.get('accounts:list')) || [];
        const built = buildMonthlyForecast({ month, monthlySales: current.input.monthlySales, monthlyTransactions: current.input.monthlyTransactions, settings: current.input.settings, history: { sales: salesData.sales || {}, checks: salesData.checks || {} }, accounts, overrides: nextOverrides, employeeHours: current.input.employeeHours || {}, scenario: current.scenario });
        const plan = { ...current, ...built, version: current.version + 1, status: 'DRAFT', updatedAt: new Date().toISOString(), updatedBy: session.name || session.login };
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(session), action: 'forecast.month.adjust', target: `${month}/${date}/v${plan.version}`, before: current.overrides && current.overrides[date] || null, after: plan.overrides[date], reason: why });
        const schedule = (await kv.get(`sched:${month}`)) || { shifts: [] };
        return res.json({ success: true, plan: publicPlan(plan, scheduleCompliance(plan, schedule.shifts || [], accounts)) });
      }

      if (action === 'clear-adjustment') {
        if (current.status === 'LOCKED') return res.status(423).json({ success: false, error: 'Plan jest zablokowany. Najpierw go odblokuj.' });
        const { date, reason } = req.body || {};
        if (!validDate(date) || !date.startsWith(`${month}-`)) return res.status(400).json({ success: false, error: 'Wskaż dzień z wybranego miesiąca.' });
        const why = String(reason || '').trim();
        if (why.length < 3 || why.length > 300) return res.status(400).json({ success: false, error: 'Usunięcie korekty wymaga uzasadnienia (3–300 znaków).' });
        const nextOverrides = { ...(current.overrides || {}) };
        const before = nextOverrides[date] || null;
        delete nextOverrides[date];
        const salesData = (await kv.get('sales:data')) || {};
        const accounts = (await kv.get('accounts:list')) || [];
        const built = buildMonthlyForecast({ month, monthlySales: current.input.monthlySales, monthlyTransactions: current.input.monthlyTransactions, settings: current.input.settings, history: { sales: salesData.sales || {}, checks: salesData.checks || {} }, accounts, overrides: nextOverrides, employeeHours: current.input.employeeHours || {}, scenario: current.scenario });
        const plan = { ...current, ...built, version: current.version + 1, status: 'DRAFT', updatedAt: new Date().toISOString(), updatedBy: session.name || session.login };
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(session), action: 'forecast.month.adjust-clear', target: `${month}/${date}/v${plan.version}`, before, reason: why });
        const schedule = (await kv.get(`sched:${month}`)) || { shifts: [] };
        return res.json({ success: true, plan: publicPlan(plan, scheduleCompliance(plan, schedule.shifts || [], accounts)) });
      }

      if (action === 'lock') {
        if (current.status === 'LOCKED') return res.json({ success: true, plan: current });
        if (!current.valid || (current.errors || []).length) return res.status(409).json({ success: false, error: 'Nie można zablokować planu z błędami.', errors: current.errors || [] });
        const accounts = (await kv.get('accounts:list')) || [];
        const schedule = (await kv.get(`sched:${month}`)) || { shifts: [] };
        const compliance = scheduleCompliance(current, schedule.shifts || [], accounts);
        if (!compliance.ok) return res.status(409).json({ success: false, error: 'Aktualny grafik już przekracza plan. Najpierw popraw grafik lub Forecast.', violations: compliance.violations });
        const plan = { ...current, status: 'LOCKED', version: current.version + 1, lockedAt: new Date().toISOString(), lockedBy: session.name || session.login, updatedAt: new Date().toISOString() };
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(session), action: 'forecast.month.lock', target: `${month}/v${plan.version}`, after: { costLimit: plan.totals.targetCost, hoursLimit: plan.totals.hours } });
        return res.json({ success: true, plan: publicPlan(plan, compliance) });
      }

      if (action === 'unlock') {
        const why = String((req.body && req.body.reason) || '').trim();
        if (why.length < 3 || why.length > 300) return res.status(400).json({ success: false, error: 'Odblokowanie wymaga uzasadnienia (3–300 znaków).' });
        const plan = { ...current, status: 'DRAFT', version: current.version + 1, updatedAt: new Date().toISOString(), updatedBy: session.name || session.login, lastUnlock: { at: new Date().toISOString(), by: session.name || session.login, reason: why } };
        delete plan.lockedAt; delete plan.lockedBy;
        await kv.set(keyFor(month), plan);
        await audit({ ...aktor(session), action: 'forecast.month.unlock', target: `${month}/v${plan.version}`, reason: why });
        const accounts = (await kv.get('accounts:list')) || [];
        const schedule = (await kv.get(`sched:${month}`)) || { shifts: [] };
        return res.json({ success: true, plan: publicPlan(plan, scheduleCompliance(plan, schedule.shifts || [], accounts)) });
      }

      return res.status(400).json({ success: false, error: 'Nieznana akcja Forecast.' });
    } finally {
      await releaseMonthLock(month, token);
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
