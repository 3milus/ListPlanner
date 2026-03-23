// ============================================================
// CONSTANTS
// ============================================================

const STORAGE_KEY = 'listplanner_v2';

// Web Push — replace with your actual VAPID public key after running:
//   npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY = 'BFy3fMRmXipd_OPNJ68pmm3-vRui6-N-SMjTIjUVfHYxYDgKD1ELGF-OJgVkD9LHMFaTMedqj1y8AAYu5U9Lvr4';

const PALETTE = [
  '#2A9D8F', '#E9C46A', '#457B9D', '#E76F51',
  '#4CC9F0', '#F4A261', '#7B2FBE', '#F72585',
  '#06D6A0', '#6C757D',
];

const USERS = ['Emil', 'Rebecca'];
const USER_COLORS = { Emil: '#457B9D', Rebecca: '#E76F51' };

let db = null;          // Firestore instance (null if not configured)
let ui_appReady = false; // true once user has successfully logged in

const DEFAULT_SECTIONS = [
  { name: 'Frugt & Grønt',        color: '#2A9D8F' },
  { name: 'Bageri & Brød',        color: '#E9C46A' },
  { name: 'Mejeri & Æg',          color: '#457B9D' },
  { name: 'Kød & Fisk',           color: '#E76F51' },
  { name: 'Frysevarer',           color: '#4CC9F0' },
  { name: 'Kolonial & Tørvarer',  color: '#F4A261' },
  { name: 'Drikkevarer',          color: '#7B2FBE' },
  { name: 'Snacks & Slik',        color: '#F72585' },
  { name: 'Helse & Skønhed',      color: '#06D6A0' },
  { name: 'Husholdning',          color: '#6C757D' },
];

// ============================================================
// STATE
// ============================================================

let state = {
  presets: [],
  lists: [],
  apiKey: '',
  apiProvider: 'openai',
  currentUser: 'Emil',
  pinHash: '',
  pushSubscriptions: {},   // { Emil: {...}, Rebecca: {...} } — stored in Firestore
};

let ui = {
  view: 'sort',
  sortPhase: 'input',
  sortMode: 'paste',      // 'paste' | 'generate'
  selectedPresetId: null,
  sortedResult: null,
  checkedItems: {},       // sort view: { key: 'Emil'|'Rebecca' }
  assignments: {},        // sort view: { key: 'Emil'|'Rebecca' }
  presetsSubView: 'list',
  editingPresetId: null,
  modalMode: null,
  modalDraft: null,
  presetModalMode: null,
  expandedListIds: {},
  movingItem: null,   // { listId, sectionId, item } while move-picker is open
};

// ============================================================
// UTILITIES
// ============================================================

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function normalizeOrders(sections) {
  sections.slice().sort((a, b) => a.order - b.order).forEach((s, i) => {
    const found = sections.find(x => x.id === s.id);
    if (found) found.order = i;
  });
}

function getSortedSections(sections) {
  return [...sections].sort((a, b) => a.order - b.order);
}

function formatDate(iso) {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString('default', { month: 'short' });
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

function autoListName(presetName) {
  const now = new Date();
  const day = now.getDate();
  const month = now.toLocaleString('default', { month: 'short' });
  return `${day} ${month} · ${presetName}`;
}

function getPreset(id) {
  return state.presets.find(p => p.id === id) || null;
}

// ============================================================
// DEFAULT PRESET
// ============================================================

function createDefaultPreset() {
  return {
    id:       uid(),
    name:     'Grocery Store',
    sections: DEFAULT_SECTIONS.map((d, i) => ({ id: uid(), name: d.name, color: d.color, order: i })),
  };
}

// ============================================================
// FIREBASE & PERSISTENCE
// ============================================================

function initFirebase() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || cfg.projectId === 'YOUR_PROJECT_ID') {
    console.warn('Firebase not configured — falling back to localStorage');
    return false;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.firestore();
    return true;
  } catch (e) {
    console.error('Firebase init error:', e);
    return false;
  }
}

async function hashPin(pin) {
  const data = new TextEncoder().encode(String(pin).trim() + '_lp_salt_v1');
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPin(entered) {
  if (!state.pinHash) return false;
  return (await hashPin(entered)) === state.pinHash;
}

function saveLocalState() {
  try {
    localStorage.setItem('lp_local', JSON.stringify({
      currentUser: state.currentUser,
      apiKey:      state.apiKey,
      apiProvider: state.apiProvider,
    }));
  } catch (e) {}
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem('lp_local');
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.currentUser && USERS.includes(d.currentUser)) state.currentUser = d.currentUser;
    if (d.apiKey)      state.apiKey      = d.apiKey;
    if (d.apiProvider) state.apiProvider = d.apiProvider;
  } catch (e) {}
}

async function loadState() {
  loadLocalState();

  if (!db) {
    // Fallback: old localStorage format
    try {
      const raw = localStorage.getItem('listplanner_v2');
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d.presets)) state.presets = d.presets;
        if (Array.isArray(d.lists))   state.lists   = d.lists;
        if (d.apiKey)      state.apiKey      = d.apiKey;
        if (d.apiProvider) state.apiProvider = d.apiProvider;
      }
    } catch (e) {}
    return;
  }

  try {
    const snap = await db.collection('listplanner').doc('shared').get();
    if (snap.exists) {
      const d = snap.data();
      if (Array.isArray(d.presets) && d.presets.length) state.presets          = d.presets;
      if (Array.isArray(d.lists))                        state.lists            = d.lists;
      if (d.pinHash)                                     state.pinHash          = d.pinHash;
      if (d.apiKey)                                      state.apiKey           = d.apiKey;
      if (d.apiProvider)                                 state.apiProvider      = d.apiProvider;
      if (d.pushSubscriptions)                           state.pushSubscriptions = d.pushSubscriptions;
    } else {
      // First ever run — migrate any existing localStorage data then init Firestore
      try {
        const raw = localStorage.getItem('listplanner_v2');
        if (raw) {
          const d = JSON.parse(raw);
          if (Array.isArray(d.presets) && d.presets.length) state.presets = d.presets;
          if (Array.isArray(d.lists)   && d.lists.length)   state.lists   = d.lists;
        }
      } catch (e) {}
      if (state.presets.length === 0) state.presets = [createDefaultPreset()];
      state.pinHash = await hashPin('1981');
      await saveState();
    }
  } catch (e) {
    console.error('Firestore load failed:', e);
  }
}

function saveState() {
  saveLocalState();
  if (!db) {
    // Fallback to localStorage
    try {
      localStorage.setItem('listplanner_v2', JSON.stringify({
        presets:     state.presets,
        lists:       state.lists,
        apiKey:      state.apiKey,
        apiProvider: state.apiProvider,
      }));
    } catch (e) {}
    return;
  }
  // Return the Firestore promise so callers can await it if needed
  return db.collection('listplanner').doc('shared').set({
    presets:           state.presets,
    lists:             state.lists,
    pinHash:           state.pinHash,
    apiKey:            state.apiKey,
    apiProvider:       state.apiProvider,
    pushSubscriptions: state.pushSubscriptions,
  }).catch(e => console.error('Firestore save failed:', e));
}

// ============================================================
// PARSING
// ============================================================

function parseList(text) {
  return text
    .split('\n')
    .map(line =>
      line
        .replace(/^[\s\-–—•·▪◦*]+/, '')
        .replace(/^\d+[.)]\s*/, '')
        .trim()
    )
    .filter(line => line.length > 0);
}

// ============================================================
// LLM FUNCTIONS
// ============================================================

function buildPrompt(items, sections) {
  const sorted = getSortedSections(sections);
  const sectionList = sorted.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
  const itemList = items.map(item => `- ${item}`).join('\n');

  return `You are a helpful assistant. Categorize each item into the most appropriate section. Items may be in any language — categorize them correctly regardless of language.

Sections (in order):
${sectionList}

Items to categorize:
${itemList}

Respond ONLY with a valid JSON object. Each key must be the exact item text as given, and each value must be the exact section name from the list above. If an item does not fit any section, use "Uncategorized".

Example: {"æbler": "Frugt & Grønt", "rugbrød": "Bageri & Brød"}`;
}

async function callOpenAI(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI error ${response.status}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(state.apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        response_mime_type: 'application/json',
        temperature: 0,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini error ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return JSON.parse(text);
}

function parseLLMResponse(mapping, items, sections) {
  const result = { uncategorized: [] };
  const sorted = getSortedSections(sections);
  sorted.forEach(s => { result[s.id] = []; });

  const nameToId = {};
  sorted.forEach(s => { nameToId[s.name.toLowerCase()] = s.id; });

  items.forEach(item => {
    const assigned = mapping[item];
    if (!assigned || assigned === 'Uncategorized') {
      result.uncategorized.push(item);
      return;
    }
    const sectionId = nameToId[assigned.toLowerCase()];
    if (sectionId) {
      result[sectionId].push(item);
    } else {
      result.uncategorized.push(item);
    }
  });

  return result;
}

async function sortWithLLM(items, sections) {
  const prompt = buildPrompt(items, sections);
  const mapping = state.apiProvider === 'gemini'
    ? await callGemini(prompt)
    : await callOpenAI(prompt);
  return parseLLMResponse(mapping, items, sections);
}

// ============================================================
// LIST GENERATION
// ============================================================

function buildSuggestCategoriesPrompt(items) {
  const itemList = items.map(i => `- ${i}`).join('\n');
  return `You are a helpful assistant. The following items could not be categorized into any existing section of a list. Suggest 1-3 new section names that would logically group these items. Items may be in any language — respond in the same language as the items.

Items:
${itemList}

Respond ONLY with a valid JSON array of section name strings.
Example: ["Electronics", "Books & Media"]`;
}

async function suggestCategories(items) {
  const prompt = buildSuggestCategoriesPrompt(items);
  const raw = state.apiProvider === 'gemini'
    ? await callGemini(prompt)
    : await callOpenAI(prompt);
  // raw may come back as an object or array depending on the LLM response shape
  if (Array.isArray(raw)) return raw;
  // callGemini/callOpenAI return parsed JSON objects; if it's an array-like object, convert
  const values = Object.values(raw);
  return values.flat().filter(v => typeof v === 'string');
}

function buildGeneratePrompt(description, preset) {
  const sections = getSortedSections(preset.sections);
  const sectionList = sections.map((s, i) => `${i + 1}. ${s.name}`).join('\n');

  // Format past lists of this preset type as context (newest first, cap at 20)
  const recentLists = [...state.lists]
    .filter(l => l.presetId === preset.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);

  let pastContext = '';
  if (recentLists.length > 0) {
    pastContext = `\n\nHere are the user's past "${preset.name}" lists to understand their preferences and typical items:\n`;
    recentLists.forEach(list => {
      pastContext += `\nList: "${list.name}"\n`;
      (list.sections || []).forEach(s => {
        const items = (list.items || {})[s.id] || [];
        if (items.length > 0) pastContext += `  ${s.name}: ${items.join(', ')}\n`;
      });
      const uncat = (list.items || {}).uncategorized || [];
      if (uncat.length > 0) pastContext += `  Other: ${uncat.join(', ')}\n`;
    });
  }

  return `You are a helpful personal assistant creating a tailored list for the user.

The user wants a list for: "${description}"${pastContext}

Create a comprehensive and practical list for this request. Use the past lists as context to understand their preferences, typical items, brands, and quantities — but adapt for the new request.

Organise all items into these sections:
${sectionList}

Respond ONLY with a valid JSON object. Each key must be the EXACT section name from the list above, and the value must be an array of item strings. Only include sections that have items. Items that don't fit any section go under "Uncategorized".

Example: {"Frugt & Grønt": ["æbler", "bananer"], "Mejeri & Æg": ["mælk", "ost"]}`;
}

function parseGenerateResponse(response, preset) {
  const result = { uncategorized: [] };
  const sections = getSortedSections(preset.sections);
  sections.forEach(s => { result[s.id] = []; });

  const nameToId = {};
  sections.forEach(s => { nameToId[s.name.toLowerCase()] = s.id; });

  Object.entries(response).forEach(([sectionName, items]) => {
    if (!Array.isArray(items)) return;
    if (sectionName === 'Uncategorized') {
      result.uncategorized.push(...items);
      return;
    }
    const sectionId = nameToId[sectionName.toLowerCase()];
    if (sectionId) {
      result[sectionId] = items;
    } else {
      result.uncategorized.push(...items);
    }
  });

  return result;
}

async function generateList(description, preset) {
  const prompt = buildGeneratePrompt(description, preset);
  const response = state.apiProvider === 'gemini'
    ? await callGemini(prompt)
    : await callOpenAI(prompt);
  return parseGenerateResponse(response, preset);
}

// ============================================================
// RENDER: SORT VIEW
// ============================================================

function renderUserPills() {
  const color = USER_COLORS[state.currentUser] || '#888';
  const initial = state.currentUser[0];
  const html = `<span class="user-pill-dot" style="background:${color}">${initial}</span>${escapeHtml(state.currentUser)}`;
  document.querySelectorAll('.btn-switch-user').forEach(btn => { btn.innerHTML = html; });
}

function renderSortView() {
  renderPresetPicker();
  renderUserPills();

  const phaseInput   = document.getElementById('phase-input');
  const phaseResults = document.getElementById('phase-results');
  const btnNewList   = document.getElementById('btn-new-list');

  if (ui.sortPhase === 'input') {
    phaseInput.classList.remove('hidden');
    phaseResults.classList.add('hidden');
    btnNewList.classList.add('hidden');
    renderSortModeToggle();
    updateSortButton();
  } else {
    phaseInput.classList.add('hidden');
    phaseResults.classList.remove('hidden');
    btnNewList.classList.remove('hidden');
    renderResults();
  }
}

function renderSortModeToggle() {
  const isPaste = ui.sortMode === 'paste';
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === ui.sortMode);
  });
  const pasteContent    = document.getElementById('paste-mode-content');
  const generateContent = document.getElementById('generate-mode-content');
  if (pasteContent)    pasteContent.classList.toggle('hidden', !isPaste);
  if (generateContent) generateContent.classList.toggle('hidden', isPaste);
}

function renderPresetPicker() {
  const picker = document.getElementById('preset-picker');
  if (!picker) return;

  if (state.presets.length === 0) {
    picker.innerHTML = '<span style="padding:12px 16px;color:var(--text-muted);font-size:14px;">No presets — create one in the Presets tab</span>';
    return;
  }

  // Auto-select first if nothing selected or selection no longer exists
  if (!ui.selectedPresetId || !state.presets.find(p => p.id === ui.selectedPresetId)) {
    ui.selectedPresetId = state.presets[0].id;
  }

  picker.innerHTML = state.presets.map(p => {
    const isActive = p.id === ui.selectedPresetId;
    return `<button class="preset-chip${isActive ? ' active' : ''}" data-preset-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`;
  }).join('');
}

function updateSortButton() {
  const hasPreset = !!ui.selectedPresetId && !!state.presets.find(p => p.id === ui.selectedPresetId);

  const textarea = document.getElementById('list-input');
  const sortBtn  = document.getElementById('btn-sort');
  if (textarea && sortBtn) {
    sortBtn.disabled = !(textarea.value.trim().length > 0 && hasPreset);
  }

  const genInput = document.getElementById('generate-input');
  const genBtn   = document.getElementById('btn-generate');
  if (genInput && genBtn) {
    genBtn.disabled = !(genInput.value.trim().length > 0 && hasPreset);
  }
}

function renderResults() {
  const container = document.getElementById('results-container');
  if (!container || !ui.sortedResult) return;

  const preset = getPreset(ui.sortedResult._presetId);
  const sections = preset ? getSortedSections(preset.sections) : [];

  let html = '';
  let totalCategorized = 0;

  sections.forEach(s => {
    const items = ui.sortedResult[s.id] || [];
    if (items.length > 0) {
      totalCategorized += items.length;
      html += renderSectionCard(s, items, ui.checkedItems, ui.assignments);
    }
  });

  const uncategorized = ui.sortedResult.uncategorized || [];
  if (uncategorized.length > 0) {
    html += renderUncategorized(uncategorized, sections);
  }

  if (totalCategorized === 0 && uncategorized.length === 0) {
    html = '<p class="no-items-msg">No items to display.</p>';
  }

  container.innerHTML = html;
}

function renderSectionCard(section, items, checkedItems, assignments) {
  const tintColor = hexToRgba(section.color, 0.12);
  const checked = checkedItems || {};
  const assigns = assignments || {};
  const checkedCount = items.filter(item => checked[`${section.id}::${item}`]).length;

  const itemsHtml = items.map(item => {
    const key     = `${section.id}::${item}`;
    const checker = checked[key];
    const isChecked = !!checker;
    const eItem   = escapeHtml(item);
    const eKey    = escapeHtml(key);
    const assignee = assigns[key];
    const badge   = checker
      ? `<span class="user-badge" style="background:${USER_COLORS[checker] || '#888'}" title="${escapeHtml(checker)}">${escapeHtml(checker[0])}</span>`
      : '';
    return `
      <li class="checklist-item${isChecked ? ' checked' : ''}" data-key="${eKey}">
        <input type="checkbox" id="cb-${eKey}" ${isChecked ? 'checked' : ''} data-key="${eKey}" />
        <label for="cb-${eKey}">${eItem}</label>
        ${assignBtnHtml(key, assignee, null)}
        ${badge}
      </li>
    `;
  }).join('');

  return `
    <div class="section-card" style="--section-color: ${section.color}; --section-tint: ${tintColor};">
      <div class="section-card-header" style="background-color: ${tintColor};">
        <span class="section-card-name">${escapeHtml(section.name)}</span>
        <span class="section-card-count">${checkedCount}/${items.length}</span>
      </div>
      <ul class="checklist">
        ${itemsHtml}
      </ul>
    </div>
  `;
}

function renderUncategorized(items, sections) {
  const sectionOptions = sections.map(s =>
    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
  ).join('');

  const itemsHtml = items.map(item => {
    const eItem = escapeHtml(item);
    return `
      <div class="uncategorized-item" data-item="${eItem}">
        <span class="uncategorized-item-name">${eItem}</span>
        <div class="assign-controls">
          <select class="assign-select" data-item="${eItem}">
            <option value="">Move to...</option>
            ${sectionOptions}
          </select>
          <button class="assign-btn" data-item="${eItem}">Save</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="section-card uncategorized">
      <div class="uncategorized-header">
        <span class="uncategorized-title">Uncategorized</span>
        <span class="section-card-count">${items.length}</span>
        ${sections.length > 0 ? `<button class="btn-sort-uncat" data-action="suggest-categories">Suggest categories</button>` : ''}
      </div>
      ${itemsHtml}
    </div>
  `;
}

function updateSectionBadge(card) {
  if (!card) return;
  const total = card.querySelectorAll('input[type="checkbox"]').length;
  const checked = card.querySelectorAll('input[type="checkbox"]:checked').length;
  const badge = card.querySelector('.section-card-count');
  if (badge) badge.textContent = `${checked}/${total}`;
}

// ============================================================
// RENDER: LISTS VIEW
// ============================================================

function renderListsView() {
  const container = document.getElementById('lists-container');
  if (!container) return;

  if (state.lists.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No saved lists yet<br>Sort a list to save it here</p>
      </div>
    `;
    return;
  }

  const byDate = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  const active = [...state.lists].filter(l => !l.closed).sort(byDate);
  const closed = [...state.lists].filter(l =>  l.closed).sort(byDate);

  let html = active.map(list => renderListCard(list)).join('');

  if (closed.length > 0) {
    html += `<div class="lists-section-header">Closed</div>`;
    html += closed.map(list => renderListCard(list)).join('');
  }

  container.innerHTML = html;
}

function renderListCard(list) {
  const firstSection = list.sections && list.sections.length > 0 ? list.sections[0] : null;
  const dotColor = firstSection ? firstSection.color : '#6C757D';
  const isExpanded = !!ui.expandedListIds[list.id];
  const isClosed = !!list.closed;
  const metaText = `${escapeHtml(list.presetName)} · ${formatDate(list.createdAt)}`;

  let bodyHtml = '';
  if (isExpanded) {
    const sections = list.sections || [];
    const items = list.items || {};
    const checked = list.checkedItems || {};

    let cardsHtml = '';
    sections.forEach(s => {
      const sectionItems = items[s.id] || [];
      if (sectionItems.length > 0) {
        cardsHtml += renderListSectionCard(list.id, s, sectionItems, checked, list.assignments || {}, list.sections || []);
      }
    });

    const uncatItems = items.uncategorized || [];
    if (uncatItems.length > 0) {
      cardsHtml += renderListUncategorized(list.id, uncatItems, sections);
    }

    if (!cardsHtml) {
      cardsHtml = '<p class="no-items-msg">No items yet.</p>';
    }

    const eLid = escapeHtml(list.id);
    bodyHtml = `
      <div class="list-card-body">${cardsHtml}</div>
      <div class="list-quick-add-row">
        <input class="list-quick-add-input" type="text" placeholder="Add item to list…"
          autocomplete="off" autocorrect="off" spellcheck="false" data-list-id="${eLid}" />
        <button class="add-item-btn" data-action="quick-add-item" data-list-id="${eLid}" aria-label="Add">+</button>
      </div>`;
  }

  const closeTitle = isClosed ? 'Reopen list' : 'Close list';
  const closeIcon = isClosed
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  return `
    <div class="list-card${isClosed ? ' list-card-closed' : ''}" data-list-id="${escapeHtml(list.id)}">
      <div class="list-card-header">
        <div class="list-card-dot" style="background-color: ${dotColor};"></div>
        <div class="list-card-info">
          <div class="list-card-name" data-list-name-id="${escapeHtml(list.id)}">${escapeHtml(list.name)}</div>
          <div class="list-card-meta">${metaText}</div>
        </div>
        <div class="list-card-actions">
          <button class="list-expand-btn icon-btn${isExpanded ? ' expanded' : ''}" data-action="toggle-list" data-list-id="${escapeHtml(list.id)}" aria-label="${isExpanded ? 'Collapse' : 'Expand'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <button class="icon-btn" data-action="rename-list" data-list-id="${escapeHtml(list.id)}" aria-label="Rename" title="Rename list">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="icon-btn${isClosed ? ' reopen-btn' : ''}" data-action="toggle-close-list" data-list-id="${escapeHtml(list.id)}" aria-label="${closeTitle}" title="${closeTitle}">
            ${closeIcon}
          </button>
          <button class="icon-btn danger" data-action="delete-list" data-list-id="${escapeHtml(list.id)}" aria-label="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>
      ${bodyHtml}
    </div>
  `;
}

function renderListSectionCard(listId, section, items, checkedItems, assignments, allSections) {
  const tintColor = hexToRgba(section.color, 0.12);
  const checked = checkedItems || {};
  const assigns = assignments || {};
  const checkedCount = items.filter(item => checked[`${section.id}::${item}`]).length;
  const otherSections = (allSections || []).filter(s => s.id !== section.id);

  const itemsHtml = items.map(item => {
    const key     = `${section.id}::${item}`;
    const checker = checked[key];
    const isChecked = !!checker;
    const eItem   = escapeHtml(item);
    const eKey    = escapeHtml(key);
    const eLid    = escapeHtml(listId);
    const eSid    = escapeHtml(section.id);
    const assignee = assigns[key];
    const badge   = checker
      ? `<span class="user-badge" style="background:${USER_COLORS[checker] || '#888'}" title="${escapeHtml(checker)}">${escapeHtml(checker[0])}</span>`
      : '';

    const mv = ui.movingItem;
    const isMoving = mv && mv.listId === listId && mv.sectionId === section.id && mv.item === item;
    const movePicker = isMoving
      ? `<div class="move-picker">
           <button class="move-cancel" data-action="cancel-move" aria-label="Cancel">✕</button>
           ${otherSections.map(s =>
               `<button class="move-target-chip" data-action="move-item-to"
                  data-list-id="${eLid}" data-from-section="${eSid}"
                  data-to-section="${escapeHtml(s.id)}" data-item="${eItem}"
                  style="border-color:${s.color};color:${s.color}">${escapeHtml(s.name)}</button>`
             ).join('')}
         </div>`
      : '';

    return `
      <li class="checklist-item${isChecked ? ' checked' : ''}${isMoving ? ' moving' : ''}" data-key="${eKey}">
        <div class="checklist-item-row">
          <input type="checkbox" id="lcb-${eLid}-${eKey}" ${isChecked ? 'checked' : ''} data-key="${eKey}" data-list-id="${eLid}" data-action="toggle-check" />
          <label for="lcb-${eLid}-${eKey}">${eItem}</label>
          <button class="item-move-btn${isMoving ? ' active' : ''}" data-action="start-move-item"
            data-list-id="${eLid}" data-section-id="${eSid}" data-item="${eItem}" aria-label="Move item" title="Move to another section">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="5 9 2 12 5 15"/><polyline points="19 9 22 12 19 15"/>
              <line x1="2" y1="12" x2="22" y2="12"/>
            </svg>
          </button>
          ${assignBtnHtml(key, assignee, listId)}
          ${badge}
          <button class="item-ping-btn" data-action="ping-item"
            data-list-id="${eLid}" data-section-id="${eSid}" data-item="${eItem}"
            aria-label="Ping" title="Ping the other person about this item">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </button>
          <button class="item-delete-btn" data-action="delete-list-item"
            data-list-id="${eLid}" data-section-id="${eSid}" data-item="${eItem}" aria-label="Delete item">×</button>
        </div>
        ${movePicker}
      </li>
    `;
  }).join('');

  const eLid = escapeHtml(listId);
  const eSid = escapeHtml(section.id);

  return `
    <div class="section-card" style="--section-color: ${section.color}; --section-tint: ${tintColor};">
      <div class="section-card-header" style="background-color: ${tintColor};">
        <span class="section-card-name">${escapeHtml(section.name)}</span>
        <span class="section-card-count">${checkedCount}/${items.length}</span>
      </div>
      <ul class="checklist">
        ${itemsHtml}
      </ul>
      <div class="add-item-row">
        <input class="add-item-input" type="text" placeholder="Add item…"
          autocomplete="off" autocorrect="off" spellcheck="false"
          data-list-id="${eLid}" data-section-id="${eSid}" />
        <button class="add-item-btn" data-action="add-list-item"
          data-list-id="${eLid}" data-section-id="${eSid}" aria-label="Add item">+</button>
      </div>
    </div>
  `;
}

async function sortUncategorizedInList(listId, btn) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  const uncatItems = (list.items.uncategorized || []).filter(i => i);
  if (!uncatItems.length) return;
  if (!state.apiKey) { alert('Add your API key in the List Types tab first.'); return; }

  if (btn) { btn.textContent = 'Sorting…'; btn.disabled = true; }
  try {
    const result = await sortWithLLM(uncatItems, list.sections);
    list.sections.forEach(section => {
      const sorted = result[section.id] || [];
      if (!list.items[section.id]) list.items[section.id] = [];
      sorted.forEach(item => {
        if (!list.items[section.id].includes(item)) list.items[section.id].push(item);
      });
    });
    list.items.uncategorized = result.uncategorized || [];
    saveState();
    renderListsView();
  } catch (e) {
    alert('Sort failed: ' + e.message);
    if (btn) { btn.textContent = 'Sort with AI'; btn.disabled = false; }
  }
}

function addItemToList(listId, sectionId, input) {
  const text = input ? input.value.trim() : '';
  if (!text) return;
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;
  if (!list.items[sectionId]) list.items[sectionId] = [];
  if (!list.items[sectionId].includes(text)) list.items[sectionId].push(text);
  saveState();
  renderListsView();
  // Re-focus the input for the same section after re-render
  const newInput = document.querySelector(
    `.add-item-input[data-list-id="${listId}"][data-section-id="${sectionId}"]`
  );
  if (newInput) newInput.focus();
}

function renderListUncategorized(listId, items, sections) {
  const sectionOptions = sections.map(s =>
    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
  ).join('');

  const eLid = escapeHtml(listId);

  const itemsHtml = items.map(item => {
    const eItem = escapeHtml(item);
    return `
      <div class="uncategorized-item" data-item="${eItem}">
        <span class="uncategorized-item-name">${eItem}</span>
        <div class="assign-controls">
          <select class="assign-select" data-item="${eItem}">
            <option value="">Move to...</option>
            ${sectionOptions}
          </select>
          <button class="assign-btn" data-action="assign-list-item" data-list-id="${eLid}" data-item="${eItem}">Save</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="section-card uncategorized">
      <div class="uncategorized-header">
        <span class="uncategorized-title">Uncategorized</span>
        <span class="section-card-count">${items.length}</span>
        ${sections.length > 0 && items.length > 0 ? `<button class="btn-sort-uncat" data-action="sort-uncategorized" data-list-id="${eLid}">Sort with AI</button>` : ''}
      </div>
      ${itemsHtml}
      <div class="add-item-row">
        <input class="add-item-input" type="text" placeholder="Add item…"
          autocomplete="off" autocorrect="off" spellcheck="false"
          data-list-id="${eLid}" data-section-id="uncategorized" />
        <button class="add-item-btn" data-action="add-list-item"
          data-list-id="${eLid}" data-section-id="uncategorized" aria-label="Add item">+</button>
      </div>
    </div>
  `;
}

// ============================================================
// RENDER: PRESETS VIEW
// ============================================================

function renderPresetsView() {
  if (ui.presetsSubView === 'list') {
    document.getElementById('presets-list-view').classList.remove('hidden');
    document.getElementById('preset-detail-view').classList.add('hidden');
    renderPresetsList();
  } else {
    document.getElementById('presets-list-view').classList.add('hidden');
    document.getElementById('preset-detail-view').classList.remove('hidden');
    renderPresetDetail();
  }
}

function renderPresetsList() {
  const container = document.getElementById('presets-list');
  if (!container) return;

  let html = '';

  if (state.presets.length === 0) {
    html += `<div class="empty-state"><p>No presets yet.<br>Tap "+ Add" to create one.</p></div>`;
  } else {
    html += state.presets.map(preset => {
      const firstSection = preset.sections && preset.sections.length > 0 ? getSortedSections(preset.sections)[0] : null;
      const dotColor = firstSection ? firstSection.color : '#6C757D';
      const count = preset.sections ? preset.sections.length : 0;
      return `
        <div class="section-row" data-preset-id="${escapeHtml(preset.id)}">
          <div class="section-dot" style="background-color: ${dotColor};"></div>
          <div class="section-row-info">
            <span class="section-row-name">${escapeHtml(preset.name)}</span>
            <span class="section-row-meta">${count} section${count !== 1 ? 's' : ''}</span>
          </div>
          <div class="section-row-actions">
            <button class="icon-btn" data-action="edit-preset" data-preset-id="${escapeHtml(preset.id)}" aria-label="Edit preset">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="icon-btn danger" data-action="delete-preset" data-preset-id="${escapeHtml(preset.id)}" aria-label="Delete preset">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  html += getApiSettingsHtml();
  container.innerHTML = html;
}

function renderPresetDetail() {
  const preset = getPreset(ui.editingPresetId);
  if (!preset) {
    ui.presetsSubView = 'list';
    renderPresetsView();
    return;
  }

  const nameEl = document.getElementById('preset-detail-name');
  if (nameEl) nameEl.textContent = preset.name;

  const container = document.getElementById('preset-detail-content');
  if (!container) return;

  const sections = getSortedSections(preset.sections || []);
  let html = '';

  if (sections.length === 0) {
    html += `<div class="empty-state"><p>No sections yet.<br>Tap "+ Add" to create one.</p></div>`;
  } else {
    html += sections.map((section, index) => {
      const isFirst = index === 0;
      const isLast = index === sections.length - 1;
      return `
        <div class="section-row" data-section-id="${escapeHtml(section.id)}">
          <div class="section-dot" style="background-color: ${section.color};"></div>
          <div class="section-row-info">
            <span class="section-row-name">${escapeHtml(section.name)}</span>
          </div>
          <div class="section-row-actions">
            <button class="icon-btn" data-action="move-up" data-section-id="${escapeHtml(section.id)}" ${isFirst ? 'disabled' : ''} aria-label="Move up">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </button>
            <button class="icon-btn" data-action="move-down" data-section-id="${escapeHtml(section.id)}" ${isLast ? 'disabled' : ''} aria-label="Move down">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="section-divider"></div>
            <button class="icon-btn" data-action="edit-section" data-section-id="${escapeHtml(section.id)}" aria-label="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="icon-btn danger" data-action="delete-section" data-section-id="${escapeHtml(section.id)}" aria-label="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  html += getApiSettingsHtml();
  container.innerHTML = html;
}

function getApiSettingsHtml() {
  const isGemini = state.apiProvider === 'gemini';
  const maskedKey = state.apiKey
    ? state.apiKey.slice(0, 4) + '••••••••' + state.apiKey.slice(-4)
    : '';

  return `
    <div class="settings-card">
      <h3 class="settings-title">AI Settings</h3>
      <p class="settings-desc">API used to categorize your list</p>

      <div class="provider-toggle">
        <button class="provider-btn${!isGemini ? ' active' : ''}" data-provider="openai">
          OpenAI
          <small>GPT-4o mini · Paid</small>
        </button>
        <button class="provider-btn${isGemini ? ' active' : ''}" data-provider="gemini">
          Gemini
          <small>Flash 2.5 · Free tier</small>
        </button>
      </div>

      <div class="api-key-row">
        <input
          type="password"
          id="api-key-input"
          class="form-input"
          placeholder="${isGemini ? 'AIza...' : 'sk-proj-...'}"
          value="${escapeHtml(state.apiKey)}"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        />
        <button class="btn-save-key" id="btn-save-key">Save</button>
      </div>

      ${state.apiKey
        ? `<p class="key-status saved">Saved: ${escapeHtml(maskedKey)}</p>`
        : `<p class="key-status">No key set — enter one above</p>`
      }
    </div>
  `;
}

// ============================================================
// SECTION MODAL
// ============================================================

function openSectionModal(mode, sectionId = null) {
  ui.modalMode = mode;

  const preset = getPreset(ui.editingPresetId);
  if (!preset) return;

  if (mode === 'edit-section' && sectionId) {
    const section = preset.sections.find(s => s.id === sectionId);
    if (!section) return;
    ui.modalDraft = { id: section.id, name: section.name, color: section.color, order: section.order };
    document.getElementById('modal-title').textContent = 'Edit Section';
  } else {
    const usedColors = preset.sections.map(s => s.color);
    const nextColor = PALETTE.find(c => !usedColors.includes(c)) || PALETTE[0];
    ui.modalDraft = { id: uid(), name: '', color: nextColor, order: preset.sections.length };
    document.getElementById('modal-title').textContent = 'New Section';
  }

  renderModalBody();
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => {
    const input = document.getElementById('modal-name-input');
    if (input) input.focus();
  }, 350);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  ui.modalMode = null;
  ui.modalDraft = null;
}

function saveModal() {
  if (!ui.modalDraft) return;

  const name = ui.modalDraft.name.trim();
  if (!name) {
    const input = document.getElementById('modal-name-input');
    if (input) {
      input.focus();
      input.style.borderColor = '#FF3B30';
      setTimeout(() => { input.style.borderColor = ''; }, 1500);
    }
    return;
  }

  const preset = getPreset(ui.editingPresetId);
  if (!preset) return;

  if (ui.modalMode === 'add-section') {
    const maxOrder = preset.sections.length > 0
      ? Math.max(...preset.sections.map(s => s.order)) + 1
      : 0;
    const newSection = { id: ui.modalDraft.id, name, color: ui.modalDraft.color, order: maxOrder };
    preset.sections.push(newSection);

    // Propagate new section to all active lists using this preset
    state.lists.forEach(list => {
      if (list.presetId !== preset.id || list.closed) return;
      if (!list.sections.find(s => s.id === newSection.id)) {
        list.sections.push({ ...newSection });
        if (!list.items) list.items = {};
        list.items[newSection.id] = [];
      }
    });
  } else if (ui.modalMode === 'edit-section') {
    const section = preset.sections.find(s => s.id === ui.modalDraft.id);
    if (section) {
      section.name = name;
      section.color = ui.modalDraft.color;
    }

    // Propagate name/color change to all active lists using this preset
    state.lists.forEach(list => {
      if (list.presetId !== preset.id || list.closed) return;
      const ls = list.sections.find(s => s.id === ui.modalDraft.id);
      if (ls) { ls.name = name; ls.color = ui.modalDraft.color; }
    });
  }

  saveState();
  closeModal();
  renderPresetDetail();
}

function renderModalBody() {
  const body = document.getElementById('modal-body');
  if (!body || !ui.modalDraft) return;

  const swatchesHtml = PALETTE.map(color => `
    <button
      class="color-swatch${ui.modalDraft.color === color ? ' selected' : ''}"
      style="background-color: ${color};"
      data-color="${color}"
      aria-label="Color ${color}"
    ></button>
  `).join('');

  body.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="modal-name-input">Section Name</label>
      <input
        type="text"
        id="modal-name-input"
        class="form-input"
        placeholder="e.g. Produce"
        value="${escapeHtml(ui.modalDraft.name)}"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
      />
    </div>

    <div class="form-group">
      <span class="form-label">Color</span>
      <div class="color-grid">
        ${swatchesHtml}
      </div>
    </div>
  `;
}

// ============================================================
// PRESET NAME MODAL
// ============================================================

function openPresetModal(mode) {
  ui.presetModalMode = mode;
  const titleEl = document.getElementById('preset-modal-title');
  const input = document.getElementById('preset-name-input');

  if (mode === 'rename-preset') {
    const preset = getPreset(ui.editingPresetId);
    if (!preset) return;
    if (titleEl) titleEl.textContent = 'Rename List Type';
    if (input) input.value = preset.name;
  } else {
    if (titleEl) titleEl.textContent = 'New List Type';
    if (input) input.value = '';
  }

  document.getElementById('preset-name-modal-overlay').classList.remove('hidden');
  setTimeout(() => {
    if (input) { input.focus(); input.select(); }
  }, 350);
}

function closePresetModal() {
  document.getElementById('preset-name-modal-overlay').classList.add('hidden');
  ui.presetModalMode = null;
}

function savePresetModal() {
  const input = document.getElementById('preset-name-input');
  const name = input ? input.value.trim() : '';

  if (!name) {
    if (input) {
      input.focus();
      input.style.borderColor = '#FF3B30';
      setTimeout(() => { input.style.borderColor = ''; }, 1500);
    }
    return;
  }

  if (ui.presetModalMode === 'add-preset') {
    const newPreset = { id: uid(), name, sections: [] };
    state.presets.push(newPreset);
    saveState();
    closePresetModal();
    ui.editingPresetId = newPreset.id;
    ui.presetsSubView = 'detail';
    switchView('presets');
  } else if (ui.presetModalMode === 'rename-preset') {
    const preset = getPreset(ui.editingPresetId);
    if (preset) {
      preset.name = name;
      saveState();
    }
    closePresetModal();
    renderPresetDetail();
  }
}

// ============================================================
// VIEW SWITCHING
// ============================================================

function switchView(view) {
  ui.view = view;

  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });

  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const target = document.getElementById(`view-${view}`);
  if (target) target.classList.remove('hidden');

  if (view === 'sort') renderSortView();
  else if (view === 'lists') renderListsView();
  else if (view === 'presets') renderPresetsView();
}

// ============================================================
// TOP-LEVEL RENDER
// ============================================================

function render() {
  switchView(ui.view);
}

// ============================================================
// EVENT HANDLERS
// ============================================================

function setupEventListeners() {

  // USER SWITCH (delegated on #app so it works in all views)
  document.getElementById('app').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-switch-user');
    if (!btn) return;
    sessionStorage.removeItem('loggedIn');
    showLogin();
  });

  // BOTTOM NAV
  document.querySelector('.bottom-nav').addEventListener('click', (e) => {
    const tab = e.target.closest('.nav-tab');
    if (!tab) return;
    const view = tab.dataset.view;
    if (!view || view === ui.view) return;
    switchView(view);
  });

  // LOGIN SCREEN — step 1: pick user card
  document.getElementById('login-screen').addEventListener('click', (e) => {
    const card = e.target.closest('.login-user-card');
    if (!card) return;
    // Highlight selected card
    document.querySelectorAll('.login-user-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.currentUser = card.dataset.user;
    // Show PIN entry
    const pinSection = document.getElementById('login-pin-section');
    pinSection.classList.remove('hidden');
    document.getElementById('login-pin-error').classList.add('hidden');
    const pinInput = document.getElementById('login-pin-input');
    pinInput.value = '';
    pinInput.focus();
  });

  // LOGIN SCREEN — step 2: enter PIN
  document.getElementById('login-enter-btn').addEventListener('click', async () => {
    await doLogin();
  });
  document.getElementById('login-pin-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') await doLogin();
  });

  // MODE TOGGLE (Paste / Generate)
  document.getElementById('phase-input').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn || btn.dataset.mode === ui.sortMode) return;
    ui.sortMode = btn.dataset.mode;
    renderSortModeToggle();
    updateSortButton();
  });

  // GENERATE INPUT: enable/disable button
  document.getElementById('generate-input').addEventListener('input', updateSortButton);

  // GENERATE button
  document.getElementById('btn-generate').addEventListener('click', async () => {
    const input       = document.getElementById('generate-input');
    const description = input ? input.value.trim() : '';
    if (!description) return;

    const preset = getPreset(ui.selectedPresetId);
    if (!preset) { alert('Please select a preset first.'); return; }
    if (!state.apiKey) { alert('Please add your API key in the Presets tab first.'); return; }

    const btn       = document.getElementById('btn-generate');
    btn.disabled    = true;
    btn.textContent = 'Creating...';

    try {
      const result      = await generateList(description, preset);
      result._presetId  = preset.id;
      ui.sortedResult   = result;
      ui.checkedItems   = {};
      ui.assignments    = {};
      ui.sortPhase      = 'results';

      const nameInput = document.getElementById('list-name-input');
      if (nameInput) nameInput.value = description.length > 40 ? description.slice(0, 40) + '…' : description;

      renderSortView();
    } catch (err) {
      console.error('Generate failed:', err);
      alert(`Failed to create list: ${err.message}`);
    } finally {
      btn.textContent = 'Create List';
      btn.disabled    = input ? input.value.trim().length === 0 : true;
    }
  });

  // PRESET PICKER chips
  document.getElementById('preset-picker').addEventListener('click', (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    ui.selectedPresetId = chip.dataset.presetId;
    renderPresetPicker();
    updateSortButton();
  });

  // SORT: textarea input
  document.getElementById('list-input').addEventListener('input', () => {
    updateSortButton();
  });

  // SORT: sort button
  document.getElementById('btn-sort').addEventListener('click', async () => {
    const textarea = document.getElementById('list-input');
    const text = textarea ? textarea.value : '';
    const items = parseList(text);
    if (items.length === 0) return;

    if (!state.apiKey) {
      alert('Please add your API key in the Presets tab first.');
      return;
    }

    const preset = getPreset(ui.selectedPresetId);
    if (!preset) {
      alert('Please select a preset first.');
      return;
    }

    const btn = document.getElementById('btn-sort');
    btn.disabled = true;
    btn.textContent = 'Sorting...';

    try {
      const result = await sortWithLLM(items, preset.sections);
      result._presetId = preset.id;
      ui.sortedResult = result;
      ui.checkedItems = {};
      ui.assignments  = {};
      ui.sortPhase = 'results';

      // Pre-fill name input
      const nameInput = document.getElementById('list-name-input');
      if (nameInput) nameInput.value = autoListName(preset.name);

      renderSortView();
    } catch (err) {
      console.error('Sort failed:', err);
      alert(`Sorting failed: ${err.message}`);
    } finally {
      btn.textContent = 'Sort List';
      btn.disabled = !(textarea && textarea.value.trim().length > 0 && ui.selectedPresetId);
    }
  });

  // SORT: new list button
  document.getElementById('btn-new-list').addEventListener('click', () => {
    ui.sortPhase    = 'input';
    ui.sortedResult = null;
    ui.checkedItems = {};
    ui.assignments  = {};
    const textarea  = document.getElementById('list-input');
    if (textarea) textarea.value = '';
    const genInput  = document.getElementById('generate-input');
    if (genInput) genInput.value = '';
    renderSortView();
  });

  // SORT results: checkbox toggle
  document.getElementById('phase-results').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' && e.target.dataset.key) {
      const key  = e.target.dataset.key;
      const item = e.target.closest('.checklist-item');
      if (e.target.checked) {
        ui.checkedItems[key] = state.currentUser;
        if (item) {
          item.classList.add('checked');
          if (!item.querySelector('.user-badge')) {
            const badge = document.createElement('span');
            badge.className = 'user-badge';
            badge.style.background = USER_COLORS[state.currentUser] || '#888';
            badge.title = state.currentUser;
            badge.textContent = state.currentUser[0];
            item.appendChild(badge);
          }
        }
      } else {
        delete ui.checkedItems[key];
        if (item) {
          item.classList.remove('checked');
          const badge = item.querySelector('.user-badge');
          if (badge) badge.remove();
        }
      }
      updateSectionBadge(e.target.closest('.section-card'));
    }
  });

  // SORT results: assign uncategorized + item assignment
  document.getElementById('phase-results').addEventListener('click', (e) => {
    // Item assignment cycling
    const assignBtn = e.target.closest('.item-assign-btn[data-action="assign-item"]');
    if (assignBtn && !assignBtn.dataset.listId) {
      const key = assignBtn.dataset.key;
      const cycle = [undefined, ...USERS];
      const current = ui.assignments[key];
      const idx = cycle.indexOf(current);
      const next = cycle[(idx + 1) % cycle.length];
      if (next) ui.assignments[key] = next; else delete ui.assignments[key];
      const color = next ? (USER_COLORS[next] || '#888') : null;
      assignBtn.style.background = color || '';
      assignBtn.style.borderColor = color ? 'transparent' : '';
      assignBtn.style.color = color ? '#fff' : '';
      assignBtn.textContent = next ? next[0] : '';
      assignBtn.title = next ? `Assigned to ${next}` : 'Assign to someone';
      assignBtn.classList.toggle('assigned', !!next);
      return;
    }

    // Suggest categories for uncategorized items
    const suggestBtn = e.target.closest('[data-action="suggest-categories"]');
    if (suggestBtn) {
      const items = ui.sortedResult?.uncategorized || [];
      if (!items.length) return;
      if (!state.apiKey) { alert('Add your API key in the List Types tab first.'); return; }
      suggestBtn.textContent = 'Thinking…';
      suggestBtn.disabled = true;
      suggestCategories(items).then(suggestions => {
        if (!suggestions.length) { alert('No suggestions returned.'); return; }
        const list = suggestions.map(s => `• ${s}`).join('\n');
        alert(`Suggested new categories:\n\n${list}\n\nAdd these to your List Type to use them next time you sort.`);
      }).catch(e => {
        alert('Suggestion failed: ' + e.message);
      }).finally(() => {
        suggestBtn.textContent = 'Suggest categories';
        suggestBtn.disabled = false;
      });
      return;
    }

    // Assign uncategorized
    const uncatBtn = e.target.closest('.assign-btn');
    if (!uncatBtn) return;
    const itemText = uncatBtn.dataset.item;
    const row = uncatBtn.closest('.uncategorized-item');
    const select = row ? row.querySelector('.assign-select') : null;
    const sectionId = select ? select.value : '';
    if (!sectionId || !ui.sortedResult) return;

    ui.sortedResult.uncategorized = ui.sortedResult.uncategorized.filter(i => i !== itemText);
    if (!ui.sortedResult[sectionId]) ui.sortedResult[sectionId] = [];
    ui.sortedResult[sectionId].push(itemText);
    renderResults();
  });

  // SORT: save list
  document.getElementById('btn-save-list').addEventListener('click', () => {
    if (!ui.sortedResult) return;

    const preset = getPreset(ui.sortedResult._presetId);
    if (!preset) return;

    const nameInput = document.getElementById('list-name-input');
    const listName = (nameInput && nameInput.value.trim()) || autoListName(preset.name);

    // Snapshot sections (exclude internal _presetId key)
    const sectionSnapshot = getSortedSections(preset.sections).map(s => ({
      id: s.id,
      name: s.name,
      color: s.color,
    }));

    // Build items object from sortedResult
    const itemsObj = {};
    sectionSnapshot.forEach(s => {
      itemsObj[s.id] = ui.sortedResult[s.id] || [];
    });
    itemsObj.uncategorized = ui.sortedResult.uncategorized || [];

    const newList = {
      id: uid(),
      name: listName,
      presetId: preset.id,
      presetName: preset.name,
      sections: sectionSnapshot,
      items: itemsObj,
      checkedItems: {},
      assignments: { ...ui.assignments },
      createdAt: new Date().toISOString(),
      closed: false,
    };

    state.lists.push(newList);
    saveState();

    const btn = document.getElementById('btn-save-list');
    btn.textContent = 'Saved!';
    btn.disabled = true;

    setTimeout(() => {
      ui.sortPhase = 'input';
      ui.sortedResult = null;
      const textarea = document.getElementById('list-input');
      if (textarea) textarea.value = '';
      switchView('lists');
    }, 800);
  });

  // LISTS container: event delegation
  document.getElementById('lists-container').addEventListener('click', (e) => {
    // Expand/collapse
    const expandBtn = e.target.closest('[data-action="toggle-list"]');
    if (expandBtn) {
      const listId = expandBtn.dataset.listId;
      ui.expandedListIds[listId] = !ui.expandedListIds[listId];
      renderListsView();
      return;
    }

    // Rename list (pencil button)
    if (e.target.closest('[data-action="rename-list"]')) {
      const listId = e.target.closest('[data-action="rename-list"]').dataset.listId;
      const nameEl = document.querySelector(`.list-card-name[data-list-name-id="${listId}"]`);
      if (nameEl && !nameEl.classList.contains('editing')) nameEl.click();
      return;
    }

    // Quick-add item to uncategorized
    const quickAddBtn = e.target.closest('[data-action="quick-add-item"]');
    if (quickAddBtn) {
      const listId = quickAddBtn.dataset.listId;
      const input = quickAddBtn.closest('.list-quick-add-row')?.querySelector('.list-quick-add-input');
      addItemToList(listId, 'uncategorized', input);
      return;
    }

    // Sort uncategorized items with AI
    const sortUncatBtn = e.target.closest('[data-action="sort-uncategorized"]');
    if (sortUncatBtn) {
      sortUncategorizedInList(sortUncatBtn.dataset.listId, sortUncatBtn);
      return;
    }

    // Ping the other person about an item
    const pingBtn = e.target.closest('[data-action="ping-item"]');
    if (pingBtn) {
      const { listId, sectionId, item } = pingBtn.dataset;
      sendPing(listId, sectionId, item);
      return;
    }

    // Start moving an item
    const moveTrigger = e.target.closest('[data-action="start-move-item"]');
    if (moveTrigger) {
      const { listId, sectionId, item } = moveTrigger.dataset;
      const mv = ui.movingItem;
      ui.movingItem = (mv && mv.listId === listId && mv.sectionId === sectionId && mv.item === item)
        ? null : { listId, sectionId, item };
      renderListsView();
      return;
    }

    // Cancel move
    if (e.target.closest('[data-action="cancel-move"]')) {
      ui.movingItem = null;
      renderListsView();
      return;
    }

    // Execute move to a section
    const moveTarget = e.target.closest('[data-action="move-item-to"]');
    if (moveTarget) {
      const { listId, fromSection, toSection, item } = moveTarget.dataset;
      const list = state.lists.find(l => l.id === listId);
      if (!list) return;

      // Move the item
      list.items[fromSection] = (list.items[fromSection] || []).filter(i => i !== item);
      if (!list.items[toSection]) list.items[toSection] = [];
      list.items[toSection].push(item);

      // Transfer checked state and assignment to new key
      const oldKey = `${fromSection}::${item}`;
      const newKey = `${toSection}::${item}`;
      if (list.checkedItems && list.checkedItems[oldKey] !== undefined) {
        list.checkedItems[newKey] = list.checkedItems[oldKey];
        delete list.checkedItems[oldKey];
      }
      if (list.assignments && list.assignments[oldKey] !== undefined) {
        list.assignments[newKey] = list.assignments[oldKey];
        delete list.assignments[oldKey];
      }

      ui.movingItem = null;
      saveState();
      renderListsView();
      return;
    }

    // Delete an item from a saved list section
    const deleteItemBtn = e.target.closest('[data-action="delete-list-item"]');
    if (deleteItemBtn) {
      const { listId, sectionId, item } = deleteItemBtn.dataset;
      const list = state.lists.find(l => l.id === listId);
      if (!list) return;
      list.items[sectionId] = (list.items[sectionId] || []).filter(i => i !== item);
      const key = `${sectionId}::${item}`;
      if (list.checkedItems) delete list.checkedItems[key];
      if (list.assignments) delete list.assignments[key];
      saveState();
      renderListsView();
      return;
    }

    // Add an item to a saved list section (button click)
    const addItemBtn = e.target.closest('[data-action="add-list-item"]');
    if (addItemBtn) {
      const { listId, sectionId } = addItemBtn.dataset;
      const input = addItemBtn.closest('.add-item-row')?.querySelector('.add-item-input');
      addItemToList(listId, sectionId, input);
      return;
    }

    // Close / reopen list
    const closeBtn = e.target.closest('[data-action="toggle-close-list"]');
    if (closeBtn) {
      const listId = closeBtn.dataset.listId;
      const list = state.lists.find(l => l.id === listId);
      if (!list) return;
      list.closed = !list.closed;
      saveState();
      renderListsView();
      return;
    }

    // Delete list
    const deleteBtn = e.target.closest('[data-action="delete-list"]');
    if (deleteBtn) {
      const listId = deleteBtn.dataset.listId;
      const list = state.lists.find(l => l.id === listId);
      if (!list) return;
      if (!confirm(`Delete "${list.name}"? This cannot be undone.`)) return;
      state.lists = state.lists.filter(l => l.id !== listId);
      delete ui.expandedListIds[listId];
      saveState();
      renderListsView();
      return;
    }

    // Assign uncategorized item in a saved list
    const uncatAssignBtn = e.target.closest('[data-action="assign-list-item"]');
    if (uncatAssignBtn) {
      const listId = uncatAssignBtn.dataset.listId;
      const itemText = uncatAssignBtn.dataset.item;
      const row = uncatAssignBtn.closest('.uncategorized-item');
      const select = row ? row.querySelector('.assign-select') : null;
      const sectionId = select ? select.value : '';
      if (!sectionId) return;

      const list = state.lists.find(l => l.id === listId);
      if (!list) return;

      list.items.uncategorized = (list.items.uncategorized || []).filter(i => i !== itemText);
      if (!list.items[sectionId]) list.items[sectionId] = [];
      list.items[sectionId].push(itemText);
      saveState();
      renderListsView();
      return;
    }

    // Item assignment in saved lists
    const assignBtn = e.target.closest('.item-assign-btn[data-action="assign-item"]');
    if (assignBtn && assignBtn.dataset.listId) {
      const key = assignBtn.dataset.key;
      const listId = assignBtn.dataset.listId;
      const list = state.lists.find(l => l.id === listId);
      if (!list) return;
      if (!list.assignments) list.assignments = {};
      const cycle = [undefined, ...USERS];
      const current = list.assignments[key];
      const idx = cycle.indexOf(current);
      const next = cycle[(idx + 1) % cycle.length];
      if (next) list.assignments[key] = next; else delete list.assignments[key];
      const color = next ? (USER_COLORS[next] || '#888') : null;
      assignBtn.style.background = color || '';
      assignBtn.style.borderColor = color ? 'transparent' : '';
      assignBtn.style.color = color ? '#fff' : '';
      assignBtn.textContent = next ? next[0] : '';
      assignBtn.title = next ? `Assigned to ${next}` : 'Assign to someone';
      assignBtn.classList.toggle('assigned', !!next);
      saveState();
      return;
    }

    // Inline rename: click on list name
    const nameEl = e.target.closest('.list-card-name');
    if (nameEl && !nameEl.classList.contains('editing')) {
      const listId = nameEl.dataset.listNameId;
      const list = state.lists.find(l => l.id === listId);
      if (!list) return;

      nameEl.classList.add('editing');
      const currentName = list.name;
      nameEl.innerHTML = `<input class="list-card-name-input" type="text" value="${escapeHtml(currentName)}" autocomplete="off" autocorrect="off" spellcheck="false" />`;
      const input = nameEl.querySelector('input');
      if (input) {
        input.focus();
        input.select();

        const save = () => {
          const newName = input.value.trim() || currentName;
          list.name = newName;
          saveState();
          nameEl.classList.remove('editing');
          nameEl.textContent = newName;
          nameEl.dataset.listNameId = listId;
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); save(); }
          if (ev.key === 'Escape') {
            nameEl.classList.remove('editing');
            nameEl.textContent = currentName;
            nameEl.dataset.listNameId = listId;
          }
        });
      }
      return;
    }
  });

  // LISTS container: checkbox toggle
  document.getElementById('lists-container').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' && e.target.dataset.action === 'toggle-check') {
      const key = e.target.dataset.key;
      const listId = e.target.dataset.listId;
      const list = state.lists.find(l => l.id === listId);
      if (!list) return;

      if (!list.checkedItems) list.checkedItems = {};
      const item = e.target.closest('.checklist-item');

      if (e.target.checked) {
        list.checkedItems[key] = state.currentUser;
        if (item) {
          item.classList.add('checked');
          if (!item.querySelector('.user-badge')) {
            const badge = document.createElement('span');
            badge.className = 'user-badge';
            badge.style.background = USER_COLORS[state.currentUser] || '#888';
            badge.title = state.currentUser;
            badge.textContent = state.currentUser[0];
            item.appendChild(badge);
          }
        }
      } else {
        delete list.checkedItems[key];
        if (item) {
          item.classList.remove('checked');
          const badge = item.querySelector('.user-badge');
          if (badge) badge.remove();
        }
      }

      updateSectionBadge(e.target.closest('.section-card'));
      saveState();
    }
  });

  // LISTS container: Enter key on add-item inputs
  document.getElementById('lists-container').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const quickInput = e.target.closest('.list-quick-add-input');
    if (quickInput) {
      e.preventDefault();
      addItemToList(quickInput.dataset.listId, 'uncategorized', quickInput);
      return;
    }
    const input = e.target.closest('.add-item-input');
    if (!input) return;
    e.preventDefault();
    addItemToList(input.dataset.listId, input.dataset.sectionId, input);
  });

  // PRESETS: add preset button
  document.getElementById('btn-add-preset').addEventListener('click', () => {
    openPresetModal('add-preset');
  });

  // PRESETS LIST: event delegation
  document.getElementById('presets-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      const presetId = btn.dataset.presetId;

      if (action === 'edit-preset') {
        ui.editingPresetId = presetId;
        ui.presetsSubView = 'detail';
        renderPresetsView();
        return;
      }

      if (action === 'delete-preset') {
        const preset = getPreset(presetId);
        if (!preset) return;
        const usedCount = state.lists.filter(l => l.presetId === presetId).length;
        let msg = `Delete "${preset.name}"?`;
        if (usedCount > 0) msg += ` ${usedCount} saved list${usedCount !== 1 ? 's' : ''} use this list type.`;
        msg += ' This cannot be undone.';
        if (!confirm(msg)) return;
        state.presets = state.presets.filter(p => p.id !== presetId);
        if (ui.selectedPresetId === presetId) ui.selectedPresetId = null;
        saveState();
        renderPresetsList();
        return;
      }
    }

    // Provider toggle
    const providerBtn = e.target.closest('.provider-btn[data-provider]');
    if (providerBtn) {
      state.apiProvider = providerBtn.dataset.provider;
      saveState();
      renderPresetsList();
      return;
    }

    // Save API key
    if (e.target.id === 'btn-save-key') {
      const input = document.getElementById('api-key-input');
      if (input) {
        state.apiKey = input.value.trim();
        saveState();
        renderPresetsList();
      }
      return;
    }
  });

  // PRESET DETAIL: back button
  document.getElementById('btn-back-presets').addEventListener('click', () => {
    ui.presetsSubView = 'list';
    renderPresetsView();
  });

  // PRESET DETAIL: rename button (pencil)
  document.getElementById('btn-rename-preset').addEventListener('click', () => {
    openPresetModal('rename-preset');
  });

  // PRESET DETAIL: add section button
  document.getElementById('btn-add-section-to-preset').addEventListener('click', () => {
    openSectionModal('add-section');
  });

  // PRESET DETAIL content: event delegation
  document.getElementById('preset-detail-content').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      const sectionId = btn.dataset.sectionId;

      if (action === 'edit-section') {
        openSectionModal('edit-section', sectionId);
        return;
      }

      if (action === 'delete-section') {
        handleDeleteSection(sectionId);
        return;
      }

      if (action === 'move-up') {
        handleMoveSection(sectionId, -1);
        return;
      }

      if (action === 'move-down') {
        handleMoveSection(sectionId, 1);
        return;
      }
    }

    // Provider toggle in detail view
    const providerBtn = e.target.closest('.provider-btn[data-provider]');
    if (providerBtn) {
      state.apiProvider = providerBtn.dataset.provider;
      saveState();
      renderPresetDetail();
      return;
    }

    // Save API key in detail view
    if (e.target.id === 'btn-save-key') {
      const input = document.getElementById('api-key-input');
      if (input) {
        state.apiKey = input.value.trim();
        saveState();
        renderPresetDetail();
      }
      return;
    }
  });

  // SECTION MODAL: cancel & save
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // SECTION MODAL body: color swatch & name input
  document.getElementById('modal-body').addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (swatch && ui.modalDraft) {
      ui.modalDraft.color = swatch.dataset.color;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
    }
  });

  document.getElementById('modal-body').addEventListener('input', (e) => {
    if (e.target.id === 'modal-name-input' && ui.modalDraft) {
      ui.modalDraft.name = e.target.value;
    }
  });

  document.getElementById('modal-body').addEventListener('keydown', (e) => {
    if (e.target.id === 'modal-name-input' && e.key === 'Enter') {
      e.preventDefault();
      saveModal();
    }
  });

  // PRESET NAME MODAL: cancel & save
  document.getElementById('preset-modal-cancel').addEventListener('click', closePresetModal);
  document.getElementById('preset-modal-save').addEventListener('click', savePresetModal);
  document.getElementById('preset-name-modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('preset-name-modal-overlay')) closePresetModal();
  });

  document.getElementById('preset-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); savePresetModal(); }
    if (e.key === 'Escape') closePresetModal();
  });
}

// ============================================================
// SECTION ACTIONS (within editing preset)
// ============================================================

function handleDeleteSection(sectionId) {
  const preset = getPreset(ui.editingPresetId);
  if (!preset) return;
  const section = preset.sections.find(s => s.id === sectionId);
  if (!section) return;
  if (!confirm(`Delete "${section.name}"? This cannot be undone.`)) return;
  preset.sections = preset.sections.filter(s => s.id !== sectionId);
  normalizeOrders(preset.sections);
  saveState();
  renderPresetDetail();
}

function handleMoveSection(sectionId, direction) {
  const preset = getPreset(ui.editingPresetId);
  if (!preset) return;
  const sorted = getSortedSections(preset.sections);
  const index = sorted.findIndex(s => s.id === sectionId);
  if (index === -1) return;
  const swapIndex = index + direction;
  if (swapIndex < 0 || swapIndex >= sorted.length) return;

  const sectionA = preset.sections.find(s => s.id === sorted[index].id);
  const sectionB = preset.sections.find(s => s.id === sorted[swapIndex].id);
  if (!sectionA || !sectionB) return;

  const tempOrder = sectionA.order;
  sectionA.order = sectionB.order;
  sectionB.order = tempOrder;
  normalizeOrders(preset.sections);
  saveState();
  renderPresetDetail();
}

// ============================================================
// WEB PUSH
// ============================================================

// Converts the VAPID public key (base64url) to Uint8Array for pushManager.subscribe
function urlBase64ToUint8Array(base64String) {
  const pad  = '='.repeat((4 - base64String.length % 4) % 4);
  const b64  = (base64String + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw  = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function subscribeToPush() {
  if (!VAPID_PUBLIC_KEY) return;
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.warn('Push permission denied');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    state.pushSubscriptions[state.currentUser] = sub.toJSON();
    saveState();
    console.log('Push subscription saved for', state.currentUser);
  } catch (e) {
    console.error('Push subscription failed:', e);
    alert(`Notification setup failed: ${e.message}\nMake sure the app is installed to your home screen.`);
  }
}

async function sendPing(listId, sectionId, item) {
  if (!db) { alert('No database connection.'); return; }

  const list    = state.lists.find(l => l.id === listId);
  const section = list?.sections?.find(s => s.id === sectionId);
  const to      = USERS.find(u => u !== state.currentUser);

  if (!to) return;

  const hasSub = !!state.pushSubscriptions?.[to];
  if (!hasSub) {
    alert(`${to} hasn't enabled notifications yet.\nAsk them to open the app and allow notifications.`);
    return;
  }

  try {
    await db.collection('pings').add({
      to,
      from:        state.currentUser,
      item,
      listName:    list?.name    || '',
      sectionName: section?.name || '',
      timestamp:   Date.now(),
    });
  } catch (e) {
    console.error('Failed to write ping:', e);
    alert('Could not send ping — check your connection.');
  }
}

// ============================================================
// LOGIN HELPERS
// ============================================================

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.querySelector('.bottom-nav').classList.add('hidden');
  // Reset PIN UI
  document.getElementById('login-pin-section').classList.add('hidden');
  document.getElementById('login-pin-error').classList.add('hidden');
  document.getElementById('login-pin-input').value = '';
  document.querySelectorAll('.login-user-card').forEach(c => c.classList.remove('selected'));
}

function hideLogin() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.querySelector('.bottom-nav').classList.remove('hidden');
}

async function doLogin() {
  const pin = document.getElementById('login-pin-input').value;
  const errorEl = document.getElementById('login-pin-error');

  // If pinHash not yet loaded (Firestore still loading), wait briefly
  if (!state.pinHash) {
    errorEl.textContent = 'Still loading — try again in a moment';
    errorEl.classList.remove('hidden');
    return;
  }

  const ok = await verifyPin(pin);
  if (!ok) {
    errorEl.textContent = 'Incorrect PIN — try again';
    errorEl.classList.remove('hidden');
    document.getElementById('login-pin-input').value = '';
    document.getElementById('login-pin-input').focus();
    return;
  }

  sessionStorage.setItem('loggedIn', '1');
  ui_appReady = true;
  saveState();
  hideLogin();
  renderUserPills();
  render();
  subscribeToPush(); // request notification permission and store subscription
}

function setupRealtimeSync() {
  if (!db) return;
  db.collection('listplanner').doc('shared').onSnapshot(snap => {
    if (!snap.exists || snap.metadata.hasPendingWrites || !ui_appReady) return;
    const d = snap.data();
    if (Array.isArray(d.presets) && d.presets.length) state.presets          = d.presets;
    if (Array.isArray(d.lists))                        state.lists            = d.lists;
    if (d.pinHash)                                     state.pinHash          = d.pinHash;
    if (d.apiKey)                                      state.apiKey           = d.apiKey;
    if (d.apiProvider)                                 state.apiProvider      = d.apiProvider;
    if (d.pushSubscriptions)                           state.pushSubscriptions = d.pushSubscriptions;
    render();
  });
}

// ============================================================
// ITEM ASSIGNMENT BUTTON
// ============================================================

function assignBtnHtml(key, assignee, listId) {
  const color = assignee ? (USER_COLORS[assignee] || '#888') : null;
  const style = color
    ? `background:${color};border-color:transparent;color:#fff;`
    : '';
  const text = assignee ? escapeHtml(assignee[0]) : '';
  const listAttr = listId ? ` data-list-id="${escapeHtml(listId)}"` : '';
  return `<button class="item-assign-btn${assignee ? ' assigned' : ''}" data-key="${escapeHtml(key)}" data-action="assign-item"${listAttr} style="${style}" title="${assignee ? `Assigned to ${escapeHtml(assignee)}` : 'Assign to someone'}">${text}</button>`;
}

// ============================================================
// INIT
// ============================================================

async function init() {
  initFirebase();
  showLogin();
  setupEventListeners();

  await loadState();

  // Create default preset if first run
  if (state.presets.length === 0) {
    const sections = DEFAULT_SECTIONS.map((d, i) => ({
      id: uid(),
      name: d.name,
      color: d.color,
      order: i,
    }));
    state.presets.push({
      id: uid(),
      name: 'Grocery Store',
      sections,
    });
    await saveState();
  }

  setupRealtimeSync();

  if (sessionStorage.getItem('loggedIn') && state.currentUser) {
    ui_appReady = true;
    hideLogin();
    renderUserPills();
    render();
  }
}

document.addEventListener('DOMContentLoaded', init);
