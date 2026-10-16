// ============================================================================
// NAIT FINANCE — Mobile-First PWA with SQLite WebAssembly + Groq/Gemini AI
// ============================================================================

const DB_STORE_NAME = 'nait_finance_idb';
const DB_KEY = 'sqlite_binary_dump';

// Option A (BYOK — Bring Your Own Key): No hardcoded keys in source code.
// Users enter their personal Groq / Gemini API keys in Settings (stored in device localStorage).
const DEFAULT_KEYS = {
  groq: '',
  gemini: ''
};

let db = null;
let SQL = null;
let currentFilter = 'all';
let currentReportPeriod = 'weekly';
let currentProvider = localStorage.getItem('nait_llm_provider') || 'groq';
let maskBalance = false;
let chatMessages = [];
let deferredInstallPrompt = null;

// ============================================================================
// 1. INDEXEDDB PERSISTENCE FOR SQLITE WASM BINARY
// ============================================================================
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_STORE_NAME, 1);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('files')) {
        idb.createObjectStore('files');
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveDatabaseToDevice() {
  if (!db) return;
  const binaryArray = db.export();
  try {
    const idb = await openIndexedDB();
    await new Promise((resolve, reject) => {
      const tx = idb.transaction('files', 'readwrite');
      tx.objectStore('files').put(binaryArray, DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = (err) => reject(err);
    });
  } catch (err) {
    console.warn('IndexedDB persistence warning:', err);
  }
}

async function loadDatabaseFromDevice() {
  try {
    const idb = await openIndexedDB();
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(DB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (err) => reject(err);
    });
  } catch (err) {
    return null;
  }
}

// ============================================================================
// 2. INITIALIZE SQLITE WEBASSEMBLY ENGINE & SCHEMA MIGRATIONS
// ============================================================================
async function initSqliteEngine() {
  try {
    SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });

    const savedBytes = await loadDatabaseFromDevice();
    if (savedBytes && savedBytes.byteLength > 0) {
      db = new SQL.Database(new Uint8Array(savedBytes));
      ensureSchema();
    } else {
      db = new SQL.Database();
      ensureSchema();
      await saveDatabaseToDevice();
    }

    refreshAllViews();
    initChatGreeting();
  } catch (err) {
    console.error('Failed to initialize SQLite WebAssembly:', err);
  }
}

function ensureSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('deposit', 'spend')),
      account TEXT NOT NULL CHECK(account IN ('cash', 'e-wallet', 'bank')),
      sub_account TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Deposit',
      description TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_created_at ON transactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
  `);

  // Seamless migration for existing device databases that don't have sub_account yet
  try {
    const cols = queryAll(`PRAGMA table_info(transactions)`);
    const hasSubAcc = cols.some((c) => c.name === 'sub_account');
    if (!hasSubAcc) {
      db.run(`ALTER TABLE transactions ADD COLUMN sub_account TEXT NOT NULL DEFAULT '';`);
    }
  } catch (e) {
    console.warn('Migration check:', e);
  }
}

// Helper to run SELECT queries and return an array of objects safely
function queryAll(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ============================================================================
// 3. FORMATTERS & UI HELPERS
// ============================================================================
function formatCurrency(val) {
  const num = Number(val) || 0;
  const sign = num < 0 ? '-' : '';
  return `${sign}₱${Math.abs(num).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatRelativeDate(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today, ${timeStr}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} • ${timeStr}`;
}

function getAccountMeta(account, subAccount = '') {
  const sub = (subAccount || '').trim();
  switch ((account || '').toLowerCase()) {
    case 'cash':
      return {
        label: 'Cash',
        fullLabel: 'Cash',
        icon: 'pi-money-bill',
        badge: 'bg-emerald-50 text-emerald-700 border-emerald-200'
      };
    case 'e-wallet':
      return {
        label: 'E-Wallet',
        fullLabel: sub ? `E-Wallet • ${sub}` : 'E-Wallet',
        icon: 'pi-mobile',
        badge: 'bg-sky-50 text-sky-700 border-sky-200'
      };
    case 'bank':
      return {
        label: 'Bank',
        fullLabel: sub ? `Bank • ${sub}` : 'Bank',
        icon: 'pi-building-columns',
        badge: 'bg-indigo-50 text-indigo-700 border-indigo-200'
      };
    default:
      return {
        label: account,
        fullLabel: sub ? `${account} • ${sub}` : account,
        icon: 'pi-wallet',
        badge: 'bg-slate-100 text-slate-700 border-slate-200'
      };
  }
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const msg = document.getElementById('toastMsg');
  msg.textContent = message;
  icon.className = isError
    ? 'pi pi-exclamation-circle text-rose-500 text-xs'
    : 'pi pi-check-circle text-emerald-600 text-xs';
  toast.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 2600);
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  if (id === 'depositModal') {
    handleAccountTypeChange('deposit');
  } else if (id === 'spendModal') {
    handleAccountTypeChange('spend');
  } else if (id === 'walletsBreakdownModal') {
    renderBalances();
  } else if (id === 'reportsModal') {
    renderReportsAnalytics();
  } else if (id === 'settingsModal') {
    loadApiKeysToSettings();
  } else if (id === 'trackModal') {
    setTimeout(() => {
      const container = document.getElementById('chatContainer');
      container.scrollTop = container.scrollHeight;
    }, 60);
  }
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================================
// 4. CONDITIONAL SUB-ACCOUNT SELECT + INPUT (E-WALLET & BANK)
// ============================================================================
function handleAccountTypeChange(mode) {
  const isDeposit = mode === 'deposit';
  const selectEl = document.getElementById(isDeposit ? 'depositFrom' : 'spendPaidFrom');
  const wrapEl = document.getElementById(isDeposit ? 'depositSubAccountWrap' : 'spendSubAccountWrap');
  const labelEl = document.getElementById(isDeposit ? 'depositSubAccountLabel' : 'spendSubAccountLabel');
  const iconEl = document.getElementById(isDeposit ? 'depositSubAccountIcon' : 'spendSubAccountIcon');
  const inputEl = document.getElementById(isDeposit ? 'depositSubAccount' : 'spendSubAccount');
  const datalistEl = document.getElementById(isDeposit ? 'depositSubSuggestions' : 'spendSubSuggestions');

  if (!selectEl || !wrapEl || !inputEl) return;

  const accountType = selectEl.value;
  if (accountType === 'cash') {
    wrapEl.classList.add('hidden');
    inputEl.required = false;
    inputEl.value = '';
    return;
  }

  // Show sub-account input when 'e-wallet' or 'bank' is chosen
  wrapEl.classList.remove('hidden');
  inputEl.required = true;
  inputEl.value = '';

  const accentStarClass = isDeposit ? 'text-emerald-600' : 'text-rose-600';
  if (accountType === 'e-wallet') {
    labelEl.innerHTML = `E-Wallet <span class="${accentStarClass}">*</span>`;
    iconEl.className = 'pi pi-mobile absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs';
  } else {
    labelEl.innerHTML = `Bank <span class="${accentStarClass}">*</span>`;
    iconEl.className = 'pi pi-building-columns absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs';
  }

  // Populate historical sub-accounts strictly from SQLite for the selected account type
  const rows = queryAll(
    `SELECT TRIM(sub_account) AS sub_name, MAX(datetime(created_at)) AS last_used
     FROM transactions
     WHERE account = ? AND TRIM(sub_account) != ''
     GROUP BY LOWER(TRIM(sub_account))
     ORDER BY last_used DESC`,
    [accountType]
  );

  if (datalistEl) {
    datalistEl.innerHTML = rows
      .map((r) => `<option value="${escapeHtml(r.sub_name)}"></option>`)
      .join('');
  }
}

function renderCategorySuggestions() {
  const datalist = document.getElementById('categorySuggestions');
  if (!datalist) return;
  const rows = queryAll(`
    SELECT TRIM(category) AS category, MAX(datetime(created_at)) AS last_used
    FROM transactions
    WHERE type = 'spend' AND TRIM(category) != ''
    GROUP BY LOWER(TRIM(category))
    ORDER BY last_used DESC
  `);
  datalist.innerHTML = rows
    .map((r) => `<option value="${escapeHtml(r.category)}"></option>`)
    .join('');
}

// ============================================================================
// 5. BALANCE, WALLETS BREAKDOWN & TRANSACTIONS RENDERING
// ============================================================================
function refreshAllViews() {
  renderBalances();
  renderRecentTransactions();
  renderCategorySuggestions();
}

function renderBalances() {
  const totals = queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS total_deposit,
      COALESCE(SUM(CASE WHEN type = 'spend' THEN amount ELSE 0 END), 0) AS total_spend
    FROM transactions
  `) || { total_deposit: 0, total_spend: 0 };

  const net = totals.total_deposit - totals.total_spend;

  const byAccRows = queryAll(`
    SELECT
      account,
      COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS total_in,
      COALESCE(SUM(CASE WHEN type = 'spend' THEN amount ELSE 0 END), 0) AS total_out,
      COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0) AS net_amount
    FROM transactions
    GROUP BY account
  `);

  const accMap = {
    'cash': { in: 0, out: 0, net: 0 },
    'e-wallet': { in: 0, out: 0, net: 0 },
    'bank': { in: 0, out: 0, net: 0 }
  };
  byAccRows.forEach((r) => {
    if (accMap[r.account]) {
      accMap[r.account] = { in: r.total_in, out: r.total_out, net: r.net_amount };
    }
  });

  document.getElementById('totalNetBalance').textContent = maskBalance ? '₱ ••••••' : formatCurrency(net);
  document.getElementById('totalDepositsDisplay').textContent = maskBalance ? '••••' : formatCurrency(totals.total_deposit);
  document.getElementById('totalSpendsDisplay').textContent = maskBalance ? '••••' : formatCurrency(totals.total_spend);

  const positiveTotal = Math.max(0, accMap['cash'].net) + Math.max(0, accMap['e-wallet'].net) + Math.max(0, accMap['bank'].net);

  const updateWalletCard = (key, balId, shareId, barId) => {
    const d = accMap[key];
    const pct = positiveTotal > 0 && d.net > 0 ? Math.round((d.net / positiveTotal) * 100) : 0;
    const balEl = document.getElementById(balId);
    if (balEl) {
      balEl.textContent = formatCurrency(d.net);
      balEl.className = `text-sm font-extrabold font-mono shrink-0 ${d.net < 0 ? 'text-rose-600' : 'text-slate-900'}`;
    }
    const shareEl = document.getElementById(shareId);
    if (shareEl) shareEl.textContent = `${pct}%`;
    const barEl = document.getElementById(barId);
    if (barEl) barEl.style.width = `${pct}%`;
  };

  updateWalletCard('cash', 'balCash', 'shareCash', 'barCash');
  updateWalletCard('e-wallet', 'balEwallet', 'shareEwallet', 'barEwallet');
  updateWalletCard('bank', 'balBank', 'shareBank', 'barBank');

  // Render Sub-Account Breakdowns inside E-Wallet & Bank cards in Wallet Portfolio modal
  renderSubAccountBreakdown('e-wallet', 'subListEwallet', 'text-sky-600');
  renderSubAccountBreakdown('bank', 'subListBank', 'text-indigo-600');
}

function renderSubAccountBreakdown(accountType, containerId, dotColorClass) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const subRows = queryAll(
    `SELECT
       CASE WHEN TRIM(sub_account) = '' THEN 'Unspecified' ELSE TRIM(sub_account) END AS sub_name,
       COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0) AS net_val
     FROM transactions
     WHERE account = ?
     GROUP BY LOWER(CASE WHEN TRIM(sub_account) = '' THEN 'Unspecified' ELSE TRIM(sub_account) END)
     ORDER BY net_val DESC`,
    [accountType]
  );

  if (subRows.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = subRows
    .map(
      (s) => `
      <div class="flex items-center justify-between text-[11px] py-0.5 px-1 rounded-lg hover:bg-slate-50">
        <span class="font-semibold text-slate-600 flex items-center gap-1.5 truncate">
          <span class="w-1.5 h-1.5 rounded-full bg-current ${dotColorClass}"></span>
          ${escapeHtml(s.sub_name)}
        </span>
        <span class="font-mono font-bold ${s.net_val < 0 ? 'text-rose-600' : 'text-slate-800'}">
          ${formatCurrency(s.net_val)}
        </span>
      </div>
    `
    )
    .join('');
}

function setTxFilter(filter) {
  currentFilter = filter;
  ['all', 'deposit', 'spend'].forEach((f) => {
    const btn = document.getElementById(`filter-${f}`);
    if (f === filter) {
      btn.className = 'px-2 py-0.5 rounded-md font-bold bg-white text-slate-900 shadow-sm transition';
    } else {
      btn.className = 'px-2 py-0.5 rounded-md font-semibold text-slate-600 hover:text-slate-900 transition';
    }
  });
  renderRecentTransactions();
}

function renderRecentTransactions() {
  const search = (document.getElementById('txSearchInput')?.value || '').trim().toLowerCase();
  let sql = `SELECT * FROM transactions WHERE 1=1`;
  const params = [];

  if (currentFilter !== 'all') {
    sql += ` AND type = ?`;
    params.push(currentFilter);
  }
  if (search) {
    sql += ` AND (LOWER(description) LIKE ? OR LOWER(category) LIKE ? OR LOWER(account) LIKE ? OR LOWER(sub_account) LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY datetime(created_at) DESC, id DESC LIMIT 100`;

  const rows = queryAll(sql, params);
  const container = document.getElementById('transactionsList');

  if (rows.length === 0) {
    container.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-2xl p-6 text-center space-y-1.5 shadow-sm">
        <div class="w-10 h-10 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
          <i class="pi pi-inbox text-base"></i>
        </div>
        <p class="text-xs font-bold text-slate-700">No transactions yet</p>
        <p class="text-[11px] text-slate-500 max-w-[220px] mx-auto">Tap <span class="text-emerald-600 font-semibold">Deposit</span> or <span class="text-rose-600 font-semibold">Spend</span> below to record your first transaction.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = rows
    .map((tx) => {
      const isDeposit = tx.type === 'deposit';
      const acc = getAccountMeta(tx.account, tx.sub_account);
      return `
        <div class="bg-white hover:bg-slate-50/80 border border-slate-200/90 rounded-xl px-3 py-2.5 flex items-center justify-between gap-2.5 transition shadow-sm">
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <div class="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
              isDeposit
                ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                : 'bg-rose-50 text-rose-600 border border-rose-200'
            }">
              <i class="pi ${isDeposit ? 'pi-arrow-down-left' : 'pi-arrow-up-right'} text-xs"></i>
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-slate-900 truncate leading-snug">${escapeHtml(tx.description)}</p>
              <div class="flex items-center flex-wrap gap-1 mt-0.5">
                <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold border ${acc.badge}">
                  <i class="pi ${acc.icon} text-[8px]"></i> ${escapeHtml(acc.fullLabel)}
                </span>
                ${
                  !isDeposit
                    ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
                        ${escapeHtml(tx.category)}
                      </span>`
                    : ''
                }
                <span class="text-[9px] text-slate-400">• ${formatRelativeDate(tx.created_at)}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <p class="text-xs font-extrabold font-mono ${isDeposit ? 'text-emerald-600' : 'text-rose-600'}">
              ${isDeposit ? '+' : '-'}${formatCurrency(tx.amount)}
            </p>
            <button
              onclick="deleteTransaction(${tx.id})"
              title="Delete"
              class="w-6 h-6 rounded-md hover:bg-rose-50 text-slate-300 hover:text-rose-600 flex items-center justify-center transition"
            >
              <i class="pi pi-trash text-[10px]"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAmountInput(input) {
  let raw = input.value.replace(/[^0-9.]/g, '');
  const parts = raw.split('.');
  if (parts.length > 2) {
    raw = parts[0] + '.' + parts.slice(1).join('');
  }
  const [intPart, decPart] = raw.split('.');
  const formattedInt = intPart ? Number(intPart).toLocaleString('en-US') : '';
  if (decPart !== undefined) {
    input.value = `${formattedInt}.${decPart.slice(0, 2)}`;
  } else {
    input.value = formattedInt;
  }
}

function parseFormattedAmount(val) {
  return parseFloat(String(val || '').replace(/,/g, ''));
}

// ============================================================================
// 6. DEPOSIT & SPEND CRUD OPERATIONS
// ============================================================================
async function handleDepositSubmit(e) {
  e.preventDefault();
  const from = document.getElementById('depositFrom').value;
  const subAccount = from === 'cash' ? '' : (document.getElementById('depositSubAccount')?.value || '').trim();
  const description = document.getElementById('depositDescription').value.trim();
  const amount = parseFormattedAmount(document.getElementById('depositAmount').value);

  if ((from !== 'cash' && !subAccount) || !description || isNaN(amount) || amount <= 0) {
    showToast('Please complete all required fields.', true);
    return;
  }

  db.run(
    `INSERT INTO transactions (type, account, sub_account, category, description, amount, created_at)
     VALUES ('deposit', ?, ?, 'Deposit', ?, ?, ?)`,
    [from, subAccount, description, amount, new Date().toISOString()]
  );

  await saveDatabaseToDevice();
  document.getElementById('depositForm').reset();
  handleAccountTypeChange('deposit');
  closeModal('depositModal');
  refreshAllViews();
  const targetLabel = subAccount ? `${from.toUpperCase()} (${subAccount})` : from.toUpperCase();
  showToast(`Deposited ${formatCurrency(amount)} to ${targetLabel}`);
}

async function handleSpendSubmit(e) {
  e.preventDefault();
  const category = document.getElementById('spendCategory').value.trim();
  const paidFrom = document.getElementById('spendPaidFrom').value;
  const subAccount = paidFrom === 'cash' ? '' : (document.getElementById('spendSubAccount')?.value || '').trim();
  const description = document.getElementById('spendDescription').value.trim();
  const amount = parseFormattedAmount(document.getElementById('spendAmount').value);

  if (!category || (paidFrom !== 'cash' && !subAccount) || !description || isNaN(amount) || amount <= 0) {
    showToast('Please complete all spend fields.', true);
    return;
  }

  db.run(
    `INSERT INTO transactions (type, account, sub_account, category, description, amount, created_at)
     VALUES ('spend', ?, ?, ?, ?, ?, ?)`,
    [paidFrom, subAccount, category, description, amount, new Date().toISOString()]
  );

  await saveDatabaseToDevice();
  document.getElementById('spendForm').reset();
  handleAccountTypeChange('spend');
  closeModal('spendModal');
  refreshAllViews();
  const sourceLabel = subAccount ? `${paidFrom.toUpperCase()} (${subAccount})` : paidFrom.toUpperCase();
  showToast(`Spent ${formatCurrency(amount)} from ${sourceLabel}`);
}

let pendingDeleteTxId = null;

function deleteTransaction(id) {
  pendingDeleteTxId = id;
  const tx = queryOne(`SELECT description, amount, type FROM transactions WHERE id = ?`, [id]);
  const descEl = document.getElementById('deleteConfirmDesc');
  if (descEl && tx) {
    descEl.innerHTML = `Remove <strong class="text-slate-800">${escapeHtml(tx.description)}</strong> (${formatCurrency(tx.amount)})?`;
  }
  openModal('deleteConfirmModal');
}

async function confirmDeleteTransaction() {
  if (pendingDeleteTxId === null) return;
  db.run(`DELETE FROM transactions WHERE id = ?`, [pendingDeleteTxId]);
  pendingDeleteTxId = null;
  await saveDatabaseToDevice();
  closeModal('deleteConfirmModal');
  refreshAllViews();
  showToast('Transaction removed');
}

// ============================================================================
// 7. REPORTS & ANALYTICS (WEEKLY / MONTHLY / YEARLY)
// ============================================================================
function setReportPeriod(period) {
  currentReportPeriod = period;
  ['weekly', 'monthly', 'yearly'].forEach((p) => {
    const btn = document.getElementById(`rep-${p}`);
    if (p === period) {
      btn.className = 'py-1.5 rounded-lg text-[11px] font-bold transition bg-blue-600 text-white shadow-sm';
    } else {
      btn.className = 'py-1.5 rounded-lg text-[11px] font-bold transition text-slate-600 hover:text-slate-900';
    }
  });
  renderReportsAnalytics();
}

function renderReportsAnalytics() {
  const now = new Date();
  let cutoffDate = new Date();
  let daysDivisor = 7;

  if (currentReportPeriod === 'weekly') {
    cutoffDate.setDate(now.getDate() - 6);
    cutoffDate.setHours(0, 0, 0, 0);
    daysDivisor = 7;
    document.getElementById('repChartTitle').textContent = 'Last 7 Days Cashflow';
  } else if (currentReportPeriod === 'monthly') {
    cutoffDate.setDate(now.getDate() - 29);
    cutoffDate.setHours(0, 0, 0, 0);
    daysDivisor = 30;
    document.getElementById('repChartTitle').textContent = 'Last 30 Days (By Week)';
  } else {
    cutoffDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    daysDivisor = 365;
    document.getElementById('repChartTitle').textContent = 'Last 12 Months Cashflow';
  }

  const cutoffIso = cutoffDate.toISOString();

  // Period Totals
  const summary = queryOne(
    `SELECT
       COUNT(*) AS tx_count,
       COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS total_in,
       COALESCE(SUM(CASE WHEN type = 'spend' THEN amount ELSE 0 END), 0) AS total_out
     FROM transactions
     WHERE datetime(created_at) >= datetime(?)`,
    [cutoffIso]
  ) || { tx_count: 0, total_in: 0, total_out: 0 };

  const netFlow = summary.total_in - summary.total_out;
  document.getElementById('repTotalIn').textContent = formatCurrency(summary.total_in);
  document.getElementById('repTotalOut').textContent = formatCurrency(summary.total_out);
  const netEl = document.getElementById('repNetFlow');
  netEl.textContent = (netFlow >= 0 ? '+' : '') + formatCurrency(netFlow);
  netEl.className = `text-xs font-extrabold font-mono mt-0.5 break-all ${netFlow >= 0 ? 'text-emerald-600' : 'text-rose-600'}`;

  // Savings Rate & Ratio Bar
  const totalVolume = summary.total_in + summary.total_out;
  const inPct = totalVolume > 0 ? Math.round((summary.total_in / totalVolume) * 100) : 50;
  const outPct = 100 - inPct;
  document.getElementById('repInBar').style.width = `${inPct}%`;
  document.getElementById('repOutBar').style.width = `${outPct}%`;

  const savingsRate = summary.total_in > 0
    ? Math.round(((summary.total_in - summary.total_out) / summary.total_in) * 100)
    : 0;
  document.getElementById('repSavingsRateLabel').textContent =
    summary.total_in > 0 ? `${savingsRate}% Net Saved` : 'No Deposits in Period';
  document.getElementById('repTxCountLabel').textContent = `${summary.tx_count} transactions`;
  document.getElementById('repAvgDailyLabel').textContent = `Avg/day: ${formatCurrency(summary.total_out / daysDivisor)}`;

  // Build Timeline Buckets for Bar Chart
  const allPeriodTxs = queryAll(
    `SELECT type, amount, created_at FROM transactions WHERE datetime(created_at) >= datetime(?) ORDER BY datetime(created_at) ASC`,
    [cutoffIso]
  );
  renderTimelineBuckets(allPeriodTxs, currentReportPeriod);

  // Category Breakdown
  const catRows = queryAll(
    `SELECT TRIM(category) AS category, SUM(amount) AS total, COUNT(*) AS cnt
     FROM transactions
     WHERE type = 'spend' AND datetime(created_at) >= datetime(?)
     GROUP BY LOWER(TRIM(category))
     ORDER BY total DESC`,
    [cutoffIso]
  );

  const catContainer = document.getElementById('repCategoryList');
  if (catRows.length === 0) {
    catContainer.innerHTML = `<p class="text-xs text-slate-400 text-center py-3">No expenses recorded in this period.</p>`;
  } else {
    catContainer.innerHTML = catRows
      .map((c) => {
        const pct = summary.total_out > 0 ? Math.round((c.total / summary.total_out) * 100) : 0;
        return `
          <div>
            <div class="flex items-center justify-between text-xs mb-1">
              <span class="font-bold text-slate-700 flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full bg-rose-500"></span>
                ${escapeHtml(c.category)}
                <span class="text-[10px] text-slate-400 font-normal">(${c.cnt})</span>
              </span>
              <span class="font-mono font-bold text-rose-600">${formatCurrency(c.total)} <span class="text-slate-400 text-[10px]">(${pct}%)</span></span>
            </div>
            <div class="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
              <div class="h-full bg-gradient-to-r from-rose-500 to-orange-400 rounded-full" style="width: ${Math.max(pct, 4)}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // Wallet / Account + Sub-Account Breakdown in Reports
  const accRows = queryAll(
    `SELECT
       account,
       TRIM(sub_account) AS sub_account,
       COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS dep,
       COALESCE(SUM(CASE WHEN type = 'spend' THEN amount ELSE 0 END), 0) AS spd
     FROM transactions
     WHERE datetime(created_at) >= datetime(?)
     GROUP BY account, LOWER(TRIM(sub_account))
     ORDER BY account ASC, (dep + spd) DESC`,
    [cutoffIso]
  );

  if (accRows.length === 0) {
    document.getElementById('repWalletList').innerHTML = `<p class="text-xs text-slate-400 text-center py-2">No account activity in this period.</p>`;
  } else {
    document.getElementById('repWalletList').innerHTML = accRows
      .map((r) => {
        const meta = getAccountMeta(r.account, r.sub_account);
        return `
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-7 h-7 rounded-lg flex items-center justify-center border shrink-0 ${meta.badge}">
                <i class="pi ${meta.icon} text-[11px]"></i>
              </span>
              <span class="text-xs font-bold text-slate-700 truncate">${escapeHtml(meta.fullLabel)}</span>
            </div>
            <div class="flex items-center gap-2.5 text-[11px] font-mono font-semibold shrink-0">
              <span class="text-emerald-600">+${formatCurrency(r.dep)}</span>
              <span class="text-rose-600">-${formatCurrency(r.spd)}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

function renderTimelineBuckets(txs, period) {
  const now = new Date();
  const buckets = [];

  if (period === 'weekly') {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-US', { weekday: 'short' });
      buckets.push({ key, label, deposit: 0, spend: 0 });
    }
    txs.forEach((t) => {
      const k = new Date(t.created_at).toISOString().slice(0, 10);
      const b = buckets.find((x) => x.key === k);
      if (b) b[t.type] += Number(t.amount);
    });
  } else if (period === 'monthly') {
    for (let w = 4; w >= 0; w--) {
      buckets.push({ key: w, label: w === 0 ? 'This Wk' : `-${w}w`, deposit: 0, spend: 0 });
    }
    txs.forEach((t) => {
      const diffDays = Math.floor((now - new Date(t.created_at)) / (1000 * 60 * 60 * 24));
      const wkIdx = Math.min(4, Math.max(0, Math.floor(diffDays / 7)));
      const b = buckets.find((x) => x.key === wkIdx);
      if (b) b[t.type] += Number(t.amount);
    });
  } else {
    for (let m = 5; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      buckets.push({ key, label, deposit: 0, spend: 0 });
    }
    txs.forEach((t) => {
      const d = new Date(t.created_at);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const b = buckets.find((x) => x.key === k);
      if (b) b[t.type] += Number(t.amount);
    });
  }

  const maxVal = Math.max(1, ...buckets.map((b) => Math.max(b.deposit, b.spend)));
  const chartEl = document.getElementById('repBarChart');

  chartEl.innerHTML = buckets
    .map((b) => {
      const depHeight = Math.max(4, Math.round((b.deposit / maxVal) * 95));
      const spdHeight = Math.max(4, Math.round((b.spend / maxVal) * 95));
      return `
        <div class="flex-1 flex flex-col items-center gap-1">
          <div class="w-full flex items-end justify-center gap-1 h-[100px]">
            <div
              title="Deposit: ${formatCurrency(b.deposit)}"
              class="w-2.5 sm:w-3 rounded-t-md bg-emerald-500 hover:bg-emerald-600 transition-all"
              style="height: ${b.deposit > 0 ? depHeight : 3}px; opacity: ${b.deposit > 0 ? 1 : 0.2}"
            ></div>
            <div
              title="Spend: ${formatCurrency(b.spend)}"
              class="w-2.5 sm:w-3 rounded-t-md bg-rose-500 hover:bg-rose-600 transition-all"
              style="height: ${b.spend > 0 ? spdHeight : 3}px; opacity: ${b.spend > 0 ? 1 : 0.2}"
            ></div>
          </div>
          <span class="text-[9px] font-semibold text-slate-500">${b.label}</span>
        </div>
      `;
    })
    .join('');
}

// ============================================================================
// 8. TRACK MODAL — AI CONVERSATION WITH SQLITE DATABASE ACCESS (BYOK)
// ============================================================================
function getApiKey(provider) {
  const custom = localStorage.getItem(`nait_key_${provider}`);
  return (custom && custom.trim()) ? custom.trim() : DEFAULT_KEYS[provider];
}

function loadApiKeysToSettings() {
  document.getElementById('settingsGroqKey').value = getApiKey('groq');
  document.getElementById('settingsGeminiKey').value = getApiKey('gemini');
}

function saveApiKeys() {
  const gk = document.getElementById('settingsGroqKey').value.trim();
  const gem = document.getElementById('settingsGeminiKey').value.trim();
  if (gk) {
    localStorage.setItem('nait_key_groq', gk);
  } else {
    localStorage.removeItem('nait_key_groq');
  }
  if (gem) {
    localStorage.setItem('nait_key_gemini', gem);
  } else {
    localStorage.removeItem('nait_key_gemini');
  }
  showToast('API Credentials Updated');
  closeModal('settingsModal');
}

function setLLMProvider(provider) {
  currentProvider = provider;
  localStorage.setItem('nait_llm_provider', provider);

  const groqBtn = document.getElementById('providerGroqBtn');
  const geminiBtn = document.getElementById('providerGeminiBtn');

  if (provider === 'groq') {
    groqBtn.className = 'px-2 py-1 rounded-md transition flex items-center gap-1 bg-purple-600 text-white shadow-sm';
    geminiBtn.className = 'px-2 py-1 rounded-md transition flex items-center gap-1 text-slate-500 hover:text-slate-900';
  } else {
    geminiBtn.className = 'px-2 py-1 rounded-md transition flex items-center gap-1 bg-blue-600 text-white shadow-sm';
    groqBtn.className = 'px-2 py-1 rounded-md transition flex items-center gap-1 text-slate-500 hover:text-slate-900';
  }
}

function initChatGreeting() {
  setLLMProvider(currentProvider);
  renderChatMessages();
}

function clearChatHistory() {
  chatMessages = [];
  initChatGreeting();
}

function renderChatMessages() {
  const container = document.getElementById('chatContainer');
  if (!container) return;

  container.innerHTML = chatMessages
    .map((m) => {
      if (m.role === 'user') {
        return `
          <div class="flex justify-end">
            <div class="max-w-[82%] bg-gradient-to-br from-purple-600 to-indigo-600 text-white rounded-2xl rounded-br-sm px-3.5 py-2 text-xs leading-relaxed shadow-sm">
              ${escapeHtml(m.content)}
            </div>
          </div>
        `;
      } else {
        const badge = m.provider === 'gemini' ? 'Gemini AI' : 'Groq AI';
        return `
          <div class="flex justify-start">
            <div class="max-w-[88%] bg-white border border-slate-200 text-slate-700 rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-xs leading-relaxed space-y-1 shadow-sm">
              <div class="flex items-center gap-1.5 text-[10px] font-bold text-purple-600 uppercase tracking-wider">
                <i class="pi pi-sparkles text-[10px]"></i> ${badge}
              </div>
              <div class="prose-sm whitespace-pre-wrap">${formatMarkdownLite(m.content)}</div>
            </div>
          </div>
        `;
      }
    })
    .join('');

  container.scrollTop = container.scrollHeight;
}

function formatMarkdownLite(text) {
  // Strip any accidental markdown table separator rows like |---|---| or horizontal rules ---
  const cleaned = String(text || '')
    .split('\n')
    .filter((line) => !/^\s*\|?[\s\-:|]+\|[\s\-:|]*$/.test(line) && !/^\s*[-=_*]{3,}\s*$/.test(line))
    .map((line) => {
      // If a line looks like a pipe table row | a | b | c |, convert it into clean readable text
      if (/^\s*\|.*\|\s*$/.test(line)) {
        return line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(' • ');
      }
      return line.replace(/^#{1,6}\s+/, '');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const safe = escapeHtml(cleaned);
  return safe
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-900 font-bold">$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-slate-100 text-emerald-700 font-mono text-[11px] border border-slate-200">$1</code>');
}

// Build live SQLite context snapshot including sub_account breakdowns
function buildDatabaseContextSnapshot() {
  const totals = queryOne(`
    SELECT
      COUNT(*) AS total_tx_count,
      COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS total_deposits,
      COALESCE(SUM(CASE WHEN type = 'spend' THEN amount ELSE 0 END), 0) AS total_spends,
      COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0) AS net_balance
    FROM transactions
  `);

  const byAccount = queryAll(`
    SELECT
      account,
      TRIM(sub_account) AS sub_account,
      COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS deposits,
      COALESCE(SUM(CASE WHEN type = 'spend' THEN amount ELSE 0 END), 0) AS spends,
      COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0) AS net_balance
    FROM transactions
    GROUP BY account, LOWER(TRIM(sub_account))
  `);

  const byCategory = queryAll(`
    SELECT
      TRIM(category) AS category,
      COUNT(*) AS tx_count,
      ROUND(SUM(amount), 2) AS total_spent
    FROM transactions
    WHERE type = 'spend'
    GROUP BY LOWER(TRIM(category))
    ORDER BY total_spent DESC
  `);

  const recentTransactions = queryAll(`
    SELECT id, type, account, sub_account, category, description, amount, created_at
    FROM transactions
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 60
  `);

  return JSON.stringify(
    {
      currency: 'PHP (₱)',
      current_time: new Date().toISOString(),
      sqlite_schema: 'transactions(id, type [deposit|spend], account [cash|e-wallet|bank], sub_account, category, description, amount, created_at)',
      overall_summary: totals,
      balances_by_account_and_sub_account: byAccount,
      spending_by_category: byCategory,
      recent_transactions: recentTransactions
    },
    null,
    2
  );
}

function tryExecuteEmbeddedSql(text) {
  const match = text.match(/```sql\s*([\s\S]*?)```/i);
  if (!match) return null;
  const sql = match[1].trim();
  if (!/^SELECT\b/i.test(sql)) return null;
  try {
    return queryAll(sql);
  } catch (e) {
    return { sql_error: e.message };
  }
}

function sendQuickPrompt(promptText) {
  const input = document.getElementById('chatInput');
  input.value = promptText;
  handleChatSubmit(new Event('submit'));
}

async function handleChatSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const input = document.getElementById('chatInput');
  const userText = input.value.trim();
  if (!userText) return;

  input.value = '';
  chatMessages.push({ role: 'user', content: userText });
  renderChatMessages();

  const activeKey = getApiKey(currentProvider);
  if (!activeKey) {
    const providerLabel = currentProvider === 'gemini' ? 'Gemini' : 'Groq';
    chatMessages.push({
      role: 'assistant',
      provider: currentProvider,
      content: `🔑 **No ${providerLabel} API Key Found**\n\nPlease tap the **Settings (⚙️)** button at the top right of the home screen and enter your personal **${providerLabel} API Key** to enable AI insights. Your key is stored privately on this device only.`
    });
    renderChatMessages();
    return;
  }

  const sendBtn = document.getElementById('chatSendBtn');
  sendBtn.disabled = true;
  sendBtn.innerHTML = `<i class="pi pi-spin pi-spinner text-xs"></i>`;

  const dbSnapshot = buildDatabaseContextSnapshot();
  const systemPrompt = `You are NAIT FINANCE AI, a smart, concise, and helpful personal finance assistant embedded inside the user's mobile-first PWA.
You have direct access to the user's live on-device SQLite database.
Always use Philippine Peso (₱) when formatting amounts.

STRICT FORMATTING RULES:
- Plain text and simple bullet points ONLY.
- NEVER use Markdown tables, pipes (|), dashed lines (---), ASCII boxes, or visual dividers.
- Format items naturally in plain sentences or simple bullet lines (e.g. "• DBM - MIRIENDA (Food via E-Wallet - Gotyme): ₱500.00").

=== LIVE SQLITE DATABASE SNAPSHOT ===
${dbSnapshot}
=====================================

If the user asks in Tagalog/Taglish or English, respond naturally in the same language.`;

  try {
    let reply = '';
    if (currentProvider === 'groq') {
      reply = await callGroqLLM(systemPrompt, userText);
    } else {
      reply = await callGeminiLLM(systemPrompt, userText);
    }

    const sqlResult = tryExecuteEmbeddedSql(reply);
    if (sqlResult && Array.isArray(sqlResult)) {
      reply += `\n\n**SQLite Query Result:** \`${JSON.stringify(sqlResult)}\``;
    }

    chatMessages.push({
      role: 'assistant',
      provider: currentProvider,
      content: reply
    });
  } catch (err) {
    console.error('LLM Error:', err);
    chatMessages.push({
      role: 'assistant',
      provider: currentProvider,
      content: `⚠️ **${currentProvider.toUpperCase()} API Error:** ${err.message}\n\nTip: You can switch between **Groq** and **Gemini** using the toggle at the top right, or update your API key in Settings.`
    });
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = `<i class="pi pi-send text-xs"></i>`;
    renderChatMessages();
  }
}

async function callGroqLLM(systemPrompt, userPrompt) {
  const apiKey = getApiKey('groq');
  const history = chatMessages
    .slice(-8)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

  const groqModels = [
    'openai/gpt-oss-120b',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant'
  ];
  let lastErr = 'Groq request failed';

  for (const modelName of groqModels) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: userPrompt }
        ]
      })
    });

    const data = await response.json();
    if (response.ok) {
      return data.choices?.[0]?.message?.content || 'No response received.';
    }
    lastErr = data?.error?.message || `HTTP ${response.status}`;
  }
  throw new Error(lastErr);
}

async function callGeminiLLM(systemPrompt, userPrompt) {
  const apiKey = getApiKey('gemini');
  const geminiModels = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
  ];
  let lastErr = 'Gemini request failed';

  for (const modelName of geminiModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 900
        }
      })
    });

    const data = await response.json();
    if (response.ok) {
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p.text || '').join('\n').trim();
      if (text) return text;
    }
    lastErr = data?.error?.message || `HTTP ${response.status}`;
  }
  throw new Error(lastErr);
}

// ============================================================================
// 9. EXPORT / IMPORT / THEME / RESET SQLITE DB
// ============================================================================
function exportSqliteFile() {
  if (!db) return;
  const binaryArray = db.export();
  const blob = new Blob([binaryArray], { type: 'application/x-sqlite3' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nait_finance_${new Date().toISOString().slice(0, 10)}.sqlite`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Exported .sqlite database!');
}

async function importSqliteFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const candidateDb = new SQL.Database(new Uint8Array(buf));
    db = candidateDb;
    ensureSchema();
    await saveDatabaseToDevice();
    refreshAllViews();
    closeModal('settingsModal');
    showToast('Imported SQLite database!');
  } catch (err) {
    showToast('Invalid SQLite file', true);
  } finally {
    event.target.value = '';
  }
}

function applyThemeMode(mode) {
  const isDark = mode === 'dark';
  document.documentElement.classList.toggle('dark', isDark);

  const btn = document.getElementById('themeToggleBtn');
  const icon = document.getElementById('themeToggleIcon');
  const label = document.getElementById('themeToggleLabel');

  if (btn && icon && label) {
    if (isDark) {
      btn.className = 'py-2 px-2.5 rounded-lg bg-indigo-950/60 border border-indigo-500/40 text-indigo-300 text-[11px] font-bold flex items-center justify-center gap-1.5 transition';
      icon.className = 'pi pi-moon text-[11px] text-indigo-300';
      label.textContent = 'Dark Mode';
    } else {
      btn.className = 'py-2 px-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-bold flex items-center justify-center gap-1.5 hover:bg-amber-100 transition';
      icon.className = 'pi pi-sun text-[11px] text-amber-600';
      label.textContent = 'Light Mode';
    }
  }
}

function toggleThemeMode() {
  const current = localStorage.getItem('nait_theme_mode') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('nait_theme_mode', next);
  applyThemeMode(next);
  showToast(`Switched to ${next === 'dark' ? 'Dark' : 'Light'} Mode`);
}

async function resetDatabase() {
  if (!confirm('Are you sure you want to wipe all transactions on this device?')) return;
  db.run(`DELETE FROM transactions;`);
  await saveDatabaseToDevice();
  refreshAllViews();
  closeModal('settingsModal');
  showToast('Database cleared');
}

// ============================================================================
// 10. SERVICE WORKER & PWA INSTALL PROMPT
// ============================================================================
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installPwaBtn');
  if (btn) {
    btn.classList.remove('hidden');
    btn.onclick = async () => {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      btn.classList.add('hidden');
    };
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== 'nait-finance-light-v6').map((k) => caches.delete(k)));
      const reg = await navigator.serviceWorker.register('./sw.js?v=6');
      await reg.update();
    } catch (e) {}
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('nait_theme_mode') || 'light';
  applyThemeMode(savedTheme);
  initSqliteEngine();
});
