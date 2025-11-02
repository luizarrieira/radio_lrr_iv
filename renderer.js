// renderer.js — Versão final integrando durações das narrações (duracoes_narracoes.json)
// - Ducking 50% (DUCK_TARGET = 0.5), fade 0.2s
// - Usa duracoes_narracoes.json para escolher narrações que caibam nas zonas seguras (sem limite de tentativas)
// - Capa default para tudo que não for música; capa da música permanece durante a música
// - DJSOLO substitui DJ/CALL, ADV agora AD001..AD083
// - ENDTO followup executado somente depois da música e da narração final terminarem
// - Manual start via botão id="btnStart", logs ativos
// - Assuma que duracoes_narracoes.json existe na raiz (gerado pelo script Node)

// -------------------- Config & Globals --------------------
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

const DUCK_TARGET = 0.5; // reduce music to 50%
const DUCK_DOWN_TIME = 0.1; // segundos — descida mais rápida
const DUCK_UP_TIME = 0.1;   // segundos — subida mais rápida
const DUCK_RELEASE_DELAY_MS = 250;

const DEFAULT_COVER = 'capas/default.jpg';
let currentCover = DEFAULT_COVER;

// Gains
const musicGain = audioCtx.createGain();
musicGain.gain.value = 1.0;
musicGain.connect(audioCtx.destination);

const narrationGain = audioCtx.createGain();
narrationGain.connect(audioCtx.destination);

// analyser optional
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 512;
analyser.smoothingTimeConstant = 0.85;
narrationGain.connect(analyser);

// Audio cache
const audioBufferCache = new Map();
let duracoesNarracoes = {}; // loaded from duracoes_narracoes.json

// State
let musicQueue = [];
let idQueue = [];
let advQueue = [];
let started = false;
let activeNarrationsCount = 0;
let duckReleaseTimeout = null;

// -------------------- Utilities --------------------
function pad(n, len = 2) { return String(n).padStart(len, '0'); }
function rand(arr) { if(!arr || arr.length===0) return null; return arr[Math.floor(Math.random()*arr.length)]; }
function chance(p) { return Math.random() < p; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// Weighted pick for sequences / endto
function weightedPick(items) {
  const total = items.reduce((s,i)=>s+i.w,0);
  let r = Math.random()*total;
  for (const it of items) { if (r < it.w) return it.k; r -= it.w; }
  return items[0].k;
}

// Logging helper
function log(...args){ console.log('[RADIO]', ...args); }

// -------------------- Groups & Files --------------------
// IDs -> narracoes/ID_01..ID_12.wav
const grupoID = Array.from({length:12}, (_,i) => `narracoes/ID_${pad(i+1,2)}.wav`);

// DJSOLO -> narracoes/SOLO_01..SOLO_13.wav
const grupoDJSolo = Array.from({length:13}, (_,i) => `narracoes/SOLO_${pad(i+1,2)}.wav`);

// ADV -> adv/AD001..AD083.wav (updated)
const grupoAdv = Array.from({length:83}, (_,i) => `adv/AD${pad(i+1,3)}.wav`);

// Weazel news -> news/NEWS_01..NEWS_70.wav
const grupoWeazelNews = Array.from({length:70}, (_,i) => `news/NEWS_${pad(i+1,2)}.wav`);

// General narrations -> narracoes/GENERAL_01..GENERAL_25.wav
const narracoesGeneral = Array.from({length:25}, (_,i) => `narracoes/GENERAL_${pad(i+1,2)}.wav`);

// ENDTO subgroups: toad, tonews, towheather
const endto = {
  toad: Array.from({length:5}, (_,i) => `narracoes/TO_AD_${pad(i+1,2)}.wav`),
  tonews: Array.from({length:5}, (_,i) => `narracoes/TO_NEWS_${pad(i+1,2)}.wav`),
  towheather: Array.from({length:5}, (_,i) => `narracoes/TO_WEATHER_${pad(i+1,2)}.wav`)
};

// Music-specific intro narrations (all files in narracoes/)
const musicIntroNarrations = {
  'FASCINATION': ['narracoes/FASCINATION_01.wav', 'narracoes/FASCINATION_02.wav'],
  'REMEDY': ['narracoes/REMEDY_01.wav', 'narracoes/REMEDY_02.wav'],
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

// Music list (with zones)
const musicasList = [
  {id:'fascination', name:'FASCINATION', arquivo:'musicas/FASCINATION.wav', introStart:5581, introEnd:27563, finalStart:188733, finalEnd:216000, capa:'capas/fascination.jpg'},
  {id:'remedy', name:'REMEDY', arquivo:'musicas/REMEDY.wav', introStart:6020, introEnd:36138, finalStart:195886, finalEnd:222205, capa:'capas/remedy.jpg'},
  {id:'cocaine', name:'COCAINE', arquivo:'musicas/COCAINE.wav', finalStart:171349, finalEnd:201728, capa:'capas/cocaine.jpg'},
  {id:'1979', name:'1979', arquivo:'musicas/1979.wav', introStart:1895, introEnd:11613, finalStart:226907, finalEnd:244963, capa:'capas/1979.jpg'},
  {id:'cry', name:'CRY', arquivo:'musicas/CRY.wav', introStart:3413, introEnd:15736, finalStart:195000, finalEnd:218269, capa:'capas/cry.jpg'},
  {id:'dominion', name:'DOMINION', arquivo:'musicas/DOMINION.wav', capa:'capas/dominion.jpg'}, // no zones
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

// -------------------- Queues helpers --------------------
function shuffle(arr){
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function resetMusicQueue(){ musicQueue = shuffle(musicasList.slice()); }
function resetIDAdvQueues(){ idQueue = shuffle(grupoID.slice()); advQueue = shuffle(grupoAdv.slice()); }
async function nextMusic(){ if(!musicQueue || musicQueue.length===0) resetMusicQueue(); return musicQueue.shift(); }
async function nextID(){ if(!idQueue || idQueue.length===0) resetIDAdvQueues(); return idQueue.shift(); }
async function nextAdv(){ if(!advQueue || advQueue.length===0) resetIDAdvQueues(); return advQueue.shift(); }

// -------------------- Preload duracoes JSON --------------------
async function loadDuracoesJSON(){
  try {
    const resp = await fetch('duracoes_narracoes.json');
    if(!resp.ok) throw new Error('duracoes json fetch failed ' + resp.status);
    duracoesNarracoes = await resp.json();
    log('Loaded duracoes_narracoes.json with', Object.keys(duracoesNarracoes).length, 'entries');
  } catch (e) {
    console.warn('Failed to load duracoes_narracoes.json:', e);
    duracoesNarracoes = {};
  }
}

// -------------------- Audio buffer caching --------------------
async function getAudioBuffer(path){
  if(audioBufferCache.has(path)) return audioBufferCache.get(path);
  try{
    const resp = await fetch(path);
    if(!resp.ok) throw new Error('fetch ' + resp.status + ' ' + path);
    const ab = await resp.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(ab);
    audioBufferCache.set(path, buf);
    return buf;
  }catch(e){
    console.warn('getAudioBuffer error', path, e);
    throw e;
  }
}
async function playBufferToDestination(buf){ return new Promise(r=>{ const s=audioCtx.createBufferSource(); s.buffer=buf; s.connect(audioCtx.destination); s.onended=()=>r(); s.start(); }); }
async function playBufferToNarrationGain(buf){ return new Promise(r=>{ const s=audioCtx.createBufferSource(); s.buffer=buf; s.connect(narrationGain); s.onended=()=>r(); s.start(); }); }

// -------------------- Ducking control --------------------
function onNarrationStart(){
  activeNarrationsCount++;
  if(duckReleaseTimeout){ clearTimeout(duckReleaseTimeout); duckReleaseTimeout=null; }
  const now = audioCtx.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(musicGain.gain.value, now);
  musicGain.gain.linearRampToValueAtTime(DUCK_TARGET, now + DUCK_DOWN_TIME);
  log('Narration start -> ducking to', DUCK_TARGET);
}
function onNarrationEnd(){
  activeNarrationsCount = Math.max(0, activeNarrationsCount-1);
  if(activeNarrationsCount === 0){
    duckReleaseTimeout = setTimeout(()=>{
      const now = audioCtx.currentTime;
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setValueAtTime(musicGain.gain.value, now);
      musicGain.gain.linearRampToValueAtTime(1.0, now + DUCK_UP_TIME);
      duckReleaseTimeout = null;
      log('Narration end -> release duck back to 1.0');
    }, DUCK_RELEASE_DELAY_MS);
  }
}

// -------------------- Cover handling --------------------
function updateCover(newCover = DEFAULT_COVER, force=false){
  const el = document.getElementById('capa') || document.getElementById('cover') || null;
  if(!el) return;
  const target = newCover || DEFAULT_COVER;
  if(force || target !== currentCover){
    el.src = target;
    currentCover = target;
    log('Cover set ->', target.includes('default') ? 'default' : target);
  }
}

// -------------------- Weather & TIME helpers --------------------
let currentWeatherMain = 'Clear';
async function fetchWeather(){
  try {
    const key = '0cad953b1e9b3793a944d644d5193d3a';
    const resp = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Maringa,BR&appid=${key}`);
    const j = await resp.json();
    currentWeatherMain = j && j.weather && j.weather[0] && j.weather[0].main ? j.weather[0].main : 'Clear';
    log('Weather:', currentWeatherMain);
  }catch(e){ console.warn('fetchWeather failed', e); currentWeatherMain='Clear'; }
}
function pickWeatherFile(condition) {
  if(!condition) return null;
  const c = String(condition).toLowerCase();
  const h = new Date().getHours();

  if(c.includes('cloud')) {
    const n=Math.floor(Math.random()*11)+1;
    return `weather/CLOUD_${pad(n,2)}.wav`;
  }
  if(c.includes('fog')||c.includes('mist')) {
    const n=Math.floor(Math.random()*12)+1;
    return `weather/FOG_${pad(n,2)}.wav`;
  }
  if(c.includes('rain')) {
    const n=Math.floor(Math.random()*11)+1;
    return `weather/RAIN_${pad(n,2)}.wav`;
  }
  if((c.includes('clear') || c.includes('sun')) && h >= 5 && h <= 18) {
    const n=Math.floor(Math.random()*12)+1;
    return `weather/SUN_${pad(n,2)}.wav`;
  }
  if(c.includes('wind')||c.includes('breeze')) {
    const n=Math.floor(Math.random()*11)+1;
    return `weather/WIND_${pad(n,2)}.wav`;
  }
  return null;
}
function pickTimeNarration() {
  const h = new Date().getHours();
  if(h>=4 && h<=10){ const n=Math.floor(Math.random()*5)+1; return `narracoes/MORNING_${pad(n,2)}.wav`; }
  if(h>=13 && h<=16){ const n=Math.floor(Math.random()*5)+1; return `narracoes/AFTERNOON_${pad(n,2)}.wav`; }
  if(h>=18 && h<=19){ const n=Math.floor(Math.random()*6)+1; return `narracoes/EVENING_${pad(n,2)}.wav`; }
  if(h>=21 || h<=1){ const n=Math.floor(Math.random()*5)+1; return `narracoes/NIGHT_${pad(n,2)}.wav`; }
  return null;
}

// -------------------- Narration selection using duracoes_narracoes.json --------------------
/**
 * Given a pool of candidate file paths, returns an array filtered to those whose duration (from JSON)
 * is <= zone length. File names in duracoesNarracoes JSON must match exactly (e.g. GENERAL_01.wav).
 */
function filterCandidatesByZone(candidates, zoneLenMs){
  if(!candidates || candidates.length===0) return [];
  const filtered = [];
  for(const p of candidates){
    // extract file name portion e.g. narracoes/GENERAL_01.wav -> GENERAL_01.wav
    const parts = p.split('/'); const fname = parts[parts.length-1];
    const d = duracoesNarracoes[fname];
    if(typeof d === 'number' && d <= zoneLenMs) filtered.push({path:p,dur:d});
  }
  return filtered;
}

/**
 * Choose a random candidate from pool that fits zone. If none fit, returns null.
 * This implements "unlimited attempts" by selecting randomly from the filtered set.
 */
function chooseRandomCandidateThatFits(poolPaths, zoneLenMs){
  const filtered = filterCandidatesByZone(poolPaths, zoneLenMs);
  if(filtered.length===0) return null;
  const choice = filtered[Math.floor(Math.random()*filtered.length)];
  return choice; // {path, dur}
}

// -------------------- Schedule narration to end exactly at zoneEndMs --------------------
/**
 * Schedules narration so it ends at zoneEndMs (ms relative to music start).
 * Returns an object {scheduled:bool, promise:Promise|null, meta:{...}}.
 */
async function scheduleNarrationToEndAt(musicStartAudioTime, zoneStartMs, zoneEndMs, candidatePath, candidateDurMs, meta={}){
  if(!candidatePath) return {scheduled:false};
  const durMs = candidateDurMs;
  // compute start offset in seconds relative to music start:
  let startOffsetSec = (zoneEndMs - durMs) / 1000;
  if(startOffsetSec < zoneStartMs/1000) startOffsetSec = zoneStartMs/1000;
  const startAudioTime = musicStartAudioTime + startOffsetSec;

  // create source but do not start until startAudioTime
  try {
    const buf = await getAudioBuffer(candidatePath);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(narrationGain);

    // plan duck lead: slightly before start
    const now = audioCtx.currentTime;
    const leadMs = 40;
    const duckDelayMs = Math.max(0, (startAudioTime - now)*1000 - leadMs);
    if(duckDelayMs > 0) {
      setTimeout(()=>{ onNarrationStart(); }, duckDelayMs);
    } else {
      // if start immediate or in past, start duck now
      requestAnimationFrame(()=>onNarrationStart());
    }

    // start playback
    try { src.start(startAudioTime); } catch(e){ src.start(); }

    const p = new Promise((resolve)=>{
      src.onended = ()=>{
        onNarrationEnd();
        resolve({path:candidatePath, meta});
      };
    });
    log('Scheduled narration', candidatePath, 'to start at', startAudioTime.toFixed(3), 'audioTime');
    return {scheduled:true, promise:p, chosen:candidatePath, dur:durMs, meta};
  } catch(e){
    console.warn('Failed to schedule narration', candidatePath, e);
    return {scheduled:false};
  }
}

// -------------------- Play immediate narration (news/weather) --------------------
async function playNarrationImmediate(path){
  updateCover(DEFAULT_COVER);
  try {
    const buf = await getAudioBuffer(path);
    log('Playing immediate narration', path);
    onNarrationStart();
    await playBufferToNarrationGain(buf);
    onNarrationEnd();
  } catch (e) {
    console.warn('playNarrationImmediate failed', path, e);
  }
}

// -------------------- ENDTO followups (run AFTER music and final narration) --------------------
async function handleEndtoFollowupQueued(subgroup){
  if(!subgroup) return;
  updateCover(DEFAULT_COVER);
  log('ENDTO followup will run for subgroup', subgroup);
  if(subgroup === 'toad'){
    // toad -> adv+musica OR adv+id+musica (50/50)
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

// run immediate sequence (used by ENDTO followups)
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

// -------------------- Sequence pool weights --------------------
const sequencePool = [
  {k:'id+musica', w:3},
  {k:'djsolo+musica', w:3},
  {k:'musica', w:3},
  {k:'adv+musica', w:1},
  {k:'adv+id+musica', w:1},
  {k:'id+djsolo+musica', w:1}
];

function pickSequenceWeighted(){ return weightedPick(sequencePool); }

// -------------------- Main sequence runner (sequential) --------------------
async function mainSequenceRunner(){
  try{
    const seq = pickSequenceWeighted();
    log('Chosen sequence:', seq);
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
        console.warn('Unknown sequence chosen', seq);
    }
  } catch(e){
    console.error('mainSequenceRunner error', e);
  } finally {
    // call next sequence only after the above flow completed (sequential)
    await sleep(50);
    mainSequenceRunner().catch(err => console.error('mainSequenceRunner recursion error', err));
  }
}

// -------------------- Play music & schedule narrations --------------------
/*
 * Schedules intro and final narrations (70% chance each) using durations from JSON.
 * If ENDTO final narration chosen, the follow-up will be queued and executed only after the music ends
 * and the scheduled narration finish (we await scheduledPromises).
 */
async function playMusicWithNarrations(musicObj){
  log('Now playing track:', musicObj.name, musicObj.arquivo);
  // set cover to music cover
  updateCover(musicObj.capa || DEFAULT_COVER, true);

  // load music
  const musicBuf = await getAudioBuffer(musicObj.arquivo);
  const musicSrc = audioCtx.createBufferSource();
  musicSrc.buffer = musicBuf;
  musicSrc.connect(musicGain);
  const musicStartAudioTime = audioCtx.currentTime;
  musicSrc.start(musicStartAudioTime);
  log('Music started at audioTime', musicStartAudioTime.toFixed(3));

  const scheduledPromises = [];
  let endtoWasScheduled=false;
  let endtoQueuedSubgroup=null;

  // --- INTRO ---
  if(musicObj.introStart != null && musicObj.introEnd != null){
    if(chance(0.7)){
      const r = Math.random();
      if(r < 0.4){
        // general pool
        log('Intro: selecting from GENERAL pool for', musicObj.name);
        const pool = narracoesGeneral;
        const zoneLen = musicObj.introEnd - musicObj.introStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){
          const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'general'});
          if(res.scheduled) scheduledPromises.push(res.promise);
        } else log('Intro: no general candidate fits for', musicObj.name);
      } else if(r < 0.8){
        // music-specific pool
        const pool = musicIntroNarrations[musicObj.name] || [];
        if(pool.length>0){
          log('Intro: selecting from MUSIC-SPECIFIC pool for', musicObj.name);
          const zoneLen = musicObj.introEnd - musicObj.introStart;
          const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
          if(chosen){
            const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'music-specific'});
            if(res.scheduled) scheduledPromises.push(res.promise);
          } else log('Intro: no music-specific candidate fits for', musicObj.name);
        } else log('Intro: no music-specific pool for', musicObj.name);
      } else {
        // time pool
        const timePath = pickTimeNarration();
        if(timePath){
          log('Intro: selecting TIME narration', timePath, 'for', musicObj.name);
          const zoneLen = musicObj.introEnd - musicObj.introStart;
          const chosen = chooseRandomCandidateThatFits([timePath], zoneLen);
          if(chosen){
            const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'time'});
            if(res.scheduled) scheduledPromises.push(res.promise);
          } else log('Intro: time narration too long for zone of', musicObj.name);
        } else log('Intro: no TIME narration for current hour');
      }
    } else {
      log('Intro: skipped by chance for', musicObj.name);
    }
  } else {
    log('Intro zone absent for', musicObj.name);
  }

  // --- FINAL ---
  if(musicObj.finalStart != null && musicObj.finalEnd != null){
    if(chance(0.7)){
      const r2 = Math.random();
      if(r2 < 0.7){
        // general pool for final
        log('Final: selecting from GENERAL pool for', musicObj.name);
        const pool = narracoesGeneral;
        const zoneLen = musicObj.finalEnd - musicObj.finalStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){
          const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'general'});
          if(res.scheduled) scheduledPromises.push(res.promise);
        } else log('Final: no general candidate fits for', musicObj.name);
      } else {
        // choose endto subgroup by weight: toad 3, tonews 2, towheather 1
        const pick = weightedPick([{k:'toad',w:3},{k:'tonews',w:2},{k:'towheather',w:1}]);
        log('Final: selecting ENDTO subgroup', pick, 'for', musicObj.name);
        const pool = endto[pick] || [];
        const zoneLen = musicObj.finalEnd - musicObj.finalStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){
          const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'endto','subgroup':pick});
          if(res.scheduled){ scheduledPromises.push(res.promise); endtoWasScheduled=true; endtoQueuedSubgroup=pick; }
        } else log('Final: no ENDTO candidate fit for', musicObj.name, 'subgroup', pick);
      }
    } else {
      log('Final: skipped by chance for', musicObj.name);
    }
  } else {
    log('Final zone absent for', musicObj.name);
  }

  // wait until music ends
  await new Promise(resolve => musicSrc.onended = resolve);
  log('Music ended:', musicObj.name);

  // If ENDTO was scheduled, wait for scheduled narrations to finish then run followup
  if(endtoWasScheduled){
    try {
      if(scheduledPromises.length>0) await Promise.all(scheduledPromises);
    } catch(e){ console.warn('Error awaiting scheduled narrations', e); }
    if(endtoQueuedSubgroup) await handleEndtoFollowupQueued(endtoQueuedSubgroup);
  } else {
    // otherwise ensure scheduled narrations finished
    try { if(scheduledPromises.length>0) await Promise.all(scheduledPromises); } catch(e){ /* ignore */ }
  }

  // after music ends, set cover back to default (next non-music will show default)
  updateCover(DEFAULT_COVER);
  log('playMusicWithNarrations finished for', musicObj.name);
}

// -------------------- Preload all (best-effort) --------------------
async function preloadAll(){
  const toPreload = new Set();
  // music files
  musicasList.forEach(m => toPreload.add(m.arquivo));
  // narrations general & music-specific & endto
  narracoesGeneral.forEach(p => toPreload.add(p));
  Object.values(musicIntroNarrations).flat().forEach(p => toPreload.add(p));
  Object.values(endto).flat().forEach(p => toPreload.add(p));
  // ids, djsolo, adv, news
  grupoID.forEach(p => toPreload.add(p));
  grupoDJSolo.forEach(p => toPreload.add(p));
  grupoAdv.forEach(p => toPreload.add(p));
  grupoWeazelNews.forEach(p => toPreload.add(p));
  // time groups
  for(let i=1;i<=5;i++) toPreload.add(`narracoes/MORNING_${pad(i,2)}.wav`);
  for(let i=1;i<=5;i++) toPreload.add(`narracoes/AFTERNOON_${pad(i,2)}.wav`);
  for(let i=1;i<=6;i++) toPreload.add(`narracoes/EVENING_${pad(i,2)}.wav`);
  for(let i=1;i<=5;i++) toPreload.add(`narracoes/NIGHT_${pad(i,2)}.wav`);
  // weather
  for(let i=1;i<=11;i++) toPreload.add(`weather/CLOUD_${pad(i,2)}.wav`);
  for(let i=1;i<=12;i++) toPreload.add(`weather/FOG_${pad(i,2)}.wav`);
  for(let i=1;i<=11;i++) toPreload.add(`weather/RAIN_${pad(i,2)}.wav`);
  for(let i=1;i<=12;i++) toPreload.add(`weather/SUN_${pad(i,2)}.wav`);
  for(let i=1;i<=11;i++) toPreload.add(`weather/WIND_${pad(i,2)}.wav`);

  const arr = Array.from(toPreload);
  log('Preloading', arr.length, 'audio files (best-effort)');
  await Promise.all(arr.map(async p => { try{ await getAudioBuffer(p);}catch(e){} }));
  log('Preload done');
}

// -------------------- Initialization & start --------------------
async function init(){
  await loadDuracoesJSON();
  await fetchWeather();
  resetMusicQueue();
  resetIDAdvQueues();
  preloadAll().catch(e=>log('preloadAll failed', e));
  log('Renderer initialized — waiting manual start (btnStart)');
}

// Manual start wired to button
async function startRadio(){
  if(started) return;
  started = true;
  log('Starting radio (manual click)');
  if(audioCtx.state === 'suspended') await audioCtx.resume();
  // ensure duracoes loaded
  if(Object.keys(duracoesNarracoes).length === 0) await loadDuracoesJSON();
  // ensure weather
  await fetchWeather();
  // start loop
  mainSequenceRunner().catch(e=>console.error('mainSequenceRunner init error', e));
}

// attach to button
document.getElementById('btnStart')?.addEventListener('click', startRadio);

// run init on load
init().catch(e=>console.error('init error', e));

// expose some helpers for debugging in console
window.__RADIO = {
  startRadio,
  mainSequenceRunner,
  updateCover,
  musicasList,
  duracoesNarracoes
};

log('renderer.js loaded — ready. Use btnStart to play.');
