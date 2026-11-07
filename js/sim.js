// Mode simulation : une fausse position « roule » le long du parcours.
import { pointAlong, bearing, destination, nearestOnLine, segmentAt } from './geo.js';

export class Simulator {
  constructor(engine, { factor = 4, onTick } = {}) {
    this.engine = engine;
    this.factor = factor;
    this.onTick = onTick;
    this.along = 0;
    this.route = engine.route;
    this.timer = null;
    this.detour = null;
    this.pos = engine.route.shape[0];
    this.heading = 0;
  }

  start() {
    this.stop();
    this.simT = Date.now();
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setFactor(k) { this.factor = k; }

  // Fait sortir du parcours pendant ~25 s pour tester le recalcul.
  deviate() {
    this.detour = { left: 25, heading: (this.heading + 75) % 360 };
  }

  segmentSpeed(r, along) {
    const i = segmentAt(r.cum, along);
    const dd = r.cum[i + 1] - r.cum[i];
    const dt = r.cumTime[i + 1] - r.cumTime[i];
    const v = dt > 0 ? dd / dt : 15;
    return Math.min(30, Math.max(7, v));
  }

  tick() {
    const e = this.engine;
    if (e.finished) { this.stop(); return; }
    const dt = 1; // une seconde « réelle » par tick, accélérée par le facteur
    if (e.pausedAt) return; // à l'arrêt pendant la pause
    this.simT += dt * this.factor * 1000; // horloge simulée (cohérente avec la distance parcourue)
    if (e.route !== this.route) {
      // Le moteur a recalculé : on se raccroche au nouveau tracé.
      this.route = e.route;
      const n = nearestOnLine(this.route.shape, this.route.cum, this.pos, 0, this.route.shape.length - 1);
      this.along = n.along;
    }
    let speed;
    if (this.detour && this.detour.left > 0) {
      speed = 13;
      this.pos = destination(this.pos, this.detour.heading, speed * dt * this.factor);
      this.heading = this.detour.heading;
      this.detour.left -= dt * this.factor;
      if (this.detour.left <= 0) this.detour = null;
    } else if (e.rerouting || e.offRoute) {
      speed = 0; // on attend le recalcul
    } else {
      const r = this.route;
      speed = this.segmentSpeed(r, this.along);
      this.along = Math.min(r.totalM, this.along + speed * dt * this.factor);
      const p = pointAlong(r.shape, r.cum, this.along);
      const ahead = pointAlong(r.shape, r.cum, Math.min(r.totalM, this.along + 15));
      this.heading = bearing(p, ahead) || this.heading;
      this.pos = p;
    }
    const fix = { lat: this.pos[0], lon: this.pos[1], accuracy: 5, speed, heading: this.heading, t: this.simT };
    this.onTick?.(fix);
    e.feed(fix);
  }
}
