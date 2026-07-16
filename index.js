const mqtt = require('mqtt');

const broker = 'mqtt://localhost:1883';
const topicRtk = '01/sensor/rtk_lio';
const topicElev = '01/map/elevation';
const topicJoints = '01/joints';

// ====== Tile config (must match Unity TerrainTileManager) ======
const tileSizeMeters = 100.0;

// gridSize=128 => Unity TerrainData.heightmapResolution must be 129
const gridSize = 128;

// Excavator position relative to the center of the elevation map (ENU, meters).
// x=east, y=north, z=up
const elevationOrigin = Object.freeze({ x: Math.random() * 10, y: Math.random() * 12, z: 0.0 });

// ====== Publish rates ======
const rtkHz = 5;                 // 5 Hz
const jointsHz = 5;              // 5 Hz
const elevIntervalMs = 5000;     // 2 s

// Dynamic-terrain stability test. Each elevation message adds a broad, smooth
// centimetre-level pulse around the excavator instead of changing random pixels.
// Set to 0 to publish a completely static surface.
const terrainPulseAmplitudeMeters = 0.03;

// ====== Motion model ======
const speedMps = 0.6;           // forward speed (m/s)
const turnRateRad = 0.08;       // slow turn (rad/s)

const client = mqtt.connect(broker);

let t0 = Date.now();
let lastRtkMs = Date.now();
let elevationSequence = 0;
let jointsSequence = 0;

let state = {
  // relative ENU meters (x=east, y=north)
  x: 0.0,
  y: 0.0,
  z: 0.0,
  heading: 0.0, // rad, 0=north
};

client.on('connect', () => {
  console.log('MQTT connected');

  // setInterval(publishRtk, Math.floor(1000 / rtkHz));
  setInterval(publishJoints, Math.floor(1000 / jointsHz));
  setInterval(publishElevationForCurrentTile, elevIntervalMs);
});

function publishJoints() {
  const now = Date.now();
  const elapsedSeconds = (now - t0) / 1000.0;

  // Smooth absolute angles relative to each parent link. The small phase offsets make
  // it easy to verify boom -> stick -> bucket forward kinematics independently.
  const boomAngle = 30.0 + 10.0 * Math.sin(elapsedSeconds * 0.35);
  const stickAngle = 45.0 + 12.0 * Math.sin(elapsedSeconds * 0.42 + 0.8);
  const bucketAngle = -15.0 + 18.0 * Math.sin(elapsedSeconds * 0.55 + 1.6);

  const msg = {
    timestamp: now / 1000,
    joints: {
      bucket: { angle: round3(bucketAngle), velocity: 0.0 },
      stick: { angle: round3(stickAngle), velocity: 0.0 },
      boom: { angle: round3(boomAngle), velocity: 0.0 },
      // Unity intentionally ignores cabin and all velocity fields for now.
      cabin: { angle: 90.0, velocity: 0.0 }
    }
  };

  client.publish(topicJoints, JSON.stringify(msg), { qos: 0 }, (err) => {
    if (err) {
      console.error('joints publish failed:', err);
      return;
    }

    if (jointsSequence++ % jointsHz === 0) {
      console.log(
        `joints published boom=${msg.joints.boom.angle} ` +
        `stick=${msg.joints.stick.angle} bucket=${msg.joints.bucket.angle}`
      );
    }
  });
}

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
    now,
    sequence: elevationSequence++
  });

  client.publish(topicElev, JSON.stringify(msg), { qos: 0 }, (err) => {
    if (err) console.error('elevation publish failed:', err);
    else console.log(`elevation tile (${tile_x},${tile_y}) published`);
  });
}

function generateElevationTile({ tile_x, tile_y, now, sequence }) {
  const width = gridSize;
  const height = gridSize;

  // meters per pixel (optional, not required by Unity demo)
  const resolution = tileSizeMeters / gridSize;

  const height_resolution = 0.01;
  const minElevation = -6.0;
  const maxElevation = 12.0;

  // Base shapes (smooth) + coherent noise (smooth) => natural terrain.
  // Avoid per-pixel Math.random(), which creates "spikes" in Unity.
  const hillHeight = 2.5 + ((tile_x + tile_y) % 3) * 1.2;
  const bumpsHeight = 2.8; // only appears sparsely via mask
  const noiseAmpMeters = 0.65;
  const noiseFreq = 1 / 14.0; // larger => more frequent bumps; unit: 1/m

  const data = new Array(width * height);
  const centerX = width / 2;
  const centerY = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - centerX) / (width / 2);
      const dy = (y - centerY) / (height / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);

      // World position in meters for stable, smooth noise (seamless across tiles)
      const worldX = tile_x * tileSizeMeters + x * resolution;
      const worldY = tile_y * tileSizeMeters + y * resolution;

      // Coherent noise in [-1, 1]
      const n1 = fbm2D(worldX * noiseFreq, worldY * noiseFreq, 5, 2.0, 0.5, 1337);
      const n2 = fbm2D(worldX * noiseFreq * 0.5, worldY * noiseFreq * 0.5, 3, 2.0, 0.5, 4242);

      // add a gentle "basin" so tiles have both hills and valleys
      let elevation = -2.0 * dist;
      elevation += hillHeight * Math.exp(-dist * dist * 3);

      // Smooth rolling terrain (continuous)
      elevation += n1 * noiseAmpMeters;

      // Sparse bumps: only some areas get extra uplift (not everywhere)
      const bumpMask = Math.max(0.0, (n2 - 0.35) / 0.65); // 0..1-ish
      elevation += bumpMask * bumpMask * bumpsHeight;

      // Broad temporal pulse near the map centre. This deliberately exercises
      // Unity TerrainCollider updates under the excavator by only a few cm.
      const pulseFalloff = Math.exp(-dist * dist * 2.0);
      elevation += Math.sin(sequence * 0.8) * terrainPulseAmplitudeMeters * pulseFalloff;

      elevation = Math.max(minElevation, Math.min(maxElevation, elevation));

      data[y * width + x] = Math.round(elevation / height_resolution);
    }
  }

  return {
    timestamp: now / 1000,
    sequence,
    metadata: {
      width,
      height,
      resolution,
      height_resolution,
      // Excavator offset from the elevation map center, in meters.
      origin: { ...elevationOrigin },
      origin_type: 'center',
      coordinate_system: 'global',
      frame_id: 'camera_init',
      min_elevation: minElevation,
      max_elevation: maxElevation,
      invalid_value: -32768,

      // Unity tile demo reads these:
      tile_x,
      tile_y,
      tile_size_meters: tileSizeMeters
    },
    data_type: 'int16',
    data_order: 'row_major',
    layer: 'elevation',
    data
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Deterministic hash -> [0, 1)
function hash2D(ix, iy, seed) {
  // 32-bit integer mix (deterministic)
  let h = (ix * 374761393) ^ (iy * 668265263) ^ (seed * 1442695041);
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  // convert to [0,1)
  return (h >>> 0) / 4294967296;
}

// Value noise with bilinear interpolation, output in [-1, 1]
function valueNoise2D(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const sx = smoothstep(x - x0);
  const sy = smoothstep(y - y0);

  const n00 = hash2D(x0, y0, seed) * 2 - 1;
  const n10 = hash2D(x1, y0, seed) * 2 - 1;
  const n01 = hash2D(x0, y1, seed) * 2 - 1;
  const n11 = hash2D(x1, y1, seed) * 2 - 1;

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sy);
}

// Fractal Brownian Motion (sum of octaves), output roughly in [-1, 1]
function fbm2D(x, y, octaves, lacunarity, gain, seed) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;

  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }

  return norm > 0 ? sum / norm : 0.0;
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
