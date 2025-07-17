const socket = io('https://orange-halibut-9675jr46x9h799j-3000.app.github.dev/'); // Update to deployed URL later

function register() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  fetch('https://orange-halibut-9675jr46x9h799j-3000.app.github.dev/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  }).then(res => res.json()).then(data => {
    if (data.token) {
      localStorage.setItem('token', data.token);
      initGame();
    } else alert(data.error);
  });
}

function login() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  fetch('https://orange-halibut-9675jr46x9h799j-3000.app.github.dev/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  }).then(res => res.json()).then(data => {
    if (data.token) {
      localStorage.setItem('token', data.token);
      initGame();
    } else alert(data.error);
  });
}

function initGame() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('chat').style.display = 'block';

  // Moved Phaser code inside initGame
  class GalaxyScene extends Phaser.Scene {
    constructor() {
      super('Galaxy');
    }

    preload() {
      // Load backgrounds or node icons if needed
    }

    create() {
      // Draw starry background
      this.add.image(0, 0, 'stars').setOrigin(0,0).setScale(2); // Placeholder - add asset later

      // Placeholder systems: Hardcode 5 nodes for test
      const systems = [
        { id: '1', x: 200, y: 200, name: 'Safe Zone' },
        { id: '2', x: 400, y: 300, name: 'Mining Zone' },
        // Add 3 more...
      ];

      const graphics = this.add.graphics({ lineStyle: { width: 2, color: 0xffffff } });
      // Draw connections (lines)
      graphics.lineBetween(200, 200, 400, 300); // Example connection

      // Draw clickable nodes
      systems.forEach(sys => {
        const node = this.add.circle(sys.x, sys.y, 20, 0x00ff00).setInteractive();
        this.add.text(sys.x, sys.y + 30, sys.name, { fontSize: 16 });
        node.on('pointerdown', () => {
          socket.emit('joinSystem', sys.id);
          this.scene.start('System');
        });
      });

      // Zoom (wheel input)
      this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY, deltaZ) => {
        const zoom = this.cameras.main.zoom - deltaY * 0.001;
        this.cameras.main.setZoom(Phaser.Math.Clamp(zoom, 0.5, 2)); // Clamp min/max
        pointer.event.preventDefault(); // Stop page scroll
      });
      this.input.keyboard.enabled = false; // Optional if keys
    }
  }

  class SystemScene extends Phaser.Scene {
    constructor() {
      super('System');
    }

    preload() {
      this.load.image('destroyer', 'assets/destroyer.png');
    }

    create() {
      this.otherShips = new Map(); // Key: playerId, Value: sprite

      // Background
      this.add.image(400, 300, 'stars').setOrigin(0.5);

      // Player ship
      this.playerShip = this.add.sprite(400, 300, 'destroyer').setScale(0.5).setInteractive();
      this.playerShip.setDepth(1); // Above bg

      // Tap to move (time-based tween)
      this.input.on('pointerdown', (pointer) => {
        const duration = Phaser.Math.Distance.Between(this.playerShip.x, this.playerShip.y, pointer.x, pointer.y) * 5; // Time based on distance
        this.tweens.add({
          targets: this.playerShip,
          x: pointer.x,
          y: pointer.y,
          duration: duration,
          onComplete: () => socket.emit('move', { x: pointer.x, y: pointer.y }) // Send to server
        });
      });

      // Handle other players entering
      socket.on('playerEntered', (data) => {
        if (data.id !== socket.id) { // Not self
          const otherShip = this.add.sprite(100, 100, 'destroyer').setScale(0.5); // Start pos from server later
          this.otherShips.set(data.id, otherShip);
        }
      });

      // Handle other player movements
      socket.on('playerMoved', (data) => {
        const otherShip = this.otherShips.get(data.id);
        if (otherShip) {
          const duration = Phaser.Math.Distance.Between(otherShip.x, otherShip.y, data.x, data.y) * 5;
          this.tweens.add({
            targets: otherShip,
            x: data.x,
            y: data.y,
            duration: duration
          });
        }
      });
    }
  }

  const config = {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    scene: [GalaxyScene, SystemScene],
    parent: 'game-container' // Changed from 'phaser-container'
  };

  socket.auth = { token: localStorage.getItem('token') };
  socket.connect();

  socket.on('chatHistory', (data) => {
    const messagesDiv = document.getElementById('messages');
    data.messages.forEach(msg => {
      messagesDiv.innerHTML += `<p>[${data.type}] ${msg.from}: ${msg.message}</p>`;
    });
  });

  socket.on('newChat', (data) => {
    const messagesDiv = document.getElementById('messages');
    messagesDiv.innerHTML += `<p>[${data.type}] ${data.from}: ${data.message}</p>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  });

  const game = new Phaser.Game(config);

  // Show game container after game starts
  document.getElementById('game-container').style.display = 'block';
}

function sendGlobalChat() {
  const message = document.getElementById('message').value;
  socket.emit('sendChat', { type: 'global', message });
  document.getElementById('message').value = '';
}