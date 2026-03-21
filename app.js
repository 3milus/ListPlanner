// ============================================================
// CONSTANTS
// ============================================================

const STORAGE_KEY = 'listplanner_v1';

const PALETTE = [
  '#2A9D8F', '#E9C46A', '#457B9D', '#E76F51',
  '#4CC9F0', '#F4A261', '#7B2FBE', '#F72585',
  '#06D6A0', '#6C757D',
];

// ============================================================
// DEFAULT SECTIONS
// ============================================================

const SECTION_PRESETS = {
  en: [
    { name: 'Produce',            color: '#2A9D8F' },
    { name: 'Bakery & Bread',     color: '#E9C46A' },
    { name: 'Dairy & Eggs',       color: '#457B9D' },
    { name: 'Meat & Fish',        color: '#E76F51' },
    { name: 'Frozen Foods',       color: '#4CC9F0' },
    { name: 'Pantry & Dry Goods', color: '#F4A261' },
    { name: 'Beverages',          color: '#7B2FBE' },
    { name: 'Snacks & Sweets',    color: '#F72585' },
    { name: 'Health & Beauty',    color: '#06D6A0' },
    { name: 'Household',          color: '#6C757D' },
  ],
  da: [
    { name: 'Frugt & Grønt',      color: '#2A9D8F' },
    { name: 'Bageri & Brød',      color: '#E9C46A' },
    { name: 'Mejeri & Æg',        color: '#457B9D' },
    { name: 'Kød & Fisk',         color: '#E76F51' },
    { name: 'Frysevarer',         color: '#4CC9F0' },
    { name: 'Kolonial & Tørvarer', color: '#F4A261' },
    { name: 'Drikkevarer',        color: '#7B2FBE' },
    { name: 'Snacks & Slik',      color: '#F72585' },
    { name: 'Helse & Skønhed',    color: '#06D6A0' },
    { name: 'Husholdning',        color: '#6C757D' },
  ],
};

function createDefaultSections() {
  const lang = state.sectionLang || 'en';
  return SECTION_PRESETS[lang].map((d, i) => ({ id: uid(), name: d.name, color: d.color, order: i }));
}

// ============================================================
// STATE
// ============================================================

let state = {
  sections: [],
  apiKey: '',
  apiProvider: 'openai', // 'openai' | 'gemini'
  sectionLang: 'en',    // 'en' | 'da'
};

let ui = {
  view: 'sort',
  phase: 'input',       // 'input' | 'results'
  sortedResult: null,
  checkedItems: {},
  modalMode: null,      // null | 'add' | 'edit'
  editingSectionId: null,
  modalDraft: null,
};

// ============================================================
// PERSISTENCE
// ============================================================

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.sections && Array.isArray(parsed.sections)) {
        // Strip legacy keywords to keep data lean
        state.sections = parsed.sections.map(s => ({
          id: s.id,
          name: s.name,
          color: s.color,
          order: s.order,
        }));
      }
      if (parsed.apiKey)      state.apiKey      = parsed.apiKey;
      if (parsed.apiProvider) state.apiProvider = parsed.apiProvider;
      if (parsed.sectionLang) state.sectionLang = parsed.sectionLang;
    }
  } catch (e) {
    console.error('Failed to load state:', e);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sections:    state.sections,
      apiKey:      state.apiKey,
      apiProvider: state.apiProvider,
      sectionLang: state.sectionLang,
    }));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

// ============================================================
// UTILITIES
// ============================================================

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function getSortedSections() {
  return [...state.sections].sort((a, b) => a.order - b.order);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function normalizeOrders() {
  getSortedSections().forEach((section, index) => {
    const s = state.sections.find(x => x.id === section.id);
    if (s) s.order = index;
  });
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
// LLM SORTING
// ============================================================

function buildPrompt(items) {
  const sections = getSortedSections();
  const sectionList = sections.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
  const itemList = items.map(item => `- ${item}`).join('\n');

  return `You are a grocery store assistant. Categorize each grocery item into the most appropriate store section. Items may be in any language — Danish, English, or others — categorize them correctly regardless of language.

Store sections (in the order they appear in the store):
${sectionList}

Grocery items to categorize:
${itemList}

Respond ONLY with a valid JSON object. Each key must be the exact grocery item text as given, and each value must be the exact section name from the list above. If an item does not fit any section, use "Uncategorized".

Example: {"æbler": "Produce", "rugbrød": "Bakery & Bread", "shampoo": "Health & Beauty"}`;
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(state.apiKey)}`;
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

async function sortWithLLM(items) {
  const prompt = buildPrompt(items);
  const mapping = state.apiProvider === 'gemini'
    ? await callGemini(prompt)
    : await callOpenAI(prompt);
  return parseLLMResponse(mapping, items);
}

function parseLLMResponse(mapping, items) {
  const result = { uncategorized: [] };
  const sections = getSortedSections();
  sections.forEach(s => { result[s.id] = []; });

  // Build case-insensitive name → id lookup
  const nameToId = {};
  sections.forEach(s => { nameToId[s.name.toLowerCase()] = s.id; });

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

// ============================================================
// RENDER: SORT VIEW
// ============================================================

function renderSortView() {
  const phaseInput   = document.getElementById('phase-input');
  const phaseResults = document.getElementById('phase-results');
  const btnNewList   = document.getElementById('btn-new-list');

  if (ui.phase === 'input') {
    phaseInput.classList.remove('hidden');
    phaseResults.classList.add('hidden');
    btnNewList.classList.add('hidden');
  } else {
    phaseInput.classList.add('hidden');
    phaseResults.classList.remove('hidden');
    btnNewList.classList.remove('hidden');
    renderResults();
  }
}

function renderResults() {
  const container = document.getElementById('results-container');
  if (!container || !ui.sortedResult) return;

  const sections = getSortedSections();
  let html = '';
  let totalCategorized = 0;

  sections.forEach(s => {
    const items = ui.sortedResult[s.id] || [];
    if (items.length > 0) {
      totalCategorized += items.length;
      html += renderSectionCard(s, items);
    }
  });

  const uncategorized = ui.sortedResult.uncategorized || [];
  if (uncategorized.length > 0) {
    html += renderUncategorized(uncategorized);
  }

  if (totalCategorized === 0 && uncategorized.length === 0) {
    html = '<p class="no-items-msg">No items to display.</p>';
  }

  container.innerHTML = html;
}

function renderSectionCard(section, items) {
  const tintColor   = hexToRgba(section.color, 0.12);
  const checkedCount = items.filter(item => ui.checkedItems[`${section.id}::${item}`]).length;

  const itemsHtml = items.map(item => {
    const key       = `${section.id}::${item}`;
    const isChecked = !!ui.checkedItems[key];
    const eItem     = escapeHtml(item);
    const eKey      = escapeHtml(key);
    return `
      <li class="checklist-item${isChecked ? ' checked' : ''}" data-key="${eKey}">
        <input type="checkbox" id="cb-${eKey}" ${isChecked ? 'checked' : ''} data-key="${eKey}" />
        <label for="cb-${eKey}">${eItem}</label>
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

function renderUncategorized(items) {
  const sections       = getSortedSections();
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
      </div>
      ${itemsHtml}
    </div>
  `;
}

// ============================================================
// RENDER: SECTIONS VIEW
// ============================================================

function renderSectionsView() {
  const container = document.getElementById('sections-list');
  if (!container) return;

  const sections = getSortedSections();
  let html = '';

  if (sections.length === 0) {
    html += `
      <div class="empty-state">
        <p>No sections yet.<br>Tap "+ Add" to create one.</p>
      </div>
    `;
  } else {
    html += sections.map((section, index) => {
      const isFirst = index === 0;
      const isLast  = index === sections.length - 1;
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
  const isGemini  = state.apiProvider === 'gemini';
  const maskedKey = state.apiKey
    ? state.apiKey.slice(0, 4) + '••••••••' + state.apiKey.slice(-4)
    : '';

  return `
    <div class="settings-card">
      <h3 class="settings-title">AI Settings</h3>
      <p class="settings-desc">API used to categorize your grocery list</p>

      <div class="form-group">
        <span class="form-label">Default section language</span>
        <div class="provider-toggle">
          <button class="provider-btn${state.sectionLang === 'en' ? ' active' : ''}" data-lang="en">
            English
          </button>
          <button class="provider-btn${state.sectionLang === 'da' ? ' active' : ''}" data-lang="da">
            Dansk
          </button>
        </div>
        <button class="btn-reset-sections" id="btn-reset-sections">Reset sections to defaults</button>
      </div>

      <div class="provider-toggle">
        <button class="provider-btn${!isGemini ? ' active' : ''}" data-provider="openai">
          OpenAI
          <small>GPT-4o mini · Paid</small>
        </button>
        <button class="provider-btn${isGemini ? ' active' : ''}" data-provider="gemini">
          Gemini
          <small>Flash 1.5 · Free tier</small>
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
// MODAL (Add/Edit Section)
// ============================================================

function openModal(mode, sectionId = null) {
  ui.modalMode        = mode;
  ui.editingSectionId = sectionId;

  if (mode === 'edit' && sectionId) {
    const section = state.sections.find(s => s.id === sectionId);
    if (!section) return;
    ui.modalDraft = { id: section.id, name: section.name, color: section.color, order: section.order };
    document.getElementById('modal-title').textContent = 'Edit Section';
  } else {
    const usedColors = state.sections.map(s => s.color);
    const nextColor  = PALETTE.find(c => !usedColors.includes(c)) || PALETTE[0];
    ui.modalDraft = { id: uid(), name: '', color: nextColor, order: state.sections.length };
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
  ui.modalMode        = null;
  ui.editingSectionId = null;
  ui.modalDraft       = null;
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

  if (ui.modalMode === 'add') {
    const maxOrder = state.sections.length > 0
      ? Math.max(...state.sections.map(s => s.order)) + 1
      : 0;
    state.sections.push({ id: ui.modalDraft.id, name, color: ui.modalDraft.color, order: maxOrder });
  } else if (ui.modalMode === 'edit') {
    const section = state.sections.find(s => s.id === ui.modalDraft.id);
    if (section) {
      section.name  = name;
      section.color = ui.modalDraft.color;
    }
  }

  saveState();
  closeModal();
  renderSectionsView();
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
// EVENT HANDLERS
// ============================================================

function setupEventListeners() {
  // NAV TABS
  document.querySelector('.bottom-nav').addEventListener('click', (e) => {
    const tab = e.target.closest('.nav-tab');
    if (!tab) return;
    const view = tab.dataset.view;
    if (!view || view === ui.view) return;
    ui.view = view;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    render();
  });

  // SORT: sort button (async)
  document.getElementById('btn-sort').addEventListener('click', async () => {
    const textarea = document.getElementById('list-input');
    const text     = textarea ? textarea.value : '';
    const items    = parseList(text);
    if (items.length === 0) return;

    if (!state.apiKey) {
      alert('Please add your API key in the Sections tab first.');
      return;
    }

    const btn       = document.getElementById('btn-sort');
    btn.disabled    = true;
    btn.textContent = 'Sorting...';

    try {
      ui.sortedResult = await sortWithLLM(items);
      ui.checkedItems = {};
      ui.phase        = 'results';
      renderSortView();
    } catch (err) {
      console.error('Sort failed:', err);
      alert(`Sorting failed: ${err.message}`);
    } finally {
      btn.textContent = 'Sort List';
      btn.disabled    = textarea ? textarea.value.trim().length === 0 : true;
    }
  });

  // SORT: new list
  document.getElementById('btn-new-list').addEventListener('click', () => {
    ui.phase        = 'input';
    ui.sortedResult = null;
    ui.checkedItems = {};
    const textarea  = document.getElementById('list-input');
    if (textarea) textarea.value = '';
    const btn = document.getElementById('btn-sort');
    if (btn) btn.disabled = true;
    renderSortView();
  });

  // SORT: enable/disable sort button on input
  document.getElementById('list-input').addEventListener('input', () => {
    const textarea = document.getElementById('list-input');
    const btn      = document.getElementById('btn-sort');
    if (textarea && btn) btn.disabled = textarea.value.trim().length === 0;
  });

  // RESULTS: checkbox toggle
  document.getElementById('phase-results').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' && e.target.dataset.key) {
      const key  = e.target.dataset.key;
      const item = e.target.closest('.checklist-item');
      if (e.target.checked) {
        ui.checkedItems[key] = true;
        if (item) item.classList.add('checked');
      } else {
        delete ui.checkedItems[key];
        if (item) item.classList.remove('checked');
      }
      updateSectionBadge(e.target.closest('.section-card'));
    }
  });

  // RESULTS: assign uncategorized item
  document.getElementById('phase-results').addEventListener('click', (e) => {
    const assignBtn = e.target.closest('.assign-btn');
    if (!assignBtn) return;
    const itemText = assignBtn.dataset.item;
    const row      = assignBtn.closest('.uncategorized-item');
    const select   = row ? row.querySelector('.assign-select') : null;
    const sectionId = select ? select.value : '';
    if (!sectionId) return;

    if (ui.sortedResult) {
      ui.sortedResult.uncategorized = ui.sortedResult.uncategorized.filter(i => i !== itemText);
      if (!ui.sortedResult[sectionId]) ui.sortedResult[sectionId] = [];
      ui.sortedResult[sectionId].push(itemText);
    }
    renderResults();
  });

  // SECTIONS: add section button
  document.getElementById('btn-add-section').addEventListener('click', () => {
    openModal('add');
  });

  // SECTIONS: section row actions (event delegation)
  document.getElementById('sections-list').addEventListener('click', (e) => {
    // Section actions
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action    = btn.dataset.action;
      const sectionId = btn.dataset.sectionId;
      if (action === 'edit-section')   openModal('edit', sectionId);
      if (action === 'delete-section') handleDeleteSection(sectionId);
      if (action === 'move-up')        handleMoveSection(sectionId, -1);
      if (action === 'move-down')      handleMoveSection(sectionId, 1);
      return;
    }

    // Provider toggle
    const providerBtn = e.target.closest('.provider-btn');
    if (providerBtn && providerBtn.dataset.provider) {
      state.apiProvider = providerBtn.dataset.provider;
      saveState();
      renderSectionsView();
      return;
    }

    // Language toggle (also matched via .provider-btn, checked after provider)
    if (providerBtn && providerBtn.dataset.lang) {
      state.sectionLang = providerBtn.dataset.lang;
      saveState();
      renderSectionsView();
      return;
    }


    // Reset sections to defaults
    if (e.target.id === 'btn-reset-sections') {
      if (confirm('Reset all sections to the default list? Your current sections will be replaced.')) {
        state.sections = createDefaultSections();
        saveState();
        renderSectionsView();
      }
      return;
    }

    // Save API key
    if (e.target.id === 'btn-save-key') {
      const input = document.getElementById('api-key-input');
      if (input) {
        state.apiKey = input.value.trim();
        saveState();
        renderSectionsView();
      }
    }
  });

  // MODAL: cancel & save
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveModal);

  // MODAL: overlay click to dismiss
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // MODAL BODY: color swatch & name input
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
}

function handleDeleteSection(sectionId) {
  const section = state.sections.find(s => s.id === sectionId);
  if (!section) return;
  if (!confirm(`Delete "${section.name}"? This cannot be undone.`)) return;
  state.sections = state.sections.filter(s => s.id !== sectionId);
  normalizeOrders();
  saveState();
  renderSectionsView();
}

function handleMoveSection(sectionId, direction) {
  const sorted     = getSortedSections();
  const index      = sorted.findIndex(s => s.id === sectionId);
  if (index === -1) return;
  const swapIndex  = index + direction;
  if (swapIndex < 0 || swapIndex >= sorted.length) return;

  const sectionA = state.sections.find(s => s.id === sorted[index].id);
  const sectionB = state.sections.find(s => s.id === sorted[swapIndex].id);
  if (!sectionA || !sectionB) return;

  const tempOrder  = sectionA.order;
  sectionA.order   = sectionB.order;
  sectionB.order   = tempOrder;
  normalizeOrders();
  saveState();
  renderSectionsView();
}

function updateSectionBadge(card) {
  if (!card) return;
  const total   = card.querySelectorAll('input[type="checkbox"]').length;
  const checked = card.querySelectorAll('input[type="checkbox"]:checked').length;
  const badge   = card.querySelector('.section-card-count');
  if (badge) badge.textContent = `${checked}/${total}`;
}

// ============================================================
// RENDER (top-level)
// ============================================================

function render() {
  const sortView     = document.getElementById('view-sort');
  const sectionsView = document.getElementById('view-sections');

  if (ui.view === 'sort') {
    sortView.classList.remove('hidden');
    sectionsView.classList.add('hidden');
    renderSortView();
  } else {
    sortView.classList.add('hidden');
    sectionsView.classList.remove('hidden');
    renderSectionsView();
  }
}

// ============================================================
// INIT
// ============================================================

function init() {
  loadState();

  if (state.sections.length === 0) {
    state.sections = createDefaultSections();
    saveState();
  }

  const btn = document.getElementById('btn-sort');
  if (btn) btn.disabled = true;

  setupEventListeners();
  render();
}

document.addEventListener('DOMContentLoaded', init);
