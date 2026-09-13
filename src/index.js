export { GameRoom } from "./GameRoom.js";

const GAME_ID_PATTERN = /^[a-f0-9]{32}$/;

function createGameId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return configured.includes(origin);
}

function getGameId(url) {
  if (url.pathname.startsWith("/ws/")) {
    return url.pathname.slice("/ws/".length);
  }
  return url.searchParams.get("gameId");
}

function validGameId(gameId) {
  return typeof gameId === "string" && GAME_ID_PATTERN.test(gameId);
}

export default {
  async fetch(request, env) {
    if (!allowedOrigin(request, env)) {
      return json({ error: "origin_not_allowed" }, 403);
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/games") {
      const gameId = createGameId();
      const stub = env.GAME_ROOM.getByName(gameId);
      const created = await stub.fetch(
        new Request(`${url.origin}/room`, { method: "POST" })
      );

      if (!created.ok) {
        return json({ error: "room_creation_failed" }, 500);
      }

      return json({
        gameId,
        websocketUrl: `${url.origin.replace("http", "ws")}/ws/${gameId}`,
      }, 201);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }

    if (url.pathname !== "/ws" && !url.pathname.startsWith("/ws/")) {
      return json({ error: "not_found" }, 404);
    }

    const gameId = getGameId(url);
    if (!validGameId(gameId)) {
      return json({ error: "invalid_game_id" }, 400);
    }

    const stub = env.GAME_ROOM.getByName(gameId);
    return stub.fetch(new Request(`${url.origin}/ws?gameId=${gameId}`, request));
  },
};
