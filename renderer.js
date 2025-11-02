// renderer.js — Versão final completa
// - Ducking 50% (0.5), DUCK fade 0.1s
// - Preload inicial da sequência escolhida + preload global em paralelo
// - Usa duracoes_narracoes.json para encaixe das narrações
// - ENDTO followups aguardam fim de música + narração
// - Manual start via element id="btnStart"
// - Logs no console

/* =================== Configurações =================== */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

const DUCK_TARGET = 0.5;        // reduce music to 50%
const DUCK_DOWN_TIME = 0.1;    // seconds
const DUCK_UP_TIME = 0.1;
const DUCK_RELEASE_DELAY_MS = 200;

const DEFAULT_COVER = 'capas/default.jpg';
let currentCover = DEFAULT_COVER;

/* =================== Gains / Analyser =================== */
const musicGain = audioCtx.createGain(); musicGain.gain.value = 1.0; musicGain.connect(audioCtx.destination);
const narrationGain = audioCtx.createGain(); narrationGain.connect(audioCtx.destination);
const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.85;
narrationGain.connect(analyser);

/* =================== State & Caches =================== */
const audioBufferCache = new Map();
let duracoesNarracoes = {}; // loaded from duracoes_narracoes.json
let musicQueue = [];
let idQueue = [];
let advQueue = [];
let started = false;
let activeNarrationsCount = 0;
let duckReleaseTimeout = null;

/* =================== Utils =================== */
function pad(n, len=2){ return String(n).padStart(len, '0'); }
function rand(arr){ return arr && arr.length ? arr[Math.floor(Math.random()*arr.length)] : null; }
function chance(p){ return Math.random() < p; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function log(...args){ console.log('[RADIO]', ...args); }

/* Weighted pick helper */
function weightedPick(items){
  const total = items.reduce((s,i)=>s+i.w,0);
  let r = Math.random()*total;
  for(const it of items){ if(r < it.w) return it.k; r -= it.w; }
  return items[0].k;
}

/* =================== File groups =================== */
/* ID 01..12 in narracoes/ */
const grupoID = Array.from({length:12},(_,i)=>`narracoes/ID_${pad(i+1,2)}.wav`);
/* DJSOLO (SOLO_01..SOLO_13) in narracoes/ */
const grupoDJSolo = Array.from({length:13},(_,i)=>`narracoes/SOLO_${pad(i+1,2)}.wav`);
/* ADV AD001..AD083 in adv/ */
const grupoAdv = Array.from({length:83},(_,i)=>`adv/AD${pad(i+1,3)}.wav`);
/* Weazel news NEWS_01..NEWS_70 in news/ */
const grupoWeazelNews = Array.from({length:70},(_,i)=>`news/NEWS_${pad(i+1,2)}.wav`);
/* General narrations GENERAL_01..GENERAL_25 in narracoes/ */
const narracoesGeneral = Array.from({length:25},(_,i)=>`narracoes/GENERAL_${pad(i+1,2)}.wav`);

/* Time narrations (present in narracoes/) */
const timePools = {
  morning: Array.from({length:5},(_,i)=>`narracoes/MORNING_${pad(i+1,2)}.wav`),
  afternoon: Array.from({length:5},(_,i)=>`narracoes/AFTERNOON_${pad(i+1,2)}.wav`),
  evening: Array.from({length:6},(_,i)=>`narracoes/EVENING_${pad(i+1,2)}.wav`),
  night: Array.from({length:5},(_,i)=>`narracoes/NIGHT_${pad(i+1,2)}.wav`)
};

/* ENDTO groups (toad, tonews, towheather) in narracoes/ */
const endto = {
  toad: Array.from({length:5},(_,i)=>`narracoes/TO_AD_${pad(i+1,2)}.wav`),
  tonews: Array.from({length:5},(_,i)=>`narracoes/TO_NEWS_${pad(i+1,2)}.wav`),
  towheather: Array.from({length:5},(_,i)=>`narracoes/TO_WEATHER_${pad(i+1,2)}.wav`)
};

/* Music-specific intro narrations mapping (files in narracoes/) */
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

/* Music list with zones (introStart,introEnd,finalStart,finalEnd in ms)
   Keep name uppercase for matching with musicIntroNarrations keys */
const musicasList = [
  { id:'fascination', name:'FASCINATION', arquivo:'musicas/FASCINATION.wav', introStart:5581, introEnd:27563, finalStart:188733, finalEnd:216000, capa:'capas/fascination.jpg' },
  { id:'remedy', name:'REMEDY', arquivo:'musicas/REMEDY.wav', introStart:6020, introEnd:36138, finalStart:195886, finalEnd:222205, capa:'capas/remedy.jpg' },
  { id:'cocaine', name:'COCAINE', arquivo:'musicas/COCAINE.wav', finalStart:171349, finalEnd:201728, capa:'capas/cocaine.jpg' },
  { id:'1979', name:'1979', arquivo:'musicas/1979.wav', introStart:1895, introEnd:11613, finalStart:226907, finalEnd:244963, capa:'capas/1979.jpg' },
  { id:'cry', name:'CRY', arquivo:'musicas/CRY.wav', introStart:3413, introEnd:15736, finalStart:195000, finalEnd:218269, capa:'capas/cry.jpg' },
  { id:'dominion', name:'DOMINION', arquivo:'musicas/DOMINION.wav', capa:'capas/dominion.jpg' },
  { id:'edgeofseventeen', name:'EDGEOFSEVENTEEN', arquivo:'musicas/EDGEOFSEVENTEEN.wav', finalStart:242440, finalEnd:269738, capa:'capas/edgeofseventeen.jpg' },
  { id:'evilwoman', name:'EVILWOMAN', arquivo:'musicas/EVILWOMAN.wav', introStart:6570, introEnd:29958, finalStart:195393, finalEnd:225301, capa:'capas/evilwoman.jpg' },
  { id:'goodbyehorses', name:'GOODBYEHORSES', arquivo:'musicas/GOODBYEHORSES.wav', introStart:6826, introEnd:28508, finalStart:137199, finalEnd:165000, capa:'capas/goodbyehorses.jpg' },
  { id:'heavenandhell', name:'HEAVENANDHELL', arquivo:'musicas/HEAVENANDHELL.wav', introStart:2986, introEnd:22250, finalStart:280405, finalEnd:302770, capa:'capas/heavenandhell.jpg' },
  { id:'herstrut', name:'HERSTRUT', arquivo:'musicas/HERSTRUT.wav', introStart:4199, introEnd:24966, finalStart:157991, finalEnd:190000, capa:'capas/herstrut.jpg' },
  { id:'iwannabeyourdog', name:'IWANNABEYOURDOG', arquivo:'musicas/IWANNABEYOURDOG.wav', introStart:2380, introEnd:23786, finalStart:151573, finalEnd:174866, capa:'capas/iwannabeyourdog.jpg' },
  { id:'jailbreak', name:'JAILBREAK', arquivo:'musicas/JAILBREAK.wav', introStart:2197, introEnd:18983, finalStart:206452, finalEnd:235163, capa:'capas/jailbreak.jpg' },
  { id:'mama', name:'MAMA', arquivo:'musicas/MAMA.wav', introStart:4889, introEnd:29179, finalStart:260364, finalEnd:291065, capa:'capas/mama.jpg' },
  { id:'newyorkgroove', name:'NEWYORKGROOVE', arquivo:'musicas/NEWYORKGROOVE.wav', finalStart:127005, finalEnd:152020, capa:'capas/newyorkgroove.jpg' },
  { id:'onevision', name:'ONEVISION', arquivo:'musicas/ONEVISION.wav', introStart:9642, introEnd:30922, finalStart:215893, finalEnd:227306, capa:'capas/onevision.jpg' },
  { id:'rockymountainway', name:'ROCKYMOUNTAINWAY', arquivo:'musicas/ROCKYMOUNTAINWAY.wav', introStart:21606, introEnd:47224, finalStart:234922, finalEnd:260224, capa:'capas/rockymountainway.jpg' },
  { id:'straighton', name:'STRAIGHTON', arquivo:'musicas/STRAIGHTON.wav', introStart:2052, introEnd:17002, finalStart:157013, finalEnd:185290, capa:'capas/straighton.jpg' },
  { id:'streetkids', name:'STREETKIDS', arquivo:'musicas/STREETKIDS.wav', introStart:4853, introEnd:23040, finalStart:219858, finalEnd:247773, capa:'capas/streetkids.jpg' },
  { id:'theseeker', name:'THESEEKER', arquivo:'musicas/THESEEKER.wav', introStart:3504, introEnd:17007, finalStart:144031, finalEnd:184829, capa:'capas/theseeker.jpg' },
  { id:'thug', name:'THUG', arquivo:'musicas/THUG.wav', introStart:1858, introEnd:16282, finalStart:173141, finalEnd:197448, capa:'capas/thug.jpg' },
  { id:'turnyouinsideout', name:'TURNYOUINSIDEOUT', arquivo:'musicas/TURNYOUINSIDEOUT.wav', introStart:3923, introEnd:21663, finalStart:167936, finalEnd:190086, capa:'capas/turnyouinsideout.jpg' }
];

/* =================== Queue helpers =================== */
function shuffle(arr){ const a = arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function resetMusicQueue(){ musicQueue = shuffle(musicasList.slice()); }
function resetIDAdvQueues(){ idQueue = shuffle(grupoID.slice()); advQueue = shuffle(grupoAdv.slice()); }
async function nextMusic(){ if(!musicQueue || musicQueue.length===0) resetMusicQueue(); return musicQueue.shift(); }
async function nextID(){ if(!idQueue || idQueue.length===0) resetIDAdvQueues(); return idQueue.shift(); }
async function nextAdv(){ if(!advQueue || advQueue.length===0) resetIDAdvQueues(); return advQueue.shift(); }

/* =================== Durations JSON loader =================== */
async function loadDuracoesJSON(){
  try{
    const resp = await fetch('duracoes_narracoes.json');
    if(!resp.ok) throw new Error('duracoes json fetch failed ' + resp.status);
    duracoesNarracoes = await resp.json();
    log('Loaded duracoes_narracoes.json', Object.keys(duracoesNarracoes).length, 'entries');
  }catch(e){
    console.warn('Failed to load duracoes_narracoes.json', e);
    duracoesNarracoes = {};
  }
}

/* =================== Audio buffer caching =================== */
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

/* Helper play to destination */
async function playBufferToDestination(buf){
  return new Promise(r=>{
    const s = audioCtx.createBufferSource(); s.buffer = buf; s.connect(audioCtx.destination);
    s.onended = ()=>r(); s.start();
  });
}
async function playBufferToNarrationGain(buf){
  return new Promise(r=>{
    const s = audioCtx.createBufferSource(); s.buffer = buf; s.connect(narrationGain);
    s.onended = ()=>r(); s.start();
  });
}

/* =================== Ducking control =================== */
function onNarrationStart(){
  activeNarrationsCount++;
  if(duckReleaseTimeout){ clearTimeout(duckReleaseTimeout); duckReleaseTimeout=null; }
  const now = audioCtx.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(musicGain.gain.value, now);
  musicGain.gain.linearRampToValueAtTime(DUCK_TARGET, now + DUCK_DOWN_TIME);
  log('Narration start -> duck to', DUCK_TARGET);
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
      log('Narration end -> release duck to 1.0');
    }, DUCK_RELEASE_DELAY_MS);
  }
}

/* =================== Cover handling =================== */
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

/* =================== Weather & TIME =================== */
let currentWeatherMain = 'Clear';
async function fetchWeather(){
  try{
    const key = '0cad953b1e9b3793a944d644d5193d3a';
    const resp = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Maringa,BR&appid=${key}`);
    const j = await resp.json();
    currentWeatherMain = j && j.weather && j.weather[0] && j.weather[0].main ? j.weather[0].main : 'Clear';
    log('Weather fetched:', currentWeatherMain);
  }catch(e){
    console.warn('fetchWeather failed', e);
    currentWeatherMain = 'Clear';
  }
}

/* pick weather file, with SUN allowed only when clear AND between 05:00-18:00 */
function pickWeatherFile(condition){
  if(!condition) return null;
  const c = String(condition).toLowerCase();
  const h = new Date().getHours();
  if(c.includes('cloud')) { const n=Math.floor(Math.random()*11)+1; return `weather/CLOUD_${pad(n,2)}.wav`; }
  if(c.includes('fog')||c.includes('mist')) { const n=Math.floor(Math.random()*12)+1; return `weather/FOG_${pad(n,2)}.wav`; }
  if(c.includes('rain')) { const n=Math.floor(Math.random()*11)+1; return `weather/RAIN_${pad(n,2)}.wav`; }
  if((c.includes('clear') || c.includes('sun')) && h >= 5 && h <= 18) { const n=Math.floor(Math.random()*12)+1; return `weather/SUN_${pad(n,2)}.wav`; }
  if(c.includes('wind')||c.includes('breeze')) { const n=Math.floor(Math.random()*11)+1; return `weather/WIND_${pad(n,2)}.wav`; }
  return null;
}

/* pick time narration */
function pickTimeNarration(){
  const h = new Date().getHours();
  if(h>=4 && h<=10){ const n=Math.floor(Math.random()*5)+1; return `narracoes/MORNING_${pad(n,2)}.wav`; }
  if(h>=13 && h<=16){ const n=Math.floor(Math.random()*5)+1; return `narracoes/AFTERNOON_${pad(n,2)}.wav`; }
  if(h>=18 && h<=19){ const n=Math.floor(Math.random()*6)+1; return `narracoes/EVENING_${pad(n,2)}.wav`; }
  if(h>=21 || h<=1){ const n=Math.floor(Math.random()*5)+1; return `narracoes/NIGHT_${pad(n,2)}.wav`; }
  return null;
}

/* =================== Candidate filtering by zone using duracoesNarracoes =================== */
function filterCandidatesByZone(candidates, zoneLenMs){
  if(!candidates || candidates.length===0) return [];
  const out = [];
  for(const p of candidates){
    const parts = p.split('/'); const fname = parts[parts.length-1];
    const d = duracoesNarracoes[fname];
    if(typeof d === 'number' && d <= zoneLenMs) out.push({path:p,dur:d});
  }
  return out;
}
function chooseRandomCandidateThatFits(poolPaths, zoneLenMs){
  const filtered = filterCandidatesByZone(poolPaths, zoneLenMs);
  if(filtered.length===0) return null;
  return filtered[Math.floor(Math.random()*filtered.length)];
}

/* =================== Schedule narration to end exactly at zoneEndMs =================== */
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

    try { src.start(startAudioTime); } catch(e){ src.start(); }

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

/* =================== Play immediate narration (news/weather/adv/id) =================== */
async function playNarrationImmediate(path){
  updateCover(DEFAULT_COVER);
  try{
    const buf = await getAudioBuffer(path);
    onNarrationStart();
    await playBufferToNarrationGain(buf);
    onNarrationEnd();
  }catch(e){
    console.warn('playNarrationImmediate failed', path, e);
  }
}

/* =================== ENDTO followup (after music & final narrator done) =================== */
async function handleEndtoFollowupQueued(subgroup){
  if(!subgroup) return;
  updateCover(DEFAULT_COVER);
  log('ENDTO followup for', subgroup);
  if(subgroup === 'toad'){
    // toad -> adv+musica or adv+id+musica (choose among two with equal chance)
    const pick = Math.random() < 0.5 ? 'adv+musica' : 'adv+id+musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'tonews'){
    // play news then pick id+musica or musica
    const news = rand(grupoWeazelNews);
    await playNarrationImmediate(news);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'towheather'){
    const weatherFile = pickWeatherFile(currentWeatherMain);
    if(weatherFile) await playNarrationImmediate(weatherFile);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  }
}

/* =================== runSequenceImmediately (used by ENDTO) =================== */
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

/* =================== Sequence pool & main loop =================== */
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
    await sleep(50);
    mainSequenceRunner().catch(err => console.error('mainSequenceRunner recursion error', err));
  }
}

/* =================== Play music & schedule narrations =================== */
async function playMusicWithNarrations(musicObj){
  log('Now playing track:', musicObj.name, musicObj.arquivo);
  updateCover(musicObj.capa || DEFAULT_COVER, true);

  // start music
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

  // Intro
  if(musicObj.introStart != null && musicObj.introEnd != null){
    if(chance(0.7)){
      const r = Math.random();
      if(r < 0.4){
        const pool = narracoesGeneral;
        const zoneLen = musicObj.introEnd - musicObj.introStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'general'}); if(res.scheduled) scheduledPromises.push(res.promise); }
        else log('Intro: no general candidate fits for', musicObj.name);
      } else if(r < 0.8){
        const pool = musicIntroNarrations[musicObj.name] || [];
        if(pool.length>0){
          const zoneLen = musicObj.introEnd - musicObj.introStart;
          const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
          if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'music-specific'}); if(res.scheduled) scheduledPromises.push(res.promise); }
          else log('Intro: none music-specific fit for', musicObj.name);
        } else log('Intro: no music-specific pool for', musicObj.name);
      } else {
        const timePath = pickTimeNarration();
        if(timePath){
          const zoneLen = musicObj.introEnd - musicObj.introStart;
          const chosen = chooseRandomCandidateThatFits([timePath], zoneLen);
          if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'time'}); if(res.scheduled) scheduledPromises.push(res.promise); }
          else log('Intro: time narration too long for', musicObj.name);
        } else log('Intro: no TIME narration for hour');
      }
    } else log('Intro skipped by chance for', musicObj.name);
  } else log('Intro zone absent for', musicObj.name);

  // Final
  if(musicObj.finalStart != null && musicObj.finalEnd != null){
    if(chance(0.7)){
      const r2 = Math.random();
      if(r2 < 0.7){
        const pool = narracoesGeneral;
        const zoneLen = musicObj.finalEnd - musicObj.finalStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'general'}); if(res.scheduled) scheduledPromises.push(res.promise); }
        else log('Final: no general candidate fits for', musicObj.name);
      } else {
        const pick = weightedPick([{k:'toad',w:3},{k:'tonews',w:2},{k:'towheather',w:1}]);
        const pool = endto[pick] || [];
        const zoneLen = musicObj.finalEnd - musicObj.finalStart;
        const chosen = chooseRandomCandidateThatFits(pool, zoneLen);
        if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'endto','subgroup':pick}); if(res.scheduled){ scheduledPromises.push(res.promise); endtoWasScheduled=true; endtoQueuedSubgroup=pick; } }
        else log('Final: no ENDTO candidate fits for', musicObj.name, 'subgroup', pick);
      }
    } else log('Final skipped by chance for', musicObj.name);
  } else log('Final zone absent for', musicObj.name);

  // wait until music ends
  await new Promise(resolve => musicSrc.onended = resolve);
  log('Music ended:', musicObj.name);

  // if endto was scheduled, wait narrations then run followup; else just wait narrs
  if(endtoWasScheduled){
    try{ if(scheduledPromises.length>0) await Promise.all(scheduledPromises); }catch(e){ console.warn('Error waiting scheduled narrs', e); }
    if(endtoQueuedSubgroup) await handleEndtoFollowupQueued(endtoQueuedSubgroup);
  } else {
    try{ if(scheduledPromises.length>0) await Promise.all(scheduledPromises); }catch(e){}
  }

  updateCover(DEFAULT_COVER);
  log('playMusicWithNarrations finished for', musicObj.name);
}

/* =================== Preload helpers =================== */
async function preloadFiles(list){
  const unique = Array.from(new Set(list));
  log('Preloading', unique.length, 'files (best-effort)');
  await Promise.all(unique.map(async p => { try{ await getAudioBuffer(p); }catch(e){ /* ignore */ } }));
  log('PreloadFiles done');
}

async function preloadAll(){
  const toPreload = new Set();
  musicasList.forEach(m=>toPreload.add(m.arquivo));
  narracoesGeneral.forEach(p=>toPreload.add(p));
  Object.values(musicIntroNarrations).flat().forEach(p=>toPreload.add(p));
  Object.values(endto).flat().forEach(p=>toPreload.add(p));
  grupoID.forEach(p=>toPreload.add(p));
  grupoDJSolo.forEach(p=>toPreload.add(p));
  grupoAdv.forEach(p=>toPreload.add(p));
  grupoWeazelNews.forEach(p=>toPreload.add(p));
  Object.values(timePools).flat().forEach(p=>toPreload.add(p));
  for(let i=1;i<=11;i++) toPreload.add(`weather/CLOUD_${pad(i,2)}.wav`);
  for(let i=1;i<=12;i++) toPreload.add(`weather/FOG_${pad(i,2)}.wav`);
  for(let i=1;i<=11;i++) toPreload.add(`weather/RAIN_${pad(i,2)}.wav`);
  for(let i=1;i<=12;i++) toPreload.add(`weather/SUN_${pad(i,2)}.wav`);
  for(let i=1;i<=11;i++) toPreload.add(`weather/WIND_${pad(i,2)}.wav`);
  const arr = Array.from(toPreload);
  await preloadFiles(arr);
}

/* =================== Initial-sequence preload logic =================== */
async function chooseInitialSequenceAndPreload(){
  // choose weighted sequence (same logic as main loop)
  const seq = pickSequenceWeighted();
  log('Initial sequence chosen for preload:', seq);

  // ensure queues
  if(!musicQueue || musicQueue.length===0) resetMusicQueue();
  if(!idQueue || idQueue.length===0 || !advQueue || advQueue.length===0) resetIDAdvQueues();

  // pick the music that will be used for the sequence (peek)
  const musicCandidate = await nextMusic(); // consumes one
  musicQueue.unshift(musicCandidate); // push back to front

  const files = [];

  function addMusicPools(mObj){
    files.push(mObj.arquivo);
    // general narrations
    narracoesGeneral.forEach(p=>files.push(p));
    // music-specific intros
    const specific = musicIntroNarrations[mObj.name] || [];
    specific.forEach(p=>files.push(p));
    // time narrations (all candidates)
    Object.values(timePools).flat().forEach(p=>files.push(p));
    // endto candidates
    Object.values(endto).flat().forEach(p=>files.push(p));
  }

  // include adv/id/djsolo samples depending on sequence
  if(seq.includes('adv')){
    const advSample = advQueue && advQueue.length ? advQueue[0] : grupoAdv[0];
    files.push(advSample);
  }
  if(seq.includes('id')){
    const idSample = idQueue && idQueue.length ? idQueue[0] : grupoID[0];
    files.push(idSample);
  }
  if(seq.includes('djsolo')){
    const dSample = rand(grupoDJSolo);
    files.push(dSample);
  }
  // add music + relevant pools
  addMusicPools(musicCandidate);

  const uniqueFiles = Array.from(new Set(files));
  log('Preloading initial sequence files:', uniqueFiles.length);
  await preloadFiles(uniqueFiles);
  log('Initial sequence preloaded.');
  return seq;
}

/* =================== Initialization & start =================== */
async function init(){
  await loadDuracoesJSON();
  await fetchWeather();
  resetMusicQueue();
  resetIDAdvQueues();
  log('Init complete — ready to start');
}

async function startRadio(){
  if(started) return;
  started = true;
  log('Starting radio (manual)');

  if(audioCtx.state === 'suspended') await audioCtx.resume();
  if(Object.keys(duracoesNarracoes).length === 0) await loadDuracoesJSON();
  await fetchWeather();

  if(!musicQueue || musicQueue.length===0) resetMusicQueue();
  if(!idQueue || idQueue.length===0 || !advQueue || advQueue.length===0) resetIDAdvQueues();

  // choose and preload initial sequence
  const initialSeq = await chooseInitialSequenceAndPreload();

  // start background preload in parallel (do not await)
  preloadAll().then(()=>log('Background preload complete')).catch(e=>log('background preload error', e));

  // execute initial sequence exactly
  await runSequenceImmediately(initialSeq);

  // start main loop
  mainSequenceRunner().catch(e=>console.error('mainSequenceRunner error', e));
}

/* attach start button */
document.getElementById('btnStart')?.addEventListener('click', startRadio);

/* auto-init on load */
init().catch(e=>console.error('init error', e));

/* =================== Expose for debug =================== */
window.__RADIO = {
  startRadio,
  mainSequenceRunner,
  preloadAll,
  loadDuracoesJSON,
  duracoesNarracoes: () => duracoesNarracoes
};

log('renderer.js loaded — manual start via btnStart');
