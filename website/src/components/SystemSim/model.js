/* The model behind the hero scene: a JetStream work queue in miniature.

   Messages are tiles in a log, oldest at the front. A free pod takes the
   oldest ready tile; the tile stays in the log while it is out for delivery.
   An ack removes it; a nak, or the pod going down, leaves it in place and
   makes it ready again after a backoff. No tile is ever lost. */

export const SLOTS = 14;
export const PODS = 3;
export const FALL_MS = 520;
export const ACK_MS = 650;
export const RETRY_MS = 2200;
export const RESTART_MS = 3400;
export const MANUAL_DOWN_MS = 20000;

const FAIL_CHANCE = [0.3, 0.2, 0];
const DEPLOY_EVERY_MS = 25000;
const SUBJECTS = ['orders.created', 'payments.captured', 'users.updated', 'emails.send', 'stock.reserved'];

export const createSim = () => ({
  time: 0,
  nextId: 1,
  tiles: [],
  pods: Array.from({ length: PODS }, () => ({ tile: null, downUntil: 0, manual: false, flash: null, flashAt: -1e9 })),
  nextSpawn: 200,
  nextBurst: 2500,
  burstLeft: 0,
  burstAt: 0,
  nextRestart: 16000,
  nextDeploy: 6500,
  deploy: null,
  stats: { published: 0, retried: 0, acked: 0 },
});

export const isDown = (sim, pod) => sim.time < pod.downUntil;

/* Tiles still in the log, oldest first. Acked ones are on their way out. */
export const liveTiles = (sim) => sim.tiles.filter((tile) => tile.state !== 'acked');

const nak = (sim, tile) => {
  tile.state = 'stored';
  tile.attempt += 1;
  tile.retrying = true;
  tile.readyAt = sim.time + RETRY_MS;
  tile.pod = null;
  sim.stats.retried += 1;
};

export const takeDown = (sim, index, ms, manual) => {
  const pod = sim.pods[index];

  pod.downUntil = sim.time + ms;
  pod.manual = manual;

  if (pod.tile) {
    nak(sim, pod.tile);
    pod.tile = null;
  }
};

/* A visitor's click: a running pod goes down until clicked again; a down pod comes back. */
export const togglePod = (sim, index) => {
  const pod = sim.pods[index];

  if (isDown(sim, pod)) {
    pod.downUntil = sim.time;
    pod.manual = false;
  } else {
    takeDown(sim, index, MANUAL_DOWN_MS, true);
  }
};

const publish = (sim) => {
  if (liveTiles(sim).length >= SLOTS) return;

  const id = sim.nextId++;

  sim.tiles.push({
    id,
    seq: 4812000 + id,
    subject: SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)],
    attempt: 0,
    state: 'stored',
    bornAt: sim.time,
    readyAt: sim.time + FALL_MS,
    pod: null,
  });
  sim.stats.published += 1;
};

export const step = (sim, dt) => {
  sim.time += dt;
  const now = sim.time;

  if (now >= sim.nextSpawn) {
    publish(sim);
    sim.nextSpawn = now + 600 + Math.random() * 500;
  }

  if (now >= sim.nextBurst) {
    sim.burstLeft = 5;
    sim.nextBurst = now + 9000 + Math.random() * 4000;
  }

  if (sim.burstLeft && now >= sim.burstAt) {
    publish(sim);
    sim.burstLeft -= 1;
    sim.burstAt = now + 140;
  }

  // a rolling deploy: each running pod restarts in turn while the log holds the work
  if (now >= sim.nextDeploy) {
    sim.deploy = { start: now, done: -1 };
    sim.nextDeploy = now + DEPLOY_EVERY_MS;
    sim.nextRestart = Math.max(sim.nextRestart, now + PODS * RESTART_MS + 6000);
  }

  if (sim.deploy) {
    const index = Math.floor((now - sim.deploy.start) / RESTART_MS);

    if (index < PODS && index > sim.deploy.done) {
      sim.deploy.done = index;
      if (!isDown(sim, sim.pods[index])) takeDown(sim, index, RESTART_MS, false);
    } else if (now - sim.deploy.start > PODS * RESTART_MS + 600) {
      sim.deploy = null;
    }
  }

  if (now >= sim.nextRestart) {
    const up = sim.pods.map((_, index) => index).filter((index) => !isDown(sim, sim.pods[index]));

    if (up.length > 1) takeDown(sim, up[Math.floor(Math.random() * up.length)], RESTART_MS, false);
    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  sim.pods.forEach((pod, index) => {
    if (!isDown(sim, pod)) pod.manual = false;

    const tile = pod.tile;

    // finish the delivery in hand
    if (tile && now >= tile.until) {
      pod.tile = null;
      pod.flashAt = now;

      if (Math.random() < FAIL_CHANCE[Math.min(tile.attempt, FAIL_CHANCE.length - 1)]) {
        pod.flash = 'nak';
        nak(sim, tile);
      } else {
        pod.flash = 'ack';
        tile.state = 'acked';
        tile.ackAt = now;
        sim.stats.acked += 1;
      }
    }

    // take the oldest ready message
    if (!pod.tile && !isDown(sim, pod)) {
      const next = sim.tiles.find((candidate) => candidate.state === 'stored' && now >= candidate.readyAt);

      if (next) {
        next.state = 'delivered';
        next.pod = index;
        next.since = now;
        next.until = now + 800 + Math.random() * 500;
        pod.tile = next;
      }
    }
  });

  sim.tiles = sim.tiles.filter((tile) => !(tile.state === 'acked' && now - tile.ackAt > ACK_MS));
};
