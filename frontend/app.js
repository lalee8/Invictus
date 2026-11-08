// =====================================================
//  ResiliNode AI — Frontend
//  Modules: Bank (ATM), Hospital (queue), Doctor panel,
//           ESP32 device, Voice commands
// =====================================================

// ===== Settings and state =====
const API = "http://127.0.0.1:8000";
const LOCALE = "en-GB";
const VOICE_LANG = "en-US";

let isOnline = false;        // is the backend reachable

// Bank
let currentId = null;        // logged-in account ID
let currentPin = null;       // PIN (kept in memory only)
let currentAction = null;    // "deposit" or "withdraw"

// Hospital
let currentTicket = null;    // { id, offline, announced }
let lastTicketText = "";

// ESP32
let deviceUrl = null;
let deviceOnline = false;

// Shortcut: find element by id
const $ = (id) => document.getElementById(id);
const isVisible = (id) => !$(id).classList.contains("hidden");


// ===== Helpers =====

// Show only one screen
function showScreen(screenId) {
  document.querySelectorAll("main section").forEach((s) => s.classList.add("hidden"));
  $(screenId).classList.remove("hidden");

  // Screen-specific loading
  if (screenId === "screen-doctor") loadQueue();
}

// Show a message (green / red)
function showMsg(elId, text, isError = false) {
  const el = $(elId);
  el.textContent = text;
  el.className = "msg " + (isError ? "error" : "success");
}

// Read text aloud (for Digital Inclusion)
function speak(text) {
  if (!text || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = VOICE_LANG;
  window.speechSynthesis.speak(u);
}

// localStorage can fail in some contexts, so use try/catch
function storageGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // could not save, not a problem
  }
}

// Friendlier versions of backend error messages
const FRIENDLY_ERRORS = {
  "Invalid PIN": "Wrong PIN",
  "Account not found": "Account not found",
  "Account is inactive": "This account is inactive",
  "Insufficient funds": "Insufficient funds",
  "Unsupported currency": "This currency is not supported",
  "Department not found": "Department not found",
  "Ticket not found": "Ticket not found",
  "Queue is empty": "No patients are waiting",
};

// Send a request to the backend
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      ...options,
    });
  } catch {
    // Server is down or no network
    const err = new Error("Could not connect to the server");
    err.offline = true;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // response is not JSON
  }

  if (!res.ok) {
    let message = "Something went wrong";
    if (data && data.detail) {
      // 422 validation errors return an array
      message = Array.isArray(data.detail)
        ? data.detail.map((d) => d.msg).join(", ")
        : data.detail;
    }
    throw new Error(FRIENDLY_ERRORS[message] || message);
  }

  return data;
}

const isValidPin = (pin) => /^\d{4}$/.test(pin);

// SQLite stores UTC but returns it without "Z". Parse it as UTC so local time is correct
function parseDate(value) {
  if (!value) return new Date();
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  return new Date(hasZone ? value : value.replace(" ", "T") + "Z");
}


// ===== Backend status =====
async function checkHealth() {
  try {
    await api("/health");
    isOnline = true;
    $("status-dot").className = "online";
    $("status-text").textContent = "Server: online";
  } catch {
    isOnline = false;
    $("status-dot").className = "offline";
    $("status-text").textContent = "Server: offline";
  }
}


// =====================================================
//  BANK
// =====================================================

async function register() {
  const owner_name = $("reg-name").value.trim();
  const pin = $("reg-pin").value;
  const currency = $("reg-currency").value;

  if (owner_name.length < 2) return showMsg("reg-msg", "Please enter a valid name", true);
  if (!isValidPin(pin)) return showMsg("reg-msg", "PIN must be 4 digits", true);

  try {
    const acc = await api("/accounts/", {
      method: "POST",
      body: JSON.stringify({ owner_name, pin, currency }),
    });

    showMsg("reg-msg", `Account created! Your ID: ${acc.id}`);
    speak(`Your account has been created. Your ID number is ${acc.id}`);

    // Pre-fill the login form
    $("login-id").value = acc.id;
    $("reg-name").value = "";
    $("reg-pin").value = "";
  } catch (err) {
    showMsg("reg-msg", err.message, true);
  }
}

async function login() {
  const id = $("login-id").value;
  const pin = $("login-pin").value;

  if (!id) return showMsg("login-msg", "Please enter your account ID", true);
  if (!isValidPin(pin)) return showMsg("login-msg", "PIN must be 4 digits", true);

  try {
    // There is no separate login endpoint, so we verify with the balance request
    const data = await api(`/accounts/${id}/balance?pin=${encodeURIComponent(pin)}`);

    currentId = Number(id);
    currentPin = pin;

    $("dash-number").textContent = data.account_number;
    $("dash-balance").textContent = `${data.balance} ${data.currency}`;
    $("login-pin").value = "";
    showMsg("login-msg", "");
    showMsg("dash-msg", "");

    showScreen("screen-dashboard");
    speak("Welcome");
    notifyDevice("login", "Bank login");
  } catch (err) {
    showMsg("login-msg", err.message, true);
    speak(err.message);
    notifyDevice("error", err.message);
  }
}

function logout() {
  currentId = null;
  currentPin = null;
  currentAction = null;
  closeAmountPanel();
  showScreen("screen-home");
  speak("Thank you, goodbye");
}

function openAmountPanel(action) {
  currentAction = action;
  $("amount-panel").classList.remove("hidden");
  $("amount").value = "";
  $("amount").focus();
  const text = action === "deposit" ? "Enter the amount to deposit" : "Enter the amount to withdraw";
  showMsg("dash-msg", text);
  speak(text);
}

function closeAmountPanel() {
  $("amount-panel").classList.add("hidden");
  currentAction = null;
}

async function confirmTransaction() {
  const amount = Number($("amount").value);
  if (!amount || amount <= 0) return showMsg("dash-msg", "Please enter a valid amount", true);

  try {
    const tx = await api(`/accounts/${currentId}/${currentAction}`, {
      method: "POST",
      body: JSON.stringify({ pin: currentPin, amount }),
    });

    $("dash-balance").textContent = `${tx.balance_after} ${tx.currency}`;
    const verb = currentAction === "deposit" ? "deposited" : "withdrawn";
    const text = `${amount} ${tx.currency} ${verb}. New balance: ${tx.balance_after}`;
    showMsg("dash-msg", text);
    speak(text);
    notifyDevice(currentAction, `${amount} ${tx.currency}`);
    closeAmountPanel();
  } catch (err) {
    showMsg("dash-msg", err.message, true);
    speak(err.message);
    notifyDevice("error", err.message);
  }
}

async function refreshBalance() {
  try {
    const data = await api(`/accounts/${currentId}/balance?pin=${encodeURIComponent(currentPin)}`);
    $("dash-balance").textContent = `${data.balance} ${data.currency}`;
    const text = `Your balance is ${data.balance} ${data.currency}`;
    showMsg("dash-msg", text);
    speak(text);
  } catch (err) {
    showMsg("dash-msg", err.message, true);
  }
}

async function loadHistory() {
  try {
    const list = await api(`/accounts/${currentId}/transactions?pin=${encodeURIComponent(currentPin)}`);
    const body = $("history-body");
    body.innerHTML = "";

    if (list.length === 0) {
      body.innerHTML = `<tr><td colspan="4">No transactions yet</td></tr>`;
    }

    list.forEach((t) => {
      const isDeposit = t.transaction_type === "DEPOSIT";
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${parseDate(t.created_at).toLocaleString(LOCALE)}</td>
        <td class="${isDeposit ? "type-deposit" : "type-withdraw"}">${isDeposit ? "Deposit" : "Withdraw"}</td>
        <td>${isDeposit ? "+" : "-"}${t.amount} ${t.currency}</td>
        <td>${t.balance_after}</td>
      `;
      body.appendChild(row);
    });

    showScreen("screen-history");
    speak(`${list.length} transactions found`);
  } catch (err) {
    showMsg("dash-msg", err.message, true);
  }
}


// =====================================================
//  HOSPITAL
//  Uses the backend when the server is online;
//  creates the ticket in the browser when offline.
// =====================================================

const DEPARTMENTS = {
  general:    { name: "General Practice", prefix: "G", minutes: 10 },
  cardiology: { name: "Cardiology",       prefix: "C", minutes: 15 },
  pediatrics: { name: "Pediatrics",       prefix: "P", minutes: 12 },
  dentistry:  { name: "Dentistry",        prefix: "D", minutes: 20 },
};

const STATUS_TEXT = {
  WAITING: "Waiting",
  CALLED: "📢 It's your turn! Please go to the doctor's room",
  DONE: "Visit completed",
};

function openHospital() {
  showMsg("hospital-msg", "");
  showScreen("screen-hospital");
  speak("Hospital. Type your name and choose a department: general practice, cardiology, pediatrics, or dentistry");
}

// Offline ticket: number is stored in the browser (resets daily)
function createOfflineTicket(name, deptKey) {
  const dept = DEPARTMENTS[deptKey];
  const today = new Date().toDateString();
  let queues = storageGet("resilinode-queues", {});
  if (queues.date !== today) queues = { date: today, counts: {} };

  const number = (queues.counts[deptKey] || 0) + 1;
  queues.counts[deptKey] = number;
  storageSet("resilinode-queues", queues);

  // In offline mode we don't know the real queue, so we estimate
  const ahead = Math.min(number - 1, 4);

  return {
    id: null,
    code: `OFF-${dept.prefix}${String(number).padStart(3, "0")}`,
    department: deptKey,
    department_name: dept.name,
    patient_name: name,
    status: "WAITING",
    ahead,
    estimated_wait: ahead * dept.minutes,
    created_at: new Date().toISOString(),
  };
}

function renderTicket(t, offline) {
  $("ticket-offline").classList.toggle("hidden", !offline);
  $("ticket-dept").textContent = t.department_name;
  $("ticket-number").textContent = t.code;
  $("ticket-name").textContent = t.patient_name;
  $("ticket-ahead").textContent = t.ahead;
  $("ticket-wait").textContent = t.estimated_wait;
  $("ticket-time").textContent = parseDate(t.created_at).toLocaleString(LOCALE);
  $("ticket-status").textContent = STATUS_TEXT[t.status] || t.status;
  $("ticket-status").classList.toggle("called", t.status === "CALLED");
  $("btn-ticket-refresh").classList.toggle("hidden", offline);
}

async function takeTicket(deptKey) {
  const name = $("patient-name").value.trim();

  if (name.length < 2) {
    showMsg("hospital-msg", "Please type your name first", true);
    speak("Please type your name first");
    $("patient-name").focus();
    return;
  }

  let ticket;
  let offline = false;

  try {
    ticket = await api("/hospital/tickets", {
      method: "POST",
      body: JSON.stringify({ patient_name: name, department: deptKey }),
    });
  } catch (err) {
    if (!err.offline) {
      showMsg("hospital-msg", err.message, true);
      return speak(err.message);
    }
    // No server: offline ticket
    ticket = createOfflineTicket(name, deptKey);
    offline = true;
  }

  currentTicket = { id: ticket.id, offline, announced: false };
  renderTicket(ticket, offline);

  const spokenCode = ticket.code.replace("OFF-", "").replace("-", " ");
  lastTicketText =
    `${name}, your ticket number is ${spokenCode}. ` +
    `Department: ${ticket.department_name}. There are ${ticket.ahead} people ahead of you. ` +
    `Estimated wait is ${ticket.estimated_wait} minutes.` +
    (offline ? " Note: the system is in offline mode, please confirm your ticket at the front desk." : "");

  showScreen("screen-ticket");
  speak(lastTicketText);
  notifyDevice("ticket", ticket.code);
}

// Refresh the ticket status from the server
async function refreshTicket(silent = false) {
  if (!currentTicket || currentTicket.offline) return;

  try {
    const t = await api(`/hospital/tickets/${currentTicket.id}`);
    renderTicket(t, false);

    if (t.status === "CALLED" && !currentTicket.announced) {
      currentTicket.announced = true;
      speak(`${t.patient_name}, it's your turn. Please go to the ${t.department_name} room.`);
    } else if (!silent) {
      speak(`There are ${t.ahead} people ahead of you`);
    }
  } catch (err) {
    if (!silent) speak(err.message);
  }
}

function finishHospital() {
  $("patient-name").value = "";
  lastTicketText = "";
  currentTicket = null;
  showScreen("screen-home");
}


// =====================================================
//  DOCTOR PANEL
// =====================================================

async function loadQueue() {
  const dept = $("doctor-dept").value;

  try {
    const q = await api(`/hospital/queue/${dept}`);

    $("doctor-current").textContent = q.current ? q.current.code : "—";
    $("doctor-current-name").textContent = q.current ? q.current.patient_name : "";
    $("doctor-count").textContent = q.waiting.length;

    const list = $("doctor-waiting");
    list.innerHTML = "";

    if (q.waiting.length === 0) {
      list.innerHTML = `<li>No patients waiting</li>`;
    }

    q.waiting.forEach((t) => {
      const li = document.createElement("li");
      const time = parseDate(t.created_at).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
      li.innerHTML = `<span><strong>${t.code}</strong> — </span><span>${time}</span>`;
      // Add the name with a text node (safer than innerHTML)
      li.firstChild.appendChild(document.createTextNode(t.patient_name));
      list.appendChild(li);
    });

    showMsg("doctor-msg", "");
  } catch (err) {
    showMsg("doctor-msg", err.offline ? "The doctor panel needs the server" : err.message, true);
  }
}

async function callNext() {
  const dept = $("doctor-dept").value;

  try {
    const t = await api(`/hospital/queue/${dept}/next`, { method: "POST" });
    const spokenCode = t.code.replace("-", " ");
    const text = `Ticket ${spokenCode}, ${t.patient_name}, please go to the ${t.department_name} room`;
    speak(text);
    showMsg("doctor-msg", `Called: ${t.code}`);
    notifyDevice("call", t.code);
    loadQueue();
  } catch (err) {
    showMsg("doctor-msg", err.message, true);
    speak(err.message);
    loadQueue();
  }
}


// =====================================================
//  ESP32 DEVICE
//  Firmware: esp32/resilinode_node/resilinode_node.ino
//  GET /status  -> device info (JSON)
//  GET /notify?event=...&msg=...  -> LED / buzzer signal
// =====================================================

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  return url.replace(/\/+$/, "");
}

function setDeviceStatus(online, text) {
  deviceOnline = online;
  $("device-dot").className = deviceUrl ? (online ? "online" : "offline") : "";
  $("device-text").textContent = text;
}

async function pingDevice() {
  if (!deviceUrl) {
    setDeviceStatus(false, "ESP32: not connected");
    return null;
  }

  try {
    const res = await fetch(deviceUrl + "/status", { signal: AbortSignal.timeout(3000) });
    const info = await res.json();
    setDeviceStatus(true, "ESP32: online");
    $("device-info").textContent =
      `Device:  ${info.device || "-"}\n` +
      `IP:      ${info.ip || "-"}\n` +
      `WiFi:    ${info.rssi ?? "-"} dBm\n` +
      `Uptime:  ${info.uptime ?? "-"} s\n` +
      `Signals: ${info.notifications ?? 0}`;
    return info;
  } catch {
    setDeviceStatus(false, "ESP32: unreachable");
    $("device-info").textContent = "Could not connect to the device";
    return null;
  }
}

async function connectDevice() {
  const url = normalizeUrl($("device-ip").value);
  if (!url) return showMsg("device-msg", "Please enter the device address", true);

  deviceUrl = url;
  $("device-ip").value = url;
  showMsg("device-msg", "Connecting...");

  const info = await pingDevice();
  if (info) {
    storageSet("resilinode-device", url);
    showMsg("device-msg", "ESP32 connected");
    speak("Device connected");
    notifyDevice("test", "Connected");
  } else {
    showMsg("device-msg", "Could not connect. Check the IP, WiFi and firmware", true);
  }
}

function disconnectDevice() {
  deviceUrl = null;
  storageSet("resilinode-device", null);
  setDeviceStatus(false, "ESP32: not connected");
  $("device-info").textContent = "No data";
  showMsg("device-msg", "Device disconnected");
}

// Send an event to the device (we don't read the reply, so "no-cors")
function notifyDevice(event, msg = "") {
  if (!deviceUrl || !deviceOnline) return;
  const url = `${deviceUrl}/notify?event=${encodeURIComponent(event)}&msg=${encodeURIComponent(msg)}`;
  fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(3000) }).catch(() => {});
}


// =====================================================
//  VOICE COMMANDS
// =====================================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

function setVoiceText(text) {
  $("voice-text").textContent = text;
}

// Find the first number in the text: "deposit 50" -> 50
function extractNumber(text) {
  const match = text.replace(",", ".").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// Turn the recognized text into a command
function handleCommand(rawText) {
  const text = rawText.toLowerCase();
  setVoiceText(`Heard: "${rawText}"`);

  const has = (...words) => words.some((w) => text.includes(w));

  // --- Doctor panel ---
  if (isVisible("screen-doctor")) {
    if (has("next", "call")) return callNext();
    if (has("home", "back")) return showScreen("screen-home");
  }

  // --- Module selection (any screen) ---
  if (has("doctor panel")) return showScreen("screen-doctor");
  if (has("device", "esp")) return showScreen("screen-device");
  if (has("hospital", "clinic", "doctor")) return openHospital();
  if (!currentId && has("bank")) {
    showScreen("screen-login");
    return speak("Bank. Please enter your account ID and PIN");
  }
  if (!currentId && has("home", "back")) return showScreen("screen-home");

  // --- Ticket screen ---
  if (isVisible("screen-ticket")) {
    if (has("repeat", "again")) return speak(lastTicketText);
    if (has("status", "how many", "refresh")) return refreshTicket();
    if (has("done", "finish", "okay")) return finishHospital();
  }

  // --- Hospital: department name ---
  if (isVisible("screen-hospital")) {
    if (has("general", "practice", "therapist")) return takeTicket("general");
    if (has("cardio", "heart")) return takeTicket("cardiology");
    if (has("pediatric", "child", "kid")) return takeTicket("pediatrics");
    if (has("dent", "tooth", "teeth")) return takeTicket("dentistry");
    return speak("Say a department: general practice, cardiology, pediatrics, or dentistry");
  }

  // --- Bank: before login only "register" works ---
  if (!currentId) {
    if (has("register", "new account", "open account")) return showScreen("screen-register");
    return speak("Please log in first with your account ID and PIN");
  }

  const amount = extractNumber(text);

  if (has("balance", "how much")) {
    return refreshBalance();
  }

  if (has("deposit", "add", "put")) {
    showScreen("screen-dashboard");
    openAmountPanel("deposit");
    if (amount) {
      $("amount").value = amount;
      confirmTransaction();
    }
    return;
  }

  if (has("withdraw", "take out", "cash")) {
    showScreen("screen-dashboard");
    openAmountPanel("withdraw");
    if (amount) {
      $("amount").value = amount;
      confirmTransaction();
    }
    return;
  }

  if (has("history", "transactions")) {
    return loadHistory();
  }

  if (has("back", "home", "menu")) {
    closeAmountPanel();
    return showScreen("screen-dashboard");
  }

  if (has("cancel")) {
    closeAmountPanel();
    return speak("Cancelled");
  }

  if (has("log out", "logout", "exit", "goodbye")) {
    return logout();
  }

  // Amount panel is open and only a number was said: "100"
  if (currentAction && amount) {
    $("amount").value = amount;
    return confirmTransaction();
  }

  speak("Sorry, I didn't understand. Say balance, deposit, withdraw, history, or log out");
}

function startListening() {
  if (!SpeechRecognition) {
    setVoiceText("This browser does not support speech recognition. Use Chrome.");
    return speak("This browser does not support voice commands");
  }

  if (isListening) {
    recognition.stop();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = VOICE_LANG;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    $("btn-voice").classList.add("listening");
    setVoiceText("Listening...");
  };

  recognition.onresult = (e) => {
    handleCommand(e.results[0][0].transcript);
  };

  recognition.onerror = (e) => {
    const errors = {
      "not-allowed": "Microphone permission was denied",
      "no-speech": "No speech detected",
      "network": "Speech recognition needs an internet connection",
    };
    setVoiceText(errors[e.error] || "Error: " + e.error);
  };

  recognition.onend = () => {
    isListening = false;
    $("btn-voice").classList.remove("listening");
  };

  recognition.start();
}


// =====================================================
//  BUTTON BINDINGS
// =====================================================

// Home
$("btn-module-bank").addEventListener("click", () => {
  showScreen("screen-login");
  speak("Bank. Please enter your account ID and PIN");
});
$("btn-module-hospital").addEventListener("click", openHospital);
$("btn-module-doctor").addEventListener("click", () => showScreen("screen-doctor"));
$("btn-module-device").addEventListener("click", () => {
  showScreen("screen-device");
  pingDevice();
});

// Hospital
$("btn-hospital-home").addEventListener("click", finishHospital);
$("btn-ticket-refresh").addEventListener("click", () => refreshTicket());
$("btn-ticket-repeat").addEventListener("click", () => speak(lastTicketText));
$("btn-ticket-done").addEventListener("click", finishHospital);
document.querySelectorAll("#departments button").forEach((btn) => {
  btn.addEventListener("click", () => takeTicket(btn.dataset.dept));
});

// Doctor panel
$("doctor-dept").addEventListener("change", loadQueue);
$("btn-call-next").addEventListener("click", callNext);
$("btn-doctor-home").addEventListener("click", () => showScreen("screen-home"));

// ESP32
$("btn-device-connect").addEventListener("click", connectDevice);
$("btn-device-test").addEventListener("click", () => {
  if (!deviceOnline) return showMsg("device-msg", "Connect to the device first", true);
  notifyDevice("test", "Test");
  showMsg("device-msg", "Test signal sent");
});
$("btn-device-disconnect").addEventListener("click", disconnectDevice);
$("btn-device-home").addEventListener("click", () => showScreen("screen-home"));
$("device-ip").addEventListener("keydown", (e) => e.key === "Enter" && connectDevice());

// Bank
$("btn-login").addEventListener("click", login);
$("btn-login-home").addEventListener("click", () => showScreen("screen-home"));
$("btn-go-register").addEventListener("click", () => showScreen("screen-register"));
$("btn-register").addEventListener("click", register);
$("btn-back-login").addEventListener("click", () => showScreen("screen-login"));

$("btn-deposit").addEventListener("click", () => openAmountPanel("deposit"));
$("btn-withdraw").addEventListener("click", () => openAmountPanel("withdraw"));
$("btn-balance").addEventListener("click", refreshBalance);
$("btn-history").addEventListener("click", loadHistory);
$("btn-confirm").addEventListener("click", confirmTransaction);
$("btn-cancel").addEventListener("click", () => {
  closeAmountPanel();
  showMsg("dash-msg", "");
});
$("btn-logout").addEventListener("click", logout);
$("btn-history-back").addEventListener("click", () => showScreen("screen-dashboard"));

// Submit with the Enter key
$("login-pin").addEventListener("keydown", (e) => e.key === "Enter" && login());
$("reg-pin").addEventListener("keydown", (e) => e.key === "Enter" && register());
$("amount").addEventListener("keydown", (e) => e.key === "Enter" && confirmTransaction());

// Voice command: button or the "V" key (when not typing in a field)
$("btn-voice").addEventListener("click", startListening);
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (!typing && e.key.toLowerCase() === "v") startListening();
});


// =====================================================
//  STARTUP
// =====================================================
closeAmountPanel();
showScreen("screen-home");

checkHealth();
setInterval(checkHealth, 5000);

// Remember a previously connected ESP32
const savedDevice = storageGet("resilinode-device");
if (savedDevice) {
  deviceUrl = savedDevice;
  $("device-ip").value = savedDevice;
}
pingDevice();
setInterval(pingDevice, 10000);

// Auto-refresh depending on the open screen
setInterval(() => {
  if (isVisible("screen-ticket")) refreshTicket(true);
  if (isVisible("screen-doctor")) loadQueue();
}, 5000);
