# GameHappy Backend

WebSocket server for the Secret Syndicates game, built with Node.js and uWebSockets.

## Setup

```bash
npm install
npm start
```

The server will run on port 3001.

## Files

- `GameServer.js` - Main game logic (creating games, joining, roles, phases)
- `ws-server.js` - WebSocket server using uWebSockets.js
- `package.json` - Dependencies

## Game Flow

1. Player creates or joins a game
2. Host starts the game once minimum players join
3. Roles are assigned
4. Game proceeds through phases (Syndicate actions, voting, trials)
5. Game ends when Syndicate wins or is eliminated

## Deployment

On production server:
```bash
cd /var/www/gamehappy-backend
npm install
node ws-server.js
```

Or use systemd service:
```bash
sudo systemctl restart gamehappy-ws.service
```
