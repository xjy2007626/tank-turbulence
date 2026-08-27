const rooms = new Map();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const roomCode = () => Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
const clean = (value, max = 16) => String(value || "").trim().slice(0, max);

function send(ws, data) {
  try {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  } catch {}
}

function roster(room) {
  return room.clients.map((client, index) => ({
    name: client.name,
    role: index === 0 ? "host" : "guest",
  }));
}

function publishRoom(room) {
  room.clients.forEach(client => send(client.ws, {
    type: "room",
    code: room.code,
    players: roster(room),
  }));
}

function leave(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (!room) return;
  room.clients = room.clients.filter(item => item !== client);
  client.room = "";
  if (!room.clients.length) rooms.delete(room.code);
  else publishRoom(room);
}

function handleSocket(ws) {
  const client = { ws, name: "", room: "" };
  ws.accept();
  send(ws, { type: "hello", service: "Tank Turbulence Online" });

  ws.addEventListener("message", event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "create") {
      leave(client);
      let code;
      do code = roomCode(); while (rooms.has(code));
      const room = { code, clients: [] };
      client.name = clean(msg.name) || "Player 1";
      client.room = code;
      room.clients.push(client);
      rooms.set(code, room);
      send(ws, { type: "created", code, role: "host" });
      publishRoom(room);
      return;
    }

    if (msg.type === "join") {
      leave(client);
      const code = clean(msg.code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "error", message: "房间不存在" });
      if (room.clients.length >= 2) return send(ws, { type: "error", message: "房间已满" });
      client.name = clean(msg.name) || "Player 2";
      client.room = code;
      room.clients.push(client);
      send(ws, { type: "joined", code, role: "guest" });
      publishRoom(room);
      return;
    }

    if (msg.type === "leave") {
      leave(client);
      return;
    }

    const room = rooms.get(client.room);
    if (!room) return;
    if (["start", "state", "input", "fire", "chat"].includes(msg.type)) {
      room.clients
        .filter(item => item !== client)
        .forEach(item => send(item.ws, msg));
    }
  });

  ws.addEventListener("close", () => leave(client));
  ws.addEventListener("error", () => leave(client));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      handleSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    return Response.json({
      ok: true,
      service: "Tank Turbulence Online",
      rooms: rooms.size,
      websocket: `wss://${url.host}`,
    }, {
      headers: { "access-control-allow-origin": "*" },
    });
  },
};
