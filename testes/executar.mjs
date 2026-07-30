// Suite de testes do SyncLab. Roda sem dependencias: `node testes/executar.mjs`
// ou `npm test`. Cobre a logica pura -- o que nao depende de rede nem de DOM.

import { strict as assert } from 'node:assert';

import * as U from '../src/js/util.js';
import * as L from '../src/js/legendas.js';
import * as A from '../src/js/aparencia.js';
import * as G from '../src/js/gerador.js';
import * as S from '../src/js/s3.js';
import * as Z from '../src/js/zip.js';
import { regrasParaApi, validarRegra } from '../src/js/elevenlabs.js';

let passaram = 0;
const falhas = [];
const grupos = [];

function grupo(nome) { grupos.push(nome); console.log('\n' + nome); }

async function teste(nome, fn) {
  try {
    await fn();
    passaram++;
    console.log('  ok   ' + nome);
  } catch (erro) {
    falhas.push({ nome, erro });
    console.log('  FALHA ' + nome + '\n        ' + erro.message);
  }
}

const ASCII_PURO = (s) => !/[^\x09\x0A\x0D\x20-\x7E]/.test(s);

// ---------------------------------------------------------------------------
grupo('util: nomes de arquivo');

await teste('remove acentos, espacos e maiusculas', () => {
  assert.equal(U.sanitizarNomeArquivo('  Aula 03 Coração  '), 'aula-03-coracao');
  assert.equal(U.sanitizarNomeArquivo('Pulmão & Coração'), 'pulmao-coracao');
  assert.equal(U.sanitizarNomeArquivo('ÁÉÍÓÚ ção'), 'aeiou-cao');
});

await teste('nunca devolve nome vazio', () => {
  assert.equal(U.sanitizarNomeArquivo(''), 'synclab');
  assert.equal(U.sanitizarNomeArquivo('---'), 'synclab');
  assert.equal(U.sanitizarNomeArquivo('!!!', 'narracao'), 'narracao');
});

await teste('o mesmo nome-base serve para todas as extensoes', () => {
  const base = U.sanitizarNomeArquivo('Aula 03 — Coração');
  for (const ext of ['.html', '.mp3', '.srt', '.vtt', '.zip']) {
    assert.ok(/^[a-z0-9.\-]+$/.test(base + ext), 'extensao ' + ext);
  }
});

// ---------------------------------------------------------------------------
grupo('util: limpeza e escape');

await teste('remove caracteres invisiveis das credenciais', () => {
  const sujo = '​sk_abc﻿123­ ⁠';
  assert.equal(U.limparInvisiveis(sujo), 'sk_abc123');
  assert.equal(U.limparInvisiveis('  chave  '), 'chave');
});

await teste('escaparParaJs preserva quebras de linha', () => {
  // Escapar a quebra de linha quebraria a sintaxe do codigo gerado.
  assert.equal(U.escaparParaJs('a\nb'), 'a\nb');
  assert.equal(U.escaparParaJs('ação'), 'a\\u00E7\\u00E3o');
  assert.equal(U.escaparParaJs('—'), '\\u2014');
});

await teste('escapes de 4 digitos, sempre', () => {
  assert.equal(U.escaparParaJs('ç'), '\\u00E7'.replace('\\u00E7', '\\u00E7'));
  assert.ok(/^\\u[0-9A-F]{4}$/.test(U.escaparParaJs('ç')));
});

await teste('jsonAscii neutraliza fechamento de script', () => {
  const saida = U.jsonAscii({ t: '</script><script>alert(1)</script>' });
  assert.ok(ASCII_PURO(saida));
  assert.ok(!saida.includes('</script>'));
  // Escapado, mas ainda o mesmo dado depois que o JS interpreta os escapes.
  assert.deepEqual(JSON.parse(saida.replace(/\\u003C/g, '<').replace(/\\u003E/g, '>').replace(/\\u0026/g, '&')),
    { t: '</script><script>alert(1)</script>' });
});

await teste('htmlAscii escapa metacaracteres e acentos', () => {
  assert.equal(U.htmlAscii('<b>ação</b>'), '&lt;b&gt;a&#231;&#227;o&lt;/b&gt;');
  assert.ok(ASCII_PURO(U.htmlAscii('coração & cia')));
});

await teste('ehAsciiPuro aceita tab/CR/LF e recusa acento', () => {
  assert.equal(U.ehAsciiPuro('linha1\n\tlinha2\r\n'), true);
  assert.equal(U.ehAsciiPuro('não'), false);
  assert.equal(U.primeiroNaoAscii('abcção').codigo, 'U+00E7');
});

// ---------------------------------------------------------------------------
grupo('util: tempos e base64');

await teste('formata SRT e VTT', () => {
  assert.equal(U.tempoSrt(3661.5), '01:01:01,500');
  assert.equal(U.tempoVtt(75.25), '00:01:15.250');
  assert.equal(U.tempoSrt(0), '00:00:00,000');
});

await teste('le tempos de volta', () => {
  assert.equal(U.tempoParaSegundos('00:01:15,250'), 75.25);
  assert.equal(U.tempoParaSegundos('01:01:01.500'), 3661.5);
  assert.equal(U.tempoParaSegundos('lixo'), null);
});

await teste('base64 ida e volta', () => {
  for (const original of ['', 'a', 'ab', 'abc', 'olá mundo', 'x'.repeat(1000)]) {
    const bytes = U.textoParaBytes(original);
    const volta = U.base64ParaBytes(U.bytesParaBase64(bytes));
    assert.equal(new TextDecoder().decode(volta), original, 'valor: ' + original.slice(0, 20));
  }
});

await teste('base64 confere com a implementacao do Node', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]);
  assert.equal(U.bytesParaBase64(bytes), Buffer.from(bytes).toString('base64'));
});

// ---------------------------------------------------------------------------
grupo('legendas: origem 1 - timestamps da ElevenLabs');

function alinhamentoDe(frase, passo = 0.1) {
  const chars = frase.split('');
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * passo),
    character_end_times_seconds: chars.map((_, i) => (i + 1) * passo)
  };
}

await teste('agrupa caracteres em palavras com tempo', () => {
  const p = L.palavrasDeAlinhamento(alinhamentoDe('ola mundo'));
  assert.equal(p.length, 2);
  assert.equal(p[0].texto, 'ola');
  assert.equal(p[1].texto, 'mundo');
  assert.ok(Math.abs(p[0].inicio - 0) < 1e-9);
  assert.ok(p[1].inicio > p[0].fim - 1e-9);
});

await teste('lida com alinhamento vazio', () => {
  assert.deepEqual(L.palavrasDeAlinhamento(null), []);
  assert.deepEqual(L.palavrasDeAlinhamento({}), []);
});

// ---------------------------------------------------------------------------
grupo('legendas: origem 2 - Scribe');

await teste('usa so os tokens do tipo word', () => {
  const p = L.palavrasDeScribe({
    words: [
      { text: 'Olá', start: 0, end: 0.5, type: 'word' },
      { text: ' ', start: 0.5, end: 0.6, type: 'spacing' },
      { text: 'turma', start: 0.6, end: 1.2, type: 'word' },
      { text: '(risos)', start: 1.2, end: 2, type: 'audio_event' }
    ]
  });
  assert.deepEqual(p.map((x) => x.texto), ['Olá', 'turma']);
});

// ---------------------------------------------------------------------------
grupo('legendas: origem 3 - SRT/VTT prontos');

const SRT_EXEMPLO = `1
00:00:00,200 --> 00:00:01,600
Olá turma, tudo bem?

2
00:00:01,900 --> 00:00:04,200
Hoje falamos de infarto
agudo do miocárdio.
`;

await teste('le SRT com numeracao e duas linhas', () => {
  const cues = L.lerLegendas(SRT_EXEMPLO);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].inicio, 0.2);
  assert.equal(cues[1].fim, 4.2);
  assert.deepEqual(cues[1].linhas, ['Hoje falamos de infarto', 'agudo do miocárdio.']);
});

await teste('le VTT, ignorando cabecalho e tags', () => {
  const cues = L.lerLegendas(
    'WEBVTT\n\nNOTE algo\n\n00:00:01.000 --> 00:00:02.000\n<v Ana>Olá <i>turma</i>\n'
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].texto, 'Olá turma');
});

await teste('ignora BOM e CRLF', () => {
  const cues = L.lerLegendas('﻿1\r\n00:00:00,000 --> 00:00:01,000\r\nOi\r\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].texto, 'Oi');
});

await teste('SRT sem numeracao tambem e aceito', () => {
  const cues = L.lerLegendas('00:00:00,000 --> 00:00:01,000\nOi\n');
  assert.equal(cues.length, 1);
});

await teste('ida e volta SRT preserva texto e tempos', () => {
  const cues = L.lerLegendas(SRT_EXEMPLO);
  const volta = L.lerLegendas(L.paraSrt(cues));
  assert.deepEqual(volta.map((c) => c.texto), cues.map((c) => c.texto));
  assert.deepEqual(volta.map((c) => c.inicio), cues.map((c) => c.inicio));
});

await teste('cues viram palavras com tempo estimado', () => {
  const palavras = L.palavrasDeCues(L.lerLegendas(SRT_EXEMPLO));
  assert.ok(palavras.length > 5);
  assert.ok(palavras.every((p) => p.estimado));
  // O tempo caminha sempre para a frente.
  for (let i = 1; i < palavras.length; i++) {
    assert.ok(palavras[i].inicio >= palavras[i - 1].inicio - 1e-9, 'palavra ' + i);
  }
});

// ---------------------------------------------------------------------------
grupo('legendas: regras de segmentacao');

const FRASE_LONGA = 'Ola turma. Hoje falamos de infarto agudo do miocardio e do eletrocardiograma.';

await teste('respeita o maximo de caracteres por linha', () => {
  const cues = L.segmentar(L.palavrasDeAlinhamento(alinhamentoDe(FRASE_LONGA, 0.05)),
    { maxCaracteresPorLinha: 20, maxLinhas: 2, pausaMinima: 0, quebrarEmFimDeFrase: false });
  for (const cue of cues) {
    for (const linha of cue.linhas) {
      assert.ok(linha.length <= 20, 'linha com ' + linha.length + ': ' + linha);
    }
  }
});

await teste('respeita o maximo de linhas por bloco', () => {
  for (const maxLinhas of [1, 2, 3]) {
    const cues = L.segmentar(L.palavrasDeAlinhamento(alinhamentoDe(FRASE_LONGA, 0.05)),
      { maxCaracteresPorLinha: 18, maxLinhas, pausaMinima: 0, quebrarEmFimDeFrase: false });
    for (const cue of cues) {
      assert.ok(cue.linhas.length <= maxLinhas, maxLinhas + ' linhas: veio ' + cue.linhas.length);
    }
  }
});

await teste('quebra em fim de frase quando pedido', () => {
  const palavras = L.palavrasDeAlinhamento(alinhamentoDe(FRASE_LONGA, 0.05));
  const com = L.segmentar(palavras, { maxCaracteresPorLinha: 200, maxLinhas: 4, pausaMinima: 0, quebrarEmFimDeFrase: true });
  const sem = L.segmentar(palavras, { maxCaracteresPorLinha: 200, maxLinhas: 4, pausaMinima: 0, quebrarEmFimDeFrase: false });
  assert.equal(com.length, 2, 'com a opcao ligada, "Ola turma." fecha o bloco');
  assert.equal(sem.length, 1);
  assert.equal(com[0].texto, 'Ola turma.');
});

await teste('quebra na pausa minima', () => {
  const palavras = [
    { texto: 'antes', inicio: 0, fim: 0.5 },
    { texto: 'depois', inicio: 2.0, fim: 2.5 }   // pausa de 1,5 s
  ];
  const quebrado = L.segmentar(palavras, { maxCaracteresPorLinha: 100, maxLinhas: 2, pausaMinima: 1.0, quebrarEmFimDeFrase: false });
  const junto = L.segmentar(palavras, { maxCaracteresPorLinha: 100, maxLinhas: 2, pausaMinima: 2.0, quebrarEmFimDeFrase: false });
  assert.equal(quebrado.length, 2);
  assert.equal(junto.length, 1);
});

await teste('palavra maior que o limite fica sozinha, sem ser cortada', () => {
  const linhas = L.quebrarEmLinhas('otorrinolaringologista ok', 10);
  assert.deepEqual(linhas, ['otorrinolaringologista', 'ok']);
});

await teste('reaplicar regras muda a segmentacao sem tocar nos tempos', () => {
  const palavras = L.palavrasDeAlinhamento(alinhamentoDe(FRASE_LONGA, 0.05));
  const largo = L.segmentar(palavras, { maxCaracteresPorLinha: 60, maxLinhas: 2, pausaMinima: 0, quebrarEmFimDeFrase: false });
  const estreito = L.segmentar(palavras, { maxCaracteresPorLinha: 15, maxLinhas: 1, pausaMinima: 0, quebrarEmFimDeFrase: false });
  assert.ok(estreito.length > largo.length);
  // A duracao coberta e a mesma: o audio nao foi regerado.
  assert.equal(largo[0].inicio, estreito[0].inicio);
  assert.equal(largo[largo.length - 1].fim, estreito[estreito.length - 1].fim);
});

await teste('tempos sempre crescentes e sem sobreposicao', () => {
  const cues = L.segmentar(L.palavrasDeAlinhamento(alinhamentoDe(FRASE_LONGA, 0.05)),
    { maxCaracteresPorLinha: 22, maxLinhas: 2, pausaMinima: 0.1, quebrarEmFimDeFrase: true });
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].fim >= cues[i].inicio, 'bloco ' + i + ' termina antes de comecar');
    if (i > 0) assert.ok(cues[i].inicio >= cues[i - 1].fim - 1e-9, 'blocos ' + i + ' sobrepostos');
    assert.equal(cues[i].indice, i + 1);
  }
});

await teste('entrada vazia devolve lista vazia', () => {
  assert.deepEqual(L.segmentar([], {}), []);
  assert.deepEqual(L.segmentar(null, {}), []);
});

// ---------------------------------------------------------------------------
grupo('legendas: saida SRT/VTT');

await teste('SRT numera a partir de 1 e usa virgula', () => {
  const srt = L.paraSrt(L.lerLegendas(SRT_EXEMPLO));
  assert.ok(srt.startsWith('1\n00:00:00,200 --> 00:00:01,600\n'));
  assert.ok(srt.includes('\n2\n'));
});

await teste('VTT comeca com WEBVTT e usa ponto', () => {
  const vtt = L.paraVtt(L.lerLegendas(SRT_EXEMPLO));
  assert.ok(vtt.startsWith('WEBVTT\n'));
  assert.ok(vtt.includes('00:00:00.200 --> 00:00:01.600'));
  assert.ok(!vtt.includes(',200 -->'));
});

await teste('formato compacto arredonda para milissegundos', () => {
  const compacto = L.paraFormatoCompacto([{ inicio: 1.23456, fim: 2.98765, linhas: ['a', 'b'] }]);
  assert.deepEqual(compacto, [[1.235, 2.988, 'a\nb']]);
});

// ---------------------------------------------------------------------------
grupo('aparencia');

await teste('normaliza cores curtas e longas', () => {
  assert.equal(A.normalizarCor('#fff'), '#FFFFFF');
  assert.equal(A.normalizarCor('abc123'), '#ABC123');
  assert.equal(A.normalizarCor('invalido', '#000000'), '#000000');
});

await teste('opacidade vira rgba', () => {
  assert.equal(A.corComOpacidade('#000000', 0.75), 'rgba(0,0,0,0.75)');
  assert.equal(A.corComOpacidade('#FFFFFF', 0), 'rgba(255,255,255,0)');
});

await teste('a caixa usa max-content, nunca faixa larga', () => {
  const css = A.cssDaLegenda('teste', {});
  assert.ok(css.includes('width:max-content'), 'faltou max-content');
});

await teste('o fundo em volta e sempre transparente', () => {
  for (const variante of [{}, { mostrarTarja: false }, { posicaoVertical: 'topo' }, { ancoragem: 'estatico' }]) {
    const css = A.cssDaLegenda('teste', variante);
    assert.ok(css.includes('background:transparent;'), 'faltou fundo transparente');
  }
});

await teste('remover a tarja deixa a caixa sem fundo', () => {
  assert.ok(A.cssDaLegenda('t', { mostrarTarja: false }).includes('background-color:transparent'));
  assert.ok(A.cssDaLegenda('t', { mostrarTarja: true, corTarja: '#000000', opacidadeTarja: 0.5 })
    .includes('background-color:rgba(0,0,0,0.5)'));
});

await teste('posicao vertical vira alinhamento e recuo', () => {
  assert.ok(A.cssDaLegenda('t', { posicaoVertical: 'topo', distanciaBorda: 30 }).includes('align-items:flex-start'));
  assert.ok(A.cssDaLegenda('t', { posicaoVertical: 'centro' }).includes('align-items:center'));
  const base = A.cssDaLegenda('t', { posicaoVertical: 'base', distanciaBorda: 48 });
  assert.ok(base.includes('align-items:flex-end'));
  assert.ok(base.includes('48px'));
});

await teste('valores fora da faixa caem no padrao', () => {
  const a = A.combinarAparencia({ tamanho: 9999, opacidadeTarja: 5, peso: -3, posicaoVertical: 'lua' });
  assert.equal(a.tamanho, 200);
  assert.equal(a.opacidadeTarja, 1);
  assert.equal(a.peso, 100);
  assert.equal(a.posicaoVertical, A.APARENCIA_PADRAO.posicaoVertical);
});

await teste('CSS sai em ASCII puro mesmo com fonte acentuada', () => {
  assert.ok(ASCII_PURO(A.cssDaLegenda('t', { fonte: '"Fonte Ação", serif' })));
});

// ---------------------------------------------------------------------------
grupo('gerador: trecho inline e documento');

const CUES = L.segmentar(L.palavrasDeAlinhamento(alinhamentoDe('Olá turma. Atenção ao ECG — miocárdio.', 0.08)),
  { maxCaracteresPorLinha: 24, maxLinhas: 2 });
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
const BASE = { nomeBase: 'aula', cues: CUES, aparencia: {}, audio: { modo: 'embutido', bytes: MP3 }, diagnostico: false };

await teste('trecho inline sai em ASCII puro', () => {
  assert.ok(ASCII_PURO(G.gerarTrechoInline(BASE).conteudo));
});

await teste('documento completo sai em ASCII puro', () => {
  assert.ok(ASCII_PURO(G.gerarDocumentoCompleto(BASE).conteudo));
});

await teste('acentos viram escape, e o texto original nao aparece cru', () => {
  const saida = G.gerarTrechoInline(BASE).conteudo;
  assert.ok(saida.includes('\\u00E1'), 'faltou o escape de a-agudo');
  assert.ok(!saida.includes('Olá'));
});

await teste('trecho inline nao usa iframe', () => {
  assert.ok(!/<iframe/i.test(G.gerarTrechoInline(BASE).conteudo));
});

await teste('nao ha player, controle ou loop visivel', () => {
  const saida = G.gerarTrechoInline({ ...BASE, diagnostico: false }).conteudo;
  assert.ok(!/\bcontrols\b/.test(saida), 'apareceu o atributo controls');
  assert.ok(saida.includes('audio.loop = false'), 'o loop precisa ser desligado explicitamente');
  assert.ok(!/<button/i.test(saida), 'apareceu um botao');
});

await teste('a tentativa de autoplay se repete a cada 400 ms', () => {
  const saida = G.gerarTrechoInline(BASE).conteudo;
  assert.ok(saida.includes('"intervaloTentativa":400'));
  assert.ok(saida.includes('setInterval(tentativa'));
});

await teste('existe o plano B mudo e a escuta na pagina pai', () => {
  const saida = G.gerarTrechoInline(BASE).conteudo;
  assert.ok(saida.includes('audio.muted = true'), 'faltou o fallback mudo');
  assert.ok(saida.includes('window.parent.document'), 'faltou a escuta na pagina pai');
});

await teste('audio embutido vira data URI', () => {
  const saida = G.gerarTrechoInline(BASE).conteudo;
  assert.ok(saida.includes('data:audio/mpeg;base64,'));
  assert.ok(saida.includes(U.bytesParaBase64(MP3)));
});

await teste('audio por URL externa nao embute nada', () => {
  const saida = G.gerarTrechoInline({ ...BASE, audio: { modo: 'url', url: 'https://x.s3.amazonaws.com/a.mp3' } }).conteudo;
  assert.ok(saida.includes('https://x.s3.amazonaws.com/a.mp3'));
  assert.ok(!saida.includes('data:audio/mpeg'));
});

await teste('o painel de diagnostico e opcional', () => {
  assert.ok(!G.gerarTrechoInline({ ...BASE, diagnostico: false }).conteudo.includes('-diag{'));
  const com = G.gerarTrechoInline({ ...BASE, diagnostico: true }).conteudo;
  assert.ok(com.includes('-diag{'));
  assert.ok(com.includes('"diagnostico":true'));
});

await teste('o diagnostico informa o contexto de iframe', () => {
  const com = G.gerarTrechoInline({ ...BASE, diagnostico: true }).conteudo;
  assert.ok(com.includes('window.self !== window.top'), 'faltou a deteccao de iframe');
  assert.ok(com.includes('dentro de um iframe') || com.includes('\\u0069'), 'faltou o rotulo do contexto');
});

await teste('dois trechos na mesma pagina nao colidem', () => {
  const a = G.gerarTrechoInline(BASE).prefixo;
  const b = G.gerarTrechoInline(BASE).prefixo;
  assert.notEqual(a, b);
  assert.ok(/^synclab-[a-z0-9]{6}$/.test(a), 'prefixo inesperado: ' + a);
});

await teste('texto hostil nao escapa do literal de string', () => {
  const cuesHostis = [{ indice: 1, inicio: 0, fim: 1, texto: 'x', linhas: ['</script><img onerror=alert(1)>'] }];
  const saida = G.gerarTrechoInline({ ...BASE, cues: cuesHostis }).conteudo;
  const corpo = saida.slice(saida.indexOf('<script>') + 8);
  assert.ok(!corpo.slice(0, corpo.indexOf('<\/script>')).includes('</script>'));
});

await teste('recusa exportar sem legenda', () => {
  assert.throws(() => G.gerarTrechoInline({ ...BASE, cues: [] }), /blocos de legenda/i);
});

await teste('recusa exportar sem audio', () => {
  assert.throws(() => G.gerarTrechoInline({ ...BASE, audio: { modo: 'embutido', bytes: null } }), /audio/i);
});

await teste('recusa URL de audio malformada, em portugues', () => {
  assert.throws(() => G.gerarTrechoInline({ ...BASE, audio: { modo: 'url', url: 'ftp://x/a.mp3' } }),
    /precisa comecar com http/);
  assert.throws(() => G.gerarTrechoInline({ ...BASE, audio: { modo: 'url', url: '' } }), /nao informou a URL/);
});

await teste('avisa sobre http dentro de pagina https', () => {
  const r = G.gerarTrechoInline({ ...BASE, audio: { modo: 'url', url: 'http://x.com/a.mp3' } });
  assert.ok(/conteudo misto/i.test(r.aviso), 'faltou o aviso de conteudo misto');
});

await teste('garantirAscii aponta o caractere problematico', () => {
  assert.throws(() => G.garantirAscii('tudo bem ate o ç', 'teste'), /U\+00E7/);
});

await teste('o documento completo tem fundo transparente', () => {
  const doc = G.gerarDocumentoCompleto(BASE).conteudo;
  assert.ok(doc.includes('html,body{margin:0;padding:0;background:transparent;'));
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
});

// ---------------------------------------------------------------------------
grupo('s3: assinatura SigV4');

await teste('confere com o vetor de teste publicado pela AWS', async () => {
  // Exemplo oficial "PUT Object" da documentacao de Signature Version 4.
  const corpo = new TextEncoder().encode('Welcome to Amazon S3.');
  const hash = await S.sha256Hex(corpo);
  assert.equal(hash, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');

  const r = await S.assinarRequisicao({
    metodo: 'PUT',
    caminho: '/' + S.escaparCaminho('test$file.text'),
    consulta: '',
    regiao: 'us-east-1',
    servico: 's3',
    cabecalhos: {
      date: 'Fri, 24 May 2013 00:00:00 GMT',
      host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': hash,
      'x-amz-date': '20130524T000000Z',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY'
    },
    hashCorpo: hash,
    chaveAcesso: 'AKIAIOSFODNN7EXAMPLE',
    segredo: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    carimbo: { amzDate: '20130524T000000Z', dia: '20130524' }
  });

  assert.equal(r.assinatura, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  assert.equal(r.listaAssinada, 'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
});

await teste('escape de caminho segue RFC 3986 e preserva barras', () => {
  assert.equal(S.escaparCaminho('test$file.text'), 'test%24file.text');
  assert.equal(S.escaparCaminho('aulas/cardio/aula 03.mp3'), 'aulas/cardio/aula%2003.mp3');
  assert.equal(S.escaparUri("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
});

await teste('host virtual-hosted por regiao', () => {
  assert.equal(S.hostDoBucket('meu', 'us-east-1'), 'meu.s3.amazonaws.com');
  assert.equal(S.hostDoBucket('meu', 'sa-east-1'), 'meu.s3.sa-east-1.amazonaws.com');
});

await teste('URL publica com nome que precisa de escape', () => {
  assert.equal(S.montarUrlPublica({ bucket: 'aulas', regiao: 'sa-east-1' }, 'pasta/a b.mp3'),
    'https://aulas.s3.sa-east-1.amazonaws.com/pasta/a%20b.mp3');
});

await teste('monta a chave sem barras duplicadas', () => {
  assert.equal(S.montarChave('/aulas/', 'a.mp3'), 'aulas/a.mp3');
  assert.equal(S.montarChave('', 'a.mp3'), 'a.mp3');
});

await teste('carimbo de data no formato da AWS', () => {
  const c = S.carimboDeData(new Date('2013-05-24T00:00:00Z'));
  assert.equal(c.amzDate, '20130524T000000Z');
  assert.equal(c.dia, '20130524');
});

await teste('Cache-Control e no-store, para republicacao aparecer na hora', () => {
  assert.ok(S.CACHE_CONTROL_PADRAO.includes('no-store'));
});

// ---------------------------------------------------------------------------
grupo('elevenlabs: dicionario de pronuncia');

await teste('regra de substituicao vira alias', () => {
  assert.deepEqual(regrasParaApi([{ termo: 'IAM', tipo: 'substituicao', valor: 'infarto agudo do miocárdio' }]),
    [{ string_to_replace: 'IAM', type: 'alias', alias: 'infarto agudo do miocárdio' }]);
});

await teste('regra de fonema vira phoneme em IPA', () => {
  assert.deepEqual(regrasParaApi([{ termo: 'ECG', tipo: 'fonema', valor: 'e.se.ˈʒe' }]),
    [{ string_to_replace: 'ECG', type: 'phoneme', phoneme: 'e.se.ˈʒe', alphabet: 'ipa' }]);
});

await teste('descarta regras sem termo', () => {
  assert.equal(regrasParaApi([{ termo: '  ', valor: 'x' }, null, { termo: 'ok', valor: 'y' }]).length, 1);
});

await teste('validacao das regras responde em portugues', () => {
  assert.match(validarRegra({ termo: '', valor: 'x' }), /Informe o termo/);
  assert.match(validarRegra({ termo: 'IAM', valor: '' }), /como o termo deve ser escrito/);
  assert.match(validarRegra({ termo: 'IAM', tipo: 'fonema', valor: '' }), /IPA/);
  assert.match(validarRegra({ termo: 'IAM', tipo: 'fonema', valor: 'infarto agudo' }), /nao IPA/);
  assert.equal(validarRegra({ termo: 'IAM', tipo: 'substituicao', valor: 'infarto' }), null);
});

// ---------------------------------------------------------------------------
grupo('zip');

await teste('CRC32 confere com valor conhecido', () => {
  assert.equal(Z.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

await teste('estrutura do zip: assinaturas e contagem', () => {
  const z = Z.montarZip([
    { nome: 'a.txt', conteudo: 'primeiro' },
    { nome: 'b.bin', conteudo: new Uint8Array([1, 2, 3]) }
  ]);
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  assert.equal(v.getUint32(0, true), 0x04034b50, 'cabecalho local');
  const fim = z.length - 22;
  assert.equal(v.getUint32(fim, true), 0x06054b50, 'fim do diretorio central');
  assert.equal(v.getUint16(fim + 10, true), 2, 'total de entradas');

  // O tamanho do diretorio central precisa bater com o deslocamento gravado.
  const tamanhoCentral = v.getUint32(fim + 12, true);
  const inicioCentral = v.getUint32(fim + 16, true);
  assert.equal(inicioCentral + tamanhoCentral, fim, 'diretorio central com tamanho errado');
  assert.equal(v.getUint32(inicioCentral, true), 0x02014b50, 'assinatura do diretorio central');
});

await teste('o pacote leva HTML, legendas e MP3 com o mesmo nome-base', () => {
  const base = U.sanitizarNomeArquivo('Aula 03 Coração');
  const nomes = [base + '.html', base + '.srt', base + '.vtt', base + '.mp3'];
  const z = Z.montarZip(nomes.map((n) => ({ nome: n, conteudo: 'x' })));
  const texto = new TextDecoder('latin1').decode(z);
  for (const n of nomes) assert.ok(texto.includes(n), 'faltou ' + n);
});

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62));
console.log(passaram + ' testes passaram, ' + falhas.length + ' falharam');
if (falhas.length) {
  console.log('\nFalhas:');
  for (const f of falhas) console.log('  - ' + f.nome + ': ' + f.erro.message);
  process.exit(1);
}
console.log('Tudo certo.');
