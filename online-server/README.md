# Tank Turbulence 联机服务器

这是房间服务端，适合部署到 Render。它负责六位房间号、两名玩家加入、房间状态和实时游戏消息转发。

## 本地运行

```bash
npm install
npm start
```

默认地址为 `ws://localhost:3000`。

## Render 部署

1. 把本目录提交到 GitHub 仓库。
2. 在 Render 创建 Blueprint，选择该仓库中的 `render.yaml`。
3. 部署完成后复制 `wss://你的服务名.onrender.com`。
4. 将网页中的 `TT_ONLINE_SERVER_URL` 设置成这个地址。

免费服务长时间无人使用后可能休眠，第一次连接可能需要等待几十秒。
