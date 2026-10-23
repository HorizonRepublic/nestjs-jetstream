import React, { useEffect, useRef, useState } from 'react';
import './styles.css';

/* A small JetStream system on a loop: services emit, the stream queues, replicas
   handle. Some handlers throw and some pods restart; every message gets acked in
   the end. Drawn on a canvas so dozens of messages stay smooth. */

const FAIL_CHANCE = [0.3, 0.2, 0];
const RETRY_WAIT_MS = 2000;
const SLOT = 9;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const quad = (a, c, b, t) => {
  const u = 1 - t;

  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
};

const readPalette = () => {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();

  return {
    deliver: token('--jt-state-deliver'),
    redeliver: token('--jt-state-redeliver'),
    ack: token('--jt-state-ack'),
    line: token('--jt-line-2'),
    faint: token('--jt-line-1'),
    surface: token('--jt-bg-1'),
    label: token('--jt-fg-3'),
    mono: token('--jt-font-mono') || 'monospace',
  };
};

const layout = (w, h) => {
  const mid = h * 0.46;

  return {
    w,
    h,
    producers: [0.2, 0.46, 0.72].map((f) => ({ x: w * 0.06, y: h * f })),
    tube: { x0: w * 0.34, x1: w * 0.6, y: mid },
    lane: { x0: w * 0.34, x1: w * 0.6, y: mid + 30 },
    replicas: [0.2, 0.46, 0.72].map((f) => ({ x: w * 0.84, y: h * f })),
    exit: { x: w * 1.02, y: mid },
  };
};

const createSim = () => ({
  time: 0,
  nextId: 1,
  messages: [],
  queue: [],
  replicas: [0, 1, 2].map(() => ({ busy: null, until: 0, flash: null, flashAt: -1e9, downUntil: 0 })),
  nextSpawn: 300,
  nextBurst: 5000,
  nextRestart: 9000,
  stats: { published: 0, retried: 0, acked: 0 },
});

const flight = (message, from, to, duration, bend, state, delay = 0) => {
  message.state = state;
  message.from = from;
  message.to = to;
  message.ctrl = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + bend };
  message.start = null;
  message.delay = delay;
  message.duration = duration;
};

const step = (sim, geo, dt) => {
  sim.time += dt;
  const now = sim.time;

  const spawn = (delay = 0) => {
    const producer = Math.floor(Math.random() * geo.producers.length);
    const message = { id: sim.nextId++, attempt: 0, pos: { ...geo.producers[producer] } };

    flight(message, geo.producers[producer], { x: geo.tube.x0, y: geo.tube.y }, 900, 0, 'toStream', delay);
    sim.messages.push(message);
    sim.stats.published += 1;
  };

  if (now >= sim.nextSpawn) {
    spawn();
    sim.nextSpawn = now + 900 + Math.random() * 900;
  }

  if (now >= sim.nextBurst) {
    for (let i = 0; i < 6; i += 1) spawn(i * 140);
    sim.nextBurst = now + 9000 + Math.random() * 6000;
  }

  if (now >= sim.nextRestart) {
    const replica = sim.replicas[Math.floor(Math.random() * sim.replicas.length)];

    replica.downUntil = now + 2600;

    if (replica.busy) {
      const message = replica.busy;
      replica.busy = null;
      sim.stats.retried += 1;
      flight(message, { ...message.pos }, { x: geo.lane.x1, y: geo.lane.y }, 800, 26, 'toLane');
    }

    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  // dispatch from the head of the queue to free replicas
  sim.replicas.forEach((replica, index) => {
    if (replica.busy || now < replica.downUntil || !sim.queue.length) return;

    const head = sim.queue[0];

    if (head.state !== 'queued' || Math.abs(head.pos.x - (geo.tube.x1 - 6)) > 4) return;

    sim.queue.shift();
    replica.busy = head;
    flight(head, { ...head.pos }, geo.replicas[index], 650, 0, 'toReplica');
    head.replica = index;
  });

  // queue slots: the head sits at the stream's right end
  const span = geo.tube.x1 - geo.tube.x0 - 12;
  const gap = Math.min(SLOT, span / Math.max(sim.queue.length, 1));

  sim.queue.forEach((message, index) => {
    const tx = geo.tube.x1 - 6 - index * gap;

    message.pos.x += (tx - message.pos.x) * Math.min(1, dt / 120);
    message.pos.y += (geo.tube.y - message.pos.y) * Math.min(1, dt / 120);
  });

  for (const message of sim.messages) {
    if (message.from && message.start === null) message.start = now + message.delay;

    if (message.from) {
      const t = Math.min(1, Math.max(0, (now - message.start) / message.duration));

      message.pos = quad(message.from, message.ctrl, message.to, easeInOut(t));

      if (t < 1) continue;

      message.from = null;

      if (message.state === 'toStream') {
        message.state = 'queued';
        sim.queue.push(message);
      } else if (message.state === 'toReplica') {
        message.state = 'processing';
        message.since = now;
        message.until = now + 450 + Math.random() * 650;
      } else if (message.state === 'toLane') {
        message.state = 'waiting';
        message.until = now + RETRY_WAIT_MS;
        message.laneFrom = message.pos.x;
      } else if (message.state === 'toExit') {
        message.state = 'done';
      }

      continue;
    }

    if (message.state === 'processing' && now >= message.until) {
      const replica = sim.replicas[message.replica];

      replica.busy = null;

      if (Math.random() < FAIL_CHANCE[Math.min(message.attempt, FAIL_CHANCE.length - 1)]) {
        message.attempt += 1;
        sim.stats.retried += 1;
        replica.flash = 'redeliver';
        replica.flashAt = now;
        flight(message, { ...message.pos }, { x: geo.lane.x1, y: geo.lane.y }, 800, 26, 'toLane');
      } else {
        sim.stats.acked += 1;
        replica.flash = 'ack';
        replica.flashAt = now;
        message.state = 'acked';
        message.ackAt = now;
        flight(message, { ...message.pos }, geo.exit, 900, -14, 'toExit');
      }
    } else if (message.state === 'waiting') {
      const t = Math.min(1, 1 - (message.until - now) / RETRY_WAIT_MS);

      message.pos.x = message.laneFrom + (geo.lane.x0 - message.laneFrom) * easeInOut(t);
      message.pos.y = geo.lane.y;

      if (now >= message.until) {
        flight(message, { ...message.pos }, { x: geo.tube.x0, y: geo.tube.y }, 450, 0, 'toStream');
      }
    }
  }

  sim.messages = sim.messages.filter((message) => message.state !== 'done');
};

const draw = (ctx, sim, geo, palette) => {
  const { w, h } = geo;

  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1;

  // connectors
  ctx.strokeStyle = palette.faint;
  ctx.beginPath();
  for (const p of geo.producers) {
    ctx.moveTo(p.x, p.y);
    ctx.quadraticCurveTo((p.x + geo.tube.x0) / 2, (p.y + geo.tube.y) / 2, geo.tube.x0, geo.tube.y);
  }
  for (const r of geo.replicas) {
    ctx.moveTo(geo.tube.x1, geo.tube.y);
    ctx.quadraticCurveTo((r.x + geo.tube.x1) / 2, (r.y + geo.tube.y) / 2, r.x, r.y);
  }
  ctx.stroke();

  // stream
  const tubeH = 18;

  ctx.fillStyle = palette.surface;
  ctx.strokeStyle = palette.line;
  ctx.beginPath();
  ctx.roundRect(geo.tube.x0 - 8, geo.tube.y - tubeH / 2, geo.tube.x1 - geo.tube.x0 + 16, tubeH, 9);
  ctx.fill();
  ctx.stroke();

  // retry lane
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = palette.redeliver;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.moveTo(geo.lane.x1, geo.lane.y);
  ctx.lineTo(geo.lane.x0, geo.lane.y);
  ctx.stroke();
  ctx.restore();

  // labels
  ctx.font = `11px ${palette.mono}`;
  ctx.fillStyle = palette.label;
  ctx.textAlign = 'center';
  ctx.fillText('services', geo.producers[0].x, h - 6);
  ctx.fillText('stream', (geo.tube.x0 + geo.tube.x1) / 2, geo.tube.y - 16);
  ctx.fillText('replicas', geo.replicas[0].x, h - 6);
  ctx.fillStyle = palette.redeliver;
  ctx.globalAlpha = 0.85;
  ctx.fillText('retry after 2 s, 10 s', (geo.lane.x0 + geo.lane.x1) / 2, geo.lane.y + 16);
  ctx.globalAlpha = 1;

  // producers
  for (const p of geo.producers) {
    ctx.fillStyle = palette.surface;
    ctx.strokeStyle = palette.line;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // replicas
  sim.replicas.forEach((replica, index) => {
    const r = geo.replicas[index];
    const down = sim.time < replica.downUntil;
    const flashAge = sim.time - replica.flashAt;
    const flashing = flashAge < 500;

    ctx.save();
    if (down) {
      ctx.setLineDash([2, 3]);
      ctx.globalAlpha = 0.6;
    }
    ctx.fillStyle = flashing ? palette[replica.flash] : palette.surface;
    ctx.globalAlpha = flashing ? 0.2 + 0.25 * (1 - flashAge / 500) : ctx.globalAlpha;
    ctx.beginPath();
    ctx.roundRect(r.x - 9, r.y - 9, 18, 18, 4);
    ctx.fill();
    ctx.globalAlpha = down ? 0.6 : 1;
    ctx.strokeStyle = flashing ? palette[replica.flash] : palette.line;
    ctx.stroke();
    ctx.restore();

    if (down) {
      ctx.font = `10px ${palette.mono}`;
      ctx.fillStyle = palette.label;
      ctx.textAlign = 'left';
      ctx.fillText('restarting', r.x + 15, r.y + 4);
    }

    const busy = replica.busy;

    if (busy && busy.state === 'processing') {
      const progress = Math.min(1, (sim.time - busy.since) / (busy.until - busy.since));

      ctx.strokeStyle = palette.deliver;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 14, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  });

  // messages
  for (const message of sim.messages) {
    let color = palette.deliver;

    if (message.state === 'acked' || message.state === 'toExit') color = palette.ack;
    else if (message.attempt > 0 || message.state === 'toLane' || message.state === 'waiting') color = palette.redeliver;

    let alpha = 1;

    if (message.state === 'toExit') alpha = Math.max(0, 1 - (sim.time - message.ackAt) / 900);

    ctx.globalAlpha = alpha * 0.18;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(message.pos.x, message.pos.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(message.pos.x, message.pos.y, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
};

const SystemSim = () => {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [stats, setStats] = useState({ published: 0, retried: 0, acked: 0, inFlight: 0 });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sim = createSim();
    let palette = readPalette();
    let geo = null;
    let frame = 0;
    let last = 0;
    let visible = true;
    let statsAt = 0;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;

      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      geo = layout(w, h);
      // Positions are in pixels, so a new size starts a fresh run.
      Object.assign(sim, createSim());
    };

    const publish = () => {
      setStats({
        ...sim.stats,
        inFlight: sim.messages.filter((m) => m.state !== 'acked' && m.state !== 'toExit').length,
      });
    };

    const tick = (ts) => {
      const dt = last ? Math.min(50, ts - last) : 16;

      last = ts;
      step(sim, geo, dt);
      draw(ctx, sim, geo, palette);

      if (ts - statsAt > 400) {
        statsAt = ts;
        publish();
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
      for (let t = 0; t < 9000; t += 16) step(sim, geo, 16);
      draw(ctx, sim, geo, palette);
      publish();

      return undefined;
    }

    const sizeObserver = new ResizeObserver(() => {
      resize();
      draw(ctx, sim, geo, palette);
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
    start();

    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      viewObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <figure className="sim">
      <div className="sim-stage" ref={wrapRef} aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      <figcaption className="sim-stats">
        <span>
          published <b data-tone="deliver">{stats.published}</b>
        </span>
        <span>
          retried <b data-tone="redeliver">{stats.retried}</b>
        </span>
        <span>
          acked <b data-tone="ack">{stats.acked}</b>
        </span>
        <span>
          in flight <b>{stats.inFlight}</b>
        </span>
        <span className="sim-note">lost 0</span>
      </figcaption>
    </figure>
  );
};

export default SystemSim;
