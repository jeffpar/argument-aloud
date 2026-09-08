#!/usr/bin/env node
// One-off: resolve the 2026 Video Voters' Guide TVW events (WA Supreme Court
// races) to direct Backblaze .mp4 URLs, the same way import_wasc.js --tvw does.
import fs from 'node:fs';
import path from 'node:path';

const INVINTUS_URL = 'https://api.v3.invintus.com/v2/Event/getDetailed';
const INVINTUS_KEY = '7WhiEBzijpritypp8bqcU7pfU9uicDR';
const INVINTUS_CLIENT = '9375922947';
const CACHE = path.join(process.cwd(), 'courts/wasc/cache/tvw');

const RACES = [
  ['Position 1', [['Colleen Melody', '2026061108'], ['Scott Edwards', '2026061106']]],
  ['Position 3', [['Jaime Michelle Hawk', '2026061105'], ['David Stevens', '2026061104']]],
  ['Position 4', [['Ian Birk', '2026061102'], ["Sean O'Donnell", '2026061101']]],
  ['Position 5', [['Theo Angelis', '2026061100'], ['Dave Larson', '2026061099']]],
  ['Position 7', [['Debra L. Stephens', '2026061097'], ['Todd A. Bloom', '2026061212']]],
];

async function invintusEvent(eid) {
  const cf = path.join(CACHE, `${eid}.json`);
  if (fs.existsSync(cf)) {
    try { const j = JSON.parse(fs.readFileSync(cf, 'utf8')); if (j && j.data) return j.data; } catch {}
  }
  const resp = await fetch(INVINTUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: 'embedder', 'wsc-api-key': INVINTUS_KEY },
    body: JSON.stringify({ eventID: String(eid), clientID: INVINTUS_CLIENT, showStreams: true, showDownloadLinks: true, showMediaAssets: true }),
  });
  const j = await resp.json().catch(() => null);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cf, JSON.stringify(j || {}, null, 1), 'utf8');
  return (j && !(j.errors && j.errors.hasError) && j.data && j.data.eventID) ? j.data : null;
}

async function probeSize(url) {
  if (!url) return 0;
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    const cr = r.headers.get('content-range');
    if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) return +m[1]; }
    const cl = r.headers.get('content-length');
    return cl && r.status === 200 ? +cl : 0;
  } catch { return 0; }
}

async function media(d, eid) {
  const out = {};
  const vids = (d.mediaAssets || []).filter((a) => a.type === 'video');
  const vAsset = vids.find((a) => a.currentStatus === 'archive') || vids[0];
  const dl = d.downloadLinks || {};
  const hashOf = (s) => (/([0-9a-f]{40})\.(?:mp4|m4a)\b/i.exec(String(s || '')) || [])[1];
  let videoUrl = '';
  if (vAsset && /f005\.backblazeb2\.com/i.test(vAsset.fileUrl || '')) videoUrl = vAsset.fileUrl;
  if (!videoUrl) {
    const h = hashOf(vAsset && vAsset.fileUrl) || hashOf(dl.videoDownloadURI);
    if (h) videoUrl = `https://f005.backblazeb2.com/file/invintus-client-media/${INVINTUS_CLIENT}/${h}.mp4`;
  }
  if (!videoUrl && dl.videoDownloadURI) videoUrl = dl.videoDownloadURI;
  if (videoUrl) out.video_url = videoUrl;
  let hls = (d.streamingURIs && d.streamingURIs.main) || '';
  if (hls && hls.includes('//media.m3u8')) hls = hls.replace('//media.m3u8', `/${eid}/media.m3u8`);
  if (hls) out.hls_url = hls;
  if (vAsset && /^\d{1,2}:\d{2}:\d{2}$/.test(vAsset.totalRunTime || '')) out.length = vAsset.totalRunTime;
  let size = +(vAsset && vAsset.fileSize) || 0;
  if (!size && out.video_url) size = await probeSize(out.video_url);
  if (size) out.size = size;
  const capAsset = (d.mediaAssets || []).find((a) => a.type === 'caption');
  const vtt = d.captionPath || (capAsset && capAsset.fileUrl) || '';
  if (/\.vtt(\?|$)/i.test(vtt)) out.captions_url = vtt;
  return out;
}

for (const [pos, cands] of RACES) {
  console.log(`\n=== ${pos} ===`);
  for (const [name, eid] of cands) {
    const d = await invintusEvent(eid);
    if (!d) { console.log(`  ${name} (${eid}): NOT FOUND`); continue; }
    const m = await media(d, eid);
    console.log(`  ${name} (${eid}):`);
    console.log(`    video_url:  ${m.video_url || '(none)'}`);
    console.log(`    hls_url:    ${m.hls_url || '(none)'}`);
    console.log(`    length:     ${m.length || '(none)'}   size: ${m.size || '(none)'}   captions: ${m.captions_url || '(none)'}`);
  }
}
