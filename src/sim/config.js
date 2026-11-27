// Tuning tables for LAST CORDON. Pure data: shared by the simulation, renderer, HUD and tests.

export const WORLD = {
  SIZE: 640,        // metres, world spans [-320, 320] on x and z
  HALF: 320,
  GRID_N: 257,      // heightmap vertices per side
  CELL: 2.5,        // heightmap cell size (m)
  BOUND_R: 312,     // actors are clamped inside this radius
  NAV_N: 640,       // nav grid cells per side (1 m cells)
  SEED: 20261,      // the island itself is fixed; matches vary by match seed
};

export const ACTOR = {
  RADIUS: 0.36,
  HEIGHT: 1.8,
  CROUCH_HEIGHT: 1.25,
  EYE: 1.58,
  CROUCH_EYE: 1.08,
  HEAD_Y: 1.63,
  CROUCH_HEAD_Y: 1.13,
  HEAD_R: 0.2,
  WALK: 4.7,
  SPRINT: 7.0,
  CROUCH: 2.5,
  ADS_MOVE: 3.1,
  SWIM: 2.7,
  ACCEL: 46,
  AIR_ACCEL: 9,
  JUMP_V: 6.1,
  GRAVITY: 17.5,
  STEP: 0.38,
  MAX_HP: 100,
  MAX_ARMOR: 100,
  MAX_HELMET: 60,
  VEST_ABSORB: 0.55,
  HELMET_ABSORB: 0.4,
  MAX_MEDKITS: 5,
  MAX_WALLS: 5,
  START_WALLS: 3,
  HEAL_TIME: 2.4,
  HEAL_AMOUNT: 65,
};

// Spread and recoil are in degrees. Damage falls off linearly between falloffStart and falloffEnd.
export const WEAPONS = [
  {
    id: 'ar', name: 'WARDEN', cls: 'ASSAULT RIFLE', slot: 0, auto: true,
    dmg: 22, head: 2.0, leg: 0.85, interval: 0.1, mag: 30, reload: 2.1,
    falloffStart: 55, falloffEnd: 130, falloffMin: 0.6, range: 330,
    hipSpread: 1.5, adsSpread: 0.25, bloom: 0.2, bloomMax: 2.0, moveSpread: 1.3,
    recoilPitch: 0.5, recoilYaw: 0.26, adsFov: 46, moveMul: 1.0, pickupReserve: 60, maxReserve: 210,
  },
  {
    id: 'smg', name: 'HORNET', cls: 'SUBMACHINE GUN', slot: 1, auto: true,
    dmg: 15, head: 1.7, leg: 0.85, interval: 0.066, mag: 34, reload: 1.7,
    falloffStart: 16, falloffEnd: 48, falloffMin: 0.45, range: 220,
    hipSpread: 1.9, adsSpread: 0.75, bloom: 0.13, bloomMax: 1.9, moveSpread: 0.7,
    recoilPitch: 0.3, recoilYaw: 0.3, adsFov: 54, moveMul: 1.06, pickupReserve: 68, maxReserve: 238,
  },
  {
    id: 'sr', name: 'LANCE', cls: 'SNIPER RIFLE', slot: 2, auto: false,
    dmg: 92, head: 2.4, leg: 0.85, interval: 1.25, mag: 5, reload: 2.9,
    falloffStart: 9999, falloffEnd: 9999, falloffMin: 1, range: 420,
    hipSpread: 5.0, adsSpread: 0.02, bloom: 0, bloomMax: 0, moveSpread: 2.2,
    recoilPitch: 3.0, recoilYaw: 0.6, adsFov: 13, scope: true, moveMul: 0.94, pickupReserve: 10, maxReserve: 30,
  },
];
export const WEAPON_INDEX = { ar: 0, smg: 1, sr: 2 };

// The Cordon (safe zone). Each phase: hold for `wait` seconds, then shrink over `shrink` seconds
// to `radius`. `dps` is damage per second outside the barrier during that phase.
// Totals 440 s: the barrier is fully closed at 7:20, which bounds every match.
export const ZONE_PHASES = [
  { wait: 60, shrink: 45, radius: 185, dps: 1.5 },
  { wait: 45, shrink: 40, radius: 105, dps: 3 },
  { wait: 40, shrink: 35, radius: 52, dps: 5 },
  { wait: 35, shrink: 30, radius: 22, dps: 8 },
  { wait: 25, shrink: 30, radius: 8, dps: 12 },
  { wait: 15, shrink: 40, radius: 0, dps: 18 },
];
export const ZONE_START_RADIUS = 335;
export const ZONE_FINAL_DPS = 30; // once fully closed

// Deployable cover wall (the "Bulwark").
export const WALL = {
  HP: 300,
  LIFE: 24,          // seconds before it dissolves
  COOLDOWN: 0.9,
  DIST: 1.9,         // metres in front of the deployer
  ARC_RADIUS: 3.1,   // radius of curvature
  ARC_ANGLE: 1.5,    // radians of arc (about 4.2 m wide)
  HEIGHT: 2.35,
  THICK: 0.26,
  SEGMENTS: 5,
  MAX_ACTIVE: 48,
};

export const DROP = {
  ALTITUDE: 150,
  FALL_SPEED: 8.5,
  STEER_SPEED: 17,
};

// How many of each crate to place per match (plus drops from eliminated operators).
export const LOOT_COUNTS = { ar: 15, smg: 13, sr: 8, ammo: 26, vest: 13, helmet: 11, medkit: 20 };
export const LOOT_PICKUP_RADIUS = 1.55;

export const LOOT_INFO = {
  ar: { label: 'WARDEN AR', color: 0xffb347 },
  smg: { label: 'HORNET SMG', color: 0xffd447 },
  sr: { label: 'LANCE SR', color: 0xff6b4a },
  ammo: { label: 'SUPPLY', color: 0xcfd8dc },
  vest: { label: 'PLATE VEST', color: 0x4aa3ff },
  helmet: { label: 'HELMET', color: 0x6fd0ff },
  medkit: { label: 'MEDKIT', color: 0x59e37a },
};

export const BOT_NAMES = [
  'Kestrel', 'Onyx', 'Mako', 'Vandal', 'Rook', 'Jinx', 'Talon', 'Cinder', 'Nomad', 'Sable',
  'Drift', 'Echo', 'Flint', 'Quill', 'Tundra', 'Lynx', 'Orca', 'Vesper', 'Cobalt',
];

export const TOTAL_ACTORS = 20;
export const TICK = 1 / 60;

// Pacing director: how many operators "should" be alive at a given match time (seconds).
// Bot-vs-bot lethality is nudged up or down to follow this curve.
export const ALIVE_CURVE = [
  [0, 20], [35, 20], [90, 17], [150, 14], [210, 11], [270, 8.5], [330, 6], [385, 4], [440, 1],
];
