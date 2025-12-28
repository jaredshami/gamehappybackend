const uWS = require('uWebSockets.js');
const GameServer = require('./GameServer');

const gameServer = new GameServer();
let connectionIdCounter = 1;
const wsToConnectionId = new Map();

const port = 3001;

uWS.App()
  .ws('/*', {
    open: (ws) => {
      const connectionId = connectionIdCounter++;
      wsToConnectionId.set(ws, connectionId);
      console.log(`Client connected: ${connectionId}`);
    },

    message: (ws, msg, isBinary) => {
      const connectionId = wsToConnectionId.get(ws);
      if (!connectionId) {
        console.error('No connection ID found for WebSocket');
        return;
      }

      gameServer.handleMessage(ws, msg, connectionId);
    },

    close: (ws) => {
      const connectionId = wsToConnectionId.get(ws);
      if (connectionId) {
        gameServer.onPlayerDisconnect(connectionId);
        wsToConnectionId.delete(ws);
        console.log(`Client disconnected: ${connectionId}`);
      }
    }
  })
  .listen(port, (token) => {
    if (token) {
      console.log(`WebSocket server running on port ${port}`);
    } else {
      console.error(`Failed to listen on port ${port}`);
    }
  });
