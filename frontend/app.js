// =====================================================
//  Nodex ATM — Frontend
//  Login with card number + PIN
//  Screens: welcome, keypad entry (card / PIN / amount),
//           menu, balance, result, history, register
// =====================================================

// ===== Settings =====
// Online (same server) -> "" ; opened as a file or with Live Server -> local backend
const API =
  location.protocol === "file:" || location.port === "5500"
    ? "http://127.0.0.1:8000"
    : "";
const LOCALE = "en-GB";
const SPEAK_ENABLED = true;      // set to false to turn off spoken feedback
const RESULT_RETURN_SECONDS = 8;
const CARD_LENGTH = 10;          // account_number in the backend has 10 digits

const SYMBOLS = { AZN: "₼", USD: "$", EUR: "€" };

// ===== State =====
const session = {
  id: null,          // account ID (used by the API)
  pin: null,         // PIN (memory only)
  card: "",          // card (account) number
  name: "",
  currency: "AZN",
};

let entryMode = null;      // "card" | "pin" | "withdraw" | "deposit"
let entryValue = "";
let pendingCard = "";      // card number typed before the PIN step
let resultTimer = null;

const $ = (id) => document.getElementById(id);


// =====================================================
//  HELPERS
// =====================================================

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
  clearInterval(resultTimer);
}

function speak(text) {
  if (typeof queueBridgeReport === "function") queueBridgeReport(text);
  if (!SPEAK_ENABLED || !text || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  window.speechSynthesis.speak(u);
}

const FRIENDLY_ERRORS = {
  "Invalid card number or PIN": "Wrong card number or PIN",
  "Invalid PIN": "Wrong PIN. Please try again",
  "Account not found": "Card not found",
  "Account is inactive": "This card is blocked",
  "Insufficient funds": "Insufficient funds",
  "Unsupported currency": "This currency is not supported",
  "Not Found": "Card login is not available. Update the backend",
};

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      ...options,
    });
  } catch {
    throw new Error("Server is not reachable");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }

  if (!res.ok) {
    let message = "Something went wrong";
    if (data && data.detail) {
      message = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join(", ") : data.detail;
    }
    throw new Error(FRIENDLY_ERRORS[message] || message);
  }
  return data;
}

// SQLite returns UTC without "Z"
function parseDate(value) {
  if (!value) return new Date();
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  return new Date(hasZone ? value : value.replace(" ", "T") + "Z");
}

const money = (n, decimals = 2) =>
  Number(n).toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const symbol = (cur = session.currency) => SYMBOLS[cur] || cur;

// "0089258598" -> "0089 2585 98"
const formatCard = (num) => String(num).replace(/(\d{4})(?=\d)/g, "$1 ");

// "0089258598" -> "•••• •••• 98"
const maskCard = (num) => (num ? "•••• •••• " + String(num).slice(-2) : "•••• •••• ••");

const timeShort = (d = new Date()) => d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });

const txRef = (id) => "TX-" + String(id).padStart(6, "0");

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// 35000 -> "Thirty Five Thousand"
function numberToWords(num) {
  num = Math.floor(Number(num));
  if (num === 0) return "Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function under1000(n) {
    const out = [];
    if (n >= 100) {
      out.push(ones[Math.floor(n / 100)], "Hundred");
      n %= 100;
    }
    if (n >= 20) {
      out.push(tens[Math.floor(n / 10)]);
      n %= 10;
    }
    if (n > 0) out.push(ones[n]);
    return out.join(" ");
  }

  const parts = [];
  for (const [value, name] of [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]]) {
    if (num >= value) {
      parts.push(under1000(Math.floor(num / value)), name);
      num %= value;
    }
  }
  if (num > 0) parts.push(under1000(num));
  return parts.join(" ");
}

async function withBusy(button, task) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await task();
  } finally {
    button.disabled = false;
  }
}

function restartAnimation(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}


// =====================================================
//  KEYPAD ENTRY (card number, PIN, amount)
// =====================================================

const ICONS = {
  withdraw: `<svg viewBox="0 0 24 24" class="ico-lg"><rect x="3" y="9" width="18" height="11" rx="1.5"/><circle cx="12" cy="14.5" r="2.5"/><path d="M9 6l3-3 3 3M12 3v5"/></svg>`,
  deposit: `<svg viewBox="0 0 24 24" class="ico-lg"><rect x="3" y="9" width="18" height="11" rx="1.5"/><circle cx="12" cy="14.5" r="2.5"/><path d="M9 4l3 3 3-3M12 7V2"/></svg>`,
};

const ENTRY = {
  card: {
    title: "Enter your card number",
    sub: `${CARD_LENGTH} digits, printed on your card`,
    button: "Continue",
    max: CARD_LENGTH,
    voice: "Please enter your card number",
  },
  pin: {
    title: "Enter your PIN to continue",
    sub: "Your PIN is never shown on screen",
    button: "Confirm",
    max: 4,
    voice: "Please enter your PIN",
  },
  withdraw: {
    title: "Withdraw Cash",
    sub: "Enter the amount you want to withdraw",
    button: "Withdraw",
    max: 7,
    voice: "Enter the amount you want to withdraw",
  },
  deposit: {
    title: "Deposit Money",
    sub: "Enter the amount you want to deposit",
    button: "Deposit",
    max: 7,
    voice: "Enter the amount you want to deposit",
  },
};

function openEntry(mode) {
  entryMode = mode;
  entryValue = "";
  const cfg = ENTRY[mode];
  const isLogin = mode === "card" || mode === "pin";
  const isAmount = !isLogin;

  const panel = document.querySelector(".entry-panel");
  panel.classList.toggle("plain", isLogin);
  $("live-card").classList.toggle("hidden", !isLogin);
  $("steps").classList.toggle("hidden", !isLogin);
  $("entry-icon").innerHTML = ICONS[mode] || "";
  $("entry-title").textContent = cfg.title;
  $("entry-sub").textContent = cfg.sub;
  $("btn-entry-submit").textContent = cfg.button;
  $("quick-amounts").classList.toggle("hidden", !isAmount);
  $("entry-display").classList.toggle("left", isAmount);
  $("entry-display").classList.remove("shake");
  $("entry-msg").textContent = "";

  // Step indicator: Card -> PIN -> Menu
  document.querySelectorAll("#steps li").forEach((li) => {
    const order = ["card", "pin", "menu"];
    const i = order.indexOf(li.dataset.step);
    const current = order.indexOf(mode);
    li.className = i < current ? "done" : i === current ? "active" : "";
  });

  renderEntry();
  showScreen("screen-entry");
  speak(cfg.voice);
}

// Live card preview: typed digits appear on the card
function renderLiveCard() {
  const source = entryMode === "card" ? entryValue : pendingCard;
  let html = "";
  for (let i = 0; i < CARD_LENGTH; i++) {
    if (i > 0 && i % 4 === 0) html += " ";
    if (entryMode === "pin" && i < CARD_LENGTH - 2) {
      html += `<span class="typed">•</span>`; // hide most digits on the PIN step
    } else if (i < source.length) {
      html += `<span class="typed">${source[i]}</span>`;
    } else {
      html += `<span class="empty">•</span>`;
    }
  }
  $("live-number").innerHTML = html;
  $("live-holder").textContent = entryMode === "pin" ? "ENTER PIN" : "CARD HOLDER";
}

function renderEntry() {
  const d = $("entry-display");
  $("entry-words").textContent = "";

  if (entryMode === "card" || entryMode === "pin") renderLiveCard();

  if (entryMode === "pin") {
    d.innerHTML =
      `<span class="pin-dots">` +
      [0, 1, 2, 3].map((i) => `<span class="${i < entryValue.length ? "on" : ""}"></span>`).join("") +
      `</span>`;
    return;
  }

  if (entryMode === "card") {
    d.innerHTML = entryValue
      ? formatCard(entryValue)
      : `<span class="ph">0000 0000 00</span>`;
    return;
  }

  // amount
  if (entryValue) {
    d.textContent = `${symbol()} ${money(entryValue, 0)}`;
    $("entry-words").textContent = `${numberToWords(entryValue)} ${session.currency} only`;
  } else {
    d.innerHTML = `${symbol()} <span class="ph">0</span>`;
  }
}

function pressKey(key) {
  if (!entryMode) return;
  $("entry-msg").textContent = "";

  if (key === "back") {
    entryValue = entryValue.slice(0, -1);
  } else if (entryValue.length < ENTRY[entryMode].max) {
    const isAmount = entryMode === "withdraw" || entryMode === "deposit";
    if (isAmount && entryValue === "" && key === "0") return; // no leading zero in amounts
    entryValue += key;
    if (entryMode === "card") restartAnimation($("live-card"), "bump");
  }
  renderEntry();

  // Auto-continue when the card number or PIN is complete
  if (entryMode === "pin" && entryValue.length === 4) setTimeout(submitEntry, 150);
  if (entryMode === "card" && entryValue.length === CARD_LENGTH) setTimeout(submitEntry, 250);
}

function entryError(text) {
  $("entry-msg").textContent = text;
  restartAnimation($("entry-display"), "shake");
  speak(text);
}

async function submitEntry() {
  const btn = $("btn-entry-submit");
  if (btn.disabled || !entryMode) return;

  if (entryMode === "card") {
    if (entryValue.length !== CARD_LENGTH) return entryError(`Card number must be ${CARD_LENGTH} digits`);
    pendingCard = entryValue;
    return openEntry("pin");
  }

  if (entryMode === "pin") {
    if (entryValue.length !== 4) return entryError("PIN must be 4 digits");
    return withBusy(btn, login);
  }

  if (!entryValue || Number(entryValue) <= 0) return entryError("Please enter an amount");
  return withBusy(btn, makeTransaction);
}

function cancelEntry() {
  if (entryMode === "card" || entryMode === "pin") {
    pendingCard = "";
    goWelcome();
  } else {
    goMenu();
  }
}


// =====================================================
//  LOGIN / LOGOUT
// =====================================================

async function login() {
  const pin = entryValue;
  try {
    const acc = await api("/accounts/login", {
      method: "POST",
      body: JSON.stringify({ account_number: pendingCard, pin }),
    });

    session.id = acc.id;
    session.pin = pin;
    session.card = acc.account_number;
    session.name = acc.owner_name;
    session.currency = acc.currency;
    pendingCard = "";

    if (pendingService) {
      runPendingService();   // e.g. card -> "balance" -> PIN  => open balance directly
    } else {
      goMenu(true);
    }
  } catch (err) {
    entryValue = "";
    renderEntry();
    entryError(err.message);

    // Wrong card or PIN: start again from the card number after a moment
    if (err.message === "Wrong card number or PIN") {
      setTimeout(() => {
        if (entryMode === "pin") openEntry("card");
      }, 1600);
    }
  }
}

function logout() {
  Object.assign(session, { id: null, pin: null, card: "", name: "", currency: "AZN" });
  pendingService = null;
  pendingAmount = "";
  $("balance-amount").textContent = "0.00";
  $("history-list").innerHTML = "";
  goWelcome();
  speak("Thank you for using Nodex. Goodbye");
}

function goWelcome() {
  entryMode = null;
  showScreen("screen-welcome");
}

function goMenu(firstTime = false) {
  if (!session.id) return goWelcome();
  entryMode = null;

  const firstName = (session.name || "").split(" ")[0];
  $("menu-greeting").textContent = greeting();
  $("menu-name").textContent = firstName ? `Welcome, ${firstName}` : "Welcome";
  $("menu-card").textContent = maskCard(session.card);

  showScreen("screen-menu");
  if (firstTime) speak(`${greeting()} ${firstName}. Please choose an operation`);
}


// =====================================================
//  TRANSACTIONS
// =====================================================

async function makeTransaction() {
  const action = entryMode;
  const amount = Number(entryValue);

  try {
    const tx = await api(`/accounts/${session.id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ pin: session.pin, amount }),
    });
    showResult(tx);
  } catch (err) {
    entryError(err.message);
  }
}

// Receipt shows only the transaction, never the balance
function showResult(tx) {
  const isDeposit = tx.transaction_type === "DEPOSIT";

  $("result-title").textContent = isDeposit ? "Deposit successful" : "Withdrawal successful";
  $("result-amount").textContent = `${symbol(tx.currency)} ${money(tx.amount)}`;
  $("result-note").textContent = isDeposit ? "The money has been added to your account" : "Please take your cash";
  $("result-card").textContent = maskCard(session.card);
  $("result-ref").textContent = txRef(tx.id);
  $("result-time").textContent = parseDate(tx.created_at).toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" });

  entryMode = null;
  showScreen("screen-result");
  speak(isDeposit
    ? `${tx.amount} ${tx.currency} deposited successfully`
    : `${tx.amount} ${tx.currency} withdrawn. Please take your cash`);

  // Back to the menu automatically
  let left = RESULT_RETURN_SECONDS;
  $("result-countdown").textContent = `(${left})`;
  resultTimer = setInterval(() => {
    left -= 1;
    $("result-countdown").textContent = `(${left})`;
    if (left <= 0) goMenu();
  }, 1000);
}


// =====================================================
//  BALANCE (only when requested)
// =====================================================

async function showBalance() {
  try {
    const data = await api(`/accounts/${session.id}/balance?pin=${encodeURIComponent(session.pin)}`);
    session.currency = data.currency;

    $("balance-card-number").textContent = formatCard(data.account_number);
    $("balance-holder").textContent = session.name || "CARD HOLDER";
    $("balance-symbol").textContent = symbol();
    $("balance-words").textContent = `${numberToWords(data.balance)} ${data.currency}`;
    $("balance-currency").textContent = data.currency;
    $("balance-time").textContent = timeShort();

    showScreen("screen-balance");
    countUp($("balance-amount"), Number(data.balance));
    speak(`Your available balance is ${data.balance} ${data.currency}`);
  } catch (err) {
    menuError(err.message);
  }
}

function countUp(el, target) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = money(target);
    return;
  }
  const start = performance.now();
  const duration = 800;
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    el.textContent = money(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function menuError(text) {
  speak(text);
  const g = $("menu-greeting");
  g.textContent = "⚠ " + text;
  g.style.color = "var(--red)";
  setTimeout(() => {
    g.textContent = greeting();
    g.style.color = "";
  }, 2500);
}


// =====================================================
//  HISTORY (timeline grouped by day)
// =====================================================

const TX_ICONS = {
  in: `<svg viewBox="0 0 24 24" class="ico"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`,
  out: `<svg viewBox="0 0 24 24" class="ico"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
};

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(LOCALE, { day: "numeric", month: "long", year: "numeric" });
}

async function showHistory() {
  try {
    const list = await api(`/accounts/${session.id}/transactions?pin=${encodeURIComponent(session.pin)}`);
    const box = $("history-list");
    box.innerHTML = "";

    // Summary line
    let totalIn = 0;
    let totalOut = 0;
    list.forEach((t) => (t.transaction_type === "DEPOSIT" ? (totalIn += Number(t.amount)) : (totalOut += Number(t.amount))));
    $("history-summary").textContent = list.length
      ? `${list.length} transactions · In ${symbol()} ${money(totalIn)} · Out ${symbol()} ${money(totalOut)}`
      : "No transactions yet";

    if (list.length === 0) {
      box.innerHTML = `<p class="tx-empty">Your transactions will appear here</p>`;
    }

    // Group by day
    let currentDay = null;
    let dayBox = null;

    list.forEach((t) => {
      const date = parseDate(t.created_at);
      const label = dayLabel(date);

      if (label !== currentDay) {
        currentDay = label;
        dayBox = document.createElement("div");
        dayBox.className = "day";
        dayBox.innerHTML = `<p class="day-label">${label}</p>`;
        box.appendChild(dayBox);
      }

      const isIn = t.transaction_type === "DEPOSIT";
      const sym = symbol(t.currency);
      const row = document.createElement("div");
      row.className = "tx";
      row.innerHTML = `
        <span class="tx-ico ${isIn ? "in" : "out"}">${isIn ? TX_ICONS.in : TX_ICONS.out}</span>
        <div class="tx-card" style="grid-column: span 2">
          <div class="tx-top">
            <span class="tx-title">${isIn ? "Deposit" : "Withdrawal"}</span>
            <span class="tx-amount ${isIn ? "in" : "out"}">${isIn ? "+" : "−"}${sym} ${money(t.amount)}</span>
          </div>
          <div class="tx-top">
            <span class="tx-date">${timeShort(date)} · ${txRef(t.id)}</span>
            <span class="tx-after">Balance ${sym} ${money(t.balance_after)}</span>
          </div>
        </div>
      `;
      dayBox.appendChild(row);
    });

    showScreen("screen-history");
    speak(`${list.length} transactions found`);
  } catch (err) {
    menuError(err.message);
  }
}


// =====================================================
//  REGISTER
// =====================================================

let newCardNumber = "";

function openRegister() {
  $("reg-name").value = "";
  $("reg-pin").value = "";
  $("reg-msg").textContent = "";
  $("new-card").classList.remove("ready");
  $("new-card-number").textContent = "•••• •••• ••";
  $("new-card-holder").textContent = "YOUR NAME";
  $("new-card-note").textContent = "Your card preview";
  $("btn-use-card").classList.add("hidden");
  newCardNumber = "";
  showScreen("screen-register");
  $("reg-name").focus();
}

async function register() {
  const owner_name = $("reg-name").value.trim();
  const pin = $("reg-pin").value;
  const currency = document.querySelector("#reg-currency .active").dataset.value;
  const msg = $("reg-msg");
  msg.className = "entry-msg";

  if (owner_name.length < 2) return (msg.textContent = "Please enter your full name");
  if (!/^\d{4}$/.test(pin)) return (msg.textContent = "PIN must be 4 digits");

  try {
    const acc = await api("/accounts/", {
      method: "POST",
      body: JSON.stringify({ owner_name, pin, currency }),
    });

    newCardNumber = acc.account_number;
    msg.className = "entry-msg ok";
    msg.textContent = "Account created!";

    $("new-card-number").textContent = formatCard(acc.account_number);
    $("new-card").classList.add("ready");
    $("new-card-note").innerHTML = `Your card number: <strong>${formatCard(acc.account_number)}</strong><br>Please write it down.`;
    $("btn-use-card").classList.remove("hidden");

    $("reg-name").value = "";
    $("reg-pin").value = "";

    speak(`Your account has been created. Your card number is ${acc.account_number.split("").join(" ")}`);
  } catch (err) {
    msg.textContent = err.message;
  }
}

// Live preview of the name on the new card
$("reg-name").addEventListener("input", (e) => {
  if (!$("new-card").classList.contains("ready")) {
    $("new-card-holder").textContent = e.target.value.trim() || "YOUR NAME";
  }
});

// Go straight to login with the new card number
$("btn-use-card").addEventListener("click", () => {
  pendingCard = newCardNumber;
  openEntry("pin");
});


// =====================================================
//  SERVER STATUS + CLOCK
// =====================================================

async function checkHealth() {
  try {
    await api("/health");
    $("status-dot").className = "dot online";
    $("status-text").textContent = "Online";
  } catch {
    $("status-dot").className = "dot offline";
    $("status-text").textContent = "Offline";
  }
}

function updateClock() {
  $("clock").textContent = timeShort();
}


// =====================================================
//  HELP
// =====================================================

function openHelp() {
  $("help-modal").classList.remove("hidden");
  $("btn-help-close").focus();
  speak("Tap start, enter your card number and PIN, then choose an operation");
}

function closeHelp() {
  $("help-modal").classList.add("hidden");
}


// =====================================================
//  EVENTS
// =====================================================

// Welcome
$("btn-start").addEventListener("click", () => openEntry("card"));
$("card-slot").addEventListener("click", () => openEntry("card"));
$("btn-go-register").addEventListener("click", openRegister);

// Keypad
document.querySelectorAll(".key").forEach((k) => {
  k.addEventListener("click", () => pressKey(k.dataset.key));
});
document.querySelectorAll(".chip").forEach((c) => {
  c.addEventListener("click", () => {
    entryValue = c.dataset.amount;
    renderEntry();
  });
});
$("btn-entry-submit").addEventListener("click", submitEntry);
$("btn-entry-cancel").addEventListener("click", cancelEntry);

// Menu
$("tile-withdraw").addEventListener("click", () => openEntry("withdraw"));
$("tile-deposit").addEventListener("click", () => openEntry("deposit"));
$("tile-balance").addEventListener("click", (e) => withBusy(e.currentTarget, showBalance));
$("tile-history").addEventListener("click", (e) => withBusy(e.currentTarget, showHistory));
$("tile-help").addEventListener("click", openHelp);
$("btn-logout").addEventListener("click", logout);

// Balance / result / history
$("btn-balance-back").addEventListener("click", () => {
  $("balance-amount").textContent = "0.00";
  goMenu();
});
$("btn-balance-withdraw").addEventListener("click", () => {
  $("balance-amount").textContent = "0.00";
  openEntry("withdraw");
});
$("btn-result-menu").addEventListener("click", () => goMenu());
$("btn-result-logout").addEventListener("click", logout);
$("btn-history-back").addEventListener("click", () => goMenu());

// Register
$("btn-register").addEventListener("click", (e) => withBusy(e.currentTarget, register));
$("btn-register-back").addEventListener("click", goWelcome);
$("reg-pin").addEventListener("keydown", (e) => e.key === "Enter" && $("btn-register").click());
document.querySelectorAll("#reg-currency button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#reg-currency button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });
});

// Help
$("btn-help").addEventListener("click", openHelp);
$("btn-help-close").addEventListener("click", closeHelp);
$("help-modal").addEventListener("click", (e) => e.target.id === "help-modal" && closeHelp());

// Remove the red outline after the shake
$("entry-display").addEventListener("animationend", () => {
  setTimeout(() => $("entry-display").classList.remove("shake"), 600);
});

// Physical keyboard
document.addEventListener("keydown", (e) => {
  if (!$("help-modal").classList.contains("hidden")) {
    if (e.key === "Escape") closeHelp();
    return;
  }

  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (typing) return;

  // Enter on a focused button already "clicks" it
  if (e.key === "Enter" && document.activeElement.tagName === "BUTTON") return;

  const onEntry = !$("screen-entry").classList.contains("hidden");

  if (onEntry) {
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      pressKey(e.key);
      flashKey(e.key);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      pressKey("back");
      flashKey("back");
    } else if (e.key === "Enter") {
      e.preventDefault();
      submitEntry();
    } else if (e.key === "Escape") {
      cancelEntry();
    }
    return;
  }

  if (e.key === "Escape" && session.id) goMenu();
  if (e.key === "Enter" && !$("screen-welcome").classList.contains("hidden")) openEntry("card");
});

// Light up the on-screen key when typing on a real keyboard
function flashKey(key) {
  const el = document.querySelector(`.key[data-key="${key}"]`);
  if (!el) return;
  el.classList.add("pressed");
  setTimeout(() => el.classList.remove("pressed"), 120);
}


// =====================================================
//  STARTUP
// =====================================================
goWelcome();

checkHealth();
setInterval(checkHealth, 5000);

updateClock();
setInterval(updateClock, 10000);


// =====================================================
//  HARDWARE BRIDGE (ESP32 voice board)
//  nodex_mcp_bridge.py exposes:
//    GET  /api/kiosk-state   { screen, card_number, pin, amount, version, changed }
//    POST /api/kiosk-result  { version, text }  <- the site reports what really happened
//  Every voice command has a new "version". The site handles each command once,
//  in the order the robot asks: card number -> service -> PIN.
// =====================================================

// Where the bridge runs. If it is on ANOTHER computer, open the site once like this:
//   http://127.0.0.1:8000/?bridge=192.168.1.25
// The address is remembered in this browser. To go back: ?bridge=localhost
function getBridgeBase() {
  const fromLink = new URLSearchParams(location.search).get("bridge");
  if (fromLink) {
    try { localStorage.setItem("nodex-bridge", fromLink); } catch {}
  }
  let host = fromLink;
  if (!host) {
    try { host = localStorage.getItem("nodex-bridge"); } catch {}
  }
  host = (host || "localhost").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host.includes(":")) host += ":5000";
  return `http://${host}`;
}

const BRIDGE_BASE = getBridgeBase();
const BRIDGE_URL = BRIDGE_BASE + "/api/kiosk-state";
const BRIDGE_RESULT_URL = BRIDGE_BASE + "/api/kiosk-result";
console.log("Nodex bridge:", BRIDGE_URL);

const BRIDGE_FAST = 300;    // ms between polls while the bridge is online
const BRIDGE_SLOW = 3000;   // ms between polls while it is offline
const REPORT_DELAY = 1000;  // wait for the last spoken message before reporting

let bridgeVersion = null;   // last handled command
let reportVersion = null;   // command waiting for a result
let reportText = "";
let reportTimer = null;

// Service chosen BEFORE the PIN (robot order: card -> service -> PIN)
let pendingService = null;  // "balance" | "history" | "withdraw" | "deposit" | "main_menu"
let pendingAmount = "";

const SERVICE_NAMES = {
  balance: "Check balance",
  history: "Transaction history",
  withdraw: "Withdraw cash",
  deposit: "Deposit money",
  main_menu: "Main menu",
};


// ----- Reporting real results back to the robot -----

function queueBridgeReport(text) {
  if (reportVersion === null || !text) return;
  reportText = text;                  // keep only the latest message
  clearTimeout(reportTimer);
  reportTimer = setTimeout(sendBridgeReport, REPORT_DELAY);
}

function sendBridgeReport() {
  if (reportVersion === null) return;
  const body = JSON.stringify({ version: reportVersion, text: reportText });
  reportVersion = null;
  fetch(BRIDGE_RESULT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => {});
}


// ----- Services -----

function isAmountMode() {
  return entryMode === "withdraw" || entryMode === "deposit";
}

function openService(service) {
  if (service === "balance") return showBalance();
  if (service === "history") return showHistory();
  if (service === "withdraw" || service === "deposit") return openEntry(service);
  goMenu();
  speak("Main menu. You can withdraw, deposit, check balance or see history");
}

// Called right after a successful login
function runPendingService() {
  const service = pendingService;
  const amount = pendingAmount;
  pendingService = null;
  pendingAmount = "";

  goMenu(false);
  openService(service);

  // Amount was already said before the PIN: the PIN confirms it, so do it now
  if (amount && (service === "withdraw" || service === "deposit")) {
    entryValue = amount.slice(0, ENTRY[service].max);
    renderEntry();
    setTimeout(submitEntry, 400);
  }
}


// ----- One voice command -----

function handleVoiceCommand(cmd) {
  const loggedIn = !!session.id;

  // 1. Screen / service
  if (cmd.screen) {
    const screen = cmd.screen;

    if (screen === "welcome") {
      pendingService = null;
      pendingAmount = "";
      if (loggedIn) logout();
      else {
        goWelcome();
        speak("Welcome to Nodex. Say your card number to start");
      }
      return;
    }

    if (screen === "card_input") {
      pendingService = null;
      pendingAmount = "";
      if (loggedIn) logout();
      openEntry("card");
    } else if (loggedIn) {
      openService(screen);
    } else {
      // Not logged in yet: remember the service, ask for what is missing
      pendingService = screen;
      if (entryMode === "pin") {
        speak(`${SERVICE_NAMES[screen] || screen} selected. Please say your PIN`);
      } else if (!cmd.card_number) {
        openEntry("card");
        speak(`${SERVICE_NAMES[screen] || screen} selected. Please say your card number first`);
      }
    }
  }

  // 2. Card number
  if (cmd.card_number) {
    const card = cmd.card_number.replace(/\D/g, "");
    if (loggedIn) {
      speak("You are already logged in");
    } else if (card.length !== CARD_LENGTH) {
      if (entryMode !== "card") openEntry("card");
      entryValue = card.slice(0, CARD_LENGTH);
      renderEntry();
      entryError(`Card number must be ${CARD_LENGTH} digits. Please say it again`);
    } else {
      pendingCard = card;
      openEntry("pin");
      renderLiveCard();
      if (!cmd.pin) {
        speak(pendingService
          ? `Card accepted. ${SERVICE_NAMES[pendingService]} selected. Please say your PIN`
          : "Card accepted. Which service would you like: balance, withdraw, deposit or history?");
      }
    }
  }

  // 3. Amount
  if (cmd.amount) {
    const amount = cmd.amount.replace(/\D/g, "");
    if (!session.id) {
      pendingAmount = amount;                       // used after the PIN
    } else if (isAmountMode()) {
      entryValue = amount.slice(0, ENTRY[entryMode].max);
      renderEntry();
      if (!cmd.pin && !cmd.confirm) {
        speak(`${amount} ${session.currency}. Please say your PIN to confirm`);
      }
    }
  }

  // 4. PIN
  if (cmd.pin) {
    const pin = cmd.pin.replace(/\D/g, "").slice(0, 4);

    if (!session.id) {
      // Login
      if (entryMode !== "pin") {
        if (pendingCard) openEntry("pin");
        else return speak("Please say your card number first");
      }
      entryValue = pin;
      renderEntry();
      submitEntry();                                 // -> login -> pending service
    } else if (isAmountMode()) {
      // PIN = confirmation of withdraw / deposit
      if (!entryValue) return speak("Please say the amount first");
      if (pin !== session.pin) return entryError("Wrong PIN. Please try again");
      submitEntry();
    } else if (!cmd.screen) {
      speak("You are already logged in. Which service would you like?");
    }
  }

  // 5. Explicit confirmation ("yes, confirm")
  if (cmd.confirm && session.id && isAmountMode() && entryValue && !cmd.pin) {
    submitEntry();
  }
}

function applyBridgeState(state) {
  if (state.version === undefined || state.version === bridgeVersion) return;

  const firstPoll = bridgeVersion === null;
  bridgeVersion = state.version;
  if (firstPoll) return;              // don't replay an old command when the page opens

  const changed = state.changed || [];
  const cmd = {};
  if (changed.includes("screen")) cmd.screen = state.screen;
  if (changed.includes("card_number")) cmd.card_number = String(state.card_number || "");
  if (changed.includes("pin")) cmd.pin = String(state.pin || "");
  if (changed.includes("amount")) cmd.amount = String(state.amount || "");
  if (changed.includes("confirm")) cmd.confirm = true;

  reportVersion = state.version;      // the next spoken result goes back to the robot
  handleVoiceCommand(cmd);
}

async function pollBridge() {
  let delay = BRIDGE_SLOW;
  try {
    const res = await fetch(BRIDGE_URL, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      applyBridgeState(await res.json());
      delay = BRIDGE_FAST;
    }
  } catch {
    // bridge is not running: try again later
  }
  setTimeout(pollBridge, delay);
}

pollBridge();