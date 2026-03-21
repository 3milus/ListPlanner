// ============================================================
// CONSTANTS
// ============================================================

const STORAGE_KEY = 'listplanner_v2';

const PALETTE = [
  '#2A9D8F', '#E9C46A', '#457B9D', '#E76F51',
  '#4CC9F0', '#F4A261', '#7B2FBE', '#F72585',
  '#06D6A0', '#6C757D',
];

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
};

let ui = {
  view: 'sort',
  sortPhase: 'input',
  selectedPresetId: null,
  sortedResult: null,
  presetsSubView: 'list',
  editingPresetId: null,
  modalMode: null,
  modalDraft: null,
  presetModalMode: null,
  expandedListIds: {},
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
// PERSISTENCE
// ============================================================

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.presets && Array.isArray(parsed.presets)) state.presets = parsed.presets;
      if (parsed.lists && Array.isArray(parsed.lists)) state.lists = parsed.lists;
      if (parsed.apiKey) state.apiKey = parsed.apiKey;
      if (parsed.apiProvider) state.apiProvider = parsed.apiProvider;
      return;
    }

    // Migrate from v1 if present
    const v1raw = localStorage.getItem('listplanner_v1');
    if (v1raw) {
      const v1 = JSON.parse(v1raw);
      if (v1.sections && Array.isArray(v1.sections) && !v1.presets) {
        const migratedSections = v1.sections.map(s => ({
          id: s.id,
          name: s.name,
          color: s.color,
          order: s.order,
        }));
        const migratedPreset = {
          id: uid(),
          name: 'My Store',
          sections: migratedSections,
        };
        state.presets = [migratedPreset];
        if (v1.apiKey) state.apiKey = v1.apiKey;
        if (v1.apiProvider) state.apiProvider = v1.apiProvider;
        saveState();
        return;
      }
    }
  } catch (e) {
    console.error('Failed to load state:', e);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      presets: state.presets,
      lists: state.lists,
      apiKey: state.apiKey,
      apiProvider: state.apiProvider,
    }));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
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
// RENDER: SORT VIEW
// ============================================================

function renderSortView() {
  renderPresetPicker();

  const phaseInput   = document.getElementById('phase-input');
  const phaseResults = document.getElementById('phase-results');
  const btnNewList   = document.getElementById('btn-new-list');

  if (ui.sortPhase === 'input') {
    phaseInput.classList.remove('hidden');
    phaseResults.classList.add('hidden');
    btnNewList.classList.add('hidden');
    updateSortButton();
  } else {
    phaseInput.classList.add('hidden');
    phaseResults.classList.remove('hidden');
    btnNewList.classList.remove('hidden');
    renderResults();
  }
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
  const textarea = document.getElementById('list-input');
  const btn = document.getElementById('btn-sort');
  if (!textarea || !btn) return;
  const hasText = textarea.value.trim().length > 0;
  const hasPreset = !!ui.selectedPresetId && !!state.presets.find(p => p.id === ui.selectedPresetId);
  btn.disabled = !(hasText && hasPreset);
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
      html += renderSectionCard(s, items, null);
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

function renderSectionCard(section, items, checkedItems) {
  const tintColor = hexToRgba(section.color, 0.12);
  const checked = checkedItems || {};
  const checkedCount = items.filter(item => checked[`${section.id}::${item}`]).length;

  const itemsHtml = items.map(item => {
    const key = `${section.id}::${item}`;
    const isChecked = !!checked[key];
    const eItem = escapeHtml(item);
    const eKey = escapeHtml(key);
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

  const sorted = [...state.lists].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  container.innerHTML = sorted.map(list => renderListCard(list)).join('');
}

function renderListCard(list) {
  const firstSection = list.sections && list.sections.length > 0 ? list.sections[0] : null;
  const dotColor = firstSection ? firstSection.color : '#6C757D';
  const isExpanded = !!ui.expandedListIds[list.id];
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
        cardsHtml += renderListSectionCard(list.id, s, sectionItems, checked);
      }
    });

    const uncatItems = items.uncategorized || [];
    if (uncatItems.length > 0) {
      cardsHtml += renderListUncategorized(list.id, uncatItems, sections);
    }

    if (!cardsHtml) {
      cardsHtml = '<p class="no-items-msg">No items.</p>';
    }

    bodyHtml = `<div class="list-card-body">${cardsHtml}</div>`;
  }

  return `
    <div class="list-card" data-list-id="${escapeHtml(list.id)}">
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

function renderListSectionCard(listId, section, items, checkedItems) {
  const tintColor = hexToRgba(section.color, 0.12);
  const checked = checkedItems || {};
  const checkedCount = items.filter(item => checked[`${section.id}::${item}`]).length;

  const itemsHtml = items.map(item => {
    const key = `${section.id}::${item}`;
    const isChecked = !!checked[key];
    const eItem = escapeHtml(item);
    const eKey = escapeHtml(key);
    const eLid = escapeHtml(listId);
    return `
      <li class="checklist-item${isChecked ? ' checked' : ''}" data-key="${eKey}">
        <input type="checkbox" id="lcb-${eLid}-${eKey}" ${isChecked ? 'checked' : ''} data-key="${eKey}" data-list-id="${eLid}" data-action="toggle-check" />
        <label for="lcb-${eLid}-${eKey}">${eItem}</label>
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
      </div>
      ${itemsHtml}
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
    preset.sections.push({ id: ui.modalDraft.id, name, color: ui.modalDraft.color, order: maxOrder });
  } else if (ui.modalMode === 'edit-section') {
    const section = preset.sections.find(s => s.id === ui.modalDraft.id);
    if (section) {
      section.name = name;
      section.color = ui.modalDraft.color;
    }
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
    if (titleEl) titleEl.textContent = 'Rename Preset';
    if (input) input.value = preset.name;
  } else {
    if (titleEl) titleEl.textContent = 'New Preset';
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

  // BOTTOM NAV
  document.querySelector('.bottom-nav').addEventListener('click', (e) => {
    const tab = e.target.closest('.nav-tab');
    if (!tab) return;
    const view = tab.dataset.view;
    if (!view || view === ui.view) return;
    switchView(view);
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
    ui.sortPhase = 'input';
    ui.sortedResult = null;
    const textarea = document.getElementById('list-input');
    if (textarea) textarea.value = '';
    renderSortView();
  });

  // SORT results: checkbox toggle
  document.getElementById('phase-results').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' && e.target.dataset.key) {
      const item = e.target.closest('.checklist-item');
      if (e.target.checked) {
        if (item) item.classList.add('checked');
      } else {
        if (item) item.classList.remove('checked');
      }
      updateSectionBadge(e.target.closest('.section-card'));
    }
  });

  // SORT results: assign uncategorized
  document.getElementById('phase-results').addEventListener('click', (e) => {
    const assignBtn = e.target.closest('.assign-btn');
    if (!assignBtn) return;
    const itemText = assignBtn.dataset.item;
    const row = assignBtn.closest('.uncategorized-item');
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
      createdAt: new Date().toISOString(),
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
    const assignBtn = e.target.closest('[data-action="assign-list-item"]');
    if (assignBtn) {
      const listId = assignBtn.dataset.listId;
      const itemText = assignBtn.dataset.item;
      const row = assignBtn.closest('.uncategorized-item');
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
        list.checkedItems[key] = true;
        if (item) item.classList.add('checked');
      } else {
        delete list.checkedItems[key];
        if (item) item.classList.remove('checked');
      }

      updateSectionBadge(e.target.closest('.section-card'));
      saveState();
    }
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
        if (usedCount > 0) msg += ` ${usedCount} saved list${usedCount !== 1 ? 's' : ''} use this preset.`;
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
// INIT
// ============================================================

function init() {
  loadState();

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
    saveState();
  }

  setupEventListeners();
  render();
}

document.addEventListener('DOMContentLoaded', init);
