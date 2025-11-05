// renderer.js — Versão final com preload sequencial, logs detalhados e comportamento de troca de programação robusto
// - Pré-carrega NEXT somente quando CURRENT começa a tocar
// - Quando CURRENT termina, toca NEXT (já carregado) e só após iniciar NEXT pré-carrega NEXT+1
// - Troca de programação pendente (nextProgram) aplicada só no final da sequência atual (respeita últimos 30s regra)
// - Proteções contra múltiplas instâncias/cliques
// - Mantém 70% chance pra narração em intro/final e aleatoriedades existentes
// - Usa duracoes_narracoes.json para validar cabimento das narrações

/* =================== Setup AudioContext e nodes =================== */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextClass();

const DUCK_TARGET = 0.5;
const DUCK_DOWN_TIME = 0.1;
const DUCK_UP_TIME = 0.1;
const DUCK_RELEASE_DELAY_MS = 200;
const DEFAULT_COVER = 'capas/default.jpg';

const musicGain = audioCtx.createGain(); musicGain.gain.value = 1.0; musicGain.connect(audioCtx.destination);
const narrationGain = audioCtx.createGain(); narrationGain.connect(audioCtx.destination);
const analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.85;
narrationGain.connect(analyser);

/* =================== Estado global e caches =================== */
const audioBufferCache = new Map(); // path -> AudioBuffer
let duracoesNarracoes = {};
let currentCover = DEFAULT_COVER;

/* sequence tokens/state to avoid race conditions */
let sequenceLoopRunning = false;
let sequenceLoopToken = 0; // increment to cancel old loops

/* radio state (control flags) */
const radioState = {
  started: false,           // botão Iniciar já clicado
  running: false,           // loop rodando
  currentProgram: 'ivbase', // inicia default como ivbase
  nextProgram: null,        // programação pedida (pendente)
  changingProgram: false,   // se há troca pendente
  preparingNext: false,     // se está pré-carregando a próxima sequência
  preloadToken: 0           // token para invalidar preloads antigos
};

/* =================== Utils =================== */
function pad(n, len=2){ return String(n).padStart(len, '0'); }
function rand(arr){ return arr && arr.length ? arr[Math.floor(Math.random()*arr.length)] : null; }
function chance(p){ return Math.random() < p; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function log(...args){ console.log('[RADIO]', new Date().toISOString(), ...args); }
function warn(...args){ console.warn('[RADIO]', new Date().toISOString(), ...args); }
function weightedPick(items){
  const total = items.reduce((s,i)=>s+i.w,0);
  let r = Math.random()*total;
  for(const it of items){ if(r < it.w) return it.k; r -= it.w; }
  return items[0].k;
}

/* =================== Carregamento duracoes json =================== */
async function loadDuracoesJSON(){
  try{
    const resp = await fetch('duracoes_narracoes.json');
    if(!resp.ok) throw new Error('duracoes json fetch failed ' + resp.status);
    duracoesNarracoes = await resp.json();
    log('duracoes_narracoes.json carregado. entradas:', Object.keys(duracoesNarracoes).length);
  }catch(e){
    warn('Falha ao carregar duracoes_narracoes.json:', e);
    duracoesNarracoes = {};
  }
}
loadDuracoesJSON();

/* =================== getAudioBuffer (cache) =================== */
async function getAudioBuffer(path){
  if(audioBufferCache.has(path)) return audioBufferCache.get(path);
  log('getAudioBuffer -> fetching', path);
  const resp = await fetch(path);
  if(!resp.ok) throw new Error('fetch ' + resp.status + ' ' + path);
  const ab = await resp.arrayBuffer();
  const buf = await audioCtx.decodeAudioData(ab);
  audioBufferCache.set(path, buf);
  log('Buffer decodificado e cacheado:', path);
  return buf;
}

/* =================== Reproduzir buffers =================== */
async function playBufferToDestination(buf){
  return new Promise(resolve => {
    const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination);
    src.onended = () => { resolve(); };
    src.start();
  });
}
async function playBufferToNarrationGain(buf){
  return new Promise(resolve => {
    const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(narrationGain);
    src.onended = () => { resolve(); };
    src.start();
  });
}

/* =================== Ducking (reduz volume da música durante narração) =================== */
let activeNarrationsCount = 0;
let duckReleaseTimeout = null;
function onNarrationStart(){
  activeNarrationsCount++;
  if(duckReleaseTimeout){ clearTimeout(duckReleaseTimeout); duckReleaseTimeout = null; }
  const now = audioCtx.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(musicGain.gain.value, now);
  musicGain.gain.linearRampToValueAtTime(DUCK_TARGET, now + DUCK_DOWN_TIME);
  log('Duck iniciado ->', DUCK_TARGET, 'activeNarrationsCount', activeNarrationsCount);
}
function onNarrationEnd(){
  activeNarrationsCount = Math.max(0, activeNarrationsCount-1);
  log('Narration ended, activeNarrationsCount', activeNarrationsCount);
  if(activeNarrationsCount === 0){
    duckReleaseTimeout = setTimeout(() => {
      const now = audioCtx.currentTime;
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setValueAtTime(musicGain.gain.value, now);
      musicGain.gain.linearRampToValueAtTime(1.0, now + DUCK_UP_TIME);
      duckReleaseTimeout = null;
      log('Duck liberado -> 1.0');
    }, DUCK_RELEASE_DELAY_MS);
  }
}

/* =================== Cover update =================== */
function updateCover(src = DEFAULT_COVER, force=false){
  const el = document.getElementById('capa');
  if(!el) return;
  if(force || el.src.indexOf(src) === -1){
    el.src = src;
    currentCover = src;
    log('Capa atualizada ->', src);
  }
}

/* =================== Weather helpers (reaproveita sua chave) =================== */
let currentWeatherMain = 'Clear';
async function fetchWeather(){
  try{
    const key = '0cad953b1e9b3793a944d644d5193d3a';
    const resp = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Maringa,BR&appid=${key}`);
    const j = await resp.json();
    currentWeatherMain = j && j.weather && j.weather[0] && j.weather[0].main ? j.weather[0].main : 'Clear';
    log('Weather atual:', currentWeatherMain);
  }catch(e){
    warn('fetchWeather falhou:', e);
    currentWeatherMain = 'Clear';
  }
}
fetchWeather();

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

/* =================== Candidate selection via duracoes_narracoes.json =================== */
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

/* =================== Pools & programações (copiado do renderer original) =================== */
/* Aqui eu copiei as listas e pools do seu renderer original para manter compatibilidade.
   Se quiser editar os pools, edite as arrays abaixo. */

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

/* TLAD / IVTLAD pools (copiados) */
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
const tlad_grupoAdv = Array.from({length:93},(_,i)=>`adv/AD${pad(i+1,3)}.wav`);
const tlad_grupoWeazelNews = Array.from({length:125},(_,i)=>`news/NEWS_${pad(i+1,2)}.wav`);
const tlad_grupoDJSolo = Array.from({length:10},(_,i)=>`narracoes/SOLO_${pad(i+14,2)}.wav`);
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

const PROGRAMACOES = {
  ivbase: {
    key:'ivbase',
    musicasList: base_musicasList.slice(),
    narracoesGeneral: base_narracoesGeneral.slice(),
    timePools: JSON.parse(JSON.stringify(base_timePools)),
    endto: JSON.parse(JSON.stringify(base_endto)),
    grupoID: base_grupoID.slice(),
    grupoDJSolo: base_grupoDJSolo.slice(),
    grupoAdv: base_grupoAdv.slice(),
    grupoWeazelNews: base_grupoWeazelNews.slice(),
    musicIntroNarrations: Object.assign({}, base_musicIntroNarrations)
  },
  tlad: {
    key:'tlad',
    musicasList: tlad_musicasList.slice(),
    narracoesGeneral: tlad_narracoesGeneral.slice(),
    timePools: JSON.parse(JSON.stringify(tlad_timePools)),
    endto: JSON.parse(JSON.stringify(tlad_endto)),
    grupoID: base_grupoID.slice(),
    grupoDJSolo: tlad_grupoDJSolo.slice(),
    grupoAdv: tlad_grupoAdv.slice(),
    grupoWeazelNews: tlad_grupoWeazelNews.slice(),
    musicIntroNarrations: Object.assign({}, tlad_musicIntroNarrations)
  },
  ivtlad: {
    key:'ivtlad',
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

/* =================== Filas aleatórias (shuffle) =================== */
let musicQueue = [];
let idQueue = [];
let advQueue = [];

function shuffle(arr){ const a = arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function resetMusicQueue(){ musicQueue = shuffle((PROGRAMACOES[radioState.currentProgram].musicasList || []).slice()); }
function resetIDAdvQueues(){ idQueue = shuffle((PROGRAMACOES[radioState.currentProgram].grupoID || []).slice()); advQueue = shuffle((PROGRAMACOES[radioState.currentProgram].grupoAdv || []).slice()); }
async function nextMusic(){ if(!musicQueue || musicQueue.length===0) resetMusicQueue(); return musicQueue.shift(); }
async function nextID(){ if(!idQueue || idQueue.length===0) resetIDAdvQueues(); return idQueue.shift(); }
async function nextAdv(){ if(!advQueue || advQueue.length===0) resetIDAdvQueues(); return advQueue.shift(); }

/* =================== Build concrete sequence (respeita 70% chance e ENDTO) =================== */
async function buildConcreteSequenceForProgram(programKey, overrideEndto=null){
  const prog = PROGRAMACOES[programKey];
  if(!prog) return null;
  // weighted pool similar to original
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

  // build in order (like previous implementation)
  if(seqKey.startsWith('adv')){
    const adv = await nextAdv();
    if(adv) seq.parts.push({type:'adv', path:adv});
    if(seqKey === 'adv+id+musica'){
      const id2 = await nextID(); if(id2) seq.parts.push({type:'id', path:id2});
    }
  } else if(seqKey.startsWith('id')){
    const id = await nextID(); if(id) seq.parts.push({type:'id', path:id});
  } else if(seqKey === 'djsolo+musica'){
    const d = pickFrom(prog.grupoDJSolo || []); if(d) seq.parts.push({type:'djsolo', path:d});
  }

  if(seqKey === 'id+djsolo+musica'){
    const d = pickFrom(prog.grupoDJSolo || []); if(d) seq.parts.push({type:'djsolo', path:d});
  }

  // music part
  if(seqKey.includes('musica')){
    const musicObj = await nextMusic();
    if(musicObj){
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
  log('buildConcreteSequenceForProgram ->', programKey, 'seqKey', seq.seqKey, 'parts', seq.parts.map(p=>p.type));
  return seq;
}

/* =================== Preload EXATO da sequence (sem priorização) ===================
   Este preload NÃO é iniciado até a sequência atual começar a tocar (por design do usuário).
   Usa token de preload para invalidar resultados antigos.
*/
async function preloadExactSequence(sequence, preloadToken){
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
    const wf = pickWeatherFile(currentWeatherMain); if(wf) files.add(wf);
  }

  const list = Array.from(files);
  log('[PRELOAD] token', preloadToken, '-> iniciando preload de', list.length, 'arquivos:', list);
  for(const f of list){
    if(preloadToken !== radioState.preloadToken){ log('[PRELOAD] token stale, abortando preload atual:', preloadToken); throw new Error('preload_token_stale'); }
    if(audioBufferCache.has(f)){ log('[PRELOAD] já no cache:', f); continue; }
    try{
      await getAudioBuffer(f);
      log('[PRELOAD] carregado:', f);
    }catch(e){
      warn('[PRELOAD] falha ao carregar', f, e);
      // não interrompe o loop: tentamos carregar todos; se algo faltar, o loop esperará
    }
  }
  log('[PRELOAD] token', preloadToken, '-> preload concluído para sequência');
  return {loaded:list};
}

/* =================== Play prepared sequence (usa buffers no cache) =================== */
async function playPreparedSequence(sequence){
  if(!sequence) return;
  log('[PLAY_SEQUENCE] Iniciando sequência:', sequence.seqKey, 'parts:', sequence.parts.map(p=>p.type));
  updateCover(DEFAULT_COVER);

  for(const part of sequence.parts){
    if(part.type === 'id' || part.type === 'adv' || part.type === 'djsolo' || part.type === 'news' || part.type === 'weather'){
      try{
        const buf = await getAudioBuffer(part.path);
        log('[PLAY] Tocando', part.type, part.path);
        await playBufferToDestination(buf);
        log('[PLAY] Finalizou', part.type, part.path);
      }catch(e){
        warn('[PLAY] Erro ao tocar', part.path, e);
      }
    } else if(part.type === 'musica'){
      await playMusicWithChosenNarrations(part.music, part.narrations || []);
    }
  }
  log('[PLAY_SEQUENCE] Sequência finalizada:', sequence.seqKey);
}

/* =================== playMusicWithChosenNarrations (schedules narrations já escolhidas) =================== */
async function playMusicWithChosenNarrations(musicObj, narrationList){
  if(!musicObj) return;
  log('[PLAY_MUSIC] Iniciando música:', musicObj.name, musicObj.arquivo);
  updateCover(musicObj.capa || DEFAULT_COVER, true);

  const musicBuf = await getAudioBuffer(musicObj.arquivo);
  const musicSrc = audioCtx.createBufferSource();
  musicSrc.buffer = musicBuf;
  musicSrc.connect(musicGain);
  const startAudioTime = audioCtx.currentTime;
  musicSrc.start(startAudioTime);
  log('[PLAY_MUSIC] music started at audioTime', startAudioTime.toFixed(3), 'track', musicObj.name);

  const scheduledPromises = [];
  let endtoScheduled = false;
  let endtoSubgroup = null;

  for(const nar of narrationList){
    if(nar.when === 'intro'){
      const zoneStartMs = musicObj.introStart;
      const zoneEndMs = musicObj.introEnd;
      const res = await scheduleNarrationToEndAt(startAudioTime, zoneStartMs, zoneEndMs, nar.path, nar.dur, {when:'intro', pool:nar.pool});
      if(res.scheduled) scheduledPromises.push(res.promise);
    } else if(nar.when === 'final'){
      const zoneStartMs = musicObj.finalStart;
      const zoneEndMs = musicObj.finalEnd;
      const res = await scheduleNarrationToEndAt(startAudioTime, zoneStartMs, zoneEndMs, nar.path, nar.dur, {when:'final', pool:nar.pool, subgroup:nar.subgroup});
      if(res.scheduled){
        scheduledPromises.push(res.promise);
        if(nar.pool === 'endto' && nar.subgroup){ endtoScheduled = true; endtoSubgroup = nar.subgroup; }
      }
    }
  }

  // Wait for music to end
  await new Promise(resolve => musicSrc.onended = resolve);
  log('[PLAY_MUSIC] música terminou:', musicObj.name);

  // Wait for scheduled narrations to finish if still running
  if(scheduledPromises.length > 0){
    try{ await Promise.all(scheduledPromises); }catch(e){ warn('[PLAY_MUSIC] erro aguardando narracoes', e); }
  }

  // If had ENDTO, handle followup (this may call runSequenceImmediately and such)
  if(endtoScheduled && endtoSubgroup){
    log('[ENDTO] endtoScheduled tipo', endtoSubgroup);
    // note: handleEndtoFollowupQueued will use current PROGRAMACOES pools (respecting any nextProgram applied when sequence finished)
    await handleEndtoFollowupQueued(endtoSubgroup);
  }

  updateCover(DEFAULT_COVER);
}

/* =================== scheduleNarrationToEndAt =================== */
async function scheduleNarrationToEndAt(musicStartAudioTime, zoneStartMs, zoneEndMs, candidatePath, candidateDurMs, meta={}){
  if(!candidatePath) return {scheduled:false};
  const durMs = candidateDurMs;
  let startOffsetSec = (zoneEndMs - durMs) / 1000;
  if(startOffsetSec < zoneStartMs / 1000) startOffsetSec = zoneStartMs / 1000;
  const startAudioTime = musicStartAudioTime + startOffsetSec;

  try{
    const buf = await getAudioBuffer(candidatePath);
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(narrationGain);

    // schedule duck lead
    const now = audioCtx.currentTime;
    const leadMs = 40;
    const duckDelayMs = Math.max(0, (startAudioTime - now) * 1000 - leadMs);
    if(duckDelayMs > 0){
      setTimeout(()=>{ onNarrationStart(); }, duckDelayMs);
    } else {
      requestAnimationFrame(()=>onNarrationStart());
    }

    try { src.start(startAudioTime); } catch(e){ src.start(); }

    const p = new Promise(resolve => {
      src.onended = () => { onNarrationEnd(); resolve({path:candidatePath, meta}); };
    });
    log('[SCHEDULE_NARR] scheduled', candidatePath, 'startAudioTime', startAudioTime.toFixed(3));
    return {scheduled:true, promise:p, chosen:candidatePath, dur:durMs, meta};
  }catch(e){
    warn('[SCHEDULE_NARR] failed', candidatePath, e);
    return {scheduled:false};
  }
}

/* =================== ENDTO followup handler (simple behaviors) =================== */
async function handleEndtoFollowupQueued(subgroup){
  if(!subgroup) return;
  log('[ENDTO_FOLLOWUP] executing subgroup', subgroup, 'program now', radioState.currentProgram);
  updateCover(DEFAULT_COVER);
  const prog = PROGRAMACOES[radioState.currentProgram];

  if(subgroup === 'toad'){
    const pick = Math.random() < 0.5 ? 'adv+musica' : 'adv+id+musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'tonews'){
    const pool = prog.grupoWeazelNews || [];
    const item = pool.length ? rand(pool) : null;
    if(item) await playNarrationImmediate(item);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  } else if(subgroup === 'towheather'){
    const weatherFile = pickWeatherFile(currentWeatherMain);
    if(weatherFile) await playNarrationImmediate(weatherFile);
    const pick = Math.random() < 0.5 ? 'id+musica' : 'musica';
    await runSequenceImmediately(pick);
  }
}

/* play narration immediate */
async function playNarrationImmediate(path){
  try{
    const buf = await getAudioBuffer(path);
    requestAnimationFrame(()=>onNarrationStart());
    await playBufferToNarrationGain(buf);
    onNarrationEnd();
  }catch(e){
    warn('[PLAY_NARR_IMMEDIATE] error', path, e);
  }
}

/* runSequenceImmediately fallback (used by ENDTO flows) */
async function runSequenceImmediately(seq){
  log('[RUN_IMMEDIATE] ', seq, 'program', radioState.currentProgram);
  const prog = PROGRAMACOES[radioState.currentProgram];
  switch(seq){
    case 'adv+musica': {
      const adv = await nextAdv(); if(adv) { await playBufferToDestination(await getAudioBuffer(adv)); }
      const m = await nextMusic(); if(m) { await playMusicWithChosenNarrations(m, []); }
      break;
    }
    case 'adv+id+musica': {
      const adv = await nextAdv(); if(adv) await playBufferToDestination(await getAudioBuffer(adv));
      const id = await nextID(); if(id) await playBufferToDestination(await getAudioBuffer(id));
      const m = await nextMusic(); if(m) await playMusicWithChosenNarrations(m, []);
      break;
    }
    case 'id+musica': {
      const id = await nextID(); if(id) await playBufferToDestination(await getAudioBuffer(id));
      const m = await nextMusic(); if(m) await playMusicWithChosenNarrations(m, []);
      break;
    }
    case 'id+djsolo+musica': {
      const id = await nextID(); if(id) await playBufferToDestination(await getAudioBuffer(id));
      const d = rand(PROGRAMACOES[radioState.currentProgram].grupoDJSolo); if(d) await playBufferToDestination(await getAudioBuffer(d));
      const m = await nextMusic(); if(m) await playMusicWithChosenNarrations(m, []);
      break;
    }
    case 'djsolo+musica': {
      const d = rand(PROGRAMACOES[radioState.currentProgram].grupoDJSolo); if(d) await playBufferToDestination(await getAudioBuffer(d));
      const m = await nextMusic(); if(m) await playMusicWithChosenNarrations(m, []);
      break;
    }
    case 'musica': {
      const m = await nextMusic(); if(m) await playMusicWithChosenNarrations(m, []);
      break;
    }
    default: warn('[RUN_IMMEDIATE] unknown sequence', seq);
  }
}

/* =================== Prune cache: mantém apenas arquivos necessários para current e next sequence =================== */
function pruneCacheKeepSequences(currentSeq, nextSeq){
  try{
    const keep = new Set();
    const addSeq = (s) => {
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
    addSeq(currentSeq); addSeq(nextSeq);
    // limpar tudo que não está no keep
    for(const k of Array.from(audioBufferCache.keys())){
      if(!keep.has(k)){ audioBufferCache.delete(k); log('[PRUNE] Removed from cache:', k); }
    }
  }catch(e){
    warn('[PRUNE] erro', e);
  }
}

/* =================== Loop principal (sequencial) ===================
   - Quando a loop inicia, constrói preparedCurrent (previamente já construído no início)
   - Ao INICIAR preparedCurrent (inicio de reprodução), dispara preload do NEXT (apenas enquanto current toca)
   - Ao finalizar current:
       - se next não carregado -> espera até carregar (per your requirement: wait, don't play partial)
       - se nextProgram pendente e aplicável -> use nextProgram para construir next sequence antes de tocar next
       - toca next (já carregado)
   - Após iniciar next, inicia preload do nextNext, e o ciclo segue
*/
async function sequenceLoopMain(){
  if(sequenceLoopRunning) { log('[LOOP] Já existe um loop rodando. Ignorando nova chamada.'); return; }
  sequenceLoopRunning = true;
  sequenceLoopToken++; const myToken = sequenceLoopToken;
  radioState.running = true;
  log('[LOOP] sequenceLoopMain iniciado. token', myToken, 'program inicial', radioState.currentProgram);

  // inicializar filas para a programação atual
  resetMusicQueue(); resetIDAdvQueues();

  try{
    // prepare primeira sequência (mas NÃO iniciar preload do next ainda até que a sequência COMEÇE a tocar)
    let preparedCurrent = await buildConcreteSequenceForProgram(radioState.currentProgram, null);
    log('[LOOP] preparedCurrent construída:', preparedCurrent ? preparedCurrent.seqKey : 'NULL');

    // Preload for the preparedCurrent BEFORE starting to play it (we must have current available)
    radioState.preloadToken++;
    const currentPreloadToken = radioState.preloadToken;
    try{
      log('[LOOP] Carregando arquivos da preparedCurrent antes de tocar (token)', currentPreloadToken);
      await preloadExactSequence(preparedCurrent, currentPreloadToken);
    }catch(e){
      if(String(e).includes('preload_token_stale')) { log('[LOOP] preload cancelled for preparedCurrent (token stale)'); sequenceLoopRunning=false; radioState.running=false; return; }
      else warn('[LOOP] Erro carregando preparedCurrent', e);
    }

    // Now start the loop
    let preparedNext = null;
    let nextPreloadPromise = null;

    while(sequenceLoopToken === myToken){
      // 1) Start playing preparedCurrent. When it starts, we will start preloading preparedNext.
      log('[LOOP] Iniciando reprodução de preparedCurrent:', preparedCurrent.seqKey);
      // start pre-build of preparedNext (but DO NOT preload yet — we'll preload only when current actually starts)
      // Build preparedNext based on current preparedCurrent.endtoRequest (so respects ENDTO)
      preparedNext = await buildConcreteSequenceForProgram(radioState.nextProgram || radioState.currentProgram, preparedCurrent.endtoRequest || null);
      log('[LOOP] preparedNext construída (pronta para preload após current start):', preparedNext ? preparedNext.seqKey : 'NULL');

      // Play current in background, but we need to start preloading next AS SOON AS playback begins.
      // We'll implement playPreparedSequence that returns a promise resolving after fully finished.
      // To coordinate: before calling playPreparedSequence we set up a microtask to start preload after small delay (when audioCtx actually starts)
      // Simpler: call playPreparedSequence but start preloadExactSequence immediately after a small setTimeout(0) — the audio already started in playPreparedSequence.
      // To ensure preload begins "while current plays", we'll start it right after playPreparedSequence returns an internal "started" signal.
      // So we will modify playPreparedSequence to optionally fire an event "onStarted" — but for simplicity, wrap: call playPreparedSequenceStart which returns {playPromise, startedPromise}.
      const playStarter = startPlayingPreparedSequenceWithStartSignal(preparedCurrent);
      // Wait until playback has actually started (ensures we begin preloading while it's playing)
      await playStarter.startedPromise;
      log('[LOOP] confirmed preparedCurrent started -> iniciando preload da preparedNext (token)', radioState.preloadToken+1);
      // start preload for preparedNext now (only once)
      radioState.preloadToken++;
      const preloadTokenForNext = radioState.preloadToken;
      radioState.preparingNext = true;
      nextPreloadPromise = preloadExactSequence(preparedNext, preloadTokenForNext).catch(err => {
        if(String(err).includes('preload_token_stale')) { log('[LOOP] next preload cancelled (token stale)'); }
        else warn('[LOOP] next preload failed', err);
      }).finally(()=>{ radioState.preparingNext = false; });
      // Now wait for the full playPromise (current completes)
      await playStarter.playPromise;
      log('[LOOP] preparedCurrent finished playback');

      // At this point, we must decide whether to apply program change:
      // If user has requested a nextProgram different from current, we apply it now before starting preparedNext,
      // except special rule: if change requested <30s left of the music when requested, we accept latest change but we start loading only after next sequence begins (we implemented by postponing preload start).
      // We need to check radioState.nextProgram vs radioState.currentProgram.
      if(radioState.nextProgram && radioState.nextProgram !== radioState.currentProgram){
        log('[LOOP] Aplicando troca de programação pendente. nextProgram=', radioState.nextProgram, 'old currentProgram=', radioState.currentProgram);
        // apply now: set currentProgram to nextProgram
        radioState.currentProgram = radioState.nextProgram;
        radioState.nextProgram = null;
        radioState.changingProgram = false;
        // rebuild queues for the new program
        resetMusicQueue(); resetIDAdvQueues();
        // IMPORTANT: preparedNext was built earlier in loop using (radioState.nextProgram || radioState.currentProgram).
        // We must ensure preparedNext corresponds to the program we want to play next.
        // If preparedNext was built for old program, we should rebuild preparedNext for the new program.
        // So: if preparedNext.programKey differs, rebuild.
        // But we built preparedNext using radioState.nextProgram || radioState.currentProgram at build time; to be safe, rebuild preparedNext now.
        log('[LOOP] Rebuilding preparedNext para a nova programação aplicada');
        preparedNext = await buildConcreteSequenceForProgram(radioState.currentProgram, preparedCurrent.endtoRequest || null);
        // Start its preload (we may have preloaded previous preparedNext — we will prune caches soon)
        radioState.preloadToken++;
        const newPreloadToken = radioState.preloadToken;
        try{ await preloadExactSequence(preparedNext, newPreloadToken); }catch(e){ if(String(e).includes('preload_token_stale')) log('[LOOP] preload aborted token stale'); else warn('[LOOP] preload erro ao rebuild preparedNext', e); }
      } else {
        // No program change applied: ensure preparedNext preload finished (if not, wait)
        if(nextPreloadPromise){
          log('[LOOP] aguardando preload da preparedNext completar antes de tocar (se necessário)');
          try{ await nextPreloadPromise; }catch(e){ /* já logado */ }
        } else {
          log('[LOOP] nextPreloadPromise não iniciado? (isso não deveria ocorrer)');
        }
      }

      // Before starting preparedNext, prune cache to keep only current/next
      pruneCacheKeepSequences(preparedCurrent, preparedNext);

      // Rotate: preparedCurrent = preparedNext; then null preparedNext for next iteration
      preparedCurrent = preparedNext;
      preparedNext = null;

      // Start playing preparedCurrent (i.e., the one we preloaded). But per requested behavior, we must START its playback immediately in next loop iteration.
      // However, loop continues — since while loop will restart, we'll build new preparedNext then start its preload only after current starts.
      // Continue loop.
      // But we must check token still valid
      if(sequenceLoopToken !== myToken){
        log('[LOOP] token changed, saindo loop');
        break;
      }
    } // end while
  }catch(e){
    warn('[LOOP] erro inesperado no sequenceLoopMain', e);
  }finally{
    sequenceLoopRunning = false;
    radioState.running = false;
    log('[LOOP] sequenceLoopMain finalizado');
  }
}

/* Helper que inicia a reprodução e retorna: { startedPromise, playPromise }.
   startedPromise resolve assim que a música/parte realmente começou (microtask), playPromise resolve quando tudo da sequência terminar.
*/
function startPlayingPreparedSequenceWithStartSignal(sequence){
  const startedDeferred = {};
  const playDeferred = {};

  startedDeferred.promise = new Promise(resolve => { startedDeferred.resolve = resolve; });
  playDeferred.promise = new Promise(resolve => { playDeferred.resolve = resolve; });

  // We will play sequence in microtasks and signal started as soon as the first audio node starts.
  (async () => {
    try{
      log('[PLAY_STARTER] iniciando execução de sequência e coletando sinal de "started"');
      // We'll instrument playPreparedSequence to emit an event when first sound starts.
      // Simpler: implement small inline player here to detect first start.
      let firstStarted = false;
      // iterate parts
      for(const part of sequence.parts){
        if(part.type === 'id' || part.type === 'adv' || part.type === 'djsolo' || part.type === 'news' || part.type === 'weather'){
          try{
            const buf = await getAudioBuffer(part.path);
            // create source
            const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination);
            if(!firstStarted){ firstStarted = true; startedDeferred.resolve(); log('[PLAY_STARTER] primeira parte começou:', part.type, part.path); }
            await new Promise(res => { src.onended = res; src.start(); });
            log('[PLAY_STARTER] parte finalizada:', part.type, part.path);
          }catch(e){
            warn('[PLAY_STARTER] erro tocando parte', part, e);
          }
        } else if(part.type === 'musica'){
          // music: schedule narrations and detect start
          try{
            const musicBuf = await getAudioBuffer(part.path);
            const src = audioCtx.createBufferSource(); src.buffer = musicBuf; src.connect(musicGain);
            const startTime = audioCtx.currentTime;
            src.start(startTime);
            if(!firstStarted){ firstStarted = true; startedDeferred.resolve(); log('[PLAY_STARTER] musica começou:', part.music.name); }
            // schedule narrations
            const scheduled = [];
            for(const nar of (part.narrations || [])){
              if(nar.when === 'intro'){
                const zoneStartMs = part.music.introStart;
                const zoneEndMs = part.music.introEnd;
                const res = await scheduleNarrationToEndAt(startTime, zoneStartMs, zoneEndMs, nar.path, nar.dur, {when:'intro'});
                if(res.scheduled) scheduled.push(res.promise);
              } else if(nar.when === 'final'){
                const zoneStartMs = part.music.finalStart;
                const zoneEndMs = part.music.finalEnd;
                const res = await scheduleNarrationToEndAt(startTime, zoneStartMs, zoneEndMs, nar.path, nar.dur, {when:'final', subgroup:nar.subgroup});
                if(res.scheduled) scheduled.push(res.promise);
              }
            }
            await new Promise(res => { src.onended = res; });
            log('[PLAY_STARTER] musica terminou:', part.music.name);
            if(scheduled.length) try{ await Promise.all(scheduled); }catch(e){ warn('[PLAY_STARTER] erro aguardando narrs', e); }
          }catch(e){
            warn('[PLAY_STARTER] erro tocando musica', e);
          }
        }
      }
    }catch(e){
      warn('[PLAY_STARTER] erro no player inline', e);
    }finally{
      playDeferred.resolve();
    }
  })();

  return { startedPromise: startedDeferred.promise, playPromise: playDeferred.promise };
}

/* =================== setProgramacao (chamada pelas thumbs) ===================
   - Antes de startRadio: muda currentProgram somente (não inicia preloads)
   - Depois de startRadio: registra nextProgram pendente; se igual ao currentProgram (ou igual ao already pending) ignora.
*/
function setProgramacao(key){
  if(!PROGRAMACOES[key]) { warn('setProgramacao: programa desconhecido', key); return; }
  if(!radioState.started){
    radioState.currentProgram = key;
    radioState.nextProgram = null;
    radioState.changingProgram = false;
    log('[SET_PROGRAM] Antes de iniciar rádio -> programacao atual agora é', key);
    // update UI active thumb
    return;
  }
  // after started: handle pending switch logic
  // If the clicked program is the same as currentProgram -> ignore
  if(key === radioState.currentProgram){
    log('[SET_PROGRAM] clicado na programação atual (ignorar):', key);
    // If there was a pending nextProgram equal to currentProgram (i.e. user canceled), clear it
    if(radioState.nextProgram && radioState.nextProgram !== radioState.currentProgram) { /* do nothing */ }
    return;
  }
  // If clicked program is same as pending nextProgram -> ignore
  if(radioState.nextProgram === key){
    log('[SET_PROGRAM] clicado na programação que já está pendente (ignorar):', key);
    return;
  }
  // If clicked program equals the program that is currently loading as next? We track via radioState.preparingNext if needed.
  // Set it as pending; the loop will apply it at end of current sequence.
  log('[SET_PROGRAM] registrando troca pendente ->', key, ' (vai aplicar quando a sequência atual terminar)');
  radioState.nextProgram = key;
  radioState.changingProgram = true;
}

/* =================== startRadio (botão) =================== */
async function startRadio(){
  if(radioState.started){
    log('[START] Rádio já iniciada. Ignorando novo start.');
    return;
  }
  radioState.started = true;
  // ensure initial program default is ivbase (unless user selected before)
  if(!radioState.currentProgram) radioState.currentProgram = 'ivbase';
  log('[START] Iniciando rádio. Programacao inicial:', radioState.currentProgram);
  // disable start button visually (if exists)
  const btn = document.getElementById('btnStart'); if(btn) { btn.disabled = true; btn.textContent = 'Rádio em transmissão'; }
  // set up UI program thumbs to call setProgramacao (they already do in index.html)
  // Start the sequence loop (single instance)
  setTimeout(()=>{ sequenceLoopMain().catch(e=>warn('[START] sequenceLoopMain erro', e)); }, 20);
}

/* Expose API for index.html */
window.__RADIO = window.__RADIO || {};
window.__RADIO.startRadio = startRadio;
window.__RADIO.setProgramacao = setProgramacao;

/* Expose debug helpers */
window.__RADIO._debug = {
  audioCtx,
  audioBufferCache,
  radioState,
  sequenceLoopRunning: () => sequenceLoopRunning
};

log('renderer.js carregado. Pronto para iniciar a rádio. Botão "Iniciar Rádio" deve ser o gatilho.');
