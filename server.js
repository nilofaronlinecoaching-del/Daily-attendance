'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'attendance.json');
const PORT = Number(process.env.PORT || 4173);
const INITIAL_ADMIN_PIN = String(process.env.ADMIN_PIN || '2468');
const INITIAL_PRINCIPAL_PIN = String(process.env.PRINCIPAL_PIN || '5678');

const DEFAULT_GROUPS = [
  { key: 'NUR', name: 'Nursery', short: 'NUR', sections: [''] },
  { key: 'KG', name: 'K.G.', short: 'K.G.', sections: ['A', 'B'] },
  { key: 'I', name: 'Class I', short: 'I', sections: ['A', 'B', 'C'] },
  { key: 'II', name: 'Class II', short: 'II', sections: ['A', 'B', 'C'] },
  { key: 'III', name: 'Class III', short: 'III', sections: ['A', 'B', 'C'] },
  { key: 'IV', name: 'Class IV', short: 'IV', sections: ['A', 'B', 'C'] },
  { key: 'V', name: 'Class V', short: 'V', sections: ['A', 'B', 'C', 'D'] },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeGroups(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 30) return null;
  const groupKeys = new Set();
  const classKeys = new Set();
  const groups = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    const key = String(raw.key || '').trim().toUpperCase();
    const name = String(raw.name || '').trim().slice(0, 40);
    const short = String(raw.short || key).trim().slice(0, 12);
    if (!/^[A-Z0-9]{1,8}$/.test(key) || !name || !short || !/^[A-Z0-9. ]{1,12}$/i.test(short) || groupKeys.has(key)) return null;
    if (!Array.isArray(raw.sections) || raw.sections.length > 12) return null;
    const sections = raw.sections.map((value) => {
      const section = String(value == null ? '' : value).trim().toUpperCase();
      return section === '-' || section === '—' || section === 'NONE' ? '' : section;
    });
    if (!sections.length) sections.push('');
    if (sections.some((section) => section !== '' && !/^[A-Z0-9]{1,4}$/.test(section))) return null;
    if (new Set(sections).size !== sections.length) return null;
    for (const section of sections) {
      const classKey = `${key}${section}`;
      if (classKeys.has(classKey)) return null;
      classKeys.add(classKey);
    }
    groupKeys.add(key);
    groups.push({ key, name, short, sections });
  }
  return groups;
}

function classesFromGroups(groups) {
  return groups.flatMap((group) => group.sections.map((section) => {
    const key = `${group.key}${section}`;
    let label;
    if (!section) label = group.short || group.key;
    else if (group.key === 'KG' || String(group.short).endsWith('.')) label = `${group.short}${section}`;
    else label = `${group.short} ${section}`;
    return { key, label, grade: group.name, groupKey: group.key, section, active: true };
  }));
}

const DEFAULT_CLASSES = classesFromGroups(DEFAULT_GROUPS);
const DEFAULT_CLASS_BY_KEY = new Map(DEFAULT_CLASSES.map((item) => [item.key, item]));

function todayIST() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,12}$/.test(pin);
}

function recordKey(date, classKey) {
  return `${date}|${classKey}`;
}

function defaultSessionStartDate(today = todayIST()) {
  const [year, month] = today.split('-').map(Number);
  return `${month >= 4 ? year : year - 1}-04-01`;
}

function normalizeSessionSettings(input) {
  const startDate = validDate(input?.startDate) ? input.startDate : defaultSessionStartDate();
  const openingByClass = {};
  const raw = input?.openingByClass && typeof input.openingByClass === 'object' && !Array.isArray(input.openingByClass) ? input.openingByClass : {};
  for (const [classKey, counts] of Object.entries(raw)) {
    if (!/^[A-Z0-9]{1,12}$/i.test(classKey) || !counts || typeof counts !== 'object') continue;
    const startingRaw = counts.startingTotal;
    const startingTotal = startingRaw !== '' && startingRaw != null && Number.isInteger(Number(startingRaw)) && Number(startingRaw) >= 0 && Number(startingRaw) <= 500 ? Number(startingRaw) : null;
    openingByClass[classKey] = { startingTotal, ...Object.fromEntries(['admission', 'withdrawal', 'dormant'].map((field) => {
      const value = Number(counts[field] ?? 0);
      return [field, Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : 0];
    })) };
  }
  return { startDate, openingByClass };
}

function emptyStore() {
  return {
    records: [], history: [], deletedRecords: [], reopenAllowed: {},
    groups: clone(DEFAULT_GROUPS),
    pins: { admin: INITIAL_ADMIN_PIN, principal: INITIAL_PRINCIPAL_PIN },
    session: normalizeSessionSettings(null),
  };
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const groups = normalizeGroups(parsed.groups) || clone(DEFAULT_GROUPS);
    return {
      records: Array.isArray(parsed.records) ? parsed.records.map(normalizeStoredRecord) : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      deletedRecords: Array.isArray(parsed.deletedRecords) ? parsed.deletedRecords : [],
      reopenAllowed: parsed.reopenAllowed && typeof parsed.reopenAllowed === 'object' ? parsed.reopenAllowed : {},
      groups,
      pins: {
        admin: validPin(parsed.pins?.admin) ? parsed.pins.admin : INITIAL_ADMIN_PIN,
        principal: validPin(parsed.pins?.principal) ? parsed.pins.principal : INITIAL_PRINCIPAL_PIN,
      },
      session: normalizeSessionSettings(parsed.session),
    };
  } catch (_) {
    return emptyStore();
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporary, DATA_FILE);
}

function getClasses(store) {
  return classesFromGroups(store.groups);
}

function reportClasses(store, records) {
  const classes = getClasses(store);
  const seen = new Set(classes.map((item) => item.key));
  for (const record of records) {
    if (seen.has(record.classKey)) continue;
    const fallback = DEFAULT_CLASS_BY_KEY.get(record.classKey);
    classes.push({
      key: record.classKey,
      label: record.classLabel || fallback?.label || record.classKey,
      grade: record.grade || fallback?.grade || 'Archived class',
      groupKey: record.groupKey || fallback?.groupKey || 'ARCHIVED',
      section: record.section || fallback?.section || '',
      active: false,
    });
    seen.add(record.classKey);
  }
  const activeOrder = new Map(getClasses(store).map((item, index) => [item.key, index]));
  const oldOrder = new Map(DEFAULT_CLASSES.map((item, index) => [item.key, index]));
  return classes.sort((a, b) => {
    const aa = activeOrder.has(a.key) ? activeOrder.get(a.key) : 1000 + (oldOrder.get(a.key) ?? 999);
    const bb = activeOrder.has(b.key) ? activeOrder.get(b.key) : 1000 + (oldOrder.get(b.key) ?? 999);
    return aa - bb || a.label.localeCompare(b.label);
  });
}

function sortRecords(records, classes) {
  const order = new Map(classes.map((item, index) => [item.key, index]));
  return records.slice().sort((a, b) => (order.get(a.classKey) ?? 9999) - (order.get(b.classKey) ?? 9999));
}

function withPermission(store, records) {
  return sortRecords(records, reportClasses(store, records)).map((record) => ({
    ...record,
    reopenAllowed: store.reopenAllowed[recordKey(record.date, record.classKey)] === true,
  }));
}

function pinMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const given = Buffer.from(candidate, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function isAdmin(req, store = loadStore()) {
  return pinMatches(req.headers['x-admin-pin'], store.pins.admin);
}

function isPrincipal(req, store = loadStore()) {
  return pinMatches(req.headers['x-principal-pin'], store.pins.principal);
}

function isAdminOrPrincipal(req, store = loadStore()) {
  return isAdmin(req, store) || isPrincipal(req, store);
}

function validDateForSchool(date, today) {
  return validDate(date) && date <= today;
}

function validateCounts(body) {
  const baseTotal = Number(body.baseTotal ?? body.total);
  const admission = Number(body.admission ?? 0);
  const withdrawal = Number(body.withdrawal ?? 0);
  const dormant = Number(body.dormant ?? 0);
  const total = baseTotal + admission - withdrawal - dormant;
  const present = Number(body.present);
  const aadhaar = Number(body.aadhaar);
  const bank = Number(body.bank);
  const counts = [baseTotal, admission, withdrawal, dormant, present, aadhaar, bank];
  if (!counts.every(Number.isInteger)) return { error: 'Enter whole-number student counts.' };
  if (baseTotal < 0 || baseTotal > 500 || admission < 0 || admission > 500 || withdrawal < 0 || withdrawal > 500 || dormant < 0 || dormant > 500) return { error: 'Starting total and daily movement counts must be between 0 and 500.' };
  if (total < 0 || total > 500) return { error: 'Current class strength must be between 0 and 500 after movements.' };
  if (body.total != null && body.total !== '' && Number(body.total) !== total) return { error: 'Current class strength does not match the movement calculation.' };
  if (present < 0 || present > total) return { error: 'Present students cannot exceed the current class strength.' };
  if (aadhaar < 0 || aadhaar > total) return { error: 'Aadhaar count cannot exceed the current class strength.' };
  if (bank < 0 || bank > total) return { error: 'Bank account count cannot exceed the current class strength.' };
  return { baseTotal, admission, withdrawal, dormant, total, present, absent: total - present, aadhaar, bank };
}

function normalizeStoredRecord(record) {
  const admission = Number.isInteger(Number(record?.admission)) ? Number(record.admission) : 0;
  const withdrawal = Number.isInteger(Number(record?.withdrawal)) ? Number(record.withdrawal) : 0;
  const dormant = Number.isInteger(Number(record?.dormant)) ? Number(record.dormant) : 0;
  const storedTotal = Number.isInteger(Number(record?.total)) ? Number(record.total) : 0;
  const baseTotal = Number.isInteger(Number(record?.baseTotal)) ? Number(record.baseTotal) : storedTotal - admission + withdrawal + dormant;
  const total = baseTotal + admission - withdrawal - dormant;
  const present = Number.isInteger(Number(record?.present)) ? Number(record.present) : 0;
  return { ...record, baseTotal, admission, withdrawal, dormant, total, present, absent: total - present };
}

function publicSessionSettings(input) {
  const session = normalizeSessionSettings(input);
  const openingByClass = {};
  for (const [classKey, counts] of Object.entries(session.openingByClass)) {
    openingByClass[classKey] = { startingTotal: counts.startingTotal };
  }
  return { startDate: session.startDate, openingByClass };
}

function sessionSummary(store, throughDate) {
  const settings = normalizeSessionSettings(store.session);
  const includeOpening = throughDate >= settings.startDate;
  const openingTotals = { admission: 0, withdrawal: 0, dormant: 0 };
  if (includeOpening) for (const counts of Object.values(settings.openingByClass)) {
    for (const field of Object.keys(openingTotals)) openingTotals[field] += counts[field] || 0;
  }
  const records = store.records.map(normalizeStoredRecord).filter((record) => record.date >= settings.startDate && record.date <= throughDate);
  const totals = { ...openingTotals };
  for (const record of records) {
    totals.admission += record.admission;
    totals.withdrawal += record.withdrawal;
    totals.dormant += record.dormant;
  }
  const classes = reportClasses(store, records);
  const order = new Map(classes.map((item, index) => [item.key, index]));
  const movements = records.filter((record) => record.admission || record.withdrawal || record.dormant)
    .map((record) => ({ date: record.date, classKey: record.classKey, classLabel: record.classLabel || classes.find((item) => item.key === record.classKey)?.label || record.classKey, admission: record.admission, withdrawal: record.withdrawal, dormant: record.dormant }))
    .sort((a, b) => b.date.localeCompare(a.date) || (order.get(a.classKey) ?? 9999) - (order.get(b.classKey) ?? 9999));
  const history = store.history.filter((item) => item.date >= settings.startDate && item.date <= throughDate).slice().sort((a, b) => String(b.editedAt || '').localeCompare(String(a.editedAt || '')));
  return { startDate: settings.startDate, throughDate, openingTotals, totals, openingByClass: settings.openingByClass, movements, history };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

async function readBody(req, res) {
  try { return await readJson(req); }
  catch (error) {
    sendJson(res, 400, { message: error.message || 'Invalid request.' });
    return null;
  }
}

function error(res, status, message) {
  sendJson(res, status, { message });
}

function publicFile(res, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch (_) { return error(res, 400, 'Invalid path.'); }
  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return error(res, 403, 'Forbidden.');
  let content;
  try { content = fs.readFileSync(filePath); }
  catch (_) { return error(res, 404, 'Not found.'); }
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors *",
  });
  res.end(content);
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const today = todayIST();
  let store;

  if (req.method === 'GET' && route === '/api/config') {
    store = loadStore();
    return sendJson(res, 200, { today, groups: store.groups, classes: getClasses(store), session: publicSessionSettings(store.session) });
  }

  if (req.method === 'GET' && route === '/api/records') {
    const date = url.searchParams.get('date') || today;
    if (!validDateForSchool(date, today)) return error(res, 400, 'Choose a valid date that is not in the future.');
    store = loadStore();
    const records = store.records.filter((item) => item.date === date);
    return sendJson(res, 200, { date, records: withPermission(store, records), classes: reportClasses(store, records), groups: store.groups, session: publicSessionSettings(store.session) });
  }

  if (req.method === 'GET' && route === '/api/previous') {
    const date = url.searchParams.get('date') || today;
    const classKey = url.searchParams.get('classKey') || '';
    if (!validDateForSchool(date, today)) return error(res, 400, 'Choose a valid date that is not in the future.');
    store = loadStore();
    if (!getClasses(store).some((item) => item.key === classKey)) return error(res, 400, 'Choose a valid class and section.');
    const previous = store.records
      .filter((item) => item.classKey === classKey && item.date < date)
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.submittedAt).localeCompare(String(a.submittedAt)))[0] || null;
    return sendJson(res, 200, { date, classKey, record: previous });
  }

  if (req.method === 'POST' && route === '/api/submit') {
    const body = await readBody(req, res);
    if (!body) return;
    if (!validDateForSchool(body.date, today)) return error(res, 400, 'Choose a valid attendance date that is not in the future.');
    store = loadStore();
    const classItem = getClasses(store).find((item) => item.key === body.classKey);
    if (!classItem) return error(res, 400, 'Choose a valid class and section.');
    const counts = validateCounts(body);
    if (counts.error) return error(res, 400, counts.error);
    const key = recordKey(body.date, body.classKey);
    const existingIndex = store.records.findIndex((item) => item.date === body.date && item.classKey === body.classKey);
    const existing = existingIndex >= 0 ? store.records[existingIndex] : null;
    if (existing && store.reopenAllowed[key] !== true) {
      return sendJson(res, 409, { message: 'This class attendance has already been submitted. Ask the admin to allow one resubmission.', record: { ...existing, reopenAllowed: false } });
    }
    const submittedAt = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(), date: body.date, classKey: body.classKey,
      classLabel: classItem.label, groupKey: classItem.groupKey, section: classItem.section,
      ...counts, submittedAt, revision: existing ? (Number(existing.revision) || 1) + 1 : 1,
    };
    if (existing) {
      store.history.push({ action: 'resubmit', date: body.date, classKey: body.classKey, editedAt: submittedAt, oldRecord: existing, newRecord: record });
      store.records[existingIndex] = record;
      delete store.reopenAllowed[key];
    } else store.records.push(record);
    saveStore(store);
    return sendJson(res, 201, { message: existing ? 'Attendance updated after admin approval.' : 'Attendance submitted.', replaced: Boolean(existing), record });
  }

  if (req.method === 'POST' && route === '/api/admin/verify') {
    const body = await readBody(req, res);
    if (!body) return;
    store = loadStore();
    if (!pinMatches(body.pin, store.pins.admin)) return error(res, 401, 'Incorrect admin PIN.');
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/api/principal/verify') {
    const body = await readBody(req, res);
    if (!body) return;
    store = loadStore();
    if (!pinMatches(body.pin, store.pins.principal)) return error(res, 401, 'Incorrect Principal PIN.');
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && route === '/api/admin/records') {
    store = loadStore();
    if (!isAdminOrPrincipal(req, store)) return error(res, 401, 'Admin or Principal access required.');
    const date = url.searchParams.get('date') || today;
    if (!validDateForSchool(date, today)) return error(res, 400, 'Choose a valid date that is not in the future.');
    const records = store.records.filter((item) => item.date === date);
    const summary = url.searchParams.get('includeSession') === 'false' ? null : sessionSummary(store, date);
    return sendJson(res, 200, { date, records: withPermission(store, records), history: store.history.filter((item) => item.date === date), classes: reportClasses(store, records), groups: store.groups, sessionSettings: store.session, sessionSummary: summary });
  }

  if (req.method === 'GET' && route === '/api/principal/records') {
    store = loadStore();
    if (!isPrincipal(req, store)) return error(res, 401, 'Principal access required.');
    const date = url.searchParams.get('date') || today;
    if (!validDateForSchool(date, today)) return error(res, 400, 'Choose a valid date that is not in the future.');
    const records = store.records.filter((item) => item.date === date);
    const deletedRecords = store.deletedRecords.filter((item) => item.date === date);
    const summary = url.searchParams.get('includeSession') === 'false' ? null : sessionSummary(store, date);
    return sendJson(res, 200, { date, records: withPermission(store, records), history: store.history.filter((item) => item.date === date), deletedRecords, classes: reportClasses(store, records), groups: store.groups, sessionSettings: store.session, sessionSummary: summary });
  }

  if (req.method === 'POST' && route === '/api/admin/unlock') {
    store = loadStore();
    if (!isAdminOrPrincipal(req, store)) return error(res, 401, 'Admin or Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    if (!validDateForSchool(body.date, today)) return error(res, 400, 'Choose a valid date that is not in the future.');
    const exists = store.records.some((item) => item.date === body.date && item.classKey === body.classKey);
    if (!exists) return error(res, 404, 'No submitted attendance found for this class and date.');
    const key = recordKey(body.date, body.classKey);
    if (store.reopenAllowed[key] !== true) {
      store.reopenAllowed[key] = true;
      saveStore(store);
    }
    return sendJson(res, 200, { ok: true, alreadyAllowed: false, message: 'One resubmission is now allowed.' });
  }

  if (req.method === 'POST' && route === '/api/admin/change-pin') {
    store = loadStore();
    if (!isAdmin(req, store)) return error(res, 401, 'Admin access required.');
    const body = await readBody(req, res);
    if (!body) return;
    if (!validPin(body.newPin)) return error(res, 400, 'PIN must contain 4–12 digits.');
    store.pins.admin = body.newPin;
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Admin PIN changed.' });
  }

  if (req.method === 'POST' && route === '/api/principal/change-pin') {
    store = loadStore();
    if (!isPrincipal(req, store)) return error(res, 401, 'Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    if (!validPin(body.newPin)) return error(res, 400, 'PIN must contain 4–12 digits.');
    store.pins.principal = body.newPin;
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Principal PIN changed.' });
  }

  if (req.method === 'POST' && route === '/api/principal/admin-pin') {
    store = loadStore();
    if (!isPrincipal(req, store)) return error(res, 401, 'Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    if (!validPin(body.newPin)) return error(res, 400, 'PIN must contain 4–12 digits.');
    store.pins.admin = body.newPin;
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Admin PIN changed by Principal.' });
  }

  if (req.method === 'POST' && route === '/api/admin/session-settings') {
    store = loadStore();
    if (!isAdminOrPrincipal(req, store)) return error(res, 401, 'Admin or Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    if (!validDateForSchool(body.startDate, today)) return error(res, 400, 'Choose a valid session start date that is not in the future.');
    const rawOpening = body.openingByClass && typeof body.openingByClass === 'object' && !Array.isArray(body.openingByClass) ? body.openingByClass : null;
    if (!rawOpening || Object.keys(rawOpening).length > 200) return error(res, 400, 'Opening balances must be a class-by-class object.');
    for (const [classKey, counts] of Object.entries(rawOpening)) {
      if (!/^[A-Z0-9]{1,12}$/i.test(classKey) || !counts || typeof counts !== 'object' || (!((counts.startingTotal == null || counts.startingTotal === '') || (Number.isInteger(Number(counts.startingTotal)) && Number(counts.startingTotal) >= 0 && Number(counts.startingTotal) <= 500)) || ['admission', 'withdrawal', 'dormant'].some((field) => !Number.isInteger(Number(counts[field] ?? 0)) || Number(counts[field] ?? 0) < 0 || Number(counts[field] ?? 0) > 1000000))) {
        return error(res, 400, 'Opening movement counts must be whole numbers between 0 and 1,000,000.');
      }
    }
    store.session = normalizeSessionSettings({ startDate: body.startDate, openingByClass: rawOpening });
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Session settings and opening balances saved.', session: store.session });
  }

  if (req.method === 'POST' && route === '/api/admin/classes') {
    store = loadStore();
    if (!isAdminOrPrincipal(req, store)) return error(res, 401, 'Admin or Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    const groups = normalizeGroups(body.groups);
    if (!groups) return error(res, 400, 'Class list is invalid. Check class keys, names, and section codes.');
    store.groups = groups;
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Classes and sections updated.', groups: store.groups, classes: getClasses(store) });
  }

  if (req.method === 'POST' && route === '/api/principal/update-record') {
    store = loadStore();
    if (!isPrincipal(req, store)) return error(res, 401, 'Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    const { date, classKey, newClassKey } = body;
    if (!validDateForSchool(date, today)) return error(res, 400, 'Choose a valid date that is not in the future.');
    const index = store.records.findIndex((item) => item.date === date && item.classKey === classKey);
    if (index < 0) return error(res, 404, 'Active attendance record not found.');
    const targetKey = newClassKey || classKey;
    const currentRecord = store.records[index];
    const activeTarget = getClasses(store).find((item) => item.key === targetKey);
    const archivedTarget = targetKey === classKey ? {
      key: classKey,
      label: currentRecord.classLabel || DEFAULT_CLASS_BY_KEY.get(classKey)?.label || classKey,
      groupKey: currentRecord.groupKey || DEFAULT_CLASS_BY_KEY.get(classKey)?.groupKey || 'ARCHIVED',
      section: currentRecord.section || DEFAULT_CLASS_BY_KEY.get(classKey)?.section || '',
    } : null;
    const targetClass = activeTarget || archivedTarget;
    if (!targetClass) return error(res, 400, 'Choose an active class and section.');
    const duplicate = store.records.findIndex((item, itemIndex) => itemIndex !== index && item.date === date && item.classKey === targetKey);
    if (duplicate >= 0) return error(res, 409, 'That class already has an attendance record for this date.');
    const counts = validateCounts(body);
    if (counts.error) return error(res, 400, counts.error);
    const previous = store.records[index];
    const editedAt = new Date().toISOString();
    const updated = {
      ...previous, classKey: targetKey, classLabel: targetClass.label, groupKey: targetClass.groupKey, section: targetClass.section,
      ...counts, updatedAt: editedAt, revision: (Number(previous.revision) || 1) + 1,
    };
    store.history.push({ action: 'edit', date, classKey: previous.classKey, newClassKey: targetKey, editedAt, oldRecord: previous, newRecord: updated });
    store.records[index] = updated;
    delete store.reopenAllowed[recordKey(date, classKey)];
    delete store.reopenAllowed[recordKey(date, targetKey)];
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Attendance record updated.', record: updated });
  }

  if (req.method === 'POST' && route === '/api/principal/delete-record') {
    store = loadStore();
    if (!isPrincipal(req, store)) return error(res, 401, 'Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    const index = store.records.findIndex((item) => item.date === body.date && item.classKey === body.classKey);
    if (index < 0) return error(res, 404, 'Active attendance record not found.');
    const oldRecord = store.records[index];
    const deletedAt = new Date().toISOString();
    const deleted = { id: crypto.randomUUID(), date: oldRecord.date, classKey: oldRecord.classKey, deletedAt, oldRecord };
    store.records.splice(index, 1);
    store.deletedRecords.push(deleted);
    store.history.push({ action: 'delete', date: oldRecord.date, classKey: oldRecord.classKey, editedAt: deletedAt, oldRecord });
    delete store.reopenAllowed[recordKey(oldRecord.date, oldRecord.classKey)];
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Record moved to Principal trash (recoverable).', deleted });
  }

  if (req.method === 'POST' && route === '/api/principal/restore-record') {
    store = loadStore();
    if (!isPrincipal(req, store)) return error(res, 401, 'Principal access required.');
    const body = await readBody(req, res);
    if (!body) return;
    const index = store.deletedRecords.findIndex((item) => item.id === body.deletedId);
    if (index < 0) return error(res, 404, 'Deleted record not found.');
    const item = store.deletedRecords[index];
    const old = item.oldRecord;
    if (store.records.some((record) => record.date === old.date && record.classKey === old.classKey)) return error(res, 409, 'A record already exists for this class/date; restore is blocked to prevent duplicates.');
    store.records.push(old);
    store.deletedRecords.splice(index, 1);
    store.history.push({ action: 'restore', date: old.date, classKey: old.classKey, editedAt: new Date().toISOString(), oldRecord: old });
    saveStore(store);
    return sendJson(res, 200, { ok: true, message: 'Record restored.' });
  }

  if (route.startsWith('/api/')) return error(res, 404, 'API route not found.');
  return null;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) saveStore(emptyStore());

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    publicFile(res, url.pathname);
  } catch (error) {
    console.error('Request error:', error);
    if (!res.headersSent) sendJson(res, 500, { message: 'Unexpected server error.' });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Daily Attendance is running on http://0.0.0.0:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Default Admin PIN: ${INITIAL_ADMIN_PIN}; Default Principal PIN: ${INITIAL_PRINCIPAL_PIN}`);
});
