import React, { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import './styles.css';

/* A small JetStream system, drawn as a flat schematic behind the hero. The
   stream is a closed loop and a message stays on it until a pod acks it. Services feed the loop from the left; NestJS pods along the right
   take messages off as they pass. An ack sends a message out to the right; a
   nak, or a pod going down, sends it back onto the loop, where it rides until
   its retry delay is over. Every message gets acked in the end.

   Every message moves only along a line of the schematic. */

/* ---- layout ------------------------------------------------------------- */

const MODEL = { w: 470, h: 240 };
const BELT_Z = 0;
const GAP = 13;
const LANES = [70, 120, 170];
const LOOP = { x0: 100, x1: 300, y0: 22, y1: 218, r: 34 };
const POD_X = 372;
const DOCK_X = 26;
const EXIT_X = 470;

const FAIL_CHANCE = [0.3, 0.2, 0];
const RETRY_MS = 2000;
const RESTART_MS = 3400;
const MANUAL_DOWN_MS = 20000;
const DEPLOY_EVERY_MS = 25000;
const SUBJECTS = ['orders.created', 'payments.captured', 'users.updated', 'emails.send', 'stock.reserved'];
const HINT_KEY = 'jt-scene-clicked';

/* ---- paths -------------------------------------------------------------- */

const p3 = (x, y, z = BELT_Z) => ({ x, y, z });

const makePath = (points, closed = false) => {
  const pts = closed ? [...points, points[0]] : points;
  const lengths = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y, p.z - pts[i].z));

  return { points, pts, lengths, length: lengths.reduce((a, b) => a + b, 0), closed };
};

const pointAt = (path, s) => {
  let left = path.closed ? ((s % path.length) + path.length) % path.length : Math.max(0, Math.min(s, path.length));

  for (let i = 0; i < path.lengths.length; i += 1) {
    if (left <= path.lengths[i] || i === path.lengths.length - 1) {
      const t = path.lengths[i] ? Math.min(1, left / path.lengths[i]) : 0;
      const a = path.pts[i];
      const c = path.pts[i + 1];

      return { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t };
    }

    left -= path.lengths[i];
  }

  return path.pts.at(-1);
};

/* The loop: a rounded rectangle, travelled clockwise from the top-left. */
const loopPoints = ({ x0, x1, y0, y1, r }) => {
  const points = [];
  const arc = (cx, cy, from) => {
    for (let i = 1; i <= 12; i += 1) {
      const a = from + (i / 12) * (Math.PI / 2);

      points.push(p3(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  };

  points.push(p3(x0 + r, y0));
  points.push(p3(x1 - r, y0));
  arc(x1 - r, y0 + r, -Math.PI / 2);
  points.push(p3(x1, y1 - r));
  arc(x1 - r, y1 - r, 0);
  points.push(p3(x0 + r, y1));
  arc(x0 + r, y1 - r, Math.PI / 2);
  points.push(p3(x0, y0 + r));
  arc(x0 + r, y0 + r, Math.PI);
  points.pop();

  return points;
};

/* Where on the loop a point on its centreline sits, as a distance along it. */
const loopS = (path, x, y) => {
  let best = 0;
  let bestD = Infinity;

  for (let s = 0; s < path.length; s += 0.5) {
    const p = pointAt(path, s);
    const d = Math.hypot(p.x - x, p.y - y);

    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }

  return best;
};

/* ---- belts -------------------------------------------------------------- */

const belt = (path, speed) => ({ path, speed, items: [] });

const advance = (b, dt) => {
  b.items.forEach((item, index) => {
    const limit = index === 0 ? b.path.length : b.items[index - 1].s - GAP;

    if (item.s < limit) item.s = Math.min(limit, item.s + b.speed * dt);
  });
};

const atEnd = (b) => b.items.length > 0 && b.items[0].s >= b.path.length - 0.01;
const hasRoom = (b) => !b.items.length || b.items.at(-1).s >= GAP;
const put = (b, item, s = 0) => {
  item.s = s;
  item.belt = b;
  b.items.push(item);
};
const take = (b) => b.items.shift();

const buildFloor = () => {
  const loop = belt(makePath(loopPoints(LOOP), true), 0.2);

  return {
    loop,
    docks: LANES.map((y) => ({ x: DOCK_X, y })),
    pods: LANES.map((y) => ({ x: POD_X, y })),
    inputs: LANES.map((y) => belt(makePath([p3(DOCK_X, y), p3(LOOP.x0, y)]), 0.1)),
    merges: LANES.map((y) => loopS(loop.path, LOOP.x0, y)),
    ins: LANES.map((y) => belt(makePath([p3(LOOP.x1, y), p3(POD_X, y)]), 0.26)),
    outs: LANES.map((y) => belt(makePath([p3(POD_X, y), p3(LOOP.x1, y)]), 0.2)),
    offtakes: LANES.map((y) => loopS(loop.path, LOOP.x1, y)),
    outputs: LANES.map((y) => belt(makePath([p3(POD_X, y), p3(EXIT_X, y)]), 0.12)),
  };
};

/* ---- the model ---------------------------------------------------------- */

const createSim = () => ({
  time: 0,
  nextId: 1,
  replicas: LANES.map(() => ({ busy: null, flash: null, flashAt: -1e9, downUntil: 0, manual: false })),
  nextSpawn: 300,
  nextBurst: 4000,
  burstLeft: 0,
  burstAt: 0,
  nextRestart: 16000,
  nextDeploy: 6000,
  deploy: null,
  spawnTurn: 0,
  stats: { published: 0, retried: 0, acked: 0 },
});

const isDown = (sim, replica) => sim.time < replica.downUntil;

const circularGap = (a, b, length) => {
  const d = Math.abs(a - b) % length;

  return Math.min(d, length - d);
};

const loopFree = (floor, s) => floor.loop.items.every((item) => circularGap(item.s, s, floor.loop.path.length) >= GAP);

/* No ack: the message goes back onto the loop and may be taken again once its
   retry delay is over. */
const redeliver = (sim, floor, item, index) => {
  sim.stats.retried += 1;
  item.processing = false;
  item.retrying = true;
  item.readyAt = sim.time + RETRY_MS;
  put(floor.outs[index], item);
};

const takeDown = (sim, floor, index, ms, manual) => {
  const replica = sim.replicas[index];

  replica.downUntil = sim.time + ms;
  replica.manual = manual;

  const item = replica.busy;

  if (item?.processing) {
    replica.busy = null;
    redeliver(sim, floor, item, index);
  }
};

const togglePod = (sim, floor, index) => {
  const replica = sim.replicas[index];

  if (isDown(sim, replica)) {
    replica.downUntil = sim.time;
    replica.manual = false;
  } else {
    takeDown(sim, floor, index, MANUAL_DOWN_MS, true);
  }
};

const podFree = (sim, floor, index) => {
  const replica = sim.replicas[index];

  return !replica.busy && !isDown(sim, replica) && !floor.ins[index].items.length && !floor.outs[index].items.length;
};

const step = (sim, floor, dt) => {
  sim.time += dt;
  const now = sim.time;

  const spawn = () => {
    for (let tries = 0; tries < LANES.length; tries += 1) {
      const dock = (sim.spawnTurn + tries) % LANES.length;

      if (hasRoom(floor.inputs[dock])) {
        const id = sim.nextId++;

        put(floor.inputs[dock], {
          id,
          subject: SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)],
          seq: 4812000 + id,
          attempt: 0,
        });
        sim.stats.published += 1;
        sim.spawnTurn = (dock + 1 + Math.floor(Math.random() * 2)) % LANES.length;

        return;
      }
    }
  };

  if (now >= sim.nextSpawn) {
    spawn();
    sim.nextSpawn = now + 1000 + Math.random() * 900;
  }

  if (now >= sim.nextBurst) {
    sim.burstLeft = 5;
    sim.nextBurst = now + 11000 + Math.random() * 6000;
  }

  if (sim.burstLeft && now >= sim.burstAt) {
    spawn();
    sim.burstLeft -= 1;
    sim.burstAt = now + 160;
  }

  // a rolling deploy: each running pod restarts in turn while the stream holds the work
  if (now >= sim.nextDeploy) {
    sim.deploy = { start: now, done: -1 };
    sim.nextDeploy = now + DEPLOY_EVERY_MS;
    sim.nextRestart = Math.max(sim.nextRestart, now + LANES.length * RESTART_MS + 6000);
  }

  if (sim.deploy) {
    const index = Math.floor((now - sim.deploy.start) / RESTART_MS);

    if (index < LANES.length && index > sim.deploy.done) {
      sim.deploy.done = index;
      if (!isDown(sim, sim.replicas[index])) takeDown(sim, floor, index, RESTART_MS, false);
    } else if (now - sim.deploy.start > LANES.length * RESTART_MS + 600) {
      sim.deploy = null;
    }
  }

  if (now >= sim.nextRestart) {
    const up = LANES.map((_, index) => index).filter((index) => !isDown(sim, sim.replicas[index]));

    if (up.length > 1) takeDown(sim, floor, up[Math.floor(Math.random() * up.length)], RESTART_MS, false);
    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  for (const b of [...floor.inputs, ...floor.ins, ...floor.outs, ...floor.outputs]) advance(b, dt);

  // the loop always moves; a pod takes a ready message as it passes the pod's offtake
  const length = floor.loop.path.length;
  const ds = floor.loop.speed * dt;

  for (const item of [...floor.loop.items]) {
    const before = item.s;

    item.s = (item.s + ds) % length;

    for (let index = 0; index < LANES.length; index += 1) {
      const ahead = (((floor.offtakes[index] - before) % length) + length) % length;

      if (ahead > 0 && ahead <= ds && now >= (item.readyAt ?? 0) && podFree(sim, floor, index)) {
        floor.loop.items.splice(floor.loop.items.indexOf(item), 1);
        sim.replicas[index].busy = item;
        put(floor.ins[index], item);
        break;
      }
    }
  }

  // onto the loop: services at the left, pods handing back at the right
  floor.inputs.forEach((input, index) => {
    if (atEnd(input) && loopFree(floor, floor.merges[index])) put(floor.loop, take(input), floor.merges[index]);
  });
  floor.outs.forEach((out, index) => {
    if (atEnd(out) && loopFree(floor, floor.offtakes[index])) put(floor.loop, take(out), floor.offtakes[index]);
  });

  sim.replicas.forEach((replica, index) => {
    if (!isDown(sim, replica)) replica.manual = false;

    // arrival: a pod that went down meanwhile hands the message straight back
    if (atEnd(floor.ins[index])) {
      const item = take(floor.ins[index]);

      if (isDown(sim, replica)) {
        replica.busy = null;
        redeliver(sim, floor, item, index);
      } else {
        item.processing = true;
        item.since = now;
        item.until = now + 350 + Math.random() * 450;
        item.belt = null;
        item.at = floor.pods[index];
      }
    }

    const item = replica.busy;

    if (item?.processing && now >= item.until) {
      item.processing = false;
      replica.busy = null;

      if (Math.random() < FAIL_CHANCE[Math.min(item.attempt, FAIL_CHANCE.length - 1)]) {
        item.attempt += 1;
        replica.flash = 'redeliver';
        replica.flashAt = now;
        redeliver(sim, floor, item, index);
      } else {
        item.retrying = false;
        item.acked = true;
        sim.stats.acked += 1;
        replica.flash = 'ack';
        replica.flashAt = now;
        put(floor.outputs[index], item);
      }
    }
  });

  floor.outputs.forEach((output) => {
    if (atEnd(output)) take(output);
  });

};

const beltsOf = (floor) => [floor.loop, ...floor.inputs, ...floor.ins, ...floor.outs, ...floor.outputs];

const itemsOf = (sim, floor) => {
  const all = [];

  for (const b of beltsOf(floor)) all.push(...b.items);
  for (const replica of sim.replicas) if (replica.busy?.processing) all.push(replica.busy);

  return all;
};

/* ---- rendering ---------------------------------------------------------- */

const NODE = { dock: { across: 40, along: 18 }, pod: { across: 46, along: 30 } };

const readPalette = () => {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();

  return {
    dark: document.documentElement.dataset.theme === 'dark',
    deliver: token('--jt-state-deliver'),
    deliverSoft: token('--jt-deliver-soft'),
    redeliver: token('--jt-state-redeliver'),
    ack: token('--jt-state-ack'),
    dlq: token('--jt-state-dlq'),
    line: token('--jt-line-2'),
    strong: token('--jt-line-3'),
    surface: token('--jt-bg-1'),
    ink: token('--jt-fg-0'),
    label: token('--jt-fg-3'),
    mono: token('--jt-font-mono') || 'monospace',
  };
};

/* Flat projection. Vertical: the flow runs down the screen, lanes across it. */
const makeProjector = (cw, ch, region, vertical) => {
  const pad = 24;
  const w = (vertical ? MODEL.h : MODEL.w) + pad * 2;
  const h = (vertical ? MODEL.w : MODEL.h) + pad * 2;
  const rw = cw * (region.x1 - region.x0);
  const rh = ch * (region.y1 - region.y0);
  const k = Math.min(rw / w, rh / h);
  const ox = cw * region.x0 + (rw - w * k) / 2 + pad * k;
  const oy = ch * region.y0 + (rh - h * k) / 2 + pad * k;

  const project = (x, y) => (vertical ? { x: ox + y * k, y: oy + x * k } : { x: ox + x * k, y: oy + y * k });

  project.k = k;
  project.vertical = vertical;

  return project;
};

/* A node's rectangle on screen: `along` follows the flow, `across` the lanes. */
const nodeRect = (project, at, size) => {
  const c = project(at.x, at.y);
  const w = (project.vertical ? size.across : size.along) * project.k;
  const h = (project.vertical ? size.along : size.across) * project.k;

  return { x: c.x - w / 2, y: c.y - h / 2, w, h, cx: c.x, cy: c.y };
};

const label = (ctx, palette, value, x, y, align = 'center', color = palette.label, weight = 400) => {
  ctx.save();
  ctx.font = `${weight} 11px ${palette.mono}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y);
  ctx.restore();
};

const tooltip = (ctx, palette, lines, x, y) => {
  ctx.font = `11px ${palette.mono}`;
  const width = Math.max(...lines.map((line) => ctx.measureText(line.text).width)) + 18;
  const height = lines.length * 16 + 10;
  const left = x + 12;
  const top = y - height - 8;

  ctx.save();
  ctx.fillStyle = palette.surface;
  ctx.strokeStyle = palette.line;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 6);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, index) => {
    ctx.fillStyle = line.color ?? palette.ink;
    ctx.fillText(line.text, left + 9, top + 18 + index * 16);
  });
  ctx.restore();
};

const strokePath = (ctx, project, path) => {
  ctx.beginPath();
  path.points.forEach((p, i) => {
    const q = project(p.x, p.y);

    if (i) ctx.lineTo(q.x, q.y);
    else ctx.moveTo(q.x, q.y);
  });
  if (path.closed) ctx.closePath();
};

/* A line that fades out where it leaves the schematic. */
const fadingLine = (ctx, a, b, color) => {
  const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);

  g.addColorStop(0, color);
  g.addColorStop(1, 'transparent');
  ctx.strokeStyle = g;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
};

const colorOf = (item, palette) => {
  if (item.acked) return palette.ack;
  if (item.retrying || item.attempt > 0) return palette.redeliver;

  return palette.deliver;
};

const positionOf = (item) => (item.processing ? item.at : pointAt(item.belt.path, item.s));

const statusOf = (sim, replica, palette) => {
  if (isDown(sim, replica)) return palette.dlq;
  if (sim.time - replica.flashAt < 600) return palette[replica.flash];
  if (replica.busy) return palette.deliver;

  return palette.ack;
};

const drawNode = (ctx, rect, { stroke, dashed = false, alpha = 1, fill }) => {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 6);
  ctx.fillStyle = fill;
  ctx.fill();
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
};

const drawPod = (ctx, project, palette, sim, floor, index, logo, ui) => {
  const replica = sim.replicas[index];
  const down = isDown(sim, replica);
  const rect = nodeRect(project, floor.pods[index], NODE.pod);
  const flashing = !down && sim.time - replica.flashAt < 600;
  const hovered = ui.hoverPod === index;
  let stroke = hovered ? palette.deliver : palette.strong;

  if (down) stroke = palette.dlq;
  else if (flashing) stroke = palette[replica.flash];

  drawNode(ctx, rect, { stroke, dashed: down, fill: palette.surface, alpha: down ? 0.8 : 1 });

  if (logo) {
    const size = Math.min(rect.w, rect.h) * 0.5;

    ctx.save();
    ctx.globalAlpha = down ? 0.25 : 0.9;
    ctx.drawImage(logo, rect.cx - size / 2, rect.cy - size / 2, size, size);
    ctx.restore();
  }

  // status lamp in the corner
  const color = statusOf(sim, replica, palette);

  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(rect.x + rect.w - 7, rect.y + 7, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (down) label(ctx, palette, replica.manual ? 'down' : 'restarting', rect.cx, rect.y + rect.h + 12, 'center', palette.dlq, 600);

  replica.rect = rect;
};

const drawHint = (ctx, palette, sim, floor, ui) => {
  if (ui.clicked) return;

  const rect = sim.replicas[1].rect;

  if (!rect) return;

  for (let i = 0; i < 2; i += 1) {
    const phase = ((sim.time / 1800 + i / 2) % 1 + 1) % 1;
    const grow = phase * 12;

    ctx.save();
    ctx.strokeStyle = palette.deliver;
    ctx.globalAlpha = 0.5 * (1 - phase);
    ctx.beginPath();
    ctx.roundRect(rect.x - grow, rect.y - grow, rect.w + grow * 2, rect.h + grow * 2, 6 + grow);
    ctx.stroke();
    ctx.restore();
  }
};

const draw = (ctx, sim, floor, view, palette, logo, ui) => {
  const { project, cw, ch } = view;
  const k = project.k;

  ctx.clearRect(0, 0, cw, ch);
  ctx.lineWidth = 1;

  // lines of the schematic
  ctx.strokeStyle = palette.line;
  for (const b of [...floor.inputs, ...floor.ins]) {
    strokePath(ctx, project, b.path);
    ctx.stroke();
  }
  for (const b of floor.outputs) fadingLine(ctx, project(POD_X, b.path.points[0].y), project(EXIT_X, b.path.points[0].y), palette.line);

  // the stream
  strokePath(ctx, project, floor.loop.path);
  ctx.fillStyle = palette.deliverSoft;
  ctx.globalAlpha = 0.5;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = palette.strong;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineWidth = 1;

  // nodes
  for (const d of floor.docks) drawNode(ctx, nodeRect(project, d, NODE.dock), { stroke: palette.strong, fill: palette.surface });
  floor.pods.forEach((_, index) => drawPod(ctx, project, palette, sim, floor, index, logo, ui));
  drawHint(ctx, palette, sim, floor, ui);

  // messages
  const r = Math.max(2.6, 3.2 * k);

  for (const item of itemsOf(sim, floor)) {
    const at = project(positionOf(item).x, positionOf(item).y);
    const color = colorOf(item, palette);
    let alpha = 1;

    if (item.acked && item.belt) alpha = Math.max(0, 1 - item.s / item.belt.path.length);

    ctx.save();
    ctx.globalAlpha = alpha * 0.18;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fill();

    if (ui.hoverItem === item) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    item.screen = at;
  }

  // three quiet labels, and what is happening right now
  const first = nodeRect(project, floor.docks[0], NODE.dock);
  const lastPod = nodeRect(project, floor.pods[LANES.length - 1], NODE.pod);
  const centre = project((LOOP.x0 + LOOP.x1) / 2, (LOOP.y0 + LOOP.y1) / 2);
  const stored = floor.loop.items.length;

  if (project.vertical) {
    label(ctx, palette, 'services', first.x - 10, first.cy, 'right');
    label(ctx, palette, 'NestJS pods', lastPod.x + lastPod.w + 10, lastPod.cy, 'left');
  } else {
    label(ctx, palette, 'services', first.cx, first.y - 12);
    label(ctx, palette, 'NestJS pods', lastPod.cx, lastPod.y + lastPod.h + 14);
  }

  label(ctx, palette, stored ? `stream · ${stored}` : 'stream', centre.x, centre.y, 'center', palette.deliver);

  if (sim.deploy) {
    const done = Math.min(LANES.length, Math.floor((sim.time - sim.deploy.start) / RESTART_MS) + 1);
    const pod = nodeRect(project, floor.pods[0], NODE.pod);
    const at = project.vertical ? { x: pod.x - 10, y: pod.cy, align: 'right' } : { x: pod.cx, y: pod.y - 14, align: 'center' };

    label(ctx, palette, `rolling deploy ${done}/${LANES.length}`, at.x, at.y, at.align, palette.deliver, 600);
  }

  const hovered = ui.hoverItem;

  if (hovered?.screen) {
    let status = 'on its way';

    if (hovered.acked) status = 'acked';
    else if (hovered.processing) status = 'handling';
    else if (hovered.belt === floor.loop) status = hovered.retrying ? 'stored · redelivery after backoff' : 'stored';
    else if (floor.ins.includes(hovered.belt)) status = 'delivered';
    else if (floor.outs.includes(hovered.belt)) status = 'nak · back to the stream';

    tooltip(
      ctx,
      palette,
      [
        { text: hovered.subject },
        { text: `seq ${hovered.seq} · attempt ${hovered.attempt + 1}`, color: palette.label },
        { text: status, color: colorOf(hovered, palette) },
      ],
      hovered.screen.x,
      hovered.screen.y,
    );
  } else if (ui.hoverPod !== null) {
    const rect = sim.replicas[ui.hoverPod].rect;
    const down = isDown(sim, sim.replicas[ui.hoverPod]);

    tooltip(ctx, palette, [{ text: down ? 'click to start this pod' : 'click to take this pod down' }], rect.x + rect.w, rect.y);
  }
};

const REGION = {
  wide: { x0: 0.56, x1: 0.97, y0: 0.06, y1: 0.94 },
  narrow: { x0: 0.02, x1: 0.98, y0: 0.06, y1: 0.94 },
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

const HeroScene = () => {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const logoUrl = useBaseUrl('/img/brands/nestjs.svg');
  const [stats, setStats] = useState({ published: 0, retried: 0, acked: 0 });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const floor = buildFloor();
    const sim = createSim();
    const ui = { hoverItem: null, hoverPod: null, clicked: readClicked() };
    let palette = readPalette();
    let view = null;
    let logo = null;
    let frame = 0;
    let last = 0;
    let visible = true;
    let statsAt = 0;
    let pointer = null;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      const narrow = cw < 760;

      canvas.width = Math.round(cw * ratio);
      canvas.height = Math.round(ch * ratio);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      view = { cw, ch, ratio, project: makeProjector(cw, ch, narrow ? REGION.narrow : REGION.wide, !narrow) };
    };

    const render = () => {
      ctx.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
      draw(ctx, sim, floor, view, palette, logo, ui);
    };

    // What the pointer is over: a message (inspectable) or a pod (clickable).
    const hitTest = () => {
      ui.hoverItem = null;
      ui.hoverPod = null;

      if (pointer) {
        let best = 10;

        for (const item of itemsOf(sim, floor)) {
          if (!item.screen) continue;

          const d = Math.hypot(item.screen.x - pointer.x, item.screen.y - pointer.y);

          if (d < best) {
            best = d;
            ui.hoverItem = item;
          }
        }

        if (!ui.hoverItem) {
          sim.replicas.forEach((replica, index) => {
            const rect = replica.rect;

            if (rect && pointer.x >= rect.x - 4 && pointer.x <= rect.x + rect.w + 4 && pointer.y >= rect.y - 4 && pointer.y <= rect.y + rect.h + 4) {
              ui.hoverPod = index;
            }
          });
        }
      }

      canvas.style.cursor = ui.hoverPod === null ? 'default' : 'pointer';
    };

    const image = new Image();

    image.onload = () => {
      logo = image;
      if (reduce) render();
    };
    image.src = logoUrl;

    const tick = (ts) => {
      const dt = last ? Math.min(50, ts - last) : 16;

      last = ts;
      step(sim, floor, dt);
      hitTest();
      render();

      if (ts - statsAt > 400) {
        statsAt = ts;
        setStats({ ...sim.stats });
      }

      if (visible && !document.hidden) frame = requestAnimationFrame(tick);
    };

    const start = () => {
      cancelAnimationFrame(frame);
      last = 0;
      frame = requestAnimationFrame(tick);
    };

    resize();

    if (reduce) {
      for (let t = 0; t < 9000; t += 16) step(sim, floor, 16);
      ui.clicked = true;
      render();
      setStats({ ...sim.stats });

      return undefined;
    }

    const onMove = (event) => {
      const rect = canvas.getBoundingClientRect();

      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onLeave = () => {
      pointer = null;
    };
    const onClick = (event) => {
      onMove(event);
      hitTest();

      if (ui.hoverPod === null) return;

      togglePod(sim, floor, ui.hoverPod);

      if (!ui.clicked) {
        ui.clicked = true;
        rememberClicked();
      }
    };

    const sizeObserver = new ResizeObserver(() => {
      resize();
      render();
    });
    const viewObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else cancelAnimationFrame(frame);
    });
    const themeObserver = new MutationObserver(() => {
      palette = readPalette();
    });
    const onVisibility = () => {
      if (!document.hidden && visible) start();
    };

    sizeObserver.observe(wrap);
    viewObserver.observe(wrap);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    start();

    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      viewObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
    };
  }, [logoUrl]);

  return (
    <div className="scene">
      <div className="scene-stage" ref={wrapRef} aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      <p className="scene-stats">
        published <b data-tone="deliver">{stats.published}</b> · retried{' '}
        <b data-tone="redeliver">{stats.retried}</b> · acked <b data-tone="ack">{stats.acked}</b> · lost{' '}
        <b>0</b>
      </p>
    </div>
  );
};

export default HeroScene;
