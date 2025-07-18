let socket; // Make socket global

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

  // Create socket with auth
  socket = io('https://orange-halibut-9675jr46x9h799j-3000.app.github.dev/', {
    auth: { token: localStorage.getItem('token') }
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connect error:', err.message); // For debugging
  });

  socket.on('connect', () => {
    console.log('Socket connected successfully');
  });

  // Moved Phaser code inside initGame
  class GalaxyScene extends Phaser.Scene {
    constructor() {
      super('Galaxy');
    }

    preload() {
      // Load backgrounds or node icons if needed
      this.load.image('destroyer', 'assets/destroyer.png'); // Preload destroyer globally
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
          // Start SystemScene first
          this.scene.start('System');
          // Wait for SystemScene to be created, then emit joinSystem
          this.scene.get('System').events.once('create', () => {
            socket.emit('joinSystem', sys.id);
          });
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
      // No need to load 'destroyer' again, loaded in GalaxyScene
    }

    create() {
      this.otherShips = new Map();

      // Background
      this.add.image(400, 300, 'stars').setOrigin(0.5);

      // Player ship
      this.playerShip = this.add.sprite(400, 300, 'destroyer').setScale(0.1).setInteractive();
      this.playerShip.setDepth(1);

      // Updated health bar function: draws both shield and armor bars
      function updateHealthBar(bar, x, y, shield, armor) {
        bar.clear();
        bar.fillStyle(0x00ff00, 1);
        bar.fillRect(x - 25, y - 10, 50 * (shield / 100), 5); // Green for shield
        bar.fillStyle(0xff0000, 1);
        bar.fillRect(x - 25, y - 5, 50 * (armor / 100), 5); // Red for armor
      }

      this.playerHealthBar = this.add.graphics();
      updateHealthBar(this.playerHealthBar, this.playerShip.x, this.playerShip.y, 100, 100); // Defaults

      // Update health bar position each frame for player
      this.events.on('update', () => {
        updateHealthBar(this.playerHealthBar, this.playerShip.x, this.playerShip.y, 100, 100); // Replace with actual stats
        // Update all other ships' health bars as well
        this.otherShips.forEach((ship) => {
          updateHealthBar(
            ship.healthBar,
            ship.x,
            ship.y,
            ship.shield || 100,
            ship.armor || 100
          );
        });
      });

      // System data (set own pos and create existing)
      socket.on('systemData', (data) => {
        this.playerShip.setPosition(data.myPos.x, data.myPos.y);
        updateHealthBar(this.playerHealthBar, this.playerShip.x, this.playerShip.y, 100, 100); // Replace with actual stats
        data.existingPlayers.forEach(p => {
          if (!this.otherShips.has(p.id)) {
            const otherShip = this.add.sprite(p.x, p.y, 'destroyer').setScale(0.3);
            otherShip.healthBar = this.add.graphics();
            updateHealthBar(otherShip.healthBar, p.x, p.y, p.shield || 100, p.armor || 100);
            this.otherShips.set(p.id, otherShip);
          }
        });
        // Mining nodes
        data.resources.forEach(r => {
          const node = this.add.circle(r.position.x, r.position.y, 30, 0xffff00).setInteractive();
          node.on('pointerdown', () => socket.emit('startMining', { nodeId: r.id }));
        });
      });

      // Player entered
      socket.on('playerEntered', (data) => {
        if (!this.otherShips.has(data.id)) {
          const otherShip = this.add.sprite(data.x, data.y, 'destroyer').setScale(0.3);
          otherShip.healthBar = this.add.graphics();
          updateHealthBar(otherShip.healthBar, data.x, data.y, data.shield || 100, data.armor || 100);
          this.otherShips.set(data.id, otherShip);
        }
      });

      // Player start move
      socket.on('playerStartMove', (data) => {
        console.log('Received playerStartMove:', data);
        const otherShip = this.otherShips.get(data.id);
        if (otherShip) {
          const duration = Phaser.Math.Distance.Between(otherShip.x, otherShip.y, data.targetX, data.targetY) * 5;
          this.tweens.add({
            targets: otherShip,
            x: data.targetX,
            y: data.targetY,
            duration: duration
          });
        }
      });

      // Player moved (snap)
      socket.on('playerMoved', (data) => {
        const otherShip = this.otherShips.get(data.id);
        if (otherShip) {
          otherShip.setPosition(data.x, data.y);
          updateHealthBar(
            otherShip.healthBar,
            data.x,
            data.y,
            otherShip.shield || 100,
            otherShip.armor || 100
          );
        }
      });

      // Player left
      socket.on('playerLeft', (data) => {
        const otherShip = this.otherShips.get(data.id);
        if (otherShip) {
          otherShip.destroy();
          this.otherShips.delete(data.id);
        }
      });

      // Tap to move with drag filter
      let downX, downY;
      this.input.on('pointerdown', (pointer) => {
        downX = pointer.x;
        downY = pointer.y;
      });

      this.input.on('pointerup', (pointer) => {
        const dist = Phaser.Math.Distance.Between(downX, downY, pointer.x, pointer.y);
        if (dist < 5) { // Only allow if not a drag
          socket.emit('startMove', { targetX: downX, targetY: downY }); // Use pointerdown coords!
          const duration = Phaser.Math.Distance.Between(this.playerShip.x, this.playerShip.y, downX, downY) * 5;
          this.tweens.add({
            targets: this.playerShip,
            x: downX,
            y: downY,
            duration: duration,
            onComplete: () => socket.emit('move', { x: downX, y: downY })
          });
        }
        // Ignore if mouse moved (drag/ghost prevention)
      });
    }

    shutdown() {
      this.otherShips.forEach(ship => ship.destroy());
      this.otherShips.clear();
      socket.off('playerEntered');
      socket.off('playerMoved');
      socket.off('playerStartMove');
      socket.off('playerLeft');
      socket.off('systemData');
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
    console.log('Received chatHistory:', data.type, data.messages.length, 'messages');
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

  socket.on('miningComplete', (data) => {
    console.log('Mining complete:', data.minerals, 'minerals');
    alert('Mined ' + data.minerals + ' minerals!');
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