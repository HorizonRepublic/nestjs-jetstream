import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ACK_MS, CAPACITY, PODS, RESTART_MS, createSim, isDown, step, togglePod } from './model';

/* The hero scene: a message's whole life, drawn isometrically.

   Services publish along lines that converge on the stream, a glass capsule
   where messages wait in order. From its far end, lines fan out to NestJS
   pods. An ack lifts the message away; a nak sends it up the retry arc, the
   backoff, and back into the stream. Every message moves along a drawn path. */

const Z = [-1.7, 0, 1.7];
const SERVICE_X = -5.3;
const POD_X = 4.3;
const BELT_Y = 0.36;
const TUBE = { x0: -2.6, x1: 1.5, radius: 0.27 };
const SPACING = (TUBE.x1 - TUBE.x0 - 0.5) / (CAPACITY - 1);
const POD = { w: 0.98, h: 0.38, d: 0.98 };
const POD_TOP = POD.h + 0.12;
const SERVICE = { w: 0.86, h: 0.3, d: 0.6 };
const REGION = {
  wide: { x0: 0.48, x1: 0.99, y0: 0.05, y1: 0.95 },
  narrow: { x0: 0.02, x1: 0.98, y0: 0.04, y1: 0.96 },
};
const HINT_KEY = 'jt-scene-clicked';
const WARMUP_MS = 7000;

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

/* ---- paths: every message rides one of these ------------------------------ */

const entrance = v3(TUBE.x0 + 0.05, BELT_Y, 0);
const exit = v3(TUBE.x1 + 0.1, BELT_Y, 0);

const fanIn = Z.map(
  (z) => new THREE.CubicBezierCurve3(v3(SERVICE_X + 0.5, BELT_Y - 0.12, z), v3(-4.0, BELT_Y, z), v3(-3.6, BELT_Y, 0), v3(TUBE.x0 - 0.2, BELT_Y, 0)),
);
const fanOut = Z.map(
  (z) => new THREE.CubicBezierCurve3(exit.clone(), v3(2.6, BELT_Y, 0), v3(3.1, BELT_Y + 0.05, z), v3(POD_X, POD_TOP, z)),
);
const retryArcs = Z.map(
  (z) =>
    new THREE.CatmullRomCurve3(
      [
        v3(POD_X, POD_TOP, z),
        v3(POD_X - 0.1, 1.3, z * 0.8),
        v3(3.0, 2.15, -0.7),
        v3(0.2, 2.45, -1.1),
        v3(-2.3, 1.75, -0.6),
        v3(-3.0, 0.75, 0),
        v3(TUBE.x0 - 0.2, BELT_Y, 0),
      ],
      false,
      'centripetal',
    ),
);

const queueSlot = (index) => v3(TUBE.x1 - 0.2 - index * SPACING, BELT_Y, 0);
const waitSlot = (index) => v3(TUBE.x0 - 0.45 - index * 0.22, BELT_Y, 0);

/* Where a message is, from its state and how far into it the clock is. */
const positionOf = (sim, message, queueIndex, waitIndex) => {
  const t = clamp01((sim.time - message.since) / (message.until - message.since));

  switch (message.state) {
    case 'in':
      return waitIndex >= 0 ? waitSlot(waitIndex) : fanIn[message.service].getPointAt(ease(t));
    case 'queued':
      return queueSlot(queueIndex);
    case 'out':
      return fanOut[message.pod].getPointAt(ease(t));
    case 'work':
      return v3(POD_X, POD_TOP + 0.02, Z[message.pod]);
    case 'retry':
      return waitIndex >= 0 ? waitSlot(waitIndex) : retryArcs[message.from].getPointAt(ease(t));
    case 'ack':
      return v3(POD_X, POD_TOP + 1.3 * ease(t), Z[message.pod]);
    default:
      return entrance.clone();
  }
};

/* ---- look ------------------------------------------------------------------ */

const readPalette = () => {
  const css = getComputedStyle(document.documentElement);
  const color = (name) => new THREE.Color(css.getPropertyValue(name).trim() || '#888888');

  return {
    dark: document.documentElement.dataset.theme === 'dark',
    deliver: color('--jt-state-deliver'),
    redeliver: color('--jt-state-redeliver'),
    ack: color('--jt-state-ack'),
    dlq: color('--jt-state-dlq'),
    bg0: color('--jt-bg-0'),
    bg2: color('--jt-bg-2'),
    bg3: color('--jt-bg-3'),
    line: color('--jt-line-2'),
    strong: color('--jt-line-3'),
  };
};

const glowTexture = () => {
  const size = 64;
  const canvas = document.createElement('canvas');

  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(canvas);
};

const readClicked = () => {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
};

const rememberClicked = () => {
  try {
    window.localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* storage blocked; the hint just shows again next time */
  }
};

/* A floor grid whose lines fade out away from the middle. */
const makeGrid = (palette) => {
  const positions = [];
  const colors = [];
  const reach = 10;
  const push = (x1, z1, x2, z2) => {
    positions.push(x1, 0.002, z1, x2, 0.002, z2);

    for (const [x, z] of [
      [x1, z1],
      [x2, z2],
    ]) {
      colors.push(palette.line.r, palette.line.g, palette.line.b, Math.max(0, 1 - Math.hypot(x + 0.5, z) / reach) * 0.5);
    }
  };

  for (let i = -reach; i <= reach; i += 1) {
    for (let j = -reach; j < reach; j += 1) {
      push(i, j, i, j + 1);
      push(j, i, j + 1, i);
    }
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));

  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
};

const curveLine = (curve, material, segments = 64) => {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getSpacedPoints(segments)), material);

  line.computeLineDistances();

  return line;
};

/* ---- the scene ------------------------------------------------------------- */

export const createScene = ({ container, overlay, logoUrl, reduce, onStats }) => {
  const sim = createSim();
  let palette = readPalette();
  let clicked = readClicked() || reduce;

  // start in the middle of things rather than on an empty floor
  for (let t = 0; t < WARMUP_MS; t += 16) step(sim, 16);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });

  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const viewDir = v3(1, 1.12, 1).normalize();
  const target = v3(-0.4, 0.6, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.5);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);

  sun.position.set(-3, 10, 4);
  sun.target.position.set(-0.4, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 });
  sun.shadow.bias = -0.0006;
  scene.add(hemi, sun, sun.target);

  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.3 }));

  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  let grid = makeGrid(palette);

  scene.add(grid);

  // paths
  const pathMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 });
  const retryMaterial = new THREE.LineDashedMaterial({ transparent: true, opacity: 0.75, dashSize: 0.09, gapSize: 0.08 });

  for (const curve of [...fanIn, ...fanOut]) scene.add(curveLine(curve, pathMaterial));
  for (const curve of retryArcs) scene.add(curveLine(curve, retryMaterial, 96));

  // the stream: a glass capsule, with a glow inside that grows as it fills
  const tubeLength = TUBE.x1 - TUBE.x0;
  const tubeMaterial = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.16, roughness: 0.2, depthWrite: false });
  const tube = new THREE.Mesh(new THREE.CapsuleGeometry(TUBE.radius, tubeLength, 8, 32), tubeMaterial);
  const tubeEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.CapsuleGeometry(TUBE.radius, tubeLength, 2, 12), 30),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 }),
  );
  const tubeGlow = new THREE.Mesh(
    new THREE.CapsuleGeometry(TUBE.radius * 0.7, tubeLength, 4, 16),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );

  for (const mesh of [tube, tubeEdge, tubeGlow]) {
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set((TUBE.x0 + TUBE.x1) / 2, BELT_Y, 0);
    scene.add(mesh);
  }

  const tubeShadow = new THREE.Mesh(
    new THREE.CapsuleGeometry(TUBE.radius * 0.9, tubeLength, 4, 12),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  );

  tubeShadow.rotation.z = Math.PI / 2;
  tubeShadow.position.copy(tube.position);
  tubeShadow.castShadow = true;
  scene.add(tubeShadow);

  // services and pods
  const blockGeometry = new RoundedBoxGeometry(SERVICE.w, SERVICE.h, SERVICE.d, 4, 0.08);
  const podGeometry = new RoundedBoxGeometry(POD.w, POD.h, POD.d, 5, 0.1);
  const ledGeometry = new THREE.SphereGeometry(0.035, 16, 12);
  const serviceMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55 });
  const logoTexture = new THREE.TextureLoader().load(logoUrl);
  const glow = glowTexture();

  logoTexture.colorSpace = THREE.SRGBColorSpace;
  logoTexture.anisotropy = 4;

  for (const z of Z) {
    const service = new THREE.Mesh(blockGeometry, serviceMaterial);
    const led = new THREE.Mesh(ledGeometry, new THREE.MeshBasicMaterial());

    service.position.set(SERVICE_X, SERVICE.h / 2, z);
    service.castShadow = true;
    led.position.set(SERVICE_X + SERVICE.w / 2 - 0.14, SERVICE.h / 2, z + SERVICE.d / 2 + 0.004);
    led.userData.serviceLed = true;
    scene.add(service, led);
  }

  const ringPoints = Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2;

    return v3(Math.cos(a) * 0.62, 0, Math.sin(a) * 0.62);
  });

  const pods = Z.map((z, index) => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.5, transparent: true });
    const body = new THREE.Mesh(podGeometry, material);
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4),
      new THREE.MeshBasicMaterial({ map: logoTexture, transparent: true, depthWrite: false }),
    );
    const ledMaterial = new THREE.MeshBasicMaterial();
    const led = new THREE.Mesh(ledGeometry, ledMaterial);
    const progress = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints), new THREE.LineBasicMaterial({ transparent: true }));
    const burst = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.66, 64),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    const group = new THREE.Group();

    body.castShadow = true;
    body.userData.pod = index;
    logo.rotation.x = -Math.PI / 2;
    logo.rotation.z = Math.PI / 4;
    logo.position.y = POD.h / 2 + 0.002;
    led.position.set(POD.w / 2 - 0.16, 0, POD.d / 2 + 0.004);
    progress.position.y = POD.h / 2 + 0.01;
    group.add(body, logo, led, progress);
    group.position.set(POD_X, POD.h / 2, z);
    burst.rotation.x = -Math.PI / 2;
    burst.position.set(POD_X, 0.01, z);
    scene.add(group, burst);

    return { group, body, material, logo, ledMaterial, progress, burst, lift: 0 };
  });

  // messages: a lit sphere, a soft halo and a short trail of light
  const sphereGeometry = new THREE.SphereGeometry(0.085, 20, 14);
  const visuals = new Map();
  const TRAIL = 12;

  const visualFor = (message) => {
    let visual = visuals.get(message.id);

    if (!visual) {
      const core = new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({ transparent: true }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false }));
      const trailGeometry = new THREE.BufferGeometry();

      trailGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3));
      trailGeometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 4), 4));

      const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));

      halo.scale.setScalar(0.55);
      core.castShadow = true;
      visual = { core, halo, trail, history: [], color: new THREE.Color() };
      visuals.set(message.id, visual);
      scene.add(core, halo, trail);
    }

    return visual;
  };

  const dropVisual = (id) => {
    const visual = visuals.get(id);

    scene.remove(visual.core, visual.halo, visual.trail);
    visual.core.material.dispose();
    visual.halo.material.dispose();
    visual.trail.geometry.dispose();
    visual.trail.material.dispose();
    visuals.delete(id);
  };

  const applyPalette = () => {
    serviceMaterial.color.copy(palette.bg3);
    shadowCatcher.material.opacity = palette.dark ? 0.36 : 0.12;
    hemi.groundColor.copy(palette.bg0);
    hemi.intensity = palette.dark ? 1.5 : 2.4;
    sun.intensity = palette.dark ? 1.5 : 1.3;
    pathMaterial.color.copy(palette.strong);
    retryMaterial.color.copy(palette.redeliver);
    tubeMaterial.color.copy(palette.deliver);
    tubeEdge.material.color.copy(palette.deliver);
    tubeGlow.material.color.copy(palette.deliver);
    for (const pod of pods) pod.progress.material.color.copy(palette.deliver);

    scene.traverse((object) => {
      if (object.userData.serviceLed) object.material.color.copy(palette.deliver);
    });

    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
    grid = makeGrid(palette);
    scene.add(grid);
  };

  applyPalette();

  /* ---- overlay ------------------------------------------------------------ */

  const view = { cw: 1, ch: 1 };
  const make = (className, text = '') => {
    const el = document.createElement('div');

    el.className = className;
    el.textContent = text;
    el.hidden = true;
    overlay.appendChild(el);

    return el;
  };

  const steps = [
    { el: make('scene-step', 'publish'), at: v3(SERVICE_X, 0.5, -2.55) },
    { el: make('scene-step', 'stream'), at: v3((TUBE.x0 + TUBE.x1) / 2, 0.85, 0) },
    { el: make('scene-step', 'deliver'), at: v3(2.75, 0.55, -1.25) },
    { el: make('scene-step scene-step--ack', 'ack'), at: v3(POD_X, 1.9, Z[0] - 0.2) },
    { el: make('scene-step scene-step--retry', 'nak · retry after backoff'), at: v3(0.2, 2.75, -1.1) },
  ];
  const podLabels = pods.map(() => make('scene-label scene-label--down'));
  const deployLabel = make('scene-label scene-label--deploy');
  const hintLabel = make('scene-label scene-label--hint', 'click a pod to take it down');
  const tip = make('scene-tip');

  const toScreen = (vector) => {
    const v = vector.clone().project(camera);

    return { x: ((v.x + 1) / 2) * view.cw, y: ((1 - v.y) / 2) * view.ch };
  };

  const place = (el, at, show = true, anchor = 'translate(-50%, -50%)') => {
    el.hidden = !show;
    if (show) el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) ${anchor}`;
  };

  /* ---- framing ------------------------------------------------------------ */

  const frame = () => {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const region = cw < 760 ? REGION.narrow : REGION.wide;
    const aspect = cw / ch;

    view.cw = cw;
    view.ch = ch;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(cw, ch, false);
    renderer.domElement.style.width = `${cw}px`;
    renderer.domElement.style.height = `${ch}px`;

    camera.position.copy(target).addScaledVector(viewDir, 30);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateMatrixWorld();

    const bounds = [
      v3(SERVICE_X - 0.6, 0, -2.2),
      v3(SERVICE_X - 0.6, 0, 2.2),
      v3(POD_X + 0.7, 0, -2.2),
      v3(POD_X + 0.7, 0, 2.2),
      v3(0.2, 2.9, -1.1),
      v3(POD_X, 2.0, Z[0]),
    ].map((p) => p.applyMatrix4(camera.matrixWorldInverse));
    const minX = Math.min(...bounds.map((p) => p.x));
    const maxX = Math.max(...bounds.map((p) => p.x));
    const minY = Math.min(...bounds.map((p) => p.y));
    const maxY = Math.max(...bounds.map((p) => p.y));
    const rw = region.x1 - region.x0;
    const rh = region.y1 - region.y0;
    const height = Math.max((maxY - minY) / rh, (maxX - minX) / (rw * aspect)) * 1.02;
    const width = height * aspect;

    Object.assign(camera, { left: -width / 2, right: width / 2, top: height / 2, bottom: -height / 2 });

    const right = v3(0, 0, 0).setFromMatrixColumn(camera.matrixWorld, 0);
    const up = v3(0, 0, 0).setFromMatrixColumn(camera.matrixWorld, 1);
    const shiftX = (minX + maxX) / 2 - ((region.x0 + region.x1) / 2 - 0.5) * width;
    const shiftY = (minY + maxY) / 2 + ((region.y0 + region.y1) / 2 - 0.5) * height;

    camera.position.addScaledVector(right, shiftX).addScaledVector(up, shiftY);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  /* ---- per frame ------------------------------------------------------------ */

  const ui = { hoverPod: null, hoverMessage: null };

  const colorOf = (message) => {
    if (message.state === 'ack') return palette.ack;
    if (message.state === 'retry' || message.attempt > 0) return palette.redeliver;

    return palette.deliver;
  };

  const update = (dt) => {
    const now = sim.time;
    const smooth = 1 - Math.exp(-dt / 110);
    const additive = palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending;

    for (const message of sim.messages) {
      const visual = visualFor(message);
      const queueIndex = sim.queue.indexOf(message);
      const waitIndex = sim.waiting.indexOf(message);
      const target = positionOf(sim, message, queueIndex, waitIndex);
      const first = !visual.placed;

      // the queue and the waiting line glide; paths are followed exactly
      if (message.state === 'queued' || waitIndex >= 0) {
        if (first) visual.core.position.copy(target);
        else visual.core.position.lerp(target, smooth);
      } else {
        visual.core.position.copy(target);
      }

      visual.placed = true;

      const color = colorOf(message);
      const fade = message.state === 'ack' ? 1 - clamp01((now - message.since) / ACK_MS) : 1;

      visual.color.lerp(color, first ? 1 : Math.min(1, smooth * 2));
      visual.core.material.color.copy(visual.color);
      visual.core.material.opacity = fade;
      visual.halo.position.copy(visual.core.position);
      visual.halo.material.color.copy(visual.color);
      visual.halo.material.blending = additive;
      visual.halo.material.opacity = (palette.dark ? 0.9 : 0.45) * fade;
      visual.halo.scale.setScalar(ui.hoverMessage === message ? 0.85 : 0.55);

      // trail: recent positions, fading towards the tail
      visual.history.unshift(visual.core.position.clone());
      if (visual.history.length > TRAIL) visual.history.length = TRAIL;

      const positions = visual.trail.geometry.attributes.position;
      const colors = visual.trail.geometry.attributes.color;
      const moving = message.state !== 'queued' && message.state !== 'work' && waitIndex < 0;

      for (let i = 0; i < TRAIL; i += 1) {
        const p = visual.history[Math.min(i, visual.history.length - 1)];

        positions.setXYZ(i, p.x, p.y, p.z);
        colors.setXYZW(i, visual.color.r, visual.color.g, visual.color.b, moving ? (1 - i / TRAIL) * 0.7 * fade : 0);
      }

      positions.needsUpdate = true;
      colors.needsUpdate = true;
      visual.trail.material.blending = additive;
      message.screen = toScreen(visual.core.position);
    }

    for (const id of [...visuals.keys()]) {
      if (!sim.messages.some((message) => message.id === id)) dropVisual(id);
    }

    // the stream glows brighter as it fills
    const fill = sim.queue.length / CAPACITY;

    tubeGlow.material.opacity = (palette.dark ? 0.12 : 0.06) + fill * (palette.dark ? 0.3 : 0.14);
    tubeGlow.material.blending = additive;

    sim.pods.forEach((state, index) => {
      const pod = pods[index];
      const down = isDown(sim, state);
      const hovered = ui.hoverPod === index;
      const flashAge = now - state.flashAt;
      const flash = flashAge < 650 ? (state.flash === 'ack' ? palette.ack : palette.redeliver) : null;

      pod.lift += ((down ? -0.22 : hovered ? 0.06 : 0) - pod.lift) * smooth;
      pod.group.position.y = POD.h / 2 + pod.lift;
      pod.material.color.copy(palette.bg3);
      pod.material.opacity = down ? 0.4 : 1;
      pod.material.emissive.copy(flash ?? palette.deliver).multiplyScalar(flash ? 0.3 * (1 - flashAge / 650) : hovered ? 0.12 : 0);
      pod.logo.material.opacity = down ? 0.15 : 0.95;

      let led = palette.ack;

      if (down) led = palette.dlq;
      else if (flash) led = flash;
      else if (state.message) led = palette.deliver;
      pod.ledMaterial.color.copy(led);

      // progress ring while handling
      const work = state.message?.state === 'work' ? clamp01((now - state.message.since) / (state.message.until - state.message.since)) : 0;

      pod.progress.geometry.setDrawRange(0, Math.max(0, Math.round(work * 65)));

      // a ring spreads over the floor when a pod acks or goes down
      const burstAge = down ? now - state.downAt : state.flash === 'ack' ? flashAge : Infinity;
      const burstT = burstAge / 900;

      if (burstT >= 0 && burstT < 1) {
        pod.burst.scale.setScalar(1 + burstT * 0.8);
        pod.burst.material.color.copy(state.flash === 'ack' && !down ? palette.ack : palette.dlq);
        pod.burst.material.opacity = 0.5 * (1 - burstT);
      } else {
        pod.burst.material.opacity = 0;
      }

      podLabels[index].textContent = state.manual ? 'down' : 'restarting';
      place(podLabels[index], toScreen(v3(POD_X, POD.h + 0.55, Z[index])), down);
    });

    for (const stepLabel of steps) place(stepLabel.el, toScreen(stepLabel.at));
    steps[1].el.textContent = sim.queue.length ? `stream · ${sim.queue.length} stored` : 'stream';

    if (!clicked) {
      place(hintLabel, toScreen(v3(POD_X + 1.2, 0, Z[2] + 1.0)), true);
      const ring = pods[1].burst;

      if (ring.material.opacity === 0) {
        const phase = (now / 1700) % 1;

        ring.scale.setScalar(1 + phase * 0.6);
        ring.material.color.copy(palette.deliver);
        ring.material.opacity = 0.45 * (1 - phase);
      }
    } else {
      hintLabel.hidden = true;
    }

    if (sim.deploy) {
      const done = Math.min(PODS, Math.floor((now - sim.deploy.start) / RESTART_MS) + 1);

      deployLabel.textContent = `rolling deploy ${done}/${PODS}`;
      place(deployLabel, toScreen(v3(POD_X + 0.9, 1.2, Z[0] - 1.0)), true);
    } else {
      deployLabel.hidden = true;
    }

    // tooltip
    const hovered = ui.hoverMessage;

    if (hovered && sim.messages.includes(hovered)) {
      const status = {
        in: 'published',
        queued: 'stored in the stream',
        out: 'delivered to a pod',
        work: 'handling · awaiting ack',
        retry: 'nak · back after backoff',
        ack: 'acked · removed from the stream',
      }[hovered.state];

      tip.replaceChildren(
        ...[
          [hovered.subject, ''],
          [`seq ${hovered.seq} · attempt ${hovered.attempt + 1}`, 'scene-tip-muted'],
          [status, hovered.state === 'ack' ? 'scene-tip-ack' : hovered.state === 'retry' || hovered.attempt > 0 ? 'scene-tip-redeliver' : 'scene-tip-deliver'],
        ].map(([text, cls]) => {
          const line = document.createElement('span');

          line.textContent = text;
          if (cls) line.className = cls;

          return line;
        }),
      );
      place(tip, { x: hovered.screen.x + 14, y: hovered.screen.y - 12 }, true, 'translate(0, -100%)');
    } else if (ui.hoverPod !== null) {
      tip.textContent = isDown(sim, sim.pods[ui.hoverPod]) ? 'click to start this pod' : 'click to take this pod down';
      place(tip, toScreen(v3(POD_X + 0.5, POD.h, Z[ui.hoverPod])), true, 'translate(8px, -100%)');
    } else {
      tip.hidden = true;
    }
  };

  /* ---- pointer -------------------------------------------------------------- */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pointer = null;

  const hitTest = () => {
    ui.hoverPod = null;
    ui.hoverMessage = null;

    if (pointer) {
      let best = 11;

      for (const message of sim.messages) {
        if (!message.screen) continue;

        const d = Math.hypot(message.screen.x - pointer.x, message.screen.y - pointer.y);

        if (d < best) {
          best = d;
          ui.hoverMessage = message;
        }
      }

      if (!ui.hoverMessage) {
        ndc.set((pointer.x / view.cw) * 2 - 1, -(pointer.y / view.ch) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);

        const hit = raycaster.intersectObjects(pods.map((pod) => pod.body), false)[0];

        if (hit) ui.hoverPod = hit.object.userData.pod;
      }
    }

    renderer.domElement.style.cursor = ui.hoverPod === null ? 'default' : 'pointer';
  };

  const onMove = (event) => {
    const rect = renderer.domElement.getBoundingClientRect();

    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onLeave = () => {
    pointer = null;
  };
  const onClick = (event) => {
    onMove(event);
    hitTest();

    if (ui.hoverPod === null) return;

    togglePod(sim, ui.hoverPod);

    if (!clicked) {
      clicked = true;
      rememberClicked();
    }
  };

  /* ---- loop ------------------------------------------------------------------ */

  let raf = 0;
  let last = 0;
  let visible = true;
  let statsAt = 0;

  const render = (dt) => {
    update(dt);
    renderer.render(scene, camera);
  };

  const tick = (ts) => {
    const dt = last ? Math.min(100, ts - last) : 16;

    last = ts;
    step(sim, dt);
    hitTest();
    render(dt);

    if (ts - statsAt > 400) {
      statsAt = ts;
      onStats({ ...sim.stats });
    }

    if (visible && !document.hidden) raf = requestAnimationFrame(tick);
  };

  const start = () => {
    cancelAnimationFrame(raf);
    last = 0;
    raf = requestAnimationFrame(tick);
  };

  frame();
  render(16);
  onStats({ ...sim.stats });

  const sizeObserver = new ResizeObserver(() => {
    frame();
    render(16);
  });
  const viewObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !reduce) start();
    else cancelAnimationFrame(raf);
  });
  const themeObserver = new MutationObserver(() => {
    palette = readPalette();
    applyPalette();
    render(16);
  });
  const onVisibility = () => {
    if (!document.hidden && visible && !reduce) start();
  };

  sizeObserver.observe(container);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  if (reduce) {
    logoTexture.onUpdate = () => render(16);
  } else {
    viewObserver.observe(container);
    document.addEventListener('visibilitychange', onVisibility);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('click', onClick);
    start();
  }

  return () => {
    cancelAnimationFrame(raf);
    sizeObserver.disconnect();
    viewObserver.disconnect();
    themeObserver.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('pointerleave', onLeave);
    renderer.domElement.removeEventListener('click', onClick);

    scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) object.material.dispose();
    });
    logoTexture.dispose();
    glow.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    overlay.replaceChildren();
  };
};

