import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomCode = () => Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
const clean = (value, max = 16) => String(value || "").trim().slice(0, max);

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function roster(room) {
  return room.clients.map((client, index) => ({ name: client.name, role: index === 0 ? "host" : "guest" }));
}
function publishRoom(room) {
  room.clients.forEach(client => send(client.ws, { type: "room", code: room.code, players: roster(room) }));
}
function leave(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (!room) return;
  room.clients = room.clients.filter(item => item !== client);
  if (!room.clients.length) rooms.delete(room.code);
  else publishRoom(room);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ ok: true, service: "Tank Turbulence Online", rooms: rooms.size }));
});
const wss = new WebSocketServer({ server });

wss.on("connection", ws => {
  const client = { ws, name: "", room: "" };
  send(ws, { type: "hello" });
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
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
    const room = rooms.get(client.room);
    if (!room) return;
    if (["start", "state", "input", "fire", "leave", "chat"].includes(msg.type)) {
      room.clients.filter(item => item !== client).forEach(item => send(item.ws, msg));
    }
  });
  ws.on("close", () => leave(client));
  ws.on("error", () => leave(client));
});

server.listen(port, "0.0.0.0", () => console.log(`Tank Turbulence server listening on ${port}`));
