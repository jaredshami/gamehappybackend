// GameServer.js - Main game logic ported from PHP Ratchet

class GameServer {
  constructor() {
    this.games = new Map();
    this.playerConnections = new Map(); // connectionId -> gameCode
    this.playerTokens = new Map(); // token -> {gameCode, connectionId}
    this.clientConnectionMap = new Map(); // ws -> connectionId (for tracking)
  }

  // ==================== UTILITIES ====================

  generateGameCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
      }
    } while (this.games.has(code));
    return code;
  }

  generatePlayerToken() {
    return require('crypto').randomBytes(16).toString('hex');
  }

  getPlayerList(gameCode) {
    const game = this.games.get(gameCode);
    if (!game) return [];

    const players = [];
    for (const [resourceId, player] of game.players) {
      players.push({
        id: resourceId,
        name: player.name,
        connected: player.connected ?? true,
        alive: player.alive ?? true,
        isHost: player.isHost ?? false
      });
    }
    return players;
  }

  broadcastToGame(gameCode, message) {
    const game = this.games.get(gameCode);
    if (!game) return;

    const messageStr = JSON.stringify(message);
    for (const [, player] of game.players) {
      if (player.connection && player.connected !== false) {
        try {
          player.connection.send(messageStr);
        } catch (e) {
          console.error('Error broadcasting:', e.message);
        }
      }
    }
  }

  // ==================== GAME CREATION & JOINING ====================

  createGame(ws, data, connectionId) {
    const playerName = (data.playerName ?? '').trim();

    if (!playerName) {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Player name is required'
      }));
      return;
    }

    const gameCode = this.generateGameCode();
    const playerToken = this.generatePlayerToken();

    const game = {
      code: gameCode,
      host: connectionId,
      hostToken: playerToken,
      players: new Map([
        [connectionId, {
          name: playerName,
          isHost: true,
          connection: ws,
          token: playerToken,
          connected: true
        }]
      ]),
      settings: {
        eyeWitness: data.eyeWitness ?? false,
        bodyGuard: data.bodyGuard ?? false
      },
      status: 'lobby'
    };

    this.games.set(gameCode, game);
    this.playerConnections.set(connectionId, gameCode);
    this.playerTokens.set(playerToken, { gameCode, connectionId });

    ws.send(JSON.stringify({
      action: 'gameCreated',
      gameCode: gameCode,
      players: this.getPlayerList(gameCode),
      isHost: true,
      playerToken: playerToken
    }));

    console.log(`Game created: ${gameCode} by ${playerName}`);
  }

  joinGame(ws, data, connectionId) {
    const playerName = (data.playerName ?? '').trim();
    const gameCode = (data.gameCode ?? '').toUpperCase().trim();

    if (!playerName) {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Player name is required'
      }));
      return;
    }

    if (!this.games.has(gameCode)) {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Game not found'
      }));
      return;
    }

    const game = this.games.get(gameCode);

    if (game.status !== 'lobby') {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Game has already started'
      }));
      return;
    }

    // Check for duplicate names
    for (const [, player] of game.players) {
      if (player.name.toLowerCase() === playerName.toLowerCase()) {
        ws.send(JSON.stringify({
          action: 'error',
          message: 'That name is already taken'
        }));
        return;
      }
    }

    const playerToken = this.generatePlayerToken();

    game.players.set(connectionId, {
      name: playerName,
      isHost: false,
      connection: ws,
      token: playerToken,
      connected: true
    });

    this.playerConnections.set(connectionId, gameCode);
    this.playerTokens.set(playerToken, { gameCode, connectionId });

    // Send confirmation to joining player
    ws.send(JSON.stringify({
      action: 'gameJoined',
      gameCode: gameCode,
      players: this.getPlayerList(gameCode),
      isHost: false,
      playerToken: playerToken
    }));

    // Broadcast updated player list to all players in the game
    this.broadcastToGame(gameCode, {
      action: 'playerListUpdate',
      players: this.getPlayerList(gameCode)
    });

    console.log(`Player ${playerName} joined game ${gameCode}`);
  }

  // ==================== GAME START ====================

  startGame(ws, data, connectionId) {
    const gameCode = this.playerConnections.get(connectionId);

    if (!gameCode || !this.games.has(gameCode)) {
      console.log('startGame: Game not found');
      return;
    }

    const game = this.games.get(gameCode);

    // Only host can start
    if (game.host !== connectionId) {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Only the host can start the game'
      }));
      return;
    }

    // Check game status
    if (game.status !== 'lobby') {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Game is not in lobby state'
      }));
      return;
    }

    const playerCount = game.players.size;

    if (playerCount < 5) {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Need at least 5 players to start'
      }));
      return;
    }

    // Assign roles
    const roles = this.assignRoles(gameCode);
    game.roles = roles;

    game.status = 'playing';
    game.round = 1;
    game.caseNotes = [];

    // Initialize ready states
    game.readyStates = new Map();
    for (const [resourceId] of game.players) {
      game.readyStates.set(resourceId, false);
    }

    const roleDescriptions = this.getRoleDescriptions();

    console.log(`Sending roleAssigned to ${playerCount} players`);

    // Send each player their role
    for (const [resourceId, player] of game.players) {
      const role = roles.get(resourceId) || 'Unknown';
      const teammates = [];

      if (role === 'Syndicate') {
        for (const [rid, r] of roles) {
          if (r === 'Syndicate' && rid !== resourceId) {
            teammates.push(game.players.get(rid).name);
          }
        }
      }

      if (player.connection) {
        player.connection.send(JSON.stringify({
          action: 'roleAssigned',
          role: role,
          description: roleDescriptions[role] || {},
          teammates: teammates,
          playerCount: playerCount,
          readyCount: 0,
          totalPlayers: playerCount
        }));
        console.log(`Sent roleAssigned to ${resourceId} with role ${role}`);
      }
    }

    console.log(`Game ${gameCode} started with ${playerCount} players`);
  }

  // ==================== ROLE ASSIGNMENT ====================

  assignRoles(gameCode) {
    const game = this.games.get(gameCode);
    const playerIds = Array.from(game.players.keys());
    const playerCount = playerIds.length;
    const roles = new Map();

    // Shuffle player IDs
    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    // Calculate role distribution
    const syndicateCount = Math.ceil(playerCount / 3);
    const innocentCount = playerCount - syndicateCount;

    // Assign Syndicate members
    for (let i = 0; i < syndicateCount; i++) {
      roles.set(playerIds[i], 'Syndicate');
    }

    // Assign innocents with optional roles
    let assignedDetective = false;
    let assignedEyewitness = false;
    let assignedBodyGuard = false;

    for (let i = syndicateCount; i < playerCount; i++) {
      let role = 'Innocent Bystander';

      if (!assignedDetective) {
        role = 'Detective';
        assignedDetective = true;
      } else if (game.settings.eyeWitness && !assignedEyewitness) {
        role = 'Eye Witness';
        assignedEyewitness = true;
      } else if (game.settings.bodyGuard && !assignedBodyGuard) {
        role = 'Body Guard';
        assignedBodyGuard = true;
      }

      roles.set(playerIds[i], role);
    }

    console.log(`Assigned roles for ${playerCount} players`);
    return roles;
  }

  getRoleDescriptions() {
    return {
      'Syndicate': {
        title: 'Syndicate Member',
        description: 'You are part of the secret criminal organization. Your goal is to eliminate all innocent citizens without being discovered.',
        abilities: [
          'Vote each night to select an assassin and target',
          'Know the identity of your fellow Syndicate members',
          'Blend in during the day and mislead investigations'
        ],
        winCondition: 'Eliminate enough players until Syndicate equals or outnumbers the Town'
      },
      'Detective': {
        title: 'Detective',
        description: 'You are a skilled investigator working to expose the Syndicate. Use your abilities wisely to uncover the truth.',
        abilities: [
          'Receive a secret keyword each round to communicate with the Eye Witness',
          'Share your findings during day discussions',
          'Lead the town to vote out Syndicate members'
        ],
        winCondition: 'Eliminate all Syndicate members'
      },
      'Innocent Bystander': {
        title: 'Innocent Bystander',
        description: 'You are an ordinary citizen caught in the crossfire. Stay vigilant and help identify the Syndicate through observation and deduction.',
        abilities: [
          'Vote during the day to eliminate suspected Syndicate members',
          'Observe player behavior and discussions',
          'Form alliances with other players'
        ],
        winCondition: 'Survive and help eliminate all Syndicate members'
      },
      'Eye Witness': {
        title: 'Eye Witness',
        description: 'You witnessed a crime and caught a glimpse of the underworld. You see who commits the assassination each round.',
        abilities: [
          'Learn the assassin\'s identity and their victim each round',
          'Receive a keyword to secretly signal the Detective',
          'Vote during the day like other citizens'
        ],
        winCondition: 'Survive and help eliminate all Syndicate members'
      },
      'Body Guard': {
        title: 'Body Guard',
        description: 'You are a professional protector. Each night, you can choose one player to shield from harm.',
        abilities: [
          'Protect one player each night from elimination',
          'Cannot protect yourself',
          'Cannot protect the same player two nights in a row'
        ],
        winCondition: 'Survive and help eliminate all Syndicate members'
      }
    };
  }

  // ==================== MESSAGE HANDLER ====================

  handleMessage(ws, msg, connectionId) {
    let data;
    try {
      data = JSON.parse(msg.toString('utf8'));
    } catch (e) {
      console.error('Invalid JSON:', msg.toString('utf8'));
      return;
    }

    const action = data.action;

    console.log(`Message from ${connectionId}: ${action}`);

    switch (action) {
      case 'createGame':
        this.createGame(ws, data, connectionId);
        break;
      case 'joinGame':
        this.joinGame(ws, data, connectionId);
        break;
      case 'startGame':
        this.startGame(ws, data, connectionId);
        break;
      case 'playerReady':
        this.playerReady(ws, data, connectionId);
        break;
      case 'leaveGame':
        this.leaveGame(ws, data, connectionId);
        break;
      case 'removePlayer':
        this.removePlayer(ws, data, connectionId);
        break;
      default:
        console.log('Unknown action:', action);
    }
  }

  // ==================== PLAYER MANAGEMENT ====================

  playerReady(ws, data, connectionId) {
    const gameCode = this.playerConnections.get(connectionId);
    if (!gameCode || !this.games.has(gameCode)) return;

    const game = this.games.get(gameCode);
    const readyStates = game.readyStates || new Map();
    readyStates.set(connectionId, true);

    const readyCount = Array.from(readyStates.values()).filter(v => v).length;
    const totalPlayers = game.players.size;

    this.broadcastToGame(gameCode, {
      action: 'readyUpdate',
      readyCount: readyCount,
      totalPlayers: totalPlayers
    });

    console.log(`Player ${connectionId} ready: ${readyCount}/${totalPlayers}`);
  }

  leaveGame(ws, data, connectionId) {
    const gameCode = this.playerConnections.get(connectionId);
    if (!gameCode || !this.games.has(gameCode)) return;

    const game = this.games.get(gameCode);
    const player = game.players.get(connectionId);

    if (!player) return;

    console.log(`Player ${player.name} left game ${gameCode}`);

    // If player is host, delete the game
    if (game.host === connectionId) {
      this.broadcastToGame(gameCode, {
        action: 'error',
        message: 'Host left the game. Game ended.'
      });
      this.games.delete(gameCode);
    } else {
      // Just remove the player
      game.players.delete(connectionId);
      this.broadcastToGame(gameCode, {
        action: 'playerListUpdate',
        players: this.getPlayerList(gameCode)
      });
    }

    this.playerConnections.delete(connectionId);
  }

  removePlayer(ws, data, connectionId) {
    const gameCode = this.playerConnections.get(connectionId);
    if (!gameCode || !this.games.has(gameCode)) return;

    const game = this.games.get(gameCode);

    // Only host can remove
    if (game.host !== connectionId) {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Only host can remove players'
      }));
      return;
    }

    const targetId = data.targetId;
    const targetPlayer = game.players.get(targetId);

    if (!targetPlayer) {
      ws.send(JSON.stringify({
        action: 'error',
        message: 'Player not found'
      }));
      return;
    }

    console.log(`Host removed player ${targetPlayer.name} from game ${gameCode}`);

    game.players.delete(targetId);
    this.playerConnections.delete(targetId);

    if (targetPlayer.connection) {
      targetPlayer.connection.send(JSON.stringify({
        action: 'removedFromGame',
        message: 'You were removed from the game by the host'
      }));
    }

    this.broadcastToGame(gameCode, {
      action: 'playerListUpdate',
      players: this.getPlayerList(gameCode)
    });
  }

  onPlayerDisconnect(connectionId) {
    const gameCode = this.playerConnections.get(connectionId);
    if (!gameCode || !this.games.has(gameCode)) return;

    const game = this.games.get(gameCode);
    const player = game.players.get(connectionId);

    if (!player) return;

    console.log(`Player ${player.name} disconnected from game ${gameCode}`);

    // Mark as disconnected but keep in game
    player.connected = false;

    this.broadcastToGame(gameCode, {
      action: 'playerDisconnected',
      playerId: connectionId,
      playerName: player.name
    });
  }
}

module.exports = GameServer;
