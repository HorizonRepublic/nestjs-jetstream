import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ACK_MS, FALL_MS, PODS, RESTART_MS, SLOTS, createSim, isDown, liveTiles, step, togglePod } from './model';

/* The hero scene: the model from ./model drawn as an isometric log.

   Tiles are messages in a stream, oldest at the front. NestJS pods hover over
   the front of the log and reach a tile with a beam while they handle it. An
   ack sinks the tile into the floor; a nak leaves it in the log, glowing amber
   until it may be delivered again. */

const SPACING = 0.66;
const FRONT_X = 3.0;
const TILE = { w: 0.5, h: 0.14, d: 0.5, y: 0.1 };
const DROP = 2.4;
const POD = { w: 0.92, h: 0.5, d: 0.92 };
const POD_Y = 1.45;
const POD_POS = [
  [2.9, -1.7],
  [1.6, -1.7],
  [0.3, -1.7],
];
const REGION = {
  wide: { x0: 0.5, x1: 0.98, y0: 0.06, y1: 0.94 },
  narrow: { x0: 0.02, x1: 0.98, y0: 0.04, y1: 0.96 },
};
const HINT_KEY = 'jt-scene-clicked';

const easeOut = (t) => 1 - (1 - t) ** 3;
const tailX = FRONT_X - (SLOTS - 1) * SPACING;

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
    bg1: color('--jt-bg-1'),
    bg2: color('--jt-bg-2'),
    bg3: color('--jt-bg-3'),
    line: color('--jt-line-2'),
    faint: color('--jt-line-1'),
  };
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

/* A floor grid whose lines fade out away from the centre. */
const makeGrid = (palette) => {
  const positions = [];
  const colors = [];
  const reach = 9;
  const push = (x1, z1, x2, z2) => {
    positions.push(x1, 0.002, z1, x2, 0.002, z2);

    for (const [x, z] of [
      [x1, z1],
      [x2, z2],
    ]) {
      const fade = Math.max(0, 1 - Math.hypot(x + 1, z) / reach);

      colors.push(palette.line.r, palette.line.g, palette.line.b, fade * 0.55);
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

export const createScene = ({ container, overlay, logoUrl, reduce, onStats }) => {
  const sim = createSim();
  let palette = readPalette();
  let clicked = readClicked() || reduce;

  /* ---- renderer, camera, light -------------------------------------------- */

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const viewDir = new THREE.Vector3(1, 1.08, 1).normalize();
  const target = new THREE.Vector3(-1, 0.4, -0.6);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.6);
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);

  sun.position.set(-3, 9, 5);
  sun.target.position.set(-1, 0, -0.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 9;
  sun.shadow.camera.bottom = -9;
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0005;
  scene.add(hemi, sun, sun.target);

  /* ---- floor, log, pods --------------------------------------------------- */

  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.3 }));

  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  let grid = makeGrid(palette);

  scene.add(grid);

  // the stream itself: a low slab the tiles rest on
  const railLength = (SLOTS - 1) * SPACING + 0.9;
  const railMaterial = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  const rail = new THREE.Mesh(new RoundedBoxGeometry(railLength, 0.06, 0.82, 3, 0.03), railMaterial);

  rail.position.set((FRONT_X + tailX) / 2, 0.03, 0);
  rail.receiveShadow = true;
  scene.add(rail);

  const tileGeometry = new RoundedBoxGeometry(TILE.w, TILE.h, TILE.d, 4, 0.05);
  const podGeometry = new RoundedBoxGeometry(POD.w, POD.h, POD.d, 5, 0.1);
  const ledGeometry = new THREE.SphereGeometry(0.04, 16, 12);
  const beamGeometry = new THREE.CylinderGeometry(0.012, 0.012, 1, 8, 1, true);
  const logoTexture = new THREE.TextureLoader().load(logoUrl);

  logoTexture.colorSpace = THREE.SRGBColorSpace;
  logoTexture.anisotropy = 4;

  const pods = POD_POS.map(([x, z]) => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.55, transparent: true });
    const body = new THREE.Mesh(podGeometry, material);
    const group = new THREE.Group();
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.42),
      new THREE.MeshBasicMaterial({ map: logoTexture, transparent: true, depthWrite: false }),
    );
    const ledMaterial = new THREE.MeshBasicMaterial();
    const led = new THREE.Mesh(ledGeometry, ledMaterial);
    const beam = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));

    body.castShadow = true;
    logo.rotation.x = -Math.PI / 2;
    logo.rotation.z = Math.PI / 4;
    logo.position.y = POD.h / 2 + 0.002;
    led.position.set(POD.w / 2 - 0.16, 0.02, POD.d / 2 + 0.005);
    group.add(body, logo, led);
    group.position.set(x, POD_Y, z);
    body.userData.pod = POD_POS.findIndex((p) => p[0] === x);
    scene.add(group, beam);

    return { group, body, material, logo, ledMaterial, beam, base: new THREE.Vector3(x, POD_Y, z), lift: 0 };
  });

  // until the first click, ripples around the middle pod say pods can be clicked
  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.76, 64),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );

  ripple.rotation.x = -Math.PI / 2;
  scene.add(ripple);

  const tiles = new Map();

  const applyPalette = () => {
    railMaterial.color.copy(palette.bg2);
    shadowCatcher.material.opacity = palette.dark ? 0.38 : 0.14;
    hemi.color.set(0xffffff);
    hemi.groundColor.copy(palette.bg0);
    hemi.intensity = palette.dark ? 1.5 : 2.3;
    sun.intensity = palette.dark ? 1.6 : 1.4;
    ripple.material.color.copy(palette.deliver);

    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
    grid = makeGrid(palette);
    scene.add(grid);
  };

  applyPalette();

  /* ---- overlay: labels and tooltips as plain HTML ----------------------- */

  const makeLabel = (className) => {
    const el = document.createElement('div');

    el.className = className;
    el.hidden = true;
    overlay.appendChild(el);

    return el;
  };

  const podLabels = pods.map(() => makeLabel('scene-label scene-label--down'));
  const deployLabel = makeLabel('scene-label scene-label--deploy');
  const hintLabel = makeLabel('scene-label scene-label--hint');
  const tip = makeLabel('scene-tip');

  hintLabel.textContent = 'click a pod to take it down';

  const toScreen = (vector) => {
    const v = vector.clone().project(camera);

    return { x: ((v.x + 1) / 2) * view.cw, y: ((1 - v.y) / 2) * view.ch };
  };

  const place = (el, at, show = true) => {
    el.hidden = !show;
    if (show) el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, -50%)`;
  };

  /* ---- framing ------------------------------------------------------------ */

  const view = { cw: 1, ch: 1 };

  const frame = () => {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const region = cw < 760 ? REGION.narrow : REGION.wide;
    const aspect = cw / ch;

    view.cw = cw;
    view.ch = ch;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(cw, ch, false);
    renderer.domElement.style.width = `${cw}px`;
    renderer.domElement.style.height = `${ch}px`;

    camera.position.copy(target).addScaledVector(viewDir, 20);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateMatrixWorld();

    // the scene's extent in view space, from the points that bound it
    const points = [
      [tailX - 0.6, 0, -0.5],
      [tailX - 0.6, DROP, 0],
      [FRONT_X + 0.6, 0, 0.6],
      ...POD_POS.flatMap(([x, z]) => [
        [x - 0.6, POD_Y + 0.4, z - 0.6],
        [x + 0.6, POD_Y - 0.3, z + 0.6],
      ]),
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    const rw = region.x1 - region.x0;
    const rh = region.y1 - region.y0;
    const height = Math.max((maxY - minY) / rh, (maxX - minX) / (rw * aspect)) * 1.04;
    const width = height * aspect;

    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;

    // slide the camera so the scene sits in its region of the canvas
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const fx = (region.x0 + region.x1) / 2;
    const fy = (region.y0 + region.y1) / 2;
    const shiftX = cx - (fx - 0.5) * width;
    const shiftY = cy + (fy - 0.5) * height;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

    camera.position.addScaledVector(right, shiftX).addScaledVector(up, shiftY);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  /* ---- per-frame update --------------------------------------------------- */

  const ui = { hoverPod: null, hoverTile: null };
  const tmp = new THREE.Color();

  const tileMesh = (tile) => {
    let mesh = tiles.get(tile.id);

    if (!mesh) {
      mesh = new THREE.Mesh(tileGeometry, new THREE.MeshStandardMaterial({ roughness: 0.45, transparent: true }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.tile = tile;
      mesh.userData.x = null;
      tiles.set(tile.id, mesh);
      scene.add(mesh);
    }

    return mesh;
  };

  const tileColor = (tile) => {
    if (tile.state === 'acked') return palette.ack;
    if (tile.state === 'delivered') return palette.deliver;
    if (tile.retrying) return palette.redeliver;

    return tmp.copy(palette.bg3).lerp(palette.deliver, 0.32);
  };

  const update = (dt) => {
    const now = sim.time;
    const live = liveTiles(sim);
    const smooth = 1 - Math.exp(-dt / 140);

    // tiles: slide toward their slot, drop in when new, sink when acked
    for (const tile of sim.tiles) {
      const mesh = tileMesh(tile);
      const slot = live.indexOf(tile);
      const targetX = slot >= 0 ? FRONT_X - slot * SPACING : mesh.userData.x;

      if (mesh.userData.x === null) mesh.userData.x = targetX;
      mesh.userData.x += (targetX - mesh.userData.x) * smooth;

      let y = TILE.y;
      let opacity = 1;
      let emissive = 0;
      const age = now - tile.bornAt;

      if (age < FALL_MS) y += DROP * (1 - easeOut(age / FALL_MS));

      if (tile.state === 'delivered') {
        y += 0.1;
        emissive = 0.45;
      } else if (tile.state === 'acked') {
        const t = Math.min(1, (now - tile.ackAt) / ACK_MS);

        y -= 0.22 * t;
        opacity = 1 - t;
        emissive = 0.5 * (1 - t);
      } else if (tile.retrying && now < tile.readyAt) {
        emissive = 0.25 + 0.2 * Math.sin(now / 160);
      } else if (tile.retrying) {
        emissive = 0.15;
      }

      const color = tileColor(tile);

      mesh.material.color.lerp(color, Math.min(1, smooth * 2));
      mesh.material.emissive.copy(color).multiplyScalar(emissive);
      mesh.material.opacity = opacity;
      mesh.position.set(mesh.userData.x, y, 0);
      mesh.scale.setScalar(ui.hoverTile === tile ? 1.12 : 1);
    }

    for (const [id, mesh] of tiles) {
      if (!sim.tiles.some((tile) => tile.id === id)) {
        scene.remove(mesh);
        mesh.material.dispose();
        tiles.delete(id);
      }
    }

    // pods: float, dim and sink when down, reach the tile they handle
    sim.pods.forEach((state, index) => {
      const pod = pods[index];
      const down = isDown(sim, state);
      const hovered = ui.hoverPod === index;
      const flashAge = now - state.flashAt;
      const flash = flashAge < 650 ? (state.flash === 'ack' ? palette.ack : palette.redeliver) : null;
      const lift = down ? -0.5 : hovered ? 0.08 : 0;

      pod.lift += (lift - pod.lift) * smooth;
      pod.group.position.set(pod.base.x, pod.base.y + pod.lift + Math.sin(now / 900 + index) * 0.02, pod.base.z);

      pod.material.color.copy(palette.bg3);
      pod.material.opacity = down ? 0.45 : 1;
      pod.material.emissive.copy(flash ?? palette.deliver).multiplyScalar(flash ? 0.35 * (1 - flashAge / 650) : hovered ? 0.12 : 0);
      pod.logo.material.opacity = down ? 0.2 : 0.95;

      let led = palette.ack;

      if (down) led = palette.dlq;
      else if (flash) led = flash;
      else if (state.tile) led = palette.deliver;
      pod.ledMaterial.color.copy(led);

      // the beam from the pod to the tile it is handling
      const tile = state.tile;
      const mesh = tile && tiles.get(tile.id);

      if (mesh && !down) {
        const from = pod.group.position.clone().add(new THREE.Vector3(0, -POD.h / 2, 0));
        const to = mesh.position.clone().add(new THREE.Vector3(0, TILE.h / 2, 0));
        const grow = Math.min(1, (now - tile.since) / 160);
        const end = from.clone().lerp(to, grow);
        const length = from.distanceTo(end);

        pod.beam.position.copy(from).lerp(end, 0.5);
        pod.beam.scale.set(1, Math.max(0.001, length), 1);
        pod.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(from).normalize());
        pod.beam.material.color.copy(palette.deliver);
        pod.beam.material.opacity = 0.75;
      } else {
        pod.beam.material.opacity = Math.max(0, pod.beam.material.opacity - dt / 200);
      }

      // labels
      const above = toScreen(pod.group.position.clone().add(new THREE.Vector3(0, 0.55, 0)));

      podLabels[index].textContent = state.manual ? 'down' : 'restarting';
      place(podLabels[index], above, down);
    });

    // hint ripple around the middle pod
    if (!clicked) {
      const phase = (now / 1800) % 1;
      const middle = pods[1].group.position;

      ripple.visible = true;
      ripple.position.set(middle.x, middle.y - POD.h / 2, middle.z);
      ripple.scale.setScalar(1 + phase * 0.6);
      ripple.material.opacity = 0.55 * (1 - phase);
      place(hintLabel, toScreen(pods[0].group.position.clone().add(new THREE.Vector3(0.9, -1.1, 0.9))), true);
    } else {
      ripple.visible = false;
      hintLabel.hidden = true;
    }

    if (sim.deploy) {
      const done = Math.min(PODS, Math.floor((now - sim.deploy.start) / RESTART_MS) + 1);

      deployLabel.textContent = `rolling deploy ${done}/${PODS}`;
      place(deployLabel, toScreen(pods[1].group.position.clone().add(new THREE.Vector3(-0.6, 1.0, -0.6))), true);
    } else {
      deployLabel.hidden = true;
    }

    // tooltip
    if (ui.hoverTile && sim.tiles.includes(ui.hoverTile)) {
      const tile = ui.hoverTile;
      const mesh = tiles.get(tile.id);
      let status = 'stored';

      if (tile.state === 'delivered') status = 'delivered · awaiting ack';
      else if (tile.state === 'acked') status = 'acked · removed from the stream';
      else if (tile.retrying) status = sim.time < tile.readyAt ? 'nak · redelivery after backoff' : 'stored · ready to redeliver';

      tip.innerHTML = '';

      for (const [text, cls] of [
        [tile.subject, ''],
        [`seq ${tile.seq} · attempt ${tile.attempt + 1}`, 'scene-tip-muted'],
        [status, `scene-tip-${tile.state === 'acked' ? 'ack' : tile.state === 'delivered' ? 'deliver' : tile.retrying ? 'redeliver' : 'muted'}`],
      ]) {
        const line = document.createElement('span');

        line.textContent = text;
        if (cls) line.className = cls;
        tip.appendChild(line);
      }

      const at = toScreen(mesh.position.clone().add(new THREE.Vector3(0, 0.3, 0)));

      tip.hidden = false;
      tip.style.transform = `translate(${Math.round(at.x + 14)}px, ${Math.round(at.y - 14)}px) translate(0, -100%)`;
    } else if (ui.hoverPod !== null) {
      const at = toScreen(pods[ui.hoverPod].group.position);

      tip.textContent = isDown(sim, sim.pods[ui.hoverPod]) ? 'click to start this pod' : 'click to take this pod down';
      tip.hidden = false;
      tip.style.transform = `translate(${Math.round(at.x + 30)}px, ${Math.round(at.y - 20)}px) translate(0, -100%)`;
    } else {
      tip.hidden = true;
    }
  };

  /* ---- pointer ------------------------------------------------------------ */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pointer = null;

  const hitTest = () => {
    ui.hoverPod = null;
    ui.hoverTile = null;

    if (pointer) {
      ndc.set((pointer.x / view.cw) * 2 - 1, -(pointer.y / view.ch) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);

      const hits = raycaster.intersectObjects([...pods.map((pod) => pod.body), ...tiles.values()], false);
      const hit = hits[0]?.object;

      if (hit?.userData.tile) ui.hoverTile = hit.userData.tile;
      else if (hit && hit.userData.pod !== undefined) ui.hoverPod = hit.userData.pod;
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

  /* ---- loop --------------------------------------------------------------- */

  let raf = 0;
  let last = 0;
  let visible = true;
  let statsAt = 0;

  const render = (dt) => {
    update(dt);
    renderer.render(scene, camera);
  };

  const tick = (ts) => {
    const dt = last ? Math.min(50, ts - last) : 16;

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
    if (reduce) render(16);
  });
  const onVisibility = () => {
    if (!document.hidden && visible && !reduce) start();
  };

  sizeObserver.observe(container);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  if (reduce) {
    for (let t = 0; t < 9000; t += 16) step(sim, 16);
    for (let i = 0; i < 30; i += 1) update(50);
    renderer.render(scene, camera);
    onStats({ ...sim.stats });
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
    renderer.dispose();
    renderer.domElement.remove();
    overlay.replaceChildren();
  };
};
