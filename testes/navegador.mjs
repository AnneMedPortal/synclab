// Prova do HTML exportado num navegador de verdade.
//
// Verifica as tres exigencias inegociaveis da especificacao:
//   1. o aluno ve apenas a linha da legenda (sem player, botao ou fundo);
//   2. o audio toca sozinho;
//   3. a caixa e pequena, do tamanho do texto.
//
// Depende do Playwright, que e opcional -- a suite principal
// (testes/executar.mjs) roda sem nenhuma dependencia. Para usar este:
//
//   npm install --no-save playwright && npx playwright install chromium
//   node testes/navegador.mjs
//
// Se o Chromium instalado nao for o que o Playwright espera, aponte o binario:
//   SYNCLAB_CHROMIUM=/caminho/para/chrome node testes/navegador.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  console.log('Playwright nao esta instalado; esta prova foi pulada.');
  console.log('Para rodar: npm install --no-save playwright && npx playwright install chromium');
  process.exit(0);
}

const { gerarTrechoInline, gerarDocumentoCompleto } = await import('../src/js/gerador.js');
const L = await import('../src/js/legendas.js');

const AREA = fs.mkdtempSync(path.join(os.tmpdir(), 'synclab-'));
const EXEC = process.env.SYNCLAB_CHROMIUM || undefined;

// --- fixture: 6 s de silencio em MPEG-1 Layer III -------------------------
// Quadros de 417 bytes com cabecalho valido e dados zerados decodificam como
// silencio. Evita depender de ffmpeg so para ter um arquivo de teste.
function mp3DeSilencio(segundos) {
  const TAM = 417;
  const quadros = Math.round((segundos * 44100) / 1152);
  const buf = new Uint8Array(TAM * quadros);
  for (let i = 0; i < quadros; i++) {
    const o = i * TAM;
    buf[o] = 0xff; buf[o + 1] = 0xfb; buf[o + 2] = 0x90; buf[o + 3] = 0x00;
  }
  return buf;
}

const mp3 = mp3DeSilencio(6);
const frase = 'Olá turma. Hoje falamos de infarto agudo do miocárdio. Atenção ao ECG de doze derivações.';
const chars = frase.split('');
const passo = 6 / chars.length;
const cues = L.segmentar(
  L.palavrasDeAlinhamento({
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * passo),
    character_end_times_seconds: chars.map((_, i) => (i + 1) * passo)
  }),
  { maxCaracteresPorLinha: 32, maxLinhas: 2, pausaMinima: 0.35 }
);

const dados = {
  nomeBase: 'prova',
  cues,
  aparencia: { tamanho: 30, posicaoVertical: 'base', distanciaBorda: 40, mostrarTarja: true },
  audio: { modo: 'embutido', bytes: mp3 },
  diagnostico: true
};

const arq = (n) => path.join(AREA, n);
fs.writeFileSync(arq('doc.html'), gerarDocumentoCompleto(dados).conteudo);
fs.writeFileSync(arq('limpa.html'), gerarDocumentoCompleto({ ...dados, diagnostico: false }).conteudo);

// O trecho inline tem de funcionar colado numa pagina que ja existe, que e
// exatamente a situacao do Genially.
fs.writeFileSync(arq('slide.html'), `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Slide simulado</title>
<style>body{margin:0;background:linear-gradient(135deg,#2c5364,#203a43);height:100vh;}
h1{color:#fff;font:600 28px system-ui;padding:40px;}</style></head>
<body><h1>Slide do Genially (simulado)</h1>
${gerarTrechoInline(dados).conteudo}
</body></html>`);

const medir = () => {
  const audio = document.querySelector('[data-synclab="audio"]');
  const caixa = document.querySelector('[data-synclab="caixa"]');
  const raiz = document.querySelector('[data-synclab="raiz"]');
  const r = caixa.getBoundingClientRect();
  return {
    tocando: !audio.paused && !audio.ended,
    mudo: audio.muted,
    posicao: audio.currentTime,
    duracao: audio.duration,
    loop: audio.loop,
    terminou: audio.ended,
    visivel: caixa.getAttribute('data-visivel') === '1',
    texto: caixa.textContent,
    larguraCaixa: Math.round(r.width),
    larguraJanela: window.innerWidth,
    fundoRaiz: getComputedStyle(raiz).backgroundColor,
    controles: audio.controls,
    // Nada alem da legenda (e do painel) pode ocupar area na tela.
    comArea: Array.from(document.querySelectorAll('[data-synclab]'))
      .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 2 && b.height > 2; })
      .map((el) => el.getAttribute('data-synclab'))
  };
};

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  console.log('  ' + (condicao ? 'ok   ' : 'FALHA') + ' ' + descricao + (detalhe ? '  [' + detalhe + ']' : ''));
  if (!condicao) falhas++;
}

async function abrir(arquivo, args) {
  const navegador = await chromium.launch({ executablePath: EXEC, args });
  const pagina = await navegador.newPage();
  const erros = [];
  pagina.on('pageerror', (e) => erros.push(String(e)));
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  await pagina.goto('file://' + arq(arquivo));
  return { navegador, pagina, erros };
}

// ---------------------------------------------------------------------------
console.log('\nA) autoplay permitido pelo navegador');
{
  const { navegador, pagina, erros } = await abrir('doc.html', ['--autoplay-policy=no-user-gesture-required']);

  // Espera o inicio real da reproducao em vez de um tempo fixo: assim a
  // primeira medicao cai dentro do primeiro bloco, que e curto.
  await pagina.waitForFunction(() => {
    const a = document.querySelector('[data-synclab="audio"]');
    return a && !a.paused && a.currentTime > 0;
  }, null, { timeout: 8000 });
  const m = await pagina.evaluate(medir);

  conferir('o audio comeca sozinho, sem gesto nenhum', m.tocando && !m.mudo);
  conferir('a legenda aparece sincronizada', m.visivel && m.texto.length > 0, JSON.stringify(m.texto));
  conferir('a caixa abraca o texto, nao vira faixa larga',
    m.larguraCaixa < m.larguraJanela * 0.5, m.larguraCaixa + 'px de ' + m.larguraJanela + 'px');
  conferir('o fundo em volta e transparente', m.fundoRaiz === 'rgba(0, 0, 0, 0)', m.fundoRaiz);
  conferir('nenhum controle de player visivel', m.controles === false);
  conferir('sem loop', m.loop === false);

  // A legenda tem de trocar sozinha ao longo do audio. A amostragem precisa
  // ser mais rapida que o bloco mais curto, senao a prova perde blocos que
  // apareceram de verdade.
  const vistos = new Set([m.texto]);
  for (let i = 0; i < 35; i++) {
    await pagina.waitForTimeout(200);
    const atual = await pagina.evaluate(medir);
    if (atual.visivel) vistos.add(atual.texto);
  }
  conferir('a legenda troca de bloco acompanhando o audio', vistos.size >= cues.length,
    vistos.size + ' textos distintos, ' + cues.length + ' blocos');

  await pagina.waitForTimeout(1800);
  const fim = await pagina.evaluate(medir);
  conferir('toca uma vez e para no fim', fim.terminou && !fim.tocando);
  conferir('a legenda some quando o audio acaba', !fim.visivel);
  conferir('nenhum erro de console', erros.length === 0, erros.join(' | '));
  await navegador.close();
}

// ---------------------------------------------------------------------------
console.log('\nB) autoplay bloqueado, trecho inline dentro de um slide');
{
  const { navegador, pagina, erros } = await abrir('slide.html', []);
  await pagina.waitForTimeout(1500);
  const bloqueado = await pagina.evaluate(medir);

  // Chromium headless bloqueia ate o modo mudo, que num navegador real passa.
  // O que da para provar aqui e que o plano B foi acionado e que a legenda
  // continua de pe -- e que um gesto do aluno recupera tudo.
  conferir('o plano B mudo foi acionado', bloqueado.mudo === true);
  conferir('a legenda aparece mesmo com o audio barrado', bloqueado.visivel === true);

  await pagina.mouse.click(400, 300);
  await pagina.waitForTimeout(900);
  const depois = await pagina.evaluate(medir);
  conferir('um gesto do aluno libera o som', depois.tocando && !depois.mudo);
  conferir('a sincronia foi preservada', depois.posicao > 0, depois.posicao.toFixed(2) + 's');

  const diag = await pagina.evaluate(() => {
    const p = document.querySelector('[data-synclab="diagnostico"]');
    return p ? p.innerText : '';
  });
  conferir('o painel informa o contexto de pagina/iframe', /contexto:/.test(diag));
  conferir('o painel informa quantas legendas carregaram', /legendas carregadas: \d+/.test(diag));
  conferir('o painel para de acusar erro depois que resolve', /erro: nenhum/.test(diag),
    (diag.split('\n').find((l) => l.startsWith('erro:')) || '').slice(0, 60));
  conferir('nenhum erro de console', erros.length === 0, erros.join(' | '));
  await navegador.close();
}

// ---------------------------------------------------------------------------
console.log('\nC) versao final do aluno, com o diagnostico desligado');
{
  const { navegador, pagina, erros } = await abrir('limpa.html', ['--autoplay-policy=no-user-gesture-required']);
  await pagina.waitForTimeout(900);
  const m = await pagina.evaluate(medir);
  const temPainel = await pagina.evaluate(() => !!document.querySelector('[data-synclab="diagnostico"]'));

  conferir('o painel de diagnostico nao existe', !temPainel);
  conferir('so a raiz e a caixa da legenda ocupam area',
    JSON.stringify(m.comArea) === JSON.stringify(['raiz', 'caixa']), JSON.stringify(m.comArea));
  conferir('o audio continua tocando sozinho', m.tocando);
  conferir('nenhum erro de console', erros.length === 0, erros.join(' | '));
  await navegador.close();
}

fs.rmSync(AREA, { recursive: true, force: true });

console.log('\n' + '='.repeat(62));
if (falhas) {
  console.log(falhas + ' verificacoes falharam.');
  process.exit(1);
}
console.log('Todas as verificacoes de navegador passaram.');
