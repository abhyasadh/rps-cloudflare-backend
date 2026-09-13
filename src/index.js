export { GameRoom } from "./GameRoom.js";

const GAME_ID_PATTERN = /^[a-z0-9]{6}$/;

function createGameId() {
  const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return id;
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.includes(origin)) return origin;
  return null;
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
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
    const allowedOrigin = getAllowedOrigin(request, env);
    const headers = corsHeaders(allowedOrigin);

    if (!allowedOrigin) {
      return json({ error: "origin_not_allowed" }, 403);
    }

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method === "POST" && url.pathname === "/games") {
      const gameId = createGameId();
      const stub = env.GAME_ROOM.getByName(gameId);
      const created = await stub.fetch(
        new Request(`${url.origin}/room`, { method: "POST" })
      );

      if (!created.ok) {
        return json({ error: "room_creation_failed" }, 500, headers);
      }

      return json({
        gameId,
        websocketUrl: `${url.origin.replace("http", "ws")}/ws/${gameId}`,
      }, 201, headers);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426, headers);
    }

    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, headers);
    }

    if (url.pathname !== "/ws" && !url.pathname.startsWith("/ws/")) {
      return json({ error: "not_found" }, 404, headers);
    }

    const gameId = getGameId(url);
    if (!validGameId(gameId)) {
      return json({ error: "invalid_game_id" }, 400, headers);
    }

    const stub = env.GAME_ROOM.getByName(gameId);
    return stub.fetch(new Request(`${url.origin}/ws?gameId=${gameId}`, request));
  },
};
