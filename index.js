const mqtt = require('mqtt');

const broker = 'mqtt://localhost:1883';
const topicRtk = '01/sensor/rtk_lio';
const topicElev = '01/map/elevation';

// ====== Tile config (must match Unity TerrainTileManager) ======
const tileSizeMeters = 50.0;

// gridSize=128 => Unity TerrainData.heightmapResolution must be 129
const gridSize = 128;

// ====== Publish rates ======
const rtkHz = 5;                 // 5 Hz
const elevIntervalMs = 5000;     // 2 s

// ====== Motion model ======
const speedMps = 0.6;           // forward speed (m/s)
const turnRateRad = 0.08;       // slow turn (rad/s)

const client = mqtt.connect(broker);

let t0 = Date.now();
let lastRtkMs = Date.now();

let state = {
  // relative ENU meters (x=east, y=north)
  x: 0.0,
  y: 0.0,
  z: 0.0,
  heading: 0.0, // rad, 0=north
};

client.on('connect', () => {
  console.log('MQTT connected');

  setInterval(publishRtk, Math.floor(1000 / rtkHz));
  setInterval(publishElevationForCurrentTile, elevIntervalMs);
});

function publishRtk() {
  const now = Date.now();
  const dt = (now - lastRtkMs) / 1000.0;
  lastRtkMs = now;

  // smooth motion (no teleport)
  state.heading += turnRateRad * dt;
  const vx = speedMps * Math.sin(state.heading); // east
  const vy = speedMps * Math.cos(state.heading); // north

  state.x += vx * dt;
  state.y += vy * dt;

  const q = yawToEnuQuaternion(state.heading);

  const msg = {
    timestamp: now / 1000,
    rtk_status: {
      fix_type: 'fixed',
      satellites_used: 18,
      age: 0.05,
      accuracy: { horizontal: 0.015, vertical: 0.025 }
    },
    position: {
      global: {
        latitude: 22.7557479,
        longitude: 113.5515704,
        altitude: 15.678
      },
      relative: {
        translation: { x: round3(state.x), y: round3(state.y), z: round3(state.z) }
      }
    },
    rotation: q,
    velocity: { x: round3(vx), y: round3(vy), z: 0.0 }
  };

  client.publish(topicRtk, JSON.stringify(msg), { qos: 0 });
}

function publishElevationForCurrentTile() {
  const now = Date.now();

  const tile_x = Math.floor(state.x / tileSizeMeters);
  const tile_y = Math.floor(state.y / tileSizeMeters);

  const msg = generateElevationTile({
    tile_x,
    tile_y,
    now
  });

  client.publish(topicElev, JSON.stringify(msg), { qos: 0 }, (err) => {
    if (err) console.error('elevation publish failed:', err);
    else console.log(`elevation tile (${tile_x},${tile_y}) published`);
  });
}

function generateElevationTile({ tile_x, tile_y, now }) {
  const width = gridSize;
  const height = gridSize;

  // meters per pixel (optional, not required by Unity demo)
  const resolution = tileSizeMeters / gridSize;

  const height_resolution = 0.01;
  const minElevation = -2.0;
  const maxElevation = 8.0;

  // simple hill pattern changes per tile so you can see tile transitions
  const hillHeight = 3.0 + ((tile_x + tile_y) % 3) * 0.8;
  const noiseAmplitude = 0.4;

  const data = new Array(width * height);
  const centerX = width / 2;
  const centerY = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - centerX) / (width / 2);
      const dy = (y - centerY) / (height / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);

      let elevation = hillHeight * Math.exp(-dist * dist * 3);
      elevation += (Math.random() - 0.5) * noiseAmplitude;
      elevation = Math.max(minElevation, Math.min(maxElevation, elevation));

      data[y * width + x] = Math.round(elevation / height_resolution);
    }
  }

  return {
    timestamp: now / 1000,
    metadata: {
      width,
      height,
      resolution,
      height_resolution,
      origin: { x: tile_x * tileSizeMeters, y: tile_y * tileSizeMeters, z: 0.0 },
      coordinate_system: 'enu_rel',
      min_elevation: minElevation,
      max_elevation: maxElevation,

      // Unity tile demo reads these:
      tile_x,
      tile_y,
      tile_size_meters: tileSizeMeters
    },
    data_type: 'int16',
    data,
    data_order: 'row_major'
  };
}

function yawToEnuQuaternion(yawRad) {
  // yaw around ENU "up" axis. In ENU, up is +Z, but your Unity converter swaps axes.
  // For your current pipeline this is mainly for UI arrow; approximate by yaw around Unity-up equivalent.
  const half = yawRad * 0.5;
  return { x: 0.0, y: 0.0, z: Math.sin(half), w: Math.cos(half) };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}