const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

const roomCode = () => Array.from(
  { length: 6 },
  () => alphabet[Math.floor(Math.random() * alphabet.length)],
).join("");

const clientToken = () => {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const clean = (value, max = 16) => String(value || "").trim().slice(0, max);

function json(data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

function sendSocket(ws, data) {
  try {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
  } catch {}
}

export class RoomHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();
    this.httpClients = new Map();
  }

  send(client, data) {
    if (client.kind === "ws") {
      sendSocket(client.ws, data);
      return;
    }
    client.queue.push(data);
    if (client.queue.length > 120) client.queue.splice(0, client.queue.length - 120);
  }

  drain(client) {
    return client.queue.splice(0);
  }

  roster(room) {
    return room.clients.map((client, index) => ({
      name: client.name,
      role: index === 0 ? "host" : "guest",
    }));
  }

  publishRoom(room) {
    const message = {
      type: "room",
      code: room.code,
      players: this.roster(room),
    };
    room.clients.forEach(client => this.send(client, message));
  }

  leave(client) {
    if (!client?.room) return;
    const room = this.rooms.get(client.room);
    client.room = "";
    if (!room) return;
    room.clients = room.clients.filter(item => item !== client);
    if (!room.clients.length) this.rooms.delete(room.code);
    else this.publishRoom(room);
  }

  cleanupHttpClients() {
    const now = Date.now();
    for (const [token, client] of this.httpClients) {
      if (now - client.lastSeen <= 45000) continue;
      this.leave(client);
      this.httpClients.delete(token);
    }
  }

  handleMessage(client, msg) {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "create") {
      this.leave(client);
      let code;
      do code = roomCode(); while (this.rooms.has(code));
      const room = { code, clients: [] };
      client.name = clean(msg.name) || "Player 1";
      client.room = code;
      room.clients.push(client);
      this.rooms.set(code, room);
      this.send(client, { type: "created", code, role: "host" });
      this.publishRoom(room);
      return;
    }

    if (msg.type === "join") {
      this.leave(client);
      const code = clean(msg.code, 6).toUpperCase();
      const room = this.rooms.get(code);
      if (!room) return this.send(client, { type: "error", message: "房间不存在" });
      if (room.clients.length >= 2) {
        return this.send(client, { type: "error", message: "房间已满" });
      }
      client.name = clean(msg.name) || "Player 2";
      client.room = code;
      room.clients.push(client);
      this.send(client, { type: "joined", code, role: "guest" });
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
        .forEach(item => this.send(item, msg));
    }
  }

  handleSocket(ws) {
    const client = { kind: "ws", ws, name: "", room: "" };
    ws.accept();
    this.send(client, { type: "hello", service: "Tank Turbulence Online" });

    ws.addEventListener("message", event => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleMessage(client, msg);
    });

    ws.addEventListener("close", () => this.leave(client));
    ws.addEventListener("error", () => this.leave(client));
  }

  async handleHttp(request, url) {
    this.cleanupHttpClients();

    if (request.method === "POST" && ["/api/create", "/api/join"].includes(url.pathname)) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "请求格式错误" }, 400);
      }
      const client = {
        kind: "http",
        token: clientToken(),
        name: "",
        room: "",
        queue: [],
        lastSeen: Date.now(),
      };
      this.httpClients.set(client.token, client);
      this.handleMessage(client, {
        type: url.pathname === "/api/create" ? "create" : "join",
        name: body.name,
        code: body.code,
      });
      const events = this.drain(client);
      if (events.some(event => event.type === "error")) {
        this.httpClients.delete(client.token);
      }
      return json({ ok: true, token: client.token, events });
    }

    if (url.pathname === "/api/poll" && request.method === "GET") {
      const client = this.httpClients.get(clean(url.searchParams.get("token"), 80));
      if (!client) return json({ ok: false, error: "连接已失效，请重新加入房间" }, 410);
      client.lastSeen = Date.now();
      return json({ ok: true, events: this.drain(client) });
    }

    if (["/api/send", "/api/leave"].includes(url.pathname) && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "请求格式错误" }, 400);
      }
      const client = this.httpClients.get(clean(body.token, 80));
      if (!client) return json({ ok: false, error: "连接已失效，请重新加入房间" }, 410);
      client.lastSeen = Date.now();
      if (url.pathname === "/api/leave") {
        this.leave(client);
        this.httpClients.delete(client.token);
      } else {
        this.handleMessage(client, body.message);
      }
      return json({ ok: true });
    }

    return json({
      ok: true,
      service: "Tank Turbulence Online",
      durableObject: true,
      websocket: `wss://${url.host}`,
      httpFallback: true,
      rooms: this.rooms.size,
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return this.handleHttp(request, new URL(request.url));
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    if (!env.ROOM_HUB) {
      return json({
        ok: false,
        error: "ROOM_HUB binding is missing",
      }, 500);
    }

    const id = env.ROOM_HUB.idFromName("global-room-hub");
    const hub = env.ROOM_HUB.get(id);
    return hub.fetch(request);
  },
};
