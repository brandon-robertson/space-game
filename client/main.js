let socket; // Make socket global
let myPlayerId; // Global var for your _id

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
  fetch('https://orange-halibut-9675jr46x9h799j-3000.app.github.dev/login', { // <-- FULL URL
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  .then(res => res.json())
  .then(data => {
    if (data.token) {
      localStorage.setItem('token', data.token); // Store token for socket
      document.getElementById('login-container').style.display = 'none';
      document.getElementById('game-container').style.display = 'block';
      initGame(data.token, username);
    } else {
      alert(data.error || 'Login failed');
    }
  });
}

function initGame() {
  document.getElementById('login-container').style.display = 'none';
  document.getElementById('game-container').style.display = 'block'; // <-- Place here
  document.getElementById('chat').style.display = 'block';

  // Create socket with auth
  socket = io('https://orange-halibut-9675jr46x9h799j-3000.app.github.dev/', {
    auth: { token: localStorage.getItem('token') }
  });

  socket.on('connect_error', (err) => {
    alert('Connection error: ' + err.message); // Show alert on connect error
    console.error('Socket connect error:', err.message); // For debugging
  });

  socket.on('connect', () => {
    console.log('Socket connected successfully');
    // Fetch your playerId from server - add API route later, but for now assume sent on connect
  });

  socket.on('playerInfo', (data) => {
    myPlayerId = data.playerId;
    console.log('Received myPlayerId:', myPlayerId);
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
      this.load.image('destroyer', 'assets/destroyer.png');
      this.load.image('stars', 'assets/stars.png'); // Add stunning space BG
      this.load.image('planet', 'assets/planet.png');  // Loads the glowing planet image
    }

    create() {
      // Remove any duplicate background image adds!
      this.bg = this.add.tileSprite(
        0, 0,
        this.sys.game.config.width,
        this.sys.game.config.height,
        'stars'
).setOrigin(0, 0).setDepth(0);

      // Stunning particles: Nebula/stars
      const centerX = this.sys.game.config.width / 2;
const centerY = this.sys.game.config.height / 2;
const particles = this.add.particles(centerX, centerY, 'stars', {
  speed: { min: -10, max: 10 },
  scale: { start: 0.1, end: 0 },
  blendMode: 'ADD',
  frequency: 100,
  lifespan: 5000,
  quantity: 1,
  emitting: true
});
particles.setDepth(0); // BG layer

      let downX = 0, downY = 0;

      this.otherShips = new Map();
      this.justAttacked = false;
      this.pendingAttackTarget = null;

      // Player ship
      this.playerShip = this.add.sprite(400, 300, 'destroyer');
      this.playerShip.setTint(0xbbffbb);
      this.playerShip.setScale(0.1).setInteractive();
      this.playerShip.isOwnShip = true; // Flag to identify own ship - no
      this.playerShip.setDepth(1);

      // Health bar function
      function updateHealthBar(bar, x, y, shield, armor) {
        if (!bar) return; // Prevent error if healthBar is undefined
        bar.clear();
        shield = Math.max(shield, 0); // Min 0, no upper clamp needed if server caps
        armor = Math.max(armor, 0);
        bar.fillStyle(0x00ff00, 1);
        bar.fillRect(x - 25, y - 30, 50 * (shield / 100), 5);
        bar.fillStyle(0xff0000, 1);
        bar.fillRect(x - 25, y - 25, 50 * (armor / 100), 5);
      }

      this.playerHealthBar = this.add.graphics();
      updateHealthBar(this.playerHealthBar, this.playerShip.x, this.playerShip.y, 100, 100);

      // Update health bar position each frame for player and others
      this.events.on('update', () => {
        updateHealthBar(this.playerHealthBar, this.playerShip.x, this.playerShip.y, 100, 100);
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
        updateHealthBar(this.playerHealthBar, this.playerShip.x, this.playerShip.y, 100, 100);
        data.existingPlayers.forEach(p => {
          if (!this.otherShips.has(p.id)) {
            const otherShip = this.add.sprite(p.x, p.y, 'destroyer').setScale(0.1).setInteractive();
            otherShip.playerId = p.id; // Ensure set
            otherShip.shield = 100;
            otherShip.armor = 100;
            otherShip.healthBar = this.add.graphics();
            updateHealthBar(otherShip.healthBar, p.x, p.y, otherShip.shield, otherShip.armor);
            this.otherShips.set(p.id, otherShip);
            console.log('Added other ship with playerId:', p.id); // Debug:
          }
        });
        // Mining nodes
        data.resources.forEach(r => {
          console.log('Creating mining node:', r.id, 'active:', r.active);
          let nodeColor = r.active ? 0xffff00 : 0x555555; // Yellow if active, gray if not
          const node = this.add.circle(r.position.x, r.position.y, 30, nodeColor);
          if (r.active) {
            node.setInteractive();
            node.on('pointerdown', () => {
              console.log('Starting mining on active node:', r.id);
              socket.emit('startMining', { nodeId: r.id });
              // Progress bar code remains the same...
              const progressBar = this.add.graphics();
              progressBar.fillStyle(0x00ff00, 1);
              progressBar.fillRect(r.position.x - 25, r.position.y - 40, 0, 5);

              const timer = this.time.addEvent({
                delay: 10000,
                callback: () => {
                  progressBar.destroy();
                },
                loop: false
              });

              const updateProgress = () => {
                if (!progressBar.scene) return;
                const progress = 1 - (timer.getRemaining() / 10000);
                progressBar.clear();
                progressBar.fillStyle(0x00ff00, 1);
                progressBar.fillRect(r.position.x - 25, r.position.y - 40, 50 * progress, 5);
                if (progress < 1) {
                  progressBar.scene.time.delayedCall(16, updateProgress);
                }
              };
              updateProgress();
            });
          }
        });

        // Planets rendering - glowing images with interactions
        data.planets.forEach(p => {
          const planet = this.add.image(p.position.x, p.position.y, 'planet')
            .setScale(0.065) // 25% of original size (adjust as needed)
            .setInteractive()
            .setDepth(1);
          planet.postFX.addGlow(0x00ffff, 4, 1, false, 2, 16); // More outward, smoother
          if (!p.base) {
            planet.on('pointerdown', () => {
              socket.emit('buildBase', { planetId: p.id });
              // Stunning build particles - quick burst for snappy visual
              const emitter = this.add.particles(p.position.x, p.position.y, 'stars', { speed: 200, lifespan: 1000, blendMode: 'ADD', scale: { start: 1, end: 0 } });
              emitter.explode(50);  // Explodes particles instantly
            });
          } else {
            planet.on('pointerdown', () => socket.emit('dockBase', { planetId: p.id }));
          }
        });
      });

      // Player entered
      socket.on('playerEntered', (data) => {
        if (!this.otherShips.has(data.id)) {
          const otherShip = this.add.sprite(data.x, data.y, 'destroyer').setScale(0.1).setInteractive();
          otherShip.playerId = data.id;
          otherShip.shield = 100;
          otherShip.armor = 100;
          otherShip.healthBar = this.add.graphics();
          updateHealthBar(otherShip.healthBar, data.x, data.y, otherShip.shield, otherShip.armor);
          this.otherShips.set(data.id, otherShip);
          console.log('Player entered: Added ship with playerId:', data.id);
        }
      });

      // Player start move
      socket.on('playerStartMove', (data) => {
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
        if (data.id === myPlayerId && this.pendingAttackTarget) {
          const targetShip = this.otherShips.get(this.pendingAttackTarget);
          if (!targetShip) {
            console.warn('Target ship not found for attack:', this.pendingAttackTarget);
            // Optionally: retry after a short delay
            // setTimeout(() => socket.emit('attack', { targetId: this.pendingAttackTarget }), 100);
            return;
          }
          const dx = targetShip.x - this.playerShip.x;
          const dy = targetShip.y - this.playerShip.y;
          const dist = Math.hypot(dx, dy);
          const attackRange = 250;
          if (dist <= attackRange + 10) {
            console.log('Emitting attack event to server:', this.pendingAttackTarget);
            socket.emit('attack', { targetId: this.pendingAttackTarget });
            this.pendingAttackTarget = null;
            this.justAttacked = false; // <-- Add this line (optional)
          }
        }
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
          otherShip.healthBar.destroy();
          otherShip.destroy();
          this.otherShips.delete(data.id);
        }
      });

      // Player destroyed
      socket.on('playerDestroyed', (data) => {
        const destroyedShip = this.otherShips.get(data.id);
        if (destroyedShip) {
          destroyedShip.healthBar.destroy();
          destroyedShip.destroy();
          this.otherShips.delete(data.id);
          console.log('Removed destroyed ship:', data.id);
        }
      });

      // If victim rejoins same system later, 'playerEntered'

      // Tap to move with drag filter
      let lastPointerDown = 0;
      this.input.on('pointerdown', (pointer) => {
        const now = this.time.now || Date.now();
        if (now - lastPointerDown < 200) return; // 200ms throttle
        lastPointerDown = now;
        downX = pointer.x;
        downY = pointer.y;
      });

      this.input.on('gameobjectdown', (pointer, gameObject) => {
        console.log('Clicked game object:', gameObject.texture ? gameObject.texture.key : 'unknown', 'playerId:', gameObject.playerId, 'isOwnShip:', gameObject.isOwnShip);
        if (gameObject.isOwnShip) {
          console.log('Clicked own ship - ignoring attack');
          return;
        }
        if (gameObject.playerId && this.otherShips.has(gameObject.playerId)) {
          const now = Date.now();
          if (this.isAttacking || now - this.lastClickTime < 500) {
            console.log('Attack in progress or debounced - ignoring');
            return;
          }
          this.lastClickTime = now;
          if (now - this.attackCooldown < 5000) {
            console.log('Attack on cooldown - ignoring (no move)');
            alert('Weapon on cooldown!');
            return;
          }
          this.isAttacking = true;
          this.selectedTarget = gameObject.playerId;
          const targetShip = this.otherShips.get(this.selectedTarget);
          if (targetShip) {
            const dx = targetShip.x - this.playerShip.x; // Fixed: target - player for towards
            const dy = targetShip.y - this.playerShip.y;
            const dist = Math.hypot(dx, dy);
            console.log('Initial dist:', dist, 'Player pos:', this.playerShip.x, this.playerShip.y, 'Target pos:', targetShip.x, targetShip.y); // Debug pos
            const attackRange = 250; // Match server, gap for sprites
            if (dist > attackRange) {
              this.justAttacked = true;
              this.pendingAttackTarget = this.selectedTarget;
              const moveDist = dist - attackRange;
              const normX = dx / dist;
              const normY = dy / dist;
              const stopX = this.playerShip.x + normX * moveDist;
              const stopY = this.playerShip.y + normY * moveDist;
              console.log('Stop point:', stopX, stopY, 'moveDist:', moveDist);
              socket.emit('startMove', { targetX: stopX, targetY: stopY });
              const duration = moveDist * 5;
              const angle = Phaser.Math.Angle.Between(this.playerShip.x, this.playerShip.y, stopX, stopY);
              this.playerShip.rotation = angle + Math.PI/2; // Adjust if ship points up
              this.tweens.add({
                targets: this.playerShip,
                rotation: angle + Math.PI/2, // Adjust as needed
                duration: 200
              });
              this.tweens.add({
                targets: this.playerShip,
                x: stopX,
                y: stopY,
                duration: duration,
                ease: 'Sine.easeInOut', // Smoother acceleration/deceleration
                onStart: () => {
                  this.playerShip.rotation = angle; // Instantly face direction
                  // Or for smooth rotation:
                  // this.tweens.add({ targets: this.playerShip, rotation: angle, duration: 200 });
                },
                onComplete: () => {
                  socket.emit('move', { x: stopX, y: stopY });
                  this.isAttacking = false;
                }
              });
            } else {
              socket.emit('attack', { targetId: this.selectedTarget });
              console.log('Already in range - Emitting attack on:', this.selectedTarget);
              this.isAttacking = false;
              this.justAttacked = true;
            }
          } else {
            this.isAttacking = false;
            this.attackCooldown = now - 5000;
          }
        } else {
          console.log('No valid target for attack - not in otherShips or no playerId');
        }
      });

      this.input.on('pointerup', (pointer) => {
        if (this.justAttacked) {
          this.justAttacked = false; // Reset for next click
          return;
        }
        const dist = Phaser.Math.Distance.Between(downX, downY, pointer.x, pointer.y);
        if (dist < 5) {
          socket.emit('startMove', { targetX: downX, targetY: downY });
          const duration = Phaser.Math.Distance.Between(this.playerShip.x, this.playerShip.y, downX, downY) * 5;
          this.tweens.add({
            targets: this.playerShip,
            x: downX,
            y: downY,
            duration: duration,
            onComplete: () => socket.emit('move', { x: downX, y: downY })
          });
        }
      });



      // Handle attacked event and update health bars
      socket.on('attacked', (data) => {
        console.log('Received attacked:', data);
        const isOwn = data.targetId === myPlayerId;
        const ship = isOwn ? this.playerShip : this.otherShips.get(data.targetId);
        if (ship) {
          ship.shield = data.targetShield;
          ship.armor = data.targetArmor;
          if (ship && ship.healthBar) {
            updateHealthBar(ship.healthBar, ship.x, ship.y, ship.shield, ship.armor);
          }

          const attackerShip = data.attackerId === myPlayerId ? this.playerShip : this.otherShips.get(data.attackerId);
          if (attackerShip && ship) {
            const beam = this.add.graphics();
            beam.lineStyle(2, 0xff0000);
            beam.strokeLineShape(new Phaser.Geom.Line(attackerShip.x, attackerShip.y, ship.x, ship.y));
            this.time.delayedCall(500, () => beam.destroy());
          }
        } else {
          console.log('Attacked ship not found - id:', data.targetId);
        }
        this.isAttacking = false; // Unlock after server
      });

      // Handle destroyed event for player
      socket.on('destroyed', () => {
        alert('Your ship was destroyed! Respawning in safe zone.');
        this.playerShip.setPosition(400, 300); // Example safe pos
        this.playerShip.shield = 100;
        this.playerShip.armor = 100;
        updateHealthBar(this.playerHealthBar, this.playerShip.x, this.playerShip.y, this.playerShip.shield, this.playerShip.armor);
      });

      socket.on('attackError', (data) => {
        alert(data.message); // Or show
        this.isAttacking = false; // Unlock on error
        this.attackCooldown = Date.now() - 5000; // Reset if server rejects (e.g.,
      });

      socket.on('miningError', (data) => {
        console.log('Mining error:', data.message);
        alert('Mining error: ' + data.message);
      });

      // Handle base built - log for now (add more visuals later if needed)
      socket.on('baseBuilt', ({ planetId, ownerId }) => {
        console.log('Base built on', planetId, 'by', ownerId);
        // Optional: Refresh system or add base icon on planet (for now, just log)
      });

      // Docked event - snappy modal popup for research
      socket.on('docked', ({ base }) => {
        // Create modal group for easy management
        const modalGroup = this.add.group();
        const overlay = this.add.rectangle(0, 0, this.cameras.main.width, this.cameras.main.height, 0x000000, 0.7).setOrigin(0).setInteractive().setDepth(10);
        const panel = this.add.rectangle(this.cameras.main.centerX, this.cameras.main.centerY, 400, 300, 0x111111, 0.9).setOrigin(0.5).setDepth(11);
        const title = this.add.text(this.cameras.main.centerX, this.cameras.main.centerY - 100, 'Docked at Base', { fontSize: 24 }).setOrigin(0.5).setDepth(11);
        const researchBtn = this.add.text(this.cameras.main.centerX, this.cameras.main.centerY, 'Research Hub (30s)', { fontSize: 20 }).setOrigin(0.5).setInteractive().setDepth(11);
        modalGroup.addMultiple([overlay, panel, title, researchBtn]);

        // Snappy fade-in animation (200ms quick tween)
        modalGroup.getChildren().forEach(child => { 
          child.alpha = 0;  // Start invisible
          this.tweens.add({ targets: child, alpha: 1, duration: 200, ease: 'Linear' });  // Fade in fast
        });

        // Click research button
        researchBtn.on('pointerdown', () => {
          socket.emit('research', { type: 'hub' });
          // Snappy fade-out (200ms, destroy after)
          this.tweens.add({ 
            targets: modalGroup.getChildren(), 
            alpha: 0, 
            duration: 200, 
            ease: 'Linear', 
            onComplete: () => modalGroup.destroy(true)  // Clean up
          });
        });
      });

      // Research complete - alert and add temporary place button
      socket.on('researchComplete', ({ type }) => {
        alert('Hub unlocked! Place in system.');
        // Add snappy place button (text for simple UI)
        const placeBtn = this.add.text(100, 100, 'Place Hub', { fontSize: 18 }).setInteractive().setDepth(2);
        placeBtn.on('pointerdown', () => {
          socket.emit('placeHub');
          placeBtn.destroy();  // Remove after click
        });
      });

      // System controlled - stunning pulse glow on background
      socket.on('systemControlled', ({ allianceId }) => {
        // Quick pulse tween on BG for visual feedback (snappy repeat)
        this.tweens.add({ 
          targets: this.bg, 
          alpha: 0.5, 
          duration: 500, 
          yoyo: true,  // Back to normal
          repeat: 3,   // Pulse 3 times
          ease: 'Sine.easeInOut'  // Smooth and quick
        });
      });

      // General error handler - alert messages from server
      socket.on('error', (msg) => {
        alert('Error from server: ' + msg);
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
      socket.off('attacked');
      socket.off('destroyed');
      socket.off('miningError');
      socket.off('baseBuilt');
      socket.off('docked');
      socket.off('researchComplete');
      socket.off('systemControlled');
      socket.off('error');
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

  socket.on('nodeDepleted', (data) => {
    console.log('Node depleted:', data.nodeId);
    // Find and gray out node - add node map if multiple
    // (You can implement a node map to track and update visuals
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