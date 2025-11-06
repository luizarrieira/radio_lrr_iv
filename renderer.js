// renderer.js — Versão otimizada JIT (v2)
// + Lógica de troca de programa avançada (v3) com "keep-alive" do job anterior
// + Lógica de "Lockout" de 30s

/* =================== AudioContext / Constants =================== */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

const DUCK_TARGET = 0.5;
const DUCK_DOWN_TIME = 0.1;
const DUCK_UP_TIME = 0.1;
const DUCK_RELEASE_DELAY_MS = 200;
const DEFAULT_COVER = 'capas/default.jpg';
const LOCKOUT_TIME_SECONDS = 30; // Tempo de "lockout" no final da faixa

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

/* =================== JIT Preload State (Lógica v3 Avançada) =================== */
let preloadTokenCounter = 0; // Usado para cancelar preloads ao trocar de programa
let activePreloadToken = 0;
let currentFollowupHint = null; // Armazena o gatilho ENDTO (ex: 'toad')

// Lógica de Job Duplo
let nextSequenceJob = null;         // O próximo job da *programação atual*
let nextSequenceJobPromise = null;  // A promessa de carregamento do job acima
let pendingProgramSwitch = null;    // Nome da programação pendente (ex: 'tlad')
let pendingProgramJob = null;       // O job pré-carregado da *programação pendente*
let pendingProgramJobPromise = null; // A promessa de carregamento do job pendente
let isPreloadingNext = false; // Flag para evitar preloads duplicados

// Lógica de Lockout
let musicEndTime = 0; // O audioCtx.currentTime em que a música atual terminará
let programSwitchQueuedForLockout = null; // Armazena a troca pedida durante o lockout

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
/* (Pools de arquivos OMITIDOS POR BREVIDADE - eles permanecem os mesmos) */
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
  { id:'drivinwheel_ph', name:'DRIVINWHELL_PH', arquivo:'musicas/DRIVINWHELL_PH.wav', introStart:4650, introEnd:17955, finalStart:199989, finalEnd:221874, capa:'capas/drivinwheel_ph.jpg' },
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
// *** SUA ALTERAÇÃO APLICADA (SOLO_14 a SOLO_23) ***
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
// IVTLAD usa todos os 23 solos
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
    grupoDJSolo: tlad_grupoDJSolo.slice(), // *** USA A LISTA MODIFICADA (14-23) ***
    grupoAdv: tlad_grupoAdv.slice(),     // AD001..AD093
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
    grupoDJSolo: ivtlad_grupoDJSolo.slice(), // *** USA A LISTA COMPLETA (1-23) ***
    grupoAdv: ivtlad_grupoAdv.slice(),
    grupoWeazelNews: ivtlad_grupoWeazelNews.slice(),
    musicIntroNarrations: Object.assign({}, ivtlad_musicIntroNarrations)
  }
};

/* =================== Active program state & queues =================== */
let currentProgram = 'ivbase';
// 'ativo' é usado *apenas* pela 'prepareNextSequence' para saber
// de quais pools puxar os arquivos (seja o pool 'current' ou 'pending').
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

/* =================== Audio buffer fetch (JIT version) =================== */
async function getAudioBuffer(path, token = null){
  if(audioBufferCache.has(path)) return audioBufferCache.get(path);
  if(token && token !== activePreloadToken) {
    throw new Error(`Preload token stale for ${path}. Active: ${activePreloadToken}, Got: ${token}`);
  }
  try{
    const resp = await fetch(path);
    if(!resp.ok) throw new Error('fetch ' + resp.status + ' ' + path);
    const ab = await resp.arrayBuffer();
    if(token && token !== activePreloadToken) {
      throw new Error(`Preload token stale after fetch ${path}. Active: ${activePreloadToken}, Got: ${token}`);
    }
    const buf = await audioCtx.decodeAudioData(ab);
    audioBufferCache.set(path, buf);
    log('Cached buffer:', path);
    return buf;
  }catch(e){
    if(e.message.includes('stale')) {
      log('Preload canceled for:', path);
    } else {
      console.warn('getAudioBuffer error', path, e);
    }
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

/* =================== Ducking control (Sem alterações) =================== */
function onNarrationStart(){
  activeNarrationsCount++;
  if(duckReleaseTimeout){ clearTimeout(duckReleaseTimeout); duckReleaseTimeout=null; }
  const now = audioCtx.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(musicGain.gain.value, now);
  musicGain.gain.linearRampToValueAtTime(DUCK_TARGET, now + DUCK_DOWN_TIME);
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
    }, DUCK_RELEASE_DELAY_MS);
  }
}

/* =================== Cover handling (Sem alterações) =================== */
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

/* =================== Weather & TIME (Sem alterações) =================== */
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

function pickTimeNarration(){
  const h = new Date().getHours();
  if(h>=4 && h<=10){ const pool = ativo.timePools?.morning || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
  if(h>=13 && h<=16){ const pool = ativo.timePools?.afternoon || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
  if(h>=18 && h<=19){ const pool = ativo.timePools?.evening || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
  if(h>=21 || h<=1){ const pool = ativo.timePools?.night || []; return pool.length ? pool[Math.floor(Math.random()*pool.length)] : null; }
  return null;
}

/* =================== Candidate filtering (Sem alterações) =================== */
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

/* =================== Schedule narration (Sem alterações) =================== */
async function scheduleNarrationToEndAt(musicStartAudioTime, zoneStartMs, zoneEndMs, candidatePath, candidateDurMs, meta={}){
  if(!candidatePath) return {scheduled:false};
  const durMs = candidateDurMs;
  let startOffsetSec = (zoneEndMs - durMs) / 1000;
  if(startOffsetSec < zoneStartMs/1000) startOffsetSec = zoneStartMs/1000;
  const startAudioTime = musicStartAudioTime + startOffsetSec;

  try{
    const buf = await getAudioBuffer(candidatePath); // Pega do cache
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(narrationGain);

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
    return {scheduled:true, promise:p, chosen:candidatePath, dur:durMs, meta};
  }catch(e){
    console.warn('scheduleNarrationToEndAt failed', candidatePath, e);
    return {scheduled:false};
  }
}

/* =================== Play immediate narration (Helper) =================== */
async function playNarrationImmediate(path){
  if(!path) return;
  updateCover(DEFAULT_COVER);
  try{
    const buf = await getAudioBuffer(path); // Pega do cache
    onNarrationStart();
    await playBufferToNarrationGain(buf);
    onNarrationEnd();
  }catch(e){
    console.warn('playNarrationImmediate failed', path, e);
  }
}

/* =================== Sequence pool (Sem alterações) =================== */
const sequencePool = [
  {k:'id+musica', w:3},
  {k:'djsolo+musica', w:3},
  {k:'musica', w:3},
  {k:'adv+musica', w:1},
  {k:'adv+id+musica', w:1},
  {k:'id+djsolo+musica', w:1}
];
function pickSequenceWeighted(){ return weightedPick(sequencePool); }


/* ================================================================= */
/* =================== ARQUITETURA DE SEQUÊNCIA (v3 Avançada) ====== */
/* ================================================================= */

/**
 * (MODIFICADO) Prepara a *próxima* sequência.
 * Esta função agora é genérica. Ela retorna um 'job' ou 'null'.
 * Ela NÃO armazena o resultado em 'nextSequenceJob' diretamente.
 */
async function prepareNextSequence(token, programKey, hint) {
  // 1. Configura o 'ativo' temporariamente para este preload
  const originalAtivo = ativo;
  ativo = PROGRAMACOES[programKey];
  if(ativo.key !== originalAtivo.key) { // Só reseta as filas se o programa for diferente
    resetMusicQueue(); 
    resetIDAdvQueues();
  }
  
  log(`Preparando sequência... (Token: ${token}, Hint: ${hint}, Prog: ${programKey})`);

  let seqType = null;
  const filesToLoad = new Set();
  const job = {
    token: token,
    programKey: programKey, // Salva para qual programa este job é
    type: null,
    music: null,
    id: null,
    adv: null,
    djsolo: null,
    news: null,
    weather: null,
    narrations: { intro: null, final: null },
    endtoTrigger: null // O que esta sequência vai disparar?
  };

  try {
    // 2. Decidir o TIPO de sequência
    if (hint === 'toad') {
      seqType = chance(0.5) ? 'adv+musica' : 'adv+id+musica';
    } else if (hint === 'tonews') {
      seqType = chance(0.5) ? 'news+musica' : 'news+id+musica';
    } else if (hint === 'towheather') {
      seqType = chance(0.5) ? 'weather+musica' : 'weather+id+musica';
    } else {
      seqType = pickSequenceWeighted();
    }
    job.type = seqType;
    log('Sequência resolvida:', seqType);

    // 3. Resolver os arquivos para esse tipo (usando o 'ativo' temporário)
    if (seqType.includes('id')) {
      job.id = await nextID();
      if(job.id) filesToLoad.add(job.id);
    }
    if (seqType.includes('adv')) {
      job.adv = await nextAdv();
      if(job.adv) filesToLoad.add(job.adv);
    }
    if (seqType.includes('djsolo')) {
      job.djsolo = rand(ativo.grupoDJSolo);
      if(job.djsolo) filesToLoad.add(job.djsolo);
    }
    if (seqType.includes('news')) {
      job.news = rand(ativo.grupoWeazelNews);
      if(job.news) filesToLoad.add(job.news);
    }
     if (seqType.includes('weather')) {
      job.weather = pickWeatherFile(currentWeatherMain);
      if(job.weather) filesToLoad.add(job.weather);
    }

    if (seqType.includes('musica')) {
      job.music = await nextMusic();
      if (job.music && job.music.arquivo) {
        filesToLoad.add(job.music.arquivo);
        job.narrations.intro = resolveNarrationForZone(job.music, 'intro');
        if(job.narrations.intro) filesToLoad.add(job.narrations.intro.path);
        job.narrations.final = resolveNarrationForZone(job.music, 'final');
        if(job.narrations.final) {
          filesToLoad.add(job.narrations.final.path);
          job.endtoTrigger = job.narrations.final.subgroup; // Armazena o gatilho!
        }
      }
    }
    
    // 4. Carregar os arquivos
    const files = Array.from(filesToLoad).filter(Boolean);
    log('Carregando', files.length, 'arquivos para a sequência...');
    
    const loadPromises = files.map(path => getAudioBuffer(path, token));
    await Promise.all(loadPromises);

    // 5. Se o token ainda for válido, *retorna* o trabalho
    if (token === activePreloadToken) {
      log('Sequência pronta e carregada para', programKey);
      return job; // Retorna o job completo
    } else {
      log('Carregamento da sequência concluído, mas o token expirou (programa mudou). Descartando.');
      return null;
    }
    
  } catch (e) {
    if (String(e.message).includes('stale')) {
      log('Preparação da sequência cancelada pela troca de token.');
    } else {
      console.error('Falha ao preparar a próxima sequência:', e);
    }
    return null;
  } finally {
    // 6. Restaura o 'ativo' para o que está tocando
    ativo = PROGRAMACOES[currentProgram];
    // Não precisa resetar as filas aqui, o 'ativo' principal está correto
    isPreloadingNext = false; // Libera a flag de preload
  }
}

/**
 * Toca uma música e agenda as narrações que JÁ FORAM RESOLVIDAS.
 * *** MODIFICADO para setar o 'musicEndTime' ***
 */
async function playMusicWithResolvedNarrations(musicObj, introNarration, finalNarration) {
  if (!musicObj) {
    log('playMusicWithResolvedNarrations: Nenhum objeto de música fornecido.');
    return;
  }
  
  log('Now playing track:', musicObj.name, 'program', ativo.key);
  updateCover(musicObj.capa || DEFAULT_COVER, true);

  const musicBuf = await getAudioBuffer(musicObj.arquivo); // Pega do cache
  const musicSrc = audioCtx.createBufferSource();
  musicSrc.buffer = musicBuf;
  musicSrc.connect(musicGain);
  const musicStartAudioTime = audioCtx.currentTime;
  
  // *** ADIÇÃO (Lockout) ***
  // Define o tempo final da música para a regra de lockout
  const musicDurationSec = musicBuf.duration;
  musicEndTime = musicStartAudioTime + musicDurationSec;
  // *** FIM DA ADIÇÃO ***
  
  musicSrc.start(musicStartAudioTime);

  const scheduledPromises = [];

  // Agendar intro (se resolvida)
  if (introNarration) {
    const res = await scheduleNarrationToEndAt(
      musicStartAudioTime,
      musicObj.introStart, musicObj.introEnd,
      introNarration.path, introNarration.dur,
      { reason: 'intro' }
    );
    if (res.scheduled) scheduledPromises.push(res.promise);
  }

  // Agendar final (se resolvida)
  if (finalNarration) {
     const res = await scheduleNarrationToEndAt(
      musicStartAudioTime,
      musicObj.finalStart, musicObj.finalEnd,
      finalNarration.path, finalNarration.dur,
      { reason: 'final', subgroup: finalNarration.subgroup }
    );
    if (res.scheduled) scheduledPromises.push(res.promise);
  }

  // Esperar a música terminar
  await new Promise(resolve => musicSrc.onended = resolve);
  log('Music ended:', musicObj.name);

  // Esperar narrações agendadas terminarem
  if (scheduledPromises.length > 0) {
    try { await Promise.all(scheduledPromises); } catch (e) { console.warn('Error waiting scheduled narrs', e); }
  }
  
  updateCover(DEFAULT_COVER);
}

/**
 * Executa o trabalho da sequência que JÁ ESTÁ EM CACHE.
 * *** MODIFICADO para resetar o 'musicEndTime' ***
 */
async function executeSequence(job) {
  log('Executando sequência:', job.type);
  let didPlayMusic = false;
  
  try {
    if (job.news) {
      await playNarrationImmediate(job.news);
    }
    if (job.weather) {
      await playNarrationImmediate(job.weather);
    }
    if (job.adv) {
      log('Playing ADV', job.adv);
      updateCover(DEFAULT_COVER);
      await playBufferToDestination(await getAudioBuffer(job.adv));
    }
    if (job.id) {
      log('Playing ID', job.id);
      updateCover(DEFAULT_COVER);
      await playBufferToDestination(await getAudioBuffer(job.id));
    }
    if (job.djsolo) {
      log('Playing DJSOLO', job.djsolo);
      updateCover(DEFAULT_COVER);
      await playBufferToDestination(await getAudioBuffer(job.djsolo));
    }
    if (job.music) {
      didPlayMusic = true;
      await playMusicWithResolvedNarrations(
        job.music,
        job.narrations.intro,
        job.narrations.final
      );
    }
  } catch (e) {
    console.error('Erro ao executar sequência:', job.type, e);
  }
  
  // *** ADIÇÃO (Lockout) ***
  // Se a sequência não tocou música (ex: só ID), reseta o tempo final.
  if (!didPlayMusic) {
    musicEndTime = 0;
  }
  // *** FIM DA ADIÇÃO ***
  
  log('Sequência finalizada:', job.type);
}


/**
 * (NOVO) Helper para cancelar um preload em andamento.
 * Retorna null (para limpar a promise que o chamou).
 */
function cancelPreload(promiseToCancel) {
    if (promiseToCancel) {
        log('Cancelando preload anterior...');
        // Incrementa o token. O 'getAudioBuffer' em andamento falhará
        // ao verificar o token, cancelando o 'Promise.all'
        preloadTokenCounter++;
        activePreloadToken = token;
    }
    // Limpa as referências
    promiseToCancel = null;
    return null;
}

/**
 * (NOVO) Helper para iniciar um preload
 * Retorna a *promessa* do job.
 */
function startPreload(programKey, hint) {
    log(`Iniciando preload para ${programKey} (Hint: ${hint})...`);
    isPreloadingNext = true;
    const token = ++preloadTokenCounter;
    activePreloadToken = token;
    
    // Retorna a promessa, que será resolvida com o 'job' ou 'null'
    const promise = prepareNextSequence(token, programKey, hint);
    promise
      .catch(e => {
        // Apenas loga erros que *não* são de cancelamento
        if (!String(e.message).includes('stale')) {
            console.error(`Erro no preload (token ${token}, prog ${programKey}):`, e);
        }
      })
      .finally(() => {
        isPreloadingNext = false;
      });
      
    return promise;
}

/**
 * (NOVO) Helper para garantir que o preload da *programação atual*
 * esteja rodando, caso nenhum outro esteja.
 */
function ensureNextSequenceIsPreloading() {
    // Se um job normal já está pronto, ou carregando, não faz nada
    if (nextSequenceJob || nextSequenceJobPromise) return;
    // Se um job pendente está carregando, não faz nada
    if (isPreloadingNext) return; 

    log('Garantindo preload para a programação atual:', currentProgram);
    nextSequenceJobPromise = startPreload(currentProgram, currentFollowupHint);
    nextSequenceJobPromise
        .then(job => {
            if (job) { 
                nextSequenceJob = job;
            }
        });
}


/**
 * (MODIFICADO) Loop principal da rádio (Lógica v3 Avançada).
 */
async function mainSequenceRunner() {
  log('Main sequence runner iniciado (v3 Avançado).');
  
  // 1. Carrega a *primeira* sequência.
  log('Preparando a primeira sequência...');
  nextSequenceJobPromise = startPreload(currentProgram, null);
  nextSequenceJob = await nextSequenceJobPromise.catch(() => null);
  nextSequenceJobPromise = null; // Limpa a promessa
  
  if (!nextSequenceJob) {
    log('Falha ao carregar primeira sequência. Parando.');
    started = false;
    document.getElementById('status').textContent = 'Erro ao carregar. Tente reiniciar.';
    return;
  }

  while (started) {
    try {
      // 2. Handle lockout queue
      if (programSwitchQueuedForLockout) {
          log('Acionando troca de programa (do lockout) para:', programSwitchQueuedForLockout);
          const newProgram = programSwitchQueuedForLockout;
          programSwitchQueuedForLockout = null;
          setProgramacao(newProgram); // Chama a lógica de troca agora, fora do lockout
      }

      // 3. Decide which job to play
      let jobToPlay = null;

      // REGRA DE TROCA: Se um job PENDENTE está pronto, ele tem prioridade.
      if (pendingProgramSwitch && pendingProgramJob) {
          log(`Cometendo troca de ${currentProgram} para ${pendingProgramSwitch}`);
          currentProgram = pendingProgramSwitch;
          ativo = PROGRAMACOES[currentProgram];
          jobToPlay = pendingProgramJob; // Este é o job que vamos tocar

          // Limpa tudo que é "pendente"
          pendingProgramSwitch = null;
          pendingProgramJob = null;
          pendingProgramJobPromise = null;

          // Descarta o job "normal" que estava pronto (não o queremos mais)
          nextSequenceJob = null;
          nextSequenceJobPromise = cancelPreload(nextSequenceJobPromise);
      
      } else if (nextSequenceJob) {
          // REGRA NORMAL: Toca o job normal que estava pronto.
          jobToPlay = nextSequenceJob;
          nextSequenceJob = null;
      
      } else {
          // EMERGÊNCIA: Nenhum job está pronto. Espera o que estiver carregando.
          log('Aguardando próximo job carregar...');
          if (pendingProgramJobPromise) {
              // Estamos esperando a troca de programa carregar
              await pendingProgramJobPromise; // Isso vai popular 'pendingProgramJob'
              continue; // Reinicia o loop, a lógica de "Cometer Troca" rodará
          } else if (nextSequenceJobPromise) {
              // Estamos esperando o job normal carregar
              nextSequenceJob = await nextSequenceJobPromise.catch(() => null);
              if (nextSequenceJob) {
                  jobToPlay = nextSequenceJob;
                  nextSequenceJob = null;
              }
          } 
          
          // Se *ainda* não tivermos um job (ex: falha de rede)
          if (!jobToPlay) {
              log('Nenhum job carregando. Iniciando preload de emergência...');
              nextSequenceJobPromise = startPreload(currentProgram, currentFollowupHint);
              jobToPlay = await nextSequenceJobPromise.catch(() => null);
              nextSequenceJobPromise = null; // Limpa a promessa
              
              if (!jobToPlay) {
                  log('Falha catastrófica no preload. Reiniciando loop.');
                  await sleep(1000);
                  continue;
              }
          }
      }

      // 4. Limpa a promessa do job que vamos tocar
      if (jobToPlay.programKey === currentProgram) {
          nextSequenceJobPromise = null; 
      } else {
          pendingProgramJobPromise = null;
      }
      
      // 5. Define o HINT para o *próximo* preload
      currentFollowupHint = jobToPlay.endtoTrigger || null;

      // 6. Inicia o preload do *próximo* job (em background)
      //    (Somente se um preload não estiver já rodando)
      if (!isPreloadingNext) {
          if (pendingProgramSwitch) {
              // Um switch está pendente, mas não carregado. Inicia o carregamento.
              log('Preload (Pendente) iniciado em background...');
              pendingProgramJobPromise = startPreload(pendingProgramSwitch, currentFollowupHint);
              pendingProgramJobPromise
                  .then(job => { if (job) pendingProgramJob = job; })
                  .catch(e => console.error("Erro no preload pendente:", e));
          } else {
              // Nenhuma troca pendente. Carrega o job normal.
              log('Preload (Normal) iniciado em background...');
              nextSequenceJobPromise = startPreload(currentProgram, currentFollowupHint);
              nextSequenceJobPromise
                  .then(job => { if (job) nextSequenceJob = job; })
                  .catch(e => console.error("Erro no preload normal:", e));
          }
      }
      
      // 7. Execute o job
      await executeSequence(jobToPlay);

    } catch (e) {
      console.error('Erro crítico no mainSequenceRunner:', e);
      await sleep(1000);
    }
  }
}

/* =================== Gerenciamento de Programa (MODIFICADO v3) =================== */

function setProgramacao(name){
  if(!PROGRAMACOES[name]) { 
    log('Programação desconhecida', name); 
    return; 
  }

  // Verifica a regra de "Lockout"
  const now = audioCtx.currentTime;
  const timeLeft = musicEndTime - now;
  if (musicEndTime > 0 && timeLeft < LOCKOUT_TIME_SECONDS) {
      log(`Lockout ativo (${timeLeft.toFixed(1)}s restantes). Agendando troca para ${name}.`);
      programSwitchQueuedForLockout = name; // Armazena a *última* troca pedida
      return;
  }

  // Se não está em lockout, limpa a fila de lockout
  programSwitchQueuedForLockout = null;

  // --- REQUERIMENTO 2: Cancelar a troca ---
  if (name === currentProgram) {
    if (pendingProgramSwitch) {
        log(`Troca para ${pendingProgramSwitch} CANCELADA. Voltando para ${currentProgram}.`);
        pendingProgramSwitch = null;
        pendingProgramJobPromise = cancelPreload(pendingProgramJobPromise); // Cancela o preload PENDENTE
        pendingProgramJob = null;
        
        // Garante que o preload NORMAL volte a rodar
        ensureNextSequenceIsPreloading(); 
    } else {
        log('Programação já ativa:', name);
    }
    return;
  }
  
  // --- REQUERIMENTO 3: Mudar a troca ---
  if (pendingProgramSwitch && name === pendingProgramSwitch) {
      log('Troca para', name, 'já está em andamento.');
      return;
  }

  // --- REQUERIMENTO 1 & 3: Iniciar ou Mudar uma troca ---
  log(`Iniciando troca pendente para: ${name}. (Anterior: ${pendingProgramSwitch || 'N/A'})`);

  // Cancela qualquer preload PENDENTE anterior
  pendingProgramJobPromise = cancelPreload(pendingProgramJobPromise);
  pendingProgramJob = null;

  // *** NÃO CANCELA O 'nextSequenceJobPromise' ***
  // Ele continua em background, conforme solicitado.

  pendingProgramSwitch = name; // Define a *nova* programação pendente
  
  // Inicia o preload para a *nova* programação pendente
  pendingProgramJobPromise = startPreload(name, currentFollowupHint); // Usa o hint atual!
  pendingProgramJobPromise
    .then(job => {
        if (job) {
            pendingProgramJob = job; // Armazena o job quando estiver pronto
        }
    })
    .catch(e => console.error("Erro no preload pendente:", e));
}

window.__RADIO = window.__RADIO || {};
window.__RADIO.setProgramacao = setProgramacao;


/* =================== Initialization & start =================== */

async function init(){
  await loadDuracoesJSON();
  await fetchWeather();
  // 'ativo' é setado para o programa inicial.
  // A partir daqui, ele é gerenciado pela 'prepareNextSequence'
  ativo = PROGRAMACOES[currentProgram];
  resetMusicQueue();
  resetIDAdvQueues();
  log('Init complete — JIT mode v2+v3-fix ready (program)', currentProgram);
}

/**
 * Start Radio (v2+fix)
 */
async function startRadio(){
  if(started) return;
  started = true;
  log('Starting radio (JIT mode v2+v3-fix)');

  if(audioCtx.state === 'suspended') await audioCtx.resume();
  
  // Garantir que o init rodou
  if(Object.keys(duracoesNarracoes).length === 0) {
    log('Init não rodou, executando agora...');
    await init();
  } else {
    log('Init já concluído.');
  }

  // Aciona o loop principal (v3 Avançado)
  mainSequenceRunner().catch(e=>console.error('Erro ao iniciar mainSequenceRunner', e));
}

/* attach start button */
document.getElementById('btnStart')?.addEventListener('click', startRadio);

/* expose debug controls */
window.__RADIO.startRadio = startRadio;
window.__RADIO.loadDuracoesJSON = loadDuracoesJSON;
window.__RADIO.duracoesNarracoes = () => duracoesNarracoes;

init().catch(e=>console.error('init error', e));
log('renderer.js loaded (JIT mode v2+v3-fix) — manual start via btnStart');
