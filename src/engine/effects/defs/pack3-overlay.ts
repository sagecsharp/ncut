import type { EffectDef } from '../types';
import { OVERLAY_COMMON } from './pack3-common';

/**
 * overlay pack: things drawn on top of the picture. every one is a pure function of (uv, time, seed,
 * params), one texture tap, and a fixed cost: a grid cell per particle, the 3x3 cells around the pixel
 * and at most 3 depth layers. nothing here keeps state, so preview and export match.
 * every effect ends with mix(c, result, u_amount), so amount 0 returns the picture bit for bit.
 *
 * already in the app and therefore not repeated here: speed lines (motion) and light leak (color).
 */
const LAYERS = OVERLAY_COMMON;

export const PACK3_OVERLAY_EFFECTS: EffectDef[] = [
  {
    id: 'snow',
    name: 'snow',
    category: 'overlay',
    description: 'soft flakes drifting down with a gentle sway, three layers of depth',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 55, unit: '%' },
      { key: 'size', label: 'size', min: 0.3, max: 2.5, step: 0.05, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.05, default: 1.5, unit: 'x' },
      { key: 'wind', label: 'wind', min: -100, max: 100, step: 1, default: 20, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  float a = 0.0;
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float depth = 1.0 - fl * 0.32;
    float cells = (3.0 + p_density * 0.09) * (1.0 + fl * 0.85);
    vec2 q = p * cells;
    q.y -= t * p_speed * 0.12 * depth * cells;
    q.x -= t * p_wind * 0.004 * depth * cells;
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        vec2 pos = g + 0.2 + 0.6 * h.xy;
        pos.x += 0.18 * sin(t * (0.6 + h.x) + h.y * TAU);
        float r = min((0.1 + 0.12 * h.y) * p_size, 0.42);
        float d = length(f - pos);
        a += blob(d, r * 0.55, r * 0.5) * (0.45 + 0.55 * depth) * step(0.4, h.z);
      }
    }
  }
  vec3 col = mix(c, vec3(0.96, 0.98, 1.0), clamp(a, 0.0, 1.0));
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'rain',
    name: 'rain',
    category: 'overlay',
    description: 'thin fast streaks falling at an angle, three layers of depth',
    posterTime: 1,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'streak', label: 'length', min: 20, max: 100, step: 1, default: 70, unit: '%' },
      { key: 'speed', label: 'speed', min: 0.2, max: 5, step: 0.05, default: 2, unit: 'x' },
      { key: 'angle', label: 'angle', min: -45, max: 45, step: 1, default: 12, unit: 'deg' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  float ang = radians(p_angle);
  // the drops travel along dn (down, leaning by the angle); ac is the sideways axis
  vec2 dn = vec2(sin(ang), cos(ang));
  vec2 ac = vec2(cos(ang), -sin(ang));
  float along = dot(p, dn);
  float across = dot(p, ac);
  float thin = max(0.0016, 0.8 / u_res.y);
  float a = 0.0;
  for (int l = 0; l < 3; l++) {
    float fl = float(2 - l);
    float depth = 1.0 - fl * 0.3;
    float cx = (6.0 + p_density * 0.35) * (1.0 + fl * 0.6);
    float cy = cx * 0.22;
    float colId = floor(across * cx);
    float fx = across * cx - colId;
    float sp = p_speed * 0.6 * depth * (0.9 + 0.4 * hash11(colId + fl * 13.0 + u_seed));
    float yq = (along - t * sp) * cy;
    float row = floor(yq);
    float fy = yq - row;
    vec3 h = crand(vec2(colId, row), fl);
    // one streak per cell, always inside its own cell
    float fr = clamp(p_streak * 0.01 * (0.6 + 0.4 * fract(h.z * 13.7)), 0.05, 1.0);
    float y0 = h.y * (1.0 - fr);
    float v = (fy - y0) / fr;
    float s = clamp(v, 0.0, 1.0) * step(0.0, v) * step(v, 1.0);
    float x0 = 0.25 + 0.5 * h.x;
    float th = thin * cx;
    float w = 1.0 - smoothstep(th * 0.5, th * 1.4, abs(fx - x0));
    a += w * s * step(0.45, h.z) * (0.35 + 0.65 * depth);
  }
  vec3 col = mix(c, vec3(0.8, 0.87, 0.95), clamp(a * 0.7, 0.0, 1.0));
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'confetti',
    name: 'confetti',
    category: 'overlay',
    description: 'small colored paper rectangles tumbling down',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 55, unit: '%' },
      { key: 'size', label: 'size', min: 0.4, max: 2.5, step: 0.05, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.05, default: 1.5, unit: 'x' },
      { key: 'tumble', label: 'tumble', min: 0, max: 6, step: 0.1, default: 2, unit: 'x' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  vec3 col = c;
  // far layer first, so the near pieces are drawn on top
  for (int l = 0; l < 3; l++) {
    float fl = float(2 - l);
    float depth = 1.0 - fl * 0.28;
    float cells = (3.0 + p_density * 0.08) * (1.0 + fl * 0.7);
    float px = cells / u_res.y;
    vec2 q = p * cells;
    q.y -= t * p_speed * 0.1 * depth * cells;
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        float k = fract(h.z * 37.3);
        float tum = t * p_tumble;
        vec2 pos = g + 0.25 + 0.5 * h.xy;
        pos.x += 0.2 * sin(t * (0.8 + h.y) * 1.5 + h.x * TAU);
        float rotA = h.x * TAU + tum * (h.y - 0.5) * 3.0;
        vec2 loc = rot(f - pos, rotA);
        // the piece flips over as it tumbles, so its height shrinks and grows
        float flip = 0.15 + 0.85 * abs(cos(tum * (0.5 + k) + h.y * TAU));
        vec2 hs = vec2(0.17, 0.1) * p_size;
        vec2 e = abs(loc) - hs * vec2(1.0, flip);
        float m = 1.0 - smoothstep(-px, px, max(e.x, e.y));
        vec3 cc = hsv2rgb(vec3(fract(h.x * 7.7 + k), 0.75, 0.95));
        cc *= (0.65 + 0.35 * flip) * mix(0.7, 1.0, depth);
        col = mix(col, cc, m * step(0.35, h.z));
      }
    }
  }
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'embers',
    name: 'embers',
    category: 'overlay',
    description: 'small warm sparks rising from below and flickering',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'size', label: 'size', min: 0.3, max: 2.5, step: 0.05, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.05, default: 1.5, unit: 'x' },
      { key: 'heat', label: 'heat', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  vec3 light = vec3(0.0);
  // stronger near the bottom, where they come from
  float low = mix(0.3, 1.0, uv.y);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float depth = 1.0 - fl * 0.3;
    float cells = (4.0 + p_density * 0.1) * (1.0 + fl * 0.7);
    vec2 q = p * cells;
    q.y += t * p_speed * 0.12 * depth * cells;
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        vec2 pos = g + 0.15 + 0.7 * h.xy;
        pos.x += 0.25 * sin(t * (0.7 + h.x) * 1.3 + h.y * TAU);
        float r = (0.035 + 0.05 * h.y) * p_size;
        vec2 dv = f - pos;
        float d2 = dot(dv, dv);
        float rr = max(r * r, 0.00001);
        float spark = exp(-d2 / rr) + 0.25 * exp(-d2 / (rr * 9.0));
        float s = 0.5 + 0.5 * sin(t * (6.0 + 10.0 * h.x) + h.z * 80.0);
        float flick = 0.35 + 0.65 * s * s;
        float k = clamp(p_heat * 0.01 + (fract(h.z * 9.1) - 0.5) * 0.5, 0.0, 1.0);
        vec3 ec = mix(vec3(1.0, 0.22, 0.04), vec3(1.0, 0.8, 0.3), k);
        light += ec * spark * flick * step(0.45, h.z) * depth;
      }
    }
  }
  return vec4(mix(c, lit(c, light * low), u_amount), 1.0);
}`,
  },
  {
    id: 'bokeh',
    name: 'bokeh',
    category: 'overlay',
    description: 'large soft out of focus light discs drifting slowly',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'size', label: 'size', min: 0.3, max: 2, step: 0.05, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.05, default: 1, unit: 'x' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 40, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  float soft = p_softness * 0.01;
  vec3 light = vec3(0.0);
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float cells = (2.5 + p_density * 0.05) * (1.0 + fl * 0.8);
    vec2 q = p * cells;
    q.x += t * p_speed * 0.03 * cells * (1.0 - fl * 0.4);
    q.y -= t * p_speed * 0.02 * cells * (1.0 - fl * 0.4);
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        vec2 pos = g + 0.2 + 0.6 * h.xy;
        float r = min((0.2 + 0.2 * h.y) * p_size, 0.48);
        float d = length(f - pos);
        float edge = mix(0.04, 0.6, soft);
        float disc = 1.0 - smoothstep(r * (1.0 - edge), r, d);
        // a slightly brighter rim, like a real out of focus highlight
        float rim = smoothstep(r * 0.7, r, d);
        float shape = disc * (0.55 + 0.45 * rim * (1.0 - soft));
        float tw = 0.6 + 0.4 * sin(t * 0.5 + h.z * 31.0);
        vec3 tint = mix(vec3(1.0, 0.9, 0.7), hsv2rgb(vec3(fract(h.x * 3.1 + 0.05), 0.5, 1.0)), 0.6);
        light += tint * shape * tw * step(0.4, h.z) * 0.35;
      }
    }
  }
  return vec4(mix(c, lit(c, light), u_amount), 1.0);
}`,
  },
  {
    id: 'light-rays',
    name: 'light rays',
    category: 'overlay',
    description: 'soft shafts of light fanning out from a point, slowly shifting',
    posterTime: 1.5,
    params: [
      { key: 'x', label: 'x', min: -50, max: 150, step: 1, default: 15, unit: '%' },
      { key: 'y', label: 'y', min: -50, max: 150, step: 1, default: -10, unit: '%' },
      { key: 'rays', label: 'rays', min: 3, max: 24, step: 1, default: 9 },
      { key: 'reach', label: 'reach', min: 10, max: 150, step: 1, default: 60, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  vec2 src = vec2(p_x * 0.01 * aspect(), p_y * 0.01);
  vec2 d = p - src;
  float dist = length(d);
  // angle around the source, 0..1. n whole shafts per turn so the wrap has no seam
  float ang = atan(d.y, d.x + 0.00001) / TAU + 0.5;
  float n = max(floor(p_rays + 0.5), 3.0);
  float s1 = pnoise(ang * n + t * 0.25, n, u_seed);
  float s2 = pnoise(ang * n * 2.0 - t * 0.17 + 5.0, n * 2.0, u_seed + 3.0);
  float shafts = smoothstep(0.35, 0.85, s1 * 0.65 + s2 * 0.35);
  float fall = exp(-dist / max(p_reach * 0.02, 0.05));
  float haze = 0.25 * exp(-dist * 2.2);
  vec3 light = vec3(1.0, 0.92, 0.72) * (shafts * fall * 0.75 + haze);
  return vec4(mix(c, lit(c, light), u_amount), 1.0);
}`,
  },
  {
    id: 'lens-flare',
    name: 'lens flare',
    category: 'overlay',
    description: 'a bright core with a halo and a line of ghost discs through the center',
    posterTime: 1,
    params: [
      { key: 'x', label: 'x', min: -20, max: 120, step: 1, default: 75, unit: '%' },
      { key: 'y', label: 'y', min: -20, max: 120, step: 1, default: 25, unit: '%' },
      { key: 'size', label: 'size', min: 20, max: 200, step: 1, default: 100, unit: '%' },
      { key: 'ghosts', label: 'ghosts', min: 0, max: 100, step: 1, default: 60, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float asp = aspect();
  vec2 p = apos(uv);
  vec2 src = vec2(p_x * 0.01 * asp, p_y * 0.01);
  vec2 ctr = vec2(0.5 * asp, 0.5);
  float s = max(p_size * 0.01, 0.1);
  float pulse = 1.0 + 0.04 * sin(u_time * 1.7 + u_seed);
  vec2 dd = p - src;
  float ds = length(dd);
  float cr = 0.03 * s;
  vec3 light = vec3(1.0, 0.95, 0.85) * (exp(-(ds * ds) / (cr * cr)) * 1.2 + 0.35 * exp(-ds / (0.18 * s)));
  // thin anamorphic streak through the light
  light += vec3(0.55, 0.72, 1.0) * exp(-abs(dd.y) * 60.0 / s) * exp(-abs(dd.x) * 1.6 / s) * 0.5;
  float gk = p_ghosts * 0.01;
  for (int i = 0; i < 5; i++) {
    float k = 0.3 + float(i) * 0.42;
    vec2 gp = src + (ctr - src) * k;
    float hh = hash11(float(i) * 7.31 + 1.7);
    float gr = (0.025 + 0.06 * hh) * s;
    float dg = length(p - gp);
    float e = (dg - gr) / max(gr * 0.15, 0.0001);
    float ring = exp(-e * e) * 0.25;
    float disc = blob(dg, gr, gr * 0.25) * 0.15;
    vec3 gc = hsv2rgb(vec3(fract(hh * 3.7 + 0.55), 0.55, 1.0));
    light += gc * (ring + disc) * gk;
  }
  return vec4(mix(c, lit(c, light * pulse), u_amount), 1.0);
}`,
  },
  {
    id: 'fireflies',
    name: 'fireflies',
    category: 'overlay',
    description: 'a few small glowing dots wandering around and blinking',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 40, unit: '%' },
      { key: 'size', label: 'size', min: 0.3, max: 2, step: 0.05, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 4, step: 0.05, default: 1, unit: 'x' },
      { key: 'blink', label: 'blink', min: 0, max: 4, step: 0.05, default: 1, unit: 'hz' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  vec3 light = vec3(0.0);
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float cells = (2.5 + p_density * 0.06) * (1.0 + fl * 0.6);
    vec2 q = p * cells;
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        // each firefly wanders on a slow loop around the middle of its cell
        float ph = t * p_speed * (0.4 + h.x) * 0.8;
        vec2 pos = g + 0.5 + 0.3 * vec2(sin(ph * 0.9 + h.y * TAU), cos(ph * 0.7 + h.x * TAU)) + 0.1 * (h.xy - 0.5);
        float b = clamp(0.5 + 0.6 * sin(t * p_blink * TAU * (0.4 + 0.6 * h.y) + h.z * 60.0), 0.0, 1.0);
        float blink = b * b;
        float r = (0.03 + 0.03 * h.y) * p_size;
        vec2 dv = f - pos;
        float d2 = dot(dv, dv);
        float rr = max(r * r, 0.00001);
        float glow = exp(-d2 / rr) + 0.2 * exp(-d2 / (rr * 12.0));
        light += vec3(0.75, 1.0, 0.3) * glow * blink * step(0.5, h.z) * (1.0 - fl * 0.35);
      }
    }
  }
  return vec4(mix(c, lit(c, light), u_amount), 1.0);
}`,
  },
  {
    id: 'bubbles',
    name: 'bubbles',
    category: 'overlay',
    description: 'transparent rings with a bright highlight, rising and wobbling',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'size', label: 'size', min: 0.3, max: 2.5, step: 0.05, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.05, default: 1.5, unit: 'x' },
      { key: 'sway', label: 'sway', min: 0, max: 100, step: 1, default: 40, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  vec3 light = vec3(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float depth = 1.0 - fl * 0.3;
    float cells = (2.5 + p_density * 0.07) * (1.0 + fl * 0.7);
    float px = cells / u_res.y;
    vec2 q = p * cells;
    q.y += t * p_speed * 0.1 * depth * cells;
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        vec2 pos = g + 0.25 + 0.5 * h.xy;
        pos.x += 0.25 * p_sway * 0.01 * sin(t * (0.8 + h.x) + h.y * TAU);
        float r = min((0.12 + 0.14 * h.y) * p_size, 0.42);
        vec2 dv = f - pos;
        float d = length(dv);
        float w = max(r * 0.08, px);
        float e = (d - r) / w;
        float rim = exp(-e * e);
        float fill = blob(d, r, w) * 0.07;
        vec2 dir = dv / max(d, 0.0001);
        // the rim catches light at the top left and the bottom right
        float facing = abs(dot(dir, vec2(0.7071, 0.7071)));
        float hl = blob(length(dv - vec2(-0.38, -0.38) * r), r * 0.16, r * 0.1);
        vec3 irid = hsv2rgb(vec3(fract(h.x + d / max(r, 0.001) * 0.3 + dir.x * 0.1), 0.35, 1.0));
        light += (irid * rim * (0.2 + 0.5 * facing * facing) + vec3(hl * 0.8) + irid * fill) * step(0.5, h.z) * (0.5 + 0.5 * depth);
      }
    }
  }
  return vec4(mix(c, lit(c, light), u_amount), 1.0);
}`,
  },
  {
    id: 'stars',
    name: 'stars',
    category: 'overlay',
    description: 'a field of still, twinkling points of light with a few sparkles',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      { key: 'size', label: 'size', min: 0.3, max: 1.5, step: 0.05, default: 1, unit: 'x' },
      { key: 'twinkle', label: 'twinkle', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'speed', label: 'speed', min: 0, max: 4, step: 0.05, default: 1, unit: 'x' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time * p_speed;
  vec3 light = vec3(0.0);
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float cells = (8.0 + p_density * 0.25) * (1.0 + fl * 0.8);
    vec2 q = p * cells;
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        vec2 pos = g + 0.2 + 0.6 * h.xy;
        float mag = fract(h.z * 53.1);
        float bright = (0.3 + 0.7 * mag * mag) * (1.0 - fl * 0.35);
        float r = (0.03 + 0.05 * mag) * p_size;
        vec2 dv = f - pos;
        float rr = max(r * r, 0.00001);
        float core = exp(-dot(dv, dv) / rr);
        float tw = 1.0 - p_twinkle * 0.01 * (0.5 + 0.5 * sin(t * (1.5 + 3.0 * h.y) + h.x * 44.0));
        // the brightest few get a small cross sparkle
        float arm = max(r * 0.35, 0.0001);
        float spark = exp(-abs(dv.y) / arm) * exp(-abs(dv.x) / (r * 3.5 + 0.0001)) + exp(-abs(dv.x) / arm) * exp(-abs(dv.y) / (r * 3.5 + 0.0001));
        spark *= step(0.8, mag);
        vec3 tint = mix(vec3(0.8, 0.88, 1.0), vec3(1.0, 0.9, 0.75), h.y);
        float on = step(0.8 + fl * 0.1, h.z);
        light += tint * (core * 0.9 + spark * 0.5) * bright * tw * on;
      }
    }
  }
  return vec4(mix(c, lit(c, light), u_amount), 1.0);
}`,
  },
  {
    id: 'dust',
    name: 'dust',
    category: 'overlay',
    description: 'tiny slow specks, plus the odd hair and scratch, a subtle old film feel',
    posterTime: 1,
    params: [
      { key: 'density', label: 'specks', min: 0, max: 100, step: 1, default: 45, unit: '%' },
      { key: 'size', label: 'size', min: 0.3, max: 2.5, step: 0.05, default: 1, unit: 'x' },
      { key: 'drift', label: 'drift', min: 0, max: 5, step: 0.05, default: 1, unit: 'x' },
      { key: 'scratches', label: 'scratches', min: 0, max: 100, step: 1, default: 30, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  float asp = aspect();
  vec2 p = apos(uv);
  float t = u_time;
  float motes = 0.0;
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float cells = (6.0 + p_density * 0.2) * (1.0 + fl * 0.9);
    float px = cells / u_res.y;
    vec2 q = p * cells;
    q.x += t * p_drift * 0.012 * cells * (1.0 + fl * 0.5);
    q.y -= t * p_drift * 0.02 * cells * (1.0 + fl * 0.5);
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        vec2 pos = g + 0.2 + 0.6 * h.xy;
        float r = (0.03 + 0.05 * h.y) * p_size;
        float m = blob(length(f - pos), r, max(r * 0.6, px));
        // each speck catches the light now and then
        float glint = 0.5 + 0.5 * sin(t * (1.0 + 3.0 * h.x) + h.z * 56.0);
        motes += m * glint * step(0.6, h.z) * (0.8 - fl * 0.25);
      }
    }
  }
  // film damage is redrawn 12 times a second and mostly absent
  float sc = p_scratches * 0.01;
  float st = floor(t * 12.0) + u_seed;
  float th = max(0.0006, 0.6 / u_res.y);
  float sx = hash11(st * 2.3 + 11.0) * asp;
  float y0 = hash11(st * 1.3 + 5.0) * 0.5;
  float y1 = y0 + 0.3 + 0.6 * hash11(st * 4.1 + 2.0);
  float seg = smoothstep(y0, y0 + 0.05, p.y) * (1.0 - smoothstep(y1 - 0.05, y1, p.y));
  float scratch = (1.0 - smoothstep(th, th * 2.5, abs(p.x - sx - 0.002 * sin(p.y * 17.0 + st)))) * seg;
  scratch *= step(hash11(st * 1.7 + 3.0), sc * 0.5);
  float hair = 0.0;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float sk = st * 3.1 + fk * 17.7;
    vec2 hc = vec2(hash11(sk + 1.0) * asp, hash11(sk + 2.0));
    vec2 loc = rot(p - hc, hash11(sk + 3.0) * PI);
    float hl = 0.04 + 0.06 * hash11(sk + 4.0);
    // a short curved line: a flat arc across its length
    float arc = 0.25 * hl * (1.0 - (loc.x * loc.x) / (hl * hl));
    float ln = 1.0 - smoothstep(th * 1.2, th * 3.0, abs(loc.y - arc));
    ln *= 1.0 - smoothstep(hl * 0.9, hl, abs(loc.x));
    hair += ln * step(hash11(sk + 5.0), sc * 0.5);
  }
  vec3 col = lit(c, vec3(motes * 0.3 + scratch * 0.25));
  col *= 1.0 - clamp(hair, 0.0, 1.0) * 0.55;
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'mist',
    name: 'mist',
    category: 'overlay',
    description: 'slow drifting bands of soft fog, heavier near the bottom',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'height', label: 'height', min: 10, max: 100, step: 1, default: 60, unit: '%' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.05, default: 1, unit: 'x' },
      { key: 'warmth', label: 'warmth', min: 0, max: 100, step: 1, default: 20, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time * p_speed;
  // stretched sideways: wide bands that slide past each other
  float n1 = fbm(vec2(p.x * 0.9 + t * 0.04, p.y * 2.6 + u_seed * 0.13));
  float n2 = fbm(vec2(p.x * 1.7 - t * 0.03 + 31.0, p.y * 3.4 - t * 0.01 + u_seed * 0.07));
  float bands = smoothstep(0.3, 0.8, n1 * 0.6 + n2 * 0.4);
  float low = smoothstep(1.0 - max(p_height * 0.01, 0.05), 1.0, uv.y);
  float a = bands * mix(0.2, 1.0, low) * p_density * 0.01 * 0.85;
  vec3 tint = mix(vec3(0.82, 0.88, 0.96), vec3(1.0, 0.9, 0.78), p_warmth * 0.01);
  vec3 col = mix(c, tint, clamp(a, 0.0, 1.0));
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'hearts',
    name: 'hearts',
    category: 'overlay',
    description: 'small pink and red hearts floating upward',
    posterTime: 1.5,
    params: [
      { key: 'density', label: 'density', min: 0, max: 100, step: 1, default: 45, unit: '%' },
      { key: 'size', label: 'size', min: 0.4, max: 2.5, step: 0.05, default: 1, unit: 'x' },
      { key: 'speed', label: 'speed', min: 0, max: 5, step: 0.05, default: 1.5, unit: 'x' },
      { key: 'sway', label: 'sway', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    ],
    glsl: `${LAYERS}
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 p = apos(uv);
  float t = u_time;
  vec3 col = c;
  for (int l = 0; l < 2; l++) {
    float fl = float(1 - l);
    float depth = 1.0 - fl * 0.3;
    float cells = (3.0 + p_density * 0.07) * (1.0 + fl * 0.8);
    float px = cells / u_res.y;
    vec2 q = p * cells;
    q.y += t * p_speed * 0.1 * depth * cells;
    vec2 id = floor(q);
    vec2 f = q - id;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 g = vec2(float(i) - 1.0, float(j) - 1.0);
        vec3 h = crand(id + g, fl);
        vec2 pos = g + 0.25 + 0.5 * h.xy;
        float sw = sin(t * (0.7 + h.x) + h.y * TAU);
        pos.x += 0.2 * p_sway * 0.01 * sw;
        float r = min((0.1 + 0.07 * h.y) * p_size, 0.4);
        // local heart space: a little tilt, x right, y UP, scaled so the heart spans about 1.2
        vec2 loc = rot(f - pos, 0.35 * p_sway * 0.01 * sw) / max(r * 1.2, 0.0001);
        float x = loc.x;
        float y = 0.125 - loc.y;
        float a2 = x * x + y * y - 1.0;
        // implicit heart curve: negative inside
        float val = a2 * a2 * a2 - x * x * y * y * y;
        float edge = 4.0 * px / max(r, 0.0001) + 0.02;
        float m = smoothstep(0.0, edge, -val);
        vec3 hc = hsv2rgb(vec3(fract(0.94 + 0.1 * h.x), 0.55 + 0.35 * h.y, 1.0));
        hc *= 0.85 + 0.15 * clamp(y, -1.0, 1.0);
        col = mix(col, hc, m * step(0.5, h.z) * 0.92);
      }
    }
  }
  return vec4(mix(c, col, u_amount), 1.0);
}`,
  },
  {
    id: 'spotlight',
    name: 'spotlight',
    category: 'overlay',
    description: 'darkens everything outside a soft circle of light',
    posterTime: 1,
    params: [
      { key: 'x', label: 'x', min: -20, max: 120, step: 1, default: 50, unit: '%' },
      { key: 'y', label: 'y', min: -20, max: 120, step: 1, default: 50, unit: '%' },
      { key: 'size', label: 'size', min: 10, max: 250, step: 1, default: 70, unit: '%' },
      { key: 'softness', label: 'softness', min: 0, max: 100, step: 1, default: 40, unit: '%' },
    ],
    glsl: `
vec4 effect(vec2 uv) {
  vec3 c = tex(uv).rgb;
  vec2 d = (uv - vec2(p_x, p_y) * 0.01) * vec2(aspect(), 1.0);
  // size is the diameter of the lit circle in frame heights
  float r = p_size * 0.01 * 0.5;
  float w = p_softness * 0.01 * r * 0.95 + 0.003;
  float m = smoothstep(r - w, r + w, length(d));
  return vec4(c * (1.0 - m * 0.88 * u_amount), 1.0);
}`,
  },
];
