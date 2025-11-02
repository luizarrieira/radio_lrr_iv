// renderer.js — Versão final com preload inteligente da sequência inicial
// - Ducking: reduce to 50% (DUCK_TARGET = 0.5), fade down/up = 0.1s
// - Uses duracoes_narracoes.json for narration durations (no attempts limit; chooses among fits)
// - Preloads the *first chosen sequence* fully before starting playback to avoid intro misfires
// - Then preloads rest in background
// - DJSOLO replaces DJ/CALL, ADV goes to AD083
// - SUN weather only when condition clear and hour between 05:00 and 18:00
// - Manual start via element with id="btnStart"
// - Logs abundant for debugging

/* ================= CONFIG & GLOBALS ================= */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

// Ducking config
const DUCK_TARGET = 0.5; // music reduced to 50%
const DUCK_DOWN_TIME = 0.1; // faster fade (0.1s)
const DUCK_UP_TIME = 0.1;
const DUCK_RELEASE_DELAY_MS = 200; // small buffer before raising back

// Default cover
const DEFAULT_COVER = 'capas/default.jpg';
let currentCover = DEFAULT_COVER;

// Gains
const musicGain = audioCtx.createGain();
musicGain.gain.value = 1.0;
musicGain.connect(audioCtx.destination);

const narrationGain = audioCtx.createGain();
narrationGain.connect(audioCtx.destination);

// Optional analyser (connected to narrationGain)
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 512;
analyser.smoothingTimeConstant = 0.85;
narrationGain.connect(analyser);

// audio buffer cache & durations map
const audioBufferCache = new Map();
let duracoesNarracoes = {}; // will be loaded from duracoes_narracoes.json

// queues & state
let musicQueue = [];
let idQueue = [];
let advQueue = [];
let started = false;
let activeNarrationsCount = 0;
let duckReleaseTimeout = null;

/* ================= UTILITIES ================= */
function pad(n, len=2) { return String(n).padStart(len,'0'); }
function rand(arr) { return (arr && arr.length) ? arr[Math.floor(Math.random()*arr.length)] : null; }
function chance(p) { return Math.random() < p; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(...args) { console.log('[RADIO]', ...args); }

/* Weighted choice helper; items = [{k:'key', w:weight}, ...] -> returns k */
function weightedPick(items) {
  const total = items.reduce((s,i)=>s+i.w,0);
  let r = Math.random()*total;
  for (const it of items) { if (r < it.w) return it.k; r -= it.w; }
  return items[0].k;
}

/* ================= GROUPS & FILE LISTS ================= */
// IDs (narracoes/ID_01..ID_12.wav)
const grupoID = Array.from({length:12}, (_,i)=>`narracoes/ID_${pad(i+1,2)}.wav`);

// DJSOLO -> narracoes/SOLO_01..SOLO_13.wav
const grupoDJSolo = Array.from({length:13}, (_,i)=>`narracoes/SOLO_${pad(i+1,2)}.wav`);

// ADV -> adv/AD001..AD083.wav (updated)
const grupoAdv = Array.from({length:83}, (_,i)=>`adv/AD${pad(i+1,3)}.wav`);

// Weazel news -> news/NEWS_01..NEWS_70.wav
const grupoWeazelNews = Array.from({length:70}, (_,i)=>`news/NEWS_${pad(i+1,2)}.wav`);

// General narrations -> narracoes/GENERAL_01..GENERAL_25.wav
const narracoesGeneral = Array.from({length:25}, (_,i)=>`narracoes/GENERAL_${pad(i+1,2)}.wav`);

// ENDTO groups
const endto = {
  toad: Array.from({length:5}, (_,i)=>`narracoes/TO_AD_${pad(i+1,2)}.wav`),
  tonews: Array.from({length:5}, (_,i)=>`narracoes/TO_NEWS_${pad(i+1,2)}.wav`),
  towheather: Array.from({length:5}, (_,i)=>`narracoes/TO_WEATHER_${pad(i+1,2)}.wav`)
};

// Music-specific intro narrations (all in narracoes/)
const musicIntroNarrations = {
  'FASCINATION': ['narracoes/FASCINATION_01.wav','narracoes/FASCINATION_02.wav'],
  'REMEDY': ['narracoes/REMEDY_01.wav','narracoes/REMEDY_02.wav'],
  '1979': ['narracoes/1979_01.wav'],
  'CRY': ['narracoes/CRY_01.wav'],
  'DOMINION': ['narracoes/DOMINION_01.wav'],
  'EVILWOMAN': ['narracoes/EVILWOMAN_01.wav'],
  'GOODBYEHORSES': ['narracoes/GOODBYEHORSES_01.wav'],
  'HEAVENANDHELL': ['narracoes/HEAVENHELL_01.wav','narracoes/HEAVENHELL_02.wav'],
  'ONEVISION': ['narracoes/ONEVISION_01.wav','narracoes/ONEVISION_02.wav'],
  'ROCKYMOUNTAINWAY': ['narracoes/ROCKYMOUNTAINWAY_01.wav'],
  'STRAIGHTON': ['narracoes/STRAIGHTON_01.wav','narracoes/STRAIGHTON_02.wav'],
  'THESEEKER': ['narracoes/THESEEKER_01.wav'],
  'THUG': ['narracoes/THUG_01.wav','narracoes/THUG_02.wav'],
  'TURNYOUINSIDEOUT': ['narracoes/TURNYOUINSIDEOUT_01.wav']
};

// Music list with zones (introStart, introEnd, finalStart, finalEnd in ms)
const musicasList = [
  {id:'fascination', name:'FASCINATION', arquivo:'musicas/FASCINATION.wav', introStart:5581, introEnd:27563, finalStart:188733, finalEnd:216000, capa:'capas/fascination.jpg'},
  {id:'remedy', name:'REMEDY', arquivo:'musicas/REMEDY.wav', introStart:6020, introEnd:36138, finalStart:195886, finalEnd:222205, capa:'capas/remedy.jpg'},
  {id:'cocaine', name:'COCAINE', arquivo:'musicas/COCAINE.wav', finalStart:171349, finalEnd:201728, capa:'capas/cocaine.jpg'},
  {id:'1979', name:'1979', arquivo:'musicas/1979.wav', introStart:1895, introEnd:11613, finalStart:226907, finalEnd:244963, capa:'capas/1979.jpg'},
  {id:'cry', name:'CRY', arquivo:'musicas/CRY.wav', introStart:3413, introEnd:15736, finalStart:195000, finalEnd:218269, capa:'capas/cry.jpg'},
  {id:'dominion', name:'DOMINION', arquivo:'musicas/DOMINION.wav', capa:'capas/dominion.jpg'},
  {id:'edgeofseventeen', name:'EDGEOFSEVENTEEN', arquivo:'musicas/EDGEOFSEVENTEEN.wav', finalStart:242440, finalEnd:269738, capa:'capas/edgeofseventeen.jpg'},
  {id:'evilwoman', name:'EVILWOMAN', arquivo:'musicas/EVILWOMAN.wav', introStart:6570, introEnd:29958, finalStart:195393, finalEnd:225301, capa:'capas/evilwoman.jpg'},
  {id:'goodbyehorses', name:'GOODBYEHORSES', arquivo:'musicas/GOODBYEHORSES.wav', introStart:6826, introEnd:28508, finalStart:137199, finalEnd:165000, capa:'capas/goodbyehorses.jpg'},
  {id:'heavenandhell', name:'HEAVENANDHELL', arquivo:'musicas/HEAVENANDHELL.wav', introStart:2986, introEnd:22250, finalStart:280405, finalEnd:302770, capa:'capas/heavenandhell.jpg'},
  {id:'herstrut', name:'HERSTRUT', arquivo:'musicas/HERSTRUT.wav', introStart:4199, introEnd:24966, finalStart:157991, finalEnd:190000, capa:'capas/herstrut.jpg'},
  {id:'iwannabeyourdog', name:'IWANNABEYOURDOG', arquivo:'musicas/IWANNABEYOURDOG.wav', introStart:2380, introEnd:23786, finalStart:151573, finalEnd:174866, capa:'capas/iwannabeyourdog.jpg'},
  {id:'jailbreak', name:'JAILBREAK', arquivo:'musicas/JAILBREAK.wav', introStart:2197, introEnd:18983, finalStart:206452, finalEnd:235163, capa:'capas/jailbreak.jpg'},
  {id:'mama', name:'MAMA', arquivo:'musicas/MAMA.wav', introStart:4889, introEnd:29179, finalStart:260364, finalEnd:291065, capa:'capas/mama.jpg'},
  {id:'newyorkgroove', name:'NEWYORKGROOVE', arquivo:'musicas/NEWYORKGROOVE.wav', finalStart:127005, finalEnd:152020, capa:'capas/newyorkgroove.jpg'},
  {id:'onevision', name:'ONEVISION', arquivo:'musicas/ONEVISION.wav', introStart:9642, introEnd:30922, finalStart:215893, finalEnd:227306, capa:'capas/onevision.jpg'},
  {id:'rockymountainway', name:'ROCKYMOUNTAINWAY', arquivo:'musicas/ROCKYMOUNTAINWAY.wav', introStart:21606, introEnd:47224, finalStart:234922, finalEnd:260224, capa:'capas/rockymountainway.jpg'},
  {id:'straighton', name:'STRAIGHTON', arquivo:'musicas/STRAIGHTON.wav', introStart:2052, introEnd:17002, finalStart:157013, finalEnd:185290, capa:'capas/straighton.jpg'},
  {id:'streetkids', name:'STREETKIDS', arquivo:'musicas/STREETKIDS.wav', introStart:4853, introEnd:23040, finalStart:219858, finalEnd:247773, capa:'capas/streetkids.jpg'},
  {id:'theseeker', name:'THESEEKER', arquivo:'musicas/THESEEKER.wav', introStart:3504, introEnd:17007, finalStart:144031, finalEnd:184829, capa:'capas/theseeker.jpg'},
  {id:'thug', name:'THUG', arquivo:'musicas/THUG.wav', introStart:1858, introEnd:16282, finalStart:173141, finalEnd:197448, capa:'capas/thug.jpg'},
  {id:'turnyouinsideout', name:'TURNYOUINSIDEOUT', arquivo:'musicas/TURNYOUINSIDEOUT.wav', introStart:3923, introEnd:21663, finalStart:167936, finalEnd:190086, capa:'capas/turnyouinsideout.jpg'}
];

/* ================= QUEUE HELPERS ================= */
function shuffle(arr){ const a = arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function resetMusicQueue(){ musicQueue = shuffle(musicasList.slice()); }
function resetIDAdvQueues(){ idQueue = shuffle(grupoID.slice()); advQueue = shuffle(grupoAdv.slice()); }
async function nextMusic(){ if(!musicQueue || musicQueue.length===0) resetMusicQueue(); return musicQueue.shift(); }
async function nextID(){ if(!idQueue || idQueue.length===0) resetIDAdvQueues(); return idQueue.shift(); }
async function nextAdv(){ if(!advQueue || advQueue.length===0) resetIDAdvQueues(); return advQueue.shift(); }

/* ================= LOAD DURAÇÕES JSON ================= */
async function loadDuracoesJSON(){
  try{
    const resp = await fetch('duracoes_narracoes.json');
    if(!resp.ok) throw new Error('fetch duracoes failed ' + resp.status);
    duracoesNarracoes = await resp.json();
    log('Loaded duracoes_narracoes.json entries:', Object.keys(duracoesNarracoes).length);
  } catch(e){
    console.warn('Failed to load duracoes_narracoes.json:', e);
    duracoesNarracoes = {};
  }
}

/* ================= AUDIO BUFFER HELPERS ================= */
async function getAudioBuffer(path){
  if(audioBufferCache.has(path)) return audioBufferCache.get(path);
  try{
    const res = await fetch(path);
    if(!res.ok) throw new Error('fetch ' + res.status + ' ' + path);
    const ab = await res.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(ab);
    audioBufferCache.set(path, buf);
    return buf;
  }catch(e){
    console.warn('getAudioBuffer error', path, e);
    throw e;
  }
}
async function playBufferToDestination(buf){
  return new Promise(resolve => {
    const s = audioCtx.createBufferSource();
    s.buffer = buf;
    s.connect(audioCtx.destination);
    s.onended = () => resolve();
    s.start();
  });
}
async function playBufferToNarrationGain(buf){
  return new Promise(resolve => {
    const s = audioCtx.createBufferSource();
    s.buffer = buf;
    s.connect(narrationGain);
    s.onended = () => resolve();
    s.start();
  });
}

/* ================= DUCKING CONTROL ================= */
function onNarrationStart(){
  activeNarrationsCount++;
  if(duckReleaseTimeout){ clearTimeout(duckReleaseTimeout); duckReleaseTimeout=null; }
  const now = audioCtx.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(musicGain.gain.value, now);
  musicGain.gain.linearRampToValueAtTime(DUCK_TARGET, now + DUCK_DOWN_TIME);
  log('Ducking start ->', DUCK_TARGET);
}
function onNarrationEnd(){
  activeNarrationsCount = Math.max(0, activeNarrationsCount - 1);
  if(activeNarrationsCount === 0){
    duckReleaseTimeout = setTimeout(()=>{
      const now = audioCtx.currentTime;
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setValueAtTime(musicGain.gain.value, now);
      musicGain.gain.linearRampToValueAtTime(1.0, now + DUCK_UP_TIME);
      duckReleaseTimeout = null;
      log('Ducking release -> 1.0');
    }, DUCK_RELEASE_DELAY_MS);
  }
}

/* ================= COVER HANDLING ================= */
function updateCover(newCover = DEFAULT_COVER, force=false){
  const el = document.getElementById('capa') || document.getElementById('cover') || null;
  if(!el) return;
  const target = newCover || DEFAULT_COVER;
  if(force || target !== currentCover){
    el.src = target;
    currentCover = target;
    log('Cover ->', target.includes('default') ? 'default' : target);
  }
}

/* ================= WEATHER & TIME HELPERS ================= */
let currentWeatherMain = 'Clear';
async function fetchWeather(){
  try {
    const apiKey = '0cad953b1e9b3793a944d644d5193d3a';
    const resp = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Maringa,BR&appid=${apiKey}`);
    const j = await resp.json();
    currentWeatherMain = j && j.weather && j.weather[0] && j.weather[0].main ? j.weather[0].main : 'Clear';
    log('Weather fetched:', currentWeatherMain);
  } catch(e){
    console.warn('fetchWeather failed', e);
    currentWeatherMain = 'Clear';
  }
}

/* pickWeatherFile now includes SUN only if condition clear AND hour between 5..18 */
function pickWeatherFile(condition){
  if(!condition) return null;
  const c = String(condition).toLowerCase();
  const h = new Date().getHours();
  if(c.includes('cloud')) { const n=Math.floor(Math.random()*11)+1; return `weather/CLOUD_${pad(n,2)}.wav`; }
  if(c.includes('fog')||c.includes('mist')) { const n=Math.floor(Math.random()*12)+1; return `weather/FOG_${pad(n,2)}.wav`; }
  if(c.includes('rain')) { const n=Math.floor(Math.random()*11)+1; return `weather/RAIN_${pad(n,2)}.wav`; }
  // SUN only if clear AND between 05:00 and 18:00
  if((c.includes('clear') || c.includes('sun')) && h >= 5 && h <= 18) { const n=Math.floor(Math.random()*12)+1; return `weather/SUN_${pad(n,2)}.wav`; }
  if(c.includes('wind')||c.includes('breeze')) { const n=Math.floor(Math.random()*11)+1; return `weather/WIND_${pad(n,2)}.wav`; }
  return null;
}

function pickTimeNarration(){
  const h = new Date().getHours();
  if(h>=4 && h<=10){ const n=Math.floor(Math.random()*5)+1; return `narracoes/MORNING_${pad(n,2)}.wav`; }
  if(h>=13 && h<=16){ const n=Math.floor(Math.random()*5)+1; return `narracoes/AFTERNOON_${pad(n,2)}.wav`; }
  if(h>=18 && h<=19){ const n=Math.floor(Math.random()*6)+1; return `narracoes/EVENING_${pad(n,2)}.wav`; }
  if(h>=21 || h<=1){ const n=Math.floor(Math.random()*5)+1; return `narracoes/NIGHT_${pad(n,2)}.wav`; }
  return null;
}

/* ================= CANDIDATE FILTER BY ZONE (uses duracoesNarracoes) ================= */
/* candidates: array of paths (with folders), zoneLenMs: number */
function filterCandidatesByZone(candidates, zoneLenMs){
  if(!candidates || candidates.length===0) return [];
  const out = [];
  for(const p of candidates){
    const parts = p.split('/');
    const fname = parts[parts.length-1]; // e.g. GENERAL_01.wav
    const d = duracoesNarracoes[fname];
    if(typeof d === 'number' && d <= zoneLenMs) out.push({path:p, dur:d});
  }
  return out;
}
function chooseRandomCandidateThatFits(poolPaths, zoneLenMs){
  const filtered = filterCandidatesByZone(poolPaths, zoneLenMs);
  if(filtered.length === 0) return null;
  return filtered[Math.floor(Math.random()*filtered.length)]; // returns {path,dur}
}

/* ================= SCHEDULE NARRATION TO END AT zoneEndMs ================= */
/**
 * Schedules narration so it ends exactly at zoneEndMs (ms relative to music start).
 * Returns {scheduled, promise, chosen, dur}
 */
async function scheduleNarrationToEndAt(musicStartAudioTime, zoneStartMs, zoneEndMs, candidatePath, candidateDurMs, meta={}){
  if(!candidatePath) return {scheduled:false};
  const durMs = candidateDurMs;
  let startOffsetSec = (zoneEndMs - durMs) / 1000;
  if(startOffsetSec < zoneStartMs/1000) startOffsetSec = zoneStartMs/1000;
  const startAudioTime = musicStartAudioTime + startOffsetSec;

  try{
    const buf = await getAudioBuffer(candidatePath);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(narrationGain);

    // duck lead slightly before start
    const now = audioCtx.currentTime;
    const leadMs = 40;
    const duckDelayMs = Math.max(0, (startAudioTime - now)*1000 - leadMs);
    if(duckDelayMs > 0){
      setTimeout(()=>{ onNarrationStart(); }, duckDelayMs);
    } else {
      requestAnimationFrame(()=>onNarrationStart());
    }

    try { src.start(startAudioTime); } catch(e) { src.start(); }

    const p = new Promise(resolve => {
      src.onended = () => {
        onNarrationEnd();
        resolve({path:candidatePath, meta});
      };
    });
    log('Scheduled narration', candidatePath, 'startAudioTime', startAudioTime.toFixed(3));
    return {scheduled:true, promise:p, chosen:candidatePath, dur:durMs, meta};
  }catch(e){
    console.warn('scheduleNarrationToEndAt failed', candidatePath, e);
    return {scheduled:false};
  }
}

/* ================= PLAY IMMEDIATE NARRATION (news/weather) ================= */
async function playNarrationImmediate(path){
  updateCover(DEFAULT_COVER);
  try{
    const buf = await getAudioBuffer(path);
    log('Playing immediate narration', path);
    onNarrationStart();
    await playBufferToNarrationGain(buf);
    onNarrationEnd();
  }catch(e){
    console.warn('playNarrationImmediate failed', path, e);
  }
}

/* ================= ENDTO FOLLOWUPS (run AFTER music & final narration finish) ================= */
async function handleEndtoFollowupQueued(subgroup){
  if(!subgroup) return;
  updateCover(DEFAULT_COVER);
  log('ENDTO followup for', subgroup);
  if(subgroup === 'toad'){
    const pick = Math.random() < 0.5 ? 'adv+musica' : 'adv+id+musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'tonews'){
    const newsPath = rand(grupoWeazelNews);
    await playNarrationImmediate(newsPath);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'towheather'){
    const weatherFile = pickWeatherFile(currentWeatherMain);
    if(weatherFile) await playNarrationImmediate(weatherFile);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  }
}

/* ================= RUN IMMEDIATE SEQUENCE (used by ENDTO followups) ================= */
async function runSequenceImmediately(seq){
  log('runSequenceImmediately ->', seq);
  switch(seq){
    case 'adv+musica': {
      updateCover(DEFAULT_COVER);
      const adv = await nextAdv();
      await playBufferToDestination(await getAudioBuffer(adv));
      const m = await nextMusic();
      await playMusicWithNarrations(m);
      break;
    }
    case 'adv+id+musica': {
      updateCover(DEFAULT_COVER);
      const adv = await nextAdv();
      await playBufferToDestination(await getAudioBuffer(adv));
      const id = await nextID();
      await playBufferToDestination(await getAudioBuffer(id));
      const m = await nextMusic();
      await playMusicWithNarrations(m);
      break;
    }
    case 'id+musica': {
      updateCover(DEFAULT_COVER);
      const id = await nextID();
      await playBufferToDestination(await getAudioBuffer(id));
      const m = await nextMusic();
      await playMusicWithNarrations(m);
      break;
    }
    case 'id+djsolo+musica': {
      updateCover(DEFAULT_COVER);
      const id = await nextID();
      await playBufferToDestination(await getAudioBuffer(id));
      const d = rand(grupoDJSolo);
      await playBufferToDestination(await getAudioBuffer(d));
      const m = await nextMusic();
      await playMusicWithNarrations(m);
      break;
    }
    case 'djsolo+musica': {
      updateCover(DEFAULT_COVER);
      const d = rand(grupoDJSolo);
      await playBufferToDestination(await getAudioBuffer(d));
      const m = await nextMusic();
      await playMusicWithNarrations(m);
      break;
    }
    case 'musica': {
      const m = await nextMusic();
      await playMusicWithNarrations(m);
      break;
    }
    default:
      console.warn('Unknown immediate sequence', seq);
  }
}

/* ================= SEQUENCE POOL WEIGHTS ================= */
const sequencePool = [
  {k:'id+musica', w:3},
  {k:'djsolo+musica', w:3},
  {k:'musica', w:3},
  {k:'adv+musica', w:1},
  {k:'adv+id+musica', w:1},
  {k:'id+djsolo+musica', w:1}
];
function pickSequenceWeighted(){ return weightedPick(sequencePool); }

/* ================= PRELOAD HELPERS ================= */
/* Preload a list of file paths (best-effort). Returns when all attempts done (doesn't throw on individual failure). */
async function preloadFiles(list){
  const unique = Array.from(new Set(list));
  log('Preloading', unique.length, 'files');
  await Promise.all(unique.map(async p => {
    try { await getAudioBuffer(p); } catch(e){ /* ignore individual failure */ }
  }));
  log('PreloadFiles done');
}

/* Full best-effort preload (background) */
async function preloadAll(){
  const toPreload = new Set();
  musicasList.forEach(m => toPreload.add(m.arquivo));
  narracoesGeneral.forEach(p => toPreload.add(p));
  Object.values(musicIntroNarrations).flat().forEach(p => toPreload.add(p));
  Object.values(endto).flat().forEach(p => toPreload.add(p));
  grupoID.forEach(p => toPreload.add(p));
  grupoDJSolo.forEach(p => toPreload.add(p));
  grupoAdv.forEach(p => toPreload.add(p));
  grupoWeazelNews.forEach(p => toPreload.add(p));
  for (let i=1;i<=5;i++) toPreload.add(`narracoes/MORNING_${pad(i,2)}.wav`);
  for (let i=1;i<=5;i++) toPreload.add(`narracoes/AFTERNOON_${pad(i,2)}.wav`);
  for (let i=1;i<=6;i++) toPreload.add(`narracoes/EVENING_${pad(i,2)}.wav`);
  for (let i=1;i<=5;i++) toPreload.add(`narracoes/NIGHT_${pad(i,2)}.wav`);
  for (let i=1;i<=11;i++) toPreload.add(`weather/CLOUD_${pad(i,2)}.wav`);
  for (let i=1;i<=12;i++) toPreload.add(`weather/FOG_${pad(i,2)}.wav`);
  for (let i=1;i<=11;i++) toPreload.add(`weather/RAIN_${pad(i,2)}.wav`);
  for (let i=1;i<=12;i++) toPreload.add(`weather/SUN_${pad(i,2)}.wav`);
  for (let i=1;i<=11;i++) toPreload.add(`weather/WIND_${pad(i,2)}.wav`);
  const arr = Array.from(toPreload);
  await preloadFiles(arr);
}

/* ================= INITIAL SEQUENCE PRELOAD (CORE FEATURE) ================= */
/*
  - Choose a first sequence using same weighted logic
  - Build set of files required by that sequence (adv, id, djsolo, music, and any narrations that can be needed
    for the music's intro/final — we preload GENERALS + music-specific + TIME choices)
  - Preload them BEFORE starting playback to ensure intro narration timing correctness
*/
async function chooseInitialSequenceAndPreload(){
  // pick sequence weighted
  const seq = pickSequenceWeighted();
  log('Initial sequence chosen (for preload):', seq);

  const files = [];

  // helper: add music and its relevant narration pools if zone exists
  const addMusicWithNarrationPools = (musicObj) => {
    files.push(musicObj.arquivo);
    // preload music-specific intros if present
    const specific = musicIntroNarrations[musicObj.name] || [];
    specific.forEach(p=>files.push(p));
    // preload general narrations (they may be used)
    narracoesGeneral.forEach(p=>files.push(p));
    // preload time-based narrations candidates (one of them)
    for(let i=1;i<=5;i++) files.push(`narracoes/MORNING_${pad(i,2)}.wav`);
    for(let i=1;i<=5;i++) files.push(`narracoes/AFTERNOON_${pad(i,2)}.wav`);
    for(let i=1;i<=6;i++) files.push(`narracoes/EVENING_${pad(i,2)}.wav`);
    for(let i=1;i<=5;i++) files.push(`narracoes/NIGHT_${pad(i,2)}.wav`);
    // preload endto candidates if music has final zone
    Object.values(endto).flat().forEach(p=>files.push(p));
  };

  // choose a random music for the sequence (we must peek into musicQueue without consuming — but simpler: use nextMusic(), then reinsert front)
  // We'll use a fresh queue for deterministic initial selection
  if(!musicQueue || musicQueue.length===0) resetMusicQueue();
  // pick the first music that would be played by the sequence flow
  // But sequences sometimes have adv/id before music — we will pick the nextMusic() result
  const musicCandidate = await nextMusic(); // consumes one from queue intentionally
  // put it back at front so overall queue integrity kept
  musicQueue.unshift(musicCandidate);

  // build file list depending on sequence
  if(seq === 'musica'){
    addMusicWithNarrationPools(musicCandidate);
  } else if(seq === 'id+musica'){
    // preload one id candidate (random from queue)
    const idSample = idQueue && idQueue.length ? idQueue[0] : grupoID[0];
    files.push(idSample);
    addMusicWithNarrationPools(musicCandidate);
  } else if(seq === 'djsolo+musica'){
    const dSample = grupoDJSolo[Math.floor(Math.random()*grupoDJSolo.length)];
    files.push(dSample);
    addMusicWithNarrationPools(musicCandidate);
  } else if(seq === 'adv+musica'){
    const advSample = advQueue && advQueue.length ? advQueue[0] : grupoAdv[0];
    files.push(advSample);
    addMusicWithNarrationPools(musicCandidate);
  } else if(seq === 'adv+id+musica'){
    const advSample = advQueue && advQueue.length ? advQueue[0] : grupoAdv[0];
    const idSample = idQueue && idQueue.length ? idQueue[0] : grupoID[0];
    files.push(advSample, idSample);
    addMusicWithNarrationPools(musicCandidate);
  } else if(seq === 'id+djsolo+musica'){
    const idSample = idQueue && idQueue.length ? idQueue[0] : grupoID[0];
    const dSample = grupoDJSolo[Math.floor(Math.random()*grupoDJSolo.length)];
    files.push(idSample, dSample);
    addMusicWithNarrationPools(musicCandidate);
  } else {
    // fallback: preload the music and general narrations
    addMusicWithNarrationPools(musicCandidate);
  }

  // Deduplicate and preload
  const uniqueFiles = Array.from(new Set(files));
  log('Preloading initial sequence files:', uniqueFiles.length);
  await preloadFiles(uniqueFiles);
  log('Initial sequence preloaded.');
  return seq; // return chosen sequence so start function can use same sequence (important!)
}

/* ================= MAIN SEQUENCE RUNNER (sequential) ================= */
/* The loop will be started after initial preload & first sequence executed.
   It chooses sequences by weight and plays them. */
const sequencePool = [
  {k:'id+musica', w:3},
  {k:'djsolo+musica', w:3},
  {k:'musica', w:3},
  {k:'adv+musica', w:1},
  {k:'adv+id+musica', w:1},
  {k:'id+djsolo+musica', w:1}
];

function pickSequenceWeighted(){ return weightedPick(sequencePool); }

async function mainSequenceRunner(){
  try{
    const seq = pickSequenceWeighted();
    log('Sequence chosen:', seq);
    switch(seq){
      case 'id+musica': {
        updateCover(DEFAULT_COVER);
        const id = await nextID();
        log('Playing ID', id);
        await playBufferToDestination(await getAudioBuffer(id));
        const m = await nextMusic();
        await playMusicWithNarrations(m);
        break;
      }
      case 'djsolo+musica': {
        updateCover(DEFAULT_COVER);
        const d = rand(grupoDJSolo);
        log('Playing DJSOLO', d);
        await playBufferToDestination(await getAudioBuffer(d));
        const m = await nextMusic();
        await playMusicWithNarrations(m);
        break;
      }
      case 'musica': {
        const m = await nextMusic();
        await playMusicWithNarrations(m);
        break;
      }
      case 'adv+musica': {
        updateCover(DEFAULT_COVER);
        const adv = await nextAdv();
        log('Playing ADV', adv);
        await playBufferToDestination(await getAudioBuffer(adv));
        const m = await nextMusic();
        await playMusicWithNarrations(m);
        break;
      }
      case 'adv+id+musica': {
        updateCover(DEFAULT_COVER);
        const adv = await nextAdv();
        log('Playing ADV', adv);
        await playBufferToDestination(await getAudioBuffer(adv));
        const id = await nextID();
        log('Playing ID', id);
        await playBufferToDestination(await getAudioBuffer(id));
        const m = await nextMusic();
        await playMusicWithNarrations(m);
        break;
      }
      case 'id+djsolo+musica': {
        updateCover(DEFAULT_COVER);
        const id = await nextID();
        log('Playing ID', id);
        await playBufferToDestination(await getAudioBuffer(id));
        const d = rand(grupoDJSolo);
        log('Playing DJSOLO', d);
        await playBufferToDestination(await getAudioBuffer(d));
        const m = await nextMusic();
        await playMusicWithNarrations(m);
        break;
      }
      default:
        console.warn('Unknown sequence:', seq);
    }
  } catch(e){
    console.error('mainSequenceRunner error', e);
  } finally {
    await sleep(50);
    mainSequenceRunner().catch(err => console.error('mainSequenceRunner recursion error', err));
  }
}

/* ================= PLAY MUSIC WITH NARRATION SCHEDULING ================= */
/*
 - Schedules intro narration (70% chance) and final narration (70% chance)
 - Chooses among candidates that fit zone using duracoesNarracoes (unlimited attempts).
 - If ENDTO final narration chosen and scheduled, ENDTO followup is executed AFTER the music and the narration finish.
*/
async function playMusicWithNarrations(musicObj){
  log('Now playing:', musicObj.name, musicObj.arquivo);
  // set music cover (keeps during narrações)
  updateCover(musicObj.capa || DEFAULT_COVER, true);

  // load music buffer and start
  const musicBuf = await getAudioBuffer(musicObj.arquivo);
  const musicSrc = audioCtx.createBufferSource();
  musicSrc.buffer = musicBuf;
  musicSrc.connect(musicGain);

  const musicStartAudioTime = audioCtx.currentTime;
  musicSrc.start(musicStartAudioTime);
  log('Music started at audioTime', musicStartAudioTime.toFixed(3));

  const scheduledPromises = [];
  let endtoWasScheduled = false;
  let endtoQueuedSubgroup = null;

  // --- INTRO ---
  if(musicObj.introStart != null && musicObj.introEnd != null){
    if(chance(0.7)){
      // pick pool: general (40%), music-specific (40%), time (20%)
      const r = Math.random();
      if(r < 0.4){
        const pool = narracoesGeneral;
        const zoneLen = musicObj.introEnd - musicObj.introStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){
          const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'general'});
          if(res.scheduled) scheduledPromises.push(res.promise);
        } else log('Intro: no general candidate fits for', musicObj.name);
      } else if(r < 0.8){
        const pool = musicIntroNarrations[musicObj.name] || [];
        if(pool.length > 0){
          const zoneLen = musicObj.introEnd - musicObj.introStart;
          const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
          if(chosen){
            const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'music-specific'});
            if(res.scheduled) scheduledPromises.push(res.promise);
          } else log('Intro: no music-specific candidate fits for', musicObj.name);
        } else log('Intro: no music-specific pool for', musicObj.name);
      } else {
        const timePath = pickTimeNarration();
        if(timePath){
          const zoneLen = musicObj.introEnd - musicObj.introStart;
          const chosen = chooseRandomCandidateThatFits([timePath], zoneLen);
          if(chosen){
            const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'time'});
            if(res.scheduled) scheduledPromises.push(res.promise);
          } else log('Intro: time narration too long for', musicObj.name);
        } else log('Intro: no TIME narration for current hour');
      }
    } else log('Intro skipped by chance for', musicObj.name);
  } else {
    log('Intro zone absent for', musicObj.name);
  }

  // --- FINAL ---
  if(musicObj.finalStart != null && musicObj.finalEnd != null){
    if(chance(0.7)){
      const r2 = Math.random();
      if(r2 < 0.7){
        // general
        const pool = narracoesGeneral;
        const zoneLen = musicObj.finalEnd - musicObj.finalStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){
          const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'general'});
          if(res.scheduled) scheduledPromises.push(res.promise);
        } else log('Final: no general candidate fits for', musicObj.name);
      } else {
        // ENDTO subgroup pick by weight: toad 3, tonews 2, towheather 1
        const pick = weightedPick([{k:'toad',w:3},{k:'tonews',w:2},{k:'towheather',w:1}]);
        const pool = endto[pick] || [];
        const zoneLen = musicObj.finalEnd - musicObj.finalStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){
          const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'endto','subgroup':pick});
          if(res.scheduled){ scheduledPromises.push(res.promise); endtoWasScheduled=true; endtoQueuedSubgroup=pick; }
        } else log('Final: no ENDTO candidate fits for', musicObj.name, 'subgroup', pick);
      }
    } else log('Final skipped by chance for', musicObj.name);
  } else {
    log('Final zone absent for', musicObj.name);
  }

  // wait music to finish
  await new Promise(resolve => musicSrc.onended = resolve);
  log('Music ended:', musicObj.name);

  // handle ENDTO followup only after scheduled narrations finish (if any were scheduled)
  if(endtoWasScheduled){
    try { if(scheduledPromises.length>0) await Promise.all(scheduledPromises); } catch(e){ console.warn('Error waiting scheduled narrs', e); }
    if(endtoQueuedSubgroup) await handleEndtoFollowupQueued(endtoQueuedSubgroup);
  } else {
    try { if(scheduledPromises.length>0) await Promise.all(scheduledPromises); } catch(e){ /* ignore */ }
  }

  // after music ended, show default cover for non-music items
  updateCover(DEFAULT_COVER);
  log('playMusicWithNarrations finished for', musicObj.name);
}

/* ================= INITIALIZATION & START LOGIC (with initial sequence preload) ================= */
async function init(){
  // load durations JSON and weather, and prepare queues
  await loadDuracoesJSON();
  await fetchWeather();
  resetMusicQueue();
  resetIDAdvQueues();
  // do not fully preload all now; we'll preload in background after initial sequence
  log('Init complete — ready for start');
}

// Start radio flow:
// 1) Ensure audio context resumed
// 2) Choose initial sequence and preload required files
// 3) Execute that sequence (respecting the sequence's components exactly)
// 4) Launch background preloadAll() and then mainSequenceRunner() loop (which continues choosing new sequences)
async function startRadio(){
  if(started) return;
  started = true;
  log('Starting radio (manual click)');
  if(audioCtx.state === 'suspended') await audioCtx.resume();

  // ensure duracoes loaded
  if(Object.keys(duracoesNarracoes).length === 0) await loadDuracoesJSON();
  // ensure weather freshness
  await fetchWeather();

  // Prepare id/adv queues if not present
  if(!musicQueue || musicQueue.length===0) resetMusicQueue();
  if(!idQueue || idQueue.length===0 || !advQueue || advQueue.length===0) resetIDAdvQueues();

  // 1) choose initial sequence and preload it
  const initialSeq = await chooseInitialSequenceAndPreload();

  // 2) Execute the chosen initial sequence *exactly* (so behavior is deterministic for first play)
  log('Executing initial sequence:', initialSeq);
  // We reuse runSequenceImmediately to execute chosen sequence (it handles adv/id/music etc)
  await runSequenceImmediately(initialSeq);

  // 3) Start background preload of everything else
  preloadAll().then(()=>log('background preload complete')).catch(e=>log('background preload error', e));

  // 4) Start main loop (continues selecting sequences normally)
  mainSequenceRunner().catch(e=>console.error('mainSequenceRunner error', e));
}

// attach start to btnStart
document.getElementById('btnStart')?.addEventListener('click', startRadio);

// run init on load
init().catch(e=>console.error('init error', e));

/* ================= EXPORTS FOR DEBUG (optional) ================= */
window.__RADIO = {
  startRadio,
  mainSequenceRunner,
  updateCover,
  musicasList,
  duracoesNarracoes,
  preloadAll,
  loadDuracoesJSON
};

log('renderer.js loaded — manual start via btnStart. Ducking target', DUCK_TARGET, 'fadeTime', DUCK_DOWN_TIME);
