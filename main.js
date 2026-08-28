/* ============================================================
   Tank Turbulence 联机后端 —— Deno Deploy 版
   （Cloudflare worker.js 的移植，房间逻辑完全一致）

   本地运行：deno run --allow-net --allow-env main.ts
   Deno Deploy：在 dash.deno.com 新建项目，入口选 main.ts 即可

   特性：
     - WebSocket：建房间 / 加入 / 转发 state/input/fire/start/chat
     - HTTP 兜底：/api/create /api/join /api/poll /api/send /api/leave /（健康检查）
     - CORS 全开（允许 GitHub Pages 跨域调用）
     - 自带 HTTPS（deno.dev 域名）
   ============================================================ */

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

const roomCode = () =>
  Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");

const clientToken = () => crypto.randomUUID();

const clean = (v, max = 16) => String(v ?? "").trim().slice(0, max);

const json = (data, status = 200) => Response.json(data, { status, headers: corsHeaders });

class RoomHub {
  constructor() {
    this.rooms = new Map();
    this.httpClients = new Map();
  }

  send(client, data) {
    if (!client) return;
    if (client.kind === "ws") {
      try {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(data));
      } catch {}
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
    const message = { type: "room", code: room.code, players: this.roster(room) };
    room.clients.forEach((c) => this.send(c, message));
  }

  leave(client) {
    if (!client || !client.room) return;
    const room = this.rooms.get(client.room);
    client.room = "";
    if (!room) return;
    room.clients = room.clients.filter((item) => item !== client);
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
      if (room.clients.length >= 2) return this.send(client, { type: "error", message: "房间已满" });
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
      room.clients.filter((item) => item !== client).forEach((item) => this.send(item, msg));
    }
  }

  handleSocket(ws) {
    const client = { kind: "ws", ws, name: "", room: "" };
    ws.addEventListener("open", () => {
      this.send(client, { type: "hello", service: "Tank Turbulence Online" });
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handleMessage(client, msg);
    });

    ws.addEventListener("close", () => this.leave(client));
    ws.addEventListener("error", () => this.leave(client));
  }

  async handleHttp(req, url) {
    this.cleanupHttpClients();

    if (req.method === "POST" && (url.pathname === "/api/create" || url.pathname === "/api/join")) {
      let body;
      try {
        body = await req.json();
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
      if (events.some((e) => e.type === "error")) this.httpClients.delete(client.token);
      return json({ ok: true, token: client.token, events });
    }

    if (url.pathname === "/api/poll" && req.method === "GET") {
      const client = this.httpClients.get(clean(url.searchParams.get("token"), 80));
      if (!client) return json({ ok: false, error: "连接已失效，请重新加入房间" }, 410);
      client.lastSeen = Date.now();
      return json({ ok: true, events: this.drain(client) });
    }

    if ((url.pathname === "/api/send" || url.pathname === "/api/leave") && req.method === "POST") {
      let body;
      try {
        body = await req.json();
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
      durableObject: false,
      websocket: `wss://${url.host}`,
      httpFallback: true,
      rooms: this.rooms.size,
    });
  }
}

const hub = new RoomHub();

Deno.serve({ port: Number(Deno.env.get("PORT") || 8000) }, (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const upgrade = (req.headers.get("upgrade") || "").toLowerCase();
  if (upgrade === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    hub.handleSocket(socket);
    return response;
  }

  return hub.handleHttp(req, new URL(req.url));
});

console.log("[Tank Turbulence Online] Deno server started");
