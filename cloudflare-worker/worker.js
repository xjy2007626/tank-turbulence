const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const roomCode = () => Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
const clean = (value, max = 16) => String(value || "").trim().slice(0, max);

function send(ws, data) {
  try {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  } catch {}
}

export class RoomHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();
  }

  roster(room) {
    return room.clients.map((client, index) => ({
      name: client.name,
      role: index === 0 ? "host" : "guest",
    }));
  }

  publishRoom(room) {
    room.clients.forEach(client => send(client.ws, {
      type: "room",
      code: room.code,
      players: this.roster(room),
    }));
  }

  leave(client) {
    if (!client.room) return;
    const room = this.rooms.get(client.room);
    if (!room) return;
    room.clients = room.clients.filter(item => item !== client);
    client.room = "";
    if (!room.clients.length) this.rooms.delete(room.code);
    else this.publishRoom(room);
  }

  handleSocket(ws) {
    const client = { ws, name: "", room: "" };
    ws.accept();
    send(ws, { type: "hello", service: "Tank Turbulence Online" });

    ws.addEventListener("message", event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "create") {
        this.leave(client);
        let code;
        do code = roomCode(); while (this.rooms.has(code));
        const room = { code, clients: [] };
        client.name = clean(msg.name) || "Player 1";
        client.room = code;
        room.clients.push(client);
        this.rooms.set(code, room);
        send(ws, { type: "created", code, role: "host" });
        this.publishRoom(room);
        return;
      }

      if (msg.type === "join") {
        this.leave(client);
        const code = clean(msg.code, 6).toUpperCase();
        const room = this.rooms.get(code);
        if (!room) return send(ws, { type: "error", message: "房间不存在" });
        if (room.clients.length >= 2) return send(ws, { type: "error", message: "房间已满" });
        client.name = clean(msg.name) || "Player 2";
        client.room = code;
        room.clients.push(client);
        send(ws, { type: "joined", code, role: "guest" });
        this.publishRoom(room);
        return;
      }

      if (msg.type === "leave") {
        this.leave(client);
        return;
      }

      const room = this.rooms.get(client.room);
      if (!room) return;
      if (["start", "state", "input", "fire", "chat"].includes(msg.type)) {
        room.clients
          .filter(item => item !== client)
          .forEach(item => send(item.ws, msg));
      }
    });

    ws.addEventListener("close", () => this.leave(client));
    ws.addEventListener("error", () => this.leave(client));
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return Response.json({
      ok: true,
      service: "Tank Turbulence Online",
      durableObject: true,
      rooms: this.rooms.size,
    }, {
      headers: { "access-control-allow-origin": "*" },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    const id = env.ROOM_HUB.idFromName("global-room-hub");
    const hub = env.ROOM_HUB.get(id);

    if (request.headers.get("Upgrade") === "websocket") {
      return hub.fetch(request);
    }

    const hubStatus = await hub.fetch(request);
    const data = await hubStatus.json();
    return Response.json({
      ...data,
      websocket: `wss://${url.host}`,
    }, {
      headers: { "access-control-allow-origin": "*" },
    });
  },
};
