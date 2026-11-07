// Moteur de guidage : suit la position, annonce les manœuvres, gère pauses, plein et recalcul.
import { haversine, bearing, nearestOnLine, pointAlong, segmentAt } from './geo.js';
import { route as fetchRoute, finalizeRoute, timeAt } from './services.js';
import { spokenDist, lowerFirst } from './format.js';

const OFF_ROUTE_M = 45;
const ARRIVE_TYPES = new Set([4, 5, 6]);

export class NavEngine {
  /*
    option : parcours choisi (route, stops, start, end, name)
    hooks : onUpdate(state), onSpeak(text, priority), onStopPrompt(stop), onStopArrive(stop),
            onRerouteState(state), onArrive(summary)
  */
  constructor(option, settings, hooks = {}) {
    this.option = option;
    this.settings = settings;
    this.hooks = hooks;
    this.route = option.route;
    this.stops = option.stops.map((s) => ({ ...s, state: 'pending' })); // pending | prompted | accepted | skipped | paused | done
    this.matchIdx = 0;
    this.along = 0;
    this.lastGoodAlong = 0;
    this.spoken = new Set();
    this.offCount = 0;
    this.offSince = 0;
    this.rerouting = false;
    this.rerouteBlockedUntil = 0;
    this.offRoute = false;
    this.finished = false;
    this.track = [];
    this.odometer = 0;
    this.movingS = 0;
    this.pauseS = 0;
    this.lastPos = null;
    this.fuelAtFill = option.fuelKm ?? settings.fuelKm;
    this.odoAtFill = 0;
    this.startedAt = Date.now();
    this.pausedAt = null;
    this.activeStop = null;
    this.reroutes = 0;
  }

  get fuelLeftKm() {
    return this.fuelAtFill - (this.odometer - this.odoAtFill) / 1000;
  }

  // pos = { lat, lon, accuracy, speed (m/s ou null), heading (degrés ou null), t (ms) }
  feed(pos) {
    if (this.finished) return;
    const p = [pos.lat, pos.lon];
    const t = pos.t || Date.now();

    // Odomètre, temps de roulage, trace.
    if (this.lastPos) {
      const d = haversine(this.lastPos.p, p);
      const dt = (t - this.lastPos.t) / 1000;
      if (dt > 0 && d / dt < 90 && (pos.accuracy || 0) < 80) {
        this.odometer += d;
        const v = pos.speed != null ? pos.speed : d / dt;
        if (v > 1.5 && !this.pausedAt) this.movingS += dt;
      }
    }
    if (!this.track.length || haversine(this.track[this.track.length - 1], p) > 8) {
      this.track.push([p[0], p[1], t]);
    }
    let speed = pos.speed;
    if ((speed == null || Number.isNaN(speed)) && this.lastPos) {
      const dt = (t - this.lastPos.t) / 1000;
      speed = dt > 0 ? haversine(this.lastPos.p, p) / dt : 0;
    }
    speed = speed || 0;
    if (speed > 90) speed = this.speed || 0; // saut de position aberrant
    let heading = pos.heading;
    if ((heading == null || Number.isNaN(heading) || speed < 2) && this.lastPos && haversine(this.lastPos.p, p) > 3) {
      heading = bearing(this.lastPos.p, p);
    }
    this.lastPos = { p, t };
    this.speed = speed;
    this.pos = p;
    this.accuracy = pos.accuracy || 10;

    // Accrochage au parcours.
    const r = this.route;
    const n = r.shape.length;
    let m = nearestOnLine(r.shape, r.cum, p, this.matchIdx - 10, this.matchIdx + 600);
    if (m.dist > OFF_ROUTE_M) {
      const g = nearestOnLine(r.shape, r.cum, p, 0, n - 1);
      const plausible = g.along >= this.lastGoodAlong - 500;
      if (g.dist < OFF_ROUTE_M && plausible) {
        // Sur une boucle qui se croise, on vérifie que le sens de marche correspond.
        const segBrg = bearing(r.shape[g.idx], r.shape[Math.min(n - 1, g.idx + 1)]);
        const okDir = heading == null || speed < 3 || Math.abs(((segBrg - heading + 540) % 360) - 180) < 70;
        if (okDir) m = g;
      }
    }
    if (heading == null) heading = bearing(r.shape[m.idx], r.shape[Math.min(n - 1, m.idx + 1)]);
    this.heading = heading;

    const threshold = Math.max(OFF_ROUTE_M, Math.min(80, this.accuracy * 1.5));
    if (m.dist <= threshold) {
      this.matchIdx = m.idx;
      this.along = m.along;
      this.lastGoodAlong = Math.max(this.lastGoodAlong, m.along);
      this.offCount = 0;
      this.offSince = 0;
      if (this.offRoute) { this.offRoute = false; this.hooks.onRerouteState?.('ok'); }
    } else if (!this.pausedAt) {
      this.offCount++;
      if (!this.offSince) this.offSince = t;
      if (this.offCount >= 3 && t - this.offSince > 4000) {
        if (!this.offRoute) { this.offRoute = true; this.hooks.onRerouteState?.('off'); }
        if (!this.rerouting && Date.now() > this.rerouteBlockedUntil) this.reroute(p, heading);
      }
    }

    this.checkStops(p);
    this.prevAlong = this.along;
    this.checkArrival(p);
    if (!this.finished && !this.offRoute) this.announce();
    this.hooks.onUpdate?.(this.state());
  }

  nextManeuver() {
    const ms = this.route.maneuvers;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.type === 1 && i === 0 && this.along > 30) continue;
      if (m.legStart) continue;
      if (m.along > this.along + 3) {
        // On saute les arrivées intermédiaires (les pauses ont leur propre annonce).
        if (ARRIVE_TYPES.has(m.type) && i < ms.length - 1) continue;
        return { m, idx: i, dist: m.along - this.along, following: this.followingManeuver(i) };
      }
    }
    return null;
  }

  followingManeuver(i) {
    const ms = this.route.maneuvers;
    for (let j = i + 1; j < ms.length; j++) {
      if ((ARRIVE_TYPES.has(ms[j].type) && j < ms.length - 1) || ms[j].legStart) continue;
      return { m: ms[j], gap: ms[j].along - ms[i].along };
    }
    return null;
  }

  announce() {
    if (!this.settings.voice) return;
    const nm = this.nextManeuver();
    if (!nm) return;
    const { m, idx, dist } = nm;
    // « Continuez » (simple changement de nom de route) : affiché mais pas annoncé.
    if ([8, 17, 22].includes(m.type) && !/^Reprenez/.test(m.instruction)) return;
    const v = Math.max(this.speed || 0, 8);
    const near = Math.min(160, Math.max(60, v * 5));
    const mid = Math.min(800, Math.max(300, v * 16));
    const far = Math.min(2500, Math.max(1000, v * 40));
    const isEnd = idx === this.route.maneuvers.length - 1;
    const text = isEnd ? 'Vous êtes arrivé.' : (m.pre || m.instruction);
    if (dist <= near && !this.spoken.has(idx + 'n')) {
      this.spoken.add(idx + 'n'); this.spoken.add(idx + 'm'); this.spoken.add(idx + 'f');
      let s = text;
      const f = nm.following;
      if (!isEnd && f && f.gap < 250 && !ARRIVE_TYPES.has(f.m.type)) s += ' Puis ' + lowerFirst(f.m.alert || f.m.instruction);
      this.hooks.onSpeak?.(s, 'high');
    } else if (dist <= mid && dist > near * 1.6 && !this.spoken.has(idx + 'm')) {
      this.spoken.add(idx + 'm'); this.spoken.add(idx + 'f');
      this.hooks.onSpeak?.('Dans ' + spokenDist(dist) + ', ' + lowerFirst(isEnd ? 'vous serez arrivé.' : (m.alert || m.instruction)));
    } else if (v > 19 && dist <= far && dist > mid * 1.5 && !this.spoken.has(idx + 'f')) {
      this.spoken.add(idx + 'f');
      this.hooks.onSpeak?.('Dans ' + spokenDist(dist) + ', ' + lowerFirst(m.alert || m.instruction));
    }
  }

  nextStop() {
    return this.stops.find((s) => s.state === 'pending' || s.state === 'prompted' || s.state === 'accepted' || s.state === 'paused') || null;
  }

  checkStops(p) {
    const s = this.nextStop();
    if (!s || s.state === 'paused') return;
    const ahead = s.along - this.along;
    if (s.state === 'pending' && ahead <= 1500) {
      s.state = 'prompted';
      this.activeStop = s;
      this.hooks.onStopPrompt?.(s);
      if (this.settings.voice) {
        this.hooks.onSpeak?.(`Dans ${spokenDist(Math.max(100, ahead))}, ${lowerFirst(s.label)} : ${s.name}.`);
      }
    }
    // Arrivé : tout près du lieu, ou on vient de dépasser son point sur le parcours (GPS qui « saute »).
    const crossed = this.prevAlong != null && this.prevAlong < s.along && this.along >= s.along - 30;
    const atStop = haversine(p, s.point) < 70 || crossed || (ahead < -20 && haversine(p, s.routePoint || s.point) < 120);
    if (s.state === 'accepted' && atStop) {
      s.state = 'paused';
      this.pausedAt = Date.now();
      this.hooks.onStopArrive?.(s);
      return;
    }
    // Pause dépassée sans réponse (ou refusée) : on passe à la suivante.
    if (s.state === 'prompted' && ahead < -400) {
      s.state = 'skipped';
      this.activeStop = null;
      this.hooks.onStopPrompt?.(null);
    }
  }

  acceptStop(s) {
    if (s.state === 'prompted' || s.state === 'pending') s.state = 'accepted';
  }

  skipStop(s) {
    s.state = 'skipped';
    this.activeStop = null;
  }

  // Pause commencée sans être arrivé exactement au lieu prévu (bouton « Je fais la pause ici »).
  startPauseHere(s) {
    s.state = 'paused';
    this.pausedAt = Date.now();
  }

  resume() {
    const s = this.stops.find((x) => x.state === 'paused');
    if (this.pausedAt) this.pauseS += (Date.now() - this.pausedAt) / 1000;
    this.pausedAt = null;
    if (s) {
      s.state = 'done';
      if (s.kind === 'fuel') {
        this.fuelAtFill = this.settings.fullTankKm;
        this.odoAtFill = this.odometer;
      }
    }
    this.activeStop = null;
    this.hooks.onUpdate?.(this.state());
  }

  checkArrival(p) {
    const r = this.route;
    const end = r.shape[r.shape.length - 1];
    const left = r.totalM - this.along;
    if ((left < 40 || (haversine(p, end) < 50 && this.along > r.totalM * 0.7)) && !this.finished) {
      this.finish(true);
    }
  }

  finish(arrived) {
    if (this.finished) return;
    this.finished = true;
    if (arrived && this.settings.voice) this.hooks.onSpeak?.('Vous êtes arrivé. Belle virée !', 'high');
    this.hooks.onArrive?.(this.summary(arrived));
  }

  summary(arrived) {
    return {
      arrived,
      track: this.track,
      odometerM: this.odometer,
      movingS: this.movingS,
      pauseS: this.pauseS,
      pausesDone: this.stops.filter((s) => s.state === 'done').length,
      reroutes: this.reroutes,
      simulated: !!this.simulated,
      option: this.option,
      startedAt: this.startedAt,
      endedAt: Date.now(),
    };
  }

  state() {
    const r = this.route;
    const nm = this.nextManeuver();
    const leftM = Math.max(0, r.totalM - this.along);
    const leftRideS = Math.max(0, r.timeS - timeAt(r, this.along));
    const pending = this.stops.filter((s) => ['pending', 'prompted', 'accepted'].includes(s.state) && s.along > this.along);
    const pauseLeftS = pending.reduce((a, s) => a + s.durationS, 0);
    const ns = this.nextStop();
    let nextStopInfo = null;
    if (ns && ns.state !== 'paused') {
      const ahead = ns.along - this.along;
      const tS = Math.max(0, timeAt(r, ns.along) - timeAt(r, this.along));
      nextStopInfo = { stop: ns, aheadM: ahead, inS: tS };
    }
    // Prochaine station prévue (pour la jauge).
    const nextFuel = pending.find((s) => s.kind === 'fuel');
    return {
      pos: this.pos,
      heading: this.heading,
      speed: this.speed,
      along: this.along,
      offRoute: this.offRoute,
      rerouting: this.rerouting,
      maneuver: nm,
      leftM,
      leftRideS,
      eta: new Date(Date.now() + (leftRideS + pauseLeftS) * 1000),
      nextStop: nextStopInfo,
      fuelLeftKm: this.fuelLeftKm,
      nextFuelKm: nextFuel ? (nextFuel.along - this.along) / 1000 : null,
      paused: !!this.pausedAt,
      pausedSince: this.pausedAt,
    };
  }

  // Recalcul : on rejoint le parcours prévu un peu plus loin, sans le réécrire.
  async reroute(p, heading) {
    this.rerouting = true;
    this.hooks.onRerouteState?.('rerouting');
    const r = this.route;
    try {
      // Point du parcours le plus proche devant nous (au cas où l'on aurait pris un raccourci).
      const fromIdx = segmentAt(r.cum, Math.max(0, this.lastGoodAlong - 200));
      const ahead = nearestOnLine(r.shape, r.cum, p, fromIdx, r.shape.length - 1);
      let joinAlong = Math.max(this.lastGoodAlong + 1000, ahead.along + 700);
      joinAlong = Math.min(joinAlong, r.totalM - 5);
      const target = pointAlong(r.shape, r.cum, joinAlong);
      const fresh = await fetchRoute([
        { lat: p[0], lon: p[1], heading },
        { lat: target[0], lon: target[1] },
      ], this.settings, { profile: this.option.profile || null });
      this.spliceRoute(fresh, joinAlong);
      this.reroutes++;
      this.offRoute = false;
      this.offCount = 0;
      this.offSince = 0;
      this.hooks.onRerouteState?.('done');
      if (this.settings.voice) this.hooks.onSpeak?.('Nouvel itinéraire pour rejoindre le parcours.');
    } catch (e) {
      this.rerouteBlockedUntil = Date.now() + 20000;
      this.hooks.onRerouteState?.('failed', e);
    } finally {
      this.rerouting = false;
    }
  }

  spliceRoute(fresh, joinAlong) {
    const old = this.route;
    const idx = segmentAt(old.cum, joinAlong);
    const head = fresh.shape;
    const tail = old.shape.slice(idx + 1);
    const shape = head.concat(tail);
    const base = head.length; // indice du premier point de `tail` dans le nouveau tracé
    const map = (j) => base + (j - (idx + 1));
    const maneuvers = fresh.maneuvers.filter((m) => !ARRIVE_TYPES.has(m.type)).map((m) => ({ ...m }));
    // Manœuvre de jonction : on reprend le parcours prévu.
    const current = old.maneuvers.find((m) => m.begin <= idx && m.end > idx);
    maneuvers.push({
      type: 8,
      instruction: 'Reprenez le parcours prévu' + (current?.streets?.[0] ? ' sur ' + current.streets[0] : '') + '.',
      alert: 'Reprenez le parcours prévu.',
      pre: 'Reprenez le parcours prévu.',
      post: '', streets: current?.streets || [],
      time: current ? current.time * Math.max(0, Math.min(1, (current.alongEnd - joinAlong) / Math.max(1, current.alongEnd - current.along))) : 0,
      lengthKm: 0,
      begin: base - 1,
      end: current ? map(current.end) : base - 1,
      isTurn: false,
    });
    for (const m of old.maneuvers) {
      if (m.begin > idx) maneuvers.push({ ...m, begin: map(m.begin), end: map(m.end) });
    }
    const remainingOldS = old.timeS - timeAt(old, joinAlong);
    const next = finalizeRoute({
      shape,
      maneuvers,
      legs: [],
      timeS: fresh.timeS + remainingOldS,
      lengthKm: shape.length,
    });
    // Repositionne les pauses restantes sur le nouveau tracé.
    for (const s of this.stops) {
      if (['done', 'skipped'].includes(s.state)) continue;
      if (s.along < joinAlong) {
        // Pause sautée par le détour : on la propose quand même si elle reste proche.
        const near = nearestOnLine(shape, next.cum, s.routePoint || s.point, 0, shape.length - 1);
        if (near.dist > 300) { s.state = 'skipped'; continue; }
        s.along = near.along;
      } else {
        s.along = next.cum[base - 1] + (s.along - joinAlong);
      }
    }
    this.route = next;
    this.matchIdx = 0;
    this.along = 0;
    this.lastGoodAlong = 0;
    this.spoken = new Set();
    this.hooks.onRouteChanged?.(next);
  }
}
