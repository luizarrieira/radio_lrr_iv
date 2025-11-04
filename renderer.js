// renderer.js — Versão completa: sequence-based preload (current + next) integrada
// Base: versão original fornecida pelo usuário, com pools IVBase / TLAD / IVTLAD
// - Mantém 70% chance de ter narração na intro/final.
// - Pré-carrega apenas current + next sequence. Se next não carregar antes do end, espera.
// - Ao trocar de programação, invalida preloads e começa a carregar da nova programação.
// - Usa duracoes_narracoes.json para validar cabimento das narrações.
// - Exports window.__RADIO.startRadio() e window.__RADIO.setProgramacao()

/* =================== AudioContext / Constants =================== */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

const DUCK_TARGET = 0.5;
const DUCK_DOWN_TIME = 0.1;
const DUCK_UP_TIME = 0.1;
const DUCK_RELEASE_DELAY_MS = 200;
const DEFAULT_COVER = 'capas/default.jpg';

/* =================== Gains / Analyser =================== */
const musicGain = audioCtx.createGain(); musicGain.gain.value = 1.0; musicGain.connect(audioCtx.destination);
const narrationGain = audioCtx.createGain(); narrationGain.connect(audioCtx.destination);
const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.85;
narrationGain.connect(analyser);

/* =================== State & Cache =================== */
const audioBufferCache = new Map(); // path -> AudioBuffer
let duracoesNarracoes = {};
let started = false;
let activeNarrationsCount = 0;
let duckReleaseTimeout = null;
let currentCover = DEFAULT_COVER;

/* =================== Preload / sequence tokens & state =================== */
let preloadTokenCounter = 0;
let activePreloadToken = null;

let sequenceTokenCounter = 0;
let activeSequenceToken = null;

let preparedSequence = null;
let preparedNextSequence = null;
let preparingPromise = null;
let nextPreparingPromise = null;

/* =================== Utils =================== */
function pad(n, len=2){ return String(n).padStart(len, '0'); }
function rand(arr){ return arr && arr.length ? arr[Math.floor(Math.random()*arr.length)] : null; }
function chance(p){ return Math.random() < p; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function log(...args){ console.log('[RADIO]', ...args); }

function weightedPick(items){
  const total = items.reduce((s,i)=>s+i.w,0);
  let r = Math.random()*total;
  for(const it of items){ if(r < it.w) return it.k; r -= it.w; }
  return items[0].k;
}

/* =================== --- BASE (IVBASE) pools --- */
/* base musicasList (existing) */
const base_musicasList = [
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

/* base groups */
const base_narracoesGeneral = Array.from({length:25},(_,i)=>`narracoes/GENERAL_${pad(i+1,2)}.wav`);
const base_grupoID = Array.from({length:12},(_,i)=>`narracoes/ID_${pad(i+1,2)}.wav`);
const base_grupoDJSolo = Array.from({length:13},(_,i)=>`narracoes/SOLO_${pad(i+1,2)}.wav`);
const base_grupoAdv = Array.from({length:83},(_,i)=>`adv/AD${pad(i+1,3)}.wav`);
const base_grupoWeazelNews = Array.from({length:70},(_,i)=>`news/NEWS_${pad(i+1,2)}.wav`);
const base_timePools = {
  morning: Array.from({length:5},(_,i)=>`narracoes/MORNING_${pad(i+1,2)}.wav`),
  afternoon: Array.from({length:5},(_,i)=>`narracoes/AFTERNOON_${pad(i+1,2)}.wav`),
  evening: Array.from({length:6},(_,i)=>`narracoes/EVENING_${pad(i+1,2)}.wav`),
  night: Array.from({length:5},(_,i)=>`narracoes/NIGHT_${pad(i+1,2)}.wav`)
};
const base_endto = {
  toad: Array.from({length:5},(_,i)=>`narracoes/TO_AD_${pad(i+1,2)}.wav`),
  tonews: Array.from({length:5},(_,i)=>`narracoes/TO_NEWS_${pad(i+1,2)}.wav`),
  towheather: Array.from({length:5},(_,i)=>`narracoes/TO_WEATHER_${pad(i+1,2)}.wav`)
};
const base_musicIntroNarrations = {
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

/* =================== --- TLAD pools (novos arquivos) --- */
/* Musicas TLAD (todas as que você listou) */
const tlad_musicasList = [
  { id:'chinagrove_ph', name:'CHINAGROVE_PH', arquivo:'musicas/CHINAGROVE_PH.wav', introStart:6316, introEnd:21472, finalStart:140333, finalEnd:173642, capa:'capas/chinagrove_ph.jpg' },
  { id:'deadoralive_ph', name:'DEADORALIVE_PH', arquivo:'musicas/DEADORALIVE_PH.wav', introStart:15000, introEnd:38946, finalStart:255000, finalEnd:282684, capa:'capas/deadoralive_ph.jpg' },
  { id:'drivinwheel_ph', name:'DRIVINWHEEL_PH', arquivo:'musicas/DRIVINWHEEL_PH.wav', introStart:4650, introEnd:17955, finalStart:199989, finalEnd:221874, capa:'capas/drivinwheel_ph.jpg' },
  { id:'everypicturetells_ph', name:'EVERYPICTURETELLS_PH', arquivo:'musicas/EVERYPICTURETELLS_PH.wav', introStart:3029, introEnd:16238, finalStart:285184, finalEnd:310061, capa:'capas/everypicturetells_ph.jpg' },
  { id:'fivetoone_ph', name:'FIVETOONE_PH', arquivo:'musicas/FIVETOONE_PH.wav', introStart:6925, introEnd:16933, finalStart:224675, finalEnd:248426, capa:'capas/fivetoone_ph.jpg' },
  { id:'freeride_ph', name:'FREERIDE_PH', arquivo:'musicas/FREERIDE_PH.wav', introStart:7082, introEnd:15488, finalStart:145106, finalEnd:162193, capa:'capas/freeride_ph.jpg' },
  { id:'funknumber49_ph', name:'FUNKNUMBER49_PH', arquivo:'musicas/FUNKNUMBER49_PH.wav', introStart:11264, introEnd:16909, finalStart:180819, finalEnd:198260, capa:'capas/funknumber49_ph.jpg' },
  { id:'gotohell_ph', name:'GOTOHELL_PH', arquivo:'musicas/GOTOHELL_PH.wav', introStart:10973, introEnd:35648, finalStart:169389, finalEnd:216368, capa:'capas/gotohell_ph.jpg' },
  { id:'hairofthedog_ph', name:'HAIROFTHEDOG_PH', arquivo:'musicas/HAIROFTHEDOG_PH.wav', introStart:4433, introEnd:15309, finalStart:195958, finalEnd:211168, capa:'capas/hairofthedog_ph.jpg' },
  { id:'highwaystar_ph', name:'HIGHWAYSTAR_PH', arquivo:'musicas/HIGHWAYSTAR_PH.wav', introStart:7269, introEnd:33218, finalStart:235162, finalEnd:265312, capa:'capas/highwaystar_ph.jpg' },
  { id:'jane_ph', name:'JANE_PH', arquivo:'musicas/JANE_PH.wav', introStart:18597, introEnd:33798, finalStart:177247, finalEnd:201148, capa:'capas/jane_ph.jpg' },
  { id:'lordofthethighs_ph', name:'LORDOFTHETHIGHS_PH', arquivo:'musicas/LORDOFTHETHIGHS_PH.wav', introStart:10867, introEnd:28312, finalStart:165870, finalEnd:203869, capa:'capas/lordofthethighs_ph.jpg' },
  { id:'renegade_ph', name:'RENEGADE_PH', arquivo:'musicas/RENEGADE_PH.wav', introStart:30805, introEnd:41317, finalStart:203960, finalEnd:222759, capa:'capas/renegade_ph.jpg' },
  { id:'runtothehills_ph', name:'RUNTOTHEHILLS_PH', arquivo:'musicas/RUNTOTHEHILLS_PH.wav', introStart:4078, introEnd:15701, finalStart:189809, finalEnd:214594, capa:'capas/runtothehills_ph.jpg' },
  { id:'saturdaynightspecial_ph', name:'SATURDAYNIGHTSPECIAL_PH', arquivo:'musicas/SATURDAYNIGHTSPECIAL_PH.wav', introStart:7560, introEnd:22145, finalStart:238702, finalEnd:263517, capa:'capas/saturdaynightspecial_ph.jpg' },
  { id:'touchtoomuch', name:'TOUCHTOOMUCH', arquivo:'musicas/TOUCHTOOMUCH.wav', introStart:1538, introEnd:7714, finalStart:228902, finalEnd:255941, capa:'capas/touchtoomuch.jpg' },
  { id:'wheelofsteel_ph', name:'WHEELOFSTEEL_PH', arquivo:'musicas/WHEELOFSTEEL_PH.wav', introStart:5998, introEnd:18682, finalStart:234613, finalEnd:271267, capa:'capas/wheelofsteel_ph.jpg' },
  { id:'wildside_ph', name:'WILDSIDE_PH', arquivo:'musicas/WILDSIDE_PH.wav', introStart:10206, introEnd:26080, finalStart:161655, finalEnd:186433, capa:'capas/wildside_ph.jpg' }
];

/* TLAD narrations/pools based on your list */
const tlad_narracoesGeneral = Array.from({length:17}, (_,i) => `narracoes/GENERAL_${pad(i+26,2)}.wav`);
const tlad_timePools = {
  morning: ['narracoes/MORNING_06.wav','narracoes/MORNING_07.wav','narracoes/MORNING_08.wav'],
  afternoon: ['narracoes/AFTERNOON_06.wav','narracoes/AFTERNOON_07.wav','narracoes/AFTERNOON_08.wav'],
  evening: ['narracoes/EVENING_07.wav','narracoes/EVENING_08.wav','narracoes/EVENING_09.wav'],
  night: ['narracoes/NIGHT_06.wav','narracoes/NIGHT_07.wav','narracoes/NIGHT_08.wav']
};
const tlad_endto = {
  toad: ['narracoes/TO_AD_06.wav','narracoes/TO_AD_07.wav'],
  tonews: ['narracoes/TO_NEWS_06.wav','narracoes/TO_NEWS_07.wav','narracoes/TO_NEWS_08.wav'],
  towheather: ['narracoes/TO_WEATHER_06.wav','narracoes/TO_WEATHER_07.wav','narracoes/TO_WEATHER_08.wav']
};
/* TLAD adv: AD001..AD093 but ivbase should not use AD084..AD093 */
const tlad_grupoAdv = Array.from({length:93},(_,i)=>`adv/AD${pad(i+1,3)}.wav`);
const tlad_grupoWeazelNews = Array.from({length:125},(_,i)=>`news/NEWS_${pad(i+1,2)}.wav`);
const tlad_grupoDJSolo = Array.from({length:10},(_,i)=>`narracoes/SOLO_${pad(i+14,2)}.wav`);

/* TLAD music specific intro narrations (two each) */
const tlad_musicIntroNarrations = {
  'CHINAGROVE_PH': ['narracoes/CHINAGROVE_PH_01.wav','narracoes/CHINAGROVE_PH_02.wav'],
  'DEADORALIVE_PH': ['narracoes/DEADORALIVE_PH_01.wav','narracoes/DEADORALIVE_PH_02.wav'],
  'DRIVINWHEEL_PH': ['narracoes/DRIVINWHEEL_PH_01.wav','narracoes/DRIVINWHEEL_PH_02.wav'],
  'EVERYPICTURETELLS_PH': ['narracoes/EVERYPICTURETELLS_PH_01.wav','narracoes/EVERYPICTURETELLS_PH_02.wav'],
  'FIVETOONE_PH': ['narracoes/FIVETOONE_PH_01.wav','narracoes/FIVETOONE_PH_02.wav'],
  'FREERIDE_PH': ['narracoes/FREERIDE_PH_01.wav','narracoes/FREERIDE_PH_02.wav'],
  'FUNKNUMBER49_PH': ['narracoes/FUNKNUMBER49_PH_01.wav','narracoes/FUNKNUMBER49_PH_02.wav'],
  'GOTOHELL_PH': ['narracoes/GOTOHELL_PH_01.wav','narracoes/GOTOHELL_PH_02.wav'],
  'HAIROFTHEDOG_PH': ['narracoes/HAIROFTHEDOG_PH_01.wav','narracoes/HAIROFTHEDOG_PH_02.wav'],
  'HIGHWAYSTAR_PH': ['narracoes/HIGHWAYSTAR_PH_01.wav','narracoes/HIGHWAYSTAR_PH_02.wav'],
  'JANE_PH': ['narracoes/JANE_PH_01.wav','narracoes/JANE_PH_02.wav'],
  'LORDOFTHETHIGHS_PH': ['narracoes/LORDOFTHETHIGHS_PH_01.wav','narracoes/LORDOFTHETHIGHS_PH_02.wav'],
  'RENEGADE_PH': ['narracoes/RENEGADE_PH_01.wav','narracoes/RENEGADE_PH_02.wav'],
  'RUNTOTHEHILLS_PH': ['narracoes/RUNTOTHEHILLS_PH_01.wav','narracoes/RUNTOTHEHILLS_PH_02.wav'],
  'SATURDAYNIGHTSPECIAL_PH': ['narracoes/SATURDAYNIGHTSPECIAL_PH_01.wav','narracoes/SATURDAYNIGHTSPECIAL_PH_02.wav'],
  'TOUCHTOOMUCH': ['narracoes/TOUCHTOOMUCH_01.wav','narracoes/TOUCHTOOMUCH_02.wav'],
  'WHEELOFSTEEL_PH': ['narracoes/WHEELOFSTEEL_PH_01.wav','narracoes/WHEELOFSTEEL_PH_02.wav'],
  'WILDSIDE_PH': ['narracoes/WILDSIDE_PH_01.wav','narracoes/WILDSIDE_PH_02.wav']
};

/* =================== IVTLAD (union) pools =================== */
const ivtlad_musicasList = [...base_musicasList, ...tlad_musicasList];
const ivtlad_narracoesGeneral = Array.from({length:42},(_,i)=>`narracoes/GENERAL_${pad(i+1,2)}.wav`);
const ivtlad_timePools = {
  morning: Array.from({length:8},(_,i)=>`narracoes/MORNING_${pad(i+1,2)}.wav`),
  afternoon: Array.from({length:8},(_,i)=>`narracoes/AFTERNOON_${pad(i+1,2)}.wav`),
  evening: Array.from({length:9},(_,i)=>`narracoes/EVENING_${pad(i+1,2)}.wav`),
  night: Array.from({length:8},(_,i)=>`narracoes/NIGHT_${pad(i+1,2)}.wav`)
};
const ivtlad_endto = {
  toad: Array.from({length:7},(_,i)=>`narracoes/TO_AD_${pad(i+1,2)}.wav`),
  tonews: Array.from({length:8},(_,i)=>`narracoes/TO_NEWS_${pad(i+1,2)}.wav`),
  towheather: Array.from({length:8},(_,i)=>`narracoes/TO_WEATHER_${pad(i+1,2)}.wav`)
};
const ivtlad_grupoAdv = Array.from({length:93},(_,i)=>`adv/AD${pad(i+1,3)}.wav`);
const ivtlad_grupoWeazelNews = Array.from({length:125},(_,i)=>`news/NEWS_${pad(i+1,2)}.wav`);
const ivtlad_grupoDJSolo = Array.from({length:23},(_,i)=>`narracoes/SOLO_${pad(i+1,2)}.wav`);
const ivtlad_musicIntroNarrations = {...base_musicIntroNarrations, ...tlad_musicIntroNarrations};

/* =================== PROGRAMACOES object =================== */
const PROGRAMACOES = {
  ivbase: {
    key: 'ivbase',
    musicasList: base_musicasList.slice(),
    narracoesGeneral: base_narracoesGeneral.slice(),
    timePools: JSON.parse(JSON.stringify(base_timePools)),
    endto: JSON.parse(JSON.stringify(base_endto)),
    grupoID: base_grupoID.slice(),
    grupoDJSolo: base_grupoDJSolo.slice(),
    grupoAdv: base_grupoAdv.slice(), // AD001..AD083
    grupoWeazelNews: base_grupoWeazelNews.slice(),
    musicIntroNarrations: Object.assign({}, base_musicIntroNarrations)
  },
  tlad: {
    key: 'tlad',
    musicasList: tlad_musicasList.slice(),
    narracoesGeneral: tlad_narracoesGeneral.slice(),
    timePools: JSON.parse(JSON.stringify(tlad_timePools)),
    endto: JSON.parse(JSON.stringify(tlad_endto)),
    grupoID: base_grupoID.slice(),       // reuse IDs from ivbase
    grupoDJSolo: tlad_grupoDJSolo.slice(),
    grupoAdv: tlad_grupoAdv.slice(),     // AD001..AD093 (tlad may use AD001..AD093 but ivbase uses only 001..083)
    grupoWeazelNews: tlad_grupoWeazelNews.slice(),
    musicIntroNarrations: Object.assign({}, tlad_musicIntroNarrations)
  },
  ivtlad: {
    key: 'ivtlad',
    musicasList: ivtlad_musicasList.slice(),
    narracoesGeneral: ivtlad_narracoesGeneral.slice(),
    timePools: JSON.parse(JSON.stringify(ivtlad_timePools)),
    endto: JSON.parse(JSON.stringify(ivtlad_endto)),
    grupoID: base_grupoID.slice(),
    grupoDJSolo: ivtlad_grupoDJSolo.slice(),
    grupoAdv: ivtlad_grupoAdv.slice(),
    grupoWeazelNews: ivtlad_grupoWeazelNews.slice(),
    musicIntroNarrations: Object.assign({}, ivtlad_musicIntroNarrations)
  }
};

/* =================== Active program state & queues =================== */
let currentProgram = 'ivbase';
let pendingProgram = null;
let ativo = PROGRAMACOES[currentProgram];

let musicQueue = [];
let idQueue = [];
let advQueue = [];

function shuffle(arr){ const a = arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function resetMusicQueue(){ musicQueue = shuffle((ativo.musicasList || []).slice()); }
function resetIDAdvQueues(){ idQueue = shuffle((ativo.grupoID || []).slice()); advQueue = shuffle((ativo.grupoAdv || []).slice()); }
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
loadDuracoesJSON();

/* =================== Audio buffer fetch & decode (no cancellation) ===================
   Note: fetch/decode can't be reliably aborted across browsers once started without AbortController for fetch
   and decodeAudioData lacks cancellation — we control the overall preload flow via tokens and ignore results from stale tokens.
*/
async function getAudioBuffer(path){
  // Return cached if present
  if(audioBufferCache.has(path)) return audioBufferCache.get(path);
  try{
    const resp = await fetch(path);
    if(!resp.ok) throw new Error('fetch ' + resp.status + ' ' + path);
    const ab = await resp.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(ab);
    audioBufferCache.set(path, buf);
    log('Cached buffer:', path);
    return buf;
  }catch(e){
    console.warn('getAudioBuffer error', path, e);
    throw e;
  }
}

/* Helper plays */
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

/* =================== Weather & TIME (shared) =================== */
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

/* pick time narration from the active program */
function pickTimeNarration(){
  const h = new Date().getHours();
  if(h>=4 && h<=10){ const pool = ativo.timePools?.morning || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
  if(h>=13 && h<=16){ const pool = ativo.timePools?.afternoon || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
  if(h>=18 && h<=19){ const pool = ativo.timePools?.evening || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
  if(h>=21 || h<=1){ const pool = ativo.timePools?.night || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
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

/* =================== Schedule narration to end at given zone =================== */
async function scheduleNarrationToEndAt(musicStartAudioTime, zoneStartMs, zoneEndMs, candidatePath, candidateDurMs, meta={}){
  if(!candidatePath) return {scheduled:false};
  const durMs = candidateDurMs;
  let startOffsetSec = (zoneEndMs - durMs) / 1000;
  if(startOffsetSec < zoneStartMs/1000) startOffsetSec = zoneStartMs/1000;
  const startAudioTime = musicStartAudioTime + startOffsetSec;

  try{
    const buf = await getAudioBuffer(candidatePath);
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(narrationGain);

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

/* =================== ENDTO followup (after music & final narrator done)
   IMPORTANT: if pendingProgram exists at the end of the music and endtoWasScheduled,
   we apply the pendingProgram BEFORE running the ENDTO followup — so the followup uses new program pools.
*/
async function handleEndtoFollowupQueued(subgroup){
  if(!subgroup) return;
  updateCover(DEFAULT_COVER);
  log('ENDTO followup for', subgroup, 'using program', ativo.key);
  if(subgroup === 'toad'){
    const pick = Math.random() < 0.5 ? 'adv+musica' : 'adv+id+musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'tonews'){
    const newsPool = ativo.grupoWeazelNews || [];
    const news = newsPool.length ? rand(newsPool) : null;
    if(news) await playNarrationImmediate(news);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'towheather'){
    const weatherFile = pickWeatherFile(currentWeatherMain);
    if(weatherFile) await playNarrationImmediate(weatherFile);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  }
}

/* =================== runSequenceImmediately (uses active program pools) */
async function runSequenceImmediately(seq){
  log('runSequenceImmediately ->', seq, 'program', ativo.key);
  switch(seq){
    case 'adv+musica': {
      updateCover(DEFAULT_COVER);
      const adv = await nextAdv();
      if(adv) await playBufferToDestination(await getAudioBuffer(adv));
      const m = await nextMusic();
      if(m) await playMusicWithNarrations(m);
      break;
    }
    case 'adv+id+musica': {
      updateCover(DEFAULT_COVER);
      const adv = await nextAdv();
      if(adv) await playBufferToDestination(await getAudioBuffer(adv));
      const id = await nextID();
      if(id) await playBufferToDestination(await getAudioBuffer(id));
      const m = await nextMusic();
      if(m) await playMusicWithNarrations(m);
      break;
    }
    case 'id+musica': {
      updateCover(DEFAULT_COVER);
      const id = await nextID();
      if(id) await playBufferToDestination(await getAudioBuffer(id));
      const m = await nextMusic();
      if(m) await playMusicWithNarrations(m);
      break;
    }
    case 'id+djsolo+musica': {
      updateCover(DEFAULT_COVER);
      const id = await nextID();
      if(id) await playBufferToDestination(await getAudioBuffer(id));
      const d = rand(ativo.grupoDJSolo);
      if(d) await playBufferToDestination(await getAudioBuffer(d));
      const m = await nextMusic();
      if(m) await playMusicWithNarrations(m);
      break;
    }
    case 'djsolo+musica': {
      updateCover(DEFAULT_COVER);
      const d = rand(ativo.grupoDJSolo);
      if(d) await playBufferToDestination(await getAudioBuffer(d));
      const m = await nextMusic();
      if(m) await playMusicWithNarrations(m);
      break;
    }
    case 'musica': {
      const m = await nextMusic();
      if(m) await playMusicWithNarrations(m);
      break;
    }
    default:
      console.warn('Unknown immediate sequence', seq);
  }
}

/* =================== Sequence-building & sequence-based preload logic =================== */

/* Build a concrete "sequence object" (deterministic for one playback)
   A sequence object format:
   {
     seqKey: 'id+musica',      // string
     parts: [{ type:'id'|'adv'|'djsolo'|'musica'|'news'|'weather', path: '...', extra:{...} }, ...],
     endtoRequest: null | 'toad'|'tonews'|'towheather'
   }
*/
async function buildConcreteSequence(programKey, overrideEndto=null){
  const prog = PROGRAMACOES[programKey || currentProgram];
  if(!prog) return null;

  const sequencePool = [
    {k:'id+musica', w:3},
    {k:'djsolo+musica', w:3},
    {k:'musica', w:3},
    {k:'adv+musica', w:1},
    {k:'adv+id+musica', w:1},
    {k:'id+djsolo+musica', w:1}
  ];
  const seqKey = weightedPick(sequencePool);
  const seq = { seqKey, parts: [], endtoRequest: null };

  const pickFrom = (pool) => pool && pool.length ? pool[Math.floor(Math.random()*pool.length)] : null;

  // Build parts according to seqKey, in order
  if(seqKey.startsWith('adv')){
    const adv = await nextAdv();
    if(adv) seq.parts.push({type:'adv', path:adv});
    if(seqKey === 'adv+id+musica'){
      const id2 = await nextID();
      if(id2) seq.parts.push({type:'id', path:id2});
    }
  } else if(seqKey.startsWith('id')){
    const id = await nextID();
    if(id) seq.parts.push({type:'id', path:id});
  } else if(seqKey === 'djsolo+musica'){
    const d = pickFrom(prog.grupoDJSolo || []);
    if(d) seq.parts.push({type:'djsolo', path:d});
  }

  if(seqKey === 'id+djsolo+musica'){
    const d = pickFrom(prog.grupoDJSolo || []);
    if(d) seq.parts.push({type:'djsolo', path:d});
  }

  // Now attach music if sequence requires it
  if(seqKey.includes('musica')){
    const musicObj = await nextMusic();
    if(musicObj){
      // Determine whether to have intro/final narrations — keep exactly 70% chance
      const willIntro = (musicObj.introStart != null && musicObj.introEnd != null) && chance(0.7);
      const willFinal = (musicObj.finalStart != null && musicObj.finalEnd != null) && chance(0.7);

      const chosenNarrations = [];

      if(willIntro){
        const r = Math.random();
        if(r < 0.4){
          const pool = prog.narracoesGeneral || [];
          const cand = chooseRandomCandidateThatFits(pool, musicObj.introEnd - musicObj.introStart);
          if(cand) chosenNarrations.push({when:'intro', path:cand.path, dur:cand.dur, pool:'general'});
        } else if(r < 0.8){
          const pool = (prog.musicIntroNarrations && prog.musicIntroNarrations[musicObj.name]) || [];
          const cand = chooseRandomCandidateThatFits(pool, musicObj.introEnd - musicObj.introStart);
          if(cand) chosenNarrations.push({when:'intro', path:cand.path, dur:cand.dur, pool:'music-specific'});
        } else {
          const timePath = pickTimeNarration();
          if(timePath){
            const cand = chooseRandomCandidateThatFits([timePath], musicObj.introEnd - musicObj.introStart);
            if(cand) chosenNarrations.push({when:'intro', path:cand.path, dur:cand.dur, pool:'time'});
          }
        }
      }

      if(willFinal){
        const r2 = Math.random();
        if(r2 < 0.7){
          const pool = prog.narracoesGeneral || [];
          const cand = chooseRandomCandidateThatFits(pool, musicObj.finalEnd - musicObj.finalStart);
          if(cand) chosenNarrations.push({when:'final', path:cand.path, dur:cand.dur, pool:'general'});
        } else {
          const pick = weightedPick([{k:'toad',w:3},{k:'tonews',w:2},{k:'towheather',w:1}]);
          const pool = (prog.endto && prog.endto[pick]) ? prog.endto[pick] : [];
          const cand = chooseRandomCandidateThatFits(pool, musicObj.finalEnd - musicObj.finalStart);
          if(cand){
            chosenNarrations.push({when:'final', path:cand.path, dur:cand.dur, pool:'endto', subgroup:pick});
            seq.endtoRequest = pick;
          }
        }
      }

      seq.parts.push({ type:'musica', music: musicObj, path: musicObj.arquivo, narrations: chosenNarrations });
    }
  }

  if(overrideEndto) seq.endtoRequest = overrideEndto;
  return seq;
}

/* Preload the exact files required by a concrete sequence.
   Observa token: if token invalidado, abort early.
   Returns loaded list or throws 'token_stale' if aborted.
*/
async function preloadSequenceFiles(sequence, token){
  if(!sequence) return {loaded:[]};
  const files = new Set();
  for(const p of sequence.parts){
    if(p.type === 'musica'){
      if(p.path) files.add(p.path);
      if(Array.isArray(p.narrations)) p.narrations.forEach(n => { if(n.path) files.add(n.path); });
    } else {
      if(p.path) files.add(p.path);
    }
  }
  if(sequence.endtoRequest === 'towheather'){
    const wf = pickWeatherFile(currentWeatherMain);
    if(wf) files.add(wf);
  }

  const list = Array.from(files);
  log('preloadSequenceFiles token', token, 'filesCount', list.length);
  for(const f of list){
    if(token !== activeSequenceToken){ log('preloadSequenceFiles: token stale -> aborting:', token); throw new Error('token_stale'); }
    if(audioBufferCache.has(f)) continue;
    try{
      await getAudioBuffer(f); // will cache
    }catch(e){
      console.warn('preloadSequenceFiles: failed to load', f, e);
      // continue: we'll still require all files loaded; caller will wait if necessary
    }
  }
  log('preloadSequenceFiles finished for token', token);
  return {loaded:list};
}

/* Play a prepared sequence (uses cached buffers) */
async function playPreparedSequence(seq){
  if(!seq) return;
  updateCover(DEFAULT_COVER);
  log('playPreparedSequence ->', seq.seqKey);

  for(const part of seq.parts){
    if(part.type === 'id' || part.type === 'adv' || part.type === 'djsolo' || part.type === 'news' || part.type === 'weather'){
      try{
        const buf = await getAudioBuffer(part.path);
        await playBufferToDestination(buf);
      }catch(e){
        console.warn('playPreparedSequence: failed to play part', part, e);
      }
    } else if(part.type === 'musica'){
      await playMusicObjectWithChosenNarrations(part.music, part.narrations || []);
    }
  }
}

/* Plays the musicObj and schedules narrations exactly as in 'part.narrations' */
async function playMusicObjectWithChosenNarrations(musicObj, narrationList){
  if(!musicObj) return;
  log('Now playing (prepared) track:', musicObj.name, musicObj.arquivo, 'program', ativo.key);
  updateCover(musicObj.capa || DEFAULT_COVER, true);

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

  for(const nar of narrationList){
    if(nar.when === 'intro'){
      const zoneStartMs = musicObj.introStart;
      const zoneEndMs = musicObj.introEnd;
      const res = await scheduleNarrationToEndAt(musicStartAudioTime, zoneStartMs, zoneEndMs, nar.path, nar.dur, {reason:'intro','pool':nar.pool});
      if(res.scheduled) scheduledPromises.push(res.promise);
    } else if(nar.when === 'final'){
      const zoneStartMs = musicObj.finalStart;
      const zoneEndMs = musicObj.finalEnd;
      const res = await scheduleNarrationToEndAt(musicStartAudioTime, zoneStartMs, zoneEndMs, nar.path, nar.dur, {reason:'final','pool':nar.pool, subgroup:nar.subgroup});
      if(res.scheduled){
        scheduledPromises.push(res.promise);
        if(nar.pool === 'endto' && nar.subgroup) { endtoWasScheduled=true; endtoQueuedSubgroup=nar.subgroup; }
      }
    }
  }

  await new Promise(resolve => musicSrc.onended = resolve);
  log('Music ended:', musicObj.name);

  if(scheduledPromises.length>0){
    try{ await Promise.all(scheduledPromises); } catch(e){ console.warn('Error waiting scheduled narrs', e); }
  }

  if(endtoWasScheduled && endtoQueuedSubgroup){
    await handleEndtoFollowupQueued(endtoQueuedSubgroup);
  }

  updateCover(DEFAULT_COVER);
  log('playMusicObjectWithChosenNarrations finished for', musicObj.name);
}

/* Prune cache after swap: keep only files in oldSeq and newSeq */
function pruneCacheForSequenceSwap(oldSeq, newSeq){
  try{
    const keep = new Set();
    const addSeqFiles = (s) => {
      if(!s) return;
      for(const p of s.parts){
        if(p.type === 'musica'){
          if(p.path) keep.add(p.path);
          if(p.narrations) p.narrations.forEach(n => { if(n.path) keep.add(n.path); });
        } else {
          if(p.path) keep.add(p.path);
        }
      }
    };
    addSeqFiles(oldSeq);
    addSeqFiles(newSeq);

    for(const key of Array.from(audioBufferCache.keys())){
      if(!keep.has(key)){
        audioBufferCache.delete(key);
        log('Pruned buffer from cache:', key);
      }
    }
  }catch(e){
    console.warn('pruneCacheForSequenceSwap error', e);
  }
}

/* Sequence loop runner */
async function sequenceLoopRunner(){
  try{
    sequenceTokenCounter++;
    const token = sequenceTokenCounter;
    activeSequenceToken = token;
    log('sequenceLoopRunner started token', token, 'program', currentProgram);

    if(!ativo) ativo = PROGRAMACOES[currentProgram];
    resetMusicQueue();
    resetIDAdvQueues();

    preparedSequence = await buildConcreteSequence(ativo.key);
    if(!preparedSequence){ log('No sequence built, aborting loop'); return; }

    try{
      await preloadSequenceFiles(preparedSequence, token);
    }catch(e){
      if(e && e.message === 'token_stale'){ log('Initial preload aborted due to token change'); return; }
      else throw e;
    }

    preparedNextSequence = await buildConcreteSequence(ativo.key, preparedSequence.endtoRequest);
    nextPreparingPromise = preloadSequenceFiles(preparedNextSequence, token).catch(err=>{
      if(err && err.message === 'token_stale'){ log('nextPreparingPromise aborted due to token change'); return; }
      console.warn('nextPreparingPromise failed', err);
    });

    while(true){
      if(activeSequenceToken !== token){ log('sequenceLoopRunner token invalid, exiting'); return; }

      await playPreparedSequence(preparedSequence);

      if(nextPreparingPromise){
        try{ await nextPreparingPromise; }catch(e){ /* logged */ }
      }

      if(activeSequenceToken !== token){
        log('sequenceLoopRunner token changed after play, exiting for restart');
        return;
      }

      pruneCacheForSequenceSwap(preparedSequence, preparedNextSequence);

      preparedSequence = preparedNextSequence;

      preparedNextSequence = await buildConcreteSequence(ativo.key, preparedSequence ? preparedSequence.endtoRequest : null);
      nextPreparingPromise = preloadSequenceFiles(preparedNextSequence, token).catch(err=>{
        if(err && err.message === 'token_stale'){ log('nextPreparingPromise aborted due to token change'); return; }
        console.warn('nextPreparingPromise failed', err);
      });
    }
  }catch(e){
    console.error('sequenceLoopRunner error', e);
  }
}

/* Legacy dynamic music play (kept for ENDTO fallback) */
async function playMusicWithNarrations(musicObj){
  if(!musicObj){ log('No music object provided'); return; }
  log('Now playing track (dynamic):', musicObj.name, musicObj.arquivo, 'program', ativo.key);
  updateCover(musicObj.capa || DEFAULT_COVER, true);

  const musicBuf = await getAudioBuffer(musicObj.arquivo);
  const musicSrc = audioCtx.createBufferSource();
  musicSrc.buffer = musicBuf;
  musicSrc.connect(musicGain);
  const musicStartAudioTime = audioCtx.currentTime;
  musicSrc.start(musicStartAudioTime);
  log('Music started at audioTime', musicStartAudioTime.toFixed(3));

  const scheduledPromises = [];
  let endtoWasScheduled = false;

  // Intro scheduling: 70% chance
  if(musicObj.introStart != null && musicObj.introEnd != null && chance(0.7)){
    const r = Math.random();
    if(r < 0.4){
      const pool = ativo.narracoesGeneral || [];
      const chosen = chooseRandomCandidateThatFits(pool, musicObj.introEnd - musicObj.introStart);
      if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'general'}); if(res.scheduled) scheduledPromises.push(res.promise); }
    } else if(r < 0.8){
      const pool = (ativo.musicIntroNarrations && ativo.musicIntroNarrations[musicObj.name]) ? ativo.musicIntroNarrations[musicObj.name] : [];
      if(pool.length>0){
        const chosen = chooseRandomCandidateThatFits(pool, musicObj.introEnd - musicObj.introStart);
        if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'music-specific'}); if(res.scheduled) scheduledPromises.push(res.promise); }
      }
    } else {
      const timePath = pickTimeNarration();
      if(timePath){
        const chosen = chooseRandomCandidateThatFits([timePath], musicObj.introEnd - musicObj.introStart);
        if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.introStart, musicObj.introEnd, chosen.path, chosen.dur, {reason:'intro','pool':'time'}); if(res.scheduled) scheduledPromises.push(res.promise); }
      }
    }
  }

  // Final scheduling: 70% chance
  if(musicObj.finalStart != null && musicObj.finalEnd != null && chance(0.7)){
    const r2 = Math.random();
    if(r2 < 0.7){
      const pool = ativo.narracoesGeneral || [];
      const chosen = chooseRandomCandidateThatFits(pool, musicObj.finalEnd - musicObj.finalStart);
      if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'general'}); if(res.scheduled) scheduledPromises.push(res.promise); }
    } else {
      const pick = weightedPick([{k:'toad',w:3},{k:'tonews',w:2},{k:'towheather',w:1}]);
      const pool = (ativo.endto && ativo.endto[pick]) ? ativo.endto[pick] : [];
      const chosen = chooseRandomCandidateThatFits(pool, musicObj.finalEnd - musicObj.finalStart);
      if(chosen){ const res = await scheduleNarrationToEndAt(musicStartAudioTime, musicObj.finalStart, musicObj.finalEnd, chosen.path, chosen.dur, {reason:'final','pool':'endto','subgroup':pick}); if(res.scheduled){ scheduledPromises.push(res.promise); endtoWasScheduled=true; } }
    }
  }

  await new Promise(resolve => musicSrc.onended = resolve);
  log('Music ended:', musicObj.name);

  if(scheduledPromises.length>0){
    try{ await Promise.all(scheduledPromises); } catch(e){ console.warn('Error waiting scheduled narrs', e); }
  }

  updateCover(DEFAULT_COVER);
  log('playMusicWithNarrations finished for', musicObj.name);
}

/* =================== API: startRadio, setProgramacao =================== */
async function startRadio(){
  if(started) return;
  started = true;
  ativo = PROGRAMACOES[currentProgram];
  sequenceLoopRunner().catch(e=>console.error('sequenceLoopRunner start error', e));
  log('Radio started with program', currentProgram);
}
function setProgramacao(newKey){
  if(!PROGRAMACOES[newKey]) { console.warn('Unknown program:', newKey); return; }
  pendingProgram = newKey;
  sequenceTokenCounter++;
  activeSequenceToken = sequenceTokenCounter; // invalidates previous preloads/loops
  currentProgram = newKey;
  ativo = PROGRAMACOES[currentProgram];
  resetMusicQueue();
  resetIDAdvQueues();
  sequenceLoopRunner().catch(e=>console.error('sequenceLoopRunner restart error', e));
  log('Program changed to', newKey);
}

/* Expose */
window.__RADIO = window.__RADIO || {};
window.__RADIO.startRadio = startRadio;
window.__RADIO.setProgramacao = setProgramacao;
window.__RADIO._debug = {
  audioCtx,
  audioBufferCache,
  getPreparedSequence: ()=>preparedSequence,
  getNextPreparedSequence: ()=>preparedNextSequence,
  getActiveSequenceToken: ()=>activeSequenceToken
};
