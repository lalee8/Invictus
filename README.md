# Nodex — Accessible Voice ATM

Nodex is an ATM kiosk that can be used **by voice**. A small ESP32-S3 voice robot (Xiaozhi) listens to the user, and the website on the kiosk screen follows every command in real time: card number, service, PIN, amount and confirmation. The robot then reads back the **real** result from the bank (for example the actual balance).

Built for **YUNEX 2026 — Digital Inclusion**.

---

## Features

- **Card login** — 10-digit card number + 4-digit PIN
- **Withdraw / Deposit** — on-screen keypad, amount in words, quick amounts (20 / 50 / 100 / 200), printed-receipt screen
- **Check balance** — shown **only** when the user asks for it
- **Transaction history** — timeline grouped by day
- **Open new account** — creates a new card number instantly
- **Voice control** through the hardware robot (card → service → PIN)
- **Spoken results** on the kiosk and on the robot
- **Physical keyboard support** — digits, Backspace, Enter (confirm), Esc (cancel)
- Plain HTML / CSS / JavaScript — no build step, opens instantly on any device

---

## Project structure

```
Invictus/
├── backend/
│   ├── main.py              # FastAPI app — serves the API AND the website
│   ├── database.py          # SQLite connection
│   ├── models.py            # Account, Transaction tables
│   ├── schemas.py           # Request / response models
│   ├── requirements.txt     # Python packages
│   └── routers/
│       └── accounts.py      # Login, balance, deposit, withdraw, history
├── frontend/
│   ├── index.html           # All kiosk screens
│   ├── style.css            # Kiosk design
│   └── app.js               # Screen logic + hardware bridge
└── hardware/
    └── nodex_mcp_bridge.py  # Connects the Xiaozhi robot to the website
```

> The bridge file may live on the hardware laptop only. It reads the Xiaozhi token from an environment variable, so **no token is stored in the code**.

---

## 1. Run the website locally

Requires **Python 3.10+**.

```powershell
git clone https://github.com/lalee8/Invictus.git
cd Invictus

python -m venv .venv
.venv\Scripts\Activate.ps1          # macOS / Linux: source .venv/bin/activate

pip install -r backend/requirements.txt

cd backend
uvicorn main:app --reload
```

Open **http://127.0.0.1:8000** — the ATM opens.
API documentation: **http://127.0.0.1:8000/docs**

There is **no separate frontend command**: `main.py` serves the `frontend` folder.

Next time you only need:

```powershell
cd Invictus
.venv\Scripts\Activate.ps1
cd backend
uvicorn main:app --reload
```

### First use

1. Tap **Open new account**, enter a name, a 4-digit PIN and a currency.
2. Write down the **card number** that appears on the card.
3. Tap **Log in with this card** (or **Start** → card number → PIN).

> Each computer has its own database (`backend/resilinode.db`). A card created on one laptop does **not** exist on another one.

---

## 2. Connect the voice robot (hardware)

The robot talks to the bridge, and the website polls the bridge.

```
Xiaozhi robot  ──MCP / WebSocket──▶  nodex_mcp_bridge.py  ◀──HTTP──  Nodex website
                                      (localhost:5000)
```

### Start the bridge (in a second terminal)

```powershell
pip install flask flask-cors websockets

$env:XIAOZHI_TOKEN="wss://api.xiaozhi.me/mcp/?token=YOUR_TOKEN"; python nodex_mcp_bridge.py
```

You can paste either the **full MCP endpoint URL** or only the token part.
`$env:XIAOZHI_TOKEN` is valid only in that terminal window.

Expected output:

```
🚀 Kiosk API:  http://localhost:5000/api/kiosk-state
🧪 Test page:  http://localhost:5000/api/test/card_input
🔑 Token loaded (... characters)
✅ Connected to Xiaozhi MCP. Check the Xiaozhi console: it should say Connected.
📩 Xiaozhi -> initialize
📩 Xiaozhi -> tools/list
```

Then open the website **on the same laptop**: `http://127.0.0.1:8000` and press **Ctrl+F5**.

During a voice command the terminal shows:

```
📩 Xiaozhi -> tools/call
⚡ [Nodex] v5 -> screen: balance | card: 0089258598 | pin: **** | amount: -
🖥️  Website v5: Your available balance is 620.00 AZN
🤖 Robot will say: Your available balance is 620.00 AZN
```

### Xiaozhi agent prompt

Paste this into the agent's **Role / Prompt** in the Xiaozhi console, save, and restart the robot:

```
You are the voice assistant of the Nodex ATM. Always use the navigate_kiosk tool and
ALWAYS say to the user exactly the text the tool returns. Never invent balances or amounts.
Flow:
1. Ask for the card number -> call navigate_kiosk with card_number (digits only).
2. Ask which service -> call with screen: balance, history, withdraw or deposit
   (for withdraw/deposit also send amount if the user said it).
3. Ask for the PIN -> call with pin (4 digits).
For withdraw/deposit after login: send amount, then ask the PIN to confirm and send pin.
"Menu" -> screen main_menu. "Exit" / "goodbye" -> screen welcome.
```

### Voice flow

| User says | Kiosk does |
|---|---|
| Card number | Shows it on the card, moves to the PIN step |
| "Check balance" / "Withdraw" / "Deposit" / "History" | Remembers the service |
| PIN | Logs in and opens the chosen service directly |
| "Withdraw 50" (after login) | Fills the amount, asks for the PIN |
| PIN (as confirmation) | Executes the transaction, shows the receipt |
| "Goodbye" | Logs out, back to Welcome |

### Bridge on another computer

If the bridge runs on a different laptop (same WiFi), open the site once with its IP:

```
http://127.0.0.1:8000/?bridge=192.168.1.25
```

The address is remembered. In this case the bridge must use `host="0.0.0.0"` and the firewall must allow port 5000.

---

## 3. Deploy online (Render, free)

1. Push the project to GitHub.
2. **render.com** → **New + → Web Service** → choose the repository.
3. Settings:

| Field | Value |
|---|---|
| Runtime | Python 3 |
| Build Command | `pip install -r backend/requirements.txt` |
| Start Command | `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Instance Type | Free |

4. **Deploy** → the site is live at `https://<name>.onrender.com`.

Notes:
- The free instance sleeps after 15 min of inactivity — the first visit takes ~50 s.
- The SQLite database resets on every deploy / restart.
- The hardware robot only works with the **local** site (`http://127.0.0.1:8000`), not with the online HTTPS link.

---

## API

| Method | URL | Description |
|---|---|---|
| POST | `/accounts/` | Open an account → returns `id` and `account_number` (card number) |
| POST | `/accounts/login` | Log in with `account_number` + `pin` |
| GET | `/accounts/{id}/balance?pin=` | Balance |
| POST | `/accounts/{id}/deposit` | Deposit `{ pin, amount }` |
| POST | `/accounts/{id}/withdraw` | Withdraw `{ pin, amount }` |
| GET | `/accounts/{id}/transactions?pin=` | Transaction history |
| GET | `/health` | Server status |

### Bridge API (localhost:5000)

| Method | URL | Description |
|---|---|---|
| GET | `/api/kiosk-state` | Current voice command (`screen`, `card_number`, `pin`, `amount`, `version`, `changed`) |
| POST | `/api/kiosk-result` | Website reports the real result `{ version, text }` |
| GET | `/api/test/<screen>` | Test without the robot, e.g. `/api/test/card_input` |
| GET | `/api/reset` | Back to Welcome, clears card / PIN |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not import module "main"` | Run `uvicorn` **inside** the `backend` folder |
| `No module named ...` | Activate `.venv`, run `pip install -r backend/requirements.txt` |
| http://127.0.0.1:8000 shows JSON | Old `main.py` — the new one serves the website |
| Footer shows **Offline** | The backend (`uvicorn`) is not running |
| "Wrong card number or PIN" | The card does not exist on **this** computer's database — create a new account |
| Bridge: `HTTP 401` | Wrong / expired token — copy a fresh MCP endpoint from the Xiaozhi console |
| Bridge: `XIAOZHI_TOKEN is not set` | Set the token in the **same** terminal before `python nodex_mcp_bridge.py` |
| Voice works but the site doesn't change | Close all other Nodex tabs, keep one `127.0.0.1:8000` tab, press **Ctrl+F5** |
| No `🖥️ Website` line in the bridge terminal | The site runs an old `app.js` — replace `frontend/app.js`, hard-reload |
| Robot speaks and the laptop speaks too | Set `SPEAK_ENABLED = false` at the top of `frontend/app.js` |

---

## Tech stack

- **Backend:** FastAPI, SQLAlchemy, SQLite, Argon2 PIN hashing (pwdlib)
- **Frontend:** HTML, CSS, vanilla JavaScript, Web Speech API
- **Hardware:** ESP32-S3 + Xiaozhi AI voice agent, MCP over WebSocket, Flask bridge

## Security notes

- PINs are stored only as Argon2 hashes.
- The PIN is never shown on screen and never printed by the bridge (`****`).
- Keep the Xiaozhi token out of Git — use the `XIAOZHI_TOKEN` environment variable.
- Login returns the same error for a wrong card and a wrong PIN.

## Team

Team **Invictus** — YUNEX 2026, Digital Inclusion challenge.