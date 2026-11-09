"""
Nodex MCP Bridge
----------------
Xiaozhi voice board  --(MCP over WebSocket)-->  this script  --(HTTP)-->  Nodex website

Run:
    pip install flask flask-cors websockets
    set XIAOZHI_TOKEN=your_token_here        (PowerShell: $env:XIAOZHI_TOKEN="your_token_here")
    python nodex_mcp_bridge.py

The website polls:  http://localhost:5000/api/kiosk-state
"""

import asyncio
import json
import logging
import os
from threading import Thread, Lock

import websockets
from flask import Flask, jsonify, request
from flask_cors import CORS


# =====================================================
# 1. Shared kiosk state (read by the website)
# =====================================================

state_lock = Lock()

kiosk_state = {
    "screen": "welcome",   # welcome, card_input, main_menu, balance, history, withdraw, deposit
    "card_number": "",     # spoken card number (digits)
    "pin": "",             # spoken 4-digit PIN
    "amount": "",          # spoken amount for withdraw / deposit
    "version": 0,          # +1 on every voice command, so the site reacts even to repeated values
    "changed": [],         # which fields the last command set
    "last_action": "IDLE",
}

SCREENS = ["welcome", "card_input", "main_menu", "balance", "history", "withdraw", "deposit"]

# Real results reported by the website: version -> text (e.g. "Your available balance is 620 AZN")
results = {}
RESULT_TIMEOUT = 6.0   # seconds the robot waits for the website


def digits_only(value):
    """'0089 2585 98' -> '0089258598' (voice often adds spaces or dashes)"""
    return "".join(ch for ch in str(value) if ch.isdigit())


def update_state(args):
    """Apply one voice command to the kiosk state."""
    changed = []

    with state_lock:
        screen = args.get("screen")
        if screen in SCREENS:
            kiosk_state["screen"] = screen
            changed.append("screen")

            # New session: forget the previous user's card and PIN
            if screen in ("welcome", "card_input"):
                kiosk_state["card_number"] = ""
                kiosk_state["pin"] = ""
                kiosk_state["amount"] = ""

        if args.get("card_number"):
            kiosk_state["card_number"] = digits_only(args["card_number"])
            changed.append("card_number")

        if args.get("pin"):
            kiosk_state["pin"] = digits_only(args["pin"])[:4]
            changed.append("pin")

        if args.get("amount"):
            kiosk_state["amount"] = digits_only(args["amount"])
            changed.append("amount")

        if args.get("confirm") in (True, "true", "yes", 1):
            changed.append("confirm")

        kiosk_state["version"] += 1
        kiosk_state["changed"] = changed
        kiosk_state["last_action"] = ", ".join(changed) or "IDLE"

        # Never print the real PIN
        masked_pin = "*" * len(kiosk_state["pin"])
        print(
            f"⚡ [Nodex] v{kiosk_state['version']} -> screen: {kiosk_state['screen']} | "
            f"card: {kiosk_state['card_number'] or '-'} | pin: {masked_pin or '-'} | "
            f"amount: {kiosk_state['amount'] or '-'}"
        )

    return changed, kiosk_state["version"]


# =====================================================
# 2. Local HTTP API for the website
# =====================================================

app = Flask(__name__)
CORS(app)

# Hide the endless "GET /api/kiosk-state 200" lines so the important messages are visible
logging.getLogger("werkzeug").setLevel(logging.ERROR)


@app.route("/api/kiosk-state", methods=["GET"])
def get_kiosk_state():
    with state_lock:
        return jsonify(kiosk_state)


@app.route("/api/kiosk-result", methods=["POST"])
def kiosk_result():
    """The website tells us what REALLY happened (balance, errors, success)."""
    data = request.get_json(silent=True) or {}
    try:
        version = int(data.get("version"))
    except (TypeError, ValueError):
        return jsonify({"ok": False}), 400
    text = str(data.get("text", ""))[:500]
    with state_lock:
        results[version] = text
        # keep memory small
        for old in [v for v in results if v < version - 50]:
            results.pop(old, None)
    print(f"🖥️  Website v{version}: {text}")
    return jsonify({"ok": True})


async def wait_for_result(version):
    """Wait until the website reports the result of this command."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + RESULT_TIMEOUT
    while loop.time() < deadline:
        with state_lock:
            if version in results:
                return results.pop(version)
        await asyncio.sleep(0.1)
    return None


@app.route("/api/reset", methods=["POST", "GET"])
def reset_state():
    """Handy for demos: clears card / PIN and goes to welcome."""
    update_state({"screen": "welcome"})
    return jsonify({"ok": True})


@app.route("/api/test/<screen>")
def test_screen(screen):
    """Test without the board, e.g. http://localhost:5000/api/test/card_input"""
    if screen not in SCREENS:
        return jsonify({"error": f"Unknown screen. Use one of: {', '.join(SCREENS)}"}), 400
    update_state({"screen": screen})
    return jsonify(kiosk_state)


def run_flask():
    print("🚀 Kiosk API:  http://localhost:5000/api/kiosk-state")
    print("🧪 Test page:  http://localhost:5000/api/test/card_input")
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)


# =====================================================
# 3. Xiaozhi MCP (JSON-RPC over WebSocket)
# =====================================================

_raw = os.environ.get("XIAOZHI_TOKEN", "").strip()
XIAOZHI_TOKEN = _raw.split("token=", 1)[1] if "token=" in _raw else _raw  # full URL or just the token
XIAOZHI_WSS_URL = f"wss://api.xiaozhi.me/mcp/?token={XIAOZHI_TOKEN}"

TOOLS = [
    {
        "name": "navigate_kiosk",
        "description": (
            "Controls the Nodex ATM kiosk hands-free. "
            "Use 'screen' to switch screens, 'card_number' when the user says their card number, "
            "'pin' when the user says their 4-digit PIN, 'amount' when the user says how much "
            "to withdraw or deposit, and 'confirm' when the user confirms a transaction. "
            "Flow: card_number -> service (screen) -> pin. For withdraw/deposit: amount -> pin to confirm. "
            "IMPORTANT: the tool returns what the ATM really did. Always tell the user exactly that text. "
            "Never guess or invent balances, amounts or results."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "screen": {
                    "type": "string",
                    "enum": SCREENS,
                    "description": "Target screen",
                },
                "card_number": {
                    "type": "string",
                    "description": "Card number spoken by the user, digits only (10 digits)",
                },
                "pin": {
                    "type": "string",
                    "description": "4-digit PIN spoken by the user, digits only",
                },
                "amount": {
                    "type": "string",
                    "description": "Amount to withdraw or deposit, digits only",
                },
                "confirm": {
                    "type": "boolean",
                    "description": "True when the user confirms the withdraw / deposit",
                },
            },
        },
    }
]


def rpc_result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def rpc_error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


async def handle_tool_call(data):
    """Update the kiosk, then wait for the website's REAL result and return it to the robot."""
    msg_id = data.get("id")
    params = data.get("params", {})
    if params.get("name") != "navigate_kiosk":
        return rpc_error(msg_id, -32602, f"Unknown tool: {params.get('name')}")

    changed, version = update_state(params.get("arguments", {}) or {})
    if not changed:
        text = "Nothing to update"
    else:
        text = await wait_for_result(version)
        if text is None:
            text = "The ATM screen was updated. Ask the user to look at the screen."
        print(f"🤖 Robot will say: {text}")

    return rpc_result(msg_id, {"content": [{"type": "text", "text": text}]})


def handle_message(data):
    """Returns a response dict, or None for notifications."""
    method = data.get("method")
    msg_id = data.get("id")

    # Notifications (no id) need no answer, e.g. "notifications/initialized"
    if msg_id is None:
        return None

    # MCP handshake: must be answered first, otherwise the tools are never requested
    if method == "initialize":
        return rpc_result(msg_id, {
            "protocolVersion": data.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "nodex-kiosk", "version": "1.0.0"},
        })

    if method == "ping":
        return rpc_result(msg_id, {})

    if method == "tools/list":
        return rpc_result(msg_id, {"tools": TOOLS})

    return rpc_error(msg_id, -32601, f"Method not found: {method}")


async def xiaozhi_mcp_client():
    if XIAOZHI_TOKEN:
        print(f"🔑 Token loaded ({len(XIAOZHI_TOKEN)} characters)")
    if not XIAOZHI_TOKEN:
        print("❌ XIAOZHI_TOKEN is not set. Example (PowerShell):  $env:XIAOZHI_TOKEN=\"...\"")
        print("   The website API still works, but voice commands won't arrive.")
        while True:
            await asyncio.sleep(3600)

    while True:
        try:
            print("Connecting to Xiaozhi MCP endpoint...")
            async with websockets.connect(XIAOZHI_WSS_URL, ping_interval=20, ping_timeout=20) as ws:
                print("✅ Connected to Xiaozhi MCP. Check the Xiaozhi console: it should say Connected.")

                async for message in ws:
                    try:
                        data = json.loads(message)
                    except json.JSONDecodeError:
                        continue

                    if data.get("method"):
                        print(f"📩 Xiaozhi -> {data.get('method')}")

                    if data.get("method") == "tools/call" and data.get("id") is not None:
                        response = await handle_tool_call(data)
                    else:
                        response = handle_message(data)
                    if response is not None:
                        await ws.send(json.dumps(response))

        except Exception as e:
            print(f"⚠️ Connection lost ({e}). Reconnecting in 3 seconds...")
            await asyncio.sleep(3)


if __name__ == "__main__":
    Thread(target=run_flask, daemon=True).start()
    asyncio.run(xiaozhi_mcp_client())
    