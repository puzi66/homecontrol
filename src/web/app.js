// לוח שליטה ביתי. בלי פריימוורק, בלי שלב בנייה.

// ── מילון סוגים ───────────────────────────────────────────────────────

const KINDS = {
  light:      { icon: '💡', label: 'תאורה',        accent: 'var(--gold)' },
  vacuum:     { icon: '🤖', label: 'שואב רובוטי',  accent: 'var(--cyan)' },
  speaker:    { icon: '🔊', label: 'רמקול',         accent: 'var(--violet)' },
  tv:         { icon: '📺', label: 'טלוויזיה',      accent: 'var(--pink)' },
  media:      { icon: '🎬', label: 'נגן מדיה',      accent: 'var(--pink)' },
  camera:     { icon: '📷', label: 'מצלמה',         accent: 'var(--rose)' },
  sensor:     { icon: '🌡️', label: 'חיישן',         accent: 'var(--teal)' },
  plug:       { icon: '🔌', label: 'שקע חכם',       accent: 'var(--green)' },
  thermostat: { icon: '❄️', label: 'תרמוסטט',       accent: 'var(--orange)' },
  hub:        { icon: '🏠', label: 'רכזת',          accent: 'var(--blue)' },
  iot:        { icon: '✨', label: 'מכשיר חכם',     accent: 'var(--violet)' },
  printer:    { icon: '🖨️', label: 'מדפסת',         accent: 'var(--slate)' },
  computer:   { icon: '💻', label: 'מחשב',          accent: 'var(--slate)' },
  phone:      { icon: '📱', label: 'טלפון',         accent: 'var(--slate)' },
  nas:        { icon: '💾', label: 'אחסון רשת',     accent: 'var(--blue)' },
  router:     { icon: '📡', label: 'ראוטר',         accent: 'var(--slate)' },
  unknown:    { icon: '❔', label: 'לא ידוע',        accent: 'var(--slate)' },
};

const kindOf = (k) => KINDS[k] ?? KINDS.unknown;

/** סוגים ששווה לשלוט בהם, בניגוד למחשבים וטלפונים. */
const SMART = new Set(['vacuum', 'light', 'speaker', 'tv', 'media', 'camera', 'sensor', 'plug', 'thermostat', 'hub', 'iot']);

/**
 * מה להציג ואיך לשלוט, לפי דרייבר.
 * `active` קובע אם הכרטיס נדלק; `widget` מרנדר את הוויזואל של המצב.
 */
const DRIVER_UI = {
  magichome: {
    active: (s) => !!s.values?.on,
    toggle: { on: 'on', off: 'off' },
    buttons: [{ label: '🔥 לבן חם', cmd: 'setWhite', args: { level: 210 } }],
    widget: (s) => swatch(s.values?.colour),
  },
  sonos: {
    active: (s) => !!s.values?.playing,
    buttons: [
      { label: '▶', cmd: 'play', title: 'נגן' },
      { label: '⏸', cmd: 'pause', title: 'השהה' },
      { label: '⏭', cmd: 'next', title: 'הבא' },
    ],
    widget: (s) => meter(s.values?.volume, 100),
  },
  mova: {
    // 1 = ממתין, 5 = בטעינה, 12 = טעינה הושלמה — כל השאר זה עבודה.
    active: (s) => typeof s.values?.status === 'number' && ![1, 5, 12].includes(s.values.status),
    buttons: [
      { label: '🧹 נקה', cmd: 'start' },
      { label: '🏠 לעגינה', cmd: 'dock' },
      { label: '🔔', cmd: 'locate', title: 'מצא אותי' },
    ],
    widget: (s) => batteryRing(s.values?.battery),
  },
  hue: {
    active: (s) => (s.values?.onCount ?? 0) > 0,
    toggle: { on: 'allOn', off: 'allOff' },
  },
};

const DAY_SHORT = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const SCENE_ICONS = ['✨', '🌙', '☀️', '🎬', '🎵', '🧹', '🏠', '🛋️', '🍽️', '💤', '🚪', '🎉', '📖', '🌅'];

// ── מצב ───────────────────────────────────────────────────────────────

const state = {
  devices: [], rooms: [], discovered: [], wifi: [],
  states: new Map(), sun: {},
  /** deviceId -> { card, device }, so state updates can patch instead of rebuild. */
  cards: new Map(),
  rules: [], scenes: [], log: [], drivers: [],
  view: 'home', roomFilter: null, discFilter: 'new', netTab: 'found',
  scanning: false, editing: null, socket: null, eventSocket: null,
  builder: null,
};

// ── עזרים ─────────────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * כמו el אבל מקבע LTR — לכתובות IP, MAC ופורטים.
 * לא להשתמש על אלמנט שנושא תכונה לוגית כמו margin-inline-start:
 * תכונות לוגיות נפתרות מול הכיווניות של האלמנט עצמו ולא של המכל.
 */
function elLtr(tag, cls, text) {
  const n = el(tag, cls, text);
  n.dir = 'ltr';
  return n;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const n = $('#toast');
  n.textContent = msg;
  n.classList.toggle('is-err', isErr);
  n.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { n.hidden = true; }, 3400);
}

function timeAgo(iso) {
  if (!iso) return 'מעולם';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `לפני ${s} שנ׳`;
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.round(s / 3600)} שע׳`;
  return `לפני ${Math.round(s / 86400)} ימים`;
}

function clockTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const deviceName = (id) => state.devices.find((d) => d.id === id)?.name
  ?? state.scenes.find((s) => s.id === id)?.name ?? id;

// ── ווידג'טים של מצב ──────────────────────────────────────────────────

function swatch(colour) {
  if (!colour) return null;
  const n = el('span', 'swatch');
  n.style.background = colour;
  n.style.color = colour;
  return n;
}

function meter(value, max) {
  if (typeof value !== 'number') return null;
  const wrap = el('span', 'meter');
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  wrap.append(fill);
  return wrap;
}

function batteryRing(pct) {
  if (typeof pct !== 'number') return null;
  const r = 14;
  const circ = 2 * Math.PI * r;

  const wrap = el('span', 'ringwrap');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 34 34');

  for (const cls of ['ring__bg', 'ring__fg']) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '17');
    c.setAttribute('cy', '17');
    c.setAttribute('r', String(r));
    if (cls === 'ring__fg') {
      c.setAttribute('stroke-dasharray', String(circ));
      c.setAttribute('stroke-dashoffset', String(circ * (1 - Math.max(0, Math.min(100, pct)) / 100)));
    }
    svg.append(c);
  }

  wrap.append(svg, el('b', '', String(pct)));
  return wrap;
}

// ── כותרת ─────────────────────────────────────────────────────────────

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'לילה טוב';
  if (h < 12) return 'בוקר טוב';
  if (h < 17) return 'צהריים טובים';
  if (h < 21) return 'ערב טוב';
  return 'לילה טוב';
}

function activeCount() {
  let n = 0;
  for (const d of state.devices) {
    const s = state.states.get(d.id);
    const ui = DRIVER_UI[d.driver];
    if (s && ui?.active?.(s)) n++;
  }
  return n;
}

function renderHeader() {
  $('#greeting').textContent = greeting();
  const online = state.devices.filter((d) => d.online).length;
  $('#hero-sub').textContent = state.devices.length === 0
    ? 'עוד לא הוספנו מכשירים. סרקו את הרשת כדי להתחיל.'
    : `${online} מתוך ${state.devices.length} מכשירים מחוברים · ${state.rules.filter((r) => r.enabled).length} אוטומציות פעילות`;

  $('#stat-on').textContent = String(activeCount());
  $('#stat-devices').textContent = String(state.devices.length);
  $('#stat-rooms').textContent = String(new Set(state.devices.map((d) => d.room).filter(Boolean)).size);

  $('#sun-rise').textContent = state.sun.sunrise ?? '—';
  $('#sun-set').textContent = state.sun.sunset ?? '—';

  $('#brand-sub').textContent = state.scanning ? 'סורק את הרשת…' : `${state.devices.length} מכשירים`;
  $('#scan-btn').classList.toggle('is-busy', state.scanning);

  const rules = $('#count-rules');
  rules.textContent = state.rules.length ? String(state.rules.length) : '';
  const fresh = state.discovered.filter((d) => !d.adopted).length;
  $('#count-new').textContent = fresh ? String(fresh) : '';
}

// ── חדרים ─────────────────────────────────────────────────────────────

function renderRooms() {
  const box = $('#room-filter');
  box.replaceChildren();

  const counts = new Map();
  for (const d of state.devices) {
    const k = d.room ?? '—';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const rows = [['הכל', state.devices.length, null], ...[...counts].map(([r, n]) => [r, n, r])];
  for (const [label, count, value] of rows) {
    const b = el('button', state.roomFilter === value ? 'is-active' : '');
    b.append(el('span', '', label === '—' ? 'ללא חדר' : label), el('i', '', String(count)));
    b.onclick = () => { state.roomFilter = value; renderRooms(); renderDevices(); };
    box.append(b);
  }
}

// ── כרטיס מכשיר ───────────────────────────────────────────────────────

async function fire(deviceId, cmd, args, button) {
  const original = button?.textContent;
  if (button) { button.disabled = true; if (button.tagName === 'BUTTON' && original) button.textContent = '…'; }
  try {
    await api(`/api/devices/${encodeURIComponent(deviceId)}/command`, {
      method: 'POST',
      body: { command: cmd, args: args ?? {} },
    });
    // הרענון מגיע מהשרת דרך ה-WebSocket, אבל נבקש אחד מיד כדי שיהיה מיידי.
    void refreshStates();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) { button.disabled = false; if (original && button.tagName === 'BUTTON') button.textContent = original; }
  }
}

const isOn = (device, live) => !!(live && DRIVER_UI[device.driver]?.active?.(live));

/**
 * Update only the parts of a card that change with device state.
 *
 * Deliberately not a rebuild. State arrives every twenty seconds, and
 * re-creating the grid each time restarts every card's entry animation — which
 * reads as the page flickering on its own.
 */
function paintCard(card, device) {
  const live = state.states.get(device.id);
  const ui = DRIVER_UI[device.driver];
  const active = isOn(device, live);

  card.classList.toggle('is-active', active);
  card.classList.toggle('is-offline', !device.online);

  const row = card.querySelector('.card__state');
  row.classList.toggle('card__state--err', Boolean(live?.error));

  if (live?.error) {
    row.replaceChildren(live.error.length > 92 ? `${live.error.slice(0, 92)}…` : live.error);
  } else if (live) {
    const widget = ui?.widget?.(live);
    const text = el('span', '', live.summary || '—');
    row.replaceChildren(...(widget ? [widget, text] : [text]));
  } else {
    row.replaceChildren(
      el('span', '', device.driver ? 'קורא מצב…' : device.online ? 'מחובר · ניטור בלבד' : 'לא מחובר'),
    );
  }

  const sw = card.querySelector('.card__actions .switch');
  if (sw) {
    sw.classList.toggle('is-on', active);
    sw.title = active ? 'כבה' : 'הדלק';
  }

  paintChildren(card, device, live);
}

/**
 * Render the individual things behind a hub — the bulbs on a Hue bridge, say.
 *
 * Driver-agnostic on purpose: a driver publishes `values.children`, each entry
 * naming the command and argument key that switches it, so the dashboard needs
 * no knowledge of any particular vendor.
 */
function paintChildren(card, device, live) {
  const box = card.querySelector('.card__children');
  if (!box) return;

  const children = Array.isArray(live?.values?.children) ? live.values.children : [];
  if (children.length === 0) {
    box.replaceChildren();
    return;
  }

  // Rebuild only when the set or its states changed, so this stays quiet on
  // the twenty-second poll like everything else.
  const signature = children.map((c) => `${c.id}:${c.on}:${c.reachable}`).join('|');
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;

  box.replaceChildren(
    ...children.map((child) => {
      const row = el('div', `child${child.reachable === false ? ' is-away' : ''}`);
      row.append(el('span', 'child__name', child.name ?? child.id));

      if (typeof child.brightness === 'number' && child.on) {
        row.append(el('span', 'row__mid', `${Math.round((child.brightness / 254) * 100)}%`));
      }

      const toggle = el('button', `switch${child.on ? ' is-on' : ''}`);
      toggle.title = child.on ? 'כבה' : 'הדלק';
      toggle.onclick = () => {
        if (!child.command) return;
        fire(device.id, child.command, { [child.key ?? 'id']: child.id, on: !child.on }, toggle);
      };
      row.append(toggle);
      return row;
    }),
  );
}

function deviceCard(device, index) {
  const meta = kindOf(device.kind);
  const ui = DRIVER_UI[device.driver];

  const card = el('article', 'card');
  card.style.setProperty('--accent', meta.accent);
  card.style.setProperty('--i', String(index));

  // ראש
  const top = el('div', 'card__top');
  top.append(el('div', 'card__icon', meta.icon));

  const id = el('div', 'card__id');
  const name = el('button', 'card__name', device.name);
  name.onclick = () => openEditor(device);
  id.append(name, el('span', 'card__sub', device.room ?? meta.label));
  top.append(id);

  const gear = el('button', 'card__gear', '⚙');
  gear.title = 'הגדרות';
  gear.onclick = () => openEditor(device);
  top.append(gear);
  card.append(top, el('div', 'card__state'), el('div', 'card__children'));

  // פעולות
  const actions = el('div', 'card__actions');
  if (ui?.toggle) {
    const sw = el('button', 'switch');
    // Reads the current state at click time rather than capturing it, so the
    // handler stays correct however long the card has been on screen.
    sw.onclick = () => {
      const on = isOn(device, state.states.get(device.id));
      fire(device.id, on ? ui.toggle.off : ui.toggle.on, {}, sw);
    };
    actions.append(sw);
  }
  for (const b of ui?.buttons ?? []) {
    const btn = el('button', 'qa', b.label);
    if (b.title) btn.title = b.title;
    btn.onclick = () => fire(device.id, b.cmd, b.args, btn);
    actions.append(btn);
  }
  if (!ui) {
    const btn = el('button', 'qa', 'הגדר דרייבר');
    btn.onclick = () => openEditor(device);
    actions.append(btn);
  }
  actions.append(elLtr('span', 'qa__ip', device.ip));
  card.append(actions);

  paintCard(card, device);
  state.cards.set(device.id, { card, device });
  return card;
}

/** Repaint every card in place. No DOM is destroyed, so nothing re-animates. */
function paintDeviceStates() {
  for (const { card, device } of state.cards.values()) paintCard(card, device);
}

function renderDevices() {
  const body = $('#devices-body');
  body.replaceChildren();
  state.cards.clear();

  const visible = state.roomFilter === null
    ? state.devices
    : state.devices.filter((d) => (d.room ?? '—') === state.roomFilter);

  if (visible.length === 0) {
    body.append(emptyBox('🏠',
      state.devices.length === 0 ? 'עוד אין מכשירים' : 'אין מכשירים בחדר הזה',
      state.devices.length === 0
        ? 'לחצו על "הוספת מכשיר" בצד — נסרוק את הרשת ונציג כל מה שמצאנו.'
        : 'אפשר לשייך מכשיר לחדר דרך ההגדרות שלו.'));
    return;
  }

  const byRoom = new Map();
  for (const d of visible) {
    const k = d.room ?? 'ללא חדר';
    if (!byRoom.has(k)) byRoom.set(k, []);
    byRoom.get(k).push(d);
  }

  const rooms = [...byRoom.keys()].sort((a, b) => {
    if (a === 'ללא חדר') return 1;
    if (b === 'ללא חדר') return -1;
    return a.localeCompare(b, 'he');
  });

  let i = 0;
  for (const room of rooms) {
    const list = byRoom.get(room).sort((a, b) => a.name.localeCompare(b.name, 'he'));
    const group = el('section', 'roomgroup');
    const head = el('div', 'roomgroup__head');
    head.append(el('h3', '', room), el('i', '', `${list.filter((d) => d.online).length}/${list.length}`));

    const grid = el('div', 'grid');
    for (const d of list) grid.append(deviceCard(d, i++));

    group.append(head, grid);
    body.append(group);
  }
}

function emptyBox(icon, title, text) {
  const box = el('div', 'empty');
  box.append(el('span', 'empty__icon', icon), el('strong', '', title), el('p', '', text));
  return box;
}

// ── סצנות ─────────────────────────────────────────────────────────────

function renderScenes() {
  const box = $('#scenes-body');
  box.replaceChildren();

  state.scenes.forEach((scene, i) => {
    const card = el('button', 'scene');
    card.style.setProperty('--i', String(i));
    card.append(
      el('div', 'scene__icon', scene.icon),
      (() => {
        const w = el('div');
        w.append(el('strong', '', scene.name), el('em', '', scene.lastRunAt ? timeAgo(scene.lastRunAt) : `${scene.actions.length} פעולות`));
        return w;
      })(),
    );

    card.onclick = async () => {
      card.classList.add('is-running');
      try {
        const r = await api(`/api/automations/scenes/${encodeURIComponent(scene.id)}/run`, { method: 'POST' });
        toast(`${scene.name} — ${r.detail}`);
        await loadAutomations();
      } catch (err) {
        toast(err.message, true);
      } finally {
        setTimeout(() => card.classList.remove('is-running'), 700);
      }
    };
    card.oncontextmenu = (e) => { e.preventDefault(); openBuilder('scene', scene); };
    box.append(card);
  });

  const add = el('button', 'scene scene--add', '＋');
  add.style.setProperty('--i', String(state.scenes.length));
  add.title = 'סצנה חדשה';
  add.onclick = () => openBuilder('scene');
  box.append(add);
}

// ── כללים ─────────────────────────────────────────────────────────────

function describeTrigger(t) {
  switch (t.type) {
    case 'time': return `בשעה ${t.at}${t.days?.length && t.days.length < 7 ? ` (${t.days.map((d) => DAY_SHORT[d]).join(',')})` : ''}`;
    case 'sun': {
      const base = t.event === 'sunrise' ? 'זריחה' : 'שקיעה';
      const o = t.offsetMinutes ?? 0;
      if (!o) return `ב${base}`;
      return o > 0 ? `${o} דק׳ אחרי ה${base}` : `${Math.abs(o)} דק׳ לפני ה${base}`;
    }
    case 'deviceState': return t.op === 'changed'
      ? `${deviceName(t.deviceId)}: ${t.path} משתנה`
      : `${deviceName(t.deviceId)}: ${t.path} ${t.op} ${t.value}`;
    case 'deviceOnline': return `${deviceName(t.deviceId)} ${t.online ? 'מתחבר' : 'מתנתק'}`;
    case 'interval': return `כל ${t.everyMinutes} דק׳`;
    case 'manual': return 'הפעלה ידנית';
    default: return t.type;
  }
}

/** התווית העברית של פקודה, לפי קטלוג הדרייברים. נופל לשם הגלמי אם אין. */
function commandLabel(deviceId, command) {
  return commandsFor(deviceId).find((c) => c.name === command)?.label ?? command;
}

function describeAction(a) {
  switch (a.type) {
    case 'command': return `${deviceName(a.deviceId)} → ${commandLabel(a.deviceId, a.command)}`;
    case 'scene': return `סצנה "${deviceName(a.sceneId)}"`;
    case 'delay': return `המתן ${a.seconds} שנ׳`;
    case 'note': return `רשום: ${a.message}`;
    default: return a.type;
  }
}

function describeCondition(c) {
  switch (c.type) {
    case 'timeWindow': return `בין ${c.from} ל-${c.to}`;
    case 'dayOfWeek': return `בימים ${c.days.map((d) => DAY_SHORT[d]).join(',')}`;
    case 'deviceState': return `${deviceName(c.deviceId)}: ${c.path} ${c.op} ${c.value}`;
    case 'deviceOnline': return `${deviceName(c.deviceId)} ${c.online ? 'מחובר' : 'לא מחובר'}`;
    default: return c.type;
  }
}

function renderRules() {
  const body = $('#rules-body');
  body.replaceChildren();

  if (state.rules.length === 0) {
    body.append(emptyBox('⚡', 'עוד אין אוטומציות',
      'אוטומציה היא משפט אחד: כאשר משהו קורה — הבית עושה משהו. למשל: בשקיעה, הדלק את התאורה בסלון.'));
    return;
  }

  const rows = el('div', 'rows');
  state.rules.forEach((rule, i) => {
    const row = el('div', `row rule${rule.enabled ? '' : ' is-off'}`);
    row.style.setProperty('--i', String(i));

    const sw = el('button', `switch${rule.enabled ? ' is-on' : ''}`);
    sw.style.setProperty('--accent', 'var(--gold)');
    sw.title = rule.enabled ? 'השבת' : 'הפעל';
    sw.onclick = async () => {
      try {
        await api('/api/automations/rules', { method: 'POST', body: { id: rule.id, name: rule.name, enabled: !rule.enabled } });
        await loadAutomations();
      } catch (err) { toast(err.message, true); }
    };

    const bodyWrap = el('div', 'rule__body');
    const nameRow = el('div', 'rule__name');
    nameRow.append(el('span', '', rule.name));
    if (rule.lastResult === 'failed') nameRow.append(el('span', 'tag tag--bad', 'נכשל'));
    bodyWrap.append(nameRow);

    const sentence = el('div', 'rule__sentence');
    sentence.append(el('span', '', 'כאשר '), el('b', '', rule.triggers.map(describeTrigger).join(' או ') || '—'));
    if (rule.conditions.length) {
      sentence.append(el('span', '', ' · רק אם '), el('b', '', rule.conditions.map(describeCondition).join(' וגם ')));
    }
    sentence.append(el('span', '', ' → '), el('b', '', rule.actions.map(describeAction).join(', ') || '—'));
    bodyWrap.append(sentence);

    bodyWrap.append(el('div', 'rule__meta',
      `${rule.runCount} הפעלות${rule.lastRunAt ? ` · אחרונה ${timeAgo(rule.lastRunAt)}` : ''}`));

    const run = el('button', 'qa', '▶ הרץ');
    run.onclick = async () => {
      run.disabled = true;
      try {
        const r = await api(`/api/automations/rules/${encodeURIComponent(rule.id)}/run`, { method: 'POST' });
        toast(`${rule.name} — ${r.detail}`);
        await loadAutomations();
      } catch (err) { toast(err.message, true); } finally { run.disabled = false; }
    };

    const edit = el('button', 'qa', '✎');
    edit.title = 'ערוך';
    edit.onclick = () => openBuilder('rule', rule);

    row.append(sw, bodyWrap, run, edit);
    rows.append(row);
  });
  body.append(rows);
}

// ── יומן ──────────────────────────────────────────────────────────────

function renderActivity() {
  const body = $('#activity-body');
  body.replaceChildren();

  if (state.log.length === 0) {
    body.append(emptyBox('📜', 'היומן ריק', 'ברגע שכלל או סצנה ירוצו, תראו כאן מה קרה ולמה.'));
    return;
  }

  const rows = el('div', 'rows');
  state.log.forEach((entry, i) => {
    const row = el('div', 'row logrow');
    row.style.setProperty('--i', String(i));
    row.append(el('span', `logrow__dot logrow__dot--${entry.outcome}`));

    const b = el('div', 'logrow__body');
    b.append(el('b', '', entry.subject), el('p', '', entry.detail));
    if (entry.because) b.append(el('em', '', `כי: ${entry.because}`));

    row.append(b, el('span', 'logrow__time', clockTime(entry.at)));
    rows.append(row);
  });
  body.append(rows);
}

// ── רשת ───────────────────────────────────────────────────────────────

function discoveredRow(device, index) {
  const meta = kindOf(device.kind);
  const row = el('div', 'row');
  row.style.setProperty('--accent', meta.accent);
  row.style.setProperty('--i', String(index));

  row.append(el('div', 'row__icon', meta.icon));

  const main = el('div', 'row__main');
  main.append(el('b', '', device.hostname ?? meta.label));
  main.append(elLtr('small', '', [device.mac ?? 'ללא MAC', device.openPorts.length ? `:${device.openPorts.join(',')}` : ''].filter(Boolean).join('  ')));
  row.append(main);

  row.append(elLtr('span', 'row__mid', device.ip));
  row.append(el('span', 'row__vendor', device.vendor ?? '—'));

  // A device the ledger remembers but the last sweep did not find. Worth
  // showing rather than hiding — "it used to be here" is information.
  const absent = device.present === false;
  if (absent) {
    row.style.opacity = '0.55';
    row.append(el('span', 'tag tag--mute', `נראה ${timeAgo(device.lastSeen)}`));
  }

  if (device.adopted) {
    row.append(el('span', 'tag', 'נוסף'));
  } else {
    const b = el('button', 'qa qa--primary', '＋ הוסף');
    b.style.setProperty('--accent', meta.accent);
    b.onclick = () => adopt(device, b);
    row.append(b);
  }
  return row;
}

async function adopt(device, button) {
  button.disabled = true;
  button.textContent = 'מוסיף…';
  try {
    const name = device.hostname || `${kindOf(device.kind).label} ${device.vendor?.split(/[ ,]/)[0] ?? device.ip}`;
    const { device: added } = await api('/api/devices', {
      method: 'POST',
      body: { id: device.id, ip: device.ip, mac: device.mac, name, kind: device.kind, driver: device.suggestedDriver },
    });
    device.adopted = true;
    await loadDevices();
    renderDiscovered();
    renderScanRows();
    toast(`${added.name} נוסף`);
    openEditor(added);
  } catch (err) {
    button.disabled = false;
    button.textContent = '＋ הוסף';
    toast(err.message, true);
  }
}

function renderDiscovered() {
  const body = $('#discovered-body');
  body.replaceChildren();

  let list = state.discovered;
  if (state.discFilter === 'new') list = list.filter((d) => !d.adopted);
  else if (state.discFilter === 'smart') list = list.filter((d) => SMART.has(d.kind));

  const absent = state.discovered.filter((d) => d.present === false).length;
  $('#net-sub').textContent = state.discovered.length
    ? [
        `${state.discovered.length} מכשירים ידועים`,
        `${state.discovered.filter((d) => !d.adopted).length} עוד לא נוספו`,
        absent ? `${absent} לא נראו בסריקה האחרונה` : null,
        state.fromLedger ? 'מהזיכרון — טרם בוצעה סריקה בהפעלה הזו' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'כל מה שהסריקה האחרונה מצאה.';

  if (list.length === 0) {
    body.append(emptyBox('📡',
      state.discovered.length === 0 ? 'עוד לא סרקנו' : 'אין תוצאות לסינון הזה',
      state.discovered.length === 0 ? 'לחצו על "הוספת מכשיר" כדי לסרוק את הרשת.' : 'נסו סינון אחר.'));
    return;
  }

  const rows = el('div', 'rows');
  list.forEach((d, i) => rows.append(discoveredRow(d, i)));
  body.append(rows);
}

function renderWifi() {
  const body = $('#wifi-body');
  body.replaceChildren();

  if (state.wifi.length === 0) {
    body.append(emptyBox('📶', 'לא נמצאו רשתות אלחוטיות',
      'אין במחשב הזה מתאם WiFi, או ששירות ה-WLAN כבוי. מכשירים המחוברים ל-WiFi של הראוטר מופיעים ממילא ברשימת המכשירים.'));
    return;
  }

  const rows = el('div', 'rows');
  state.wifi.forEach((net, i) => {
    const row = el('div', 'row');
    row.style.setProperty('--accent', net.connected ? 'var(--green)' : 'var(--slate)');
    row.style.setProperty('--i', String(i));
    row.append(el('div', 'row__icon', '📶'));

    const main = el('div', 'row__main');
    main.append(el('b', '', net.ssid));
    main.append(elLtr('small', '', [net.bssid, net.band, net.authentication].filter(Boolean).join('  ')));
    row.append(main);

    row.append(elLtr('span', 'row__mid', net.signal != null ? `${net.signal}%` : '—'));

    const bars = el('div', 'bars');
    const lit = Math.ceil(((net.signal ?? 0) / 100) * 4);
    for (let b = 1; b <= 4; b++) bars.append(el('i', b <= lit ? 'on' : ''));
    row.append(bars);

    row.append(net.connected ? el('span', 'tag', 'מחובר') : el('span', 'tag tag--mute', `ערוץ ${net.channel ?? '—'}`));
    rows.append(row);
  });
  body.append(rows);
}

// ── שכבת הסריקה ───────────────────────────────────────────────────────

const STAGE_TEXT = {
  probe: 'בודק את הרשת (mDNS, SSDP, miio, Broadlink, ARP)…',
  arp: 'קורא את טבלת ה-ARP…',
  miio: 'מאמת מכשירי miio…',
  dns: 'מתרגם שמות מארחים…',
  ports: 'לוקח טביעת אצבע של הפורטים…',
  magichome: 'בודק בקרי תאורה…',
  http: 'קורא ממשקי ווב…',
  tuya: 'מאזין לשידורי Tuya (25 שניות)…',
  vendor: 'מזהה יצרנים…',
  wifi: 'מרכיב רשימת רשתות אלחוטיות…',
};
const STAGE_ORDER = ['probe', 'arp', 'liveness', 'miio', 'dns', 'ports', 'magichome', 'http', 'tuya', 'vendor', 'wifi'];

/** הסבר על שלמות התוצאה, לפי איך שנמצאו המארחים. */
const HOST_DISCOVERY_NOTE = {
  'tcp-sweep': 'אין טבלת ARP בפלטפורמה הזו — נסרקו רק מארחים עם פורט TCP פתוח. מכשירים שלא מקשיבים בכלל לא נמצאו.',
  'protocol-only': 'לא ניתן היה לסרוק את תת-הרשת — מוצגים רק מכשירים שענו ל-mDNS, SSDP, miio או Broadlink.',
};

function logLine(msg, isErr = false) {
  const log = $('#scan-log');
  log.append(el('p', isErr ? 'is-err' : '', msg));
  log.scrollTop = log.scrollHeight;
}

function renderScanRows() {
  const box = $('#scan-rows');
  box.replaceChildren();
  const onlyNew = $('#scan-onlynew').checked;
  const list = onlyNew ? state.discovered.filter((d) => !d.adopted) : state.discovered;
  $('#scan-count').textContent = `${list.length} מוצגים · ${state.discovered.length} נמצאו`;

  const rows = el('div', 'rows');
  list.forEach((d, i) => rows.append(discoveredRow(d, i)));
  box.append(rows);
}

function openScan() {
  $('#scan-log').replaceChildren();
  $('#scan-bar-fill').style.width = '0%';
  $('#scan-overlay').hidden = false;
  renderScanRows();
}

function closeScan() {
  $('#scan-overlay').hidden = true;
  state.socket?.close();
  state.socket = null;
}

function connectScanStream() {
  state.socket?.close();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${location.host}/api/scan/stream`);
  state.socket = socket;

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.phase === 'start') {
      logLine(`סורק את ${msg.subnets.join(', ')}`);
    } else if (msg.phase === 'stage') {
      logLine(STAGE_TEXT[msg.stage] ?? msg.message);
      const at = STAGE_ORDER.indexOf(msg.stage);
      if (at >= 0) $('#scan-bar-fill').style.width = `${Math.round(((at + 1) / STAGE_ORDER.length) * 100)}%`;
    } else if (msg.phase === 'device') {
      const at = state.discovered.findIndex((d) => d.id === msg.device.id);
      if (at >= 0) state.discovered[at] = msg.device; else state.discovered.push(msg.device);
      renderScanRows();
    } else if (msg.phase === 'wifi') {
      state.wifi = msg.networks;
    } else if (msg.phase === 'done') {
      state.discovered = msg.result.devices;
      state.wifi = msg.result.wifiNetworks;
      state.scanning = false;
      $('#scan-bar-fill').style.width = '100%';
      logLine(`הסתיים — ${msg.result.devices.length} מארחים תוך ${(msg.result.durationMs / 1000).toFixed(1)} שניות`);
      // אם הגילוי היה חלקי, שיהיה כתוב במפורש ולא יוסק.
      const note = HOST_DISCOVERY_NOTE[msg.result.hostDiscovery];
      if (note) logLine(note, true);
      renderScanRows();
      renderDiscovered();
      renderWifi();
      void loadDevices();
      socket.close();
    } else if (msg.phase === 'error') {
      state.scanning = false;
      logLine(msg.message, true);
      renderHeader();
      socket.close();
    }
  };
  socket.onerror = () => logLine('החיבור לזרם ההתקדמות נותק — ייתכן שהסריקה עדיין רצה', true);
}

async function startScan() {
  if (state.scanning) { openScan(); return; }
  const deep = $('#scan-deep').checked;
  state.scanning = true;
  state.discovered = [];
  renderHeader();
  openScan();
  logLine(deep ? 'מתחיל סריקה מעמיקה…' : 'מתחיל סריקה…');
  connectScanStream();
  try {
    await api('/api/scan', { method: 'POST', body: { deep } });
  } catch (err) {
    state.scanning = false;
    renderHeader();
    logLine(err.message, true);
  }
}

// ── עורך מכשיר ────────────────────────────────────────────────────────

function openEditor(device) {
  state.editing = device;

  $('#edit-title').textContent = device.name;
  $('#edit-sub').textContent = `${device.ip} · ${device.mac ?? 'ללא MAC'}`;
  $('#edit-name').value = device.name;
  $('#edit-room').value = device.room ?? '';
  $('#edit-notes').value = device.notes ?? '';

  const kindSel = $('#edit-kind');
  kindSel.replaceChildren();
  for (const [k, v] of Object.entries(KINDS)) {
    const o = el('option', '', `${v.icon}  ${v.label}`);
    o.value = k;
    if (k === device.kind) o.selected = true;
    kindSel.append(o);
  }

  const drvSel = $('#edit-driver');
  drvSel.replaceChildren();
  const none = el('option', '', 'ללא — ניטור בלבד');
  none.value = '';
  drvSel.append(none);
  for (const d of state.drivers) {
    const o = el('option', '', `${d.id} — ${d.label}`);
    o.value = d.id;
    if (d.id === device.driver) o.selected = true;
    drvSel.append(o);
  }
  drvSel.onchange = () => { renderDriverConfig(); renderDriverCommands(); };
  renderDriverConfig();
  renderDriverCommands();

  const dl = $('#room-options');
  dl.replaceChildren();
  for (const r of state.rooms) {
    const o = document.createElement('option');
    o.value = r;
    dl.append(o);
  }

  // עובדות
  const facts = $('#edit-meta');
  facts.replaceChildren();
  const ev = device.discovery?.evidence ?? {};
  const rows = [
    ['יצרן', device.vendor ?? '—'],
    ['שם מארח', device.hostname ?? '—'],
    ['פורטים', device.discovery?.openPorts?.join(', ') || 'אין פתוחים'],
    ['נמצא דרך', device.discovery?.sources?.join(', ') || '—'],
    ['נראה לאחרונה', device.online ? 'כעת' : timeAgo(device.lastSeen)],
  ];
  if (ev.miioDeviceId !== undefined) {
    rows.push(['מזהה miio', String(ev.miioDeviceId)]);
    rows.push(['טוקן miio', ev.miioTokenExposed ? 'חשוף ברשת' : 'מוסתר — צריך חילוץ מהענן']);
  }
  if (ev.broadlinkModel) rows.push(['דגם Broadlink', String(ev.broadlinkModel)]);
  if (ev.magicHomeColour) rows.push(['צבע נוכחי', String(ev.magicHomeColour)]);
  if (ev.tuyaGwId) rows.push(['מזהה Tuya', String(ev.tuyaGwId)]);
  if (ev.modelName) rows.push(['דגם', String(ev.modelName)]);

  for (const [k, v] of rows) {
    const line = el('div');
    line.append(el('b', '', k), elLtr('span', '', v));
    facts.append(line);
  }

  $('#edit-overlay').hidden = false;
  $('#edit-name').focus();
}

/**
 * Every command the assigned driver exposes, runnable from here.
 *
 * Some commands are the only way to complete setup — Hue pairing, reading a
 * Switcher's device id — so leaving them reachable only over the API meant
 * setup could not actually be finished in the interface that asks for it.
 */
function renderDriverCommands() {
  const wrap = $('#edit-commands-wrap');
  const box = $('#edit-commands');
  const out = $('#edit-cmd-out');
  box.replaceChildren();
  out.hidden = true;

  const driver = state.drivers.find((d) => d.id === $('#edit-driver').value);
  const device = state.editing;
  if (!driver?.commands?.length || !device) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  for (const cmd of driver.commands) {
    const row = el('div', 'cmdrow');
    row.append(el('b', '', cmd.label ?? cmd.name));

    const inputs = new Map();
    for (const p of cmd.params ?? []) {
      const input = el('input');
      input.type = p.type === 'number' ? 'number' : 'text';
      input.placeholder = p.label;
      input.title = p.label;
      if (p.type === 'boolean') input.placeholder = 'true / false';
      inputs.set(p.key, { input, type: p.type });
      row.append(input);
    }

    const run = el('button', 'qa', '▶ הרץ');
    run.type = 'button';
    run.onclick = async () => {
      const args = {};
      for (const [key, { input, type }] of inputs) {
        const raw = input.value.trim();
        if (!raw) continue;
        args[key] = type === 'number' ? Number(raw) : type === 'boolean' ? raw === 'true' : raw;
      }

      run.disabled = true;
      run.textContent = '…';
      try {
        const res = await api(`/api/devices/${encodeURIComponent(device.id)}/command`, {
          method: 'POST',
          body: { command: cmd.name, args },
        });
        out.hidden = false;
        out.classList.remove('is-err');
        out.textContent = JSON.stringify(res.result ?? res, null, 2);
        toast(`${cmd.label ?? cmd.name} — בוצע`);
        // A command may have stored config (a Hue username, a Switcher id).
        await loadDevices();
        const fresh = state.devices.find((d) => d.id === device.id);
        if (fresh) {
          state.editing = fresh;
          renderDriverConfig();
        }
        void refreshStates();
      } catch (err) {
        out.hidden = false;
        out.classList.add('is-err');
        out.textContent = err.message;
      } finally {
        run.disabled = false;
        run.textContent = '▶ הרץ';
      }
    };

    row.append(run);
    box.append(row);
  }
}

/** שדות ההגדרה שהדרייבר הנבחר דורש, למשל טוקן או שם משתמש. */
function renderDriverConfig() {
  const box = $('#edit-driver-config');
  box.replaceChildren();

  const driver = state.drivers.find((d) => d.id === $('#edit-driver').value);
  if (!driver?.requires?.length) return;

  for (const req of driver.requires) {
    const wrap = el('label', 'f');
    wrap.append(el('span', '', req.label));
    const input = el('input');
    input.type = 'text';
    input.dir = 'ltr';
    input.dataset.cfgKey = req.key;
    input.placeholder = req.hint;
    input.value = String(state.editing?.driverConfig?.[req.key] ?? '');
    wrap.append(input, el('span', 'card__sub', req.hint));
    box.append(wrap);
  }
}

async function saveEditor(e) {
  e.preventDefault();
  if (!state.editing) return;

  const driverConfig = {};
  for (const input of $$('#edit-driver-config input[data-cfg-key]')) {
    if (input.value.trim()) driverConfig[input.dataset.cfgKey] = input.value.trim();
  }

  const room = $('#edit-room').value.trim();
  try {
    await api(`/api/devices/${encodeURIComponent(state.editing.id)}`, {
      method: 'PATCH',
      body: {
        name: $('#edit-name').value.trim(),
        kind: $('#edit-kind').value,
        room: room || null,
        driver: $('#edit-driver').value || null,
        driverConfig,
        notes: $('#edit-notes').value.trim() || null,
      },
    });
    $('#edit-overlay').hidden = true;
    state.editing = null;
    await loadDevices();
    await refreshStates();
    toast('נשמר');
  } catch (err) { toast(err.message, true); }
}

async function deleteDevice() {
  if (!state.editing) return;
  const d = state.editing;
  if (!confirm(`להסיר את ${d.name}?`)) return;
  try {
    await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    $('#edit-overlay').hidden = true;
    state.editing = null;
    await loadDevices();
    const found = state.discovered.find((x) => x.id === d.id);
    if (found) found.adopted = false;
    renderDiscovered();
    toast('הוסר');
  } catch (err) { toast(err.message, true); }
}

// ── בונה כללים וסצנות ─────────────────────────────────────────────────

/** אפשרויות ה-path שאפשר לבדוק על מכשיר — נגזר מהמצב החי שלו. */
function pathsFor(deviceId) {
  const s = state.states.get(deviceId);
  const keys = s ? Object.keys(s.values ?? {}) : [];
  return ['online', ...keys.filter((k) => typeof s.values[k] !== 'object')];
}

function commandsFor(deviceId) {
  const device = state.devices.find((d) => d.id === deviceId);
  const driver = state.drivers.find((d) => d.id === device?.driver);
  return driver?.commands ?? [];
}

function select(options, value, onChange, cls) {
  const s = el('select', cls);
  for (const [v, label] of options) {
    const o = el('option', '', label);
    o.value = v;
    if (String(v) === String(value)) o.selected = true;
    s.append(o);
  }
  s.onchange = () => onChange(s.value);
  return s;
}

function num(value, onChange, placeholder) {
  const i = el('input');
  i.type = 'number';
  i.value = value ?? '';
  if (placeholder) i.placeholder = placeholder;
  i.oninput = () => onChange(i.value === '' ? null : Number(i.value));
  return i;
}

function text(value, onChange, placeholder) {
  const i = el('input');
  i.type = 'text';
  i.value = value ?? '';
  if (placeholder) i.placeholder = placeholder;
  i.oninput = () => onChange(i.value);
  return i;
}

function timeInput(value, onChange) {
  const i = el('input');
  i.type = 'time';
  i.value = value ?? '08:00';
  i.onchange = () => onChange(i.value);
  return i;
}

function dayPicker(days, onChange) {
  const wrap = el('div', 'daypick');
  const current = new Set(days ?? []);
  DAY_SHORT.forEach((label, index) => {
    const b = el('button', current.has(index) ? 'on' : '', label);
    b.type = 'button';
    b.onclick = () => {
      if (current.has(index)) current.delete(index); else current.add(index);
      b.classList.toggle('on');
      onChange([...current].sort());
    };
    wrap.append(b);
  });
  return wrap;
}

const deviceOptions = () => state.devices.map((d) => [d.id, `${kindOf(d.kind).icon} ${d.name}`]);

const OPS = [['==', 'שווה ל'], ['!=', 'שונה מ'], ['<', 'קטן מ'], ['<=', 'קטן או שווה'], ['>', 'גדול מ'], ['>=', 'גדול או שווה'], ['changed', 'משתנה']];

/** שורה אחת בבונה: בקרות + כפתור מחיקה. */
function builderLine(parts, onKill) {
  const line = el('div', 'line');
  for (const p of parts) if (p) line.append(typeof p === 'string' ? el('span', 'line__txt', p) : p);
  const kill = el('button', 'line__kill', '✕');
  kill.type = 'button';
  kill.title = 'הסר';
  kill.onclick = onKill;
  line.append(kill);
  return line;
}

function renderTriggers() {
  const box = $('#triggers-body');
  box.replaceChildren();

  state.builder.triggers.forEach((t, i) => {
    const kill = () => { state.builder.triggers.splice(i, 1); renderTriggers(); };
    const parts = [select(
      [['time', 'בשעה מסוימת'], ['sun', 'לפי השמש'], ['deviceState', 'מצב של מכשיר'], ['deviceOnline', 'מכשיר מתחבר/מתנתק'], ['interval', 'כל כמה דקות'], ['manual', 'ידני בלבד']],
      t.type,
      (v) => { state.builder.triggers[i] = defaultTrigger(v); renderTriggers(); },
    )];

    if (t.type === 'time') {
      parts.push(timeInput(t.at, (v) => { t.at = v; }), 'בימים', dayPicker(t.days, (v) => { t.days = v; }));
    } else if (t.type === 'sun') {
      parts.push(
        select([['sunrise', 'זריחה 🌅'], ['sunset', 'שקיעה 🌇']], t.event, (v) => { t.event = v; }),
        'היסט בדקות',
        num(t.offsetMinutes ?? 0, (v) => { t.offsetMinutes = v ?? 0; }, '0'),
        dayPicker(t.days, (v) => { t.days = v; }),
      );
    } else if (t.type === 'deviceState') {
      parts.push(
        select(deviceOptions(), t.deviceId, (v) => { t.deviceId = v; renderTriggers(); }),
        select(pathsFor(t.deviceId).map((p) => [p, p]), t.path, (v) => { t.path = v; }),
        select(OPS, t.op, (v) => { t.op = v; renderTriggers(); }),
        t.op === 'changed' ? null : text(t.value, (v) => { t.value = v; }, 'ערך'),
      );
    } else if (t.type === 'deviceOnline') {
      parts.push(
        select(deviceOptions(), t.deviceId, (v) => { t.deviceId = v; }),
        select([['true', 'מתחבר'], ['false', 'מתנתק']], String(t.online), (v) => { t.online = v === 'true'; }),
      );
    } else if (t.type === 'interval') {
      parts.push(num(t.everyMinutes, (v) => { t.everyMinutes = v ?? 15; }, '15'), 'דקות');
    }

    box.append(builderLine(parts, kill));
  });
}

function renderConditions() {
  const box = $('#conditions-body');
  box.replaceChildren();

  state.builder.conditions.forEach((c, i) => {
    const kill = () => { state.builder.conditions.splice(i, 1); renderConditions(); };
    const parts = [select(
      [['timeWindow', 'בין שעות'], ['dayOfWeek', 'ביום מסוים'], ['deviceState', 'מצב של מכשיר'], ['deviceOnline', 'מכשיר מחובר']],
      c.type,
      (v) => { state.builder.conditions[i] = defaultCondition(v); renderConditions(); },
    )];

    if (c.type === 'timeWindow') {
      parts.push(timeInput(c.from, (v) => { c.from = v; }), 'עד', timeInput(c.to, (v) => { c.to = v; }));
    } else if (c.type === 'dayOfWeek') {
      parts.push(dayPicker(c.days, (v) => { c.days = v; }));
    } else if (c.type === 'deviceState') {
      parts.push(
        select(deviceOptions(), c.deviceId, (v) => { c.deviceId = v; renderConditions(); }),
        select(pathsFor(c.deviceId).map((p) => [p, p]), c.path, (v) => { c.path = v; }),
        select(OPS.filter(([o]) => o !== 'changed'), c.op, (v) => { c.op = v; }),
        text(c.value, (v) => { c.value = v; }, 'ערך'),
      );
    } else if (c.type === 'deviceOnline') {
      parts.push(
        select(deviceOptions(), c.deviceId, (v) => { c.deviceId = v; }),
        select([['true', 'מחובר'], ['false', 'לא מחובר']], String(c.online), (v) => { c.online = v === 'true'; }),
      );
    }

    box.append(builderLine(parts, kill));
  });
}

function renderActions() {
  const box = $('#actions-body');
  box.replaceChildren();

  state.builder.actions.forEach((a, i) => {
    const kill = () => { state.builder.actions.splice(i, 1); renderActions(); };
    const parts = [select(
      [['command', 'פקודה למכשיר'], ['scene', 'הפעל סצנה'], ['delay', 'המתן'], ['note', 'רשום ביומן']],
      a.type,
      (v) => { state.builder.actions[i] = defaultAction(v); renderActions(); },
    )];

    if (a.type === 'command') {
      const cmds = commandsFor(a.deviceId);
      parts.push(
        select(deviceOptions(), a.deviceId, (v) => {
          a.deviceId = v;
          a.command = commandsFor(v)[0]?.name ?? '';
          a.args = {};
          renderActions();
        }),
        select(cmds.map((c) => [c.name, c.label ?? c.name]), a.command, (v) => { a.command = v; a.args = {}; renderActions(); }),
      );
      // פרמטרים של הפקודה, אם יש לה
      for (const p of cmds.find((c) => c.name === a.command)?.params ?? []) {
        a.args ??= {};
        parts.push(
          p.label,
          p.type === 'number'
            ? num(a.args[p.key], (v) => { a.args[p.key] = v; })
            : p.type === 'boolean'
              ? select([['true', 'כן'], ['false', 'לא']], String(a.args[p.key] ?? 'true'), (v) => { a.args[p.key] = v === 'true'; })
              : text(a.args[p.key], (v) => { a.args[p.key] = v; }),
        );
      }
    } else if (a.type === 'scene') {
      parts.push(select(state.scenes.map((s) => [s.id, `${s.icon} ${s.name}`]), a.sceneId, (v) => { a.sceneId = v; }));
    } else if (a.type === 'delay') {
      parts.push(num(a.seconds, (v) => { a.seconds = v ?? 5; }, '5'), 'שניות');
    } else if (a.type === 'note') {
      parts.push(text(a.message, (v) => { a.message = v; }, 'טקסט חופשי'));
    }

    box.append(builderLine(parts, kill));
  });
}

function defaultTrigger(type) {
  const first = state.devices[0]?.id ?? '';
  switch (type) {
    case 'time': return { type, at: '08:00', days: [] };
    case 'sun': return { type, event: 'sunset', offsetMinutes: 0, days: [] };
    case 'deviceState': return { type, deviceId: first, path: pathsFor(first)[0] ?? 'online', op: 'changed' };
    case 'deviceOnline': return { type, deviceId: first, online: true };
    case 'interval': return { type, everyMinutes: 15 };
    default: return { type: 'manual' };
  }
}

function defaultCondition(type) {
  const first = state.devices[0]?.id ?? '';
  switch (type) {
    case 'timeWindow': return { type, from: '22:00', to: '06:00' };
    case 'dayOfWeek': return { type, days: [0, 1, 2, 3, 4] };
    case 'deviceState': return { type, deviceId: first, path: pathsFor(first)[0] ?? 'online', op: '==', value: 'true' };
    default: return { type: 'deviceOnline', deviceId: first, online: true };
  }
}

function defaultAction(type) {
  const first = state.devices.find((d) => d.driver)?.id ?? state.devices[0]?.id ?? '';
  switch (type) {
    case 'command': return { type, deviceId: first, command: commandsFor(first)[0]?.name ?? '', args: {} };
    case 'scene': return { type, sceneId: state.scenes[0]?.id ?? '' };
    case 'delay': return { type, seconds: 5 };
    default: return { type: 'note', message: '' };
  }
}

function renderIconPicker() {
  const box = $('#rule-icon');
  box.replaceChildren();
  for (const icon of SCENE_ICONS) {
    const b = el('button', state.builder.icon === icon ? 'on' : '', icon);
    b.type = 'button';
    b.onclick = () => { state.builder.icon = icon; renderIconPicker(); };
    box.append(b);
  }
}

/** @param mode 'rule' | 'scene' */
function openBuilder(mode, existing) {
  state.builder = {
    mode,
    id: existing?.id ?? null,
    name: existing?.name ?? '',
    icon: existing?.icon ?? '✨',
    triggers: structuredClone(existing?.triggers ?? (mode === 'rule' ? [defaultTrigger('time')] : [])),
    conditions: structuredClone(existing?.conditions ?? []),
    actions: structuredClone(existing?.actions ?? [defaultAction('command')]),
  };

  const isScene = mode === 'scene';
  $('#rule-title').textContent = existing
    ? (isScene ? `סצנה: ${existing.name}` : `כלל: ${existing.name}`)
    : (isScene ? 'סצנה חדשה' : 'כלל חדש');
  $('#rule-sub').textContent = isScene
    ? 'סצנה היא רשימת פעולות שרצות בלחיצה אחת.'
    : 'כאשר משהו קורה — הבית עושה משהו.';

  $('#rule-name').value = state.builder.name;
  $('#rule-when-block').hidden = isScene;
  $('#rule-if-block').hidden = isScene;
  $('#rule-icon-wrap').hidden = !isScene;
  $('#rule-delete').hidden = !existing;

  if (isScene) renderIconPicker(); else renderTriggers();
  renderConditions();
  renderActions();

  $('#rule-overlay').hidden = false;
  $('#rule-name').focus();
}

async function saveBuilder() {
  const b = state.builder;
  if (!b) return;

  const name = $('#rule-name').value.trim();
  if (!name) { toast('צריך שם', true); return; }
  if (b.actions.length === 0) { toast('צריך לפחות פעולה אחת', true); return; }

  try {
    if (b.mode === 'scene') {
      await api('/api/automations/scenes', {
        method: 'POST',
        body: { id: b.id ?? undefined, name, icon: b.icon, actions: b.actions },
      });
    } else {
      await api('/api/automations/rules', {
        method: 'POST',
        body: { id: b.id ?? undefined, name, triggers: b.triggers, conditions: b.conditions, actions: b.actions },
      });
    }
    $('#rule-overlay').hidden = true;
    state.builder = null;
    await loadAutomations();
    toast('נשמר');
  } catch (err) { toast(err.message, true); }
}

async function deleteBuilder() {
  const b = state.builder;
  if (!b?.id) return;
  if (!confirm(`למחוק את "${b.name}"?`)) return;
  try {
    await api(`/api/automations/${b.mode === 'scene' ? 'scenes' : 'rules'}/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
    $('#rule-overlay').hidden = true;
    state.builder = null;
    await loadAutomations();
    toast('נמחק');
  } catch (err) { toast(err.message, true); }
}

// ── תצוגות ────────────────────────────────────────────────────────────

function switchView(view) {
  state.view = view;
  for (const b of $$('.nav__btn')) b.classList.toggle('is-active', b.dataset.view === view);
  for (const name of ['home', 'automations', 'activity', 'network']) {
    $(`#view-${name}`).hidden = name !== view;
  }
  if (view === 'automations') renderRules();
  if (view === 'activity') renderActivity();
  if (view === 'network') { renderDiscovered(); renderWifi(); }
}

function switchNetTab(tab) {
  state.netTab = tab;
  for (const b of $$('#net-tabs .tab')) b.classList.toggle('is-active', b.dataset.tab === tab);
  $('#discovered-body').hidden = tab !== 'found';
  $('#disc-filter').hidden = tab !== 'found';
  $('#wifi-body').hidden = tab !== 'wifi';
}

// ── טעינה ─────────────────────────────────────────────────────────────

async function loadDevices() {
  const d = await api('/api/devices');
  state.devices = d.devices;
  state.rooms = d.rooms;
  renderRooms();
  renderDevices();
  renderHeader();
}

async function loadAutomations() {
  const a = await api('/api/automations');
  state.rules = a.rules;
  state.scenes = a.scenes;
  state.log = a.log;
  state.sun = a.sun;
  renderScenes();
  renderHeader();
  if (state.view === 'automations') renderRules();
  if (state.view === 'activity') renderActivity();
}

function applyStates(payload) {
  state.states = new Map((payload.states ?? []).map((s) => [s.deviceId, s]));
  if (payload.sun) state.sun = payload.sun;

  // Only the live values changed, never the set of devices — that comes from
  // loadDevices. So patch the existing cards rather than rebuilding the grid.
  paintDeviceStates();
  renderHeader();
}

async function refreshStates() {
  try {
    applyStates(await api('/api/states'));
  } catch { /* ה-WebSocket ידביק אותנו */ }
}

/** ערוץ דחיפה: מצב מכשירים בכל סבב, ורענון כשכללים או היומן משתנים. */
function connectEvents() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${location.host}/api/events`);
  state.eventSocket = socket;

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'states') applyStates(msg.payload);
    else if (msg.type === 'automations') {
      state.rules = msg.payload.rules;
      state.log = msg.payload.log;
      renderHeader();
      if (state.view === 'automations') renderRules();
      if (state.view === 'activity') renderActivity();
    }
  };

  // חיבור מחדש בשקט אם השרת התרענן.
  socket.onclose = () => setTimeout(connectEvents, 3000);
}

async function boot() {
  $('#scan-btn').onclick = startScan;
  $('#scan-close').onclick = closeScan;
  $('#scan-done').onclick = closeScan;
  $('#scan-rescan').onclick = startScan;
  $('#scan-onlynew').onchange = renderScanRows;

  $('#edit-close').onclick = () => { $('#edit-overlay').hidden = true; state.editing = null; };
  $('#edit-cancel').onclick = $('#edit-close').onclick;
  $('#edit-delete').onclick = deleteDevice;
  $('#edit-form').onsubmit = saveEditor;

  $('#scene-add').onclick = () => openBuilder('scene');
  $('#rule-add').onclick = () => openBuilder('rule');
  $('#rule-close').onclick = () => { $('#rule-overlay').hidden = true; state.builder = null; };
  $('#rule-cancel').onclick = $('#rule-close').onclick;
  $('#rule-save').onclick = saveBuilder;
  $('#rule-delete').onclick = deleteBuilder;
  $('#add-trigger').onclick = () => { state.builder.triggers.push(defaultTrigger('time')); renderTriggers(); };
  $('#add-condition').onclick = () => { state.builder.conditions.push(defaultCondition('timeWindow')); renderConditions(); };
  $('#add-action').onclick = () => { state.builder.actions.push(defaultAction('command')); renderActions(); };

  $('#log-clear').onclick = async () => {
    if (!confirm('לנקות את היומן?')) return;
    await api('/api/log', { method: 'DELETE' });
    state.log = [];
    renderActivity();
  };

  for (const b of $$('.nav__btn')) b.onclick = () => switchView(b.dataset.view);
  for (const b of $$('#net-tabs .tab')) b.onclick = () => switchNetTab(b.dataset.tab);
  for (const c of $$('#disc-filter .chip')) {
    c.onclick = () => {
      state.discFilter = c.dataset.filter;
      for (const x of $$('#disc-filter .chip')) x.classList.toggle('is-active', x === c);
      renderDiscovered();
    };
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['#rule-overlay', '#edit-overlay', '#scan-overlay']) {
      if (!$(id).hidden) { $(id).hidden = true; if (id === '#scan-overlay') closeScan(); return; }
    }
  });

  for (const overlay of $$('.overlay')) {
    overlay.addEventListener('mousedown', (e) => {
      if (e.target !== overlay) return;
      overlay.hidden = true;
      if (overlay.id === 'scan-overlay') closeScan();
    });
  }

  try {
    const [health, scan, drivers] = await Promise.all([
      api('/api/health'), api('/api/scan'), api('/api/drivers'),
    ]);
    state.drivers = drivers.drivers;
    state.scanning = health.scanning;
    // The server serves the persisted ledger when this process has not scanned
    // yet, so the list is populated straight after a restart.
    state.fromLedger = scan.fromLedger === true;
    if (scan.result) {
      state.discovered = scan.result.devices ?? [];
      state.wifi = scan.result.wifiNetworks ?? [];
    }
    await loadDevices();
    await loadAutomations();
    await refreshStates();
    connectEvents();
    if (state.scanning) { openScan(); connectScanStream(); }
  } catch (err) {
    toast(`אין גישה ל-API: ${err.message}`, true);
  }

  setInterval(renderHeader, 60_000);
}

void boot();
