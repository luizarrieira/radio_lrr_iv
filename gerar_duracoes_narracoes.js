/**
 * Script Node.js para gerar JSON com as durações (em milissegundos)
 * de todos os arquivos .wav dentro da pasta narracoes/
 *
 * Uso:
 *   1. Instale dependência ->  npm install music-metadata
 *   2. Execute ->  node gerar_duracoes_narracoes.js
 *   3. Será criado o arquivo duracoes_narracoes.json
 */

const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

const pastaNarracoes = path.join(__dirname, 'narracoes');
const saidaJSON = path.join(__dirname, 'duracoes_narracoes.json');

async function gerarDuracoes() {
  const arquivos = fs.readdirSync(pastaNarracoes).filter(f => f.toLowerCase().endsWith('.wav'));
  const duracoes = {};

  console.log(`🔍 Lendo ${arquivos.length} arquivos da pasta narracoes/...\n`);

  for (const arquivo of arquivos) {
    const caminho = path.join(pastaNarracoes, arquivo);
    try {
      const metadata = await mm.parseFile(caminho);
      const duracaoSeg = metadata.format.duration;
      const duracaoMs = Math.round(duracaoSeg * 1000);
      duracoes[arquivo] = duracaoMs;
      console.log(`✅ ${arquivo} → ${duracaoMs} ms`);
    } catch (err) {
      console.warn(`⚠️  Erro ao ler "${arquivo}":`, err.message);
    }
  }

  fs.writeFileSync(saidaJSON, JSON.stringify(duracoes, null, 2), 'utf-8');
  console.log(`\n💾 Arquivo salvo em: ${saidaJSON}`);
}

gerarDuracoes().catch(err => console.error('Erro geral:', err));
