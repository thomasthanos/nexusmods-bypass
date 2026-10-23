import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
  <defs>
    <!-- Background Gradients -->
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141824"/>
      <stop offset="45%" stop-color="#0f121a"/>
      <stop offset="100%" stop-color="#1c161a"/>
    </linearGradient>

    <radialGradient id="gold-glow" cx="50%" cy="30%" r="55%">
      <stop offset="0%" stop-color="#eaa14c" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#eaa14c" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#eaa14c" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="blue-glow" cx="85%" cy="85%" r="45%">
      <stop offset="0%" stop-color="#45c8e6" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#45c8e6" stop-opacity="0"/>
    </radialGradient>

    <!-- Card Rim -->
    <linearGradient id="card-rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f4e5d4" stop-opacity="0.4"/>
      <stop offset="40%" stop-color="#b9bfd1" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#eaa14c" stop-opacity="0.45"/>
    </linearGradient>

    <!-- Tile Gradients -->
    <linearGradient id="tile-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#d3ae7d" stop-opacity="0.42"/>
      <stop offset="50%" stop-color="#644a32" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#261e19" stop-opacity="0.98"/>
    </linearGradient>

    <linearGradient id="tile-depth" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#80562f"/>
      <stop offset="100%" stop-color="#251e19"/>
    </linearGradient>

    <linearGradient id="arrow-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8ef"/>
      <stop offset="100%" stop-color="#f0a24d"/>
    </linearGradient>

    <linearGradient id="pill-bg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#222838" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#181c28" stop-opacity="0.85"/>
    </linearGradient>

    <linearGradient id="pill-border" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#eaa14c" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#45c8e6" stop-opacity="0.25"/>
    </linearGradient>

    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="#000000" flood-opacity="0.5"/>
    </filter>

    <filter id="tile-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.65"/>
    </filter>
  </defs>

  <style>
    .font-title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-weight: 800; }
    .font-sub { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-weight: 500; }
    .font-pill { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-weight: 600; }
  </style>

  <!-- Background Base -->
  <rect width="1280" height="640" fill="url(#bg)"/>

  <!-- Glows -->
  <rect width="1280" height="640" fill="url(#gold-glow)"/>
  <rect width="1280" height="640" fill="url(#blue-glow)"/>

  <!-- Subtle Inner Border Frame -->
  <rect x="24" y="24" width="1232" height="592" rx="28" fill="none" stroke="url(#card-rim)" stroke-width="1.5" stroke-opacity="0.6"/>

  <!-- Decorative Corner Accents -->
  <circle cx="56" cy="56" r="3" fill="#eaa14c" opacity="0.6"/>
  <circle cx="1224" cy="56" r="3" fill="#eaa14c" opacity="0.6"/>
  <circle cx="56" cy="584" r="3" fill="#45c8e6" opacity="0.6"/>
  <circle cx="1224" cy="584" r="3" fill="#45c8e6" opacity="0.6"/>

  <!-- TOP BRAND ICON (Center: x=640, y=140) -->
  <g transform="translate(640, 140)" filter="url(#tile-shadow)">
    <!-- Shadow Base -->
    <ellipse cx="0" cy="68" rx="64" ry="10" fill="#000000" fill-opacity="0.4"/>

    <!-- Depth Layer -->
    <rect x="-56" y="-50" width="112" height="112" rx="28" fill="url(#tile-depth)" stroke="#eaa14c" stroke-opacity="0.3"/>

    <!-- Front Tile -->
    <rect x="-56" y="-58" width="112" height="112" rx="28" fill="url(#tile-bg)" stroke="url(#card-rim)" stroke-width="1.8"/>

    <!-- Top Highlight Curve -->
    <path d="M-40 -48 Q-24 -51 0 -51 Q24 -51 40 -48" fill="none" stroke="#fff4e0" stroke-opacity="0.35" stroke-width="1.5" stroke-linecap="round"/>

    <!-- Download Arrow -->
    <g transform="translate(0, -58)">
      <path d="M -6 28 H 6 V 54 H 20 L 0 76 L -20 54 H -6 Z" fill="#000000" fill-opacity="0.3" transform="translate(0, 3)"/>
      <path d="M -6 28 H 6 V 54 H 20 L 0 76 L -20 54 H -6 Z" fill="url(#arrow-grad)"/>
      <path d="M -20 84 H 20" stroke="#fff1d8" stroke-width="5" stroke-linecap="round"/>
    </g>
  </g>

  <!-- MAIN TITLE -->
  <text class="font-title" x="640" y="278" font-size="54" fill="#ffffff" text-anchor="middle" letter-spacing="-1.2">
    NexusMods Bypass
  </text>

  <!-- SUBTITLE / TAGLINE -->
  <text class="font-sub" x="640" y="328" font-size="22" fill="#d8dce6" text-anchor="middle" letter-spacing="-0.2">
    Queue Nexus Mods collections, skip repetitive steps, and resume downloads
  </text>

  <!-- 4 FEATURE PILLS (Centered horizontally) -->
  <!-- Pill 1: Queue & Auto-start (x=160) -->
  <g transform="translate(140, 385)">
    <rect width="220" height="52" rx="14" fill="url(#pill-bg)" stroke="url(#pill-border)" stroke-width="1.2"/>
    <text class="font-pill" x="110" y="32" font-size="15" fill="#f4f5f8" text-anchor="middle">⚡ Collection Queue</text>
  </g>

  <!-- Pill 2: Vortex & MO2 (x=385) -->
  <g transform="translate(385, 385)">
    <rect width="240" height="52" rx="14" fill="url(#pill-bg)" stroke="url(#pill-border)" stroke-width="1.2"/>
    <text class="font-pill" x="120" y="32" font-size="15" fill="#f4f5f8" text-anchor="middle">🛡️ Vortex &amp; MO2 Handoff</text>
  </g>

  <!-- Pill 3: Skip Requirements (x=650) -->
  <g transform="translate(650, 385)">
    <rect width="230" height="52" rx="14" fill="url(#pill-bg)" stroke="url(#pill-border)" stroke-width="1.2"/>
    <text class="font-pill" x="115" y="32" font-size="15" fill="#f4f5f8" text-anchor="middle">⏩ Skip Wait &amp; Popups</text>
  </g>

  <!-- Pill 4: Resume & History (x=905) -->
  <g transform="translate(905, 385)">
    <rect width="235" height="52" rx="14" fill="url(#pill-bg)" stroke="url(#pill-border)" stroke-width="1.2"/>
    <text class="font-pill" x="117" y="32" font-size="15" fill="#f4f5f8" text-anchor="middle">🔄 Auto-Resume &amp; Logs</text>
  </g>

  <!-- BOTTOM BAR: Supported Browsers & Licence Badge -->
  <g transform="translate(640, 520)">
    <!-- Browser Support Pill -->
    <rect x="-240" y="-18" width="480" height="36" rx="18" fill="#151a26" stroke="#2c3345" stroke-width="1"/>
    <text class="font-pill" x="0" y="5" font-size="14" fill="#a4adc2" text-anchor="middle">
      Chrome &nbsp;·&nbsp; Firefox &nbsp;·&nbsp; Edge &nbsp;·&nbsp; Brave &nbsp;&nbsp;|&nbsp;&nbsp; Manifest V3
    </text>
  </g>

  <!-- FOOTER NOTE -->
  <text class="font-sub" x="640" y="575" font-size="13" fill="#6c768d" text-anchor="middle">
    Free &amp; Open Source · github.com/thomasthanos/nexusmods-bypass
  </text>
</svg>
`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    deviceScaleFactor: 1
  });

  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;overflow:hidden;background:#000;">${svg}</body></html>`);

  // Output paths
  const assetsDir = join(process.cwd(), '.github', 'assets');
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });

  const destPng = join(assetsDir, 'social-preview.png');
  const artifactDir = 'C:\\Users\\Thomas\\.gemini\\antigravity\\brain\\1912c698-0f12-4080-aa33-884dbc154349';
  const artifactPng = join(artifactDir, 'social-preview.png');

  await page.screenshot({ path: destPng, type: 'png' });
  await page.screenshot({ path: artifactPng, type: 'png' });

  console.log('Saved to:', destPng);
  console.log('Saved to:', artifactPng);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
