import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- Firebase Setup & Cross-Tab/Cloud Handshake Transport ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'bistro-3d-default';
let firebaseConfig = null;
try {
    if (typeof __firebase_config !== 'undefined' && __firebase_config) {
        firebaseConfig = typeof __firebase_config === 'string' ? JSON.parse(__firebase_config) : __firebase_config;
    }
} catch (e) {
    firebaseConfig = null;
}

let db = null;
let auth = null;
let currentUser = null;
let syncTransport = 'NONE'; // 'CLOUD' or 'LOCAL_CHANNEL'
let localChannel = null;
let localRoomData = null;
let pendingPingSentAt = 0;
let handshakeCompleted = false;

async function initFirebase() {
    if (db && currentUser) {
        syncTransport = 'CLOUD';
        return true;
    }
    if (!firebaseConfig || !firebaseConfig.apiKey) {
        syncTransport = 'LOCAL_CHANNEL';
        return false;
    }
    try {
        const app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(auth, __initial_auth_token);
        } else {
            await signInAnonymously(auth);
        }
        currentUser = auth.currentUser;
        syncTransport = 'CLOUD';
        return true;
    } catch (err) {
        console.warn('Cloud Firebase unavailable, falling back to local browser channel:', err);
        syncTransport = 'LOCAL_CHANNEL';
        return false;
    }
}

// Online Co-op Room State
let coopRole = null; // 'HOST' or 'GUEST'
let roomCode = null;
let roomUnsubscribe = null;
let lastNetSyncTime = 0;
let remoteGuestPos = { x: -5, z: -8, rotY: 0, holding: null, holdingDishId: null };
let remoteGuestInputSeq = 0;
let processedGuestInputSeq = 0;
let lastNetworkSyncTime = 0;
let hostShiftStarted = false;
let activeRoleAssignments = null;

function getRoomDocRef(code) {
    return doc(db, 'artifacts', appId, 'public', 'data', 'rooms', code);
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let res = '';
    for (let i = 0; i < 6; i++) {
        res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
}

function updateHandshakeStatusUI(connected, pingMs = null, infoText = null) {
    const bar = document.getElementById('coop-handshake-bar');
    const pingBadge = document.getElementById('coop-ping-badge');
    const pingVal = document.getElementById('coop-ping-ms');
    const transportLabel = document.getElementById('coop-transport-label');
    const connStatus = document.getElementById('coop-conn-status');

    bar.classList.remove('hidden');
    const modeTag = syncTransport === 'CLOUD' ? 'Cloud Sync' : 'Browser Sync';

    if (infoText) {
        transportLabel.innerHTML = `<i class="fa-solid fa-link text-cyan-400 mr-1"></i> ${infoText} (${modeTag})`;
    }

    if (connected) {
        handshakeCompleted = true;
        connStatus.innerText = coopRole === 'HOST' ? 'Guest Handshake OK!' : `Connected (${roomCode})`;
        connStatus.className = 'text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    }

    if (pingMs !== null) {
        pingBadge.classList.remove('hidden');
        pingVal.innerText = `${Math.max(1, Math.round(pingMs))} ms`;
    }
}

async function sendPingHandshake() {
    if (!roomCode || !coopRole) return;
    pendingPingSentAt = performance.now();
    const pingPayload = {
        from: coopRole,
        ts: Date.now(),
        seq: Math.floor(Math.random() * 100000)
    };

    document.getElementById('coop-transport-label').innerHTML = `<i class="fa-solid fa-spinner fa-spin text-amber-400 mr-1"></i> Pinging ${coopRole === 'HOST' ? 'Guest' : 'Host'}...`;

    if (syncTransport === 'CLOUD' && db) {
        await updateDoc(getRoomDocRef(roomCode), { pingPacket: pingPayload }).catch(() => {});
    } else if (localChannel) {
        localChannel.postMessage({ type: 'PING', roomCode, payload: pingPayload });
    }
}

function handleIncomingPingPong(data) {
    if (!data) return;
    if (data.pingPacket && data.pingPacket.from !== coopRole) {
        const pongPayload = {
            from: coopRole,
            replyToSeq: data.pingPacket.seq,
            ts: Date.now()
        };
        if (syncTransport === 'CLOUD' && db) {
            updateDoc(getRoomDocRef(roomCode), { pongPacket: pongPayload }).catch(() => {});
        } else if (localChannel) {
            localChannel.postMessage({ type: 'PONG', roomCode, payload: pongPayload });
        }
        updateHandshakeStatusUI(true, null, `Handshake verified with ${data.pingPacket.from}`);
    }

    if (data.pongPacket && data.pongPacket.from !== coopRole && pendingPingSentAt > 0) {
        const rtt = performance.now() - pendingPingSentAt;
        pendingPingSentAt = 0;
        sound.playRegister();
        updateHandshakeStatusUI(true, rtt, `Handshake & Ping Verified`);
    }
}

function sendNetworkPacket(packet) {
    if (!roomCode || !coopRole) return;

    const envelope = {
        ...packet,
        from: coopRole,
        timestamp: Date.now()
    };

    if (syncTransport === 'CLOUD' && db) {
        const field = coopRole === 'HOST' ? 'hostPacket' : 'guestPacket';
        updateDoc(getRoomDocRef(roomCode), { [field]: envelope }).catch((err) => {
            console.warn('Co-op network update failed:', err);
        });
    } else if (localChannel) {
        localChannel.postMessage({ type: 'NETWORK_PACKET', roomCode, payload: envelope });
    }
}

function applyNetworkPlayerState(packet) {
    if (!packet?.players || !Array.isArray(packet.players)) return;

    packet.players.forEach((player) => {
        const staff = staffMembers.find((member) => member.controller === player.controller);
        if (!staff || !staff.mesh) return;

        staff.mesh.position.set(player.x, player.y, player.z);
        staff.mesh.rotation.y = player.rotationY;
        staff.holding = player.holding;
        staff.holdingDish = player.holdingDishId
            ? readyDishes.find((dish) => dish.id === player.holdingDishId) || null
            : null;
    });
}

function handleNetworkPacket(packet) {
    if (!packet || packet.from === coopRole) return;

    if (packet.type === 'PLAYER_STATE') {
        applyNetworkPlayerState(packet);
    } else if (packet.type === 'START_SHIFT') {
        hostShiftStarted = true;
        if (gameMode === 'COOP' && !isGameRunning && packet.roleAssignments) {
            startShift(packet.roleAssignments, false);
        }
    } else if (packet.type === 'INTERACTION') {
        const localController = coopRole === 'HOST' ? 'P1' : coopRole === 'GUEST' ? 'P2' : null;
        if (packet.controller !== localController) {
            triggerStaffInteraction(packet.controller);
        }
    } else if (packet.type === 'GUEST_READY') {
        if (coopRole === 'HOST') {
            updateHandshakeStatusUI(true, null, 'Guest Ready');
            if (hostShiftStarted && activeRoleAssignments) {
                sendNetworkPacket({
                    type: 'START_SHIFT',
                    roleAssignments: activeRoleAssignments
                });
            }
        }
    }
}

// --- Core Game Constants, Audio & Three.js Scene State ---
const ROLES = { CASHIER: 'CASHIER', COOK: 'COOK', FRONT: 'FRONT', SECURITY: 'SECURITY' };
const CONFIG = {
    PLAYER_SPEED: 7.5,
    AI_SPEED: 6.2,
    CUSTOMER_SPEED: 4.5,
    SPAWN_INTERVAL: 6.5,
    EAT_TIME: 7.0,
    SATISFACTION_DIRTY_PENALTY: 1.4
};

const MENU_ITEMS = [
    { id: 'burger', code: '1', name: 'Burger', price: 12, icon: 'fa-burger', color: 0xd97706, unlocked: true, unlockCost: 0, recipe: ['bun', 'patty', 'cheese', 'lettuce'] },
    { id: 'pizza', code: '2', name: 'Pizza', price: 16, icon: 'fa-pizza-slice', color: 0xef4444, unlocked: true, unlockCost: 0, recipe: ['dough', 'sauce', 'cheese', 'pepperoni'] },
    { id: 'hotdog', code: '3', name: 'Hotdog', price: 10, icon: 'fa-hotdog', color: 0xf59e0b, unlocked: true, unlockCost: 0, recipe: ['bun', 'sausage', 'sauce'] },
    { id: 'salad', code: '4', name: 'Salad', price: 11, icon: 'fa-leaf', color: 0x22c55e, unlocked: true, unlockCost: 0, recipe: ['lettuce', 'tomato', 'cheese'] },
    { id: 'steak', code: '5', name: 'Ribeye Steak', price: 28, icon: 'fa-drumstick-bite', color: 0x991b1b, unlocked: false, unlockCost: 60, recipe: ['steak_raw', 'butter', 'herb', 'tomato'] },
    { id: 'supreme', code: '6', name: 'Supreme Pie', price: 34, icon: 'fa-crown', color: 0x9333ea, unlocked: false, unlockCost: 95, recipe: ['dough', 'sauce', 'cheese', 'pepperoni', 'herb'] }
];

const INGREDIENTS = [
    { id: 'bun', key: '1', name: 'Bun', icon: 'fa-bread-slice', color: 'text-amber-300' },
    { id: 'patty', key: '2', name: 'Patty', icon: 'fa-circle', color: 'text-amber-700' },
    { id: 'cheese', key: '3', name: 'Cheese', icon: 'fa-cheese', color: 'text-yellow-400' },
    { id: 'lettuce', key: '4', name: 'Greens', icon: 'fa-leaf', color: 'text-emerald-400' },
    { id: 'dough', key: '5', name: 'Dough', icon: 'fa-compact-disc', color: 'text-orange-200' },
    { id: 'sauce', key: '6', name: 'Sauce', icon: 'fa-droplet', color: 'text-red-500' },
    { id: 'pepperoni', key: '7', name: 'Pepperoni', icon: 'fa-certificate', color: 'text-rose-500' },
    { id: 'sausage', key: '8', name: 'Frank', icon: 'fa-minus', color: 'text-orange-500' },
    { id: 'tomato', key: '9', name: 'Tomato', icon: 'fa-apple-whole', color: 'text-red-400' },
    { id: 'steak_raw', key: '0', name: 'Ribeye', icon: 'fa-bacon', color: 'text-rose-600' },
    { id: 'butter', key: '-', name: 'Butter', icon: 'fa-square', color: 'text-yellow-200' },
    { id: 'herb', key: '=', name: 'Herbs', icon: 'fa-seedling', color: 'text-lime-400' }
];

const SHOP_POWERUPS = [
    { id: 'speed_shoes', name: 'Turbo Sneakers', desc: '+30% Walk Speed for all staff', cost: 45, icon: 'fa-shoe-prints', color: 'text-cyan-400', purchased: false },
    { id: 'auto_bussers', name: 'Sanitizer Spray', desc: 'Reduces dirty table penalty by 50%', cost: 65, icon: 'fa-spray-can-sparkles', color: 'text-emerald-400', purchased: false },
    { id: 'vip_tips', name: 'Golden Tip Jar', desc: '+$6 bonus tip on every served dish', cost: 80, icon: 'fa-sack-dollar', color: 'text-amber-400', purchased: false },
    { id: 'sat_boost', name: 'Live Jazz Band', desc: 'Instantly restores +30% Satisfaction', cost: 50, icon: 'fa-music', color: 'text-pink-400', repeatable: true }
];

const HIREABLE_STAFF = [
    { id: 'hire_security', role: ROLES.SECURITY, name: 'Security Guard', desc: 'Patrols lounge & cuts dissatisfaction by 35%', cost: 75, icon: 'fa-shield-halved', color: 'text-blue-400', hired: false },
    { id: 'hire_cook', role: ROLES.COOK, name: 'Extra Cook (AI)', desc: 'Adds a second AI chef to cook orders faster', cost: 85, icon: 'fa-fire-burner', color: 'text-red-400', hired: false },
    { id: 'hire_front', role: ROLES.FRONT, name: 'Extra Front (AI)', desc: 'Adds an extra server to deliver food & clean tables', cost: 70, icon: 'fa-utensils', color: 'text-emerald-400', hired: false }
];

// --- Global Runtime State Variables ---
let gameMode = 'SOLO';
let isGameRunning = false;
let isPaused = false;
let audioMuted = false;
let cash = 0;
let satisfaction = 100;
let ordersServed = 0;
let spawnTimer = 1.5;
let nextCustomerId = 1;

let customers = [];
let tables = [];
let staffMembers = [];
let kitchenTickets = [];
let readyDishes = [];

let activePOSCustomer = null;
let posItemRungUp = false;
let posCurrentChange = 0;
let posCardProgress = 0;
let posCombo = 0;

let activeCookTicket = null;
let cookStepIndex = 0;
let cookPhase = 'PREP';
let cookHeatValue = 0;
let cookHeatDir = 1;

const keysPressed = {};

const POSITIONS = {
    ENTRANCE: new THREE.Vector3(-11, 0, 11),
    REGISTER_QUEUE: new THREE.Vector3(-8, 0, -4.5),
    REGISTER_STAFF: new THREE.Vector3(-8, 0, -7.8),
    COOK_STOVE: new THREE.Vector3(-1, 0, -7.8),
    PICKUP_COUNTER: new THREE.Vector3(5.5, 0, -7.8),
    TRASH_BIN: new THREE.Vector3(11.5, 0, -7.8)
};

const TABLE_COORDS = [
    { id: 'T1', x: -8.5, z: 2.5 },
    { id: 'T2', x: 0.5, z: 2.5 },
    { id: 'T3', x: 9.5, z: 2.5 },
    { id: 'T4', x: -8.5, z: 8.5 },
    { id: 'T5', x: 0.5, z: 8.5 },
    { id: 'T6', x: 9.5, z: 8.5 }
];

// --- Web Audio API Synthesizer ---
const sound = {
    ctx: null,
    playTone(freq, type, duration, vol = 0.12) {
        if (audioMuted) return;
        try {
            if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (this.ctx.state === 'suspended') this.ctx.resume();
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(vol, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch (e) {}
    },
    playRegister() { this.playTone(880, 'sine', 0.14); },
    playChaChing() {
        this.playTone(987.77, 'triangle', 0.12);
        setTimeout(() => this.playTone(1318.51, 'triangle', 0.25), 90);
    },
    playCook() { this.playTone(320, 'square', 0.12, 0.08); },
    playError() { this.playTone(180, 'sawtooth', 0.22, 0.12); }
};

// --- Keyboard Controls ---
window.addEventListener('keydown', (e) => {
    keysPressed[e.code] = true;
    if (!isGameRunning || isPaused) return;

    if (e.code === 'KeyB') {
        toggleShopModal();
        return;
    }
    if (e.code === 'Escape') {
        toggleShopModal(false);
        closeCookStation();
        activePOSCustomer = null;
        document.getElementById('pos-overlay').classList.add('hidden');
        return;
    }

    if (activePOSCustomer) {
        const unlocked = MENU_ITEMS.filter(m => m.unlocked);
        const matchedItem = unlocked.find(m => `Digit${m.code}` === e.code);
        if (matchedItem) {
            ringUpPOSItem(matchedItem);
            return;
        }
        if (e.code === 'Enter' || e.code === 'Space') {
            e.preventDefault();
            handlePOSConfirmKey();
        }
        return;
    }

    if (activeCookTicket) {
        if (cookPhase === 'PREP') {
            const ingMap = {
                Digit1: 'bun', Digit2: 'patty', Digit3: 'cheese', Digit4: 'lettuce',
                Digit5: 'dough', Digit6: 'sauce', Digit7: 'pepperoni', Digit8: 'sausage',
                Digit9: 'tomato', Digit0: 'steak_raw', Minus: 'butter', Equal: 'herb'
            };
            if (ingMap[e.code]) {
                handleCookIngredientClick(ingMap[e.code]);
            }
        } else if (cookPhase === 'GRILL' && (e.code === 'Space' || e.code === 'Enter')) {
            e.preventDefault();
            finishCookingDish();
        }
        return;
    }

    if (e.code === 'KeyE') {
        if (gameMode !== 'COOP' || coopRole === 'HOST') triggerStaffInteraction('P1');
        if (gameMode === 'COOP') sendNetworkPacket({ type: 'INTERACTION', controller: 'P1' });
    } else if (e.code === 'Enter') {
        if (gameMode !== 'COOP' || coopRole === 'GUEST') triggerStaffInteraction('P2');
        if (gameMode === 'COOP') sendNetworkPacket({ type: 'INTERACTION', controller: 'P2' });
    }
});

window.addEventListener('keyup', (e) => {
    keysPressed[e.code] = false;
});

// --- Roblox-Style Blocky Avatar Builder ---
function buildRobloxAvatar(torsoColor, hatColor = null) {
    const group = new THREE.Group();
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xfcd34d, roughness: 0.4 });
    const torsoMat = new THREE.MeshStandardMaterial({ color: torsoColor, roughness: 0.5 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 });

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.85, 0.42), pantsMat);
    leftLeg.position.set(-0.24, 0.425, 0);
    leftLeg.castShadow = true;
    group.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.85, 0.42), pantsMat);
    rightLeg.position.set(0.24, 0.425, 0);
    rightLeg.castShadow = true;
    group.add(rightLeg);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.0, 0.5), torsoMat);
    torso.position.y = 1.35;
    torso.castShadow = true;
    group.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.75), skinMat);
    head.position.y = 2.25;
    head.castShadow = true;
    group.add(head);

    // Classic Eyes
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.05), eyeMat);
    eyeL.position.set(-0.16, 2.32, 0.38);
    const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.05), eyeMat);
    eyeR.position.set(0.16, 2.32, 0.38);
    group.add(eyeL, eyeR);

    // Articulated Arms + Hands
    const makeArm = (xOffset) => {
        const pivot = new THREE.Group();
        pivot.position.set(xOffset, 1.75, 0);
        const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.72, 0.36), torsoMat);
        armMesh.position.y = -0.32;
        armMesh.castShadow = true;
        pivot.add(armMesh);

        const handMesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.34), skinMat);
        handMesh.position.y = -0.78;
        handMesh.castShadow = true;
        pivot.add(handMesh);
        group.add(pivot);
        return pivot;
    };

    const leftArm = makeArm(-0.7);
    const rightArm = makeArm(0.7);

    if (hatColor !== null) {
        const hat = new THREE.Mesh(
            new THREE.BoxGeometry(0.84, 0.32, 0.84),
            new THREE.MeshStandardMaterial({ color: hatColor, roughness: 0.4 })
        );
        hat.position.y = 2.75;
        hat.castShadow = true;
        group.add(hat);
    }

    return { group, leftArm, rightArm, leftLeg, rightLeg };
}

// --- Three.js 3D Bistro Environment ---
let scene = null;
let camera = null;
let renderer = null;
const clock = new THREE.Clock();

function init3D() {
    if (renderer) return;
    const container = document.getElementById('canvas-container');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 22, 23);
    camera.lookAt(0, 0, 1);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334155, 0.95);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfffbeb, 0.9);
    dirLight.position.set(14, 26, 16);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    scene.add(dirLight);

    // Floor Baseplate
    const floor = new THREE.Mesh(
        new THREE.BoxGeometry(34, 0.4, 26),
        new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.65 })
    );
    floor.position.y = -0.2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Back & Side Walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(34, 4.5, 0.6), wallMat);
    backWall.position.set(0, 2.25, -12.7);
    backWall.receiveShadow = true;
    scene.add(backWall);

    // Queue Floor Tiles
    for (let i = 0; i < 4; i++) {
        const tile = new THREE.Mesh(
            new THREE.BoxGeometry(1.3, 0.06, 1.3),
            new THREE.MeshStandardMaterial({ color: i === 0 ? 0xf59e0b : 0x475569 })
        );
        tile.position.set(POSITIONS.REGISTER_QUEUE.x, 0.03, POSITIONS.REGISTER_QUEUE.z + i * 1.65);
        tile.receiveShadow = true;
        scene.add(tile);
    }

    // Cashier Counter
    const registerCounter = new THREE.Mesh(
        new THREE.BoxGeometry(4.2, 1.3, 1.6),
        new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.45 })
    );
    registerCounter.position.set(-8, 0.65, -6.2);
    registerCounter.castShadow = true;
    registerCounter.receiveShadow = true;
    scene.add(registerCounter);

    // Cooking Stove
    const stove = new THREE.Mesh(
        new THREE.BoxGeometry(4.4, 1.3, 1.8),
        new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4 })
    );
    stove.position.set(-1, 0.65, -9.4);
    stove.castShadow = true;
    scene.add(stove);

    // Pickup Counter
    const pickupCounter = new THREE.Mesh(
        new THREE.BoxGeometry(4.4, 1.3, 1.8),
        new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.4 })
    );
    pickupCounter.position.set(5.5, 0.65, -9.4);
    pickupCounter.castShadow = true;
    scene.add(pickupCounter);

    // Trash Bin Station
    const trashBin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.85, 0.7, 1.5, 12),
        new THREE.MeshStandardMaterial({ color: 0x9333ea, roughness: 0.5 })
    );
    trashBin.position.set(12, 0.75, -9.2);
    trashBin.castShadow = true;
    scene.add(trashBin);

    // Decorative Potted Plants (Roblox Blocky Style)
    const plantCoords = [
        { x: -15.2, z: -11.0 },
        { x: 15.2, z: -11.0 },
        { x: 15.2, z: 11.0 },
        { x: -15.2, z: 4.5 },
        { x: -3.2, z: 4.5 },
        { x: 6.5, z: -4.5 }
    ];
    plantCoords.forEach(pc => {
        const plantGroup = new THREE.Group();
        plantGroup.position.set(pc.x, 0, pc.z);

        const pot = new THREE.Mesh(
            new THREE.BoxGeometry(1.1, 0.9, 1.1),
            new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.6 })
        );
        pot.position.y = 0.45;
        pot.castShadow = true;
        pot.receiveShadow = true;
        plantGroup.add(pot);

        const soil = new THREE.Mesh(
            new THREE.BoxGeometry(0.95, 0.15, 0.95),
            new THREE.MeshStandardMaterial({ color: 0x292524 })
        );
        soil.position.y = 0.92;
        plantGroup.add(soil);

        const stem = new THREE.Mesh(
            new THREE.BoxGeometry(0.25, 0.9, 0.25),
            new THREE.MeshStandardMaterial({ color: 0x15803d })
        );
        stem.position.y = 1.35;
        stem.castShadow = true;
        plantGroup.add(stem);

        const foliageLower = new THREE.Mesh(
            new THREE.BoxGeometry(1.25, 0.75, 1.25),
            new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.5 })
        );
        foliageLower.position.y = 1.85;
        foliageLower.castShadow = true;
        plantGroup.add(foliageLower);

        const foliageTop = new THREE.Mesh(
            new THREE.BoxGeometry(0.85, 0.65, 0.85),
            new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.45 })
        );
        foliageTop.position.y = 2.45;
        foliageTop.castShadow = true;
        plantGroup.add(foliageTop);

        scene.add(plantGroup);
    });

    // Helper to build a Roblox-style dining chair
    const buildChair = (cx, cz, rotY) => {
        const chairGroup = new THREE.Group();
        chairGroup.position.set(cx, 0, cz);
        chairGroup.rotation.y = rotY;

        const woodMat = new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.5 });
        const cushionMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.4 });

        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.18, 0.95), cushionMat);
        seat.position.y = 0.68;
        seat.castShadow = true;
        chairGroup.add(seat);

        const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, 0.18), woodMat);
        backrest.position.set(0, 1.15, -0.38);
        backrest.castShadow = true;
        chairGroup.add(backrest);

        [[-0.36, -0.36], [0.36, -0.36], [-0.36, 0.36], [0.36, 0.36]].forEach(([lx, lz]) => {
            const cLeg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.64, 0.16), woodMat);
            cLeg.position.set(lx, 0.32, lz);
            cLeg.castShadow = true;
            chairGroup.add(cLeg);
        });

        return chairGroup;
    };

    // Dining Tables + Chairs
    TABLE_COORDS.forEach(tc => {
        const tableGroup = new THREE.Group();
        tableGroup.position.set(tc.x, 0, tc.z);

        const top = new THREE.Mesh(
            new THREE.BoxGeometry(2.8, 0.25, 2.2),
            new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.35 })
        );
        top.position.y = 1.15;
        top.castShadow = true;
        top.receiveShadow = true;
        tableGroup.add(top);

        const leg = new THREE.Mesh(
            new THREE.BoxGeometry(0.45, 1.1, 0.45),
            new THREE.MeshStandardMaterial({ color: 0x334155 })
        );
        leg.position.y = 0.55;
        tableGroup.add(leg);

        // Trash visual pile (shown when table is DIRTY)
        const trashPile = new THREE.Mesh(
            new THREE.BoxGeometry(0.75, 0.45, 0.75),
            new THREE.MeshStandardMaterial({ color: 0x7e22ce })
        );
        trashPile.position.set(0, 1.48, 0);
        trashPile.visible = false;
        tableGroup.add(trashPile);

        // Food plate visual (shown when customer is EATING)
        const foodPlate = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.4, 0.2, 12),
            new THREE.MeshStandardMaterial({ color: 0xf59e0b })
        );
        foodPlate.position.set(0, 1.38, 0);
        foodPlate.visible = false;
        tableGroup.add(foodPlate);

        // Add 2 chairs per table (left & right)
        tableGroup.add(buildChair(-1.85, 0, Math.PI / 2));
        tableGroup.add(buildChair(1.85, 0, -Math.PI / 2));

        scene.add(tableGroup);
        tables.push({
            id: tc.id,
            x: tc.x,
            z: tc.z,
            status: 'CLEAN', // 'CLEAN', 'OCCUPIED', 'WAITING_FOOD', 'EATING', 'DIRTY'
            customerId: null,
            mesh: tableGroup,
            trashMesh: trashPile,
            foodMesh: foodPlate
        });
    });

    window.addEventListener('resize', () => {
        if (!camera || !renderer) return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    animate();
}

// --- Single-File Queue Slot Helper (Prevents Customer Overlap) ---
function getQueueSlotPosition(slotIndex) {
    return new THREE.Vector3(
        POSITIONS.REGISTER_QUEUE.x,
        0,
        POSITIONS.REGISTER_QUEUE.z + slotIndex * 1.65
    );
}

function updateCustomerQueuePositions() {
    const queued = customers.filter(c => c.state === 'ENTERING' || c.state === 'QUEUED');
    queued.forEach((c, idx) => {
        c.targetPos = getQueueSlotPosition(idx);
    });
}

// --- Customer Entity Class ---
class Customer {
    constructor(id) {
        this.id = id;
        this.state = 'ENTERING'; // 'ENTERING', 'QUEUED', 'WALKING_TO_TABLE', 'WAITING_FOOD', 'EATING', 'LEAVING'
        this.order = null;
        this.payType = Math.random() < 0.55 ? 'CASH' : 'CARD';
        this.cashGiven = 20;
        this.tableId = null;
        this.eatTimer = CONFIG.EAT_TIME;
        this.walkCycle = 0;

        const shirtColors = [0x3b82f6, 0xec4899, 0x8b5cf6, 0x14b8a6, 0xf97316];
        const color = shirtColors[id % shirtColors.length];
        const rig = buildRobloxAvatar(color, null);
        this.mesh = rig.group;
        this.leftArm = rig.leftArm;
        this.rightArm = rig.rightArm;
        this.leftLeg = rig.leftLeg;
        this.rightLeg = rig.rightLeg;

        this.mesh.position.copy(POSITIONS.ENTRANCE);
        scene.add(this.mesh);

        this.targetPos = POSITIONS.REGISTER_QUEUE.clone();

        // World Speech Bubble
        this.bubbleEl = document.createElement('div');
        this.bubbleEl.className = 'world-bubble glass-panel px-2.5 py-1 rounded-xl text-xs font-bold text-white flex items-center gap-1.5 border border-white/20 shadow-lg';
        document.getElementById('bubbles-container').appendChild(this.bubbleEl);
    }

    update(dt) {
        const pos = this.mesh.position;
        const dx = this.targetPos.x - pos.x;
        const dz = this.targetPos.z - pos.z;
        const dist = Math.hypot(dx, dz);

        if (dist > 0.15) {
            const step = Math.min(dist, CONFIG.CUSTOMER_SPEED * dt);
            pos.x += (dx / dist) * step;
            pos.z += (dz / dist) * step;
            this.mesh.rotation.y = Math.atan2(dx, dz);

            // Walk limb animation
            this.walkCycle += dt * 10;
            const swing = Math.sin(this.walkCycle) * 0.55;
            this.leftArm.rotation.x = swing;
            this.rightArm.rotation.x = -swing;
            this.leftLeg.rotation.x = -swing;
            this.rightLeg.rotation.x = swing;
        } else {
            this.leftArm.rotation.x = 0;
            this.rightArm.rotation.x = 0;
            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;

            if (this.state === 'ENTERING') {
                this.state = 'QUEUED';
            } else if (this.state === 'WALKING_TO_TABLE') {
                this.state = 'WAITING_FOOD';
                const tbl = tables.find(t => t.id === this.tableId);
                if (tbl) tbl.status = 'WAITING_FOOD';
                this.bubbleEl.innerHTML = `<i class="fa-solid fa-clock text-amber-400"></i> <span>Waiting: ${this.order.name}</span>`;
            } else if (this.state === 'LEAVING') {
                this.destroy();
                return false;
            }
        }

        if (this.state === 'EATING') {
            this.eatTimer -= dt;
            this.rightArm.rotation.x = -0.8 + Math.sin(performance.now() * 0.01) * 0.35;
            if (this.eatTimer <= 0) {
                const tbl = tables.find(t => t.id === this.tableId);
                if (tbl) {
                    tbl.status = 'DIRTY';
                    tbl.customerId = null;
                    tbl.foodMesh.visible = false;
                    tbl.trashMesh.visible = true;
                }
                this.state = 'LEAVING';
                this.targetPos = POSITIONS.ENTRANCE.clone();
                this.bubbleEl.innerHTML = `<i class="fa-solid fa-smile text-emerald-400"></i> <span>Thanks!</span>`;
            }
        }

        this.updateBubbleScreenPos();
        return true;
    }

    updateBubbleScreenPos() {
        if (!camera) return;
        const worldPos = this.mesh.position.clone().add(new THREE.Vector3(0, 3.2, 0));
        worldPos.project(camera);
        const x = (worldPos.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-(worldPos.y * 0.5) + 0.5) * window.innerHeight;
        this.bubbleEl.style.left = `${x}px`;
        this.bubbleEl.style.top = `${y}px`;
    }

    destroy() {
        scene.remove(this.mesh);
        if (this.bubbleEl && this.bubbleEl.parentNode) {
            this.bubbleEl.parentNode.removeChild(this.bubbleEl);
        }
    }
}
// ... existing code ... -->
function spawnCustomer() {
    const cust = new Customer(nextCustomerId++);
    const unlockedMenu = MENU_ITEMS.filter(m => m.unlocked);
    cust.order = unlockedMenu[Math.floor(Math.random() * unlockedMenu.length)];
    if (cust.payType === 'CASH') {
        const roundedPrice = Math.ceil(cust.order.price / 5) * 5;
        cust.cashGiven = roundedPrice < cust.order.price ? cust.order.price + 5 : roundedPrice + 5;
    } else {
        cust.cashGiven = cust.order.price;
    }
    const payBadge = cust.payType === 'CASH'
        ? `<span class="text-[10px] bg-emerald-500/20 text-emerald-400 px-1 rounded border border-emerald-500/30">💵 Cash</span>`
        : `<span class="text-[10px] bg-cyan-500/20 text-cyan-400 px-1 rounded border border-cyan-500/30">💳 Card</span>`;
    cust.bubbleEl.innerHTML = `<i class="fa-solid ${cust.order.icon}"></i> <span>${cust.order.name} ($${cust.order.price})</span> ${payBadge}`;

    const lineCount = customers.filter(c => c.state === 'ENTERING' || c.state === 'QUEUED').length;
    cust.targetPos = getQueueSlotPosition(lineCount);
    customers.push(cust);
}

// --- Staff Spawning & Interactive Stations (POS, Cook, Front Area) ---
function createStaffMember(id, controller, role, offset = new THREE.Vector3()) {
    const roleColors = {
        [ROLES.CASHIER]: { torso: 0xf59e0b, hat: 0xd97706, spawn: POSITIONS.REGISTER_STAFF },
        [ROLES.COOK]: { torso: 0xef4444, hat: 0xffffff, spawn: POSITIONS.COOK_STOVE },
        [ROLES.FRONT]: { torso: 0x10b981, hat: 0x059669, spawn: new THREE.Vector3(4, 0, -3) },
        [ROLES.SECURITY]: { torso: 0x1e3a8a, hat: 0x172554, spawn: new THREE.Vector3(-4, 0, 5) }
    };
    const cfg = roleColors[role];
    const rig = buildRobloxAvatar(cfg.torso, cfg.hat);
    rig.group.position.copy(cfg.spawn).add(offset);
    scene.add(rig.group);

    const labelEl = document.createElement('div');
    labelEl.className = 'world-bubble px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-900/90 text-white border border-white/20';
    labelEl.innerText = `${controller} • ${role}`;
    document.getElementById('bubbles-container').appendChild(labelEl);

    return {
        id,
        controller,
        role,
        mesh: rig.group,
        leftArm: rig.leftArm,
        rightArm: rig.rightArm,
        leftLeg: rig.leftLeg,
        rightLeg: rig.rightLeg,
        holding: null, // 'DISH' or 'TRASH'
        holdingDish: null,
        walkCycle: 0,
        aiTimer: 0,
        patrolIdx: 0,
        labelEl
    };
}

function getFrontQueuedCustomer() {
    const queued = customers.filter(c => c.state === 'QUEUED' || c.state === 'ENTERING');
    if (queued.length === 0) return null;
    const front = queued[0];
    if (front.mesh.position.distanceTo(getQueueSlotPosition(0)) < 1.2) {
        return front;
    }
    return null;
}

function openPOSTerminal(customer) {
    const cleanTable = tables.find(t => t.status === 'CLEAN');
    if (!cleanTable) {
        sound.playError();
        return;
    }
    activePOSCustomer = customer;
    posItemRungUp = false;
    posCurrentChange = 0;
    posCardProgress = 0;

    document.getElementById('pos-overlay').classList.remove('hidden');
    document.getElementById('pos-target-item').innerHTML = `<i class="fa-solid ${customer.order.icon} text-amber-400 text-lg"></i> <span>${customer.order.name} ($${customer.order.price})</span>`;
    document.getElementById('pos-pay-type').innerText = customer.payType === 'CASH' ? 'CASH PAYMENT' : 'CARD PAYMENT';

    if (customer.payType === 'CASH') {
        document.getElementById('pos-cash-view').classList.remove('hidden');
        document.getElementById('pos-card-view').classList.add('hidden');
        const due = customer.cashGiven - customer.order.price;
        document.getElementById('pos-cash-total').innerText = `$${customer.order.price}`;
        document.getElementById('pos-cash-given').innerText = `$${customer.cashGiven}`;
        document.getElementById('pos-cash-due').innerText = `$${due}`;
        document.getElementById('pos-cash-current').innerText = `$0`;
    } else {
        document.getElementById('pos-cash-view').classList.add('hidden');
        document.getElementById('pos-card-view').classList.remove('hidden');
        document.getElementById('pos-card-status').innerText = 'Ring up item first, then Tap Card!';
        document.getElementById('pos-card-progress').style.width = '0%';
    }
}

function ringUpPOSItem(item) {
    if (!activePOSCustomer) return;
    if (item.id === activePOSCustomer.order.id) {
        posItemRungUp = true;
        sound.playRegister();
        if (activePOSCustomer.payType === 'CARD') {
            document.getElementById('pos-card-status').innerText = 'Item Verified! Tap Card Terminal [Enter]';
        }
    } else {
        sound.playError();
    }
}

function handlePOSConfirmKey() {
    if (!activePOSCustomer) return;
    if (!posItemRungUp) {
        // Auto-assist if player pressed Enter directly after ringing or allow quick ring
        sound.playError();
        return;
    }
    if (activePOSCustomer.payType === 'CASH') {
        const due = activePOSCustomer.cashGiven - activePOSCustomer.order.price;
        if (posCurrentChange === due) {
            completePOSTransaction(activePOSCustomer);
        } else {
            sound.playError();
        }
    } else {
        posCardProgress = 100;
        document.getElementById('pos-card-progress').style.width = '100%';
        completePOSTransaction(activePOSCustomer);
    }
}

function completePOSTransaction(customer) {
    const cleanTable = tables.find(t => t.status === 'CLEAN');
    if (!cleanTable) return;

    posCombo++;
    const comboBonus = posCombo >= 2 ? 3 : 0;
    cash += customer.order.price + comboBonus;
    sound.playChaChing();

    if (posCombo >= 2) {
        document.getElementById('pos-combo-badge').classList.remove('hidden');
        document.getElementById('pos-combo-count').innerText = `${posCombo}x`;
    }

    cleanTable.status = 'OCCUPIED';
    cleanTable.customerId = customer.id;
    customer.tableId = cleanTable.id;
    customer.state = 'WALKING_TO_TABLE';
    customer.targetPos = new THREE.Vector3(cleanTable.x - 1.35, 0, cleanTable.z);
    customer.bubbleEl.innerHTML = `<i class="fa-solid fa-chair text-cyan-300"></i> <span>Heading to ${cleanTable.id}</span>`;

    kitchenTickets.push({
        id: Date.now() + Math.random(),
        item: customer.order,
        tableId: cleanTable.id
    });

    activePOSCustomer = null;
    document.getElementById('pos-overlay').classList.add('hidden');
    updateCustomerQueuePositions();
    updateHUD(tables.filter(t => t.status === 'DIRTY').length);
}

// --- Interactive Cook Recipe & Grill Station ---
function openCookStation() {
    if (kitchenTickets.length === 0) {
        sound.playError();
        return;
    }
    activeCookTicket = kitchenTickets[0];
    cookStepIndex = 0;
    cookPhase = 'PREP';
    cookHeatValue = 0;
    cookHeatDir = 1;

    document.getElementById('cook-overlay').classList.remove('hidden');
    document.getElementById('cook-prep-view').classList.remove('hidden');
    document.getElementById('cook-grill-view').classList.add('hidden');
    document.getElementById('cook-queue-badge').innerText = `Tickets: ${kitchenTickets.length}`;
    document.getElementById('cook-dish-header').innerHTML = `<i class="fa-solid ${activeCookTicket.item.icon} text-amber-400 text-lg"></i> <span>${activeCookTicket.item.name} (${activeCookTicket.tableId})</span>`;

    renderCookRecipeSteps();
    renderCookIngredientButtons();
}

function closeCookStation() {
    activeCookTicket = null;
    document.getElementById('cook-overlay').classList.add('hidden');
}

function renderCookRecipeSteps() {
    if (!activeCookTicket) return;
    const stepsEl = document.getElementById('cook-recipe-steps');
    stepsEl.innerHTML = '';
    activeCookTicket.item.recipe.forEach((ingId, idx) => {
        const ing = INGREDIENTS.find(i => i.id === ingId);
        const done = idx < cookStepIndex;
        const current = idx === cookStepIndex;
        const badge = document.createElement('span');
        badge.className = `px-2 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 border ${
            done
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 line-through'
                : current
                ? 'bg-amber-500/20 text-amber-300 border-amber-400 animate-pulse'
                : 'bg-slate-800 text-slate-400 border-slate-700'
        }`;
        badge.innerHTML = `<i class="fa-solid ${ing.icon}"></i> ${ing.name}`;
        stepsEl.appendChild(badge);
    });
}

function renderCookIngredientButtons() {
    const grid = document.getElementById('cook-ingredients-grid');
    grid.innerHTML = '';
    INGREDIENTS.forEach(ing => {
        const btn = document.createElement('button');
        btn.className = 'flex items-center gap-1.5 p-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-bold text-white border border-slate-700 transition';
        btn.innerHTML = `<i class="fa-solid ${ing.icon} ${ing.color}"></i> <span>[${ing.key}] ${ing.name}</span>`;
        btn.addEventListener('click', () => handleCookIngredientClick(ing.id));
        grid.appendChild(btn);
    });
}

function handleCookIngredientClick(ingId) {
    if (!activeCookTicket || cookPhase !== 'PREP') return;
    const expectedId = activeCookTicket.item.recipe[cookStepIndex];
    if (ingId === expectedId) {
        cookStepIndex++;
        sound.playCook();
        renderCookRecipeSteps();
        if (cookStepIndex >= activeCookTicket.item.recipe.length) {
            cookPhase = 'GRILL';
            document.getElementById('cook-prep-view').classList.add('hidden');
            document.getElementById('cook-grill-view').classList.remove('hidden');
        }
    } else {
        sound.playError();
    }
}

function finishCookingDish() {
    if (!activeCookTicket) return;
    const ticket = kitchenTickets.shift();
    if (!ticket) return;

    // Perfect green zone check (65% - 90%)
    if (cookHeatValue >= 65 && cookHeatValue <= 90) {
        cash += 8;
        satisfaction = Math.min(100, satisfaction + 3);
        sound.playChaChing();
    } else {
        sound.playRegister();
    }

    spawnReadyDish(ticket);
    closeCookStation();
    updateHUD(tables.filter(t => t.status === 'DIRTY').length);
}

function spawnReadyDish(ticket) {
    const slotIdx = readyDishes.length;
    const dishMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.38, 0.22, 12),
        new THREE.MeshStandardMaterial({ color: ticket.item.color })
    );
    dishMesh.position.set(POSITIONS.PICKUP_COUNTER.x - 1.4 + slotIdx * 0.9, 1.42, -9.2);
    scene.add(dishMesh);

    readyDishes.push({
        id: ticket.id,
        item: ticket.item,
        tableId: ticket.tableId,
        mesh: dishMesh
    });
}

// --- Staff Interaction & Movement ---
function triggerStaffInteraction(controller) {
    const staff = staffMembers.find(s => s.controller === controller);
    if (!staff) return;

    const pos = staff.mesh.position;

    // Cashier Station
    if (pos.distanceTo(POSITIONS.REGISTER_STAFF) < 2.6) {
        const frontCust = getFrontQueuedCustomer();
        if (frontCust) {
            openPOSTerminal(frontCust);
            return;
        }
    }

    // Cooking Stove Station
    if (pos.distanceTo(POSITIONS.COOK_STOVE) < 2.6) {
        if (kitchenTickets.length > 0) {
            openCookStation();
            return;
        }
    }

    // Pickup Counter Station
    if (!staff.holding && pos.distanceTo(POSITIONS.PICKUP_COUNTER) < 2.6 && readyDishes.length > 0) {
        const dish = readyDishes.shift();
        scene.remove(dish.mesh);
        staff.holding = 'DISH';
        staff.holdingDish = dish;
        sound.playCook();
        return;
    }

    // Dining Tables (Serve Food or Clear Dirty Table)
    for (const tbl of tables) {
        const distToTable = Math.hypot(pos.x - tbl.x, pos.z - tbl.z);
        if (distToTable < 2.8) {
            if (staff.holding === 'DISH' && staff.holdingDish && staff.holdingDish.tableId === tbl.id) {
                staff.holding = null;
                staff.holdingDish = null;
                tbl.status = 'EATING';
                tbl.foodMesh.visible = true;
                const cust = customers.find(c => c.id === tbl.customerId);
                if (cust) {
                    cust.state = 'EATING';
                    cust.bubbleEl.innerHTML = `<i class="fa-solid fa-utensils text-emerald-400"></i> <span>Eating!</span>`;
                }
                ordersServed++;
                const tipUpgrade = SHOP_POWERUPS.find(p => p.id === 'vip_tips');
                if (tipUpgrade && tipUpgrade.purchased) cash += 6;
                satisfaction = Math.min(100, satisfaction + 4);
                sound.playChaChing();
                return;
            } else if (!staff.holding && tbl.status === 'DIRTY') {
                tbl.status = 'CLEAN';
                tbl.trashMesh.visible = false;
                staff.holding = 'TRASH';
                sound.playCook();
                return;
            }
        }
    }

    // Trash Bin Disposal
    if (staff.holding === 'TRASH' && pos.distanceTo(POSITIONS.TRASH_BIN) < 2.8) {
        staff.holding = null;
        satisfaction = Math.min(100, satisfaction + 2);
        sound.playRegister();
    }
}

function updatePlayerMovement(dt) {
    staffMembers.forEach(staff => {
        if (staff.controller !== 'P1' && staff.controller !== 'P2') return;
        if (gameMode === 'COOP' && coopRole === 'GUEST' && staff.controller === 'P1') return;
        if (gameMode === 'COOP' && coopRole === 'HOST' && staff.controller === 'P2') return;

        let vx = 0;
        let vz = 0;
        if (staff.controller === 'P1') {
            if (keysPressed['KeyW'] || (gameMode === 'SOLO' && keysPressed['ArrowUp'])) vz -= 1;
            if (keysPressed['KeyS'] || (gameMode === 'SOLO' && keysPressed['ArrowDown'])) vz += 1;
            if (keysPressed['KeyA'] || (gameMode === 'SOLO' && keysPressed['ArrowLeft'])) vx -= 1;
            if (keysPressed['KeyD'] || (gameMode === 'SOLO' && keysPressed['ArrowRight'])) vx += 1;
        } else if (staff.controller === 'P2') {
            if (keysPressed['ArrowUp']) vz -= 1;
            if (keysPressed['ArrowDown']) vz += 1;
            if (keysPressed['ArrowLeft']) vx -= 1;
            if (keysPressed['ArrowRight']) vx += 1;
        }

        if (vx !== 0 || vz !== 0) {
            const len = Math.hypot(vx, vz);
            vx /= len;
            vz /= len;
            staff.mesh.position.x = THREE.MathUtils.clamp(staff.mesh.position.x + vx * CONFIG.PLAYER_SPEED * dt, -15, 15);
            staff.mesh.position.z = THREE.MathUtils.clamp(staff.mesh.position.z + vz * CONFIG.PLAYER_SPEED * dt, -10.5, 11.5);
            staff.mesh.rotation.y = Math.atan2(vx, vz);

            staff.walkCycle += dt * 12;
            const swing = Math.sin(staff.walkCycle) * 0.6;
            staff.leftLeg.rotation.x = -swing;
            staff.rightLeg.rotation.x = swing;
            if (!staff.holding) {
                staff.leftArm.rotation.x = swing;
                staff.rightArm.rotation.x = -swing;
            }
        } else {
            staff.leftLeg.rotation.x = 0;
            staff.rightLeg.rotation.x = 0;
            if (!staff.holding) {
                staff.leftArm.rotation.x = 0;
                staff.rightArm.rotation.x = 0;
            }
        }

        if (staff.holding) {
            staff.leftArm.rotation.x = -1.2;
            staff.rightArm.rotation.x = -1.2;
        }
    });
}

function moveStaffToward(staff, targetVec, dt) {
    const pos = staff.mesh.position;
    const dx = targetVec.x - pos.x;
    const dz = targetVec.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.25) {
        const step = Math.min(dist, CONFIG.AI_SPEED * dt);
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        staff.mesh.rotation.y = Math.atan2(dx, dz);

        staff.walkCycle += dt * 10;
        const swing = Math.sin(staff.walkCycle) * 0.55;
        staff.leftLeg.rotation.x = -swing;
        staff.rightLeg.rotation.x = swing;
        if (!staff.holding) {
            staff.leftArm.rotation.x = swing;
            staff.rightArm.rotation.x = -swing;
        }
        return false;
    }
    staff.leftLeg.rotation.x = 0;
    staff.rightLeg.rotation.x = 0;
    if (staff.holding) {
        staff.leftArm.rotation.x = -1.2;
        staff.rightArm.rotation.x = -1.2;
    }
    return true;
}

function updateAIStaff(dt) {
    const extraCookExists = staffMembers.some(s => s.id === 'hired-cook');
    const extraFrontExists = staffMembers.some(s => s.id === 'hired-front');

    staffMembers.forEach(staff => {
        if (staff.controller !== 'AI') return;

        if (staff.role === ROLES.SECURITY) {
            const patrolPoints = [
                new THREE.Vector3(-6, 0, 6),
                new THREE.Vector3(0, 0, 4),
                new THREE.Vector3(6, 0, 4),
                new THREE.Vector3(0, 0, 9)
            ];
            const target = patrolPoints[staff.patrolIdx % patrolPoints.length];
            if (moveStaffToward(staff, target, dt)) {
                staff.aiTimer += dt;
                if (staff.aiTimer >= 1.5) {
                    staff.aiTimer = 0;
                    staff.patrolIdx++;
                }
            }
        } else if (staff.role === ROLES.CASHIER) {
            const arrived = moveStaffToward(staff, POSITIONS.REGISTER_STAFF, dt);
            const frontCust = getFrontQueuedCustomer();
            if (arrived && frontCust && tables.some(t => t.status === 'CLEAN')) {
                staff.aiTimer += dt;
                if (staff.aiTimer >= 1.6) {
                    staff.aiTimer = 0;
                    completePOSTransaction(frontCust);
                }
            } else {
                staff.aiTimer = 0;
            }
        } else if (staff.role === ROLES.COOK) {
            const stoveTarget = staff.id === 'hired-cook'
                ? POSITIONS.COOK_STOVE.clone().add(new THREE.Vector3(1.6, 0, 0))
                : POSITIONS.COOK_STOVE;
            const arrived = moveStaffToward(staff, stoveTarget, dt);
            const minTicketIndex = (staff.id === 'hired-cook' && kitchenTickets.length > 1) ? 1 : 0;
            if (arrived && kitchenTickets.length > minTicketIndex) {
                staff.aiTimer += dt;
                if (staff.aiTimer >= 2.8) {
                    staff.aiTimer = 0;
                    const ticket = kitchenTickets.splice(minTicketIndex, 1)[0];
                    if (ticket) {
                        sound.playCook();
                        spawnReadyDish(ticket);
                    }
                }
            } else {
                staff.aiTimer = 0;
            }
        } else if (staff.role === ROLES.FRONT) {
            if (staff.holding === 'TRASH') {
                if (moveStaffToward(staff, POSITIONS.TRASH_BIN, dt)) {
                    staff.holding = null;
                    satisfaction = Math.min(100, satisfaction + 2);
                }
            } else if (staff.holding === 'DISH' && staff.holdingDish) {
                const tbl = tables.find(t => t.id === staff.holdingDish.tableId);
                if (tbl && moveStaffToward(staff, new THREE.Vector3(tbl.x, 0, tbl.z - 1.5), dt)) {
                    staff.holding = null;
                    staff.holdingDish = null;
                    tbl.status = 'EATING';
                    tbl.foodMesh.visible = true;
                    const cust = customers.find(c => c.id === tbl.customerId);
                    if (cust) {
                        cust.state = 'EATING';
                        cust.bubbleEl.innerHTML = `<i class="fa-solid fa-utensils text-emerald-400"></i> <span>Eating!</span>`;
                    }
                    ordersServed++;
                    satisfaction = Math.min(100, satisfaction + 4);
                }
            } else if (readyDishes.length > 0 && !(staff.id === 'hired-front' && readyDishes.length === 1 && !extraFrontExists)) {
                const pickupSpot = staff.id === 'hired-front'
                    ? POSITIONS.PICKUP_COUNTER.clone().add(new THREE.Vector3(1.4, 0, 0))
                    : POSITIONS.PICKUP_COUNTER;
                if (moveStaffToward(staff, pickupSpot, dt)) {
                    const dish = readyDishes.shift();
                    if (dish) {
                        scene.remove(dish.mesh);
                        staff.holding = 'DISH';
                        staff.holdingDish = dish;
                    }
                }
            } else {
                const dirtyTables = tables.filter(t => t.status === 'DIRTY');
                const dirtyTbl = (staff.id === 'hired-front' && dirtyTables.length > 1) ? dirtyTables[1] : dirtyTables[0];
                if (dirtyTbl && moveStaffToward(staff, new THREE.Vector3(dirtyTbl.x, 0, dirtyTbl.z - 1.5), dt)) {
                    dirtyTbl.status = 'CLEAN';
                    dirtyTbl.trashMesh.visible = false;
                    staff.holding = 'TRASH';
                }
            }
        }
    });
}

function updateHUD(dirtyCount) {
    document.getElementById('hud-cash').innerText = `$${cash}`;
    const satRounded = Math.max(0, Math.round(satisfaction));
    document.getElementById('hud-satisfaction-val').innerText = `${satRounded}%`;
    document.getElementById('hud-satisfaction-bar').style.width = `${satRounded}%`;

    const dirtyAlert = document.getElementById('hud-dirty-alert');
    if (dirtyCount > 0) {
        dirtyAlert.classList.remove('hidden');
        document.getElementById('hud-dirty-count').innerText = `${dirtyCount} Dirty Table${dirtyCount > 1 ? 's' : ''}!`;
    } else {
        dirtyAlert.classList.add('hidden');
    }
}

function startShift(roleAssignments = null, broadcastStart = true) {
    init3D();

    // Clear old shift entities
    staffMembers.forEach(s => {
        scene.remove(s.mesh);
        if (s.labelEl && s.labelEl.parentNode) s.labelEl.parentNode.removeChild(s.labelEl);
    });
    customers.forEach(c => c.destroy());
    readyDishes.forEach(d => scene.remove(d.mesh));

    staffMembers = [];
    customers = [];
    kitchenTickets = [];
    readyDishes = [];
    activePOSCustomer = null;
    activeCookTicket = null;
    cash = 0;
    satisfaction = 100;
    ordersServed = 0;
    spawnTimer = 1.0;

    tables.forEach(t => {
        t.status = 'CLEAN';
        t.customerId = null;
        t.trashMesh.visible = false;
        t.foodMesh.visible = false;
    });

    HIREABLE_STAFF.forEach(h => {
        h.hired = false;
    });

    const cashierCtrl = roleAssignments?.cashier || document.getElementById('select-role-cashier').value;
    const cookCtrl = roleAssignments?.cook || document.getElementById('select-role-cook').value;
    const frontCtrl = roleAssignments?.front || document.getElementById('select-role-front').value;

    if (roleAssignments) {
        document.getElementById('select-role-cashier').value = cashierCtrl;
        document.getElementById('select-role-cook').value = cookCtrl;
        document.getElementById('select-role-front').value = frontCtrl;
    }

    activeRoleAssignments = { cashier: cashierCtrl, cook: cookCtrl, front: frontCtrl };

    staffMembers.push(createStaffMember('staff-cashier', cashierCtrl, ROLES.CASHIER));
    staffMembers.push(createStaffMember('staff-cook', cookCtrl, ROLES.COOK));
    staffMembers.push(createStaffMember('staff-front', frontCtrl, ROLES.FRONT));

    document.getElementById('lobby-modal').classList.add('hidden');
    document.getElementById('gameover-modal').classList.add('hidden');
    document.getElementById('top-hud').classList.remove('hidden');
    document.getElementById('bottom-hud').classList.remove('hidden');
    document.getElementById('game-mode-badge').innerText = gameMode === 'SOLO' ? 'SOLO SHIFT' : `ONLINE CO-OP (${roomCode || 'LOCAL'})`;

    const roleBadges = document.getElementById('hud-role-badges');
    roleBadges.innerHTML = `
        <span class="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[11px] font-bold">Cashier: ${cashierCtrl}</span>
        <span class="px-2.5 py-1 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 text-[11px] font-bold">Cook: ${cookCtrl}</span>
        <span class="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold">Front: ${frontCtrl}</span>
    `;

    isGameRunning = true;
    isPaused = false;
    sound.playRegister();
    spawnCustomer();

    if (gameMode === 'COOP' && broadcastStart) {
        if (coopRole === 'HOST') {
            hostShiftStarted = true;
            sendNetworkPacket({
                type: 'START_SHIFT',
                roleAssignments: { cashier: cashierCtrl, cook: cookCtrl, front: frontCtrl }
            });
        } else if (coopRole === 'GUEST') {
            sendNetworkPacket({ type: 'GUEST_READY' });
        }
    }
}

// --- Online Co-op Room Creation & Joining ---
async function createOnlineRoom() {
    await initFirebase();
    coopRole = 'HOST';
    roomCode = generateRoomCode();
    document.getElementById('host-room-code').innerText = roomCode;
    document.getElementById('host-room-code-box').classList.remove('hidden');
    updateHandshakeStatusUI(false, null, `Hosting Room ${roomCode}`);

    if (syncTransport === 'CLOUD' && db) {
        await setDoc(getRoomDocRef(roomCode), {
            hostJoined: true,
            guestJoined: false,
            createdAt: Date.now()
        });
        if (roomUnsubscribe) roomUnsubscribe();
        roomUnsubscribe = onSnapshot(getRoomDocRef(roomCode), (snap) => {
            const data = snap.data();
            if (!data) return;
            if (data.guestJoined) {
                updateHandshakeStatusUI(true, null, 'Guest Connected');
                if (hostShiftStarted && activeRoleAssignments) {
                    sendNetworkPacket({
                        type: 'START_SHIFT',
                        roleAssignments: activeRoleAssignments
                    });
                }
            }
            if (data.guestPacket) handleNetworkPacket(data.guestPacket);
            handleIncomingPingPong(data);
        });
    } else {
        if (localChannel) localChannel.close();
        localChannel = new BroadcastChannel(`bistro-room-${roomCode}`);
        localChannel.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === 'GUEST_JOIN') {
                updateHandshakeStatusUI(true, null, 'Guest Connected');
                localChannel.postMessage({ type: 'HOST_ACK', roomCode });
                if (hostShiftStarted && activeRoleAssignments) {
                    sendNetworkPacket({
                        type: 'START_SHIFT',
                        roleAssignments: activeRoleAssignments
                    });
                }
            } else if (msg.type === 'PING') {
                handleIncomingPingPong({ pingPacket: msg.payload });
            } else if (msg.type === 'PONG') {
                handleIncomingPingPong({ pongPacket: msg.payload });
            } else if (msg.type === 'NETWORK_PACKET') {
                handleNetworkPacket(msg.payload);
            } else if (msg.type === 'HOST_ACK') {
                updateHandshakeStatusUI(true, null, 'Guest Connected');
            }
        };
    }
}

async function joinOnlineRoom() {
    const inputCode = document.getElementById('input-join-code').value.trim().toUpperCase();
    if (inputCode.length < 4) {
        document.getElementById('coop-helper-text').innerText = 'Please enter a valid 6-character Room Code.';
        return;
    }
    await initFirebase();
    coopRole = 'GUEST';
    roomCode = inputCode;
    populateCoopRoleDropdowns();
    updateHandshakeStatusUI(false, null, `Connecting to ${roomCode}...`);

    if (syncTransport === 'CLOUD' && db) {
        const snap = await getDoc(getRoomDocRef(roomCode));
        if (!snap.exists()) {
            document.getElementById('coop-helper-text').innerText = `Room "${roomCode}" not found.`;
            return;
        }
        await updateDoc(getRoomDocRef(roomCode), { guestJoined: true });
        updateHandshakeStatusUI(true, null, `Joined Room ${roomCode}`);
        if (roomUnsubscribe) roomUnsubscribe();
        roomUnsubscribe = onSnapshot(getRoomDocRef(roomCode), (docSnap) => {
            const data = docSnap.data();
            if (data?.hostPacket) handleNetworkPacket(data.hostPacket);
            handleIncomingPingPong(data);
        });
    } else {
        if (localChannel) localChannel.close();
        localChannel = new BroadcastChannel(`bistro-room-${roomCode}`);
        localChannel.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === 'HOST_ACK') {
                updateHandshakeStatusUI(true, null, `Joined Room ${roomCode}`);
            } else if (msg.type === 'PING') {
                handleIncomingPingPong({ pingPacket: msg.payload });
            } else if (msg.type === 'PONG') {
                handleIncomingPingPong({ pongPacket: msg.payload });
            } else if (msg.type === 'NETWORK_PACKET') {
                handleNetworkPacket(msg.payload);
            }
        };
        localChannel.postMessage({ type: 'GUEST_JOIN', roomCode });
        updateHandshakeStatusUI(true, null, `Joined Room ${roomCode}`);
    }
}

function syncCoopPlayerState() {
    if (gameMode !== 'COOP' || !roomCode || !coopRole) return;

    const now = performance.now();
    if (now - lastNetworkSyncTime < 50) return;
    lastNetworkSyncTime = now;

    const localController = coopRole === 'HOST' ? 'P1' : 'P2';
    const players = staffMembers
        .filter((staff) => staff.controller === localController)
        .map((staff) => ({
            controller: staff.controller,
            x: staff.mesh.position.x,
            y: staff.mesh.position.y,
            z: staff.mesh.position.z,
            rotationY: staff.mesh.rotation.y,
            holding: staff.holding,
            holdingDishId: staff.holdingDish?.tableId || staff.holdingDish?.id || null
        }));

    if (players.length > 0) {
        sendNetworkPacket({ type: 'PLAYER_STATE', players });
    }
}

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);

    if (isGameRunning && !isPaused) {
        spawnTimer -= dt;
        if (spawnTimer <= 0 && customers.length < 7) {
            spawnCustomer();
            spawnTimer = CONFIG.SPAWN_INTERVAL;
        }

        updatePlayerMovement(dt);
        syncCoopPlayerState();
        updateAIStaff(dt);
        customers = customers.filter(c => c.update(dt));

        // Update Staff Floating Labels
        staffMembers.forEach(s => {
            if (!camera || !s.labelEl) return;
            const wp = s.mesh.position.clone().add(new THREE.Vector3(0, 3.1, 0));
            wp.project(camera);
            s.labelEl.style.left = `${(wp.x * 0.5 + 0.5) * window.innerWidth}px`;
            s.labelEl.style.top = `${(-(wp.y * 0.5) + 0.5) * window.innerHeight}px`;
        });

        // Grill Heat Meter Animation
        if (activeCookTicket && cookPhase === 'GRILL') {
            cookHeatValue += cookHeatDir * 58 * dt;
            if (cookHeatValue >= 100) {
                cookHeatValue = 100;
                cookHeatDir = -1;
            } else if (cookHeatValue <= 0) {
                cookHeatValue = 0;
                cookHeatDir = 1;
            }
            document.getElementById('cook-heat-bar').style.width = `${cookHeatValue}%`;
        }

        // Dirty Table Satisfaction Drain
        const dirtyCount = tables.filter(t => t.status === 'DIRTY').length;
        if (dirtyCount > 0) {
            const securityActive = HIREABLE_STAFF.find(h => h.id === 'hire_security')?.hired;
            const securityFactor = securityActive ? 0.65 : 1.0;
            satisfaction -= dirtyCount * CONFIG.SATISFACTION_DIRTY_PENALTY * securityFactor * dt;
        }

        updateHUD(dirtyCount);

        if (satisfaction <= 0) {
            satisfaction = 0;
            isGameRunning = false;
            document.getElementById('final-cash').innerText = `$${cash}`;
            document.getElementById('final-orders').innerText = `${ordersServed}`;
            document.getElementById('gameover-modal').classList.remove('hidden');
        }
    }

    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

// --- Shop & Upgrades Drawer ---
function toggleShopModal(forceState) {
    const modal = document.getElementById('shop-overlay');
    const isHidden = modal.classList.contains('hidden');
    const shouldShow = typeof forceState === 'boolean' ? forceState : isHidden;
    if (shouldShow) {
        renderShopModal();
        modal.classList.remove('hidden');
    } else {
        modal.classList.add('hidden');
    }
}

function renderShopModal() {
    document.getElementById('shop-cash-display').innerText = `$${cash}`;
    const powerupsList = document.getElementById('shop-powerups-list');
    powerupsList.innerHTML = '';

    SHOP_POWERUPS.forEach(p => {
        const canAfford = cash >= p.cost;
        const card = document.createElement('div');
        card.className = 'glass-card p-3 rounded-2xl border border-slate-700 flex items-center justify-between gap-2';
        card.innerHTML = `
            <div class="flex items-center gap-2.5">
                <div class="w-9 h-9 rounded-xl bg-slate-900 flex items-center justify-center ${p.color} border border-slate-800">
                    <i class="fa-solid ${p.icon}"></i>
                </div>
                <div>
                    <div class="text-xs font-bold text-white">${p.name}</div>
                    <div class="text-[10px] text-slate-400">${p.desc}</div>
                </div>
            </div>
            <button class="px-3 py-1.5 rounded-xl text-xs font-game transition ${
                p.purchased
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                    : canAfford
                    ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
            }" ${p.purchased || !canAfford ? 'disabled' : ''}>
                ${p.purchased ? 'OWNED' : `$${p.cost}`}
            </button>
        `;
        const btn = card.querySelector('button');
        if (!p.purchased && canAfford) {
            btn.addEventListener('click', () => {
                cash -= p.cost;
                if (p.id === 'speed_shoes') {
                    p.purchased = true;
                    CONFIG.PLAYER_SPEED *= 1.3;
                    CONFIG.AI_SPEED *= 1.3;
                } else if (p.id === 'auto_bussers') {
                    p.purchased = true;
                    CONFIG.SATISFACTION_DIRTY_PENALTY *= 0.5;
                } else if (p.id === 'vip_tips') {
                    p.purchased = true;
                } else if (p.id === 'sat_boost') {
                    satisfaction = Math.min(100, satisfaction + 30);
                }
                sound.playChaChing();
                updateHUD(tables.filter(t => t.status === 'DIRTY').length);
                renderShopModal();
            });
        }
        powerupsList.appendChild(card);
    });

    const menuList = document.getElementById('shop-menu-list');
    menuList.innerHTML = '';

    MENU_ITEMS.filter(m => m.unlockCost > 0).forEach(item => {
        const canAfford = cash >= item.unlockCost;
        const card = document.createElement('div');
        card.className = 'glass-card p-3 rounded-2xl border border-slate-700 flex items-center justify-between gap-2';
        card.innerHTML = `
            <div class="flex items-center gap-2.5">
                <div class="w-9 h-9 rounded-xl bg-slate-900 flex items-center justify-center text-amber-400 border border-slate-800">
                    <i class="fa-solid ${item.icon}"></i>
                </div>
                <div>
                    <div class="text-xs font-bold text-white">${item.name} <span class="text-emerald-400">($${item.price}/order)</span></div>
                    <div class="text-[10px] text-slate-400">${item.recipe.length}-step chef recipe</div>
                </div>
            </div>
            <button class="px-3 py-1.5 rounded-xl text-xs font-game transition ${
                item.unlocked
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                    : canAfford
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed'
            }" ${item.unlocked || !canAfford ? 'disabled' : ''}>
                ${item.unlocked ? 'UNLOCKED' : `$${item.unlockCost}`}
            </button>
        `;
        const btn = card.querySelector('button');
        if (!item.unlocked && canAfford) {
            btn.addEventListener('click', () => {
                cash -= item.unlockCost;
                item.unlocked = true;
                sound.playChaChing();
                renderPOSButtons();
                updateHUD(tables.filter(t => t.status === 'DIRTY').length);
                renderShopModal();
            });
        }
        menuList.appendChild(card);
    });

    // Render Hireable Staff Cards
    const hireList = document.getElementById('shop-hire-list');
    if (hireList) {
        hireList.innerHTML = '';
        HIREABLE_STAFF.forEach(h => {
            const canAfford = cash >= h.cost;
            const card = document.createElement('div');
            card.className = 'glass-card p-3 rounded-2xl border border-slate-700 flex flex-col justify-between gap-2';
            card.innerHTML = `
                <div class="flex items-start gap-2.5">
                    <div class="w-9 h-9 rounded-xl bg-slate-900 flex-shrink-0 flex items-center justify-center ${h.color} border border-slate-800">
                        <i class="fa-solid ${h.icon}"></i>
                    </div>
                    <div>
                        <div class="text-xs font-bold text-white">${h.name}</div>
                        <div class="text-[10px] text-slate-400 leading-snug mt-0.5">${h.desc}</div>
                    </div>
                </div>
                <button class="w-full py-1.5 rounded-xl text-xs font-game transition ${
                    h.hired
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                        : canAfford
                        ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-950'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                }" ${h.hired || !canAfford ? 'disabled' : ''}>
                    ${h.hired ? 'HIRED & ON DUTY' : `HIRE ($${h.cost})`}
                </button>
            `;
            const btn = card.querySelector('button');
            if (!h.hired && canAfford) {
                btn.addEventListener('click', () => {
                    cash -= h.cost;
                    h.hired = true;
                    if (h.id === 'hire_security') {
                        staffMembers.push(createStaffMember('hired-security', 'AI', ROLES.SECURITY));
                    } else if (h.id === 'hire_cook') {
                        staffMembers.push(createStaffMember('hired-cook', 'AI', ROLES.COOK, new THREE.Vector3(1.6, 0, 0)));
                    } else if (h.id === 'hire_front') {
                        staffMembers.push(createStaffMember('hired-front', 'AI', ROLES.FRONT, new THREE.Vector3(1.6, 0, 0)));
                    }
                    sound.playChaChing();
                    updateHUD(tables.filter(t => t.status === 'DIRTY').length);
                    renderShopModal();
                });
            }
            hireList.appendChild(card);
        });
    }
}

function renderPOSButtons() {
    const itemsGrid = document.getElementById('pos-items-grid');
    itemsGrid.innerHTML = '';
    MENU_ITEMS.filter(m => m.unlocked).forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'pos-ring-btn flex items-center justify-between p-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-bold text-white border border-slate-700 transition';
        btn.dataset.id = item.id;
        btn.innerHTML = `<span class="flex items-center gap-1"><i class="fa-solid ${item.icon} text-amber-400"></i> [${item.code}] ${item.name}</span> <span class="text-emerald-400">$${item.price}</span>`;
        btn.addEventListener('click', () => ringUpPOSItem(item));
        itemsGrid.appendChild(btn);
    });
}

// --- Lobby Role Dropdown & UI Initialization ---
function populateSoloRoleDropdowns() {
    const selects = [
        document.getElementById('select-role-cashier'),
        document.getElementById('select-role-cook'),
        document.getElementById('select-role-front')
    ];
    selects.forEach((sel, idx) => {
        sel.innerHTML = `
            <option value="P1">Assigned to: Player 1</option>
            <option value="AI">Assigned to: AI Agent</option>
        `;
        sel.value = idx === 0 ? 'P1' : 'AI';
    });
}

function populateCoopRoleDropdowns() {
    const selects = [
        document.getElementById('select-role-cashier'),
        document.getElementById('select-role-cook'),
        document.getElementById('select-role-front')
    ];
    selects.forEach((sel, idx) => {
        sel.innerHTML = `
            <option value="P1">Assigned to: Host (P1)</option>
            <option value="P2">Assigned to: Guest (P2)</option>
            <option value="AI">Assigned to: AI Agent</option>
        `;
        sel.value = idx === 0 ? 'P1' : idx === 1 ? 'P2' : 'AI';
    });
}

function setupUI() {
    const btnSolo = document.getElementById('mode-solo');
    const btnCoop = document.getElementById('mode-coop');
    const coopPanel = document.getElementById('coop-room-panel');
    const roleSection = document.getElementById('role-assignment-section');
    const btnStart = document.getElementById('btn-start-shift');

    const selCashier = document.getElementById('select-role-cashier');
    const selCook = document.getElementById('select-role-cook');
    const selFront = document.getElementById('select-role-front');

    btnSolo.addEventListener('click', () => {
        gameMode = 'SOLO';
        btnSolo.classList.add('border-amber-400', 'bg-amber-500/10');
        btnCoop.classList.remove('border-cyan-400', 'bg-cyan-500/10');
        coopPanel.classList.add('hidden');
        roleSection.classList.remove('hidden');
        btnStart.classList.remove('hidden');
        document.getElementById('p2-control-legend').classList.add('hidden');
        populateSoloRoleDropdowns();
        sound.playRegister();
    });

    btnCoop.addEventListener('click', () => {
        gameMode = 'COOP';
        btnCoop.classList.add('border-cyan-400', 'bg-cyan-500/10');
        btnSolo.classList.remove('border-amber-400', 'bg-amber-500/10');
        coopPanel.classList.remove('hidden');
        roleSection.classList.remove('hidden');
        btnStart.classList.remove('hidden');
        document.getElementById('p2-control-legend').classList.remove('hidden');
        populateCoopRoleDropdowns();
        sound.playRegister();
    });

    // Solo Mode Single-Role Enforcement (Player 1 can only take 1 role at a time)
    [selCashier, selCook, selFront].forEach((changedSel) => {
        changedSel.addEventListener('change', () => {
            if (gameMode === 'SOLO' && changedSel.value === 'P1') {
                [selCashier, selCook, selFront].forEach((other) => {
                    if (other !== changedSel) other.value = 'AI';
                });
            }
        });
    });

    // Co-op Room Buttons
    document.getElementById('btn-create-room').addEventListener('click', createOnlineRoom);
    document.getElementById('btn-join-room').addEventListener('click', joinOnlineRoom);
    document.getElementById('btn-ping-peer').addEventListener('click', sendPingHandshake);
    document.getElementById('btn-copy-room').addEventListener('click', () => {
        if (!roomCode) return;
        const temp = document.createElement('textarea');
        temp.value = roomCode;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        sound.playRegister();
    });

    // Start & Restart Shift Buttons
    btnStart.addEventListener('click', startShift);
    document.getElementById('btn-restart').addEventListener('click', () => {
        document.getElementById('gameover-modal').classList.add('hidden');
        document.getElementById('top-hud').classList.add('hidden');
        document.getElementById('bottom-hud').classList.add('hidden');
        document.getElementById('lobby-modal').classList.remove('hidden');
        isGameRunning = false;
        isPaused = true;
        document.getElementById('pos-overlay').classList.add('hidden');
        document.getElementById('cook-overlay').classList.add('hidden');
        toggleShopModal(false);
    });

    // Shop Modal Buttons
    document.getElementById('btn-open-shop').addEventListener('click', () => toggleShopModal(true));
    document.getElementById('btn-open-hire').addEventListener('click', () => toggleShopModal(true));
    document.getElementById('btn-close-shop').addEventListener('click', () => toggleShopModal(false));

    // POS Cash Change & Card Terminal Button Listeners
    document.querySelectorAll('.pos-change-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            posCurrentChange += parseInt(btn.dataset.val, 10);
            document.getElementById('pos-cash-current').innerText = `$${posCurrentChange}`;
        });
    });
    document.getElementById('pos-btn-exact').addEventListener('click', () => {
        if (!activePOSCustomer) return;
        posCurrentChange = activePOSCustomer.cashGiven - activePOSCustomer.order.price;
        document.getElementById('pos-cash-current').innerText = `$${posCurrentChange}`;
    });
    document.getElementById('pos-btn-clear').addEventListener('click', () => {
        posCurrentChange = 0;
        document.getElementById('pos-cash-current').innerText = `$0`;
    });
    document.getElementById('pos-btn-submit-cash').addEventListener('click', handlePOSConfirmKey);
    document.getElementById('pos-btn-process-card').addEventListener('click', handlePOSConfirmKey);

    // Cook Station Button Listeners
    document.getElementById('cook-btn-plate').addEventListener('click', finishCookingDish);
    document.getElementById('cook-btn-cancel').addEventListener('click', closeCookStation);

    // Audio & Pause HUD Listeners
    document.getElementById('btn-audio-toggle').addEventListener('click', (e) => {
        audioMuted = !audioMuted;
        e.currentTarget.innerHTML = audioMuted
            ? '<i class="fa-solid fa-volume-xmark text-red-400 text-sm"></i>'
            : '<i class="fa-solid fa-volume-high text-sm"></i>';
    });
    document.getElementById('btn-pause').addEventListener('click', (e) => {
        isPaused = !isPaused;
        e.currentTarget.innerHTML = isPaused
            ? '<i class="fa-solid fa-play text-emerald-400 text-sm"></i>'
            : '<i class="fa-solid fa-pause text-sm"></i>';
    });

    // Inject POS Menu Buttons
    renderPOSButtons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupUI);
} else {
    setupUI();
}
