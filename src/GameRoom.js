import { DurableObject } from "cloudflare:workers";

const MAX_MESSAGE_BYTES = 4096;
const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 30;
const CHOICES = new Set(["rock", "paper", "scissors"]);

function initialState() {
  return {
    created: false,
    phase: "waiting",
    choices: {},
    rematchRequests: [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = initialState();
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) || initialState();
    });
  }

  async fetch(request) {
    if (request.method === "POST" && new URL(request.url).pathname === "/room") {
      this.state.created = true;
      this.state.lastActivityAt = Date.now();
      await this.saveState();
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
    }

    await this.refreshState();
    if (!this.state.created) {
      return Response.json({ error: "game_not_found" }, { status: 404 });
    }

    const existing = this.playerSockets();
    if (existing.length >= 2) {
      return Response.json({ error: "game_full" }, { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const role = this.nextRole(existing);

    server.serializeAttachment({
      role,
      windowStartedAt: Date.now(),
      messageCount: 0,
    });
    this.ctx.acceptWebSocket(server);

    if (role === "player1") {
      this.state.phase = "waiting";
      server.send(JSON.stringify({ type: "game_created", gameId: this.publicGameId(request) }));
    } else {
      this.state.phase = "choosing";
      server.send(JSON.stringify({ type: "game_joined", gameId: this.publicGameId(request) }));
      this.sendToRole("player1", {
        type: "player_joined",
        message: "Player 2 has joined the game.",
      });
    }

    this.state.lastActivityAt = Date.now();
    await this.saveState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = this.readAttachment(ws);
    if (!meta) return this.fail(ws, "invalid_session", "Invalid WebSocket session.");

    const now = Date.now();
    if (now - meta.windowStartedAt >= RATE_WINDOW_MS) {
      meta.windowStartedAt = now;
      meta.messageCount = 0;
    }
    meta.messageCount += 1;
    ws.serializeAttachment(meta);
    if (meta.messageCount > MAX_MESSAGES_PER_WINDOW) {
      ws.close(1008, "Rate limit exceeded");
      return;
    }

    const text = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      return this.fail(ws, "message_too_large", "Message is too large.");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return this.fail(ws, "invalid_json", "Message must be valid JSON.");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return this.fail(ws, "invalid_message", "Message must be an object.");
    }

    await this.refreshState();
    this.state.lastActivityAt = Date.now();

    switch (data.type) {
      case "make_choice":
        await this.handlePlayerChoice(ws, meta, data.choice);
        break;
      case "request_rematch":
        await this.handleRematchRequest(ws, meta);
        break;
      case "create_game":
      case "join_game":
        this.fail(ws, "obsolete_message", "Connect using the room WebSocket URL.");
        break;
      default:
        this.fail(ws, "invalid_message_type", "Invalid message type.");
    }
  }

  async handlePlayerChoice(ws, meta, choice) {
    if (!CHOICES.has(choice)) {
      return this.fail(ws, "invalid_choice", "Choice must be rock, paper, or scissors.");
    }
    if (this.state.phase !== "choosing") {
      return this.fail(ws, "choice_not_allowed", "A choice cannot be made now.");
    }
    if (this.state.choices[meta.role]) {
      return this.fail(ws, "choice_already_made", "Choice has already been submitted.");
    }

    this.state.choices[meta.role] = choice;
    const otherRole = meta.role === "player1" ? "player2" : "player1";
    this.sendToRole(otherRole, {
      type: "choice_made",
      message: `${meta.role === "player1" ? "Player 1" : "Player 2"} has made a choice!`,
    });

    if (this.state.choices.player1 && this.state.choices.player2) {
      this.state.phase = "resolved";
      await this.saveState();
      this.determineWinner();
      return;
    }
    await this.saveState();
  }

  determineWinner() {
    const { player1, player2 } = this.state.choices;
    const result = this.getGameResult(player1, player2);
    this.sendToRole("player1", {
      type: "game_result",
      result,
      yourChoice: player1,
      opponentChoice: player2,
    });
    this.sendToRole("player2", {
      type: "game_result",
      result: this.reverseResult(result),
      yourChoice: player2,
      opponentChoice: player1,
    });
  }

  async handleRematchRequest(ws, meta) {
    if (this.state.phase !== "resolved") {
      return this.fail(ws, "rematch_not_allowed", "A rematch is not available now.");
    }
    if (!this.state.rematchRequests.includes(meta.role)) {
      this.state.rematchRequests.push(meta.role);
    }
    if (this.state.rematchRequests.length === 1) {
      this.sendToRole(meta.role === "player1" ? "player2" : "player1", {
        type: "rematch_requested",
        message: "Player has requested a rematch.",
      });
    }
    if (this.state.rematchRequests.length === 2) {
      this.state.choices = {};
      this.state.rematchRequests = [];
      this.state.phase = "choosing";
      this.sendToRole("player1", { type: "rematch_accepted", message: "Rematch started!" });
      this.sendToRole("player2", { type: "rematch_accepted", message: "Rematch started!" });
    } else {
      this.sendToRole(meta.role, {
        type: "rematch_pending",
        message: "Waiting for the other player to accept rematch.",
      });
    }
    await this.saveState();
  }

  async webSocketClose(ws) {
    const meta = this.readAttachment(ws);
    if (!meta) return;

    const otherRole = meta.role === "player1" ? "player2" : "player1";
    if (this.socketForRole(otherRole)) {
      this.sendToRole(otherRole, {
        type: "info",
        code: "player_disconnected",
        message: "Other player disconnected. Game ended.",
      });
    }

    this.state.choices = {};
    this.state.rematchRequests = [];
    this.state.phase = this.socketForRole(otherRole) ? "waiting" : "closed";
    await this.saveState();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    if (this.playerSockets().length === 0) {
      await this.ctx.storage.delete("state");
      this.state = initialState();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }

  playerSockets() {
    return this.ctx.getWebSockets().filter((socket) => this.readAttachment(socket));
  }

  socketForRole(role) {
    return this.playerSockets().find((socket) => this.readAttachment(socket)?.role === role);
  }

  sendToRole(role, message) {
    const socket = this.socketForRole(role);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  nextRole(existing) {
    const roles = new Set(existing.map((socket) => this.readAttachment(socket)?.role));
    return roles.has("player1") ? "player2" : "player1";
  }

  readAttachment(ws) {
    try {
      const attachment = ws.deserializeAttachment();
      return attachment?.role === "player1" || attachment?.role === "player2"
        ? attachment
        : null;
    } catch {
      return null;
    }
  }

  publicGameId(request) {
    return new URL(request.url).searchParams.get("gameId") || "";
  }

  async refreshState() {
    this.state = (await this.ctx.storage.get("state")) || initialState();
  }

  async saveState() {
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }

  fail(ws, code, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", code, message }));
    }
  }

  getGameResult(choice1, choice2) {
    if (choice1 === choice2) return "draw";
    if (
      (choice1 === "rock" && choice2 === "scissors") ||
      (choice1 === "scissors" && choice2 === "paper") ||
      (choice1 === "paper" && choice2 === "rock")
    ) return "win";
    return "lose";
  }

  reverseResult(result) {
    if (result === "win") return "lose";
    if (result === "lose") return "win";
    return "draw";
  }
}
