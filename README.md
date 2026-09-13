# RPS Cloudflare Backend

## Configuration

Set `ALLOWED_ORIGINS` in `wrangler.toml` to the exact origin hosting the frontend. Multiple origins are comma-separated.

## Protocol

Create a room:

```http
POST /games
```

The response contains `gameId` and `websocketUrl`. Both players connect to that WebSocket URL. Room selection is done during the upgrade; `create_game` and `join_game` WebSocket messages are not used.

## Local development

```bash
pnpm dev
```

Configure the frontend with `REACT_APP_BACKEND_HTTP_URL` and `REACT_APP_BACKEND_WS_URL`.
